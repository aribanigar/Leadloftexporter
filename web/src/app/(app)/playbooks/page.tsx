"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { Plus, Users } from "lucide-react";
import { api } from "@/lib/api";
import type { Playbook } from "@/lib/types";

export default function PlaybooksPage() {
  const qc = useQueryClient();
  const { data: playbooks } = useQuery<Playbook[]>({
    queryKey: ["playbooks"],
    queryFn: () => api("/playbooks"),
  });
  const create = useMutation({
    mutationFn: () =>
      api<Playbook>("/playbooks", {
        method: "POST",
        body: {
          name: "Untitled Playbook",
          trigger: "manual",
          is_active: false,
          steps: [{ kind: "automated_email", wait_days: 0, wait_hours: 0, config: { ai: true } }],
        },
      }),
    onSuccess: (pb) => {
      qc.invalidateQueries({ queryKey: ["playbooks"] });
      window.location.href = `/playbooks/${pb.id}`;
    },
  });

  return (
    <div className="p-6">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-lg font-semibold">Playbooks</h1>
        <button className="btn-primary" onClick={() => create.mutate()}>
          <Plus className="h-4 w-4" /> New playbook
        </button>
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {playbooks?.map((p) => (
          <Link
            key={p.id}
            href={`/playbooks/${p.id}`}
            className="card block p-4 hover:border-brand-200"
          >
            <div className="flex items-center justify-between">
              <h2 className="font-semibold">{p.name}</h2>
              <span
                className={`pill ${p.is_active ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-500"}`}
              >
                {p.is_active ? "Active" : "Paused"}
              </span>
            </div>
            <p className="mt-1 text-sm text-slate-500">{p.description || "—"}</p>
            <div className="mt-3 flex items-center gap-3 text-xs text-slate-500">
              <span>{p.steps.length} step{p.steps.length === 1 ? "" : "s"}</span>
              <span className="flex items-center gap-1">
                <Users className="h-3.5 w-3.5" /> {p.enrolled_count}
              </span>
              <span className="capitalize">trigger: {p.trigger.replace("_", " ")}</span>
            </div>
          </Link>
        ))}
        {playbooks?.length === 0 && (
          <p className="col-span-full text-sm text-slate-500">No playbooks yet. Create one to start outreach.</p>
        )}
      </div>
    </div>
  );
}
