"use client";

import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Mail,
  CheckCircle2,
  Loader2,
  Plug,
  Trash2,
  Send,
  Sparkles,
  AlertCircle,
  LogIn,
} from "lucide-react";
import { api, getToken, getWorkspaceId } from "@/lib/api";
import { copyToClipboard } from "@/lib/utils";

interface ConnectedAccount {
  id: string;
  provider: string;
  label: string | null;
  external_id: string | null;
  status: string;
  config?: Record<string, unknown>;
}

interface SenderWarmup {
  enabled: boolean;
  daily_cap_today: number;
  sent_today: number;
  day: number;
}
interface SenderListItem {
  id: string;
  warmup: SenderWarmup;
}

type Tab = "smtp" | "gmail" | "resend" | "sendgrid";

function domainOf(a: ConnectedAccount): string {
  const addr = a.external_id || (a.config?.username as string) || a.label || "";
  const at = addr.lastIndexOf("@");
  return at >= 0 ? addr.slice(at + 1).toLowerCase() : "";
}

// Hostinger-hosted mailboxes (smtp.hostinger.com / smtp.hostinger.in) get a
// one-click "Login" button — see SenderRow's useHostingerLogin below for why
// this can only copy the password + open the login page rather than a true
// zero-click auto-submit.
function isHostingerAccount(a: ConnectedAccount): boolean {
  if (a.provider !== "smtp") return false;
  const host = String(a.config?.host || "").toLowerCase();
  return host.includes("hostinger");
}

