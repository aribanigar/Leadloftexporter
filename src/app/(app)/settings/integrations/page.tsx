"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";

const INTEGRATIONS = [
  {
    id: "linkedin",
    name: "LinkedIn",
    description: "Pair the Chrome extension to enable LinkedIn capture & outreach.",
    logo: "in",
    action: "api-keys",
    actionLabel: "Go to API Keys",
  },
  {
    id: "gmail",
    name: "Gmail",
    description: "Send and receive emails from your Gmail inbox.",
    logo: "📧",
    action: "coming-soon",
    actionLabel: "Coming Soon",
  },
  {
    id: "smtp",
    name: "SMTP",
    description: "Connect any SMTP/IMAP mailbox.",
    logo: "📨",
    action: "coming-soon",
    actionLabel: "Coming Soon",
  },
  {
    id: "hubspot",
    name: "HubSpot",
    description: "Bi-directional contact sync with HubSpot.",
    logo: "🟧",
    action: "coming-soon",
    actionLabel: "Coming Soon",
  },
  {
    id: "salesforce",
    name: "Salesforce",
    description: "Sync leads & opportunities with Salesforce.",
    logo: "☁️",
    action: "coming-soon",
    actionLabel: "Coming Soon",
  },
  {
    id: "zapier",
    name: "Zapier",
    description: "1,500+ apps via Zapier.",
    logo: "⚡",
    action: "coming-soon",
    actionLabel: "Coming Soon",
  },
];

export default function IntegrationsPage() {
  const router = useRouter();

  return (
    <div className="card p-6">
      <h2 className="mb-1 text-base font-semibold">Integrations</h2>
      <p className="mb-6 text-sm text-slate-500">
        Connect your tools. To capture leads from LinkedIn, generate an API key in{" "}
        <Link href="/settings/api-keys" className="text-brand-600 hover:underline">
          API Keys
        </Link>{" "}
        and paste it into the Chrome extension.
      </p>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {INTEGRATIONS.map((integration) => (
          <div key={integration.id} className="rounded-lg border border-slate-200 bg-white p-4">
            <div className="mb-3 flex items-center gap-3">
              <div className="grid h-10 w-10 place-items-center rounded-md bg-slate-100 text-lg font-bold">
                {integration.logo}
              </div>
              <div>
                <h3 className="font-semibold">{integration.name}</h3>
              </div>
            </div>
            <p className="mb-3 text-sm text-slate-500">{integration.description}</p>
            {integration.action === "api-keys" ? (
              <button
                className="btn-secondary w-full"
                onClick={() => router.push("/settings/api-keys")}
              >
                {integration.actionLabel}
              </button>
            ) : (
              <button className="btn-secondary w-full cursor-not-allowed opacity-50" disabled>
                {integration.actionLabel}
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
