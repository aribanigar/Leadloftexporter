"use client";

/**
 * Reusable Connect SMTP modal.
 *
 * Mounts the same SMTP form that lives in /settings/email but in a modal
 * over whatever page the user is currently on (Outreach, Lead Detail, the
 * Messaging composer…) so they never have to navigate away to set up
 * their sender. Hits the same /integrations/smtp/connect endpoint, which
 * verifies the credentials directly first and falls back through the
 * Vercel SMTP relay when Render's outbound-port block trips.
 *
 * Props:
 *  - open / onClose                modal visibility
 *  - onConnected({ id })           fires after a successful save so the
 *                                   parent can invalidate its
 *                                   ["connected-accounts"] query and
 *                                   immediately use the new sender.
 */
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { X, Mail, Loader2, Plug, CheckCircle2, AlertCircle } from "lucide-react";
import { api } from "@/lib/api";

interface Props {
  open: boolean;
  onClose: () => void;
  onConnected?: (acct: { id: string; via?: string }) => void;
}

export function ConnectSmtpModal({ open, onClose, onConnected }: Props) {
  const [host, setHost] = useState("");
  const [port, setPort] = useState<number>(587);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [fromEmail, setFromEmail] = useState("");

  const save = useMutation<
    { id: string; label?: string; via?: string },
    Error,
    void
  >({
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
    onSuccess: (r) => {
      setHost("");
      setUsername("");
      setPassword("");
      setFromEmail("");
      onConnected?.({ id: r.id, via: r.via });
    },
  });

  if (!open) return null;
  const errMsg = save.error?.message || "";
  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-slate-900/50 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-xl bg-white p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Mail className="h-5 w-5 text-indigo-600" />
            <h2 className="text-sm font-semibold">Connect an SMTP sender</h2>
          </div>
          <button
            className="rounded p-1 text-slate-400 hover:bg-slate-100"
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <p className="mb-3 rounded-md bg-indigo-50/60 p-3 text-xs text-indigo-900">
          Paste the SMTP credentials of ANY mailbox you want to send from
          (Hostinger, Zoho, Mailgun, Gmail, your own server …). Recipients
          will see that address as the sender. It does not have to match
          your LeadCaptura login email.
        </p>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">SMTP host</label>
            <input
              className="input"
              placeholder="smtp.your-provider.com"
              value={host}
              onChange={(e) => setHost(e.target.value)}
              autoFocus
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
        <label className="label mt-3">From address (defaults to username)</label>
        <input
          className="input"
          placeholder="hello@yourcompany.com"
          value={fromEmail}
          onChange={(e) => setFromEmail(e.target.value)}
        />

        {save.isError && (
          <p className="mt-3 flex items-start gap-1.5 text-sm text-red-600">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
            {(() => {
              if (/smtp_auth_failed/i.test(errMsg)) {
                return "Username or password rejected by the SMTP server. Double-check the credentials.";
              }
              if (/relay_not_configured/i.test(errMsg)) {
                return "Direct SMTP is blocked on this server and the Vercel relay isn't configured yet.";
              }
              return errMsg || "Connect failed.";
            })()}
          </p>
        )}
        {save.isSuccess && (
          <p className="mt-3 flex items-center gap-1.5 text-sm text-emerald-700">
            <CheckCircle2 className="h-4 w-4" /> SMTP verified and saved.
            {save.data?.via === "relay" && (
              <span className="ml-1 text-xs text-emerald-600">
                (sending via Vercel relay)
              </span>
            )}
          </p>
        )}

        <div className="mt-5 flex items-center justify-end gap-2">
          <button className="btn-secondary" onClick={onClose}>
            {save.isSuccess ? "Done" : "Cancel"}
          </button>
          <button
            className="btn-primary disabled:opacity-50"
            disabled={!host || !username || !password || save.isPending}
            onClick={() => save.mutate()}
          >
            {save.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Plug className="h-4 w-4" />
            )}
            {save.isPending ? "Verifying…" : "Connect SMTP"}
          </button>
        </div>
      </div>
    </div>
  );
}
