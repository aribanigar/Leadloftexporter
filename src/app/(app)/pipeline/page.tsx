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
  Loader2,
} from "lucide-react";
import {
  DndContext,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
  useDraggable,
  type DragEndEvent,
} from "@dnd-kit/core";
import Link from "next/link";
import { api, apiBase, getToken, getWorkspaceId } from "@/lib/api";
import type { Lead, LeadList, PipelineStage } from "@/lib/types";
import { fmtDate, fmtMoney, initials } from "@/lib/utils";
import { EnrollPlaybookModal } from "@/components/enroll-playbook-modal";
import { BulkActionsBar } from "@/components/bulk-actions-bar";

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

const LEAD_FIELDS = [
  "full_name", "title", "company", "email", "phone",
  "linkedin_url", "stage", "created_at", "updated_at",
];

export default function PipelinePage() {
  const qc = useQueryClient();
  const [view, setView] = useState<"board" | "list">("list");
  const [stageFilter, setStageFilter] = useState<string | null>(null);
  const [ownerFilter, setOwnerFilter] = useState<"any" | "me">("any");
  const [sortIdx, setSortIdx] = useState(0);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const { data: stages, isLoading: stagesLoading } = useQuery<PipelineStage[]>({
    queryKey: ["stages"],
    queryFn: () => api("/pipeline/stages"),
    refetchInterval: 15000,
    refetchOnWindowFocus: true,
  });

  const { data: leads, isLoading: leadsLoading, isError: leadsError, refetch: refetchLeads } = useQuery<LeadList>({
    queryKey: ["leads", "pipeline"],
    // Fetch ALL leads, not just the first 200 — Pipeline has no pagination
    // UI, so a hard cap silently hid leads beyond row 200. We grab page 1 at
    // the backend max (500), then if `total` is larger we fan out the
    // remaining pages in parallel and concatenate. Same LeadList shape
    // comes back so nothing downstream changes.
    //
    // Scale hardening (designed for workspaces with 1 000–10 000 leads):
    //  • Hard cap of 20 pages (= 10 000 leads) so a misreported `total`
    //    can't spawn runaway fetches.
    //  • Promise.allSettled (not all) — if one paged request fails, we
    //    return what we got rather than blowing up the whole table.
    //  • In-flight micro-cache (5s) below — the heavier this fetch gets,
    //    the more wasteful 8 s polling becomes. Slow the heartbeat to 60 s;
    //    mutations (stage change, lead create/delete) already invalidate
    //    the cache explicitly so the UI stays fresh on user action, and
    //    refetchOnWindowFocus brings it up to date when you return to the
    //    tab. Net: ~3-5× less API traffic at 1 000 leads, ~10× less at
    //    5 000, with no perceived staleness in practice.
    queryFn: async () => {
      const PAGE_SIZE = 500;          // backend allows ge=1 le=500
      const MAX_PAGES = 20;           // 20 × 500 = 10 000-row safety ceiling
      const qs = (p: number) =>
        `/leads?page=${p}&page_size=${PAGE_SIZE}&sort=created_at&direction=desc`;
      const first = (await api(qs(1))) as LeadList;
      const total = first.total ?? first.items.length;
      if (total <= first.items.length) return first;
      const pagesNeeded = Math.min(MAX_PAGES, Math.ceil(total / PAGE_SIZE));
      if (pagesNeeded <= 1) return first;
      const settled = await Promise.allSettled(
        Array.from({ length: pagesNeeded - 1 }, (_, i) =>
          api(qs(i + 2)) as Promise<LeadList>
        )
      );
      const rest = settled
        .filter((r): r is PromiseFulfilledResult<LeadList> => r.status === "fulfilled")
        .map((r) => r.value);
      const items = first.items.concat(...rest.map((r) => r.items));
      return { items, total, page: 1, page_size: items.length };
    },
    refetchInterval: 60_000,          // was 8s — too aggressive once page-fan grows
    refetchOnWindowFocus: true,       // back-to-tab still refreshes
    retry: 2,
    staleTime: 5_000,                 // avoid hammering on rapid re-renders
  });

  const loading = stagesLoading || leadsLoading;

  const updateStage = useMutation({
    mutationFn: ({ id, stage_id }: { id: string; stage_id: string }) =>
      api(`/leads/${id}`, { method: "PATCH", body: { stage_id } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["leads"] });
      qc.invalidateQueries({ queryKey: ["stages"] });
      refetchLeads();
    },
  });

  const addStage = useMutation({
    mutationFn: (name: string) =>
      api("/pipeline/stages", {
        method: "POST",
        body: { name, color: "#64748b", is_won: false, is_lost: false },
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["stages"] }),
  });

  const saveView = useMutation({
    mutationFn: (name: string) =>
      api("/workspaces/current/views", {
        method: "POST",
        body: {
          name,
          filters: { stage_id: stageFilter || undefined, owner: ownerFilter },
          sort: { field: SORT_OPTIONS[sortIdx].key, dir: SORT_OPTIONS[sortIdx].dir },
        },
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["saved-views"] }),
  });

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } })
  );

  const firstStageId = stages?.[0]?.id;
  // O(1) stage lookups. Previously every lead did stages.some(...) / stages.find(...)
  // — an O(stages) scan per row, run for thousands of rows on every render and in
  // each memo. With a Map + Set it's a constant-time lookup, which is the dominant
  // per-render cost on a large pipeline.
  const stageById = useMemo(() => {
    const m = new Map<string, PipelineStage>();
    stages?.forEach((s) => m.set(s.id, s));
    return m;
  }, [stages]);
  const stageOf = (l: Lead): string | undefined =>
    l.stage_id && stageById.has(l.stage_id) ? l.stage_id : firstStageId;

  const countsByStage = useMemo(() => {
    const m = new Map<string, number>();
    leads?.items.forEach((l) => {
      const sid = stageOf(l);
      if (!sid) return;
      m.set(sid, (m.get(sid) || 0) + 1);
    });
    return m;
  }, [leads, stages]);

  const grouped = useMemo(() => {
    const map = new Map<string, Lead[]>();
    stages?.forEach((s) => map.set(s.id, []));
    leads?.items.forEach((l) => {
      const sid = stageOf(l);
      if (sid && map.has(sid)) map.get(sid)!.push(l);
    });
    return map;
  }, [stages, leads]);

  const filteredLeads = useMemo(() => {
    const sort = SORT_OPTIONS[sortIdx];
    let list = leads?.items ?? [];
    if (stageFilter) list = list.filter((l) => stageOf(l) === stageFilter);
    if (ownerFilter === "me") list = list.filter((l) => l.owner_id);
    list = [...list].sort((a, b) => {
      const av = (a[sort.key] as string | null | undefined) ?? "";
      const bv = (b[sort.key] as string | null | undefined) ?? "";
      if (av === bv) return 0;
      const cmp = av < bv ? -1 : 1;
      return sort.dir === "asc" ? cmp : -cmp;
    });
    return list;
  }, [leads, stages, stageFilter, ownerFilter, sortIdx]);

  const leadsById = useMemo(() => {
    const m = new Map<string, Lead>();
    (leads?.items ?? []).forEach((l) => m.set(l.id, l));
    return m;
  }, [leads]);

  const allFilteredIds = useMemo(() => filteredLeads.map((l) => l.id), [filteredLeads]);
  const allSelected =
    allFilteredIds.length > 0 && allFilteredIds.every((id) => selectedIds.has(id));

  function toggleSelectAll() {
    if (allSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(allFilteredIds));
    }
  }

  function toggleRow(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

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
    const url = `${apiBase()}/api/v1/leads/export.csv?columns=${encodeURIComponent(LEAD_FIELDS.join(","))}`;
    fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Workspace-Id": ws || "",
      },
    })
      .then((r) => {
        if (!r.ok) throw new Error(`Export failed (${r.status})`);
        return r.blob();
      })
      .then((blob) => {
        const href = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = href;
        a.download = "pipeline.csv";
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(href);
      })
      .catch((err) => window.alert(err instanceof Error ? err.message : "Export failed"));
  }

  const selectedArr = Array.from(selectedIds);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header */}
      <div className="flex shrink-0 items-center gap-2 border-b border-slate-200 bg-white px-5 py-3">
        <h1 className="text-lg font-semibold text-slate-800">Pipeline</h1>
        <div className="ml-2 flex overflow-hidden rounded-md border border-slate-200">
          <button
            onClick={() => setView("list")}
            className={`px-2 py-1 text-sm ${
              view === "list" ? "bg-brand-50 text-brand-700" : "text-slate-500 hover:bg-slate-50"
            }`}
            title="List view"
          >
            <List className="h-4 w-4" />
          </button>
          <button
            onClick={() => setView("board")}
            className={`border-l border-slate-200 px-2 py-1 text-sm ${
              view === "board" ? "bg-brand-50 text-brand-700" : "text-slate-500 hover:bg-slate-50"
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
          <button
            className="btn-secondary disabled:opacity-50"
            disabled={addStage.isPending}
            onClick={() => {
              const name = window.prompt("New stage name:");
              if (name?.trim()) addStage.mutate(name.trim());
            }}
          >
            {addStage.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Plus className="h-4 w-4" />
            )}
            {addStage.isPending ? "Adding…" : "Add stage"}
          </button>
        </div>
      </div>

      {/* Stage filter chips */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-slate-200 bg-white px-5 py-2">
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
            onClick={() => setStageFilter(stageFilter === s.id ? null : s.id)}
          />
        ))}
      </div>

      {/* Toolbar */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-slate-200 bg-white px-5 py-2 text-sm">
        <button
          className="inline-flex items-center gap-1 text-brand-600 hover:underline disabled:opacity-50"
          disabled={saveView.isPending}
          onClick={() => {
            const name = window.prompt("Name this view:");
            if (name?.trim()) saveView.mutate(name.trim());
          }}
        >
          <Bookmark className="h-4 w-4" />
          {saveView.isPending ? "Saving…" : "Save View"}
        </button>

        <span className="h-4 w-px bg-slate-200" />

        <Dropdown
          label="Stage"
          value={stages?.find((s) => s.id === stageFilter)?.name || "All"}
        >
          <DDItem onClick={() => setStageFilter(null)}>All</DDItem>
          {stages?.map((s) => (
            <DDItem key={s.id} onClick={() => setStageFilter(s.id)}>
              {s.name}
            </DDItem>
          ))}
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

        <span className="ml-auto flex items-center gap-2 text-xs text-slate-500">
          {loading && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {filteredLeads.length} of {leads?.total ?? 0} leads
        </span>
        <OverflowMenu onExport={exportCsv} />
      </div>

      {/* Body */}
      {view === "board" ? (
        <DndContext sensors={sensors} onDragEnd={onDragEnd}>
          <div className="flex flex-1 gap-3 overflow-x-auto overflow-y-hidden p-4">
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
        <div className="flex-1 overflow-auto">
          {loading && filteredLeads.length === 0 ? (
            <div className="flex items-center justify-center gap-2 py-20 text-sm text-slate-400">
              <Loader2 className="h-5 w-5 animate-spin" />
              Loading leads…
            </div>
          ) : (
            <table className="min-w-full border-collapse">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50">
                  <th className="w-10 px-3 py-3 text-left">
                    <input
                      type="checkbox"
                      className="rounded border-slate-300"
                      checked={allSelected}
                      onChange={toggleSelectAll}
                    />
                  </th>
                  <th className="px-3 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                    Name
                  </th>
                  <th className="px-3 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                    Title
                  </th>
                  <th className="px-3 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                    Company
                  </th>
                  <th className="px-3 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                    Email
                  </th>
                  <th className="px-3 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                    Phone
                  </th>
                  <th className="px-3 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                    Stage
                  </th>
                  <th className="px-3 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                    Location
                  </th>
                  <th className="px-3 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                    Added
                  </th>
                  <th className="px-3 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 bg-white">
                {filteredLeads.map((lead) => {
                  const stage = lead.stage_id ? stageById.get(lead.stage_id) : undefined;
                  const selected = selectedIds.has(lead.id);
                  return (
                    <tr
                      key={lead.id}
                      className={`group transition-colors ${
                        selected ? "bg-brand-50" : "hover:bg-slate-50"
                      }`}
                    >
                      <td className="w-10 px-3 py-3">
                        <input
                          type="checkbox"
                          className="rounded border-slate-300"
                          checked={selected}
                          onChange={() => toggleRow(lead.id)}
                        />
                      </td>
                      <td className="px-3 py-3">
                        <Link
                          href={`/leads/${lead.id}`}
                          className="flex items-center gap-2.5 hover:text-brand-700"
                        >
                          <div className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-slate-200 text-[11px] font-bold uppercase text-slate-600">
                            {initials(lead.full_name)}
                          </div>
                          <div>
                            <div className="font-medium text-slate-800 hover:underline">
                              {lead.full_name || "—"}
                            </div>
                            {lead.close_date && (
                              <div className="text-xs text-slate-400">
                                {fmtDate(lead.close_date)}
                              </div>
                            )}
                          </div>
                        </Link>
                      </td>
                      <td className="px-3 py-3 text-sm text-slate-600">
                        {lead.title || <span className="text-slate-300">—</span>}
                      </td>
                      <td className="px-3 py-3 text-sm text-slate-600">
                        {lead.company?.name || <span className="text-slate-300">—</span>}
                      </td>
                      <td className="px-3 py-3 text-sm">
                        {lead.email ? (
                          <a
                            href={`mailto:${lead.email}`}
                            className="text-brand-600 hover:underline"
                          >
                            {lead.email}
                          </a>
                        ) : (
                          <span className="text-slate-300">—</span>
                        )}
                      </td>
                      <td className="px-3 py-3 text-sm text-slate-600">
                        {lead.phone || <span className="text-slate-300">—</span>}
                      </td>
                      <td className="px-3 py-3">
                        {stage ? (
                          <span
                            className="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium"
                            style={{
                              backgroundColor: (stage.color || "#e2e8f0") + "22",
                              color: stage.color || "#475569",
                              border: `1px solid ${stage.color || "#e2e8f0"}44`,
                            }}
                          >
                            {stage.name}
                          </span>
                        ) : (
                          <span className="text-xs text-slate-300">—</span>
                        )}
                      </td>
                      <td className="px-3 py-3 text-sm text-slate-500">
                        {lead.location || <span className="text-slate-300">—</span>}
                      </td>
                      <td className="px-3 py-3 text-xs text-slate-400">
                        {fmtDate(lead.created_at)}
                      </td>
                      <td className="px-3 py-3">
                        <RowActions lead={lead} />
                      </td>
                    </tr>
                  );
                })}
                {!loading && filteredLeads.length === 0 && (
                  <tr>
                    <td colSpan={10} className="px-4 py-16 text-center text-sm text-slate-400">
                      {leadsError ? (
                        <span>
                          Could not load leads.{" "}
                          <button
                            className="text-brand-600 underline hover:text-brand-800"
                            onClick={() => refetchLeads()}
                          >
                            Retry
                          </button>
                        </span>
                      ) : leads?.items.length ? (
                        "No leads match the current filters."
                      ) : (
                        "No leads yet. Capture them from LinkedIn using the extension, or import a CSV from Settings."
                      )}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          )}
        </div>
      )}

      {selectedArr.length > 0 && (
        <BulkActionsBar
          selectedIds={selectedArr}
          leadsById={leadsById}
          stages={stages ?? []}
          onClear={() => setSelectedIds(new Set())}
        />
      )}
    </div>
  );
}

function StageChip({
  label, count, color, active, onClick,
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
      className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm font-medium transition-colors ${
        active
          ? "border-brand-500 bg-brand-50 text-brand-700"
          : "border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:bg-slate-50"
      }`}
    >
      {color && (
        <span className="h-2 w-2 rounded-full" style={{ background: color }} />
      )}
      <span>{label}</span>
      <span
        className={`rounded-full px-1.5 py-0.5 text-xs ${
          active ? "bg-brand-100 text-brand-700" : "bg-slate-100 text-slate-500"
        }`}
      >
        {count}
      </span>
    </button>
  );
}

