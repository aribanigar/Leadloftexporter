"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useState } from "react";
import { useAuth } from "@/lib/auth";

export default function LoginPage() {
  const router = useRouter();
  const login = useAuth((s) => s.login);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    setPending(true);
    try {
      await login(email, password);
      router.replace("/prospecting");
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : "Sign in failed";
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
        <h1 className="mb-6 text-center text-lg font-semibold">Sign in to your workspace</h1>
        <form onSubmit={onSubmit} className="space-y-4">
          <div>
            <label className="label">Email</label>
            <input
              className="input"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@company.com"
            />
          </div>
          <div>
            <label className="label">Password</label>
            <input
              className="input"
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
            />
          </div>
          {err && <p className="text-sm text-rose-600">{err}</p>}
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
