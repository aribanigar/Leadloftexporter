"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const SECTIONS = [
  { title: "My Account", items: [
    { href: "/settings", label: "Profile & Security" },
    { href: "/settings/workspaces", label: "Workspaces" },
  ]},
  { title: "My Workspace Settings", items: [
    { href: "/settings/accounts", label: "Connected Accounts" },
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
    { href: "/settings/billing", label: "Subscription" },
  ]},
];

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  return (
    <div className="grid h-full grid-cols-[260px_1fr] gap-6 p-6">
      <aside className="space-y-5">
        {SECTIONS.map((s) => (
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
