"use client";

import Link from "next/link";
import { FormEvent, useState } from "react";
import { api } from "@/lib/api";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [pending, setPending] = useState(false);
  const [sent, setSent] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    setPending(true);
    try {
      await api("/auth/forgot-password", { method: "POST", body: { email: email.trim() } });
      setSent(true);
    } catch (e: unknown) {
      let message = e instanceof Error ? e.message : "Couldn't send reset email";
      if (/Failed to fetch|NetworkError|TypeError/i.test(message)) {
        message = "Can't reach the LeadCaptura service right now. Retry in ~30s.";
      }
      setErr(message);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
      <div className="w-full max-w-md rounded-xl bg-white p-8 shadow-card">
        <div className="mb-6 flex items-center justify-center gap-2">
          <div className="grid h-9 w-9 place-items-center rounded-md bg-gradient-to-br from-brand-500 to-pink-500 text-white font-bold">L</div>
          <span className="text-xl font-semibold tracking-tight">LeadCaptura</span>
        </div>

        {sent ? (
          <>
            <h1 className="mb-2 text-center text-lg font-semibold">Check your email</h1>
            <p className="mb-6 text-center text-sm text-slate-500">
              If an account exists for <span className="font-medium text-slate-700">{email}</span>,
              we just sent a reset link. It expires in 30 minutes.
            </p>
            <Link href="/login" className="btn-primary block w-full text-center">
              Back to sign in
            </Link>
            <p className="mt-4 text-center text-xs text-slate-400">
              Didn&apos;t get it? Check spam, or{" "}
              <button
                onClick={() => { setSent(false); setErr(null); }}
                className="text-brand-600 hover:underline"
              >
                try again
              </button>
              .
            </p>
          </>
        ) : (
          <>
            <h1 className="mb-2 text-center text-lg font-semibold">Reset your password</h1>
            <p className="mb-6 text-center text-sm text-slate-500">
              Enter your email and we&apos;ll send you a link to set a new password.
            </p>
            <form onSubmit={onSubmit} className="space-y-4">
              <div>
                <label className="label">Email</label>
                <input
                  className="input"
                  type="email"
                  required
                  autoFocus
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@company.com"
                />
              </div>
              {err && <p className="text-sm text-rose-600">{err}</p>}
              <button className="btn-primary w-full" disabled={pending || !email.trim()} type="submit">
                {pending ? "Sending…" : "Send reset link"}
              </button>
            </form>
            <p className="mt-6 text-center text-sm text-slate-500">
              Remembered it?{" "}
              <Link className="text-brand-600 hover:underline" href="/login">
                Back to sign in
              </Link>
            </p>
          </>
        )}
      </div>
    </div>
  );
}