// A plain bookmarklet — works with NO browser extension at all, since
// dragging/clicking it runs the script in the CURRENT tab's own origin
// (mail.hostinger.com), the same way typing it into DevTools would. That
// sidesteps the cross-origin wall that stops this app's own JS from ever
// touching that tab directly. It reads {u,p} JSON off the clipboard (the
// "Login" button below copies it there right before opening the tab) and
// fills the email + password inputs using a native value-setter + input/
// change events — Hostinger's login is a Vue app, and setting .value alone
// does not notify v-model, same class of problem React has. It never
// touches the Login button itself; that stays the user's own click.
//
// Also handles switching senders: if the tab already has a DIFFERENT
// Hostinger mailbox logged in (no login fields on screen), it opens the
// account menu ([data-qa=profile-menu-trigger], confirmed live in DevTools),
// clicks Log out ([data-qa=profile-logout], also confirmed live — it is
// already in the DOM once the menu is open, no extra step needed there),
// waits for the login form to reappear, then fills the new credentials —
// all from the one click on this bookmark. If already on the login page
// (nothing logged in), it skips straight to filling, same as before.
//
// No apostrophes anywhere in the strings below on purpose — the whole
// thing is wrapped in an outer double-quoted TS string, and every inner
// JS string literal uses single quotes, so a stray apostrophe would
// terminate an inner string early. Selectors use unquoted CSS attribute
// values (data-qa identifiers only contain letters/hyphens, which is
// valid unquoted) so no inner double-quote is needed either.
const HOSTINGER_BOOKMARKLET_HREF =
  "javascript:" +
  "(function(){" +
  "try{" +
  "function d(m){if(m){alert(m);}}" +
  "function find(sels){for(var i=0;i<sels.length;i++){var el=document.querySelector(sels[i]);if(el){return el;}}return null;}" +
  "function fill(el,value){var setter=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;setter.call(el,value);el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));}" +
  // Plain el.click() silently did nothing for the account-menu trigger and
  // the Log out item — dropdown components commonly open/act on pointerdown
  // or mousedown rather than the synthesized click alone, especially when
  // they also listen document-wide for an outside-click-to-close handler.
  // Fire a full pointer/mouse sequence with real coordinates first, same
  // fix this codebase already needed for LinkedIn (Ember) buttons, then
  // fall back to plain .click() in case the target only wires the simple
  // handler.
  "function forceClick(el){" +
  "try{" +
  "var r=el.getBoundingClientRect();" +
  "var x=r.left+r.width/2;" +
  "var y=r.top+r.height/2;" +
  "var o={bubbles:true,cancelable:true,view:window,clientX:x,clientY:y};" +
  "var PE=window.PointerEvent||window.MouseEvent;" +
  "el.dispatchEvent(new PE('pointerover',o));" +
  "el.dispatchEvent(new PE('pointerdown',o));" +
  "el.dispatchEvent(new MouseEvent('mousedown',o));" +
  "el.dispatchEvent(new PE('pointerup',o));" +
  "el.dispatchEvent(new MouseEvent('mouseup',o));" +
  "}catch(e){}" +
  "el.click();" +
  "}" +
  "var EMAIL_SELS=['input[data-qa=login-email-input-input]','input#email','input[autocomplete=username]'];" +
  "var PASS_SELS=['input[data-qa=login-password-input-input]','input#password','input[autocomplete=current-password]'];" +
  "function doFill(){" +
  "if(!navigator.clipboard||!navigator.clipboard.readText){d('LeadCaptura: this browser does not support reading the clipboard from a bookmarklet.');return;}" +
  "navigator.clipboard.readText().then(function(raw){" +
  "var data=null;try{data=JSON.parse(raw);}catch(e){}" +
  "if(!data||!data.u||!data.p){d('LeadCaptura: no credentials on your clipboard yet. Go back to Settings, Email Senders, click Login next to the Hostinger sender, then click this bookmark again.');return;}" +
  "var emailEl=find(EMAIL_SELS);" +
  "var passEl=find(PASS_SELS);" +
  "if(emailEl){fill(emailEl,data.u);}" +
  "if(passEl){fill(passEl,data.p);}" +
  "if(!emailEl||!passEl){d('LeadCaptura: could not find the '+(emailEl?'password':'email')+' field on this page.');}" +
  "}).catch(function(){d('LeadCaptura: could not read the clipboard. If Chrome just asked for permission, click Allow, then click this bookmark again.');});" +
  "}" +
  "function waitForLoginThenFill(){" +
  "var tries=0;" +
  "var iv=setInterval(function(){" +
  "tries=tries+1;" +
  "if(find(EMAIL_SELS)){clearInterval(iv);doFill();return;}" +
  "if(tries>75){clearInterval(iv);d('LeadCaptura: logged out, but the login page did not reappear. Click this bookmark again once you see the login form.');}" +
  "},200);" +
  "}" +
  "if(find(EMAIL_SELS)){doFill();return;}" +
  "var logoutBtn=document.querySelector('[data-qa=profile-logout]');" +
  "if(logoutBtn){forceClick(logoutBtn);waitForLoginThenFill();return;}" +
  "var menuTrigger=document.querySelector('[data-qa=profile-menu-trigger]');" +
  "if(menuTrigger){" +
  "forceClick(menuTrigger);" +
  "var mtries=0;" +
  "var mIv=setInterval(function(){" +
  "mtries=mtries+1;" +
  "var lb=document.querySelector('[data-qa=profile-logout]');" +
  "if(lb){clearInterval(mIv);forceClick(lb);waitForLoginThenFill();return;}" +
  "if(mtries>15){clearInterval(mIv);d('LeadCaptura: opened the account menu but could not find Log out. Click this bookmark again, or log out manually.');}" +
  "},200);" +
  "return;" +
  "}" +
  "doFill();" +
  "}catch(err){alert('LeadCaptura bookmarklet error: '+(err&&err.message?err.message:err));}" +
  "})();";

// React 19 hard-blocks a `javascript:` href passed through JSX props —
// clicking/dragging one throws "React has blocked a javascript: URL as a
// security precaution" instead of setting the attribute, since React
// treats it the same as unsanitized string interpolation (a reasonable
// default against attacker-controlled hrefs). This one isn't attacker
// input, it's the fixed constant above, so the fix is to set the
// attribute directly on the DOM node via a ref — that bypasses React's
// prop-diffing entirely, which is the only place the check lives.
function HostingerBookmarkletLink() {
  const ref = useRef<HTMLAnchorElement>(null);
  useEffect(() => {
    ref.current?.setAttribute("href", HOSTINGER_BOOKMARKLET_HREF);
  }, []);
  return (
    <a
      ref={ref}
      href="#"
      onClick={(e) => e.preventDefault()}
      draggable
      className="inline-flex items-center rounded-md border border-indigo-300 bg-white px-2 py-1 font-medium text-indigo-700 shadow-sm cursor-move select-none"
      title="Drag me to your bookmarks bar"
    >
      🔖 Fill Hostinger Login
    </a>
  );
}

