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

/**
 * Best-effort copy of a just-sent SMTP message into the mailbox's Sent folder
 * via IMAP. Pure SMTP send does NOT file to Sent (only the user's own webmail
 * client does), so without this, campaign mail never appears in the user's
 * "Sent" — which looks like it wasn't sent at all. We derive the IMAP host
 * from the SMTP host (smtp.x → imap.x), reuse the same credentials, find the
 * \Sent special-use folder (or a name matching /sent/), and APPEND the raw
 * RFC822 message. Always best-effort: any failure here NEVER affects the send.
 */
async function appendToSentFolder(
  smtp: SmtpConfig,
  rawMessage: Buffer,
): Promise<void> {
  try {
    const { ImapFlow } = await import("imapflow");
    const imapHost = smtp.host.replace(/^smtp\./i, "imap.");
    const client = new ImapFlow({
      host: imapHost,
      port: 993,
      secure: true,
      auth: { user: smtp.username, pass: smtp.password },
      logger: false,
      // Hostinger/Zoho/etc. self-signed or hostname-mismatched certs.
      tls: { rejectUnauthorized: false },
    });
    await client.connect();
    try {
      let sentPath = "Sent";
      try {
        const boxes = await client.list();
        const match =
          boxes.find((b) => b.specialUse === "\\Sent") ||
          boxes.find((b) => /(^|[./])sent($|[ ._])/i.test(b.path));
        if (match) sentPath = match.path;
      } catch { /* fall back to "Sent" */ }
      await client.append(sentPath, rawMessage, ["\\Seen"]);
    } finally {
      await client.logout().catch(() => {});
    }
  } catch {
    /* best-effort — never affect the send result */
  }
}

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
  amp_html?: string;       // AMP for Email source. Gmail renders this; others use html.
  preview_text?: string;   // <90-char preheader shown in inbox preview pane.
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
      // AMP for Email: attach as text/x-amp-html alternative. Gmail (web,
      // iOS, Android) renders the AMP version; every other client falls
      // back to text/html. Senders MUST be DKIM-signed and registered with
      // Gmail's AMP Sender program for delivery — we still attach because
      // unsigned senders just degrade gracefully to text/html.
      const alternatives: Array<{ contentType: string; content: string }> = [];
      if (job.amp_html) {
        alternatives.push({ contentType: "text/x-amp-html", content: job.amp_html });
      }
      const headers: Record<string, string> = {};
      // Preheader / preview text via a Gmail-respected header. The visible
      // hidden preheader span injected into the HTML body itself is what
      // actually fills the inbox preview pane — this header is a hint.
      if (job.preview_text) headers["X-Preheader"] = job.preview_text;
      const mailOptions = {
        from: fromHeader,
        to: job.to,
        subject: job.subject,
        html: job.html || undefined,
        text: job.text || undefined,
        alternatives: alternatives.length ? alternatives : undefined,
        headers: Object.keys(headers).length ? headers : undefined,
      };
      await t.sendMail(mailOptions);
      // Copy the message into the mailbox's Sent folder via IMAP so it shows
      // up in the user's webmail "Sent". Compose the raw RFC822 separately
      // (SMTP transport doesn't hand back its raw bytes), append best-effort,
      // bounded so a slow IMAP server can't stall the tick.
      try {
        const MailComposer = (await import("nodemailer/lib/mail-composer")).default;
        const raw: Buffer = await new Promise((resolve, reject) => {
          new MailComposer(mailOptions).compile().build((err, message) =>
            err ? reject(err) : resolve(message),
          );
        });
        await Promise.race([
          appendToSentFolder(send_config.smtp, raw),
          new Promise<void>((resolve) => setTimeout(resolve, 9000)),
        ]);
      } catch { /* best-effort copy to Sent */ }
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
