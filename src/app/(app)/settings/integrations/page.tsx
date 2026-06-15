"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";

type CatalogItem = {
  id: string;
  name: string;
  description: string;
  kind: "extension" | "email" | "crm" | "webhook";
};

type Account = {
  id: string;
  provider: string;
  label: string | null;
  external_id: string | null;
  status: string;
  config: Record<string, unknown>;
};

// Logos rendered as compact monogram tiles so we don't ship a binary asset
// per provider. Kind decides accent colour.
const PROVIDER_TILE: Record<string, { initials: string; bg: string; fg: string }> = {
  linkedin: { initials: "in", bg: "bg-[#0a66c2]", fg: "text-white" },
  gmail: { initials: "G", bg: "bg-red-500", fg: "text-white" },
  smtp: { initials: "✉", bg: "bg-slate-700", fg: "text-white" },
  hubspot: { initials: "Hs", bg: "bg-orange-500", fg: "text-white" },
  salesforce: { initials: "SF", bg: "bg-sky-500", fg: "text-white" },
  resend: { initials: "R", bg: "bg-black", fg: "text-white" },
  sendgrid: { initials: "SG", bg: "bg-blue-700", fg: "text-white" },
  apollo: { initials: "A", bg: "bg-indigo-600", fg: "text-white" },
  zapier: { initials: "Z", bg: "bg-orange-600", fg: "text-white" },
};

