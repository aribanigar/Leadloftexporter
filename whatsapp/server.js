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
  initAuthCreds,
  BufferJSON,
  proto,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers,
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');

let pinoLogger;
try { pinoLogger = require('pino')({ level: 'silent' }); } catch (_) { pinoLogger = undefined; }

const app = express();
app.use(express.json({ limit: MAX_JSON_BYTES }));

const PORT = process.env.PORT || 8001;
const SIDECAR_TOKEN = process.env.WA_SIDECAR_TOKEN || '';
// Where to push captured messages so the backend can match them to a Lead and
// surface the conversation on the Lead Detail timeline. Optional — if unset,
// the in-memory inbox still works; only CRM timeline sync is disabled. Accepts
// either the API origin (https://api.example.com) or the full webhook URL.
const BACKEND_URL = (process.env.WA_BACKEND_URL || '').replace(/\/+$/, '');
let warnedNoBackend = false;
const AUTH_DIR = path.join(__dirname, '.baileys_auth');
// CRITICAL: ``accounts.json`` and ``campaigns.json`` MUST live on the
// persistent disk that Render mounts at ``.baileys_auth`` — otherwise they
// are wiped on every redeploy, the boot-time restore sees an empty account
// list, none of the previously-paired phones get re-initialised, and a
// fresh QR pair will orphan the credentials already on disk. Keep these
// inside AUTH_DIR.
const DATA_DIR = path.join(AUTH_DIR, '_meta');
fs.mkdirSync(AUTH_DIR, { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });

// Media upload limit — base64-encoded payloads inflate ~33%, so 24mb of
// raw JSON gives ~17mb of binary, well above WhatsApp's per-message ceiling.
const MAX_JSON_BYTES = '24mb';

// Mime sniff map for sending media via JSON.
const MEDIA_KIND_BY_MIME = (mt) => {
  const t = String(mt || '').toLowerCase();
  if (t.startsWith('image/')) return 'image';
  if (t.startsWith('video/')) return 'video';
  if (t.startsWith('audio/')) return 'audio';
  return 'document';
};

