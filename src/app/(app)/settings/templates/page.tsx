"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { api } from "@/lib/api";
import type { Template } from "@/lib/types";

export default function TemplatesPage() {
  const qc = useQueryClient();
  const { data: templates } = useQuery<Template[]>({
    queryKey: ["templates"],
    queryFn: () => api("/templates"),
  });
  const [draft, setDraft] = useState<{ name: string; channel: string; subject: string; body: string } | null>(null);
  const create = useMutation({
    mutationFn: () => api("/templates", { method: "POST", body: draft }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["templates"] });
      setDraft(null);
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/templates/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["templates"] }),
  });

  return (
    <div className="card max-w-3xl p-6">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-base font-semibold">Email Templates</h2>
        <button
          className="btn-primary"
          onClick={() => setDraft({ name: "", channel: "email", subject: "", body: "" })}
        >
          <Plus className="h-4 w-4" /> New template
        </button>
      </div>

      {draft && (
        <div className="mb-4 space-y-3 rounded-md border border-slate-200 p-3">
          <input className="input" placeholder="Name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          <select className="input" value={draft.channel} onChange={(e) => setDraft({ ...draft, channel: e.target.value })}>
            <option value="email">Email</option>
            <option value="linkedin_connect">LinkedIn Connect</option>
            <option value="linkedin_message">LinkedIn Message</option>
          </select>
          {draft.channel === "email" && (
            <input className="input" placeholder="Subject" value={draft.subject} onChange={(e) => setDraft({ ...draft, subject: e.target.value })} />
          )}
          <textarea
            className="input min-h-[160px]"
            placeholder={"Hi {{first_name}},\n\nSaw you're {{title}} at {{company}}…"}
            value={draft.body}
            onChange={(e) => setDraft({ ...draft, body: e.target.value })}
          />
          <div className="flex justify-end gap-2">
            <button className="btn-secondary" onClick={() => setDraft(null)}>Cancel</button>
            <button className="btn-primary" onClick={() => create.mutate()}>Save</button>
          </div>
        </div>
      )}

      <ul className="divide-y divide-slate-100">
        {templates?.map((t) => (
          <li key={t.id} className="flex items-center justify-between py-2 text-sm">
            <div>
              <div className="font-medium">{t.name}</div>
              <div className="text-xs text-slate-500">{t.channel} • {t.subject || "(no subject)"}</div>
            </div>
            <button className="rounded p-1 text-slate-400 hover:text-rose-500" onClick={() => remove.mutate(t.id)}>
              <Trash2 className="h-4 w-4" />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
