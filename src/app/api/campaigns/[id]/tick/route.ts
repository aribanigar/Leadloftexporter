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
import nodemailer from "nodemailer";

export const runtime = "nodejs";
export const maxDuration = 60;

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

interface SmtpConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  from_email: string;
}

interface SendConfig {
  provider: string;
  smtp?: SmtpConfig;
  resend_api_key?: string;
  sendgrid_api_key?: string;
}

interface EmailJob {
  recipient_id: string;
  message_id: string;
  to: string;
  from_name: string;
  from_email: string;
  subject: string;
  html: string;
  text: string;
  send_config: SendConfig;
}

async function sendJob(job: EmailJob): Promise<{ ok: boolean; error?: string }> {
  const { send_config } = job;
  const fromHeader = job.from_name
    ? `${job.from_name} <${job.from_email}>`
    : job.from_email;

  if (send_config.provider === "smtp" && send_config.smtp) {
    const { host, port, username, password } = send_config.smtp;
    const useImplicitTls = Number(port) === 465;
    // tls.rejectUnauthorized: false is required for Hostinger, Zoho, etc. —
    // see /api/smtp-connect for the full rationale.
    const t = nodemailer.createTransport({
      host,
      port: Number(port),
      secure: useImplicitTls,
      requireTLS: !useImplicitTls,
      auth: { user: username, pass: password },
      tls: { rejectUnauthorized: false },
      connectionTimeout: 15_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    });
    try {
      await t.sendMail({
        from: fromHeader,
        to: job.to,
        subject: job.subject,
        html: job.html || undefined,
        text: job.text || undefined,
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      try { t.close(); } catch { /* ignore */ }
    }
  }

  if (send_config.provider === "resend" && send_config.resend_api_key) {
    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${send_config.resend_api_key}`,
        },
        body: JSON.stringify({
          from: fromHeader,
          to: [job.to],
          subject: job.subject,
          html: job.html || undefined,
          text: job.text || undefined,
        }),
      });
      if (res.ok) return { ok: true };
      const data = await res.json().catch(() => ({})) as Record<string, unknown>;
      return { ok: false, error: String(data.message || `resend_http_${res.status}`) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  if (send_config.provider === "sendgrid" && send_config.sendgrid_api_key) {
    try {
      const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${send_config.sendgrid_api_key}`,
        },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: job.to }] }],
          from: { email: job.from_email, name: job.from_name || undefined },
          subject: job.subject,
          content: [
            ...(job.html ? [{ type: "text/html", value: job.html }] : []),
            ...(job.text ? [{ type: "text/plain", value: job.text }] : []),
          ],
        }),
      });
      if (res.status === 202) return { ok: true };
      const data = await res.json().catch(() => ({})) as Record<string, unknown>;
      return { ok: false, error: String((data as {errors?: Array<{message: string}>})?.errors?.[0]?.message || `sendgrid_http_${res.status}`) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  return { ok: false, error: `unsupported_provider:${send_config.provider}` };
}

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

  // Step 2: send each job (sequential to avoid SMTP rate-limit hammering)
  const results: Array<{
    recipient_id: string;
    message_id: string;
    ok: boolean;
    error: string | null;
  }> = [];

  for (const job of prepared.jobs) {
    const r = await sendJob(job);
    results.push({
      recipient_id: job.recipient_id,
      message_id: job.message_id,
      ok: r.ok,
      error: r.error ?? null,
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
