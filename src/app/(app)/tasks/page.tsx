"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2,
  Circle,
  CircleDot,
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
  CalendarPlus,
  AlertTriangle,
  Inbox,
  ListChecks,
  LayoutGrid,
  KanbanSquare,
  Plus,
  Trash2,
  ChevronDown,
  ChevronRight,
  UserCircle2,
} from "lucide-react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import type { Task } from "@/lib/types";
import { cn, fmtRelative, initials } from "@/lib/utils";

interface Member {
  id: string;
  name: string;
  email: string;
}

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

// ── ClickUp-style board ─────────────────────────────────────────────────────

const TYPE_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  call: Phone,
  email: Mail,
  linkedin: Linkedin,
};

// Board columns (grouped by status). Legacy "done"/"completed" collapse to done.
const COLUMNS: { key: string; label: string; color: string; bg: string; dot: string }[] = [
  { key: "open", label: "To do", color: "#64748b", bg: "#f1f5f9", dot: "#94a3b8" },
  { key: "in_progress", label: "In progress", color: "#1a73e8", bg: "#e8f0fe", dot: "#1a73e8" },
  { key: "done", label: "Completed", color: "#137333", bg: "#e6f4ea", dot: "#34a853" },
];
const NEXT_STATUS: Record<string, string> = { open: "in_progress", in_progress: "done", done: "open" };

function normStatus(s: string): string {
  if (s === "completed") return "done";
  if (s === "open" || s === "in_progress" || s === "done") return s;
  return "open"; // "skipped" and anything unknown sit in To do on the board
}

// datetime-local helpers (value is local wall-clock; convert to/from ISO).
function toLocalInput(iso?: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}
function fromLocalInput(v: string): string | null {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d.toISOString();
}
function formatDue(iso?: string | null): { text: string; overdue: boolean } | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  const now = new Date();
  const sameYear = d.getFullYear() === now.getFullYear();
  const text = d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
    hour: "numeric",
    minute: "2-digit",
  });
  return { text, overdue: d.getTime() < now.getTime() };
}

const AVATAR_COLORS = ["#2563eb", "#0d9488", "#9333ea", "#db2777", "#ea580c", "#65a30d", "#0891b2"];
function avatarColor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}
function Avatar({ name, size = 22 }: { name?: string | null; size?: number }) {
  if (!name) {
    return <UserCircle2 className="text-slate-300" style={{ width: size, height: size }} />;
  }
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center rounded-full text-[10px] font-semibold text-white"
      style={{ width: size, height: size, backgroundColor: avatarColor(name) }}
      title={name}
    >
      {initials(name)}
    </span>
  );
}

