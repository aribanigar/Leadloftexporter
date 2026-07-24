"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { Download, MoreHorizontal, Plus, Filter, Columns3, Search, Sparkles, Zap, Wrench, Bot } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { api, apiBase, getToken, getWorkspaceId } from "@/lib/api";
import type { Lead, LeadField, LeadList, PipelineStage, SavedView } from "@/lib/types";
import Link from "next/link";
import { fmtDate, fmtMoney, initials } from "@/lib/utils";
import { CreateLeadModal } from "@/components/create-lead-modal";
import { ColumnPicker } from "@/components/column-picker";
import { BulkActionsBar } from "@/components/bulk-actions-bar";

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
  const searchParams = useSearchParams();
  const viewId = searchParams.get("view");
  const q = (searchParams.get("q") || "").trim();
  const [page, setPage] = useState(1);
  const [stageFilter, setStageFilter] = useState<string>("");
  const [viewSegment, setViewSegment] = useState<string>("");
  const [viewMine, setViewMine] = useState<boolean>(false);
  const [viewNoActivityDays, setViewNoActivityDays] = useState<number | null>(null);
  const [viewStageSlugs, setViewStageSlugs] = useState<string[]>([]);
  const [showFilter, setShowFilter] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState(false);
  const [pickingColumns, setPickingColumns] = useState(false);
  const [findingEmails, setFindingEmails] = useState(false);
  const [findResult, setFindResult] = useState<string | null>(null);
  const [repairing, setRepairing] = useState(false);
  // Bulk-enrich progress state. `bulkEnrich.cancel` is a ref-stable
  // boolean toggled by the Cancel button so the in-flight loop can
  // bail between leads without an unmount.
  const [bulkEnrich, setBulkEnrich] = useState<{
    running: boolean;
    done: number;
    total: number;
    currentName: string;
  }>({ running: false, done: 0, total: 0, currentName: "" });
  const bulkCancelRef = useRef(false);

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
    queryKey: ["leads", page, stageFilter, q, viewSegment, viewMine, viewNoActivityDays, viewStageSlugs],
    queryFn: () => {
      const params = new URLSearchParams({ page: String(page), page_size: "50" });
      if (stageFilter) params.set("stage_id", stageFilter);
      if (q) params.set("q", q);
      if (viewSegment) params.set("segment", viewSegment);
      if (viewMine) params.set("mine", "true");
      if (viewNoActivityDays !== null) params.set("no_activity_days", String(viewNoActivityDays));
      viewStageSlugs.forEach((s) => params.append("stage_slug", s));
      return api(`/leads?${params.toString()}`);
    },
    refetchInterval: 15000,
    refetchOnWindowFocus: true,
  });

  // A Saved View opened from the sidebar ("/prospecting?view=<id>") applies its
  // saved stage filter + columns. Without this the Quick View links navigated
  // but changed nothing on the page.
  const activeView = useMemo(
    () => views?.find((v) => v.id === viewId) || null,
    [views, viewId]
  );
  const [columns, setColumns] = useState<string[] | null>(null);
  useEffect(() => {
    if (!activeView) {
      setStageFilter("");
      setViewSegment("");
      setViewMine(false);
      setViewNoActivityDays(null);
      setViewStageSlugs([]);
      return;
    }
    const f = activeView.filters || {};
    setStageFilter((f.stage_id as string) || "");
    setViewSegment((f.segment as string) || "");
    setViewMine(f.mine === true);
    setViewNoActivityDays(typeof f.no_activity_days === "number" ? (f.no_activity_days as number) : null);
    const slugs = f.stage_slug;
    setViewStageSlugs(Array.isArray(slugs) ? (slugs as string[]) : slugs ? [slugs as string] : []);
    setPage(1);
    if (activeView.columns?.length) setColumns(activeView.columns);
  }, [activeView]);

  useEffect(() => {
    setPage(1);
  }, [q]);

  const defaultCols = useMemo(
    () =>
      views?.[0]?.columns?.length
        ? views[0].columns
        : ["full_name", "title", "company", "email", "phone", "stage", "owner", "close_date"],
    [views]
  );
  const visibleColumns = columns ?? defaultCols;

  const stageById = useMemo(() => {
    const m = new Map<string, PipelineStage>();
    stages?.forEach((s) => m.set(s.id, s));
    return m;
  }, [stages]);

  const leadsById = useMemo(() => {
    const m = new Map<string, Lead>();
    leads?.items.forEach((l) => m.set(l.id, l));
    return m;
  }, [leads]);

  // Clear selection whenever the visible result set changes.
  useEffect(() => {
    setSelected(new Set());
  }, [page, stageFilter, q, viewSegment, viewMine, viewNoActivityDays, viewStageSlugs]);

  const pageIds = useMemo(() => (leads?.items || []).map((l) => l.id), [leads]);
  const allSelected = pageIds.length > 0 && pageIds.every((id) => selected.has(id));
  function toggleOne(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function toggleAll() {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allSelected) pageIds.forEach((id) => next.delete(id));
      else pageIds.forEach((id) => next.add(id));
      return next;
    });
  }

  const removeLead = useMutation({
    mutationFn: (id: string) => api(`/leads/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["leads"] }),
  });

  function exportCsv() {
    const token = getToken();
    const ws = getWorkspaceId();
    const cols = visibleColumns.join(",");
    const url = `${apiBase()}/api/v1/leads/export.csv?columns=${encodeURIComponent(cols)}`;
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
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 bg-white px-4 py-3">
        <h1 className="text-lg font-semibold">Prospecting</h1>
        <span className="rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-500">
          {leads?.total ?? 0} leads
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <button className="btn-secondary" onClick={() => setPickingColumns(true)}>
            <Columns3 className="h-4 w-4" /> Columns
          </button>
          <div className="relative">
            <button
              className="btn-secondary"
              onClick={() => setShowFilter((s) => !s)}
              title="Filter leads by stage"
            >
              <Filter className="h-4 w-4" /> Filter{stageFilter ? " (1)" : ""}
            </button>
            {showFilter && (
              <>
                <div
                  className="fixed inset-0 z-10"
                  onClick={() => setShowFilter(false)}
                />
                <div className="absolute right-0 z-20 mt-1 w-60 rounded-md border border-slate-200 bg-white p-3 shadow-lg">
                  <label className="label">Stage</label>
                  <select
                    className="input"
                    value={stageFilter}
                    onChange={(e) => {
                      setStageFilter(e.target.value);
                      setPage(1);
                    }}
                  >
                    <option value="">All stages</option>
                    {(stages || []).map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                  {stageFilter && (
                    <button
                      className="btn-ghost mt-2 w-full justify-center"
                      onClick={() => {
                        setStageFilter("");
                        setPage(1);
                        setShowFilter(false);
                      }}
                    >
                      Clear filter
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
          <button className="btn-secondary" onClick={exportCsv}>
            <Download className="h-4 w-4" /> Export
          </button>
          <button
            className="btn-secondary"
            disabled={findingEmails}
            onClick={async () => {
              setFindingEmails(true);
              setFindResult(null);
              try {
                const res = await api<{
                  processed: number;
                  verified: number;
                  risky: number;
                  unknown: number;
                  not_found: number;
                  remaining: number;
                }>("/leads/find-emails-bulk", {
                  method: "POST",
                  body: { limit: 25 },
                });
                const msg =
                  res.processed === 0
                    ? "All leads already have emails."
                    : `Found ${res.verified} verified${
                        res.risky ? `, ${res.risky} risky` : ""
                      } of ${res.processed} probed${
                        res.remaining ? ` · ${res.remaining} still pending` : ""
                      }`;
                setFindResult(msg);
                // Refresh the leads list so newly-enriched emails appear
                qc.invalidateQueries({ queryKey: ["leads"] });
              } catch (e: unknown) {
                setFindResult(
                  `Error: ${e instanceof Error ? e.message : String(e)}`
                );
              } finally {
                setFindingEmails(false);
              }
            }}
            title="Run the email finder (pattern cache → SMTP probe → Apollo) on the next 25 leads without an email"
          >
            <Sparkles className="h-4 w-4" />
            {findingEmails ? "Finding…" : "Find emails"}
          </button>
          <button
            className="btn-secondary"
            disabled={repairing}
            onClick={async () => {
              if (!confirm(
                "Scan all leads in this workspace and repair rows polluted by previous extension versions?\n\n" +
                "This fixes in place: corrupted LinkedIn URLs (/overlay/contact-info/ paths), names saved as \"LinkedIn\"/\"Save\"/\"Connect\", " +
                "headline/title fields containing UI-button text, and name+headline mashed strings.\n\n" +
                "Nothing is deleted — only fixed in place. Safe to run repeatedly."
              )) return;
              setRepairing(true);
              setFindResult(null);
              try {
                const res = await api<{
                  scanned: number;
                  urls_fixed: number;
                  names_fixed: number;
                  name_mash_fixed: number;
                  headlines_fixed: number;
                  titles_fixed: number;
                  total_rows_changed: number;
                }>("/leads/cleanup/repair-corrupted", { method: "POST" });
                setFindResult(
                  res.total_rows_changed === 0
                    ? `Scanned ${res.scanned} leads — no corruption found.`
                    : `Repaired ${res.total_rows_changed} rows of ${res.scanned} scanned · ` +
                      `${res.urls_fixed} URLs · ${res.names_fixed} names · ` +
                      `${res.name_mash_fixed} name-mash · ${res.headlines_fixed} headlines · ${res.titles_fixed} titles`
                );
                qc.invalidateQueries({ queryKey: ["leads"] });
              } catch (e: unknown) {
                setFindResult(`Error: ${e instanceof Error ? e.message : String(e)}`);
              } finally {
                setRepairing(false);
              }
            }}
            title="Repair leads polluted by previous extension versions (corrupted URLs, name='LinkedIn', UI-noise headlines, name/headline mashing)"
          >
            <Wrench className="h-4 w-4" />
            {repairing ? "Repairing…" : "Repair leads"}
          </button>
          <button
            className="btn-secondary"
            disabled={bulkEnrich.running}
            onClick={async () => {
              if (bulkEnrich.running) return;
              await startBulkEnrich({ qc, setBulkEnrich, bulkCancelRef, setFindResult });
            }}
            title="Walk through every lead missing email or phone, open the LinkedIn profile in a background tab, scrape Contact info, sync back. Human-paced 35–80 seconds between leads."
          >
            <Bot className="h-4 w-4" />
            {bulkEnrich.running
              ? `Enriching ${bulkEnrich.done}/${bulkEnrich.total}…`
              : "Bulk Enrich"}
          </button>
          {bulkEnrich.running && (
            <button
              className="btn-secondary"
              onClick={() => { bulkCancelRef.current = true; }}
              title="Stop after the current lead finishes"
            >
              Cancel
            </button>
          )}
          <button className="btn-primary" onClick={() => setCreating(true)}>
            <Plus className="h-4 w-4" /> Add Lead
          </button>
        </div>
      </div>
      {findResult && (
        <div className="mb-3 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">
          {findResult}
        </div>
      )}

      <div className="flex-1 overflow-auto">
        <table className="min-w-full">
          <thead className="sticky top-0 z-10 bg-slate-50/95 text-xs uppercase tracking-wide text-slate-500 backdrop-blur">
            <tr>
              <th className="w-10 px-3 py-1.5">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={toggleAll}
                  aria-label="Select all on this page"
                />
              </th>
              {visibleColumns.map((c) => (
                <th key={c} className="whitespace-nowrap px-3 py-1.5 text-left font-semibold">
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
            {leads?.items.map((lead) => {
              const needsEnrichment =
                !!lead.linkedin_url && (!lead.email || !lead.phone);
              return (
                <tr
                  key={lead.id}
                  className={`border-b border-slate-100 hover:bg-slate-50 ${selected.has(lead.id) ? "bg-brand-50/60" : ""}`}
                >
                  <td className="w-10 px-3 py-1.5">
                    <input
                      type="checkbox"
                      checked={selected.has(lead.id)}
                      onChange={() => toggleOne(lead.id)}
                      aria-label="Select lead"
                    />
                  </td>
                  {visibleColumns.map((c) => (
                    <td key={c} className="whitespace-nowrap px-3 py-1.5 text-sm">
                      {renderCell(c, lead, stageById)}
                    </td>
                  ))}
                  <td className="w-24 px-2">
                    <div className="flex items-center justify-end gap-1">
                      {needsEnrichment && (
                        <button
                          className="inline-flex items-center gap-1 rounded-md border border-brand-200 bg-brand-50 px-2 py-1 text-xs font-medium text-brand-700 hover:bg-brand-100"
                          onClick={() => enrichLead(lead, qc)}
                          title="Open LinkedIn profile and auto-scrape email, phone, and name from Contact info"
                        >
                          <Zap className="h-3 w-3" /> Enrich
                        </button>
                      )}
                      <button
                        className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                        onClick={() => removeLead.mutate(lead.id)}
                        title="Delete"
                      >
                        <MoreHorizontal className="h-4 w-4" />
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
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

      {selected.size > 0 && (
        <BulkActionsBar
          selectedIds={Array.from(selected)}
          leadsById={leadsById}
          stages={stages || []}
          onClear={() => setSelected(new Set())}
        />
      )}
    </div>
  );
}

// Trigger the extension's contact-info enrichment workflow on an existing
// lead. Opens the lead's LinkedIn URL in a new tab with ?lc_enrich=1; the
// extension's content script (main.js → maybeRunEnrichmentTrigger) detects
// the flag, auto-clicks Contact info, scrapes email/phone/name, syncs back
// to the matching lead (by linkedin_url), then closes the tab. We refresh
// the leads query after a short delay so the row picks up the new fields.
function enrichLead(lead: Lead, qc: ReturnType<typeof useQueryClient>) {
  if (!lead.linkedin_url) return;
  // Build the enrichment URL via URL() so we don't double-append the param
  // if the stored linkedin_url already contains a query string. Fall back to
  // naive concat only if the URL is malformed.
  let target: string;
  try {
    const u = new URL(lead.linkedin_url);
    u.searchParams.set("lc_enrich", "1");
    target = u.toString();
  } catch {
    const sep = lead.linkedin_url.includes("?") ? "&" : "?";
    target = `${lead.linkedin_url}${sep}lc_enrich=1`;
  }
  const win = window.open(target, "_blank", "noopener");
  if (!win) {
    // Popup blocked — surface a hint rather than silently failing.
    alert(
      "Please allow popups for this site so LeadCaptura can open the LinkedIn profile and run enrichment."
    );
    return;
  }
  // Refresh twice — early in case enrichment is fast, late as a safety net.
  setTimeout(() => qc.invalidateQueries({ queryKey: ["leads"] }), 12_000);
  setTimeout(() => qc.invalidateQueries({ queryKey: ["leads"] }), 25_000);
}

// Bulk Enrich — walk every lead in the workspace missing email or phone,
// open the LinkedIn profile in a background tab with ?lc_enrich=1, wait
// for the extension to scrape Contact info and sync back, then move to
// the next lead. Spacing is human-paced (35–80s typical, ~15% chance of
// a 90–180s "distracted user" pause) so it doesn't look like a bot to
// LinkedIn's behavioural anti-abuse. Cancellable mid-flight.
//
// Implementation choices:
//   - We pull leads via /leads/needs-enrichment (server filters for
//     linkedin_url IS NOT NULL AND (email IS NULL OR phone IS NULL)).
//     Sorting by date_created so newly-captured leads enrich first.
//   - window.open() is used because the extension can't be addressed
//     directly from a non-LinkedIn page (no externally_connectable in
//     manifest). The extension's main.js maybeRunEnrichmentTrigger()
//     detects ?lc_enrich=1, does the scrape, then asks its service
//     worker (lc:closeMe) to close the tab — so visible tabs flash
//     open for ~6–12s each then disappear.
//   - Popup blocker check on the first lead only; if it fires there
//     we abort the whole run with a clear error.
//   - Cancel button flips a ref that the loop polls between leads.
async function startBulkEnrich(opts: {
  qc: ReturnType<typeof useQueryClient>;
  setBulkEnrich: (s: {
    running: boolean;
    done: number;
    total: number;
    currentName: string;
  }) => void;
  bulkCancelRef: React.MutableRefObject<boolean>;
  setFindResult: (s: string | null) => void;
}) {
  const { qc, setBulkEnrich, bulkCancelRef, setFindResult } = opts;
  bulkCancelRef.current = false;
  setFindResult(null);

  // Fetch the candidate list from the backend.
  let candidates: Lead[] = [];
  try {
    const res = await api<{ items: Lead[] }>(
      "/leads/needs-enrichment?limit=500"
    );
    candidates = res.items.filter((l) => !!l.linkedin_url);
  } catch (e: unknown) {
    setFindResult(
      `Bulk Enrich failed: ${e instanceof Error ? e.message : String(e)}`
    );
    return;
  }

  if (candidates.length === 0) {
    setFindResult("All leads already have email and phone — nothing to enrich.");
    return;
  }

  // Confirm with the user — show count + estimated time before opening
  // dozens of tabs unexpectedly.
  const estMinLow = Math.round((candidates.length * 35) / 60);
  const estMinHigh = Math.round((candidates.length * 90) / 60);
  const proceed = confirm(
    `Bulk Enrich ${candidates.length} leads?\n\n` +
      `LeadCaptura will open each LinkedIn profile in a background tab one ` +
      `at a time, scrape Contact info, sync back, and close the tab. ` +
      `Human-paced 35–80 seconds between leads so it stays under LinkedIn's ` +
      `behavioural radar.\n\n` +
      `Estimated time: ~${estMinLow}–${estMinHigh} minutes. ` +
      `You can keep working in other tabs. Click Cancel here to stop, or ` +
      `click the Cancel button in the toolbar after starting.`
  );
  if (!proceed) return;

  setBulkEnrich({
    running: true,
    done: 0,
    total: candidates.length,
    currentName: "",
  });

  for (let i = 0; i < candidates.length; i++) {
    if (bulkCancelRef.current) break;
    const lead = candidates[i];
    setBulkEnrich({
      running: true,
      done: i,
      total: candidates.length,
      currentName: lead.full_name || lead.linkedin_url || "(unnamed)",
    });

    // Open the lead's URL with ?lc_enrich=1 — extension auto-runs scrape
    // and closes the tab when done.
    let target: string;
    try {
      const u = new URL(lead.linkedin_url!);
      u.searchParams.set("lc_enrich", "1");
      target = u.toString();
    } catch {
      const sep = lead.linkedin_url!.includes("?") ? "&" : "?";
      target = `${lead.linkedin_url}${sep}lc_enrich=1`;
    }
    const win = window.open(target, "_blank", "noopener");
    if (!win && i === 0) {
      alert(
        "Popup blocked. Allow popups for this site so Bulk Enrich can open LinkedIn profiles in background tabs."
      );
      setBulkEnrich({ running: false, done: 0, total: 0, currentName: "" });
      return;
    }

    // Refresh the leads list mid-run so the user sees progress.
    setTimeout(() => qc.invalidateQueries({ queryKey: ["leads"] }), 15_000);

    // Skip the wait after the last lead.
    if (i < candidates.length - 1) {
      // Human-paced gap: 35–80s, ~15% chance of a 90–180s long-tail
      // (mimics "user got distracted by another tab").
      const base = 35_000 + Math.random() * 45_000;
      const longTail =
        Math.random() < 0.15 ? 90_000 + Math.random() * 90_000 : 0;
      const totalWait = base + longTail;
      // Poll the cancel flag every second so the user doesn't wait
      // 80s after clicking Cancel.
      const waitStart = Date.now();
      while (Date.now() - waitStart < totalWait) {
        if (bulkCancelRef.current) break;
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }

  const finishedCount = bulkCancelRef.current
    ? `Cancelled after ${candidates.findIndex((_, i) => i)}/${candidates.length}`
    : `Enriched ${candidates.length} leads`;
  setBulkEnrich({ running: false, done: 0, total: 0, currentName: "" });
  qc.invalidateQueries({ queryKey: ["leads"] });
  setFindResult(finishedCount);
}

// Headlines like "Save" / "Save Lead" / "Save in Sales Navigator" come from
// historical extension bugs where the scraper picked up its own injected
// "Save" chip text. We hide them on display so the pipeline rows look clean
// even before the backend strips them out on the next sync.
const NOISY_HEADLINE_RE =
  /^\s*(save(\s+lead)?|save\s+in\s+sales\s+navigator|add\s+to\s+pipeline)\s*$/i;

function renderCell(col: string, lead: Lead, stageById: Map<string, PipelineStage>): React.ReactNode {
  switch (col) {
    case "full_name": {
      const showHeadline =
        lead.headline && !NOISY_HEADLINE_RE.test(lead.headline);
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
            {showHeadline && <span className="text-xs text-slate-500">{lead.headline}</span>}
          </div>
        </Link>
      );
    }
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
