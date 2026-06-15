"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Send, UserPlus, Layers, Tag, Trash2, X, Loader2, ChevronDown } from "lucide-react";
import { api } from "@/lib/api";
import type { Lead, PipelineStage } from "@/lib/types";

interface PlaybookMini {
  id: string;
  name: string;
}

interface Props {
  selectedIds: string[];
  leadsById: Map<string, Lead>;
  stages: PipelineStage[];
  onClear: () => void;
}

/**
 * Floating action bar shown when one or more leads are selected in a list.
 * Every action reuses an EXISTING backend endpoint:
 *   - Message  → POST /leads/bulk-message { message, lead_ids }
 *   - Enroll   → POST /playbooks/{id}/enroll { lead_ids }
 *   - Stage    → PATCH /leads/{id} { stage_id }   (per lead)
 *   - Tag      → PATCH /leads/{id} { tags }        (per lead, merged)
 *   - Delete   → DELETE /leads/{id}                (per lead)
 */
export function BulkActionsBar({ selectedIds, leadsById, stages, onClear }: Props) {
  const qc = useQueryClient();
  const [panel, setPanel] = useState<null | "message" | "enroll" | "stage" | "tag">(null);
  const [message, setMessage] = useState("");
  const [tag, setTag] = useState("");
  const [note, setNote] = useState<string | null>(null);

  const { data: playbooks } = useQuery<PlaybookMini[]>({
    queryKey: ["playbooks"],
    queryFn: () => api("/playbooks"),
    enabled: panel === "enroll",
  });

  const refresh = () => qc.invalidateQueries({ queryKey: ["leads"] });
  const close = () => {
    setPanel(null);
    setMessage("");
    setTag("");
  };

  const bulkMessage = useMutation({
    mutationFn: () =>
      api<{ queued: number }>("/leads/bulk-message", {
        method: "POST",
        body: { message: message.trim(), lead_ids: selectedIds },
      }),
    onSuccess: (r) => {
      setNote(`${r.queued} message${r.queued === 1 ? "" : "s"} queued.`);
      close();
      onClear();
    },
  });

  const enroll = useMutation({
    mutationFn: (playbookId: string) =>
      api(`/playbooks/${playbookId}/enroll`, {
        method: "POST",
        body: { lead_ids: selectedIds },
      }),
    onSuccess: () => {
      setNote(`Enrolled ${selectedIds.length} lead${selectedIds.length === 1 ? "" : "s"}.`);
      close();
      onClear();
    },
  });

  const setStage = useMutation({
    mutationFn: (stageId: string) =>
      Promise.all(
        selectedIds.map((id) =>
          api(`/leads/${id}`, { method: "PATCH", body: { stage_id: stageId } })
        )
      ),
    onSuccess: () => {
      setNote(`Moved ${selectedIds.length} lead${selectedIds.length === 1 ? "" : "s"}.`);
      close();
      onClear();
      refresh();
      qc.invalidateQueries({ queryKey: ["stages"] });
    },
  });

  const addTag = useMutation({
    mutationFn: () => {
      const t = tag.trim();
      return Promise.all(
        selectedIds.map((id) => {
          const lead = leadsById.get(id);
          const merged = Array.from(new Set([...(lead?.tags || []), t]));
          return api(`/leads/${id}`, { method: "PATCH", body: { tags: merged } });
        })
      );
    },
    onSuccess: () => {
      setNote(`Tagged ${selectedIds.length} lead${selectedIds.length === 1 ? "" : "s"}.`);
      close();
      onClear();
      refresh();
    },
  });

  const del = useMutation({
    mutationFn: () =>
      Promise.all(selectedIds.map((id) => api(`/leads/${id}`, { method: "DELETE" }))),
    onSuccess: () => {
      setNote(`Deleted ${selectedIds.length} lead${selectedIds.length === 1 ? "" : "s"}.`);
      onClear();
      refresh();
    },
  });

  const busy =
    bulkMessage.isPending ||
    enroll.isPending ||
    setStage.isPending ||
    addTag.isPending ||
    del.isPending;

  return (
    <>
      {note && (
        <div className="fixed bottom-20 left-1/2 z-40 -translate-x-1/2 rounded-md border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm text-emerald-800 shadow-lg">
          {note}
          <button className="ml-3 text-emerald-600 hover:text-emerald-800" onClick={() => setNote(null)}>
            ✕
          </button>
        </div>
      )}

      <div className="fixed bottom-6 left-1/2 z-40 -translate-x-1/2">
        <div className="flex items-center gap-1 rounded-xl border border-slate-200 bg-white px-3 py-2 shadow-xl">
          <span className="mr-1 rounded-md bg-brand-50 px-2 py-1 text-sm font-semibold text-brand-700">
            {selectedIds.length} selected
          </span>

          <BarButton icon={Send} label="Message" onClick={() => setPanel(panel === "message" ? null : "message")} active={panel === "message"} />
          <BarButton icon={UserPlus} label="Enroll" onClick={() => setPanel(panel === "enroll" ? null : "enroll")} active={panel === "enroll"} />
          <BarButton icon={Layers} label="Stage" onClick={() => setPanel(panel === "stage" ? null : "stage")} active={panel === "stage"} />
          <BarButton icon={Tag} label="Tag" onClick={() => setPanel(panel === "tag" ? null : "tag")} active={panel === "tag"} />
          <BarButton
            icon={Trash2}
            label="Delete"
            danger
            onClick={() => {
              if (window.confirm(`Delete ${selectedIds.length} lead(s)? This cannot be undone.`)) del.mutate();
            }}
          />
          <span className="mx-1 h-5 w-px bg-slate-200" />
          <button className="rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700" title="Clear selection" onClick={onClear}>
            <X className="h-4 w-4" />
          </button>
          {busy && <Loader2 className="ml-1 h-4 w-4 animate-spin text-brand-600" />}
        </div>

        {/* Expanding panels */}
        {panel === "message" && (
          <Panel>
            <label className="label">Message all {selectedIds.length} selected</label>
            <textarea
              className="input min-h-[110px] resize-y"
              placeholder="Hi {first_name}, …"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
            />
            <div className="mt-2 flex justify-end gap-2">
              <button className="btn-secondary" onClick={close}>Cancel</button>
              <button className="btn-primary disabled:opacity-50" disabled={!message.trim() || bulkMessage.isPending} onClick={() => bulkMessage.mutate()}>
                Queue messages
              </button>
            </div>
          </Panel>
        )}

        {panel === "enroll" && (
          <Panel>
            <label className="label">Enroll in playbook</label>
            <div className="max-h-56 overflow-y-auto">
              {(playbooks || []).map((p) => (
                <button key={p.id} className="block w-full rounded-md px-3 py-2 text-left text-sm hover:bg-slate-50" onClick={() => enroll.mutate(p.id)}>
                  {p.name}
                </button>
              ))}
              {playbooks && playbooks.length === 0 && <div className="px-3 py-2 text-sm text-slate-400">No playbooks yet.</div>}
            </div>
          </Panel>
        )}

        {panel === "stage" && (
          <Panel>
            <label className="label">Move to stage</label>
            <div className="max-h-56 overflow-y-auto">
              {stages.map((s) => (
                <button key={s.id} className="block w-full rounded-md px-3 py-2 text-left text-sm hover:bg-slate-50" onClick={() => setStage.mutate(s.id)}>
                  {s.name}
                </button>
              ))}
            </div>
          </Panel>
        )}

        {panel === "tag" && (
          <Panel>
            <label className="label">Add a tag to {selectedIds.length} selected</label>
            <div className="flex gap-2">
              <input className="input" placeholder="e.g. hot-lead" value={tag} onChange={(e) => setTag(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && tag.trim()) addTag.mutate(); }} />
              <button className="btn-primary disabled:opacity-50" disabled={!tag.trim() || addTag.isPending} onClick={() => addTag.mutate()}>
                Add
              </button>
            </div>
          </Panel>
        )}
      </div>
    </>
  );
}

function BarButton({
  icon: Icon,
  label,
  onClick,
  active,
  danger,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  onClick: () => void;
  active?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={[
        "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm font-medium",
        danger ? "text-rose-600 hover:bg-rose-50" : active ? "bg-brand-50 text-brand-700" : "text-slate-600 hover:bg-slate-100",
      ].join(" ")}
    >
      <Icon className="h-4 w-4" /> {label}
    </button>
  );
}

function Panel({ children }: { children: React.ReactNode }) {
  return (
    <div className="absolute bottom-full left-1/2 mb-2 w-80 -translate-x-1/2 rounded-xl border border-slate-200 bg-white p-3 shadow-xl">
      {children}
    </div>
  );
}
