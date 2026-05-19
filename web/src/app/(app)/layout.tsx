"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { useAuth } from "@/lib/auth";
import { Sidebar } from "@/components/sidebar";
import { TopBar } from "@/components/top-bar";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { user, loading } = useAuth();
  useEffect(() => {
    if (!loading && !user) router.replace("/login");
  }, [user, loading, router]);
  if (loading) {
    return <div className="flex h-screen items-center justify-center text-slate-400 text-sm">Loading…</div>;
  }
  if (!user) return null;
  return (
    <div className="flex h-screen w-screen overflow-hidden bg-slate-50">
      <Sidebar />
      <div className="flex flex-1 flex-col overflow-hidden">
        <TopBar />
        <main className="flex-1 overflow-auto">{children}</main>
      </div>
    </div>
  );
}
