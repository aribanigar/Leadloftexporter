/**
 * LeadCaptura WhatsApp sidecar — multi-account Baileys server.
 *
 * Why a Node sidecar:
 *   The main API is Python/FastAPI. Baileys is the only mature library that
 *   speaks the WhatsApp multi-device protocol (the same one WhatsApp Web uses)
 *   and it is Node-only. Rewriting it in Python is not realistic.
 *
 * Architecture:
 *   This process is NOT exposed to end users. The FastAPI backend proxies to
 *   it over an internal URL (env WA_SIDECAR_URL) and authenticates each call
 *   with a shared secret (env WA_SIDECAR_TOKEN, sent as X-Sidecar-Token).
 *
 * Auth namespacing:
 *   Every WhatsApp account is scoped to a LeadCaptura workspace_id. The
 *   workspace_id is passed in every request and is part of the auth-state
 *   directory path (.baileys_auth/<workspace_id>/<account_id>/) so different
 *   workspaces cannot see or use each other's connected phones.
 *
 * Persistence:
 *   accounts.json — workspace_id → list of {id, label, createdAt}
 *   campaigns.json — bulk-send history (capped to last 200 across all WS)
 *   .baileys_auth/<workspace_id>/<account_id>/ — Baileys credentials
 */

const express = require('express');
const qrcode = require('qrcode');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers,
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');

let pinoLogger;
try { pinoLogger = require('pino')({ level: 'silent' }); } catch (_) { pinoLogger = undefined; }

const app = express();
app.use(express.json({ limit: '20mb' }));

const PORT = process.env.PORT || 8001;
const SIDECAR_TOKEN = process.env.WA_SIDECAR_TOKEN || '';
const DATA_DIR = path.join(__dirname, 'data');
const AUTH_DIR = path.join(__dirname, '.baileys_auth');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(AUTH_DIR, { recursive: true });

const ACCOUNTS_FILE = path.join(DATA_DIR, 'accounts.json');
const CAMPAIGNS_FILE = path.join(DATA_DIR, 'campaigns.json');
function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
function writeJson(file, obj) { fs.writeFileSync(file, JSON.stringify(obj, null, 2)); }
function readAccounts() { return readJson(ACCOUNTS_FILE, {}); }
function writeAccounts(d) { writeJson(ACCOUNTS_FILE, d); }
function listAccounts(ws) { const all = readAccounts(); return all[ws] || []; }
function setAccounts(ws, list) { const all = readAccounts(); all[ws] = list; writeAccounts(all); }

// ─── Auth middleware ──────────────────────────────────────────────────────────
// Every endpoint requires the shared sidecar token AND a workspace_id (so one
// workspace cannot enumerate another's connected accounts).
app.use((req, res, next) => {
  if (req.path === '/health') return next();
  if (SIDECAR_TOKEN) {
    const got = req.header('x-sidecar-token') || '';
    if (got !== SIDECAR_TOKEN) return res.status(401).json({ error: 'bad_sidecar_token' });
  }
  const ws = req.header('x-workspace-id') || '';
  if (!ws) return res.status(400).json({ error: 'workspace_id_required' });
  req.workspaceId = ws;
  next();
});

// ─── Runtime state ────────────────────────────────────────────────────────────
// sessions: Map<"<workspace_id>:<account_id>", { sock, clientState, reconnecting, label }>
const sessions = new Map();
const activeCampaigns = {}; // id -> in-memory campaign
let _waVersion = null;

function sKey(ws, id) { return `${ws}:${id}`; }

function getStatus(ws, id) {
  const s = sessions.get(sKey(ws, id));
  if (!s) return { status: 'disconnected', qrDataUrl: null, phone: null, pushName: null };
  return {
    status: s.clientState.status,
    qrDataUrl: s.clientState.qrDataUrl,
    phone: s.clientState.info?.wid?.user || null,
    pushName: s.clientState.info?.pushname || null,
  };
}

function getDefaultSession(ws) {
  // Prefer a ready account, else any account for this workspace.
  for (const [k, s] of sessions) {
    if (!k.startsWith(`${ws}:`)) continue;
    if (s.clientState.status === 'ready') return s;
  }
  for (const [k, s] of sessions) if (k.startsWith(`${ws}:`)) return s;
  return null;
}