function TaskRow({
  t,
  members,
  onPatch,
  onDelete,
}: {
  t: Task;
  members: Member[];
  onPatch: (patch: Partial<Task> & { remind?: boolean }) => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(t.title);
  const status = normStatus(t.status);
  const TIcon = TYPE_ICON[t.type];
  const due = formatDue(t.due_at);
  const assignee = members.find((m) => m.id === t.assignee_id);
  const dateRef = useRef<HTMLInputElement>(null);

  const commitTitle = () => {
    const v = title.trim();
    setEditing(false);
    if (v && v !== t.title) onPatch({ title: v });
    else setTitle(t.title);
  };

  return (
    <div className="group grid grid-cols-[28px_1fr_auto] items-center gap-2 border-b border-slate-100 px-3 py-2 last:border-0 hover:bg-slate-50/70 md:grid-cols-[28px_1fr_150px_180px_28px]">
      {/* status dot — click to advance To do → In progress → Completed */}
      <button
        onClick={() => onPatch({ status: NEXT_STATUS[status] })}
        title={`Mark ${status === "done" ? "to do" : status === "open" ? "in progress" : "completed"}`}
        className="flex h-7 w-7 items-center justify-center"
      >
        {status === "done" ? (
          <CheckCircle2 className="h-[18px] w-[18px] text-emerald-500" />
        ) : status === "in_progress" ? (
          <CircleDot className="h-[18px] w-[18px] text-blue-500" />
        ) : (
          <Circle className="h-[18px] w-[18px] text-slate-300 hover:text-slate-400" />
        )}
      </button>

      {/* title (inline editable) */}
      <div className="flex min-w-0 items-center gap-2">
        {TIcon && <TIcon className="h-3.5 w-3.5 shrink-0 text-slate-400" />}
        {editing ? (
          <input
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={commitTitle}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitTitle();
              if (e.key === "Escape") {
                setTitle(t.title);
                setEditing(false);
              }
            }}
            className="w-full rounded border border-brand-300 px-1.5 py-0.5 text-sm outline-none focus:ring-2 focus:ring-brand-100"
          />
        ) : (
          <span
            onClick={() => setEditing(true)}
            className={cn("min-w-0 cursor-text truncate text-sm", status === "done" ? "text-slate-400 line-through" : "text-slate-800")}
          >
            {t.title}
          </span>
        )}
        {t.lead_id && (
          <Link href={`/leads/${t.lead_id}`} className="shrink-0 text-[11px] text-brand-600 hover:underline" title="Open lead">
            lead ↗
          </Link>
        )}
      </div>

      {/* assignee */}
      <div className="hidden items-center md:flex">
        <label className="flex w-full cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-1 hover:bg-slate-100">
          <Avatar name={assignee?.name} />
          <select
            value={t.assignee_id || ""}
            onChange={(e) => onPatch({ assignee_id: e.target.value || null })}
            className="w-full cursor-pointer truncate bg-transparent text-[12px] text-slate-600 outline-none"
          >
            <option value="">Unassigned</option>
            {members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      {/* due date / calendar */}
      <div className="hidden items-center md:flex">
        <button
          onClick={() => dateRef.current?.showPicker?.() ?? dateRef.current?.focus()}
          className={cn(
            "flex items-center gap-1.5 rounded-md border px-2 py-1 text-[12px]",
            due
              ? due.overdue && status !== "done"
                ? "border-rose-200 bg-rose-50 text-rose-600"
                : "border-emerald-200 bg-emerald-50 text-emerald-700"
              : "border-slate-200 text-slate-400 hover:border-slate-300"
          )}
          title={due ? "On your calendar — click to change" : "Set a due date (adds to calendar + emails you)"}
        >
          {due ? <CalendarClock className="h-3.5 w-3.5" /> : <CalendarPlus className="h-3.5 w-3.5" />}
          <span className="truncate">{due ? due.text : "Schedule"}</span>
        </button>
        <input
          ref={dateRef}
          type="datetime-local"
          value={toLocalInput(t.due_at)}
          onChange={(e) => onPatch({ due_at: fromLocalInput(e.target.value), remind: true })}
          className="sr-only"
          tabIndex={-1}
        />
        {t.due_at && (
          <button
            onClick={() => onPatch({ due_at: null })}
            className="ml-1 rounded p-0.5 text-slate-300 opacity-0 hover:text-rose-500 group-hover:opacity-100"
            title="Clear due date"
          >
            ✕
          </button>
        )}
      </div>

      {/* delete */}
      <button
        onClick={onDelete}
        className="flex h-7 w-7 items-center justify-center rounded text-slate-300 opacity-0 hover:bg-rose-50 hover:text-rose-500 group-hover:opacity-100"
        title="Delete task"
      >
        <Trash2 className="h-4 w-4" />
      </button>
    </div>
  );
}

function AddTaskRow({ status, onCreate }: { status: string; onCreate: (title: string) => void }) {
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const submit = () => {
    const v = title.trim();
    if (v) onCreate(v);
    setTitle("");
    setAdding(false);
  };
  if (!adding) {
    return (
      <button
        onClick={() => setAdding(true)}
        className="flex w-full items-center gap-2 px-3 py-2 text-[13px] text-slate-400 hover:bg-slate-50 hover:text-brand-600"
      >
        <Plus className="h-4 w-4" /> Add Task
      </button>
    );
  }
  return (
    <div className="flex items-center gap-2 px-3 py-2">
      <Plus className="h-4 w-4 text-slate-300" />
      <input
        autoFocus
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onBlur={submit}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
          if (e.key === "Escape") {
            setTitle("");
            setAdding(false);
          }
        }}
        placeholder="Task name, then Enter…"
        className="w-full rounded border border-brand-300 px-2 py-1 text-sm outline-none focus:ring-2 focus:ring-brand-100"
      />
    </div>
  );
}

