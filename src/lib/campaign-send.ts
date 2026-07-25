/**
 * Shared campaign email-send logic (nodemailer / Resend / SendGrid).
 *
 * Extracted so BOTH the browser-driven tick route
 * (src/app/api/campaigns/[id]/tick/route.ts) AND the autonomous cron drain
 * (src/app/api/cron/drain/route.ts) send identically. Render blocks outbound
 * SMTP, so all sending happens here on Vercel's network.
 */
import nodemailer from "nodemailer";

export interface SmtpConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  from_email: string;
}

export interface SendConfig {
  provider: string;
  smtp?: SmtpConfig;
  resend_api_key?: string;
  sendgrid_api_key?: string;
}

export interface EmailAttachment {
  filename: string;
  content_type: string;
  data: string; // base64
}

export interface EmailJob {
  recipient_id: string;
  message_id: string;
  to: string;
  from_name: string;
  from_email: string;
  subject: string;
  html: string;
  text: string;
  amp_html?: string;
  preview_text?: string;
  attachments?: EmailAttachment[];
  send_config: SendConfig;
}

/**
 * Best-effort copy of a just-sent SMTP message into the mailbox's Sent folder
 * via IMAP. Hard-capped by the caller so it can never eat the serverless budget.
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

export async function sendJob(job: EmailJob): Promise<{ ok: boolean; error?: string }> {
  const { send_config } = job;
  const fromHeader = job.from_name
    ? `${job.from_name} <${job.from_email}>`
    : job.from_email;
  const atts = (job.attachments || []).filter((a) => a && a.data);

  if (send_config.provider === "smtp" && send_config.smtp) {
    const { host, port, username, password } = send_config.smtp;
    const useImplicitTls = Number(port) === 465;
    const t = nodemailer.createTransport({
      host,
      port: Number(port),
      secure: useImplicitTls,
      requireTLS: !useImplicitTls,
      auth: { user: username, pass: password },
      tls: { rejectUnauthorized: false },
      connectionTimeout: 8_000,
      greetingTimeout: 6_000,
      socketTimeout: 12_000,
    });
    try {
      const alternatives: Array<{ contentType: string; content: string }> = [];
      if (job.amp_html) {
        alternatives.push({ contentType: "text/x-amp-html", content: job.amp_html });
      }
      const headers: Record<string, string> = {};
      if (job.preview_text) headers["X-Preheader"] = job.preview_text;
      const mailOptions = {
        from: fromHeader,
        to: job.to,
        subject: job.subject,
        html: job.html || undefined,
        text: job.text || undefined,
        alternatives: alternatives.length ? alternatives : undefined,
        headers: Object.keys(headers).length ? headers : undefined,
        attachments: atts.length
          ? atts.map((a) => ({
              filename: a.filename,
              content: Buffer.from(a.data, "base64"),
              contentType: a.content_type,
            }))
          : undefined,
      };
      await t.sendMail(mailOptions);
      try {
        const MailComposer = (await import("nodemailer/lib/mail-composer")).default;
        const raw: Buffer = await new Promise((resolve, reject) => {
          new MailComposer(mailOptions).compile().build((err, message) =>
            err ? reject(err) : resolve(message),
          );
        });
        await Promise.race([
          appendToSentFolder(send_config.smtp, raw),
          new Promise<void>((resolve) => setTimeout(resolve, 2000)),
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
          attachments: atts.length
            ? atts.map((a) => ({ filename: a.filename, content: a.data }))
            : undefined,
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
          attachments: atts.length
            ? atts.map((a) => ({
                content: a.data,
                filename: a.filename,
                type: a.content_type,
                disposition: "attachment",
              }))
            : undefined,
        }),
      });
      if (res.status === 202) return { ok: true };
      const data = await res.json().catch(() => ({})) as Record<string, unknown>;
      return { ok: false, error: String((data as { errors?: Array<{ message: string }> })?.errors?.[0]?.message || `sendgrid_http_${res.status}`) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  return { ok: false, error: `unsupported_provider:${send_config.provider}` };
}
