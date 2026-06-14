"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2,
  Circle,
  Phone,
  Mail,
  Linkedin,
  SkipForward,
  RotateCcw,
  Search,
  PenLine,
  Send,
  MessageSquare,
  CalendarClock,
  AlertTriangle,
  Inbox,
  ListChecks,
  LayoutGrid,
} from "lucide-react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import type { Task } from "@/lib/types";
import { fmtRelative } from "@/lib/utils";

// ── Office workload dashboard ───────────────────────────────────────────────

interface Sample {
  id: string;
  label: string;
  sublabel?: string | null;
  href: string;
  task_id?: string;
}
interface Group {
  key: string;
  title: string;
  kind: "human" | "auto";
  desc: string;
  icon: string;
  accent: string;
  bg: string;
  count: number;
  samples: Sample[];
  actionHref?: string;
  actionLabel?: string;
}
interface OfficeData {
  groups: Group[];
  counters: { due_now: number; needs_you: number; ready: number; unreachable: number };
}

const ICONS: Record<string, React.ComponentType<{ className?: string; strokeWidth?: number }>> = {
  CalendarClock,
  MessageSquare,
  Send,
  Search,
  PenLine,
  AlertTriangle,
  Inbox,
};

function Counter({ label, value, color, help }: { label: string; value: number; color: string; help: string }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-card">
      <div className="text-[11px] uppercase tracking-wider text-slate-500">{label}</div>
      <div className="mt-1 text-[28px] font-normal tracking-tight tabular-nums" style={{ color }}>
        {value.toLocaleString()}
      </div>
      <p className="mt-1 text-[11px] text-slate-500">{help}</p>
    </div>
  );
}

