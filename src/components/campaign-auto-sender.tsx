"use client";

/**
 * App-shell background sender.
 *
 * On the free tier there is no server-side worker, so a campaign's send loop
 * is driven by the browser polling the Vercel `/api/campaigns/{id}/tick` route
 * (which sends via nodemailer and commits back to Python). The campaign DETAIL
 * page has its own 3s poll, but that stops the instant you navigate away.
 *
 * This component lives in the authenticated app layout — which stays mounted
 * across every in-app navigation — so it keeps ticking EVERY campaign that is
 * in 'sending' status. Result: once you press "Send Remaining" (or start a
 * campaign), it keeps draining even if you switch to another campaign, open
 * Pipeline, or background the tab. It only stops when the browser tab is closed
 * (no worker can run then) — see the note in the campaign UI.
 *
 * Safe to run alongside the detail-page poll: prepare-tick claims rows under a
 * SELECT … FOR UPDATE SKIP LOCKED, so concurrent ticks never double-send.
 */

import { useEffect, useRef } from "react";
import { useAuth } from "@/lib/auth";
import { api, getToken, getWorkspaceId } from "@/lib/api";

const TICK_INTERVAL_MS = 8000;

export function CampaignAutoSender() {
  const { user } = useAuth();
  const busy = useRef(false);

  useEffect(() => {
    if (!user) return;
    let stopped = false;

    const tickAll = async () => {
      if (busy.current || stopped) return;
      busy.current = true;
      try {
        const token = getToken();
        const wsId = getWorkspaceId();
        if (!token || !wsId) return;

        let ids: string[] = [];
        try {
          const res = await api<{ ids: string[] }>("/campaigns/active-sending");
          ids = res?.ids ?? [];
        } catch {
          return; // backend waking up / transient — try again next interval
        }

        for (const id of ids) {
          if (stopped) break;
          try {
            await fetch(`/api/campaigns/${id}/tick`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${token}`,
                "X-Workspace-Id": wsId,
              },
              body: "{}",
            });
          } catch {
            // one campaign failing must not block the others
          }
        }
      } finally {
        busy.current = false;
      }
    };

    const interval = setInterval(tickAll, TICK_INTERVAL_MS);
    // Fire an immediate catch-up tick whenever the tab regains focus, since
    // background tabs have their timers throttled to ~once/minute.
    const onVisible = () => {
      if (document.visibilityState === "visible") tickAll();
    };
    document.addEventListener("visibilitychange", onVisible);
    tickAll(); // kick off right away

    return () => {
      stopped = true;
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [user]);

  return null;
}
