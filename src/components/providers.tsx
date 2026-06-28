"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useAuth } from "@/lib/auth";

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
    void bootstrap();
  }, [bootstrap]);
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