// ─── Baileys per-account init ─────────────────────────────────────────────────
async function initAccount(workspaceId, accountId, label) {
  const key = sKey(workspaceId, accountId);
  if (!sessions.has(key)) {
    sessions.set(key, {
      sock: null,
      clientState: { status: 'connecting', qrDataUrl: null, info: null },
      reconnecting: false,
      label: label || accountId,
    });
  }
  const session = sessions.get(key);
  if (session.reconnecting) return;
  session.reconnecting = true;

  // Close old socket cleanly so we don't stack listeners.
  if (session.sock) {
    try { session.sock.ev.removeAllListeners(); session.sock.end(undefined); } catch (_) {}
    session.sock = null;
  }
  session.clientState.status = 'connecting';
  session.clientState.qrDataUrl = null;

  try {
    const authDir = path.join(AUTH_DIR, workspaceId, accountId);
    fs.mkdirSync(authDir, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(authDir);

    if (!_waVersion) {
      const { version } = await fetchLatestBaileysVersion();
      _waVersion = version;
    }

    const sock = makeWASocket({
      version: _waVersion,
      auth: state,
      printQRInTerminal: false,
      browser: Browsers.ubuntu('Chrome'),
      ...(pinoLogger ? { logger: pinoLogger } : {}),
      defaultQueryTimeoutMs: 60000,
      connectTimeoutMs: 60000,
      keepAliveIntervalMs: 30000,
      retryRequestDelayMs: 3000,
      markOnlineOnConnect: false,
      syncFullHistory: false,
      fireInitQueries: true,
      generateHighQualityLinkPreview: false,
    });
    session.sock = sock;
    session.reconnecting = false;
    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
      const cs = session.clientState;
      if (qr) {
        try { cs.qrDataUrl = await qrcode.toDataURL(qr); } catch (_) {}
        cs.status = 'qr';
        console.log(`[WA:${workspaceId}/${accountId}] QR ready`);
      }
      if (connection === 'open') {
        cs.status = 'ready';
        cs.qrDataUrl = null;
        const userId = sock.user?.id?.split(':')[0] || '';
        cs.info = { pushname: sock.user?.name || '', wid: { user: userId } };
        console.log(`[WA:${workspaceId}/${accountId}] connected as +${userId}`);
      }
      if (connection === 'close') {
        const err = lastDisconnect?.error;
        const statusCode = (err instanceof Boom) ? err.output?.statusCode : err?.output?.statusCode;
        const loggedOut = statusCode === DisconnectReason.loggedOut;
        cs.info = null;
        cs.qrDataUrl = null;
        if (loggedOut || session.intentionalLogout) {
          cs.status = 'disconnected';
          session.intentionalLogout = false;
        } else {
          cs.status = 'connecting';
          const delay = statusCode === 408 ? 8000 : 5000;
          setTimeout(() => initAccount(workspaceId, accountId, session.label), delay);
        }
      }
    });
  } catch (e) {
    console.error(`[WA:${workspaceId}/${accountId}] init error:`, e.message);
    session.reconnecting = false;
    session.clientState.status = 'disconnected';
    setTimeout(() => initAccount(workspaceId, accountId, label), 10000);
  }
}

// ─── Restore on boot ──────────────────────────────────────────────────────────
// Every previously-paired account gets re-initialised so reconnects survive a
// container restart on Render (Baileys credentials live on disk).
(async () => {
  const all = readAccounts();
  for (const [ws, list] of Object.entries(all)) {
    for (const acc of list) await initAccount(ws, acc.id, acc.label);
  }
})();

process.on('unhandledRejection', (r) => console.error('[wa] unhandled rejection', r?.message || r));
process.on('uncaughtException', (e) => console.error('[wa] uncaught exception', e.message));

// ─── Routes ───────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ ok: true, version: '1.0.0' }));

// List all accounts (workspace-scoped) with live runtime status.
app.get('/accounts', (req, res) => {
  const ws = req.workspaceId;
  const list = listAccounts(ws);
  res.json(list.map(acc => ({ ...acc, ...getStatus(ws, acc.id) })));
});

