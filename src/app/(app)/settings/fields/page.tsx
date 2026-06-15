"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { api } from "@/lib/api";
import type { LeadField } from "@/lib/types";

const TYPES = ["text", "number", "date", "url", "enum", "multi", "bool"];

export default function FieldsPage() {
  const qc = useQueryClient();
  const { data: fields } = useQuery<LeadField[]>({
    queryKey: ["fields"],
    queryFn: () => api("/settings/fields"),
  });
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ key: "", label: "", type: "text" });

  const create = useMutation({
    mutationFn: () => api("/settings/fields", { method: "POST", body: draft }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["fields"] });
      setAdding(false);
      setDraft({ key: "", label: "", type: "text" });
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => api(`/settings/fields/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["fields"] }),
  });

  return (
    <div className="card max-w-3xl p-6">
      <div className="mb-6 flex items-center justify-between">
        <h2 className="text-base font-semibold">Custom Fields</h2>
        <button className="btn-primary" onClick={() => setAdding(true)}>
          <Plus className="h-4 w-4" /> Add field
        </button>
      </div>

      {adding && (
        <div className="mb-4 grid grid-cols-1 gap-2 rounded-md border border-slate-200 p-3 sm:grid-cols-3">
          <input className="input" placeholder="Key (e.g. industry)" value={draft.key} onChange={(e) => setDraft({ ...draft, key: e.target.value })} />
          <input className="input" placeholder="Label" value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })} />
          <select className="input" value={draft.type} onChange={(e) => setDraft({ ...draft, type: e.target.value })}>
            {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          <div className="col-span-3 flex justify-end gap-2">
            <button className="btn-secondary" onClick={() => setAdding(false)}>Cancel</button>
            <button className="btn-primary" onClick={() => create.mutate()} disabled={!draft.key || !draft.label}>Save</button>
          </div>
        </div>
      )}

      <table className="w-full text-sm">
        <thead className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
          <tr>
            <th className="py-2">Label</th>
            <th className="py-2">Key</th>
            <th className="py-2">Type</th>
            <th className="py-2">Visible by default</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {fields?.map((f) => (
            <tr key={f.id} className="border-b border-slate-100">
              <td className="py-2">{f.label} {f.is_system && <span className="ml-1 text-[10px] uppercase text-slate-400">system</span>}</td>
              <td className="py-2 font-mono text-xs text-slate-600">{f.key}</td>
              <td className="py-2 capitalize">{f.type}</td>
              <td className="py-2">{f.visible_default ? "Yes" : "No"}</td>
              <td className="py-2 text-right">
                {!f.is_system && (
                  <button className="rounded p-1 text-slate-400 hover:text-rose-500" onClick={() => remove.mutate(f.id)}>
                    <Trash2 className="h-4 w-4" />
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
