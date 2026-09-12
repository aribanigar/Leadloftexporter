"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useState } from "react";
import { useAuth } from "@/lib/auth";
import { isNetworkErrorMessage, withNetworkRetry } from "@/lib/backoff-retry";

export default function LoginPage() {
  const router = useRouter();
  const login = useAuth((s) => s.login);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  // Pre-warming now happens app-wide, the instant ANY page mounts (see
  // <Providers> in src/components/providers.tsx) — that covers this page
  // too, and starts even earlier for anyone who was already elsewhere in the
  // app before landing here.

  // Sign-in is auto-retried (see withNetworkRetry, ~43s of total backoff) so
  // a Render cold-start, Neon wake-up, or any other transient backend blip
  // doesn't strand the user. Only NETWORK errors are retried — wrong-password
  // / disabled-user fail fast (no point retrying a 401).
  function classifyError(message: string): "network" | "credentials" | "disabled" | "license" | "other" {
    if (isNetworkErrorMessage(message)) return "network";
    if (/invalid_credentials|wrong email|wrong password/i.test(message)) return "credentials";
    if (/inactive_user|disabled/i.test(message)) return "disabled";
    if (/license_required/i.test(message)) return "license";
    return "other";
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    setPending(true);
    try {
      await withNetworkRetry(
        () => login(email, password),
        (attempt, max) =>
          setStatusMsg(
            attempt === 0 ? "Connecting…" : `Backend is waking up — retrying (attempt ${attempt + 1} of ${max + 1})…`,
          ),
      );
      router.replace("/prospecting");
      return;
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : "Sign in failed";
      const kind = classifyError(message);
      let friendly = message;
      if (kind === "credentials") friendly = "Wrong email or password.";
      else if (kind === "disabled") friendly = "This account is disabled. Contact support.";
      else if (kind === "license") friendly = "Your license key isn't active. Contact your admin.";
      else if (kind === "network") friendly = "Can't reach the LeadCaptura service after several attempts. It may be cold-starting (give it 1–2 minutes) or the service is down. Try again.";
      setErr(friendly);
    } finally {
      setStatusMsg(null);
      setPending(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-emerald-50 via-slate-50 to-indigo-50 px-4">
      <div className="w-full max-w-md rounded-xl border border-white/60 bg-white/90 p-8 shadow-card backdrop-blur">
        <div className="mb-6 flex items-center justify-center gap-2">
          <div className="grid h-9 w-9 place-items-center rounded-md bg-gradient-to-br from-brand-500 to-pink-500 text-white font-bold">L</div>
          <span className="text-xl font-semibold tracking-tight">LeadCaptura</span>
        </div>
        <h1 className="mb-6 text-center text-lg font-semibold">Sign in to your workspace</h1>
        <form onSubmit={onSubmit} className="space-y-4" autoComplete="off">
          <div>
            <label className="label">Email</label>
            <input
              className="input"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@company.com"
              autoComplete="off"
              name="login-email"
            />
          </div>
          <div>
            <div className="mb-1 flex items-center justify-between">
              <label className="label mb-0">Password</label>
              <Link
                href="/forgot-password"
                className="text-xs font-medium text-brand-600 hover:underline"
              >
                Forgot password?
              </Link>
            </div>
            <input
              className="input"
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              autoComplete="new-password"
              name="login-password"
            />
          </div>
          {err && <p className="text-sm text-rose-600">{err}</p>}
          {statusMsg && !err && <p className="text-sm text-amber-700">{statusMsg}</p>}
          <button className="btn-primary w-full" disabled={pending} type="submit">
            {pending ? "Signing in…" : "Sign in"}
          </button>
        </form>
        <p className="mt-6 text-center text-sm text-slate-500">
          New here?{" "}
          <Link className="text-brand-600 hover:underline" href="/register">
            Create an account
          </Link>
        </p>
      </div>
    </div>
  );
}
