"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { CalendarDays, CheckSquare, ChevronRight, Pin, Video } from "lucide-react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";

interface BoardItem {
  kind: "task" | "meeting";
  id: string;
  title: string;
  sub?: string | null;
  at: string;
  end_at?: string | null;
  type?: string;
  status?: string;
  href: string;
}
interface BoardData {
  now: string;
  items: BoardItem[];
}

const COLLAPSE_KEY = "lc_notice_collapsed";

function sameLocalDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function clockTime(d: Date): string {
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function relLabel(at: Date, end: Date | null, now: Date): { text: string; tone: "now" | "soon" | "past" | "future" } {
  if (end && now >= at && now <= end) return { text: "live now", tone: "now" };
  const diffMin = Math.round((at.getTime() - now.getTime()) / 60000);
  if (diffMin === 0) return { text: "now", tone: "now" };
  if (diffMin > 0) {
    if (diffMin < 60) return { text: `in ${diffMin}m`, tone: diffMin <= 15 ? "soon" : "future" };
    const h = Math.floor(diffMin / 60);
    const m = diffMin % 60;
    return { text: m ? `in ${h}h ${m}m` : `in ${h}h`, tone: "future" };
  }
  const past = -diffMin;
  if (past < 60) return { text: `${past}m ago`, tone: "past" };
  const h = Math.floor(past / 60);
  return { text: `${h}h ago`, tone: "past" };
}

export function NoticeBoard() {
  const { user } = useAuth();
  const [collapsed, setCollapsed] = useState(false);
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    setCollapsed(typeof window !== "undefined" && localStorage.getItem(COLLAPSE_KEY) === "1");
  }, []);

  // Real-time clock — re-render every second so timings & the clock stay live.
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  const { data } = useQuery<BoardData>({
    queryKey: ["today-board"],
    queryFn: () => api("/tasks/today"),
    enabled: !!user,
    refetchInterval: 30000,
    refetchOnWindowFocus: true,
  });

  const todays = useMemo(() => {
    const items = data?.items || [];
    return items
      .map((it) => ({ ...it, _at: new Date(it.at), _end: it.end_at ? new Date(it.end_at) : null }))
      .filter((it) => !isNaN(it._at.getTime()) && sameLocalDay(it._at, now))
      .sort((a, b) => a._at.getTime() - b._at.getTime());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, now.toDateString()]);

  const toggle = () => {
    const v = !collapsed;
    setCollapsed(v);
    if (typeof window !== "undefined") localStorage.setItem(COLLAPSE_KEY, v ? "1" : "0");
  };

  if (!user) return null;

  if (collapsed) {
    return (
      <button
        onClick={toggle}
        className="fixed right-0 top-24 z-[120] hidden -translate-y-1/2 items-center gap-1.5 rounded-l-xl border border-r-0 border-amber-300 bg-amber-200 px-2 py-3 text-[12px] font-semibold text-amber-900 shadow-md hover:bg-amber-300 lg:flex"
        style={{ writingMode: "vertical-rl" }}
        title="Show today's board"
      >
        <Pin className="h-3.5 w-3.5 rotate-45" />
        Today {todays.length > 0 && `(${todays.length})`}
      </button>
    );
  }

  return (
    <aside className="fixed right-4 top-20 z-[120] hidden w-64 lg:block">
      <div className="rotate-[-1deg] rounded-2xl border border-amber-300 bg-gradient-to-b from-amber-100 to-amber-50 p-3.5 shadow-[0_8px_24px_rgba(180,120,0,0.18)]">
        {/* pin */}
        <span className="absolute -top-2 left-1/2 grid h-6 w-6 -translate-x-1/2 place-items-center rounded-full bg-rose-500 shadow ring-2 ring-white">
          <Pin className="h-3 w-3 rotate-45 text-white" />
        </span>

        <div className="mb-2 flex items-center justify-between">
          <div>
            <div className="flex items-center gap-1.5 text-[13px] font-bold text-amber-900">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
              </span>
              Today&apos;s Board
            </div>
            <div className="text-[11px] text-amber-700">
              {now.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" })} · {clockTime(now)}
            </div>
          </div>
          <button onClick={toggle} className="rounded p-1 text-amber-600 hover:bg-amber-200/60" title="Hide">
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>

        <div className="max-h-[60vh] space-y-1.5 overflow-auto pr-0.5">
          {todays.length === 0 ? (
            <p className="py-6 text-center text-[12px] text-amber-700/80">Nothing scheduled today 🎉</p>
          ) : (
            todays.map((it) => {
              const rl = relLabel(it._at, it._end, now);
              const Icon = it.kind === "meeting" ? Video : CheckSquare;
              const toneCls =
                rl.tone === "now"
                  ? "bg-emerald-100 text-emerald-700"
                  : rl.tone === "soon"
                  ? "bg-rose-100 text-rose-700"
                  : rl.tone === "past"
                  ? "bg-slate-200 text-slate-500"
                  : "bg-amber-200/70 text-amber-800";
              return (
                <Link
                  key={`${it.kind}-${it.id}`}
                  href={it.href}
                  className="block rounded-lg border border-amber-200/70 bg-white/70 px-2.5 py-2 transition-colors hover:bg-white"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-1.5 text-[12px] font-semibold text-slate-700">
                      <Icon className={"h-3.5 w-3.5 " + (it.kind === "meeting" ? "text-violet-500" : "text-emerald-600")} />
                      {clockTime(it._at)}
                      {it._end && <span className="text-[10px] font-normal text-slate-400">–{clockTime(it._end)}</span>}
                    </span>
                    <span className={"shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold " + toneCls}>{rl.text}</span>
                  </div>
                  <div className="mt-0.5 truncate text-[12px] text-slate-800">{it.title}</div>
                  {it.kind === "meeting" && it.sub && <div className="truncate text-[10px] text-slate-400">{it.sub}</div>}
                </Link>
              );
            })
          )}
        </div>

        <div className="mt-2 flex items-center justify-between border-t border-amber-200 pt-2 text-[11px] text-amber-700">
          <Link href="/tasks" className="flex items-center gap-1 hover:text-amber-900">
            <CheckSquare className="h-3 w-3" /> Tasks
          </Link>
          <Link href="/calendar" className="flex items-center gap-1 hover:text-amber-900">
            <CalendarDays className="h-3 w-3" /> Calendar
          </Link>
        </div>
      </div>
    </aside>
  );
}