export default function IntegrationsPage() {
  const router = useRouter();
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [openProvider, setOpenProvider] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    try {
      const [c, a] = await Promise.all([
        api<CatalogItem[]>("/integrations/catalog"),
        api<Account[]>("/integrations/accounts"),
      ]);
      setCatalog(c);
      setAccounts(a);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  function accountFor(providerId: string): Account | undefined {
    return accounts.find((a) => a.provider === providerId);
  }

  async function disconnect(account: Account) {
    if (!confirm(`Disconnect ${account.label || account.provider}?`)) return;
    await api(`/integrations/accounts/${account.id}`, { method: "DELETE" });
    await refresh();
  }

  async function pushTo(provider: "hubspot" | "salesforce") {
    setStatus(`Pushing leads to ${provider}…`);
    try {
      const res = await api<{ pushed: number; failed: number; errors: string[] }>(
        `/integrations/${provider}/push`,
        { method: "POST" }
      );
      setStatus(
        `Pushed ${res.pushed} lead${res.pushed === 1 ? "" : "s"}` +
          (res.failed ? ` · ${res.failed} failed` : "")
      );
    } catch (e: unknown) {
      setStatus(`Error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return (
    <div className="space-y-4">
      <div className="card p-6">
        <h2 className="mb-1 text-base font-semibold">Integrations</h2>
        <p className="mb-6 text-sm text-slate-500">
          Connect your tools. To capture leads from LinkedIn, generate an API
          key in{" "}
          <Link href="/settings/api-keys" className="text-brand-600 hover:underline">
            API Keys
          </Link>{" "}
          and paste it into the Chrome extension.
        </p>

        {status && (
          <div className="mb-4 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">
            {status}
          </div>
        )}

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {(loading ? [] : catalog).map((item) => {
            const account = accountFor(item.id);
            const tile = PROVIDER_TILE[item.id] || {
              initials: "·",
              bg: "bg-slate-200",
              fg: "text-slate-600",
            };
            return (
              <div
                key={item.id}
                className="rounded-lg border border-slate-200 bg-white p-4"
              >
                <div className="mb-3 flex items-center gap-3">
                  <div
                    className={`grid h-10 w-10 place-items-center rounded-md ${tile.bg} ${tile.fg} text-sm font-bold`}
                  >
                    {tile.initials}
                  </div>
                  <div className="min-w-0">
                    <h3 className="truncate font-semibold">{item.name}</h3>
                    {account && (
                      <p className="truncate text-xs text-slate-500">
                        {account.label || account.external_id || "Connected"}
                      </p>
                    )}
                  </div>
                </div>
                <p className="mb-3 line-clamp-2 text-sm text-slate-500">
                  {item.description}
                </p>
                <div className="flex flex-wrap gap-2">
                  {item.id === "linkedin" ? (
                    <button
                      className="btn-secondary w-full"
                      onClick={() => router.push("/settings/api-keys")}
                    >
                      Go to API Keys
                    </button>
                  ) : account ? (
                    <>
                      <span className="pill bg-green-50 text-green-700">
                        ● Connected
                      </span>
                      {(item.id === "hubspot" || item.id === "salesforce") && (
                        <button
                          className="btn-secondary"
                          onClick={() => pushTo(item.id as "hubspot" | "salesforce")}
                        >
                          Push leads now
                        </button>
                      )}
                      <button
                        className="btn-ghost"
                        onClick={() => disconnect(account)}
                      >
                        Disconnect
                      </button>
                    </>
                  ) : (
                    <button
                      className="btn-primary w-full"
                      onClick={() => setOpenProvider(item.id)}
                    >
                      Connect
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {openProvider && (
        <ConnectModal
          provider={openProvider}
          onClose={() => setOpenProvider(null)}
          onConnected={async () => {
            setOpenProvider(null);
            setStatus(null);
            await refresh();
          }}
        />
      )}
    </div>
  );
}

// ---------- Connection modal --------------------------------------------

function ConnectModal({
  provider,
  onClose,
  onConnected,
}: {
  provider: string;
  onClose: () => void;
  onConnected: () => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<Record<string, string>>({});

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await api(`/integrations/${provider}/connect`, {
        method: "POST",
        body: provider === "zapier" ? undefined : (form as unknown as object),
      });
      onConnected();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  function field(key: string, label: string, placeholder = "", type = "text") {
    return (
      <div key={key}>
        <label className="label">{label}</label>
        <input
          className="input"
          type={type}
          placeholder={placeholder}
          value={form[key] || ""}
          onChange={(e) => setForm({ ...form, [key]: e.target.value })}
          required
        />
      </div>
    );
  }

  const fields: Record<string, React.ReactNode> = {
    smtp: (
      <>
        <p className="text-xs text-slate-500">
          <strong>Important:</strong> our backend host (Render) blocks
          direct outbound SMTP on ports 25/465/587. Use a relay provider
          that supports port <strong>2525</strong> — recommended:{" "}
          <a
            className="text-brand-600 hover:underline"
            href="https://signup.sendgrid.com/"
            target="_blank"
            rel="noreferrer"
          >
            SendGrid
          </a>{" "}
          (free 100 emails/day),{" "}
          <a
            className="text-brand-600 hover:underline"
            href="https://www.mailgun.com/"
            target="_blank"
            rel="noreferrer"
          >
            Mailgun
          </a>
          , or Postmark. Sign up, get their SMTP credentials, paste
          below with port 2525.
        </p>
        {field("host", "SMTP Host", "smtp.sendgrid.net")}
        <div className="grid grid-cols-2 gap-3">
          {field("port", "Port", "2525", "number")}
          {field("from_email", "From email", "you@yourdomain.com")}
        </div>
        {field("username", "Username", "apikey (for SendGrid)")}
        {field("password", "Password / API key", "", "password")}
      </>
    ),
    gmail: (
      <>
        <p className="text-xs text-slate-500">
          Gmail requires an{" "}
          <a
            className="text-brand-600 hover:underline"
            href="https://myaccount.google.com/apppasswords"
            target="_blank"
            rel="noreferrer"
          >
            App Password
          </a>
          . 2-step verification must be enabled on your Google account first.
        </p>
        {field("email", "Gmail address", "you@gmail.com", "email")}
        {field("app_password", "App password", "abcd efgh ijkl mnop", "password")}
      </>
    ),
    hubspot: (
      <>
        <p className="text-xs text-slate-500">
          Create a Private App at <em>HubSpot → Settings → Integrations →
          Private Apps</em> with the <code>crm.objects.contacts.write</code>{" "}
          scope, then paste the access token below.
        </p>
        {field("access_token", "Private App access token", "pat-na1-…", "password")}
      </>
    ),
    salesforce: (
      <>
        <p className="text-xs text-slate-500">
          Requires a Connected App with OAuth username-password flow enabled.
          Get the consumer key + secret from <em>Setup → App Manager → your
          Connected App → Manage Consumer Details</em>.
        </p>
        {field("instance_url", "Instance URL", "https://your-domain.my.salesforce.com")}
        {field("consumer_key", "Consumer Key", "")}
        {field("consumer_secret", "Consumer Secret", "", "password")}
        {field("username", "Salesforce username", "you@example.com")}
        {field("password", "Password", "", "password")}
        {field("security_token", "Security token", "")}
      </>
    ),
    resend: (
      <>
        <p className="text-xs text-slate-500">
          Resend sends email over HTTPS, so it works on our backend
          (Render) where SMTP is blocked. Sign up at{" "}
          <a
            className="text-brand-600 hover:underline"
            href="https://resend.com/signup"
            target="_blank"
            rel="noreferrer"
          >
            resend.com
          </a>{" "}
          (free 3,000 emails/month, no card), create an{" "}
          <a
            className="text-brand-600 hover:underline"
            href="https://resend.com/api-keys"
            target="_blank"
            rel="noreferrer"
          >
            API key
          </a>
          , and paste it below. Leave &quot;From email&quot; blank to
          start sending immediately from <code>onboarding@resend.dev</code>{" "}
          (no domain verification needed) — switch to your own domain
          later by verifying it in Resend.
        </p>
        {field("api_key", "Resend API key", "re_…", "password")}
        {field("from_email", "From email (optional)", "you@yourdomain.com")}
      </>
    ),
    sendgrid: (
      <>
        <p className="text-xs text-slate-500">
          SendGrid sends email over HTTPS, bypassing Render&apos;s SMTP
          block. Free tier: 100 emails/day forever. Sign up at{" "}
          <a
            className="text-brand-600 hover:underline"
            href="https://signup.sendgrid.com/"
            target="_blank"
            rel="noreferrer"
          >
            sendgrid.com
          </a>
          , create an API key with the <code>Mail Send</code> permission,
          and verify a Sender Identity (Settings → Sender Authentication →
          Single Sender Verification — takes ~1 minute).
        </p>
        {field("api_key", "SendGrid API key", "SG.…", "password")}
        {field("from_email", "From email (verified sender)", "you@yourdomain.com")}
      </>
    ),
    apollo: (
      <>
        <p className="text-xs text-slate-500">
          Apollo is the fallback when our pattern-finder can&apos;t resolve a
          lead&apos;s email — typically 3rd-degree LinkedIn connections, or
          Gmail/M365 domains that block SMTP probes. Apollo&apos;s
          /v1/people/match returns email + phone from a LinkedIn URL.
          Generate an API key at{" "}
          <a
            className="text-brand-600 hover:underline"
            href="https://app.apollo.io/#/settings/integrations/api"
            target="_blank"
            rel="noreferrer"
          >
            apollo.io → Settings → Integrations → API
          </a>
          .
        </p>
        {field("api_key", "Apollo API key", "Generate one in Apollo settings", "password")}
      </>
    ),
    zapier: (
      <p className="text-sm text-slate-600">
        Zapier connects via your workspace API key. Generate one in{" "}
        <Link href="/settings/api-keys" className="text-brand-600 hover:underline">
          API Keys
        </Link>{" "}
        and paste it into Zapier&apos;s &quot;LeadCaptura&quot; auth step
        (header name: <code>X-API-Key</code>). Click &quot;Connect&quot; below
        to mark Zapier as enabled for this workspace.
      </p>
    ),
  };

  const titles: Record<string, string> = {
    smtp: "Connect SMTP mailbox",
    gmail: "Connect Gmail",
    hubspot: "Connect HubSpot",
    salesforce: "Connect Salesforce",
    resend: "Connect Resend",
    sendgrid: "Connect SendGrid",
    apollo: "Connect Apollo.io",
    zapier: "Enable Zapier",
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
      onClick={onClose}
    >
      <div
        className="card w-full max-w-md p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="mb-4 text-base font-semibold">
          {titles[provider] || `Connect ${provider}`}
        </h3>
        <form onSubmit={submit} className="space-y-3">
          {fields[provider] || (
            <p className="text-sm text-slate-500">
              No connection form for this provider.
            </p>
          )}
          {error && (
            <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              {error}
            </div>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" className="btn-ghost" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn-primary" disabled={submitting}>
              {submitting ? "Connecting…" : "Connect"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