// Add a new account → triggers QR generation. Max 5 per workspace.
app.post('/accounts', async (req, res) => {
  const ws = req.workspaceId;
  const list = listAccounts(ws);
  if (list.length >= 5) return res.status(400).json({ error: 'max_5_accounts' });
  const id = 'account_' + Date.now();
  const label = (req.body?.label || '').toString().trim() || `Account ${list.length + 1}`;
  const newAcc = { id, label, createdAt: Date.now() };
  setAccounts(ws, [...list, newAcc]);
  await initAccount(ws, id, label);
  res.json({ ...newAcc, ...getStatus(ws, id) });
});

app.put('/accounts/:id', (req, res) => {
  const ws = req.workspaceId;
  const list = listAccounts(ws);
  const idx = list.findIndex(a => a.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'not_found' });
  list[idx].label = (req.body?.label || '').toString().trim() || list[idx].label;
  setAccounts(ws, list);
  const s = sessions.get(sKey(ws, req.params.id));
  if (s) s.label = list[idx].label;
  res.json(list[idx]);
});

app.delete('/accounts/:id', async (req, res) => {
  const ws = req.workspaceId;
  const list = listAccounts(ws);
  const s = sessions.get(sKey(ws, req.params.id));
  if (s) {
    s.intentionalLogout = true;
    try { await s.sock?.logout(); } catch (_) {}
    try { s.sock?.end(undefined); } catch (_) {}
    sessions.delete(sKey(ws, req.params.id));
  }
  const authPath = path.join(AUTH_DIR, ws, req.params.id);
  if (fs.existsSync(authPath)) fs.rmSync(authPath, { recursive: true, force: true });
  setAccounts(ws, list.filter(a => a.id !== req.params.id));
  res.json({ ok: true });
});

app.get('/accounts/:id/status', (req, res) => res.json(getStatus(req.workspaceId, req.params.id)));

// Force a fresh QR if the user lost the previous one.
app.post('/accounts/:id/reconnect', async (req, res) => {
  const ws = req.workspaceId;
  const list = listAccounts(ws);
  const acc = list.find(a => a.id === req.params.id);
  if (!acc) return res.status(404).json({ error: 'not_found' });
  const s = sessions.get(sKey(ws, req.params.id));
  if (s) {
    s.intentionalLogout = false;
    s.clientState = { status: 'connecting', qrDataUrl: null, info: null };
    try { s.sock?.end(undefined); } catch (_) {}
    s.sock = null;
  }
  await new Promise(r => setTimeout(r, 500));
  initAccount(ws, req.params.id, acc.label);
  res.json({ ok: true });
});

app.post('/accounts/:id/logout', async (req, res) => {
  const ws = req.workspaceId;
  const s = sessions.get(sKey(ws, req.params.id));
  if (!s) return res.status(404).json({ error: 'not_found' });
  s.intentionalLogout = true;
  s.clientState = { status: 'disconnected', qrDataUrl: null, info: null };
  try { await s.sock?.logout(); } catch (_) {}
  try { s.sock?.end(undefined); } catch (_) {}
  s.sock = null;
  const authPath = path.join(AUTH_DIR, ws, req.params.id);
  if (fs.existsSync(authPath)) fs.rmSync(authPath, { recursive: true, force: true });
  res.json({ ok: true });
});