export default function EmailSendersPage() {
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>("smtp");

  const { data: accounts, isLoading } = useQuery<ConnectedAccount[]>({
    queryKey: ["connected-accounts"],
    queryFn: () => api("/integrations/accounts"),
  });

  // Warmup state per sender (separate endpoint that includes the ramp info).
  const { data: senderList } = useQuery<SenderListItem[]>({
    queryKey: ["senders-warmup"],
    queryFn: () => api("/campaigns/senders/list"),
  });
  const warmupById = new Map((senderList || []).map((s) => [s.id, s.warmup]));

  // Grouped by domain so every @hudace.com / @giftsgulf.com / etc. sender
  // sits together instead of scattered in whatever order they were
  // connected — purely a client-side sort of already-fetched rows, doesn't
  // touch fetching, mutations, or anything else that reads `accounts`.
  const emailAccounts = (accounts || [])
    .filter((a) => ["smtp", "gmail", "resend", "sendgrid"].includes(a.provider))
    .sort((a, b) => {
      const d = domainOf(a).localeCompare(domainOf(b));
      if (d !== 0) return d;
      return (a.external_id || "").localeCompare(b.external_id || "");
    });

  const disconnect = useMutation({
    mutationFn: (id: string) => api(`/integrations/accounts/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["connected-accounts"] }),
  });

  const onSaved = () => qc.invalidateQueries({ queryKey: ["connected-accounts"] });

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <div className="flex items-center gap-2 mb-1">
          <Mail className="h-5 w-5 text-indigo-600" />
          <h1 className="text-lg font-semibold">Email Senders</h1>
        </div>
        <p className="text-sm text-slate-500">
          Connect one or more mailboxes. Each sender is independent — totally
          separate from your LeadCaptura login email. Campaigns and outreach
          rotate across all active senders automatically.
        </p>
      </div>

      {emailAccounts.some(isHostingerAccount) && (
        <div className="card p-4 flex items-start gap-3 border-indigo-100 bg-indigo-50/40">
          <LogIn className="h-4 w-4 flex-shrink-0 mt-0.5 text-indigo-600" />
          <div className="min-w-0 text-xs text-slate-600 leading-relaxed">
            <p className="font-medium text-slate-700 mb-1">
              One-time setup for the Hostinger &quot;Login&quot; button
            </p>
            <p>
              Drag this to your bookmarks bar (no browser extension needed):{" "}
              <HostingerBookmarkletLink />
              . Then click &quot;Login&quot; next to a Hostinger sender below — it copies the
              credentials and opens Hostinger&apos;s login page — and click that bookmark
              on the Hostinger tab to fill both fields. You click Login yourself.
            </p>
          </div>
        </div>
      )}

      {/* Connected senders list */}
      <div className="card divide-y divide-slate-100">
        <div className="px-4 py-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold">Connected senders</h2>
          {emailAccounts.length > 0 && (
            <span className="text-xs text-slate-400">
              {emailAccounts.length} active
            </span>
          )}
        </div>
        {isLoading ? (
          <div className="px-4 py-6 flex justify-center">
            <Loader2 className="h-5 w-5 animate-spin text-slate-400" />
          </div>
        ) : emailAccounts.length === 0 ? (
          <div className="px-4 py-8 text-center">
            <Mail className="h-8 w-8 text-slate-300 mx-auto mb-2" />
            <p className="text-sm text-slate-500">No senders connected yet.</p>
            <p className="text-xs text-slate-400 mt-1">Add one below to start sending campaigns.</p>
          </div>
        ) : (
          emailAccounts.map((a) => (
            <SenderRow
              key={a.id}
              account={a}
              warmup={warmupById.get(a.id)}
              onDisconnect={() => {
                if (window.confirm(`Disconnect ${a.external_id || a.label || a.provider}?`)) {
                  disconnect.mutate(a.id);
                }
              }}
            />
          ))
        )}
      </div>

      {/* Suppressed addresses */}
      <SuppressionsPanel />

      {/* Add sender form */}
      <div className="card p-5">
        <h2 className="text-sm font-semibold mb-4">Add a sender</h2>
        <div className="flex flex-wrap gap-1.5 border-b border-slate-100 pb-3 mb-4">
          {(
            [
              { id: "smtp", label: "SMTP" },
              { id: "gmail", label: "Gmail" },
              { id: "resend", label: "Resend" },
              { id: "sendgrid", label: "SendGrid" },
            ] as const
          ).map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                tab === t.id
                  ? "bg-indigo-50 text-indigo-700"
                  : "text-slate-500 hover:text-slate-700"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
        {tab === "smtp" && <SmtpForm onSaved={onSaved} />}
        {tab === "gmail" && <GmailForm onSaved={onSaved} />}
        {tab === "resend" && <ResendForm onSaved={onSaved} />}
        {tab === "sendgrid" && <SendGridForm onSaved={onSaved} />}
      </div>
    </div>
  );
}

function SenderRow({
  account: a,
  warmup,
  onDisconnect,
}: {
  account: ConnectedAccount;
  warmup?: SenderWarmup;
  onDisconnect: () => void;
}) {
  const qc = useQueryClient();
  const test = useMutation<{ ok: boolean; to: string }, Error, void>({
    mutationFn: () =>
      api(`/integrations/accounts/${a.id}/test`, { method: "POST", body: {} }),
  });

  const toggleWarmup = useMutation({
    mutationFn: (enabled: boolean) =>
      api(`/campaigns/senders/${a.id}/warmup`, { method: "PATCH", body: { enabled } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["senders-warmup"] }),
  });
  const warmOn = !!warmup?.enabled;

  // Hostinger's webmail (mail.hostinger.com, a Vue app) is a different
  // origin from this app — a browser will never let our JS read or submit a
  // form on someone else's site, so we can't fill it directly from here.
  // Two independent bridges, neither required for the other to work:
  //  1) The LeadCaptura browser extension, if installed — postMessage to
  //     hostinger_bridge.js (content script on THIS page) → chrome.storage
  //     .local → hostinger_autofill.js (content script on the new tab)
  //     fills both fields silently, no further action needed.
  //  2) The HOSTINGER_BOOKMARKLET_HREF bookmarklet above — works with NO
  //     extension. It reads the {u,p} JSON this click puts on the
  //     clipboard and fills the same two fields the same way.
  // Neither path ever clicks Login itself — that stays the user's own
  // action on purpose. Neither the email nor the password goes through the
  // URL of the tab we open (a URL is the wrong place for either — browser
  // history, address bar, any Referer a page sends).
  const [loginCopied, setLoginCopied] = useState(false);
  const hostingerLogin = useMutation<{ username: string; password: string }, Error, void>({
    mutationFn: () => api(`/integrations/accounts/${a.id}/reveal-secret`),
    onSuccess: async (data) => {
      const ok = await copyToClipboard(JSON.stringify({ u: data.username, p: data.password }));
      if (ok) {
        setLoginCopied(true);
        setTimeout(() => setLoginCopied(false), 6000);
      }
      try {
        window.postMessage(
          { type: "lc:hostinger-login-creds", username: data.username, password: data.password },
          window.location.origin
        );
      } catch {
        /* extension not installed / postMessage unsupported — bookmarklet path still works */
      }
      // Give the content script a moment to persist to chrome.storage.local
      // before the new tab (and its own content script) exists to read it.
      await new Promise((resolve) => setTimeout(resolve, 200));
      window.open("https://mail.hostinger.com/?_task=login", "_blank", "noopener,noreferrer");
    },
  });

  const providerColors: Record<string, string> = {
    smtp: "bg-slate-100 text-slate-700",
    gmail: "bg-red-50 text-red-700",
    resend: "bg-purple-50 text-purple-700",
    sendgrid: "bg-blue-50 text-blue-700",
  };

  return (
    <div className="px-4 py-3 flex items-center gap-3">
      <span
        className={`grid h-9 w-9 flex-shrink-0 place-items-center rounded-full text-[10px] font-bold uppercase ${
          providerColors[a.provider] || "bg-slate-100 text-slate-600"
        }`}
      >
        {a.provider.slice(0, 4)}
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">
          {a.external_id || a.label || a.provider}
        </div>
        <div className="flex items-center gap-2 text-xs text-slate-400">
          <span className="capitalize">{a.provider}</span>
          <span>·</span>
          <span className={a.status === "active" ? "text-emerald-600" : "text-slate-400"}>
            {a.status}
          </span>
          {test.isSuccess && (
            <>
              <span>·</span>
              <span className="text-emerald-600">✓ test sent to {test.data.to}</span>
            </>
          )}
          {warmOn && warmup && (
            <>
              <span>·</span>
              <span className="text-amber-600">warmup {warmup.sent_today}/{warmup.daily_cap_today} today</span>
            </>
          )}
          {loginCopied && (
            <>
              <span>·</span>
              <span className="text-emerald-600">✓ Hostinger login opened — click your &quot;Fill Hostinger Login&quot; bookmarklet on that tab (or wait for the extension to auto-fill)</span>
            </>
          )}
        </div>
        {/* Full-width, wrappable error so the real transport reason is readable
            (e.g. "test_send_failed: smtp_relay: 535 5.7.8 auth failed"). */}
        {test.isError && (
          <div className="mt-1.5 rounded-md bg-red-50 px-2.5 py-1.5 text-[11px] leading-snug text-red-700 break-words">
            {test.error?.message || "test failed"}
          </div>
        )}
        {hostingerLogin.isError && (
          <div className="mt-1.5 rounded-md bg-red-50 px-2.5 py-1.5 text-[11px] leading-snug text-red-700 break-words">
            {hostingerLogin.error?.message || "couldn't retrieve the saved password"}
          </div>
        )}
      </div>
      <button
        className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium disabled:opacity-40 ${
          warmOn
            ? "border-amber-300 bg-amber-50 text-amber-700"
            : "border-slate-200 text-slate-500 hover:bg-slate-50"
        }`}
        onClick={() => toggleWarmup.mutate(!warmOn)}
        disabled={toggleWarmup.isPending}
        title={
          warmOn
            ? "Warmup ON — this inbox gradually ramps daily campaign volume; overflow sends the next day (never blocks or fails)."
            : "Warmup OFF — this inbox sends campaigns at full speed. Turn on to gradually ramp a new inbox and protect deliverability."
        }
      >
        {toggleWarmup.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
        Warmup {warmOn ? "On" : "Off"}
      </button>
      {isHostingerAccount(a) && (
        <button
          className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-40"
          onClick={() => hostingerLogin.mutate()}
          disabled={hostingerLogin.isPending}
          title="Copies the email + password and opens Hostinger webmail login — use the bookmarklet above (or the extension) to fill both fields, then click Login yourself"
        >
          {hostingerLogin.isPending ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <LogIn className="h-3 w-3" />
          )}
          {hostingerLogin.isPending ? "Opening…" : "Login"}
        </button>
      )}
      <button
        className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-40"
        onClick={() => test.mutate()}
        disabled={test.isPending}
        title="Send a test email through this inbox"
      >
        {test.isPending ? (
          <Loader2 className="h-3 w-3 animate-spin" />
        ) : (
          <Send className="h-3 w-3" />
        )}
        {test.isPending ? "Sending…" : "Test"}
      </button>
      <button
        className="rounded p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600"
        onClick={onDisconnect}
        title="Disconnect"
      >
        <Trash2 className="h-4 w-4" />
      </button>
    </div>
  );
}

interface FormProps {
  onSaved: () => void;
}

function SmtpForm({ onSaved }: FormProps) {
  const [host, setHost] = useState("");
  const [port, setPort] = useState<number>(587);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [fromEmail, setFromEmail] = useState("");

  const save = useMutation({
    mutationFn: async () => {
      const token = getToken();
      const wsId = getWorkspaceId();
      const res = await fetch("/api/smtp-connect", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token || ""}`,
          "X-Workspace-Id": wsId || "",
        },
        body: JSON.stringify({
          host: host.trim(),
          port,
          username: username.trim(),
          password,
          from_email: fromEmail.trim() || username.trim(),
        }),
      });
      // The route returns HTML (its 404 page) until Vercel finishes deploying
      // it — parse defensively so the user gets a clear message, not a raw
      // "Unexpected token '<'" JSON error.
      const text = await res.text();
      let data: { ok?: boolean; error?: string } = {};
      try {
        data = JSON.parse(text) as { ok?: boolean; error?: string };
      } catch {
        throw new Error("deploying");
      }
      if (!res.ok || !data.ok) throw new Error(data.error || "connect_failed");
      return data;
    },
    onSuccess: () => {
      setHost("");
      setUsername("");
      setPassword("");
      setFromEmail("");
      onSaved();
    },
  });

  return (
    <div>
      <p className="text-xs text-slate-500 mb-3">
        Use any SMTP mailbox — Hostinger, Zoho, Mailgun, Gmail, your own server.
        The From address is what recipients see and has nothing to do with your
        LeadCaptura login.
      </p>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label">SMTP host</label>
          <input
            className="input"
            placeholder="smtp.your-provider.com"
            value={host}
            onChange={(e) => setHost(e.target.value)}
          />
        </div>
        <div>
          <label className="label">Port</label>
          <select
            className="input"
            value={port}
            onChange={(e) => setPort(parseInt(e.target.value, 10))}
          >
            <option value={587}>587 — STARTTLS</option>
            <option value={465}>465 — implicit TLS</option>
            <option value={25}>25 — plain (legacy)</option>
            <option value={2525}>2525 — provider relay</option>
          </select>
        </div>
      </div>
      <label className="label mt-3">Username</label>
      <input
        className="input"
        placeholder="you@example.com"
        value={username}
        onChange={(e) => setUsername(e.target.value)}
      />
      <label className="label mt-3">Password</label>
      <input
        className="input"
        type="password"
        placeholder="••••••••"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      <label className="label mt-3">From address <span className="font-normal text-slate-400">(defaults to username)</span></label>
      <input
        className="input"
        placeholder="hello@yourcompany.com"
        value={fromEmail}
        onChange={(e) => setFromEmail(e.target.value)}
      />

      {save.isError && (
        <div className="mt-3 flex items-start gap-2 rounded-md bg-red-50 border border-red-200 p-3">
          <AlertCircle className="h-4 w-4 text-red-500 mt-0.5 flex-shrink-0" />
          <p className="text-sm text-red-700">
            {(() => {
              const e = save.error?.message || "Connect failed.";
              if (e === "deploying") return "Still deploying the new SMTP connector — wait a minute and try again.";
              if (/smtp_auth_failed/i.test(e)) return "Username or password rejected. Double-check your SMTP credentials.";
              if (/relay_not_configured/i.test(e)) return "Could not reach the SMTP server. Try Resend or SendGrid instead.";
              return e;
            })()}
          </p>
        </div>
      )}
      {save.isSuccess && (
        <div className="mt-3 flex items-center gap-2 rounded-md bg-emerald-50 border border-emerald-200 p-3">
          <CheckCircle2 className="h-4 w-4 text-emerald-600" />
          <p className="text-sm font-medium text-emerald-800">
            SMTP verified and saved.{" "}
            {(save.data as { via?: string } | undefined)?.via === "relay" && (
              <span className="font-normal text-emerald-700">Sending via relay.</span>
            )}
          </p>
        </div>
      )}
      <button
        className="btn-primary mt-4 disabled:opacity-50"
        disabled={!host || !username || !password || save.isPending}
        onClick={() => save.mutate()}
      >
        {save.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plug className="h-4 w-4" />}
        {save.isPending ? "Verifying…" : "Connect SMTP"}
      </button>
    </div>
  );
}

function GmailForm({ onSaved }: FormProps) {
  const [email, setEmail] = useState("");
  const [appPassword, setAppPassword] = useState("");
  const save = useMutation({
    mutationFn: () =>
      api("/integrations/gmail/connect", {
        method: "POST",
        body: { email: email.trim(), app_password: appPassword },
      }),
    onSuccess: () => {
      setAppPassword("");
      onSaved();
    },
  });

  return (
    <div>
      <label className="label">Gmail address</label>
      <input
        className="input"
        placeholder="you@gmail.com"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
      />
      <label className="label mt-3">App Password <span className="font-normal text-slate-400">(16 chars, no spaces)</span></label>
      <input
        className="input"
        type="password"
        placeholder="abcdabcdabcdabcd"
        value={appPassword}
        onChange={(e) => setAppPassword(e.target.value)}
      />
      <p className="mt-1 text-xs text-slate-400">
        Generate at{" "}
        <a className="underline" href="https://myaccount.google.com/apppasswords" target="_blank" rel="noopener noreferrer">
          myaccount.google.com/apppasswords
        </a>{" "}
        (requires 2-Step Verification).
      </p>
      {save.isError && (
        <p className="mt-3 text-sm text-red-600">{save.error?.message || "Connect failed."}</p>
      )}
      {save.isSuccess && (
        <div className="mt-3 flex items-center gap-2 rounded-md bg-emerald-50 border border-emerald-200 p-3">
          <CheckCircle2 className="h-4 w-4 text-emerald-600" />
          <p className="text-sm font-medium text-emerald-800">Gmail connected.</p>
        </div>
      )}
      <button
        className="btn-primary mt-4 disabled:opacity-50"
        disabled={!email || !appPassword || save.isPending}
        onClick={() => save.mutate()}
      >
        {save.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plug className="h-4 w-4" />}
        {save.isPending ? "Verifying…" : "Connect Gmail"}
      </button>
    </div>
  );
}

function ResendForm({ onSaved }: FormProps) {
  const [apiKey, setApiKey] = useState("");
  const [fromEmail, setFromEmail] = useState("");
  const save = useMutation({
    mutationFn: () =>
      api("/integrations/resend/connect", {
        method: "POST",
        body: { api_key: apiKey, from_email: fromEmail.trim() },
      }),
    onSuccess: () => {
      setApiKey("");
      onSaved();
    },
  });
  return (
    <div>
      <p className="text-xs text-slate-500 mb-3">
        Pure HTTPS — works on any host, no SMTP ports needed. Free 3,000 emails/month.
      </p>
      <label className="label">API key</label>
      <input
        className="input"
        type="password"
        placeholder="re_…"
        value={apiKey}
        onChange={(e) => setApiKey(e.target.value)}
      />
      <label className="label mt-3">Verified sender address</label>
      <input
        className="input"
        placeholder="hello@yourdomain.com"
        value={fromEmail}
        onChange={(e) => setFromEmail(e.target.value)}
      />
      <p className="mt-1 text-xs text-slate-400">
        Verify a domain at{" "}
        <a className="underline" href="https://resend.com/domains" target="_blank" rel="noopener noreferrer">
          resend.com/domains
        </a>.
      </p>
      {save.isError && (
        <p className="mt-3 text-sm text-red-600">{save.error?.message || "Connect failed."}</p>
      )}
      {save.isSuccess && (
        <div className="mt-3 flex items-center gap-2 rounded-md bg-emerald-50 border border-emerald-200 p-3">
          <CheckCircle2 className="h-4 w-4 text-emerald-600" />
          <p className="text-sm font-medium text-emerald-800">Resend connected.</p>
        </div>
      )}
      <button
        className="btn-primary mt-4 disabled:opacity-50"
        disabled={!apiKey || save.isPending}
        onClick={() => save.mutate()}
      >
        {save.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
        {save.isPending ? "Verifying…" : "Connect Resend"}
      </button>
    </div>
  );
}

function SendGridForm({ onSaved }: FormProps) {
  const [apiKey, setApiKey] = useState("");
  const [fromEmail, setFromEmail] = useState("");
  const save = useMutation({
    mutationFn: () =>
      api("/integrations/sendgrid/connect", {
        method: "POST",
        body: { api_key: apiKey, from_email: fromEmail.trim() },
      }),
    onSuccess: () => {
      setApiKey("");
      onSaved();
    },
  });
  return (
    <div>
      <p className="text-xs text-slate-500 mb-3">
        Pure HTTPS — works on any host. Free 100 emails/day forever.
      </p>
      <label className="label">API key</label>
      <input
        className="input"
        type="password"
        placeholder="SG.…"
        value={apiKey}
        onChange={(e) => setApiKey(e.target.value)}
      />
      <label className="label mt-3">Verified sender address</label>
      <input
        className="input"
        placeholder="hello@yourdomain.com"
        value={fromEmail}
        onChange={(e) => setFromEmail(e.target.value)}
      />
      <p className="mt-1 text-xs text-slate-400">
        Verify at{" "}
        <a className="underline" href="https://app.sendgrid.com/settings/sender_auth" target="_blank" rel="noopener noreferrer">
          app.sendgrid.com/settings/sender_auth
        </a>.
      </p>
      {save.isError && (
        <p className="mt-3 text-sm text-red-600">{save.error?.message || "Connect failed."}</p>
      )}
      {save.isSuccess && (
        <div className="mt-3 flex items-center gap-2 rounded-md bg-emerald-50 border border-emerald-200 p-3">
          <CheckCircle2 className="h-4 w-4 text-emerald-600" />
          <p className="text-sm font-medium text-emerald-800">SendGrid connected.</p>
        </div>
      )}
      <button
        className="btn-primary mt-4 disabled:opacity-50"
        disabled={!apiKey || !fromEmail || save.isPending}
        onClick={() => save.mutate()}
      >
        {save.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
        {save.isPending ? "Verifying…" : "Connect SendGrid"}
      </button>
    </div>
  );
}

interface Suppression {
  id: string;
  email: string;
  reason: string;
  created_at: string | null;
}

/**
 * Suppressed addresses — emails the system will skip on every campaign because
 * they previously bounced (or were added manually). A sender-config bug used to
 * wrongly suppress valid addresses on transport failures; this panel lets the
 * user see and remove any address so it can receive mail again.
 */
function SuppressionsPanel() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery<Suppression[]>({
    queryKey: ["suppressions"],
    queryFn: () => api("/campaigns/suppressions/list"),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/campaigns/suppressions/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["suppressions"] }),
  });
  const rows = data || [];

  return (
    <div className="card divide-y divide-slate-100">
      <div className="px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <AlertCircle className="h-4 w-4 text-amber-500" />
          <h2 className="text-sm font-semibold">Suppressed addresses</h2>
        </div>
        {rows.length > 0 && <span className="text-xs text-slate-400">{rows.length} blocked</span>}
      </div>

      <div className="px-4 py-2.5">
        <p className="text-xs text-slate-500">
          These addresses are skipped on every campaign (they previously bounced or were
          added manually). If one was suppressed by mistake, remove it here to let it
          receive mail again.
        </p>
      </div>

      {isLoading ? (
        <div className="px-4 py-6 flex justify-center">
          <Loader2 className="h-5 w-5 animate-spin text-slate-400" />
        </div>
      ) : rows.length === 0 ? (
        <div className="px-4 py-6 text-center text-sm text-slate-400">
          <CheckCircle2 className="h-6 w-6 text-emerald-300 mx-auto mb-1.5" />
          No suppressed addresses — every address can receive mail.
        </div>
      ) : (
        rows.map((s) => (
          <div key={s.id} className="px-4 py-2.5 flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium text-slate-700">{s.email}</div>
              <div className="text-xs text-slate-400">
                {s.reason === "bounce" ? "Hard bounce" : s.reason}
                {s.created_at ? ` · ${new Date(s.created_at).toLocaleDateString()}` : ""}
              </div>
            </div>
            <button
              className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:border-emerald-300 hover:text-emerald-700 disabled:opacity-40"
              onClick={() => remove.mutate(s.id)}
              disabled={remove.isPending}
              title="Remove from suppression list — this address can receive mail again"
            >
              {remove.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
              Unblock
            </button>
          </div>
        ))
      )}
    </div>
  );
}