function TaskBoard() {
  const qc = useQueryClient();
  const { user } = useAuth();
  const [owner, setOwner] = useState<"all" | "me">("all");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const { data: tasks, isLoading } = useQuery<Task[]>({
    queryKey: ["tasks"],
    queryFn: () => api("/tasks"),
    refetchInterval: 15000,
  });
  const { data: members } = useQuery<Member[]>({
    queryKey: ["task-members"],
    queryFn: () => api("/tasks/members"),
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["tasks"] });
    qc.invalidateQueries({ queryKey: ["office-workload"] });
    qc.invalidateQueries({ queryKey: ["calendar-reminders"] });
  };

  const createTask = useMutation({
    mutationFn: (body: Record<string, unknown>) => api("/tasks", { method: "POST", body }),
    onSuccess: invalidate,
  });
  const patchTask = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Record<string, unknown> }) =>
      api(`/tasks/${id}`, { method: "PATCH", body: patch }),
    // Optimistic: update cache immediately so the row moves columns without a flash.
    onMutate: async ({ id, patch }) => {
      await qc.cancelQueries({ queryKey: ["tasks"] });
      const prev = qc.getQueryData<Task[]>(["tasks"]);
      qc.setQueryData<Task[]>(["tasks"], (old) => (old || []).map((t) => (t.id === id ? { ...t, ...patch } as Task : t)));
      return { prev };
    },
    onError: (_e, _v, ctx) => ctx?.prev && qc.setQueryData(["tasks"], ctx.prev),
    onSettled: invalidate,
  });
  const deleteTask = useMutation({
    mutationFn: (id: string) => api(`/tasks/${id}`, { method: "DELETE" }),
    onSuccess: invalidate,
  });

  const list = (tasks || []).filter((t) => (owner === "me" ? t.assignee_id === user?.id : true));
  const grouped = useMemo(() => {
    const g: Record<string, Task[]> = { open: [], in_progress: [], done: [] };
    for (const t of list) g[normStatus(t.status)].push(t);
    // sort: due first (soonest), then newest created
    for (const k of Object.keys(g)) {
      g[k].sort((a, b) => {
        const ad = a.due_at ? new Date(a.due_at).getTime() : Infinity;
        const bd = b.due_at ? new Date(b.due_at).getTime() : Infinity;
        if (ad !== bd) return ad - bd;
        return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
      });
    }
    return g;
  }, [list]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm text-slate-500">
          <span>Owner:</span>
          <div className="inline-flex gap-0.5 rounded-lg bg-slate-100 p-0.5">
            {(["all", "me"] as const).map((o) => (
              <button
                key={o}
                onClick={() => setOwner(o)}
                className={cn(
                  "rounded-md px-2.5 py-1 text-[13px] font-medium capitalize transition-colors",
                  owner === o ? "bg-white text-brand-700 shadow-sm" : "text-slate-500 hover:text-slate-700"
                )}
              >
                {o}
              </button>
            ))}
          </div>
        </div>
        <span className="text-[12px] text-slate-400">{list.length} task{list.length === 1 ? "" : "s"}</span>
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-24 animate-pulse rounded-2xl bg-slate-100" />
          ))}
        </div>
      ) : (
        COLUMNS.map((col) => {
          const rows = grouped[col.key];
          const isCollapsed = collapsed[col.key];
          return (
            <div key={col.key} className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-card">
              <div className="flex items-center gap-2 px-3 py-2.5">
                <button
                  onClick={() => setCollapsed((c) => ({ ...c, [col.key]: !c[col.key] }))}
                  className="text-slate-400 hover:text-slate-600"
                >
                  {isCollapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                </button>
                <span
                  className="inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-[12px] font-semibold uppercase tracking-wide"
                  style={{ backgroundColor: col.bg, color: col.color }}
                >
                  <span className="h-2 w-2 rounded-full" style={{ backgroundColor: col.dot }} />
                  {col.label}
                </span>
                <span className="text-[12px] font-medium text-slate-400">{rows.length}</span>
              </div>

              {!isCollapsed && (
                <div>
                  {rows.length > 0 && (
                    <div className="hidden grid-cols-[28px_1fr_150px_180px_28px] gap-2 border-y border-slate-100 bg-slate-50/60 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400 md:grid">
                      <span />
                      <span>Name</span>
                      <span>Assignee</span>
                      <span>Due / calendar</span>
                      <span />
                    </div>
                  )}
                  {rows.map((t) => (
                    <TaskRow
                      key={t.id}
                      t={t}
                      members={members || []}
                      onPatch={(patch) => patchTask.mutate({ id: t.id, patch })}
                      onDelete={() => deleteTask.mutate(t.id)}
                    />
                  ))}
                  <AddTaskRow status={col.key} onCreate={(title) => createTask.mutate({ title, status: col.key })} />
                </div>
              )}
            </div>
          );
        })
      )}
    </div>
  );
}

