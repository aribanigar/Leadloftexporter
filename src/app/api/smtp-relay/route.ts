/**
 * SMTP relay — outbound mail egress for the Render-hosted backend.
 *
 * Render's free + starter tiers block outbound ports 25/465/587, so the
 * backend's direct `aiosmtplib.send()` to a user's Hostinger/Zoho/etc. SMTP
 * server times out. Vercel's serverless functions don't have that block,
 * so this tiny HTTPS endpoint takes SMTP credentials + a message and
 * performs the send from Vercel's network.
 *
 * The backend (`api/app/services/email_sender.py:_smtp_send`) calls this
 * endpoint automatically when its direct SMTP attempt fails — so users who
 * type `smtp.hostinger.com:465` into Settings → Email Senders get mail out
 * with zero further configuration. Same applies to the verify step in
 * `api/app/api/v1/integrations.py:smtp_connect`.
 *
 * Auth: optional shared secret in `X-LC-Relay-Secret`. Accepts either
 * `SMTP_RELAY_SECRET` (the name the backend actually documents and sets —
 * .env.api.example, DEPLOY.md, render-free.yaml) or the legacy
 * `LC_SMTP_RELAY_SECRET` this route originally checked, so a Vercel env var
 * under either name works — a mismatch here means the backend's secret
 * never matches what this route expects, and EVERY relay call 401s
 * regardless of how correct the sender's own SMTP credentials are. If
 * neither is set on Vercel the relay accepts any caller — the SMTP
 * credentials themselves are the real auth, since wrong password = SMTP
 * returns 535 = relay returns 401 to caller.
 *
 * Runs on the Node runtime (NOT Edge) — Edge functions don't have raw
 * TCP sockets, which nodemailer needs.
 */
import { NextRequest, NextResponse } from "next/server";
import nodemailer from "nodemailer";

export const runtime = "nodejs";
// Allow up to 30 s for slow SMTP servers to authenticate + accept the message.
export const maxDuration = 30;

interface RelayPayload {
  host: string;
  port: number;
  username: string;
  password: string;
  from: string;
  to: string;
  subject?: string;
  text?: string;
  html?: string;
  // Verify-only mode: connect + auth, do not send. Used by `smtp_connect`
  // to validate credentials when a user saves an SMTP sender.
  verify_only?: boolean;
}

function bad(msg: string, status = 400) {
  return NextResponse.json({ ok: false, error: msg }, { status });
}

export async function POST(req: NextRequest) {
  const expected = process.env.SMTP_RELAY_SECRET || process.env.LC_SMTP_RELAY_SECRET || "";
  if (expected) {
    const got = req.headers.get("x-lc-relay-secret") || "";
    if (got !== expected) return bad("unauthorized", 401);
  }

  let body: RelayPayload;
  try {
    body = (await req.json()) as RelayPayload;
  } catch {
    return bad("invalid_json");
  }

  const { host, port, username, password, from, to, subject, text, html, verify_only } = body;
  if (!host || !port || !username || !password) {
    return bad("host_port_username_password_required");
  }
  if (!verify_only && (!from || !to)) {
    return bad("from_and_to_required");
  }

  // Port 465 is implicit-TLS — DO NOT call STARTTLS. Port 587/25 starts
  // plain and upgrades via STARTTLS. Mismatching this is the #1 reason
  // SMTP connects time out at the TLS handshake.
  const useImplicitTls = Number(port) === 465;
  const transporter = nodemailer.createTransport({
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
    if (verify_only) {
      await transporter.verify();
      return NextResponse.json({ ok: true, verified: true });
    }
    const info = await transporter.sendMail({
      from,
      to,
      subject: subject || "(no subject)",
      text: text || (html ? undefined : ""),
      html: html || undefined,
    });
    return NextResponse.json({
      ok: true,
      message_id: info.messageId || null,
      response: info.response || null,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const lower = msg.toLowerCase();
    const isAuth = /\b(auth|535|invalid login|password)\b/.test(lower);
    return NextResponse.json(
      { ok: false, error: msg, auth_failed: isAuth },
      { status: isAuth ? 401 : 502 }
    );
  } finally {
    try { transporter.close(); } catch { /* ignore */ }
  }
}

// Tiny GET handler so the user (and uptime checks) can hit the endpoint in
// a browser and confirm it's reachable. Returns nothing sensitive.
export async function GET() {
  return NextResponse.json({
    ok: true,
    service: "smtp-relay",
    runtime: "nodejs",
    methods: ["POST"],
  });
}
