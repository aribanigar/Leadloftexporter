/**
 * SMTP connect — verifies credentials from Vercel's network (no port block),
 * then saves the account to the Python backend.
 *
 * Flow: Browser → POST /api/smtp-connect (this route, runs on Vercel Node)
 *       → nodemailer verify → POST /api/v1/integrations/smtp/connect?skip_verify=1
 *       → returns {id, label, status}
 *
 * This avoids the Render→Vercel Deployment-Protection block that made the
 * relay approach return relay_http_404.
 */
import { NextRequest, NextResponse } from "next/server";
import nodemailer from "nodemailer";

export const runtime = "nodejs";
export const maxDuration = 30;

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

function bad(msg: string, status = 400) {
  return NextResponse.json({ ok: false, error: msg }, { status });
}

export async function POST(req: NextRequest) {
  const authorization = req.headers.get("authorization") || "";
  const workspaceId = req.headers.get("x-workspace-id") || "";

  let body: {
    host: string;
    port: number;
    username: string;
    password: string;
    from_email?: string;
  };
  try {
    body = await req.json();
  } catch {
    return bad("invalid_json");
  }

  const { host, port, username, password, from_email } = body;
  if (!host || !port || !username || !password) {
    return bad("host_port_username_password_required");
  }

  const useImplicitTls = Number(port) === 465;
  // tls.rejectUnauthorized: false is REQUIRED for Hostinger, Zoho, and many
  // other shared SMTP servers whose cert chain trips nodemailer's strict
  // validation. Without this the verify() silently fails with "self signed
  // certificate" or stalls past the timeout. The auth itself still requires
  // the password — this only relaxes cert validation, not authentication.
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
    await transporter.verify();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const isAuth = /\b(535|auth|invalid.{0,20}login|invalid.{0,20}password|credentials)\b/i.test(msg);
    return bad(isAuth ? `smtp_auth_failed: ${msg}` : `smtp_connect_failed: ${msg}`);
  } finally {
    try { transporter.close(); } catch { /* ignore */ }
  }

  const saveRes = await fetch(`${API_URL}/api/v1/integrations/smtp/connect`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": authorization,
      "X-Workspace-Id": workspaceId,
    },
    body: JSON.stringify({
      host,
      port,
      username,
      password,
      from_email: from_email || username,
      skip_verify: true,
    }),
  });

  const data = await saveRes.json().catch(() => ({})) as Record<string, unknown>;
  if (!saveRes.ok) {
    const detail = (data as { detail?: string }).detail || "save_failed";
    return bad(detail, saveRes.status);
  }

  return NextResponse.json({ ok: true, ...data });
}
