/**
 * Keep-alive proxy — pings whichever backend the frontend is ACTUALLY
 * configured to use, so nothing external ever needs to hardcode a Render
 * hostname.
 *
 * Every previous keep-alive mechanism (the GitHub Actions cron, a scheduled
 * pinger) hit a Render URL directly, hardcoded in that mechanism's own
 * config. Every time the backend moved to a new Render service, all of
 * those had to be updated by hand — and when they weren't, the "keep it
 * warm" pings silently kept warming a service nobody used anymore.
 *
 * This route removes that class of bug: it always reads NEXT_PUBLIC_API_URL
 * (the same env var the frontend itself uses for every API call) and pings
 * THAT backend's /health. External pingers now hit this one stable URL
 * (this route's own address, which never changes) instead of a Render host
 * directly — so switching backends on Vercel is the only update ever
 * needed, and every keep-alive layer follows automatically.
 */
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 20;

const API_URL = process.env.NEXT_PUBLIC_API_URL || "";

export async function GET() {
  if (!API_URL) {
    return NextResponse.json({ ok: false, error: "NEXT_PUBLIC_API_URL not configured" }, { status: 500 });
  }
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 15_000);
    const res = await fetch(`${API_URL.replace(/\/$/, "")}/health`, {
      cache: "no-store",
      signal: ctrl.signal,
    }).finally(() => clearTimeout(t));
    return NextResponse.json({ ok: res.ok, backend_status: res.status });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}
