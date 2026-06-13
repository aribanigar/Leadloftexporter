/**
 * Outreach send bridge — browser → Vercel → SMTP.
 *
 * Render's free tier blocks outbound SMTP ports (25/465/587), so the Python
 * backend cannot perform the actual TCP send. This route runs on Vercel
 * (Node runtime — outbound SMTP is allowed) and orchestrates a 3-step send:
 *
 *   1. POST Python /inbox/prepare-send  — creates the EmailMessage row,
 *      picks an active sender, returns the SMTP/API credentials.
 *   2. Dispatch via nodemailer / Resend API / SendGrid API from Vercel.
 *   3. POST Python /inbox/commit-send   — records sent/failed on the row.
 *
 * Used by the Outreach page's bulk composer + single-lead send buttons.
 */
import { NextRequest, NextResponse } from "next/server";
import nodemailer from "nodemailer";

export const runtime = "nodejs";
export const maxDuration = 30;

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

interface SendConfig {
  provider: string;
  smtp?: {
    host: string;
    port: number;
    username: string;
    password: string;
    from_email: string;
  };
  resend_api_key?: string;
  sendgrid_api_key?: string;
}

interface PreparedJob {
  message_id: string;
  to: string;
  from_name: string;
  from_email: string;
  subject: string;
  html: string;
  text: string;
  amp_html?: string;       // AMP for Email — Gmail uses, others fall back.
  preview_text?: string;   // Preheader hint.
  send_config: SendConfig;
}

async function dispatch(job: PreparedJob): Promise<{ ok: boolean; error?: string }> {
  const cfg = job.send_config;
  const fromHeader = job.from_name
    ? `${job.from_name} <${job.from_email}>`
    : job.from_email;

  if (cfg.provider === "smtp" && cfg.smtp) {
    const { host, port, username, password } = cfg.smtp;
    const useImplicitTls = Number(port) === 465;
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
      const alternatives: Array<{ contentType: string; content: string }> = [];
      if (job.amp_html) {
        alternatives.push({ contentType: "text/x-amp-html", content: job.amp_html });
      }
      const headers: Record<string, string> = {};
      if (job.preview_text) headers["X-Preheader"] = job.preview_text;
      await t.sendMail({
        from: fromHeader,
        to: job.to,
        subject: job.subject || "(no subject)",
        html: job.html || undefined,
        text: job.text || undefined,
        alternatives: alternatives.length ? alternatives : undefined,
        headers: Object.keys(headers).length ? headers : undefined,
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      try { t.close(); } catch { /* ignore */ }
    }
  }

  if (cfg.provider === "resend" && cfg.resend_api_key) {
    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${cfg.resend_api_key}`,
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

  if (cfg.provider === "sendgrid" && cfg.sendgrid_api_key) {
    try {
      const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${cfg.sendgrid_api_key}`,
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
      const errs = (data as { errors?: Array<{ message: string }> }).errors;
      return { ok: false, error: errs?.[0]?.message || `sendgrid_http_${res.status}` };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  return { ok: false, error: `unsupported_provider:${cfg.provider}` };
}

export async function POST(req: NextRequest) {
  const authorization = req.headers.get("authorization") || "";
  const workspaceId = req.headers.get("x-workspace-id") || "";

  let body: {
    lead_id?: string | null;
    to: string;
    subject?: string;
    body_html?: string;
    body_text?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  const pyHeaders = {
    "Content-Type": "application/json",
    "Authorization": authorization,
    "X-Workspace-Id": workspaceId,
  };

  // 1. Prepare — Python creates the EmailMessage row + returns SMTP creds.
  const prepRes = await fetch(`${API_URL}/api/v1/inbox/prepare-send`, {
    method: "POST",
    headers: pyHeaders,
    body: JSON.stringify({
      lead_id: body.lead_id ?? null,
      to: body.to,
      subject: body.subject || "",
      body_html: body.body_html || "",
      body_text: body.body_text || "",
    }),
  });
  if (!prepRes.ok) {
    const e = await prepRes.json().catch(() => ({})) as Record<string, unknown>;
    return NextResponse.json(
      { ok: false, error: (e as { detail?: string }).detail || `prepare_http_${prepRes.status}` },
      { status: prepRes.status }
    );
  }
  const job = (await prepRes.json()) as PreparedJob;

  // 2. Dispatch — actual SMTP / API call from Vercel.
  const result = await dispatch(job);

  // 3. Commit — Python records sent/failed status.
  const commitRes = await fetch(`${API_URL}/api/v1/inbox/commit-send`, {
    method: "POST",
    headers: pyHeaders,
    body: JSON.stringify({
      message_id: job.message_id,
      ok: result.ok,
      error: result.error || "",
    }),
  });
  const committed = await commitRes.json().catch(() => ({}));

  return NextResponse.json({
    ok: result.ok,
    error: result.error || null,
    ...committed,
  });
}