function OfficeWorkload() {
  const { data, isLoading } = useQuery<OfficeData>({
    queryKey: ["office-workload"],
    queryFn: () => api("/tasks/office"),
    refetchInterval: 20000,
  });

  if (isLoading || !data) {
    return (
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-24 animate-pulse rounded-2xl bg-slate-100" />
          ))}
        </div>
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-28 animate-pulse rounded-2xl bg-slate-100" />
        ))}
      </div>
    );
  }

  const c = data.counters;
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Counter label="Due now" value={c.due_now} color="#9334e6" help="Tasks + cadence steps to act on" />
        <Counter label="Needs you" value={c.needs_you} color="#137333" help="Replied leads to close yourself" />
        <Counter label="Ready to contact" value={c.ready} color="#1a73e8" help="Have a channel, not yet contacted" />
        <Counter label="Unreachable" value={c.unreachable} color="#c5221f" help="Add a channel or find replacements" />
      </div>

      <div className="space-y-3">
        {data.groups.map((g) => {
          const Icon = ICONS[g.icon] || Circle;
          return (
            <div key={g.key} className="rounded-2xl border border-slate-200 bg-white p-5 shadow-card">
              <div className="flex items-start justify-between gap-4">
                <div className="flex items-start gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-full" style={{ backgroundColor: g.bg, color: g.accent }}>
                    <Icon className="h-5 w-5" strokeWidth={1.8} />
                  </div>
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[14px] font-semibold text-slate-900">{g.title}</span>
                      <span className="rounded-full px-2 py-0.5 text-[11px] font-medium" style={{ backgroundColor: g.bg, color: g.accent }}>
                        {g.count}
                      </span>
                      {g.kind === "human" && (
                        <span className="rounded-full bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700">needs you</span>
                      )}
                    </div>
                    <p className="mt-1 max-w-2xl text-[12px] text-slate-500">{g.desc}</p>
                  </div>
                </div>
                {g.actionHref && g.count > 0 && (
                  <Link
                    href={g.actionHref}
                    className="shrink-0 rounded-full border border-slate-200 px-3 py-1 text-[12px] font-medium text-slate-600 hover:border-brand-300 hover:bg-brand-50 hover:text-brand-700"
                  >
                    {g.actionLabel}
                  </Link>
                )}
              </div>

              {g.samples.length > 0 ? (
                <ul className="mt-4 grid gap-1 border-t border-slate-100 pt-3 md:grid-cols-2">
                  {g.samples.map((s) => (
                    <li key={s.id}>
                      <Link href={s.href} className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-[12px] hover:bg-slate-50">
                        <span className="truncate font-medium text-slate-800">{s.label}</span>
                        {s.sublabel && <span className="truncate text-slate-500">· {s.sublabel}</span>}
                      </Link>
                    </li>
                  ))}
                  {g.count > g.samples.length && (
                    <li>
                      <Link href={g.actionHref || "/leads"} className="block rounded-lg px-2 py-1.5 text-[12px] font-medium text-brand-700 hover:bg-brand-50">
                        + {g.count - g.samples.length} more
                      </Link>
                    </li>
                  )}
                </ul>
              ) : (
                <p className="mt-3 border-t border-slate-100 pt-3 text-[12px] text-slate-400">Nothing here right now — you&apos;re clear. ✅</p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Interactive task list (preserved) ───────────────────────────────────────

const TYPE_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  call: Phone,
  email: Mail,
  linkedin: Linkedin,
};

type TabKey = "due" | "scheduled" | "completed" | "skipped";
const TABS: { key: TabKey; label: string }[] = [
  { key: "due", label: "Due" },
  { key: "scheduled", label: "Scheduled" },
  { key: "completed", label: "Completed" },
  { key: "skipped", label: "Skipped" },
];

function TaskList() {
  const qc = useQueryClient();
  const { user } = useAuth();
  const [tab, setTab] = useState<TabKey>("due");
  const [sort, setSort] = useState<"oldest" | "newest">("oldest");
  const [owner, setOwner] = useState<"all" | "me">("all");

  const { data: tasks } = useQuery<Task[]>({
    queryKey: ["tasks"],
    queryFn: () => api("/tasks"),
    refetchInterval: 15000,
  });

  const setStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) => api(`/tasks/${id}`, { method: "PATCH", body: { status } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tasks"] });
      qc.invalidateQueries({ queryKey: ["office-workload"] });
    },
  });

  const now = Date.now();
  const all = (tasks || []).filter((t) => (owner === "me" ? t.assignee_id === user?.id : true));
  const buckets: Record<TabKey, Task[]> = {
    due: all.filter((t) => t.status === "open" && (!t.due_at || new Date(t.due_at).getTime() <= now)),
    scheduled: all.filter((t) => t.status === "open" && t.due_at && new Date(t.due_at).getTime() > now),
    completed: all.filter((t) => t.status === "done"),
    skipped: all.filter((t) => t.status === "skipped"),
  };
  const rows = [...buckets[tab]].sort((a, b) => {
    const pick = (t: Task) => (tab === "completed" ? t.completed_at : tab === "scheduled" ? t.due_at : t.created_at);
    const av = new Date(pick(a) || a.created_at).getTime();
    const bv = new Date(pick(b) || b.created_at).getTime();
    return sort === "oldest" ? av - bv : bv - av;
  });

  return (
    <div>
      <div className="mb-3 flex items-center justify-end gap-3 text-sm">
        <label className="flex items-center gap-1 text-slate-500">
          Sort:
          <select value={sort} onChange={(e) => setSort(e.target.value as "oldest" | "newest")} className="rounded-md border border-slate-200 bg-white px-2 py-1 font-medium text-brand-700">
            <option value="oldest">Oldest First</option>
            <option value="newest">Newest First</option>
          </select>
        </label>
        <label className="flex items-center gap-1 text-slate-500">
          Owner:
          <select value={owner} onChange={(e) => setOwner(e.target.value as "all" | "me")} className="rounded-md border border-slate-200 bg-white px-2 py-1 font-medium text-brand-700">
            <option value="all">All</option>
            <option value="me">Me</option>
          </select>
        </label>
      </div>

      <div className="card">
        <div className="flex gap-1 border-b border-slate-100 px-2">
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={
                "relative px-4 py-3 text-sm font-medium transition-colors " +
                (tab === t.key
                  ? "text-brand-700 after:absolute after:inset-x-3 after:bottom-0 after:h-0.5 after:rounded-full after:bg-brand-600"
                  : "text-slate-500 hover:text-slate-700")
              }
            >
              {t.label} ({buckets[t.key].length})
            </button>
          ))}
        </div>

        <ul>
          {rows.map((t) => {
            const Icon = TYPE_ICON[t.type] || Circle;
            const stamp = tab === "completed" ? t.completed_at : tab === "scheduled" ? t.due_at : t.due_at || t.created_at;
            return (
              <li key={t.id} className="flex items-center gap-3 border-b border-slate-100 px-4 py-2.5 last:border-0">
                {t.status === "done" ? (
                  <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-500" />
                ) : t.status === "skipped" ? (
                  <SkipForward className="h-5 w-5 shrink-0 text-slate-400" />
                ) : (
                  <button onClick={() => setStatus.mutate({ id: t.id, status: "done" })} title="Mark done">
                    <Circle className="h-5 w-5 shrink-0 text-slate-400 hover:text-emerald-500" />
                  </button>
                )}
                <Icon className="h-4 w-4 shrink-0 text-slate-500" />
                <span className={"flex-1 truncate text-sm " + (t.status === "done" ? "text-slate-500 line-through" : "")}>{t.title}</span>
                <span className="shrink-0 text-xs text-slate-400">{fmtRelative(stamp)}</span>
                {t.status === "open" && (
                  <button onClick={() => setStatus.mutate({ id: t.id, status: "skipped" })} className="shrink-0 rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600" title="Skip task">
                    <SkipForward className="h-4 w-4" />
                  </button>
                )}
                {t.status === "skipped" && (
                  <button onClick={() => setStatus.mutate({ id: t.id, status: "open" })} className="shrink-0 rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600" title="Restore task">
                    <RotateCcw className="h-4 w-4" />
                  </button>
                )}
              </li>
            );
          })}
          {rows.length === 0 && <li className="px-4 py-6 text-sm text-slate-500">No {tab} tasks.</li>}
        </ul>
      </div>
    </div>
  );
}

// ── Page ────────────────────────────────────────────────────────────────────

export default function TasksPage() {
  const [view, setView] = useState<"workload" | "list">("workload");
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("view") === "list") setView("list");
  }, []);

  return (
    <div className="p-6">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[26px] font-normal tracking-tight text-slate-900">Task Office</h1>
          <p className="mt-0.5 text-sm text-slate-500">Everything that needs doing — and what needs YOUR attention.</p>
        </div>
        <div className="inline-flex gap-0.5 rounded-lg bg-slate-100 p-0.5">
          <button
            onClick={() => setView("workload")}
            className={"inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors " + (view === "workload" ? "bg-white text-brand-700 shadow-sm" : "text-slate-500 hover:text-slate-700")}
          >
            <LayoutGrid className="h-4 w-4" /> Workload
          </button>
          <button
            onClick={() => setView("list")}
            className={"inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors " + (view === "list" ? "bg-white text-brand-700 shadow-sm" : "text-slate-500 hover:text-slate-700")}
          >
            <ListChecks className="h-4 w-4" /> List
          </button>
        </div>
      </div>

      {view === "workload" ? <OfficeWorkload /> : <TaskList />}
    </div>
  );
}
