"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Download, MoreHorizontal, Plus, Filter, Columns3, Search } from "lucide-react";
import { api, API_BASE, getToken, getWorkspaceId } from "@/lib/api";
import type { Lead, LeadField, LeadList, PipelineStage, SavedView } from "@/lib/types";
import Link from "next/link";
import { fmtDate, fmtMoney, initials } from "@/lib/utils";
import { CreateLeadModal } from "@/components/create-lead-modal";
import { ColumnPicker } from "@/components/column-picker";

const STAGE_COLORS: Record<string, string> = {
  new: "bg-sky-100 text-sky-700",
  responded: "bg-violet-100 text-violet-700",
  interested: "bg-cyan-100 text-cyan-700",
  proposal_sent: "bg-amber-100 text-amber-800",
  customer: "bg-emerald-100 text-emerald-700",
  not_ready_yet: "bg-slate-100 text-slate-600",
  not_interested: "bg-rose-100 text-rose-700",
};

export default function ProspectingPage() {
  const qc = useQueryClient();
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const [pickingColumns, setPickingColumns] = useState(false);

  const { data: stages } = useQuery<PipelineStage[]>({
    queryKey: ["stages"],
    queryFn: () => api("/pipeline/stages"),
  });
  const { data: fields } = useQuery<LeadField[]>({
    queryKey: ["fields"],
    queryFn: () => api("/settings/fields"),
  });
  const { data: views } = useQuery<SavedView[]>({
    queryKey: ["saved-views"],
    queryFn: () => api("/workspaces/current/views"),
  });
  const { data: leads, isLoading } = useQuery<LeadList>({
    queryKey: ["leads", page],
    queryFn: () => api(`/leads?page=${page}&page_size=50`),
  });

  const defaultCols = useMemo(
    () =>
      views?.[0]?.columns?.length
        ? views[0].columns
        : ["full_name", "title", "company", "email", "stage", "owner", "close_date"],
    [views]
  );
  const [columns, setColumns] = useState<string[] | null>(null);
  const visibleColumns = columns ?? defaultCols;

  const stageById = useMemo(() => {
    const m = new Map<string, PipelineStage>();
    stages?.forEach((s) => m.set(s.id, s));
    return m;
  }, [stages]);

  const removeLead = useMutation({
    mutationFn: (id: string) => api(`/leads/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["leads"] }),
  });

  function exportCsv() {
    const token = getToken();
    const ws = getWorkspaceId();
    const cols = visibleColumns.join(",");
    const url = `${API_BASE}/api/v1/leads/export.csv?columns=${encodeURIComponent(cols)}`;
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
        a.download = "leads.csv";
        a.click();
      });
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-slate-200 bg-white px-4 py-3">
        <h1 className="text-lg font-semibold">Prospecting</h1>
        <span className="rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-500">
          {leads?.total ?? 0} leads
        </span>
        <div className="ml-auto flex items-center gap-2">
          <button className="btn-secondary" onClick={() => setPickingColumns(true)}>
            <Columns3 className="h-4 w-4" /> Columns
          </button>
          <button className="btn-secondary">
            <Filter className="h-4 w-4" /> Filter
          </button>
          <button className="btn-secondary" onClick={exportCsv}>
            <Download className="h-4 w-4" /> Export
          </button>
          <button className="btn-primary" onClick={() => setCreating(true)}>
            <Plus className="h-4 w-4" /> Add Lead
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-auto">
        <table className="min-w-full">
          <thead className="sticky top-0 z-10 bg-slate-50/95 text-xs uppercase tracking-wide text-slate-500 backdrop-blur">
            <tr>
              <th className="w-10 px-3 py-2">
                <input type="checkbox" />
              </th>
              {visibleColumns.map((c) => (
                <th key={c} className="whitespace-nowrap px-3 py-2 text-left font-semibold">
                  {fields?.find((f) => f.key === c)?.label || c}
                </th>
              ))}
              <th className="w-10" />
            </tr>
          </thead>
          <tbody>
            {isLoading && (
              <tr>
                <td colSpan={visibleColumns.length + 2} className="p-6 text-center text-slate-400">
                  Loading…
                </td>
              </tr>
            )}
            {!isLoading && (leads?.items.length ?? 0) === 0 && (
              <tr>
                <td colSpan={visibleColumns.length + 2} className="p-10">
                  <div className="mx-auto flex max-w-md flex-col items-center text-center">
                    <div className="mb-4 grid h-14 w-14 place-items-center rounded-xl bg-brand-50 text-brand-600">
                      <Search className="h-7 w-7" />
                    </div>
                    <h3 className="text-base font-semibold text-slate-700">
                      Download the LeadCaptura Chrome extension to get started
                    </h3>
                    <p className="mt-1 text-sm text-slate-500">
                      Once installed, visit any LinkedIn profile and click{" "}
                      <strong>Save Lead</strong> — captured leads (with email,
                      phone, and address from the Contact info popup) appear
                      right here in real time.
                    </p>
                    <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
                      <Link
                        href="/settings/api-keys"
                        className="btn-primary"
                      >
                        Get my API key
                      </Link>
                      <Link
                        href="/settings/integrations"
                        className="btn-secondary"
                      >
                        Connect LinkedIn
                      </Link>
                      <button
                        type="button"
                        className="btn-ghost"
                        onClick={() => setCreating(true)}
                      >
                        Add lead manually
                      </button>
                    </div>
                  </div>
                </td>
              </tr>
            )}
            {leads?.items.map((lead) => (
              <tr key={lead.id} className="border-b border-slate-100 hover:bg-slate-50">
                <td className="w-10 px-3 py-2">
                  <input type="checkbox" />
                </td>
                {visibleColumns.map((c) => (
                  <td key={c} className="whitespace-nowrap px-3 py-2 text-sm">
                    {renderCell(c, lead, stageById)}
                  </td>
                ))}
                <td className="w-10 px-2">
                  <button
                    className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                    onClick={() => removeLead.mutate(lead.id)}
                    title="Delete"
                  >
                    <MoreHorizontal className="h-4 w-4" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between border-t border-slate-200 bg-white px-4 py-2 text-sm text-slate-600">
        <span>Page {leads?.page ?? 1}</span>
        <div className="flex gap-2">
          <button
            className="btn-secondary"
            disabled={page <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            Prev
          </button>
          <button
            className="btn-secondary"
            disabled={!leads || page * (leads.page_size || 50) >= (leads.total || 0)}
            onClick={() => setPage((p) => p + 1)}
          >
            Next
          </button>
        </div>
      </div>

      {creating && <CreateLeadModal onClose={() => setCreating(false)} stages={stages || []} />}
      {pickingColumns && fields && (
        <ColumnPicker
          fields={fields}
          selected={visibleColumns}
          onClose={() => setPickingColumns(false)}
          onSave={(cols) => {
            setColumns(cols);
            setPickingColumns(false);
          }}
        />
      )}
    </div>
  );
}

function renderCell(col: string, lead: Lead, stageById: Map<string, PipelineStage>): React.ReactNode {
  switch (col) {
    case "full_name":
      return (
        <Link
          href={`/leads/${lead.id}`}
          className="flex items-center gap-2 hover:text-brand-700"
        >
          <div className="grid h-7 w-7 place-items-center rounded-full bg-slate-200 text-[10px] font-semibold uppercase text-slate-600">
            {initials(lead.full_name || lead.email)}
          </div>
          <div className="flex flex-col leading-tight">
            <span className="font-medium text-slate-800 hover:text-brand-700 hover:underline">{lead.full_name || "—"}</span>
            {lead.headline && <span className="text-xs text-slate-500">{lead.headline}</span>}
          </div>
        </Link>
      );
    case "title":
      return <span className="text-slate-700">{lead.title || "—"}</span>;
    case "email":
      return <span className="text-slate-700">{lead.email || "—"}</span>;
    case "phone":
      return <span className="text-slate-700">{lead.phone || "—"}</span>;
    case "linkedin_url":
      return lead.linkedin_url ? (
        <a className="text-brand-600 hover:underline" href={lead.linkedin_url} target="_blank" rel="noreferrer">
          Profile
        </a>
      ) : (
        "—"
      );
    case "company":
      return <span className="text-slate-700">{lead.company?.name || "—"}</span>;
    case "stage": {
      const s = lead.stage_id ? stageById.get(lead.stage_id) : null;
      if (!s) return <span className="text-slate-400">—</span>;
      const cls = STAGE_COLORS[s.slug] || "bg-slate-100 text-slate-700";
      return <span className={`pill ${cls}`}>{s.name}</span>;
    }
    case "owner":
      return <span className="text-slate-700">{lead.owner_id ? "You" : "—"}</span>;
    case "close_date":
      return <span className="text-slate-700">{fmtDate(lead.close_date)}</span>;
    case "estimated_value":
      return <span className="text-slate-700">{fmtMoney(lead.estimated_value)}</span>;
    case "created_at":
      return <span className="text-slate-700">{fmtDate(lead.created_at)}</span>;
    case "updated_at":
      return <span className="text-slate-700">{fmtDate(lead.updated_at)}</span>;
    case "location":
      return <span className="text-slate-700">{lead.location || "—"}</span>;
    default: {
      const val = lead.custom?.[col];
      return <span className="text-slate-700">{val == null ? "—" : String(val)}</span>;
    }
  }
}
