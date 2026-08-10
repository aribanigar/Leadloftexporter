"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { useAuth } from "@/lib/auth";

const SECTIONS = [
  { title: "My Account", items: [
    { href: "/settings", label: "Profile & Security" },
    { href: "/settings/workspaces", label: "Workspaces" },
  ]},
  { title: "My Workspace Settings", items: [
    { href: "/settings/accounts", label: "Connected Accounts" },
    { href: "/settings/email", label: "Email Senders" },
    { href: "/settings/outreach", label: "Outreach Settings" },
    { href: "/settings/templates", label: "Email Templates" },
    { href: "/settings/ai-writer", label: "AI Writer" },
  ]},
  { title: "Workspace Settings", items: [
    { href: "/settings/team", label: "Manage Team" },
    { href: "/settings/fields", label: "Custom Fields" },
    { href: "/settings/import", label: "Import Data" },
    { href: "/settings/pipeline", label: "Pipeline & Segments" },
    { href: "/settings/integrations", label: "Integrations" },
    { href: "/settings/whatsapp", label: "WhatsApp API" },
    { href: "/settings/api-keys", label: "API Keys" },
    { href: "/settings/extension", label: "Browser Extension" },
    { href: "/settings/billing", label: "Subscription" },
  ]},
];

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { workspace } = useAuth();
  // Restricted team-member role: only "My Account" is relevant (change
  // password, sign out) — every other section manages workspace-wide CRM
  // data/config outside their intended Campaigns-only scope. This is UI-level
  // decluttering (same class of gate the rest of Settings already uses —
  // e.g. workspaces.py:update_current_workspace only 403s owner/admin
  // server-side); it hides the nav entry but doesn't itself lock the route.
  const sections =
    workspace?.role === "campaigns_only"
      ? SECTIONS.filter((s) => s.title === "My Account")
      : SECTIONS;
  return (
    <div className="grid h-full grid-cols-[260px_1fr] gap-6 p-6">
      <aside className="space-y-5">
        {sections.map((s) => (
          <div key={s.title} className="card p-2">
            <div className="px-2 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
              {s.title}
            </div>
            <ul>
              {s.items.map((item) => (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    className={cn(
                      "block rounded-md px-2 py-1.5 text-sm",
                      pathname === item.href ? "bg-brand-50 text-brand-700" : "text-slate-700 hover:bg-slate-50"
                    )}
                  >
                    {item.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </aside>
      <section className="overflow-y-auto">{children}</section>
    </div>
  );
}