// ─── Single message send ──────────────────────────────────────────────────────
app.post('/send', async (req, res) => {
  const ws = req.workspaceId;
  const { accountId, phone, message, countryCode } = req.body || {};
  const s = (accountId && sessions.get(sKey(ws, accountId))) || getDefaultSession(ws);
  if (!s?.sock || s.clientState.status !== 'ready') return res.status(400).json({ error: 'wa_not_connected' });
  if (!phone || !message) return res.status(400).json({ error: 'phone_and_message_required' });

  // Normalise number — strip non-digits and leading zeros, auto-prepend the
  // workspace's country code if the user typed a local-format phone.
  const raw = String(phone).includes('E') || String(phone).includes('e')
    ? String(Math.round(Number(phone))) : String(phone);
  let digits = raw.replace(/\D/g, '').replace(/^0+/, '');
  const cc = String(countryCode || '91').replace(/\D/g, '') || '91';
  if (digits.length <= 10) digits = cc + digits;
  const lookupJid = `${digits}@s.whatsapp.net`;

  try {
    // Resolve canonical JID before sending. Sending to an unverified JID can
    // silently fail; using the JID WhatsApp itself returns is what guarantees
    // delivery.
    let sendJid = lookupJid;
    try {
      const r = await s.sock.onWhatsApp(lookupJid);
      const onWA = Array.isArray(r) ? r[0] : r;
      if (!onWA?.exists) return res.status(400).json({ error: 'not_on_whatsapp' });
      if (onWA.jid) sendJid = onWA.jid;
    } catch (_) { /* network failure on lookup — try anyway with constructed JID */ }
    await s.sock.sendMessage(sendJid, { text: message });
    res.json({ ok: true, jid: sendJid });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Bulk campaigns ───────────────────────────────────────────────────────────
// Per-recipient {token} merge: substitute {name}, {phone}, plus any extra
// fields the caller put on the contact row (e.g. {company}, {first_name}).
function mergeMessage(template, contact) {
  let out = template;
  for (const [k, v] of Object.entries(contact)) {
    out = out.replace(new RegExp(`{${k}}`, 'gi'), String(v ?? ''));
  }
  return out;
}

function randomDelay(min, max) {
  return new Promise(r => setTimeout(r, Math.floor(Math.random() * (max - min + 1)) + min));
}

async function runCampaign(campaign) {
  campaign.status = 'running';
  campaign.startedAt = campaign.startedAt || Date.now();
  const s = sessions.get(sKey(campaign.workspaceId, campaign.accountId)) || getDefaultSession(campaign.workspaceId);
  for (let i = campaign.progress; i < campaign.contacts.length; i++) {
    if (campaign.paused) { campaign.status = 'paused'; return; }
    if (campaign.cancelled) { campaign.status = 'cancelled'; campaign.completedAt = Date.now(); persistHistory(campaign); return; }
    const contact = campaign.contacts[i];
    const text = mergeMessage(campaign.message, contact);
    try {
      if (!s?.sock || s.clientState.status !== 'ready') throw new Error('wa_not_connected');
      const raw = String(contact.phone || '');
      let digits = raw.replace(/\D/g, '').replace(/^0+/, '');
      const cc = String(campaign.countryCode || '91').replace(/\D/g, '') || '91';
      if (digits.length <= 10) digits = cc + digits;
      const lookupJid = `${digits}@s.whatsapp.net`;
      let sendJid = lookupJid;
      try {
        const r = await s.sock.onWhatsApp(lookupJid);
        const onWA = Array.isArray(r) ? r[0] : r;
        if (!onWA?.exists) {
          contact.result = 'not_on_whatsapp';
          campaign.stats.failed++;
          campaign.progress = i + 1;
          campaign.stats.processed = campaign.progress;
          if (i < campaign.contacts.length - 1) await randomDelay(campaign.delayMin, campaign.delayMax);
          continue;
        }
        if (onWA.jid) sendJid = onWA.jid;
      } catch (_) { /* swallow lookup failures, try anyway */ }
      await s.sock.sendMessage(sendJid, { text });
      contact.result = 'sent';
      campaign.stats.sent++;
    } catch (e) {
      contact.result = `error: ${e.message}`;
      campaign.stats.failed++;
    }
    campaign.progress = i + 1;
    campaign.stats.processed = campaign.progress;
    if (i < campaign.contacts.length - 1) await randomDelay(campaign.delayMin, campaign.delayMax);
  }
  campaign.status = 'completed';
  campaign.completedAt = Date.now();
  persistHistory(campaign);
}

function persistHistory(c) {
  try {
    const all = readJson(CAMPAIGNS_FILE, []);
    const entry = {
      id: c.id, workspaceId: c.workspaceId, accountId: c.accountId,
      message: c.message, status: c.status, stats: c.stats,
      results: c.contacts.map(({ phone, name, result }) => ({ phone, name: name || '', result })),
      createdAt: c.createdAt, startedAt: c.startedAt, completedAt: c.completedAt || Date.now(),
    };
    const idx = all.findIndex(h => h.id === c.id);
    if (idx !== -1) all[idx] = entry; else all.unshift(entry);
    writeJson(CAMPAIGNS_FILE, all.slice(0, 200));
  } catch (e) { console.error('[wa] history persist failed', e.message); }
}

// Start a campaign. `contacts` is [{ phone, name?, ...mergeTokens? }, ...].
app.post('/campaigns/start', (req, res) => {
  const ws = req.workspaceId;
  const { contacts, message, accountId, delayMin = 5000, delayMax = 12000, countryCode = '91' } = req.body || {};
  const s = (accountId && sessions.get(sKey(ws, accountId))) || getDefaultSession(ws);
  if (!s || s.clientState.status !== 'ready') return res.status(400).json({ error: 'wa_not_connected' });
  if (!Array.isArray(contacts) || !contacts.length) return res.status(400).json({ error: 'no_contacts' });
  if (!message?.trim()) return res.status(400).json({ error: 'message_required' });
  const id = uuidv4();
  const campaign = {
    id, workspaceId: ws, accountId: accountId || listAccounts(ws)[0]?.id || null,
    countryCode: String(countryCode).replace(/\D/g, '') || '91',
    contacts: contacts.map(c => ({ ...c, result: null })),
    message,
    delayMin: Math.max(Number(delayMin) || 5000, 3000),
    delayMax: Math.max(Number(delayMax) || 12000, 6000),
    status: 'queued', progress: 0,
    stats: { total: contacts.length, processed: 0, sent: 0, failed: 0 },
    createdAt: Date.now(), startedAt: null, completedAt: null,
    paused: false, cancelled: false,
  };
  activeCampaigns[id] = campaign;
  runCampaign(campaign);
  res.json({ id });
});

// List campaigns — live in-memory ∪ persisted history, filtered to workspace.
app.get('/campaigns', (req, res) => {
  const ws = req.workspaceId;
  const active = Object.values(activeCampaigns)
    .filter(c => c.workspaceId === ws)
    .map(c => ({
      id: c.id, accountId: c.accountId, message: c.message,
      status: c.status, stats: c.stats,
      results: c.contacts.map(({ phone, name, result }) => ({ phone, name: name || '', result })),
      createdAt: c.createdAt, startedAt: c.startedAt, completedAt: c.completedAt || null,
    }));
  const history = readJson(CAMPAIGNS_FILE, []).filter(h => h.workspaceId === ws);
  const activeIds = new Set(active.map(c => c.id));
  const merged = [...active, ...history.filter(h => !activeIds.has(h.id))];
  merged.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  res.json(merged.slice(0, 100));
});

app.get('/campaigns/:id', (req, res) => {
  const c = activeCampaigns[req.params.id];
  if (!c || c.workspaceId !== req.workspaceId) {
    const h = readJson(CAMPAIGNS_FILE, []).find(x => x.id === req.params.id && x.workspaceId === req.workspaceId);
    if (!h) return res.status(404).json({ error: 'not_found' });
    return res.json(h);
  }
  res.json({
    id: c.id, accountId: c.accountId, message: c.message,
    status: c.status, stats: c.stats,
    results: c.contacts.map(({ phone, name, result }) => ({ phone, name: name || '', result })),
    createdAt: c.createdAt, startedAt: c.startedAt, completedAt: c.completedAt || null,
  });
});

app.post('/campaigns/:id/pause', (req, res) => {
  const c = activeCampaigns[req.params.id];
  if (!c || c.workspaceId !== req.workspaceId) return res.status(404).json({ error: 'not_found' });
  c.paused = true; res.json({ ok: true });
});
app.post('/campaigns/:id/resume', (req, res) => {
  const c = activeCampaigns[req.params.id];
  if (!c || c.workspaceId !== req.workspaceId) return res.status(404).json({ error: 'not_found' });
  c.paused = false; c.status = 'running'; runCampaign(c); res.json({ ok: true });
});
app.post('/campaigns/:id/cancel', (req, res) => {
  const c = activeCampaigns[req.params.id];
  if (!c || c.workspaceId !== req.workspaceId) return res.status(404).json({ error: 'not_found' });
  c.cancelled = true; res.json({ ok: true });
});

app.listen(PORT, () => console.log(`[wa-sidecar] listening on :${PORT}`));
