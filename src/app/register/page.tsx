"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Check, Copy } from "lucide-react";
import { FormEvent, useState } from "react";
import { useAuth } from "@/lib/auth";
import { copyToClipboard } from "@/lib/utils";

function licenseKeyErrorMessage(message: string): string {
  if (message === "license_key_required") return "A license key is required — ask your admin for one.";
  if (message === "invalid_license_key") return "That license key isn't valid.";
  if (message === "license_key_revoked") return "That license key has been revoked.";
  if (message === "license_key_expired") return "That license key has expired.";
  if (message === "license_key_wrong_email") return "That license key was issued for a different email address.";
  if (message === "email_in_use") return "An account with that email already exists.";
  return message;
}

export default function RegisterPage() {
  const router = useRouter();
  const register = useAuth((s) => s.register);
  const [form, setForm] = useState({
    email: "",
    password: "",
    first_name: "",
    last_name: "",
    workspace_name: "",
    license_key: "",
  });
  const [err, setErr] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [issuedApiKey, setIssuedApiKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    setPending(true);
    try {
      const { issuedApiKey } = await register(form);
      if (issuedApiKey) {
        // Don't navigate away yet — this is the only time the API key is
        // ever shown. The license key they just typed also already works
        // for the extension now (it's bound to their new workspace).
        setIssuedApiKey(issuedApiKey);
      } else {
        router.replace("/prospecting");
      }
    } catch (e: unknown) {
      setErr(e instanceof Error ? licenseKeyErrorMessage(e.message) : "Could not create account");
    } finally {
      setPending(false);
    }
  }

  if (issuedApiKey) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-emerald-50 via-slate-50 to-indigo-50 px-4">
        <div className="w-full max-w-md rounded-xl border border-white/60 bg-white/90 p-8 shadow-card backdrop-blur">
          <div className="mb-6 flex items-center justify-center gap-2">
            <div className="grid h-9 w-9 place-items-center rounded-md bg-gradient-to-br from-brand-500 to-pink-500 text-white font-bold">L</div>
            <span className="text-xl font-semibold tracking-tight">LeadCaptura</span>
          </div>
          <h1 className="mb-2 text-center text-lg font-semibold">You&apos;re all set</h1>
          <p className="mb-4 text-center text-sm text-slate-500">
            Your workspace is ready. Copy this API key now — it won&apos;t be shown again — and paste it,
            along with the license key you just used to register, into the Chrome extension&apos;s Options page.
          </p>
          <div className="mb-4 rounded-md border border-amber-200 bg-amber-50 p-3">
            <div className="mb-1 text-xs font-medium text-amber-700">API key</div>
            <div className="flex items-center gap-2">
              <code className="flex-1 break-all rounded bg-white px-2 py-1 font-mono text-xs">{issuedApiKey}</code>
              <button
                className="btn-secondary"
                onClick={async () => {
                  const ok = await copyToClipboard(issuedApiKey);
                  if (ok) { setCopied(true); setTimeout(() => setCopied(false), 2000); }
                }}
              >
                {copied ? (<><Check className="h-4 w-4 text-emerald-600" /> Copied</>) : (<><Copy className="h-4 w-4" /> Copy</>)}
              </button>
            </div>
          </div>
          <button className="btn-primary w-full" onClick={() => router.replace("/prospecting")}>
            Continue to dashboard
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-emerald-50 via-slate-50 to-indigo-50 px-4">
      <div className="w-full max-w-md rounded-xl border border-white/60 bg-white/90 p-8 shadow-card backdrop-blur">
        <div className="mb-6 flex items-center justify-center gap-2">
          <div className="grid h-9 w-9 place-items-center rounded-md bg-gradient-to-br from-brand-500 to-pink-500 text-white font-bold">L</div>
          <span className="text-xl font-semibold tracking-tight">LeadCaptura</span>
        </div>
        <h1 className="mb-1 text-center text-lg font-semibold">Create your workspace</h1>
        <p className="mb-6 text-center text-sm text-slate-500">
          You&apos;ll need a license key from your admin to finish creating an account.
        </p>
        <form onSubmit={onSubmit} className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">First name</label>
              <input
                className="input"
                value={form.first_name}
                onChange={(e) => setForm({ ...form, first_name: e.target.value })}
              />
            </div>
            <div>
              <label className="label">Last name</label>
              <input
                className="input"
                value={form.last_name}
                onChange={(e) => setForm({ ...form, last_name: e.target.value })}
              />
            </div>
          </div>
          <div>
            <label className="label">Workspace name</label>
            <input
              className="input"
              placeholder="Acme Sales"
              value={form.workspace_name}
              onChange={(e) => setForm({ ...form, workspace_name: e.target.value })}
            />
          </div>
          <div>
            <label className="label">Email</label>
            <input
              className="input"
              type="email"
              required
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
            />
          </div>
          <div>
            <label className="label">Password</label>
            <input
              className="input"
              type="password"
              required
              minLength={8}
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
              placeholder="At least 8 characters"
            />
          </div>
          <div>
            <label className="label">License key</label>
            <input
              className="input font-mono"
              required
              value={form.license_key}
              onChange={(e) => setForm({ ...form, license_key: e.target.value })}
              placeholder="lclk_…"
            />
          </div>
          {err && <p className="text-sm text-rose-600">{err}</p>}
          <button className="btn-primary w-full" disabled={pending} type="submit">
            {pending ? "Creating…" : "Create workspace"}
          </button>
        </form>
        <p className="mt-6 text-center text-sm text-slate-500">
          Already have an account?{" "}
          <Link className="text-brand-600 hover:underline" href="/login">
            Sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
