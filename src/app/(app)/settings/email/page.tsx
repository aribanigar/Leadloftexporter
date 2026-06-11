"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Mail,
  CheckCircle2,
  Loader2,
  Plug,
  Trash2,
  AlertTriangle,
  Sparkles,
} from "lucide-react";
import Link from "next/link";
import { api } from "@/lib/api";

interface ConnectedAccount {
  id: string;
  provider: string;
  label: string | null;
  external_id: string | null;
  status: string;
  config?: Record<string, unknown>;
}

type Tab = "smtp" | "gmail" | "resend" | "sendgrid";

export default function EmailSendersPage() {
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>("smtp");

  const { data: accounts } = useQuery<ConnectedAccount[]>({
    queryKey: ["connected-accounts"],
    queryFn: () => api("/integrations/accounts"),
  });

  const emailAccounts = (accounts || []).filter((a) =>
    ["smtp", "gmail", "resend", "sendgrid"].includes(a.provider)
  );

  const disconnect = useMutation({
    mutationFn: (id: string) => api(`/integrations/accounts/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["connected-accounts"] }),
  });

  // Relay probe — hits /api/smtp-relay (GET handler returns
  // {ok:true,service:"smtp-relay"}). If reachable, SMTP credentials that
  // can't connect directly will transparently fall back through this
  // endpoint, so users can paste their Hostinger / Zoho / etc. SMTP
  // settings and they just work. If unreachable, the user knows direct
  // SMTP is the only option and they need Resend / SendGrid.
  const { data: relay } = useQuery<{ ok: boolean; service?: string }>({
    queryKey: ["smtp-relay-probe"],
    queryFn: async () => {
      try {
        const r = await fetch("/api/smtp-relay", { method: "GET" });
        return (await r.json()) as { ok: boolean; service?: string };
      } catch {
        return { ok: false };
      }
    },
    staleTime: 5 * 60_000,
  });
  const relayReady = !!relay?.ok && relay?.service === "smtp-relay";

  return (
    <div className="max-w-3xl">
      <div className="mb-1 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Mail className="h-5 w-5 text-indigo-600" />
          <h1 className="text-lg font-semibold">Email Senders</h1>
        </div>
        {/* Live relay status pill — also doubles as a "have I got the
            latest deploy?" marker for users who saw a stale build. */}
        <span
          className={
            "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium " +
            (relayReady
              ? "border-emerald-200 bg-emerald-50 text-emerald-700"
              : "border-slate-200 bg-slate-50 text-slate-500")
          }
          title={
            relayReady
              ? "The Vercel SMTP relay is reachable — your SMTP creds work even on Render free tier."
              : "Vercel SMTP relay isn't reachable from this build — direct SMTP only."
          }
        >
          <span
            className={
              "h-1.5 w-1.5 rounded-full " +
              (relayReady ? "bg-emerald-500" : "bg-slate-400")
            }
          />
          Relay {relayReady ? "ready" : "checking…"}
        </span>
      </div>
      <p className="mb-5 text-sm text-slate-500">
        Connect at least one sender so the Messaging composer and Playbook
        steps can actually deliver mail. Outbound is ranked
        Resend → SendGrid → Gmail → SMTP — the first active provider wins per
        send.{" "}
        {relayReady && (
          <span className="text-emerald-700">
            Direct SMTP can&apos;t connect on Render free tier, so we route
            through the Vercel relay automatically — your Hostinger / Zoho /
            Mailgun credentials work as-is.{" "}
          </span>
        )}
        <Link href="/settings/outreach" className="underline">
          Daily quota & pacing
        </Link>{" "}
        are enforced server-side.
      </p>

      {/* Connected senders */}
      <div className="card mb-5 p-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold">Connected senders</h2>
          {emailAccounts.length > 0 && (
            <span className="text-[11px] text-slate-400">
              {emailAccounts.length} active — saving a new SMTP with a
              different From-address adds another, never overwrites.
            </span>
          )}
        </div>
        {emailAccounts.length === 0 ? (
          <div className="rounded-md border border-dashed border-slate-200 bg-slate-50 p-4 text-center text-sm text-slate-500">
            No email sender connected yet. Pick one below.
          </div>
        ) : (
          <ul className="divide-y divide-slate-100">
            {emailAccounts.map((a) => (
              <li key={a.id} className="flex items-center gap-3 py-2.5">
                <ProviderBadge provider={a.provider} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">
                    {a.external_id || a.label || a.provider}
                  </div>
                  <div className="truncate text-xs text-slate-400">
                    {a.label || a.provider} ·{" "}
                    <span
                      className={
                        a.status === "active" ? "text-emerald-600" : "text-slate-400"
                      }
                    >
                      {a.status}
                    </span>
                  </div>
                </div>
                <button
                  className="rounded p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600"
                  onClick={() => {
                    if (window.confirm(`Disconnect ${a.external_id || a.label || a.provider}?`)) {
                      disconnect.mutate(a.id);
                    }
                  }}
                  title="Disconnect"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Provider tabs */}
      <div className="card p-5">
        <div className="mb-4 flex flex-wrap gap-1.5 border-b border-slate-100 pb-3">
          {(
            [
              { id: "smtp", label: "SMTP server" },
              { id: "gmail", label: "Gmail (App Password)" },
              { id: "resend", label: "Resend" },
              { id: "sendgrid", label: "SendGrid" },
            ] as const
          ).map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`rounded-md px-3 py-1.5 text-sm font-medium ${
                tab === t.id
                  ? "bg-indigo-50 text-indigo-700"
                  : "text-slate-500 hover:text-slate-700"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
        {tab === "smtp" && <SmtpForm onSaved={() => qc.invalidateQueries({ queryKey: ["connected-accounts"] })} />}
        {tab === "gmail" && <GmailForm onSaved={() => qc.invalidateQueries({ queryKey: ["connected-accounts"] })} />}
        {tab === "resend" && <ResendForm onSaved={() => qc.invalidateQueries({ queryKey: ["connected-accounts"] })} />}
        {tab === "sendgrid" && <SendGridForm onSaved={() => qc.invalidateQueries({ queryKey: ["connected-accounts"] })} />}
      </div>

      <div className="mt-4 flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
        <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
        <div>
          <strong>SMTP & Gmail App Password</strong> go through ports 25/465/587
          which Render&apos;s free + starter tiers block. If your connect
          attempt times out, use{" "}
          <button className="underline" onClick={() => setTab("resend")}>Resend</button>{" "}
          or{" "}
          <button className="underline" onClick={() => setTab("sendgrid")}>SendGrid</button>{" "}
          (pure HTTPS — never blocked). Self-hosted backends and Render
          plans with SMTP unblocked work natively.
        </div>
      </div>
    </div>
  );
}

function ProviderBadge({ provider }: { provider: string }) {
  const styles: Record<string, string> = {
    smtp: "bg-slate-100 text-slate-700",
    gmail: "bg-red-50 text-red-700",
    resend: "bg-purple-50 text-purple-700",
    sendgrid: "bg-blue-50 text-blue-700",
  };
  return (
    <span
      className={`grid h-9 w-9 flex-shrink-0 place-items-center rounded-full text-[10px] font-semibold uppercase ${
        styles[provider] || "bg-slate-100 text-slate-600"
      }`}
    >
      {provider.slice(0, 4)}
    </span>
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
    mutationFn: () =>
      api("/integrations/smtp/connect", {
        method: "POST",
        body: {
          host: host.trim(),
          port,
          username: username.trim(),
          password,
          from_email: fromEmail.trim() || username.trim(),
        },
      }),
    onSuccess: () => {
      // Clear the whole form so the user can immediately add ANOTHER
      // sender (different from-address) without first clearing the
      // last one. Multiple senders coexist — see backend _upsert_account.
      setHost("");
      setUsername("");
      setPassword("");
      setFromEmail("");
      onSaved();
    },
  });

  return (
    <div>
      <div className="mb-3 rounded-md border border-indigo-100 bg-indigo-50/50 p-3 text-xs text-indigo-900">
        <strong>Use any email — totally independent from your LeadCaptura
        login.</strong> Paste the SMTP credentials of whichever mailbox you
        want to send from (Hostinger, Zoho, Mailgun, Gmail, your own
        server …) and recipients will see that address as the sender.
        You can save multiple senders side-by-side and pick one at send time.
      </div>
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
            <option value={2525}>2525 — provider relay (Render-friendly)</option>
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
      <label className="label mt-3">
        From address — what recipients see (defaults to username)
      </label>
      <input
        className="input"
        placeholder="hello@yourcompany.com"
        value={fromEmail}
        onChange={(e) => setFromEmail(e.target.value)}
      />
      <p className="mt-1 text-[11px] text-slate-500">
        This is the &quot;From:&quot; address on every email you send through
        this sender. It does NOT have to match your LeadCaptura login email.
      </p>

      {save.isError && (
        <p className="mt-3 text-sm text-red-600">
          {(() => {
            const e = save.error?.message || "Connect failed.";
            if (/smtp_auth_failed/i.test(e)) {
              return "Username or password rejected by the SMTP server. Double-check the credentials.";
            }
            if (/relay_not_configured/i.test(e)) {
              return "Direct SMTP is blocked on this server and the Vercel SMTP relay isn't configured yet. Use Resend or SendGrid for now — they work over HTTPS.";
            }
            return e;
          })()}
        </p>
      )}
      {save.isSuccess && (
        <div className="mt-3 rounded-md border border-emerald-200 bg-emerald-50 p-3">
          <p className="flex items-center gap-1.5 text-sm font-medium text-emerald-800">
            <CheckCircle2 className="h-4 w-4" /> SMTP verified and saved.
          </p>
          {(save.data as { via?: string } | undefined)?.via === "relay" && (
            <p className="mt-1 pl-5.5 text-xs text-emerald-700">
              Your backend host blocks direct SMTP, so we&apos;ll send through the
              Vercel relay automatically — no extra setup needed.
            </p>
          )}
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
      <label className="label mt-3">App Password (16 chars, no spaces)</label>
      <input
        className="input"
        type="password"
        placeholder="abcdabcdabcdabcd"
        value={appPassword}
        onChange={(e) => setAppPassword(e.target.value)}
      />
      <p className="mt-1 text-xs text-slate-500">
        Generate one at{" "}
        <a
          className="underline"
          href="https://myaccount.google.com/apppasswords"
          target="_blank"
          rel="noopener noreferrer"
        >
          myaccount.google.com/apppasswords
        </a>{" "}
        (requires 2-Step Verification).
      </p>
      {save.isError && (
        <p className="mt-3 text-sm text-red-600">
          {save.error?.message || "Connect failed."}
        </p>
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
      <label className="label">Resend API key</label>
      <input
        className="input"
        type="password"
        placeholder="re_…"
        value={apiKey}
        onChange={(e) => setApiKey(e.target.value)}
      />
      <label className="label mt-3">Verified sender</label>
      <input
        className="input"
        placeholder="hello@yourdomain.com"
        value={fromEmail}
        onChange={(e) => setFromEmail(e.target.value)}
      />
      <p className="mt-1 text-xs text-slate-500">
        Free 3,000/mo. Verify a domain at{" "}
        <a className="underline" href="https://resend.com/domains" target="_blank" rel="noopener noreferrer">
          resend.com/domains
        </a>.
      </p>
      {save.isError && (
        <p className="mt-3 text-sm text-red-600">
          {save.error?.message || "Connect failed."}
        </p>
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
      <label className="label">SendGrid API key</label>
      <input
        className="input"
        type="password"
        placeholder="SG.…"
        value={apiKey}
        onChange={(e) => setApiKey(e.target.value)}
      />
      <label className="label mt-3">Verified sender</label>
      <input
        className="input"
        placeholder="hello@yourdomain.com"
        value={fromEmail}
        onChange={(e) => setFromEmail(e.target.value)}
      />
      <p className="mt-1 text-xs text-slate-500">
        Free 100/day forever. Verify a sender at{" "}
        <a className="underline" href="https://app.sendgrid.com/settings/sender_auth" target="_blank" rel="noopener noreferrer">
          app.sendgrid.com/settings/sender_auth
        </a>.
      </p>
      {save.isError && (
        <p className="mt-3 text-sm text-red-600">
          {save.error?.message || "Connect failed."}
        </p>
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
