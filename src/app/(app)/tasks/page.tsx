"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Circle, Phone, Mail, Linkedin, SkipForward, RotateCcw } from "lucide-react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import type { Task } from "@/lib/types";
import { fmtRelative } from "@/lib/utils";

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

export default function TasksPage() {
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
    mutationFn: ({ id, status }: { id: string; status: string }) =>
      api(`/tasks/${id}`, { method: "PATCH", body: { status } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tasks"] }),
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
    const pick = (t: Task) =>
      tab === "completed" ? t.completed_at : tab === "scheduled" ? t.due_at : t.created_at;
    const av = new Date(pick(a) || a.created_at).getTime();
    const bv = new Date(pick(b) || b.created_at).getTime();
    return sort === "oldest" ? av - bv : bv - av;
  });

  return (
    <div className="p-6">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-lg font-semibold">Tasks</h1>
        <div className="flex items-center gap-3 text-sm">
          <label className="flex items-center gap-1 text-slate-500">
            Sort:
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as "oldest" | "newest")}
              className="rounded-md border border-slate-200 bg-white px-2 py-1 font-medium text-brand-700"
            >
              <option value="oldest">Oldest First</option>
              <option value="newest">Newest First</option>
            </select>
          </label>
          <label className="flex items-center gap-1 text-slate-500">
            Owner:
            <select
              value={owner}
              onChange={(e) => setOwner(e.target.value as "all" | "me")}
              className="rounded-md border border-slate-200 bg-white px-2 py-1 font-medium text-brand-700"
            >
              <option value="all">All</option>
              <option value="me">Me</option>
            </select>
          </label>
        </div>
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
            const stamp =
              tab === "completed" ? t.completed_at : tab === "scheduled" ? t.due_at : t.due_at || t.created_at;
            return (
              <li
                key={t.id}
                className="flex items-center gap-3 border-b border-slate-100 px-4 py-2.5 last:border-0"
              >
                {t.status === "done" ? (
                  <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-500" />
                ) : t.status === "skipped" ? (
                  <SkipForward className="h-5 w-5 shrink-0 text-slate-400" />
                ) : (
                  <button
                    onClick={() => setStatus.mutate({ id: t.id, status: "done" })}
                    title="Mark done"
                  >
                    <Circle className="h-5 w-5 shrink-0 text-slate-400 hover:text-emerald-500" />
                  </button>
                )}
                <Icon className="h-4 w-4 shrink-0 text-slate-500" />
                <span
                  className={
                    "flex-1 truncate text-sm " +
                    (t.status === "done" ? "text-slate-500 line-through" : "")
                  }
                >
                  {t.title}
                </span>
                <span className="shrink-0 text-xs text-slate-400">{fmtRelative(stamp)}</span>
                {t.status === "open" && (
                  <button
                    onClick={() => setStatus.mutate({ id: t.id, status: "skipped" })}
                    className="shrink-0 rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
                    title="Skip task"
                  >
                    <SkipForward className="h-4 w-4" />
                  </button>
                )}
                {t.status === "skipped" && (
                  <button
                    onClick={() => setStatus.mutate({ id: t.id, status: "open" })}
                    className="shrink-0 rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
                    title="Restore task"
                  >
                    <RotateCcw className="h-4 w-4" />
                  </button>
                )}
              </li>
            );
          })}
          {rows.length === 0 && (
            <li className="px-4 py-6 text-sm text-slate-500">No {tab} tasks.</li>
          )}
        </ul>
      </div>
    </div>
  );
}
