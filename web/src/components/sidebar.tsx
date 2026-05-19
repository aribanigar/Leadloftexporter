"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import {
  Search,
  Inbox,
  CheckSquare,
  Send,
  Columns3,
  Settings,
  Gift,
  Play,
  Plus,
  ChevronDown,
} from "lucide-react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { cn, initials } from "@/lib/utils";
import type { SavedView } from "@/lib/types";

const NAV = [
  { href: "/prospecting", label: "Prospecting", icon: Search },
  { href: "/inbox", label: "Inbox", icon: Inbox },
  { href: "/tasks", label: "Tasks", icon: CheckSquare },
  { href: "/playbooks", label: "Playbooks", icon: Send },
  { href: "/pipeline", label: "Pipeline", icon: Columns3 },
] as const;

export function Sidebar() {
  const pathname = usePathname();
  const { user, workspace } = useAuth();
  const { data: views } = useQuery<SavedView[]>({
    queryKey: ["saved-views"],
    queryFn: () => api("/workspaces/current/views"),
    enabled: !!user,
  });

  return (
    <aside className="flex h-full w-60 flex-col border-r border-slate-200 bg-white">
      <div className="flex h-14 items-center gap-2 border-b border-slate-100 px-4">
        <div className="grid h-7 w-7 place-items-center rounded-md bg-slate-100 text-xs font-semibold uppercase">
          {initials(workspace?.name || user?.email)}
        </div>
        <span className="truncate text-sm font-semibold">{workspace?.name || "Workspace"}</span>
        <ChevronDown className="ml-auto h-4 w-4 text-slate-400" />
      </div>

      <nav className="px-2 pt-3">
        {NAV.map(({ href, label, icon: Icon }) => {
          const active = pathname === href || pathname?.startsWith(href + "/");
          return (
            <Link
              key={href}
              href={href}
              className={cn(
                "mb-0.5 flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium",
                active ? "bg-brand-50 text-brand-700" : "text-slate-600 hover:bg-slate-50"
              )}
            >
              <Icon className="h-4 w-4" />
              <span>{label}</span>
              {href === "/pipeline" && (
                <Plus className="ml-auto h-4 w-4 text-slate-400 hover:text-slate-600" />
              )}
            </Link>
          );
        })}
      </nav>

      <div className="mt-4 px-2">
        <div className="flex items-center justify-between px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
          Quick Views
        </div>
        <div className="space-y-0.5">
          {(views || []).map((v) => {
            const href = `/prospecting?view=${v.id}`;
            return (
              <Link
                key={v.id}
                href={href}
                className="block truncate rounded-md px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50"
              >
                {v.name}
              </Link>
            );
          })}
        </div>
      </div>

      <div className="mt-auto border-t border-slate-100 px-2 py-3">
        <Link href="/settings/billing" className="flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50">
          <Gift className="h-4 w-4" />
          <span>Get LeadCaptura Free</span>
          <span className="ml-auto h-2 w-2 rounded-full bg-brand-500" />
        </Link>
        <Link href="/help" className="flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50">
          <Play className="h-4 w-4" />
          <span>Video Tutorials</span>
        </Link>
        <Link
          href="/settings"
          className={cn(
            "flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium",
            pathname?.startsWith("/settings") ? "bg-brand-50 text-brand-700" : "text-slate-600 hover:bg-slate-50"
          )}
        >
          <Settings className="h-4 w-4" />
          <span>Settings</span>
        </Link>
      </div>
    </aside>
  );
}
