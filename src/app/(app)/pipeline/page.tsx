"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Columns3, List, Plus } from "lucide-react";
import {
  DndContext,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { api } from "@/lib/api";
import type { Lead, LeadList, PipelineStage } from "@/lib/types";
import { fmtDate, fmtMoney, initials } from "@/lib/utils";

export default function PipelinePage() {
  const qc = useQueryClient();
  const [view, setView] = useState<"board" | "list">("board");

  const { data: stages } = useQuery<PipelineStage[]>({
    queryKey: ["stages"],
    queryFn: () => api("/pipeline/stages"),
  });
  const { data: leads } = useQuery<LeadList>({
    queryKey: ["leads", "all"],
    queryFn: () => api("/leads?page=1&page_size=500"),
  });

  const updateStage = useMutation({
    mutationFn: ({ id, stage_id }: { id: string; stage_id: string }) =>
      api(`/leads/${id}`, { method: "PATCH", body: { stage_id } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["leads"] });
      qc.invalidateQueries({ queryKey: ["stages"] });
    },
  });

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const grouped = useMemo(() => {
    const map = new Map<string, Lead[]>();
    stages?.forEach((s) => map.set(s.id, []));
    leads?.items.forEach((l) => {
      if (l.stage_id && map.has(l.stage_id)) map.get(l.stage_id)!.push(l);
    });
    return map;
  }, [stages, leads]);

  function onDragEnd(e: DragEndEvent) {
    const leadId = String(e.active.id);
    const targetStage = e.over?.id ? String(e.over.id) : null;
    if (!targetStage) return;
    const lead = leads?.items.find((l) => l.id === leadId);
    if (!lead || lead.stage_id === targetStage) return;
    updateStage.mutate({ id: leadId, stage_id: targetStage });
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-slate-200 bg-white px-4 py-3">
        <h1 className="text-lg font-semibold">Pipeline</h1>
        <div className="ml-2 flex overflow-hidden rounded-md border border-slate-200">
          <button
            onClick={() => setView("list")}
            className={`px-2 py-1 text-sm ${view === "list" ? "bg-brand-50 text-brand-700" : "text-slate-500 hover:bg-slate-50"}`}
            title="List view"
          >
            <List className="h-4 w-4" />
          </button>
          <button
            onClick={() => setView("board")}
            className={`px-2 py-1 text-sm ${view === "board" ? "bg-brand-50 text-brand-700" : "text-slate-500 hover:bg-slate-50"}`}
            title="Board view"
          >
            <Columns3 className="h-4 w-4" />
          </button>
        </div>
        <div className="ml-auto">
          <button className="btn-secondary">
            <Plus className="h-4 w-4" /> Add stage
          </button>
        </div>
      </div>

      {view === "board" ? (
        <DndContext sensors={sensors} onDragEnd={onDragEnd}>
          <div className="flex flex-1 gap-3 overflow-x-auto p-4">
            {stages?.map((stage) => (
              <StageColumn
                key={stage.id}
                stage={stage}
                leads={grouped.get(stage.id) || []}
              />
            ))}
          </div>
        </DndContext>
      ) : (
        <div className="flex-1 overflow-auto bg-white">
          <table className="min-w-full">
            <thead className="sticky top-0 z-10 bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-3 py-2 text-left">Name</th>
                <th className="px-3 py-2 text-left">Title</th>
                <th className="px-3 py-2 text-left">Company</th>
                <th className="px-3 py-2 text-left">Email</th>
                <th className="px-3 py-2 text-left">Phone</th>
                <th className="px-3 py-2 text-left">LinkedIn</th>
                <th className="px-3 py-2 text-left">Location</th>
                <th className="px-3 py-2 text-left">Status</th>
                <th className="px-3 py-2 text-left">Owner</th>
                <th className="px-3 py-2 text-left">Date Created</th>
                <th className="px-3 py-2 text-left">Last Updated</th>
              </tr>
            </thead>
            <tbody>
              {leads?.items.map((lead) => {
                const stage = stages?.find((s) => s.id === lead.stage_id);
                return (
                  <tr key={lead.id} className="border-b border-slate-100 hover:bg-slate-50">
                    <td className="px-3 py-2 text-sm">
                      <div className="flex items-center gap-2">
                        <div className="grid h-7 w-7 place-items-center rounded-full bg-slate-200 text-[10px] font-semibold uppercase">
                          {initials(lead.full_name)}
                        </div>
                        <div>
                          <div className="font-medium">{lead.full_name || "—"}</div>
                          <div className="text-xs text-slate-500">{fmtDate(lead.close_date) || "$--"}</div>
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-2 text-sm text-slate-700">{lead.title || "—"}</td>
                    <td className="px-3 py-2 text-sm text-slate-700">{lead.company?.name || "—"}</td>
                    <td className="px-3 py-2 text-sm text-slate-700">
                      {lead.email ? (
                        <a href={`mailto:${lead.email}`} className="text-brand-600 hover:underline">
                          {lead.email}
                        </a>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="px-3 py-2 text-sm text-slate-700">{lead.phone || "—"}</td>
                    <td className="px-3 py-2 text-sm text-slate-700">
                      {lead.linkedin_url ? (
                        <a
                          href={lead.linkedin_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-brand-600 hover:underline"
                        >
                          Profile
                        </a>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="px-3 py-2 text-sm text-slate-700">{lead.location || "—"}</td>
                    <td className="px-3 py-2 text-sm">
                      <span className="pill" style={{ backgroundColor: (stage?.color || "#e2e8f0") + "22", color: stage?.color || "#475569" }}>
                        {stage?.name || "—"}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-sm text-slate-700">{lead.owner_id ? "You" : "—"}</td>
                    <td className="px-3 py-2 text-sm text-slate-700">{fmtDate(lead.created_at)}</td>
                    <td className="px-3 py-2 text-sm text-slate-700">{fmtDate(lead.updated_at)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function StageColumn({ stage, leads }: { stage: PipelineStage; leads: Lead[] }) {
  const { isOver, setNodeRef } = useDroppable({ id: stage.id });
  return (
    <div
      ref={setNodeRef}
      className={`flex w-72 shrink-0 flex-col rounded-lg border ${isOver ? "border-brand-400 bg-brand-50" : "border-slate-200 bg-slate-50"}`}
    >
      <div className="flex items-center justify-between border-b border-slate-200 px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full" style={{ background: stage.color }} />
          <span className="text-sm font-semibold">{stage.name}</span>
        </div>
        <span className="rounded bg-white px-1.5 py-0.5 text-xs text-slate-500">{leads.length}</span>
      </div>
      <div className="flex-1 space-y-2 overflow-y-auto p-2">
        {leads.map((lead) => (
          <LeadCard key={lead.id} lead={lead} />
        ))}
      </div>
    </div>
  );
}

import { useDraggable } from "@dnd-kit/core";

function LeadCard({ lead }: { lead: Lead }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: lead.id });
  const style: React.CSSProperties = transform
    ? { transform: `translate(${transform.x}px, ${transform.y}px)`, opacity: isDragging ? 0.6 : 1 }
    : {};
  return (
    <div
      ref={setNodeRef}
      style={style}
      {...listeners}
      {...attributes}
      className="cursor-grab rounded-md border border-slate-200 bg-white p-2 shadow-soft hover:shadow-card"
    >
      <div className="flex items-center gap-2">
        <div className="grid h-7 w-7 place-items-center rounded-full bg-slate-200 text-[10px] font-semibold uppercase">
          {initials(lead.full_name)}
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{lead.full_name || "—"}</div>
          <div className="truncate text-xs text-slate-500">{lead.title || lead.company?.name || ""}</div>
        </div>
      </div>
      <div className="mt-1.5 flex items-center justify-between text-xs text-slate-500">
        <span>{fmtDate(lead.close_date) || "—"}</span>
        <span>{fmtMoney(lead.estimated_value)}</span>
      </div>
    </div>
  );
}
