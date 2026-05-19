"use client";

import { RefreshCw, Search, AlertCircle } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";

interface LinkedInStatus {
  connected: boolean;
}

export function TopBar() {
  const qc = useQueryClient();
  const { user } = useAuth();
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
    <header className="flex h-14 items-center gap-3 border-b border-slate-200 bg-white px-4">
      <button
        className="flex h-9 w-9 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-500 hover:text-slate-800"
        onClick={refresh}
        title="Refresh"
      >
        <RefreshCw className="h-4 w-4" />
      </button>
      <div className="relative w-96 max-w-full">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
        <input className="input pl-9" placeholder="Search your leads" />
      </div>
      <div className="ml-auto flex items-center gap-2">
        {!liStatus?.connected && (
          <div className="flex items-center gap-2 rounded-md bg-white px-3 py-1.5 text-sm shadow-card">
            <AlertCircle className="h-4 w-4 text-pink-500" />
            <span className="text-slate-700">Your LinkedIn profile is not connected.</span>
            <Link href="/settings/integrations" className="ml-2 rounded-md bg-pink-500 px-3 py-1 text-sm font-medium text-white hover:bg-pink-600">
              Connect Now
            </Link>
          </div>
        )}
      </div>
    </header>
  );
}