function Dropdown({
  label, value, disabled, children,
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
          disabled ? "cursor-not-allowed opacity-50" : "hover:border-slate-300"
        }`}
      >
        <span className="text-slate-400">{label}:</span>
        <span className="font-medium text-slate-700">{value}</span>
        <ChevronDown className="h-3.5 w-3.5 text-slate-400" />
      </button>
      {open && (
        <div className="absolute left-0 top-full z-30 mt-1 min-w-[180px] rounded-lg border border-slate-200 bg-white py-1 shadow-lg">
          {children}
        </div>
      )}
    </div>
  );
}

function DDItem({
  children, onClick, disabled,
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
        disabled ? "cursor-not-allowed text-slate-400" : "text-slate-700 hover:bg-slate-50"
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
        <div className="absolute right-0 top-full z-30 mt-1 min-w-[160px] rounded-lg border border-slate-200 bg-white py-1 shadow-lg">
          <DDItem onClick={onExport}>Export to CSV</DDItem>
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
      className={`flex w-72 shrink-0 flex-col rounded-xl border ${
        isOver ? "border-brand-400 bg-brand-50" : "border-slate-200 bg-slate-50"
      }`}
    >
      <div className="flex items-center justify-between border-b border-slate-200 px-3 py-2.5">
        <div className="flex items-center gap-2">
          <span className="h-2.5 w-2.5 rounded-full" style={{ background: stage.color }} />
          <span className="text-sm font-semibold text-slate-700">{stage.name}</span>
        </div>
        <span className="rounded-full bg-white px-2 py-0.5 text-xs font-medium text-slate-500 shadow-soft">
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

function LeadCard({ lead }: { lead: Lead }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: lead.id,
  });
  const style: React.CSSProperties = transform
    ? { transform: `translate(${transform.x}px, ${transform.y}px)`, opacity: isDragging ? 0.5 : 1 }
    : {};
  return (
    <Link
      href={`/leads/${lead.id}`}
      ref={setNodeRef as never}
      style={style}
      {...listeners}
      {...attributes}
      className="block cursor-grab rounded-lg border border-slate-200 bg-white p-3 shadow-soft hover:border-brand-300 hover:shadow-card active:cursor-grabbing"
    >
      <div className="flex items-center gap-2">
        <div className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-slate-200 text-[10px] font-bold uppercase text-slate-600">
          {initials(lead.full_name)}
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-slate-800">
            {lead.full_name || "—"}
          </div>
          <div className="truncate text-xs text-slate-500">
            {lead.title || lead.company?.name || ""}
          </div>
        </div>
      </div>
      {(lead.close_date || lead.estimated_value) && (
        <div className="mt-2 flex items-center justify-between text-xs text-slate-400">
          <span>{fmtDate(lead.close_date) || "—"}</span>
          <span>{fmtMoney(lead.estimated_value)}</span>
        </div>
      )}
    </Link>
  );
}

function RowActions({ lead }: { lead: Lead }) {
  const [enrolling, setEnrolling] = useState(false);
  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        onClick={() => setEnrolling(true)}
        className="action-icon"
        title={`Add ${lead.full_name || "lead"} to Playbook`}
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
          title="Send email"
        >
          <Mail className="h-3.5 w-3.5" />
        </Link>
      ) : (
        <span className="action-icon opacity-30">
          <Mail className="h-3.5 w-3.5" />
        </span>
      )}
      {lead.phone ? (
        <a href={`tel:${lead.phone}`} className="action-icon" title={`Call ${lead.phone}`}>
          <Phone className="h-3.5 w-3.5" />
        </a>
      ) : (
        <span className="action-icon opacity-30">
          <Phone className="h-3.5 w-3.5" />
        </span>
      )}
      {lead.linkedin_url ? (
        <a
          href={lead.linkedin_url}
          target="_blank"
          rel="noopener noreferrer"
          className="action-icon"
          title="Open LinkedIn"
        >
          <Linkedin className="h-3.5 w-3.5" />
        </a>
      ) : (
        <span className="action-icon opacity-30">
          <Linkedin className="h-3.5 w-3.5" />
        </span>
      )}
    </div>
  );
}
