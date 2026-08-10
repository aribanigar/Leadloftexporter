"use client";

import { useRouter, usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { useAuth } from "@/lib/auth";
import { Sidebar } from "@/components/sidebar";
import { TopBar } from "@/components/top-bar";
import { TaskAlerts } from "@/components/task-alerts";
import { NoticeBoard } from "@/components/notice-board";
import { CampaignAutoSender } from "@/components/campaign-auto-sender";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { user, workspace, loading } = useAuth();
  const [navOpen, setNavOpen] = useState(false);

  useEffect(() => {
    if (!loading && !user) router.replace("/login");
  }, [user, loading, router]);

  // Restricted team-member role (Settings → Manage Team → "Campaigns only"):
  // hard-redirect away from every CRM section except Campaigns. Settings is
  // still allowed so the member can change their password / sign out — see
  // settings/layout.tsx for the matching nav filter. This mirrors the
  // sidebar's own nav filtering so a restricted member can't just type a URL
  // to reach a hidden section.
  useEffect(() => {
    if (loading || !user) return;
    const restricted = workspace?.role === "campaigns_only";
    const allowed = pathname?.startsWith("/campaigns") || pathname?.startsWith("/settings");
    if (restricted && !allowed) router.replace("/campaigns");
  }, [workspace, pathname, loading, user, router]);

  // Close the mobile drawer whenever the route changes.
  useEffect(() => {
    setNavOpen(false);
  }, [pathname]);

  // Render the shell (sidebar + topbar) immediately so the chrome is instant.
  // The useEffect above redirects to /login when loading finishes and user is null.
  // While auth is in-flight we show a small spinner inside the content area rather
  // than a blank screen replacing the whole layout.
  return (
    <div className="app-canvas flex h-screen w-screen overflow-hidden">
      <Sidebar open={navOpen} onClose={() => setNavOpen(false)} />
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <TopBar onMenu={() => setNavOpen(true)} />
        <main className="flex-1 overflow-auto">
          {loading ? (
            <div className="flex h-full items-center justify-center">
              <div
                style={{
                  width: 32, height: 32,
                  borderRadius: "50%",
                  border: "3px solid #e2e8f0",
                  borderTopColor: "#0f766e",
                  animation: "spin 0.7s linear infinite",
                }}
              />
            </div>
          ) : children}
        </main>
      </div>
      <TaskAlerts />
      <NoticeBoard />
      {/* Keeps every 'sending' campaign draining across in-app navigation and
          tab-switches, not just while the campaign detail page is open. */}
      <CampaignAutoSender />
    </div>
  );
}