// ── Interactive task list (preserved) ───────────────────────────────────────

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
    due: all.filter((t) => (t.status === "open" || t.status === "in_progress") && (!t.due_at || new Date(t.due_at).getTime() <= now)),
    scheduled: all.filter((t) => (t.status === "open" || t.status === "in_progress") && t.due_at && new Date(t.due_at).getTime() > now),
    completed: all.filter((t) => t.status === "done" || t.status === "completed"),
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
            const done = t.status === "done" || t.status === "completed";
            return (
              <li key={t.id} className="flex items-center gap-3 border-b border-slate-100 px-4 py-2.5 last:border-0">
                {done ? (
                  <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-500" />
                ) : t.status === "skipped" ? (
                  <SkipForward className="h-5 w-5 shrink-0 text-slate-400" />
                ) : (
                  <button onClick={() => setStatus.mutate({ id: t.id, status: "done" })} title="Mark done">
                    <Circle className="h-5 w-5 shrink-0 text-slate-400 hover:text-emerald-500" />
                  </button>
                )}
                <Icon className="h-4 w-4 shrink-0 text-slate-500" />
                <span className={"flex-1 truncate text-sm " + (done ? "text-slate-500 line-through" : "")}>{t.title}</span>
                <span className="shrink-0 text-xs text-slate-400">{fmtRelative(stamp)}</span>
                {!done && t.status !== "skipped" && (
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

type View = "board" | "workload" | "list";

export default function TasksPage() {
  const [view, setView] = useState<View>("board");
  useEffect(() => {
    const v = new URLSearchParams(window.location.search).get("view");
    if (v === "list" || v === "workload" || v === "board") setView(v);
  }, []);

  const TABS_VIEW: { key: View; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
    { key: "board", label: "Board", icon: KanbanSquare },
    { key: "workload", label: "Workload", icon: LayoutGrid },
    { key: "list", label: "List", icon: ListChecks },
  ];

  return (
    <div className="p-6">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="gradient-heading text-[26px] font-semibold tracking-tight">Task Office</h1>
          <p className="mt-0.5 text-sm text-slate-500">Plan, assign, and schedule your work — everything that needs doing in one place.</p>
        </div>
        <div className="inline-flex gap-0.5 rounded-lg bg-slate-100 p-0.5">
          {TABS_VIEW.map(({ key, label, icon: Icon }) => (
            <button
              key={key}
              onClick={() => setView(key)}
              className={
                "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors " +
                (view === key ? "bg-white text-brand-700 shadow-sm" : "text-slate-500 hover:text-slate-700")
              }
            >
              <Icon className="h-4 w-4" /> {label}
            </button>
          ))}
        </div>
      </div>

      {view === "board" ? <TaskBoard /> : view === "workload" ? <OfficeWorkload /> : <TaskList />}
    </div>
  );
}
