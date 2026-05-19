"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { api } from "@/lib/api";

interface ConnectedAccount {
  id: string;
  provider: string;
  label?: string | null;
  external_id?: string | null;
  status: string;
}

const INTEGRATIONS = [
  { id: "gmail", name: "Gmail", description: "Send and receive emails from your Gmail inbox.", logo: "📧" },
  { id: "smtp", name: "SMTP", description: "Connect any SMTP/IMAP mailbox.", logo: "📨" },
  { id: "linkedin", name: "LinkedIn", description: "Pair the Chrome extension to enable LinkedIn capture & outreach.", logo: "in" },
  { id: "hubspot", name: "HubSpot", description: "Bi-directional contact sync with HubSpot.", logo: "🟧" },
  { id: "salesforce", name: "Salesforce", description: "Sync leads & opportunities with Salesforce.", logo: "☁️" },
  { id: "zapier", name: "Zapier", description: "1,500+ apps via Zapier.", logo: "⚡" },
];

export default function IntegrationsPage() {
  const { data: accounts } = useQuery<ConnectedAccount[]>({
    queryKey: ["accounts"],
    queryFn: () => api("/integrations/accounts"),
  });

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
        {INTEGRATIONS.map((integration) => {
          const connected = accounts?.find((a) => a.provider === integration.id);
          return (
            <div key={integration.id} className="rounded-lg border border-slate-200 bg-white p-4">
              <div className="mb-3 flex items-center gap-3">
                <div className="grid h-10 w-10 place-items-center rounded-md bg-slate-100 text-lg font-bold">
                  {integration.logo}
                </div>
                <div>
                  <h3 className="font-semibold">{integration.name}</h3>
                  {connected && <span className="pill bg-emerald-100 text-emerald-700">Connected</span>}
                </div>
              </div>
              <p className="text-sm text-slate-500">{integration.description}</p>
              <button className="btn-secondary mt-3 w-full">
                {connected ? "Manage" : "Connect"}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
