"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Circle, Phone, Mail, Linkedin } from "lucide-react";
import { api } from "@/lib/api";
import type { Task } from "@/lib/types";
import { fmtRelative } from "@/lib/utils";

const TYPE_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  call: Phone,
  email: Mail,
  linkedin: Linkedin,
};

export default function TasksPage() {
  const qc = useQueryClient();
  const { data: tasks } = useQuery<Task[]>({
    queryKey: ["tasks"],
    queryFn: () => api("/tasks"),
  });
  const toggle = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) =>
      api(`/tasks/${id}`, { method: "PATCH", body: { status } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tasks"] }),
  });

  const open = tasks?.filter((t) => t.status !== "done") || [];
  const done = tasks?.filter((t) => t.status === "done") || [];

  return (
    <div className="p-6">
      <h1 className="mb-4 text-lg font-semibold">Tasks</h1>
      <div className="card">
        <div className="border-b border-slate-100 px-4 py-3 text-sm font-medium">Open ({open.length})</div>
        <ul>
          {open.map((t) => {
            const Icon = TYPE_ICON[t.type] || Circle;
            return (
              <li key={t.id} className="flex items-center gap-3 border-b border-slate-100 px-4 py-2 last:border-0">
                <button onClick={() => toggle.mutate({ id: t.id, status: "done" })}>
                  <Circle className="h-5 w-5 text-slate-400 hover:text-emerald-500" />
                </button>
                <Icon className="h-4 w-4 text-slate-500" />
                <span className="flex-1 truncate text-sm">{t.title}</span>
                <span className="text-xs text-slate-400">{fmtRelative(t.due_at)}</span>
              </li>
            );
          })}
          {open.length === 0 && <li className="px-4 py-4 text-sm text-slate-500">No open tasks.</li>}
        </ul>
      </div>
      <div className="card mt-6">
        <div className="border-b border-slate-100 px-4 py-3 text-sm font-medium">Completed ({done.length})</div>
        <ul>
          {done.slice(0, 50).map((t) => (
            <li key={t.id} className="flex items-center gap-3 border-b border-slate-100 px-4 py-2 last:border-0">
              <CheckCircle2 className="h-5 w-5 text-emerald-500" />
              <span className="flex-1 truncate text-sm text-slate-500 line-through">{t.title}</span>
              <span className="text-xs text-slate-400">{fmtRelative(t.completed_at)}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
