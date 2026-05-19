"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import {
  Columns3,
  List,
  Plus,
  Mail,
  Phone,
  Linkedin,
  Send,
  MoreHorizontal,
  Bookmark,
  ChevronDown,
  Download,
} from "lucide-react";
import {
  DndContext,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import Link from "next/link";
import { api, API_BASE, getToken, getWorkspaceId } from "@/lib/api";
import type { Lead, LeadList, PipelineStage } from "@/lib/types";
import { fmtDate, fmtMoney, initials } from "@/lib/utils";
import { EnrollPlaybookModal } from "@/components/enroll-playbook-modal";

type SortKey = "created_at" | "updated_at" | "full_name" | "last_activity_at";
type SortDir = "asc" | "desc";

const SORT_OPTIONS: { key: SortKey; dir: SortDir; label: string }[] = [
  { key: "created_at", dir: "desc", label: "Newest first" },
  { key: "created_at", dir: "asc", label: "Oldest first" },
  { key: "updated_at", dir: "desc", label: "Recently updated" },
  { key: "last_activity_at", dir: "desc", label: "Recent activity" },
  { key: "full_name", dir: "asc", label: "Name A→Z" },
  { key: "full_name", dir: "desc", label: "Name Z→A" },
];

export default function PipelinePage() {
  const qc = useQueryClient();
  const [view, setView] = useState<"board" | "list">("list");
  const [stageFilter, setStageFilter] = useState<string | null>(null);
  const [ownerFilter, setOwnerFilter] = useState<"any" | "me">("any");
  const [sortIdx, setSortIdx] = useState(0);

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

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } })
  );

  const countsByStage = useMemo(() => {
    const m = new Map<string, number>();
    leads?.items.forEach((l) => {
      if (!l.stage_id) return;
      m.set(l.stage_id, (m.get(l.stage_id) || 0) + 1);
    });
    return m;
  }, [leads]);

  const grouped = useMemo(() => {
    const map = new Map<string, Lead[]>();
    stages?.forEach((s) => map.set(s.id, []));
    leads?.items.forEach((l) => {
      if (l.stage_id && map.has(l.stage_id)) map.get(l.stage_id)!.push(l);
    });
    return map;
  }, [stages, leads]);

  const filteredLeads = useMemo(() => {
    const sort = SORT_OPTIONS[sortIdx];
    let list = leads?.items ?? [];
    if (stageFilter) list = list.filter((l) => l.stage_id === stageFilter);
    if (ownerFilter === "me") list = list.filter((l) => l.owner_id);
    list = [...list].sort((a, b) => {
      const av = (a[sort.key] as string | null | undefined) ?? "";
      const bv = (b[sort.key] as string | null | undefined) ?? "";
      if (av === bv) return 0;
      const cmp = av < bv ? -1 : 1;
      return sort.dir === "asc" ? cmp : -cmp;
    });
    return list;
  }, [leads, stageFilter, ownerFilter, sortIdx]);

  function onDragEnd(e: DragEndEvent) {
    const leadId = String(e.active.id);
    const targetStage = e.over?.id ? String(e.over.id) : null;
    if (!targetStage) return;
    const lead = leads?.items.find((l) => l.id === leadId);
    if (!lead || lead.stage_id === targetStage) return;
    updateStage.mutate({ id: leadId, stage_id: targetStage });
  }

  function exportCsv() {
    const token = getToken();
    const ws = getWorkspaceId();
    const cols =
      "full_name,title,company,email,phone,linkedin_url,stage,created_at,updated_at";
    const url = `${API_BASE}/api/v1/leads/export.csv?columns=${encodeURIComponent(
      cols
    )}`;
    fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Workspace-Id": ws || "",
      },
    })
      .then((r) => r.blob())
      .then((blob) => {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = "pipeline.csv";
        a.click();
      });
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-slate-200 bg-white px-4 py-3">
        <h1 className="text-lg font-semibold">Pipeline</h1>
        <div className="ml-2 flex overflow-hidden rounded-md border border-slate-200">
          <button
            onClick={() => setView("list")}
            className={`px-2 py-1 text-sm ${
              view === "list"
                ? "bg-brand-50 text-brand-700"
                : "text-slate-500 hover:bg-slate-50"
            }`}
            title="List view"
          >
            <List className="h-4 w-4" />
          </button>
          <button
            onClick={() => setView("board")}
            className={`px-2 py-1 text-sm ${
              view === "board"
                ? "bg-brand-50 text-brand-700"
                : "text-slate-500 hover:bg-slate-50"
            }`}
            title="Board view"
          >
            <Columns3 className="h-4 w-4" />
          </button>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <button className="btn-secondary" onClick={exportCsv}>
            <Download className="h-4 w-4" /> Export
          </button>
          <button className="btn-secondary">
            <Plus className="h-4 w-4" /> Add stage
          </button>
        </div>
      </div>

      {/* Stage filter chips */}
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 bg-white px-4 py-2">
        <StageChip
          label="All"
          count={leads?.items.length ?? 0}
          active={stageFilter === null}
          onClick={() => setStageFilter(null)}
        />
        {stages?.map((s) => (
          <StageChip
            key={s.id}
            label={s.name}
            count={countsByStage.get(s.id) || 0}
            color={s.color}
            active={stageFilter === s.id}
            onClick={() =>
              setStageFilter(stageFilter === s.id ? null : s.id)
            }
          />
        ))}
      </div>

      {/* Toolbar row */}
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 bg-white px-4 py-2 text-sm">
        <button
          className="inline-flex items-center gap-1 text-brand-600 hover:underline"
          title="Save current filters as a view (coming soon)"
          onClick={() => alert("Saved views coming soon.")}
        >
          <Bookmark className="h-4 w-4" /> Save View
        </button>

        <Divider />

        <Dropdown
          label="Stage"
          value={stages?.find((s) => s.id === stageFilter)?.name || "--"}
        >
          <DDItem onClick={() => setStageFilter(null)}>All</DDItem>
          {stages?.map((s) => (
            <DDItem key={s.id} onClick={() => setStageFilter(s.id)}>
              {s.name}
            </DDItem>
          ))}
        </Dropdown>

        <Dropdown label="Segment" value="--" disabled>
          <DDItem disabled>Coming Soon</DDItem>
        </Dropdown>

        <Dropdown label="No Activity For" value="--" disabled>
          <DDItem disabled>Coming Soon</DDItem>
        </Dropdown>

        <Dropdown
          label="Owner"
          value={ownerFilter === "me" ? "Me" : "Anyone"}
        >
          <DDItem onClick={() => setOwnerFilter("any")}>Anyone</DDItem>
          <DDItem onClick={() => setOwnerFilter("me")}>Me</DDItem>
        </Dropdown>

        <Dropdown label="Sort" value={SORT_OPTIONS[sortIdx].label}>
          {SORT_OPTIONS.map((o, i) => (
            <DDItem key={i} onClick={() => setSortIdx(i)}>
              {o.label}
            </DDItem>
          ))}
        </Dropdown>

        <span className="ml-auto text-xs text-slate-500">
          {filteredLeads.length} of {leads?.items.length ?? 0}
        </span>
        <OverflowMenu onExport={exportCsv} />
      </div>

      {/* Body */}
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
                <th className="px-3 py-2 text-left">Stage</th>
                <th className="px-3 py-2 text-left">Owner</th>
                <th className="px-3 py-2 text-left">Date Created</th>
                <th className="px-3 py-2 text-left">Last Updated</th>
              </tr>
            </thead>
            <tbody>
              {filteredLeads.map((lead) => {
                const stage = stages?.find((s) => s.id === lead.stage_id);
                return (
                  <tr
                    key={lead.id}
                    className="group border-b border-slate-100 hover:bg-slate-50"
                  >
                    <td className="px-3 py-2 text-sm">
                      <div className="flex items-center gap-2">
                        <Link
                          href={`/leads/${lead.id}`}
                          className="flex items-center gap-2 hover:text-brand-700"
                        >
                          <div className="grid h-7 w-7 place-items-center rounded-full bg-slate-200 text-[10px] font-semibold uppercase">
                            {initials(lead.full_name)}
                          </div>
                          <div>
                            <div className="font-medium hover:underline">
                              {lead.full_name || "—"}
                            </div>
                            <div className="text-xs text-slate-500">
                              {fmtDate(lead.close_date) || "$--"}
                            </div>
                          </div>
                        </Link>
                        <RowActions lead={lead} />
                      </div>
                    </td>
                    <td className="px-3 py-2 text-sm text-slate-700">
                      {lead.title || "—"}
                    </td>
                    <td className="px-3 py-2 text-sm text-slate-700">
                      {lead.company?.name || "—"}
                    </td>
                    <td className="px-3 py-2 text-sm text-slate-700">
                      {lead.email ? (
                        <a
                          href={`mailto:${lead.email}`}
                          className="text-brand-600 hover:underline"
                        >
                          {lead.email}
                        </a>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="px-3 py-2 text-sm text-slate-700">
                      {lead.phone || "—"}
                    </td>
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
                    <td className="px-3 py-2 text-sm text-slate-700">
                      {lead.location || "—"}
                    </td>
                    <td className="px-3 py-2 text-sm">
                      <span
                        className="pill"
                        style={{
                          backgroundColor: (stage?.color || "#e2e8f0") + "22",
                          color: stage?.color || "#475569",
                        }}
                      >
                        {stage?.name || "—"}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-sm text-slate-700">
                      {lead.owner_id ? "You" : "—"}
                    </td>
                    <td className="px-3 py-2 text-sm text-slate-700">
                      {fmtDate(lead.created_at)}
                    </td>
                    <td className="px-3 py-2 text-sm text-slate-700">
                      {fmtDate(lead.updated_at)}
                    </td>
                  </tr>
                );
              })}
              {filteredLeads.length === 0 && (
                <tr>
                  <td colSpan={11} className="px-3 py-10 text-center text-sm text-slate-400">
                    No leads match these filters.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function StageChip({
  label,
  count,
  color,
  active,
  onClick,
}: {
  label: string;
  count: number;
  color?: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-md border px-3 py-1 text-sm transition-colors ${
        active
          ? "border-brand-500 bg-brand-50 text-brand-700"
          : "border-slate-200 bg-white text-slate-700 hover:border-slate-300"
      }`}
    >
      {color && (
        <span
          className="h-2 w-2 rounded-full"
          style={{ background: color }}
        />
      )}
      <span>{label}</span>
      <span
        className={`rounded px-1.5 py-0.5 text-xs ${
          active ? "bg-brand-100 text-brand-700" : "bg-slate-100 text-slate-500"
        }`}
      >
        {count}
      </span>
    </button>
  );
}

function Divider() {
  return <span className="mx-1 h-5 w-px bg-slate-200" />;
}

function Dropdown({
  label,
  value,
  disabled,
  children,
}: {
  label: string;
  value: string;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => !disabled && setOpen((v) => !v)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        className={`inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2.5 py-1 text-sm ${
          disabled
            ? "cursor-not-allowed opacity-50"
            : "hover:border-slate-300"
        }`}
      >
        <span className="text-slate-500">{label}:</span>
        <span className="text-slate-700">{value}</span>
        <ChevronDown className="h-3.5 w-3.5 text-slate-400" />
      </button>
      {open && (
        <div className="absolute left-0 top-full z-30 mt-1 min-w-[180px] rounded-md border border-slate-200 bg-white py-1 shadow-card">
          {children}
        </div>
      )}
    </div>
  );
}

function DDItem({
  children,
  onClick,
  disabled,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onMouseDown={onClick}
      className={`block w-full px-3 py-1.5 text-left text-sm ${
        disabled
          ? "cursor-not-allowed text-slate-400"
          : "text-slate-700 hover:bg-slate-50"
      }`}
    >
      {children}
    </button>
  );
}

function OverflowMenu({ onExport }: { onExport: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        className="action-icon"
        title="More"
      >
        <MoreHorizontal className="h-4 w-4" />
      </button>
      {open && (
        <div className="absolute right-0 top-full z-30 mt-1 min-w-[160px] rounded-md border border-slate-200 bg-white py-1 shadow-card">
          <DDItem onClick={onExport}>Export to CSV</DDItem>
          <DDItem disabled>Bulk delete</DDItem>
          <DDItem disabled>Bulk enroll</DDItem>
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
      className={`flex w-72 shrink-0 flex-col rounded-lg border ${
        isOver
          ? "border-brand-400 bg-brand-50"
          : "border-slate-200 bg-slate-50"
      }`}
    >
      <div className="flex items-center justify-between border-b border-slate-200 px-3 py-2">
        <div className="flex items-center gap-2">
          <span
            className="h-2 w-2 rounded-full"
            style={{ background: stage.color }}
          />
          <span className="text-sm font-semibold">{stage.name}</span>
        </div>
        <span className="rounded bg-white px-1.5 py-0.5 text-xs text-slate-500">
          {leads.length}
        </span>
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
  const { attributes, listeners, setNodeRef, transform, isDragging } =
    useDraggable({ id: lead.id });
  const style: React.CSSProperties = transform
    ? {
        transform: `translate(${transform.x}px, ${transform.y}px)`,
        opacity: isDragging ? 0.6 : 1,
      }
    : {};
  return (
    <Link
      href={`/leads/${lead.id}`}
      ref={setNodeRef as never}
      style={style}
      {...listeners}
      {...attributes}
      className="block cursor-grab rounded-md border border-slate-200 bg-white p-2 shadow-soft hover:shadow-card"
    >
      <div className="flex items-center gap-2">
        <div className="grid h-7 w-7 place-items-center rounded-full bg-slate-200 text-[10px] font-semibold uppercase">
          {initials(lead.full_name)}
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">
            {lead.full_name || "—"}
          </div>
          <div className="truncate text-xs text-slate-500">
            {lead.title || lead.company?.name || ""}
          </div>
        </div>
      </div>
      <div className="mt-1.5 flex items-center justify-between text-xs text-slate-500">
        <span>{fmtDate(lead.close_date) || "—"}</span>
        <span>{fmtMoney(lead.estimated_value)}</span>
      </div>
    </Link>
  );
}

function RowActions({ lead }: { lead: Lead }) {
  const [enrolling, setEnrolling] = useState(false);
  return (
    <div className="ml-auto hidden items-center gap-1 group-hover:flex">
      <button
        type="button"
        onClick={() => setEnrolling(true)}
        className="action-icon"
        title={`Add ${lead.full_name || "lead"} to a Playbook`}
      >
        <Send className="h-3.5 w-3.5" />
      </button>
      {enrolling && (
        <EnrollPlaybookModal
          leadId={lead.id}
          leadName={lead.full_name}
          onClose={() => setEnrolling(false)}
        />
      )}
      {lead.email ? (
        <Link
          href={`/leads/${lead.id}?tab=email`}
          className="action-icon"
          title={`Email ${lead.full_name || ""}`.trim()}
        >
          <Mail className="h-3.5 w-3.5" />
        </Link>
      ) : (
        <span className="action-icon opacity-40" title="No email">
          <Mail className="h-3.5 w-3.5" />
        </span>
      )}
      {lead.phone ? (
        <a
          href={`tel:${lead.phone}`}
          className="action-icon"
          title={`Call ${lead.phone}`}
        >
          <Phone className="h-3.5 w-3.5" />
        </a>
      ) : (
        <span className="action-icon opacity-40" title="No phone">
          <Phone className="h-3.5 w-3.5" />
        </span>
      )}
      {lead.linkedin_url ? (
        <a
          href={lead.linkedin_url}
          target="_blank"
          rel="noopener noreferrer"
          className="action-icon"
          title="Open LinkedIn profile"
        >
          <Linkedin className="h-3.5 w-3.5" />
        </a>
      ) : (
        <span className="action-icon opacity-40" title="No LinkedIn URL">
          <Linkedin className="h-3.5 w-3.5" />
        </span>
      )}
    </div>
  );
}
