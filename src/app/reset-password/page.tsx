"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { FormEvent, Suspense, useState } from "react";
import { api, setSession } from "@/lib/api";
import { useAuth } from "@/lib/auth";

interface TokenResponse {
  access_token: string;
  user: { id: string; email: string; first_name?: string | null; last_name?: string | null; avatar_url?: string | null };
  workspaces: Array<{ id: string; name: string; slug: string; role: string }>;
  current_workspace_id: string | null;
}

function ResetForm() {
  const router = useRouter();
  const params = useSearchParams();
  const token = params.get("token") || "";
  const bootstrap = useAuth((s) => s.bootstrap);

  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [pending, setPending] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  if (!token) {
    return (
      <>
        <h1 className="mb-2 text-center text-lg font-semibold">Reset link is missing a token</h1>
        <p className="mb-6 text-center text-sm text-slate-500">
          Use the link from the email we sent. If it&apos;s older than 30 minutes, request a new one.
        </p>
        <Link href="/forgot-password" className="btn-primary block w-full text-center">
          Request a new link
        </Link>
      </>
    );
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    if (password.length < 8) { setErr("Password must be at least 8 characters."); return; }
    if (password !== confirm) { setErr("Passwords don't match."); return; }
    setPending(true);
    try {
      const res = await api<TokenResponse>("/auth/reset-password", {
        method: "POST",
        body: { token, password },
      });
      // Auto-sign-in once the reset succeeds — saves the user another step.
      // setSession writes the token to localStorage; bootstrap() rehydrates
      // the auth store so /prospecting renders instead of bouncing to /login.
      setSession(res.access_token, res.current_workspace_id);
      await bootstrap();
      router.replace("/prospecting");
    } catch (e: unknown) {
      let message = e instanceof Error ? e.message : "Couldn't reset password";
      if (/invalid_or_expired_token/i.test(message)) {
        message = "This reset link is invalid or has expired. Request a new one.";
      } else if (/Failed to fetch|NetworkError|TypeError/i.test(message)) {
        message = "Can't reach the LeadCaptura service. Retry in ~30s.";
      }
      setErr(message);
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <h1 className="mb-2 text-center text-lg font-semibold">Set a new password</h1>
      <p className="mb-6 text-center text-sm text-slate-500">
        Choose a strong password. You&apos;ll be signed in once it&apos;s saved.
      </p>
      <form onSubmit={onSubmit} className="space-y-4">
        <div>
          <label className="label">New password</label>
          <input
            className="input"
            type="password"
            required
            autoFocus
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
          />
        </div>
        <div>
          <label className="label">Confirm password</label>
          <input
            className="input"
            type="password"
            required
            minLength={8}
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            placeholder="••••••••"
          />
        </div>
        {err && <p className="text-sm text-rose-600">{err}</p>}
        <button className="btn-primary w-full" disabled={pending || password.length < 8} type="submit">
          {pending ? "Saving…" : "Save password & sign in"}
        </button>
      </form>
      <p className="mt-6 text-center text-sm text-slate-500">
        <Link className="text-brand-600 hover:underline" href="/login">
          Back to sign in
        </Link>
      </p>
    </>
  );
}

export default function ResetPasswordPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
      <div className="w-full max-w-md rounded-xl bg-white p-8 shadow-card">
        <div className="mb-6 flex items-center justify-center gap-2">
          <div className="grid h-9 w-9 place-items-center rounded-md bg-gradient-to-br from-brand-500 to-pink-500 text-white font-bold">L</div>
          <span className="text-xl font-semibold tracking-tight">LeadCaptura</span>
        </div>
        <Suspense fallback={<p className="text-center text-sm text-slate-500">Loading…</p>}>
          <ResetForm />
        </Suspense>
      </div>
    </div>
  );
}