const ACCOUNTS_FILE = path.join(DATA_DIR, 'accounts.json');
const CAMPAIGNS_FILE = path.join(DATA_DIR, 'campaigns.json');
function _readJsonFile(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
function _writeJsonFile(file, obj) { try { fs.writeFileSync(file, JSON.stringify(obj, null, 2)); } catch (e) { console.error('[wa] file write', file, e.message); } }

// ─── Durable storage: Postgres (Neon) with on-disk fallback ───────────────────
// The Baileys session credentials + the account registry + campaign history
// used to live ONLY on a Render persistent disk. Setting WA_DB_URL (or reusing
// the app's DATABASE_URL) moves all three into Postgres, so the sidecar needs
// no disk and a paired phone survives on any host. If neither env is set we
// transparently fall back to the on-disk JSON + multi-file auth store, so
// nothing breaks without a database configured.
const { Pool } = (() => { try { return require('pg'); } catch { return {}; } })();
function _normalizeDbUrl(u) {
  // The app stores DATABASE_URL with SQLAlchemy's `+psycopg` driver suffix;
  // node-postgres wants a plain postgres:// scheme.
  return String(u || '')
    .replace(/^postgresql\+psycopg:\/\//, 'postgresql://')
    .replace(/^postgres\+psycopg:\/\//, 'postgres://')
    .trim();
}
const _DB_URL = _normalizeDbUrl(process.env.WA_DB_URL || process.env.DATABASE_URL || '');
let pgPool = null;
if (_DB_URL && Pool) {
  const local = /localhost|127\.0\.0\.1/.test(_DB_URL);
  pgPool = new Pool({
    connectionString: _DB_URL,
    ssl: local ? false : { rejectUnauthorized: false },  // Neon requires SSL
    max: 4,
  });
  pgPool.on('error', (e) => console.error('[wa] pg pool error', e.message));
}

// In-memory cache of the two JSON blobs (account registry + campaign history),
// loaded once at boot and written through to Postgres (or disk) on change. This
// keeps every existing *synchronous* call site working unchanged.
const _kv = { accounts: {}, campaigns: [] };
async function _kvLoad() {
  if (pgPool) {
    const r = await pgPool.query('SELECT k, value FROM wa_kv WHERE k = ANY($1)', [['accounts', 'campaigns']]);
    for (const row of r.rows) _kv[row.k] = row.value;
    if (_kv.accounts == null || typeof _kv.accounts !== 'object') _kv.accounts = {};
    if (!Array.isArray(_kv.campaigns)) _kv.campaigns = [];
  } else {
    _kv.accounts = _readJsonFile(ACCOUNTS_FILE, {});
    _kv.campaigns = _readJsonFile(CAMPAIGNS_FILE, []);
  }
}
function _kvSave(key) {
  if (pgPool) {
    // Fire-and-forget: the in-memory cache is authoritative for the live
    // process; Postgres is the restart-recovery copy. Writes are infrequent
    // (account add/remove, campaign progress).
    pgPool.query(
      'INSERT INTO wa_kv(k, value) VALUES($1, $2::jsonb) ON CONFLICT(k) DO UPDATE SET value = EXCLUDED.value',
      [key, JSON.stringify(_kv[key])]
    ).catch((e) => console.error('[wa] kv save', key, e.message));
  } else {
    _writeJsonFile(key === 'accounts' ? ACCOUNTS_FILE : CAMPAIGNS_FILE, _kv[key]);
  }
}

function readAccounts() { return _kv.accounts; }
function writeAccounts(d) { _kv.accounts = d; _kvSave('accounts'); }
function listAccounts(ws) { return _kv.accounts[ws] || []; }
function setAccounts(ws, list) { _kv.accounts[ws] = list; _kvSave('accounts'); }
function readCampaigns() { return _kv.campaigns; }
function writeCampaigns(arr) { _kv.campaigns = arr; _kvSave('campaigns'); }

// Baileys auth store backed by Postgres — mirrors useMultiFileAuthState but
// reads/writes the `wa_auth` table. Buffers inside the creds/keys are
// (de)serialised with Baileys' BufferJSON so they round-trip through jsonb.
async function usePostgresAuthState(pool, sessionId) {
  async function read(dataKey) {
    const r = await pool.query('SELECT value FROM wa_auth WHERE session_id=$1 AND data_key=$2', [sessionId, dataKey]);
    if (!r.rows.length) return null;
    return JSON.parse(JSON.stringify(r.rows[0].value), BufferJSON.reviver);
  }
  async function write(dataKey, value) {
    const encoded = JSON.stringify(value, BufferJSON.replacer);
    await pool.query(
      'INSERT INTO wa_auth(session_id, data_key, value) VALUES($1, $2, $3::jsonb) ON CONFLICT(session_id, data_key) DO UPDATE SET value = EXCLUDED.value',
      [sessionId, dataKey, encoded]
    );
  }
  async function del(dataKey) {
    await pool.query('DELETE FROM wa_auth WHERE session_id=$1 AND data_key=$2', [sessionId, dataKey]);
  }
  const creds = (await read('creds')) || initAuthCreds();
  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const out = {};
          await Promise.all(ids.map(async (id) => {
            let value = await read(`${type}-${id}`);
            if (type === 'app-state-sync-key' && value) {
              value = proto.Message.AppStateSyncKeyData.fromObject(value);
            }
            out[id] = value || undefined;
          }));
          return out;
        },
        set: async (data) => {
          const tasks = [];
          for (const category of Object.keys(data)) {
            for (const id of Object.keys(data[category])) {
              const value = data[category][id];
              const dataKey = `${category}-${id}`;
              tasks.push(value ? write(dataKey, value) : del(dataKey));
            }
          }
          await Promise.all(tasks);
        },
      },
    },
    saveCreds: () => write('creds', creds),
  };
}

// Remove a paired account's credentials from both Postgres and disk.
async function _clearAuth(ws, accountId) {
  if (pgPool) {
    try { await pgPool.query('DELETE FROM wa_auth WHERE session_id=$1', [`${ws}:${accountId}`]); }
    catch (e) { console.error('[wa] clearAuth', e.message); }
  }
  const p = path.join(AUTH_DIR, ws, accountId);
  try { if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true }); } catch (_) {}
}

