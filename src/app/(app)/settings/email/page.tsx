"use client";

import { useState } from "react";
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
} from "lucide-react";
import { api, getToken, getWorkspaceId } from "@/lib/api";

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

  const { data: accounts, isLoading } = useQuery<ConnectedAccount[]>({
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
              onDisconnect={() => {
                if (window.confirm(`Disconnect ${a.external_id || a.label || a.provider}?`)) {
                  disconnect.mutate(a.id);
                }
              }}
            />
          ))
        )}
      </div>

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
  onDisconnect,
}: {
  account: ConnectedAccount;
  onDisconnect: () => void;
}) {
  const test = useMutation<{ ok: boolean; to: string }, Error, void>({
    mutationFn: () =>
      api(`/integrations/accounts/${a.id}/test`, { method: "POST", body: {} }),
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
          {test.isError && (
            <>
              <span>·</span>
              <span className="text-red-500">{test.error?.message || "test failed"}</span>
            </>
          )}
        </div>
      </div>
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
