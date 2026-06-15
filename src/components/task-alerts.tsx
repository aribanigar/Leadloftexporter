"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlarmClockCheck, BellRing, Check, Clock3, Volume2, VolumeX, X } from "lucide-react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import type { Task } from "@/lib/types";

// Keys for client-side state we want to survive refreshes.
const ACK_KEY = "lc_task_alert_acked";
const MUTE_KEY = "lc_task_alert_muted";
const NOTIFIED_KEY = "lc_task_alert_notified";

function loadSet(key: string): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(key) || "[]"));
  } catch {
    return new Set();
  }
}
function saveSet(key: string, s: Set<string>) {
  try {
    localStorage.setItem(key, JSON.stringify([...s]));
  } catch {
    /* ignore quota / private-mode errors */
  }
}

// An alert is identified by task id + its due timestamp, so rescheduling /
// snoozing a task produces a fresh key and re-arms the alarm.
const dueKey = (t: Task) => `${t.id}@${t.due_at}`;
const isActive = (t: Task) => t.status === "open" || t.status === "in_progress";

// ── Synthesised beep (Web Audio — no asset needed) ──────────────────────────
function useBeeper() {
  const ctxRef = useRef<AudioContext | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const ensureCtx = useCallback(() => {
    if (typeof window === "undefined") return null;
    if (!ctxRef.current) {
      const AC = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (AC) ctxRef.current = new AC();
    }
    if (ctxRef.current?.state === "suspended") ctxRef.current.resume().catch(() => {});
    return ctxRef.current;
  }, []);

  const ping = useCallback(() => {
    const ctx = ensureCtx();
    if (!ctx) return;
    const t0 = ctx.currentTime;
    // a two-tone "ding-ding" so it reads as an alarm, not a random blip
    [
      { off: 0, freq: 880 },
      { off: 0.2, freq: 1175 },
    ].forEach(({ off, freq }) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t0 + off);
      gain.gain.linearRampToValueAtTime(0.3, t0 + off + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + off + 0.17);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t0 + off);
      osc.stop(t0 + off + 0.18);
    });
  }, [ensureCtx]);

  const start = useCallback(() => {
    ensureCtx();
    if (timerRef.current != null) return;
    ping();
    timerRef.current = setInterval(ping, 2200);
  }, [ensureCtx, ping]);

  const stop = useCallback(() => {
    if (timerRef.current != null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  useEffect(() => () => stop(), [stop]);
  return { start, stop, unlock: ensureCtx };
}

function fmtTime(iso?: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function TaskAlerts() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const { start, stop, unlock } = useBeeper();

  const [acked, setAcked] = useState<Set<string>>(() => (typeof window !== "undefined" ? loadSet(ACK_KEY) : new Set()));
  const [muted, setMuted] = useState<boolean>(() => (typeof window !== "undefined" ? localStorage.getItem(MUTE_KEY) === "1" : false));
  const [tick, setTick] = useState(0);

  const { data: tasks } = useQuery<Task[]>({
    queryKey: ["tasks"],
    queryFn: () => api("/tasks"),
    enabled: !!user,
    refetchInterval: 20000,
    refetchOnWindowFocus: true,
  });

  // Audio playback + desktop notifications need a user gesture to unlock.
  useEffect(() => {
    const handler = () => {
      unlock();
      if (typeof window !== "undefined" && "Notification" in window && Notification.permission === "default") {
        Notification.requestPermission().catch(() => {});
      }
    };
    window.addEventListener("pointerdown", handler, { once: true });
    window.addEventListener("keydown", handler, { once: true });
    return () => {
      window.removeEventListener("pointerdown", handler);
      window.removeEventListener("keydown", handler);
    };
  }, [unlock]);

  // Re-evaluate due-ness on a timer even if the task list itself hasn't changed.
  useEffect(() => {
    const id = setInterval(() => setTick((t) => (t + 1) % 1000000), 15000);
    return () => clearInterval(id);
  }, []);

  const isMine = useCallback((t: Task) => !t.assignee_id || t.assignee_id === user?.id, [user?.id]);

  const due = useMemo(() => {
    const now = Date.now();
    return (tasks || [])
      .filter((t) => isActive(t) && isMine(t) && t.due_at && new Date(t.due_at).getTime() <= now)
      .sort((a, b) => new Date(a.due_at!).getTime() - new Date(b.due_at!).getTime());
    // `tick` forces a re-eval every 15s so tasks cross the due line on time.
  }, [tasks, isMine, tick]);

  const ringing = due.filter((t) => !acked.has(dueKey(t)));
  const ringingCount = ringing.length;

  // Start/stop the looping beep.
  useEffect(() => {
    if (ringingCount > 0 && !muted) start();
    else stop();
  }, [ringingCount, muted, start, stop]);

  // One desktop notification per newly-due task.
  useEffect(() => {
    if (typeof window === "undefined" || !("Notification" in window) || Notification.permission !== "granted") return;
    const notified = loadSet(NOTIFIED_KEY);
    let changed = false;
    for (const t of ringing) {
      const k = dueKey(t);
      if (!notified.has(k)) {
        try {
          new Notification("⏰ Task due now", { body: t.title, tag: k, requireInteraction: true });
        } catch {
          /* notification may throw if the tab lost focus permission */
        }
        notified.add(k);
        changed = true;
      }
    }
    if (changed) saveSet(NOTIFIED_KEY, notified);
  }, [ringing]);

  const ackAll = () => {
    const next = new Set(acked);
    for (const t of due) next.add(dueKey(t));
    setAcked(next);
    saveSet(ACK_KEY, next);
    stop();
  };
  const ackOne = (t: Task) => {
    const next = new Set(acked);
    next.add(dueKey(t));
    setAcked(next);
    saveSet(ACK_KEY, next);
  };
  const toggleMute = () => {
    const v = !muted;
    setMuted(v);
    if (typeof window !== "undefined") localStorage.setItem(MUTE_KEY, v ? "1" : "0");
  };

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["tasks"] });
    qc.invalidateQueries({ queryKey: ["office-workload"] });
  };
  const markDone = useMutation({
    mutationFn: (id: string) => api(`/tasks/${id}`, { method: "PATCH", body: { status: "done" } }),
    onSuccess: invalidate,
  });
  const snooze = useMutation({
    mutationFn: (id: string) =>
      api(`/tasks/${id}`, { method: "PATCH", body: { due_at: new Date(Date.now() + 10 * 60000).toISOString(), remind: true } }),
    onSuccess: invalidate,
  });

  if (ringingCount === 0) return null;

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-[200] flex justify-center px-4 pb-4 sm:bottom-4 sm:right-4 sm:left-auto sm:justify-end sm:px-0">
      <div className="pointer-events-auto w-full max-w-sm overflow-hidden rounded-2xl border border-rose-200 bg-white shadow-2xl ring-1 ring-rose-100">
        <div className="flex items-center gap-2 bg-gradient-to-r from-rose-500 to-rose-600 px-4 py-3 text-white">
          <span className="relative flex h-8 w-8 items-center justify-center rounded-full bg-white/20">
            <BellRing className="h-4 w-4 animate-wiggle" />
            <span className="absolute inset-0 animate-ping rounded-full bg-white/30" />
          </span>
          <div className="flex-1">
            <div className="text-sm font-semibold leading-tight">Task due now</div>
            <div className="text-[11px] text-rose-100">
              {ringingCount} task{ringingCount === 1 ? "" : "s"} need{ringingCount === 1 ? "s" : ""} your attention
            </div>
          </div>
          <button onClick={toggleMute} title={muted ? "Unmute beep" : "Mute beep"} className="rounded-md p-1.5 hover:bg-white/20">
            {muted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
          </button>
        </div>

        <ul className="max-h-72 divide-y divide-slate-100 overflow-auto">
          {ringing.map((t) => (
            <li key={t.id} className="px-4 py-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-slate-800">{t.title}</div>
                  <div className="mt-0.5 flex items-center gap-1 text-[11px] text-rose-600">
                    <Clock3 className="h-3 w-3" /> due {fmtTime(t.due_at)}
                  </div>
                </div>
                <button
                  onClick={() => ackOne(t)}
                  title="Dismiss this alert"
                  className="shrink-0 rounded p-1 text-slate-300 hover:bg-slate-100 hover:text-slate-500"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <button
                  onClick={() => markDone.mutate(t.id)}
                  className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2.5 py-1 text-[12px] font-medium text-emerald-700 hover:bg-emerald-100"
                >
                  <Check className="h-3.5 w-3.5" /> Mark done
                </button>
                <button
                  onClick={() => snooze.mutate(t.id)}
                  className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2.5 py-1 text-[12px] font-medium text-slate-600 hover:bg-slate-200"
                >
                  <AlarmClockCheck className="h-3.5 w-3.5" /> Snooze 10m
                </button>
                {t.lead_id && (
                  <Link href={`/leads/${t.lead_id}`} className="text-[12px] font-medium text-brand-600 hover:underline">
                    Open lead ↗
                  </Link>
                )}
              </div>
            </li>
          ))}
        </ul>

        <div className="flex items-center justify-between gap-2 border-t border-slate-100 bg-slate-50 px-4 py-2.5">
          <Link href="/tasks" className="text-[12px] font-medium text-slate-500 hover:text-slate-700">
            View all tasks
          </Link>
          <button
            onClick={ackAll}
            className="inline-flex items-center gap-1.5 rounded-lg bg-rose-600 px-3 py-1.5 text-[13px] font-semibold text-white hover:bg-rose-700"
          >
            <VolumeX className="h-4 w-4" /> Stop alert
          </button>
        </div>
      </div>
    </div>
  );
}
