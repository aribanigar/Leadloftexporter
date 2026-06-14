"use client";

import { useRouter, usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { useAuth } from "@/lib/auth";
import { Sidebar } from "@/components/sidebar";
import { TopBar } from "@/components/top-bar";
import { TaskAlerts } from "@/components/task-alerts";
import { NoticeBoard } from "@/components/notice-board";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { user, loading } = useAuth();
  const [navOpen, setNavOpen] = useState(false);

  useEffect(() => {
    if (!loading && !user) router.replace("/login");
  }, [user, loading, router]);

  // Close the mobile drawer whenever the route changes.
  useEffect(() => {
    setNavOpen(false);
  }, [pathname]);

  if (loading) {
    return <div className="flex h-screen items-center justify-center text-slate-400 text-sm">Loading…</div>;
  }
  if (!user) return null;
  return (
    <div className="flex h-screen w-screen overflow-hidden bg-slate-50">
      <Sidebar open={navOpen} onClose={() => setNavOpen(false)} />
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <TopBar onMenu={() => setNavOpen(true)} />
        <main className="flex-1 overflow-auto">{children}</main>
      </div>
      <TaskAlerts />
      <NoticeBoard />
    </div>
  );
}
