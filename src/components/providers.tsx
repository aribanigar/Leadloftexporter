"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useAuth } from "@/lib/auth";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

// Pre-warm the Render backend (+ its Neon DB connection) the instant ANY page
// mounts, authenticated or not. bootstrap() below only hits the network when
// a token already exists, so an unauthenticated visitor landing on /login or
// /register got no head start before this — now every page load fires this
// fire-and-forget probe, which is the earliest possible moment we can start
// waking a cold container. Fails silently; never blocks rendering.
let warmed = false;
function warmBackend() {
  if (warmed || typeof window === "undefined") return;
  warmed = true;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20_000);
  fetch(`${API_URL}/api/v1/cron/health`, { signal: ctrl.signal, cache: "no-store" })
    .catch(() => { /* best-effort — a cold/unreachable backend is not an error here */ })
    .finally(() => clearTimeout(t));
}

export function Providers({ children }: { children: React.ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            retry: 1,
            refetchOnWindowFocus: false,
            // 2-minute stale window: navigating between CRM pages won't
            // re-fetch data that's still fresh. Mutations still call
            // invalidateQueries() so writes are always reflected immediately.
            staleTime: 120_000,
            // Keep cache entries in memory for 15 minutes so a back-navigation
            // shows the previous data instantly while a background refetch runs.
            gcTime: 15 * 60 * 1000,
          },
        },
      })
  );
  const bootstrap = useAuth((s) => s.bootstrap);
  useEffect(() => {
    warmBackend();
    void bootstrap();
  }, [bootstrap]);
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
