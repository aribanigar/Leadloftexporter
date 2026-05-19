"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { api } from "@/lib/api";
import type { PipelineStage } from "@/lib/types";

export default function PipelineSettingsPage() {
  const qc = useQueryClient();
  const { data: stages } = useQuery<PipelineStage[]>({
    queryKey: ["stages"],
    queryFn: () => api("/pipeline/stages"),
  });
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ name: "", color: "#3b82f6" });

  const create = useMutation({
    mutationFn: () => api("/pipeline/stages", { method: "POST", body: draft }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["stages"] });
      setAdding(false);
      setDraft({ name: "", color: "#3b82f6" });
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/pipeline/stages/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["stages"] }),
  });

  return (
    <div className="card max-w-3xl p-6">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-base font-semibold">Pipeline & Segments</h2>
        <button className="btn-primary" onClick={() => setAdding(true)}>
          <Plus className="h-4 w-4" /> Add stage
        </button>
      </div>
      {adding && (
        <div className="mb-4 flex items-center gap-2 rounded-md border border-slate-200 p-3">
          <input className="input flex-1" placeholder="Stage name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          <input type="color" className="h-10 w-12 rounded border border-slate-200" value={draft.color} onChange={(e) => setDraft({ ...draft, color: e.target.value })} />
          <button className="btn-secondary" onClick={() => setAdding(false)}>Cancel</button>
          <button className="btn-primary" disabled={!draft.name} onClick={() => create.mutate()}>Save</button>
        </div>
      )}
      <ul className="space-y-2">
        {stages?.map((s) => (
          <li key={s.id} className="flex items-center gap-3 rounded-md border border-slate-200 px-3 py-2">
            <span className="h-3 w-3 rounded-full" style={{ background: s.color }} />
            <span className="flex-1 font-medium">{s.name}</span>
            <span className="text-xs text-slate-500">{s.lead_count} leads</span>
            <button className="rounded p-1 text-slate-400 hover:text-rose-500" onClick={() => remove.mutate(s.id)}>
              <Trash2 className="h-4 w-4" />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
