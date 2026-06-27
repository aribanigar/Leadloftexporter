/**
 * Autonomous campaign drain — sends queued campaign email WITHOUT a browser.
 *
 * Why this exists: on the free tier Render blocks outbound SMTP, so campaign
 * email is dispatched from Vercel's network. The browser normally drives that
 * (the campaign page's poll), which means sending stops when you close the tab.
 *
 * This route lets an external scheduler (a GitHub Action, every few minutes)
 * keep every 'sending' campaign draining with no tab open:
 *   1. ask the backend (cron-authed) which campaigns are 'sending',
 *   2. for each, prepare a batch → send via nodemailer → commit results,
 *   3. repeat until the time budget runs out.
 *
 * Auth: the shared CRON_SECRET, passed as ?token= or the X-Cron-Token header,
 * AND forwarded to the backend's cron endpoints. If CRON_SECRET is unset this
 * route refuses to run (it sends real email).
 */
import { NextRequest, NextResponse } from "next/server";
import { sendJob, type EmailJob } from "@/lib/campaign-send";

export const runtime = "nodejs";
export const maxDuration = 60;

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

// Stop starting new work this invocation once we're near the serverless limit,
// so we always finish the in-flight commit cleanly.
const BUDGET_MS = 50_000;

interface PreparedTick {
  campaign_status?: string;
  jobs?: EmailJob[];
  note?: string;
}

export async function POST(req: NextRequest) {
  return run(req);
}
export async function GET(req: NextRequest) {
  return run(req);
}

async function run(req: NextRequest) {
  const secret = (process.env.CRON_SECRET || "").trim();
  if (!secret) {
    return NextResponse.json(
      { ok: false, error: "cron_disabled — set CRON_SECRET on Vercel to enable autonomous sending" },
      { status: 503 },
    );
  }
  const url = new URL(req.url);
  const token = url.searchParams.get("token") || req.headers.get("x-cron-token") || "";
  if (token !== secret) {
    return NextResponse.json({ ok: false, error: "bad_cron_token" }, { status: 401 });
  }

  const startedAt = Date.now();
  const cronHeaders = { "Content-Type": "application/json", "X-Cron-Token": secret };

  // 1) Which campaigns are sending?
  let campaigns: Array<{ id: string; name?: string }> = [];
  try {
    const res = await fetch(`${API_URL}/api/v1/campaigns/cron/sending`, { headers: cronHeaders });
    if (!res.ok) {
      const e = await res.json().catch(() => ({})) as { detail?: string };
      return NextResponse.json({ ok: false, error: e.detail || `sending_list_${res.status}` }, { status: res.status });
    }
    const data = await res.json() as { campaigns?: Array<{ id: string; name?: string }> };
    campaigns = data.campaigns ?? [];
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "list_failed" }, { status: 502 });
  }

  if (campaigns.length === 0) {
    return NextResponse.json({ ok: true, campaigns: 0, sent: 0, note: "nothing_sending" });
  }

  let totalSent = 0;
  let totalFailed = 0;
  const perCampaign: Array<{ id: string; name?: string; sent: number; failed: number; note?: string }> = [];

  // 2) Round-robin a batch through each sending campaign until the budget runs
  //    out. Each pass dispatches one prepared batch per campaign; multiple
  //    passes keep a single invocation draining as much as it safely can.
  let pass = 0;
  while (Date.now() - startedAt < BUDGET_MS) {
    let didWork = false;
    for (const c of campaigns) {
      if (Date.now() - startedAt > BUDGET_MS) break;

      // prepare
      let prepared: PreparedTick;
      try {
        const pr = await fetch(`${API_URL}/api/v1/campaigns/cron/${c.id}/prepare`, {
          method: "POST",
          headers: cronHeaders,
          body: "{}",
        });
        if (!pr.ok) continue;
        prepared = await pr.json() as PreparedTick;
      } catch {
        continue;
      }

      const jobs = prepared.jobs ?? [];
      if (jobs.length === 0) {
        if (pass === 0) perCampaign.push({ id: c.id, name: c.name, sent: 0, failed: 0, note: prepared.note });
        continue;
      }
      didWork = true;

      // send
      const results: Array<{ recipient_id: string; message_id: string; ok: boolean; error: string | null }> = [];
      for (const job of jobs) {
        if (Date.now() - startedAt > BUDGET_MS) break;
        const r = await sendJob(job);
        results.push({ recipient_id: job.recipient_id, message_id: job.message_id, ok: r.ok, error: r.error ?? null });
        if (r.ok) totalSent++; else totalFailed++;
      }

      // commit (only what we actually attempted)
      if (results.length) {
        try {
          await fetch(`${API_URL}/api/v1/campaigns/cron/${c.id}/commit`, {
            method: "POST",
            headers: cronHeaders,
            body: JSON.stringify({ results }),
          });
        } catch { /* the backend reclaims any uncommitted 'sending' rows */ }
        const pc = perCampaign.find((p) => p.id === c.id);
        const s = results.filter((r) => r.ok).length;
        const f = results.length - s;
        if (pc) { pc.sent += s; pc.failed += f; }
        else perCampaign.push({ id: c.id, name: c.name, sent: s, failed: f });
      }
    }
    pass++;
    if (!didWork) break; // every campaign returned an empty batch — nothing due
  }

  return NextResponse.json({
    ok: true,
    campaigns: campaigns.length,
    passes: pass,
    sent: totalSent,
    failed: totalFailed,
    detail: perCampaign,
    elapsed_ms: Date.now() - startedAt,
  });
}
