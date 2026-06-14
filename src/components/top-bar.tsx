"use client";

import { RefreshCw, Search, AlertCircle, Menu } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";

interface LinkedInStatus {
  connected: boolean;
}

export function TopBar({ onMenu }: { onMenu?: () => void } = {}) {
  const qc = useQueryClient();
  const router = useRouter();
  const { user } = useAuth();
  const [search, setSearch] = useState("");
  const { data: liStatus } = useQuery<LinkedInStatus>({
    queryKey: ["linkedin-status"],
    queryFn: async () => {
      try {
        const accounts = await api<Array<{ provider: string; status: string }>>(
          "/integrations/accounts"
        );
        return { connected: accounts.some((a) => a.provider === "linkedin" && a.status === "active") };
      } catch {
        return { connected: false };
      }
    },
    enabled: !!user,
  });

  function refresh() {
    qc.invalidateQueries();
  }

  return (
    <header className="flex h-14 items-center gap-2 border-b border-slate-200 bg-gradient-to-r from-white via-emerald-50/30 to-white px-3 sm:gap-3 sm:px-4">
      <button
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-600 hover:text-slate-800 lg:hidden"
        onClick={onMenu}
        title="Menu"
        aria-label="Open menu"
      >
        <Menu className="h-5 w-5" />
      </button>
      <button
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-500 hover:text-slate-800"
        onClick={refresh}
        title="Refresh"
      >
        <RefreshCw className="h-4 w-4" />
      </button>
      <form
        className="relative min-w-0 flex-1 lg:max-w-md"
        onSubmit={(e) => {
          e.preventDefault();
          const q = search.trim();
          router.push(q ? `/prospecting?q=${encodeURIComponent(q)}` : "/prospecting");
        }}
      >
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
        <input
          className="input pl-9"
          placeholder="Search your leads"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </form>
      <div className="ml-auto flex items-center gap-2">
        {!liStatus?.connected && (
          <>
            {/* full banner on desktop */}
            <div className="hidden items-center gap-2 rounded-md bg-white px-3 py-1.5 text-sm shadow-card lg:flex">
              <AlertCircle className="h-4 w-4 text-pink-500" />
              <span className="text-slate-700">Your LinkedIn profile is not connected.</span>
              <Link href="/settings/integrations" className="ml-2 rounded-md bg-pink-500 px-3 py-1 text-sm font-medium text-white hover:bg-pink-600">
                Connect Now
              </Link>
            </div>
            {/* compact icon-only on mobile */}
            <Link
              href="/settings/integrations"
              className="flex h-9 w-9 items-center justify-center rounded-md bg-pink-50 text-pink-500 lg:hidden"
              title="LinkedIn not connected — connect now"
              aria-label="LinkedIn not connected"
            >
              <AlertCircle className="h-4 w-4" />
            </Link>
          </>
        )}
      </div>
    </header>
  );
}