async function _initDb() {
  if (!pgPool) return;
  await pgPool.query('CREATE TABLE IF NOT EXISTS wa_auth (session_id text NOT NULL, data_key text NOT NULL, value jsonb NOT NULL, PRIMARY KEY (session_id, data_key))');
  await pgPool.query('CREATE TABLE IF NOT EXISTS wa_kv (k text PRIMARY KEY, value jsonb NOT NULL)');
}

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
      // In-memory chat + message stores (per the reference implementation).
      // Survives reconnects within a process; on container restart we re-sync
      // via chats.upsert. Capped per chat in the upsert handler.
      chatsStore: new Map(),     // phone -> { jid, phone, name, lastMessage, lastMessageTime, fromMe, unreadCount }
      messagesStore: new Map(),  // jid -> [{ id, fromMe, sender, text, timestamp, type }, ...]
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
    let state, saveCreds;
    if (pgPool) {
      ({ state, saveCreds } = await usePostgresAuthState(pgPool, `${workspaceId}:${accountId}`));
    } else {
      const authDir = path.join(AUTH_DIR, workspaceId, accountId);
      fs.mkdirSync(authDir, { recursive: true });
      ({ state, saveCreds } = await useMultiFileAuthState(authDir));
    }

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

    // ── Inbound capture (replies + sent-by-me echo) ──────────────────────
    // Every WhatsApp message (incoming OR our own outgoing) flows through
    // messages.upsert. We index it twice: once in chatsStore (so the inbox
    // list shows the latest preview per phone) and once in messagesStore
    // (so opening a chat returns the recent thread). Group + status JIDs
    // are ignored so the inbox stays 1:1 conversations.
    sock.ev.on('messages.upsert', ({ messages, type }) => {
      for (const msg of messages || []) {
        const jid = msg.key?.remoteJid;
        if (!jid) continue;
        if (jid.endsWith('@g.us')) continue;          // groups
        if (jid === 'status@broadcast') continue;     // status posts
        const phone = jid.split('@')[0];
        const text =
          msg.message?.conversation
          || msg.message?.extendedTextMessage?.text
          || msg.message?.imageMessage?.caption
          || msg.message?.videoMessage?.caption
          || msg.message?.documentMessage?.caption
          || '';
        const fromMe = !!msg.key?.fromMe;
        const ts = Number(msg.messageTimestamp || 0) * 1000 || Date.now();

        // Chat-list entry
        const prior = session.chatsStore.get(phone) || {};
        session.chatsStore.set(phone, {
          jid,
          phone,
          name: msg.pushName || prior.name || phone,
          lastMessage: (text || '').slice(0, 120),
          lastMessageTime: ts,
          fromMe,
          unreadCount: fromMe ? 0 : (prior.unreadCount || 0) + 1,
        });

        // Append to per-chat message list, cap at 200 (reference parity)
        const list = session.messagesStore.get(jid) || [];
        list.push({
          id: msg.key?.id || `${ts}-${list.length}`,
          jid,
          phone,
          fromMe,
          sender: fromMe ? 'me' : (msg.pushName || phone),
          text,
          timestamp: ts,
          type: Object.keys(msg.message || { text: 1 })[0] || 'text',
        });
        while (list.length > 200) list.shift();
        session.messagesStore.set(jid, list);

        // CRM timeline sync — only real-time messages (type === 'notify'), not
        // the history Baileys replays on reconnect (type 'append'/'prepend'),
        // and only when there's body text to show. Dedup at the backend by
        // message id makes this safe even if a notify is delivered twice.
        if (type === 'notify' && text) {
          pushToBackend(workspaceId, {
            phone,
            text,
            from_me: fromMe,
            timestamp: ts,
            message_id: msg.key?.id || null,
            msg_type: Object.keys(msg.message || { text: 1 })[0] || 'text',
            contact_name: msg.pushName || null,
          });
        }
      }
    });

    // ── Initial chat sync on reconnect ───────────────────────────────────
    // Baileys fires chats.upsert with whatever the WhatsApp Web protocol
    // hands us shortly after `connection: 'open'`. We seed the chat list so
    // the inbox isn't empty until the next inbound message arrives.
    sock.ev.on('chats.upsert', (chats) => {
      for (const chat of chats || []) {
        const id = chat?.id;
        if (!id || id.endsWith('@g.us') || id === 'status@broadcast') continue;
        const phone = id.split('@')[0];
        if (session.chatsStore.has(phone)) continue;   // never overwrite a live entry
        session.chatsStore.set(phone, {
          jid: id,
          phone,
          name: chat.name || phone,
          lastMessage: '',
          lastMessageTime: Number(chat.conversationTimestamp || 0) * 1000,
          fromMe: false,
          unreadCount: chat.unreadCount || 0,
        });
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
// container restart (credentials live in Postgres, or on disk as a fallback).
(async () => {
  try {
    await _initDb();
    await _kvLoad();
    console.log(`[wa-sidecar] storage: ${pgPool ? 'Postgres (disk-free)' : 'on-disk JSON'}`);
  } catch (e) {
    console.error('[wa] DB init failed — falling back to disk:', e.message);
    pgPool = null;
    await _kvLoad();
  }
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
  await _clearAuth(ws, req.params.id);
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
  await _clearAuth(ws, req.params.id);
  res.json({ ok: true });
});

// ─── Single message send (text or media) ──────────────────────────────────────
// Body shape:
//   { accountId?, phone, message?, countryCode?,
//     media?: { base64, mimetype, filename? } }   ← optional
// Either ``message`` or ``media`` (or both — caption + image) must be present.
app.post('/send', async (req, res) => {
  const ws = req.workspaceId;
  const { accountId, phone, message, countryCode, media } = req.body || {};
  const s = (accountId && sessions.get(sKey(ws, accountId))) || getDefaultSession(ws);
  if (!s?.sock || s.clientState.status !== 'ready') return res.status(400).json({ error: 'wa_not_connected' });
  if (!phone) return res.status(400).json({ error: 'phone_required' });
  if (!message && !(media && media.base64)) return res.status(400).json({ error: 'message_or_media_required' });

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

    let payload;
    if (media && media.base64) {
      const buf = Buffer.from(media.base64, 'base64');
      const mimetype = media.mimetype || 'application/octet-stream';
      const kind = MEDIA_KIND_BY_MIME(mimetype);
      const caption = message || undefined;
      if (kind === 'image')      payload = { image:    buf, caption, mimetype };
      else if (kind === 'video') payload = { video:    buf, caption, mimetype };
      else if (kind === 'audio') payload = { audio:    buf, mimetype, ptt: false };
      else                       payload = { document: buf, caption, mimetype, fileName: media.filename || 'file' };
    } else {
      payload = { text: message };
    }
    await s.sock.sendMessage(sendJid, payload);
    res.json({ ok: true, jid: sendJid });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Inbox ────────────────────────────────────────────────────────────────────
// List 1:1 chats for an account (or the default-ready account if accountId
// is omitted), newest-message-first. Group + status JIDs are excluded.
app.get('/chats', (req, res) => {
  const ws = req.workspaceId;
  const accountId = req.query.accountId;
  const s = (accountId && sessions.get(sKey(ws, String(accountId)))) || getDefaultSession(ws);
  if (!s) return res.json([]);
  const list = Array.from(s.chatsStore.values())
    .sort((a, b) => (b.lastMessageTime || 0) - (a.lastMessageTime || 0))
    .slice(0, 200);
  res.json(list);
});

// Fetch the message thread for one chat. ``phone`` is the digits portion
// (no @s.whatsapp.net). Returns up to the last 200 messages, oldest first.
app.get('/chats/:phone', (req, res) => {
  const ws = req.workspaceId;
  const accountId = req.query.accountId;
  const s = (accountId && sessions.get(sKey(ws, String(accountId)))) || getDefaultSession(ws);
  if (!s) return res.json({ chat: null, messages: [] });
  const phone = String(req.params.phone).replace(/\D/g, '');
  const chat = s.chatsStore.get(phone) || null;
  // Reset unread on read.
  if (chat && chat.unreadCount) {
    s.chatsStore.set(phone, { ...chat, unreadCount: 0 });
  }
  const jid = chat?.jid || `${phone}@s.whatsapp.net`;
  const messages = s.messagesStore.get(jid) || [];
  res.json({ chat, messages });
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

// Fire-and-forget push of a captured message to the backend's CRM sync webhook.
// Never throws into the caller — a backend hiccup must not break message
// handling or the inbox. Uses the same shared token the proxy authenticates
// with (X-Sidecar-Token).
function pushToBackend(workspaceId, payload) {
  if (!BACKEND_URL) {
    if (!warnedNoBackend) {
      console.log('[wa] WA_BACKEND_URL unset — CRM timeline sync disabled (inbox still works).');
      warnedNoBackend = true;
    }
    return;
  }
  const url = `${BACKEND_URL}/api/v1/whatsapp-web/webhook/inbound`;
  Promise.resolve()
    .then(() =>
      fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Sidecar-Token': SIDECAR_TOKEN },
        body: JSON.stringify({ workspace_id: workspaceId, ...payload }),
      })
    )
    .catch((e) => console.log('[wa] backend webhook failed:', e?.message || e));
}

// Build the Baileys send payload for a campaign, given the per-contact merged
// caption/text. When the campaign carries media, the merged text rides as the
// caption (image/video/document) so the product photo + personalised line go
// out as one message.
function buildCampaignPayload(campaign, text) {
  const m = campaign.media;
  if (m && m.buffer) {
    const kind = MEDIA_KIND_BY_MIME(m.mimetype);
    if (kind === 'image')      return { image:    m.buffer, caption: text || undefined, mimetype: m.mimetype };
    if (kind === 'video')      return { video:    m.buffer, caption: text || undefined, mimetype: m.mimetype };
    if (kind === 'audio')      return { audio:    m.buffer, mimetype: m.mimetype, ptt: false };
    return { document: m.buffer, caption: text || undefined, mimetype: m.mimetype, fileName: m.filename || 'file' };
  }
  return { text };
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
      await s.sock.sendMessage(sendJid, buildCampaignPayload(campaign, text));
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
    const all = readCampaigns();
    const entry = {
      id: c.id, workspaceId: c.workspaceId, accountId: c.accountId,
      message: c.message, status: c.status, stats: c.stats,
      results: c.contacts.map(({ phone, name, result }) => ({ phone, name: name || '', result })),
      createdAt: c.createdAt, startedAt: c.startedAt, completedAt: c.completedAt || Date.now(),
    };
    const idx = all.findIndex(h => h.id === c.id);
    if (idx !== -1) all[idx] = entry; else all.unshift(entry);
    writeCampaigns(all.slice(0, 200));
  } catch (e) { console.error('[wa] history persist failed', e.message); }
}

// Start a campaign. `contacts` is [{ phone, name?, ...mergeTokens? }, ...].
// Optional `media: { base64, mimetype, filename? }` attaches an image / video /
// document to every message (the personalised text becomes the caption).
app.post('/campaigns/start', (req, res) => {
  const ws = req.workspaceId;
  const { contacts, message, accountId, delayMin = 5000, delayMax = 12000, countryCode = '91', media } = req.body || {};
  const s = (accountId && sessions.get(sKey(ws, accountId))) || getDefaultSession(ws);
  if (!s || s.clientState.status !== 'ready') return res.status(400).json({ error: 'wa_not_connected' });
  if (!Array.isArray(contacts) || !contacts.length) return res.status(400).json({ error: 'no_contacts' });
  const hasMedia = !!(media && media.base64);
  if (!message?.trim() && !hasMedia) return res.status(400).json({ error: 'message_or_media_required' });
  // Decode the media ONCE into a Buffer kept on the campaign — not per contact.
  let mediaObj = null;
  if (hasMedia) {
    try {
      mediaObj = {
        buffer: Buffer.from(media.base64, 'base64'),
        mimetype: media.mimetype || 'application/octet-stream',
        filename: media.filename || 'file',
      };
    } catch (_) { return res.status(400).json({ error: 'bad_media_base64' }); }
  }
  const id = uuidv4();
  const campaign = {
    id, workspaceId: ws, accountId: accountId || listAccounts(ws)[0]?.id || null,
    countryCode: String(countryCode).replace(/\D/g, '') || '91',
    contacts: contacts.map(c => ({ ...c, result: null })),
    message: message || '',
    media: mediaObj,
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
  const history = readCampaigns().filter(h => h.workspaceId === ws);
  const activeIds = new Set(active.map(c => c.id));
  const merged = [...active, ...history.filter(h => !activeIds.has(h.id))];
  merged.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  res.json(merged.slice(0, 100));
});

app.get('/campaigns/:id', (req, res) => {
  const c = activeCampaigns[req.params.id];
  if (!c || c.workspaceId !== req.workspaceId) {
    const h = readCampaigns().find(x => x.id === req.params.id && x.workspaceId === req.workspaceId);
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
