/**
 * Campaign tick — browser-driven send loop that runs from Vercel's network.
 *
 * Problem: Render's free/starter tiers block outbound SMTP ports 25/465/587,
 * and Render→Vercel relay calls are blocked by Vercel Deployment Protection.
 *
 * Solution: the browser calls THIS Next.js route (same Vercel origin, no
 * Deployment Protection issue). This route:
 *   1. POSTs to Python /campaigns/{id}/prepare-tick — Python renders content,
 *      injects tracking, creates DB rows, and returns the jobs with SMTP creds.
 *   2. Sends each email via nodemailer (outbound SMTP from Vercel works fine).
 *   3. POSTs results back to /campaigns/{id}/commit-tick — Python updates
 *      CampaignRecipient + EmailMessage status and campaign counters.
 *
 * Supports smtp, resend, and sendgrid providers. Gmail falls back to the
 * existing Python tick (Gmail OAuth works fine from Render via HTTPS).
 */
import { NextRequest, NextResponse } from "next/server";
import { sendJob, type EmailJob } from "@/lib/campaign-send";

export const runtime = "nodejs";
export const maxDuration = 60;

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const authorization = req.headers.get("authorization") || "";
  const workspaceId = req.headers.get("x-workspace-id") || "";

  const pyHeaders = {
    "Content-Type": "application/json",
    "Authorization": authorization,
    "X-Workspace-Id": workspaceId,
  };

  // Step 1: prepare batch from Python
  const prepRes = await fetch(`${API_URL}/api/v1/campaigns/${id}/prepare-tick`, {
    method: "POST",
    headers: pyHeaders,
    body: "{}",
  });

  if (!prepRes.ok) {
    const e = await prepRes.json().catch(() => ({})) as Record<string, unknown>;
    return NextResponse.json(
      { ok: false, error: (e as { detail?: string }).detail || "prepare_failed" },
      { status: prepRes.status }
    );
  }

  const prepared = await prepRes.json() as {
    campaign_status: string;
    jobs: EmailJob[];
    note?: string;
  };

  if (!prepared.jobs || prepared.jobs.length === 0) {
    return NextResponse.json({
      status: prepared.campaign_status,
      this_tick: { sent: 0, failed: 0, skipped: 0 },
      note: prepared.note ?? null,
    });
  }

  // Step 2: send each job (sequential to avoid SMTP rate-limit hammering).
  // Hard wall-clock budget: stop starting NEW sends once we're close to the
  // serverless time limit, so we ALWAYS have time to POST results to
  // commit-tick. Any job we didn't get to stays "sending" and is reclaimed by
  // the next prepare-tick — far better than the whole function timing out and
  // committing nothing. The browser polls again in 3s and picks up the rest.
  const SEND_BUDGET_MS = 40_000;
  const startedAt = Date.now();
  const results: Array<{
    recipient_id: string;
    message_id: string;
    ok: boolean;
    error: string | null;
  }> = [];

  for (const job of prepared.jobs) {
    if (Date.now() - startedAt > SEND_BUDGET_MS) break;
    const r = await sendJob(job);
    results.push({
      recipient_id: job.recipient_id,
      message_id: job.message_id,
      ok: r.ok,
      error: r.error ?? null,
    });
  }

  // Nothing actually sent (e.g. the very first send ate the budget) — return
  // without committing so the rows stay claimable.
  if (results.length === 0) {
    return NextResponse.json({
      status: prepared.campaign_status,
      this_tick: { sent: 0, failed: 0, skipped: 0 },
      note: "no_sends_this_tick",
    });
  }

  // Step 3: commit results to Python
  const commitRes = await fetch(`${API_URL}/api/v1/campaigns/${id}/commit-tick`, {
    method: "POST",
    headers: pyHeaders,
    body: JSON.stringify({ results }),
  });

  if (!commitRes.ok) {
    const e = await commitRes.json().catch(() => ({})) as Record<string, unknown>;
    return NextResponse.json(
      { ok: false, error: (e as { detail?: string }).detail || "commit_failed" },
      { status: commitRes.status }
    );
  }

  const committed = await commitRes.json();
  return NextResponse.json(committed);
}
