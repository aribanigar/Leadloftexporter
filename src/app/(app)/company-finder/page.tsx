"use client";

import { useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Building2,
  Search,
  Download,
  Upload,
  Mail,
  Phone,
  Globe,
  MapPin,
  Star,
  LayoutGrid,
  ListChecks,
  Trash2,
  UserPlus,
  ChevronRight,
  ChevronDown,
  Loader2,
  Radio,
  Info,
  KeyRound,
  Sparkles,
  X,
} from "lucide-react";
import { api, API_BASE, getToken, getWorkspaceId } from "@/lib/api";
import { cn } from "@/lib/utils";

interface Business {
  id: string;
  name: string;
  phone: string;
  email: string;
  website: string;
  address: string;
  category: string;
  latitude: number | null;
  longitude: number | null;
  country: string;
  area: string;
  zone: string;
  street: string;
  building: string;
  building_key: string;
  socials: Record<string, string[]>;
  rating: string;
  rating_count: string;
  profile_url: string;
  source: string;
}
interface Facets {
  total: number;
  with_email: number;
  buildings: number;
  categories: { value: string; count: number }[];
  countries: { value: string; count: number }[];
  areas: { value: string; count: number }[];
  zones: { value: string; count: number }[];
}
interface BNode { name: string; key: string; count: number }
interface ZNode { name: string; count: number; buildings: BNode[] }
interface ANode { name: string; count: number; zones: ZNode[] }
interface CNode { name: string; count: number; areas: ANode[] }

interface Filters {
  q: string;
  category: string;
  country: string;
  area: string;
  zone: string;
  building_key: string;
  has_email: boolean;
}

const EMPTY: Filters = { q: "", category: "", country: "", area: "", zone: "", building_key: "", has_email: false };

function qs(f: Filters): string {
  const p = new URLSearchParams();
  if (f.q) p.set("q", f.q);
  if (f.category) p.set("category", f.category);
  if (f.country) p.set("country", f.country);
  if (f.area) p.set("area", f.area);
  if (f.zone) p.set("zone", f.zone);
  if (f.building_key) p.set("building_key", f.building_key);
  if (f.has_email) p.set("has_email", "true");
  return p.toString();
}

export default function CompanyFinderPage() {
  const qc = useQueryClient();
  const [view, setView] = useState<"table" | "card">("table");
  const [filters, setFilters] = useState<Filters>(EMPTY);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [treeOpen, setTreeOpen] = useState<Record<string, boolean>>({});
  const [notice, setNotice] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [showKeyModal, setShowKeyModal] = useState(false);
  const [keyInput, setKeyInput] = useState("");
  const importRef = useRef<HTMLInputElement>(null);

  const filterStr = qs(filters);

  const { data: config } = useQuery<{ configured: boolean; source: string; masked: string }>({
    queryKey: ["cf-config"],
    queryFn: () => api("/company-finder/config"),
  });

  const { data: facets } = useQuery<Facets>({
    queryKey: ["cf-facets"],
    queryFn: () => api("/company-finder/facets"),
    refetchInterval: 8000,
  });
  const { data: list, isLoading } = useQuery<{ items: Business[]; total: number }>({
    queryKey: ["cf-businesses", filterStr],
    queryFn: () => api(`/company-finder/businesses${filterStr ? `?${filterStr}` : ""}`),
    refetchInterval: 8000,
  });
  const { data: tree } = useQuery<{ countries: CNode[] }>({
    queryKey: ["cf-hierarchy"],
    queryFn: () => api("/company-finder/hierarchy"),
    refetchInterval: 12000,
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["cf-businesses"] });
    qc.invalidateQueries({ queryKey: ["cf-facets"] });
    qc.invalidateQueries({ queryKey: ["cf-hierarchy"] });
  };

  const importMut = useMutation({
    mutationFn: (businesses: Record<string, unknown>[]) =>
      api<{ inserted: number; updated: number }>("/company-finder/import", { method: "POST", body: { businesses } }),
    onSuccess: (r) => {
      setNotice(`Imported ${r.inserted} new + ${r.updated} updated.`);
      invalidate();
    },
    onError: () => setNotice("Import failed — check the file format."),
  });
  const addLeads = useMutation({
    mutationFn: (ids: string[]) => api<{ created: number }>("/company-finder/add-leads", { method: "POST", body: { ids } }),
    onSuccess: (r) => {
      setNotice(`Added ${r.created} business${r.created === 1 ? "" : "es"} to your pipeline.`);
      setSelected(new Set());
    },
  });

  // Server-side Google Places search — the backend fetches the businesses.
  const searchMut = useMutation({
    mutationFn: (query: string) =>
      api<{ found: number; inserted: number; updated: number; query: string }>(
        "/company-finder/search",
        { method: "POST", body: { query, max_pages: 3 } }
      ),
    onSuccess: (r) => {
      setNotice(
        r.found === 0
          ? `No businesses found for "${r.query}". Try a different niche or area.`
          : `Found ${r.found} for "${r.query}" — ${r.inserted} new, ${r.updated} updated.`
      );
      invalidate();
    },
    onError: (e: unknown) => {
      const msg = e instanceof Error ? e.message : "Search failed.";
      setNotice(msg);
      if (/api key/i.test(msg)) setShowKeyModal(true);
    },
  });

  const saveKey = useMutation({
    mutationFn: (google_api_key: string) =>
      api<{ ok: boolean; configured: boolean }>("/company-finder/config", {
        method: "POST",
        body: { google_api_key },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["cf-config"] });
      setShowKeyModal(false);
      setKeyInput("");
      setNotice("Google API key saved. You can search now.");
    },
  });

  function runSearch() {
    const q = searchQuery.trim();
    if (!q) return;
    if (!config?.configured) { setShowKeyModal(true); return; }
    searchMut.mutate(q);
  }

  const items = list?.items ?? [];

  // Group the current page by building so "N businesses in this building" is visible.
  const buildingGroups = useMemo(() => {
    const m = new Map<string, Business[]>();
    for (const b of items) {
      const k = b.building_key || b.building || "—";
      (m.get(k) || m.set(k, []).get(k)!).push(b);
    }
    return [...m.entries()].sort((a, b) => b[1].length - a[1].length);
  }, [items]);

  async function onImportFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const text = await file.text();
    let rows: Record<string, unknown>[] = [];
    try {
      if (file.name.endsWith(".json")) {
        const j = JSON.parse(text);
        rows = Array.isArray(j) ? j : j.businesses || j.leads || j.data || [];
      } else {
        rows = parseCsv(text);
      }
    } catch {
      setNotice("Couldn't parse that file.");
      return;
    }
    if (!rows.length) { setNotice("No rows found in the file."); return; }
    importMut.mutate(rows);
  }

  async function downloadCsv() {
    const url = `${API_BASE}/api/v1/company-finder/export.csv${filterStr ? `?${filterStr}` : ""}`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${getToken() || ""}`,
        "X-Workspace-Id": getWorkspaceId() || "",
      },
    });
    const blob = await res.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "company-finder.csv";
    a.click();
    URL.revokeObjectURL(a.href);
  }

  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  const allOnPage = items.length > 0 && items.every((b) => selected.has(b.id));

  return (
    <div className="flex h-full flex-col">
      {/* Search bar — the backend fetches businesses from Google for you. */}
      <div className="border-b border-dteal-100 bg-gradient-to-r from-dteal-50 via-emerald-50/40 to-white px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <Sparkles className="h-5 w-5 shrink-0 text-dteal-600" />
          <div className="relative min-w-[260px] flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && runSearch()}
              placeholder='Find businesses — e.g. "restaurants in Dubai", "dentists in Abu Dhabi"'
              className="w-full rounded-lg border border-dteal-200 bg-white py-2.5 pl-9 pr-3 text-sm shadow-sm focus:border-dteal-400 focus:outline-none focus:ring-2 focus:ring-dteal-100"
            />
          </div>
          <button
            onClick={runSearch}
            disabled={searchMut.isPending || !searchQuery.trim()}
            className="inline-flex items-center gap-1.5 rounded-lg bg-dteal-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-dteal-700 disabled:opacity-50"
          >
            {searchMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
            {searchMut.isPending ? "Searching Google…" : "Find businesses"}
          </button>
          <button
            onClick={() => { setKeyInput(""); setShowKeyModal(true); }}
            className="inline-flex items-center gap-1.5 rounded-lg border border-dteal-200 bg-white px-3 py-2.5 text-sm font-medium text-dteal-700 hover:bg-dteal-50"
            title="Google API key"
          >
            <KeyRound className="h-4 w-4" />
            {config?.configured ? "API key ✓" : "Set API key"}
          </button>
        </div>
        <p className="mt-1.5 flex items-center gap-1.5 pl-7 text-xs text-dteal-700/80">
          <Info className="h-3 w-3" />
          The system fetches businesses straight from Google — no manual scraping. This feature is fully separate from LinkedIn.
          {!config?.configured && <span className="font-semibold text-amber-700"> Add your Google Places API key to start.</span>}
        </p>
      </div>

      {/* API key modal */}
      {showKeyModal && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-slate-900/40 p-4" onClick={() => setShowKeyModal(false)}>
          <div className="w-full max-w-md rounded-xl bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="mb-3 flex items-center gap-2">
              <KeyRound className="h-5 w-5 text-dteal-600" />
              <h2 className="text-base font-semibold">Google Places API key</h2>
              <button onClick={() => setShowKeyModal(false)} className="ml-auto rounded p-1 text-slate-400 hover:bg-slate-100">
                <X className="h-4 w-4" />
              </button>
            </div>
            <p className="mb-3 text-xs leading-relaxed text-slate-600">
              Paste a Google Maps Platform key with <strong>“Places API (New)”</strong> enabled.
              Get one at{" "}
              <a href="https://console.cloud.google.com/google/maps-apis/credentials" target="_blank" rel="noreferrer" className="font-medium text-dteal-700 underline">
                console.cloud.google.com
              </a>
              {" "}→ Credentials → Create API key, then enable “Places API (New)”.
            </p>
            <input
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
              placeholder="AIza…"
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-dteal-400 focus:outline-none focus:ring-2 focus:ring-dteal-100"
            />
            {config?.configured && (
              <p className="mt-1.5 text-xs text-slate-500">Current: {config.masked} ({config.source})</p>
            )}
            <div className="mt-4 flex justify-end gap-2">
              {config?.configured && (
                <button
                  onClick={() => saveKey.mutate("")}
                  disabled={saveKey.isPending}
                  className="rounded-lg px-3 py-2 text-sm font-medium text-rose-600 hover:bg-rose-50 disabled:opacity-50"
                >
                  Remove key
                </button>
              )}
              <button
                onClick={() => keyInput.trim() && saveKey.mutate(keyInput.trim())}
                disabled={saveKey.isPending || !keyInput.trim()}
                className="inline-flex items-center gap-1.5 rounded-lg bg-dteal-600 px-4 py-2 text-sm font-semibold text-white hover:bg-dteal-700 disabled:opacity-50"
              >
                {saveKey.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                Save key
              </button>
            </div>
          </div>
        </div>
      )}

      {/* header */}
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 bg-white px-4 py-3">
        <Building2 className="h-5 w-5 text-dteal-600" />
        <h1 className="text-lg font-semibold">Finder Lead</h1>
        <span className="rounded-full bg-dteal-50 px-2 py-0.5 text-xs font-medium text-dteal-700">
          {facets?.total ?? 0} businesses
        </span>
        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700">
          <Radio className="h-3 w-3 animate-pulse" /> live
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {selected.size > 0 && (
            <button
              onClick={() => addLeads.mutate([...selected])}
              disabled={addLeads.isPending}
              className="inline-flex items-center gap-1.5 rounded-md bg-dteal-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-dteal-700 disabled:opacity-50"
            >
              <UserPlus className="h-4 w-4" /> Add {selected.size} to pipeline
            </button>
          )}
          <button onClick={() => importRef.current?.click()} className="btn-secondary">
            <Upload className="h-4 w-4" /> Import CSV/JSON
          </button>
          <input ref={importRef} type="file" accept=".csv,.json,.txt" onChange={onImportFile} className="hidden" />
          <button onClick={downloadCsv} className="btn-secondary">
            <Download className="h-4 w-4" /> Export CSV
          </button>
          <div className="inline-flex gap-0.5 rounded-lg bg-slate-100 p-0.5">
            <button onClick={() => setView("table")} className={cn("inline-flex items-center gap-1 rounded-md px-2.5 py-1.5 text-sm font-medium", view === "table" ? "bg-white text-dteal-700 shadow-sm" : "text-slate-500")}>
              <ListChecks className="h-4 w-4" /> Table
            </button>
            <button onClick={() => setView("card")} className={cn("inline-flex items-center gap-1 rounded-md px-2.5 py-1.5 text-sm font-medium", view === "card" ? "bg-white text-dteal-700 shadow-sm" : "text-slate-500")}>
              <LayoutGrid className="h-4 w-4" /> Cards
            </button>
          </div>
        </div>
      </div>

      {/* filter bar */}
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 bg-white px-4 py-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input
            value={filters.q}
            onChange={(e) => setFilters((f) => ({ ...f, q: e.target.value }))}
            placeholder="Search name, niche, address, email…"
            className="w-64 max-w-full rounded-md border border-slate-200 py-1.5 pl-8 pr-3 text-sm"
          />
        </div>
        <FilterSelect label="Niche" value={filters.category} opts={facets?.categories} onChange={(v) => setFilters((f) => ({ ...f, category: v }))} />
        <FilterSelect label="Country" value={filters.country} opts={facets?.countries} onChange={(v) => setFilters((f) => ({ ...f, country: v, area: "", zone: "" }))} />
        <FilterSelect label="City / area" value={filters.area} opts={facets?.areas} onChange={(v) => setFilters((f) => ({ ...f, area: v, zone: "" }))} />
        <FilterSelect label="Zone" value={filters.zone} opts={facets?.zones} onChange={(v) => setFilters((f) => ({ ...f, zone: v }))} />
        <label className="flex items-center gap-1.5 text-sm text-slate-600">
          <input type="checkbox" checked={filters.has_email} onChange={(e) => setFilters((f) => ({ ...f, has_email: e.target.checked }))} />
          Has email
        </label>
        {(filterStr || filters.building_key) && (
          <button onClick={() => setFilters(EMPTY)} className="text-xs font-medium text-rose-600 hover:underline">
            Clear filters
          </button>
        )}
        {notice && <span className="ml-auto text-xs text-slate-500">{notice}</span>}
      </div>

      <div className="flex min-h-0 flex-1">
        {/* hierarchy tree */}
        <aside className="hidden w-64 shrink-0 overflow-y-auto border-r border-slate-200 bg-white p-2 lg:block">
          <div className="px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
            Location hierarchy
          </div>
          {(tree?.countries ?? []).map((c) => (
            <TreeRow key={c.name} label={c.name} count={c.count} depth={0} open={!!treeOpen[c.name]} onClick={() => setTreeOpen((o) => ({ ...o, [c.name]: !o[c.name] }))}>
              {c.areas.map((a) => (
                <TreeRow key={a.name} label={a.name} count={a.count} depth={1} open={!!treeOpen[c.name + a.name]} onClick={() => setTreeOpen((o) => ({ ...o, [c.name + a.name]: !o[c.name + a.name] }))}>
                  {a.zones.map((z) => (
                    <TreeRow key={z.name} label={z.name} count={z.count} depth={2} open={!!treeOpen[c.name + a.name + z.name]} onClick={() => setTreeOpen((o) => ({ ...o, [c.name + a.name + z.name]: !o[c.name + a.name + z.name] }))}>
                      {z.buildings.map((b) => (
                        <button
                          key={b.key || b.name}
                          onClick={() => setFilters((f) => ({ ...f, building_key: b.key, country: c.name === "—" ? "" : c.name, area: a.name === "—" ? "" : a.name }))}
                          className={cn("flex w-full items-center justify-between gap-1 rounded px-2 py-1 pl-10 text-left text-[12px] hover:bg-slate-50", filters.building_key === b.key && "bg-dteal-50 text-dteal-700")}
                          title={b.name}
                        >
                          <span className="flex items-center gap-1 truncate"><Building2 className="h-3 w-3 shrink-0 text-slate-400" />{b.name}</span>
                          <span className="shrink-0 rounded-full bg-slate-100 px-1.5 text-[10px] text-slate-500">{b.count}</span>
                        </button>
                      ))}
                    </TreeRow>
                  ))}
                </TreeRow>
              ))}
            </TreeRow>
          ))}
          {(tree?.countries ?? []).length === 0 && (
            <p className="px-2 py-4 text-xs text-slate-400">No data yet. Scrape from Google Maps with the extension, or import a CSV.</p>
          )}
        </aside>

        {/* results */}
        <div className="min-w-0 flex-1 overflow-auto bg-slate-50/50">
          {isLoading ? (
            <div className="grid place-items-center p-16"><Loader2 className="h-6 w-6 animate-spin text-slate-400" /></div>
          ) : items.length === 0 ? (
            <div className="grid place-items-center p-16 text-center">
              <div>
                <Building2 className="mx-auto h-10 w-10 text-slate-300" />
                <p className="mt-2 text-sm text-slate-500">No businesses yet.</p>
                <p className="mt-1 max-w-md text-xs text-slate-400">
                  Search on Google Maps with the LeadCaptura extension to capture businesses live, or import your scraper&apos;s CSV/JSON export.
                </p>
              </div>
            </div>
          ) : view === "table" ? (
            <table className="min-w-full text-sm">
              <thead className="sticky top-0 z-10 bg-slate-100 text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-3 py-2">
                    <input type="checkbox" checked={allOnPage} onChange={() => setSelected(allOnPage ? new Set() : new Set(items.map((b) => b.id)))} />
                  </th>
                  <th className="px-3 py-2">Business</th>
                  <th className="px-3 py-2">Niche</th>
                  <th className="px-3 py-2">Email</th>
                  <th className="px-3 py-2">Phone</th>
                  <th className="px-3 py-2">Location</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {items.map((b) => (
                  <tr key={b.id} className={cn("border-b border-slate-100 bg-white hover:bg-dteal-50/30", selected.has(b.id) && "bg-dteal-50/50")}>
                    <td className="px-3 py-2"><input type="checkbox" checked={selected.has(b.id)} onChange={() => toggle(b.id)} /></td>
                    <td className="px-3 py-2">
                      <div className="font-medium text-slate-800">{b.name}</div>
                      <div className="flex items-center gap-2 text-[11px] text-slate-400">
                        {b.rating && <span className="inline-flex items-center gap-0.5"><Star className="h-3 w-3 text-amber-400" />{b.rating} ({b.rating_count})</span>}
                        {b.website && <a href={b.website} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-dteal-600 hover:underline"><Globe className="h-3 w-3" />site</a>}
                        {b.profile_url && <a href={b.profile_url} target="_blank" rel="noreferrer" className="text-dteal-600 hover:underline">maps↗</a>}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-slate-600">{b.category}</td>
                    <td className="px-3 py-2">{b.email ? <a href={`mailto:${b.email}`} className="text-dteal-700 hover:underline">{b.email}</a> : <span className="text-slate-300">—</span>}</td>
                    <td className="px-3 py-2 text-slate-600">{b.phone || <span className="text-slate-300">—</span>}</td>
                    <td className="px-3 py-2 text-xs text-slate-500">{[b.building, b.area, b.country].filter(Boolean).join(", ")}</td>
                    <td className="px-3 py-2">
                      <button onClick={() => addLeads.mutate([b.id])} className="rounded p-1 text-slate-400 hover:bg-dteal-50 hover:text-dteal-700" title="Add to pipeline">
                        <UserPlus className="h-4 w-4" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="space-y-5 p-4">
              {buildingGroups.map(([key, group]) => (
                <div key={key}>
                  <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                    <Building2 className="h-3.5 w-3.5 text-dteal-500" />
                    {group[0].building || "Building"} · {[group[0].area, group[0].country].filter(Boolean).join(", ")}
                    <span className="rounded-full bg-dteal-50 px-2 py-0.5 text-[11px] text-dteal-700">{group.length} business{group.length === 1 ? "" : "es"} here</span>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                    {group.map((b) => (
                      <div key={b.id} className={cn("rounded-xl border bg-white p-3 shadow-card", selected.has(b.id) ? "border-dteal-300" : "border-slate-200")}>
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <div className="truncate font-semibold text-slate-800">{b.name}</div>
                            {b.category && <div className="truncate text-[11px] text-slate-400">{b.category}</div>}
                          </div>
                          <input type="checkbox" checked={selected.has(b.id)} onChange={() => toggle(b.id)} className="mt-1" />
                        </div>
                        <div className="mt-2 space-y-1 text-[12px] text-slate-600">
                          {b.email && <div className="flex items-center gap-1.5 truncate"><Mail className="h-3.5 w-3.5 text-dteal-500" />{b.email}</div>}
                          {b.phone && <div className="flex items-center gap-1.5"><Phone className="h-3.5 w-3.5 text-dteal-500" />{b.phone}</div>}
                          {b.address && <div className="flex items-start gap-1.5"><MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0 text-dteal-500" /><span className="line-clamp-2">{b.address}</span></div>}
                        </div>
                        <div className="mt-2 flex items-center justify-between">
                          <div className="flex gap-2 text-[11px]">
                            {b.website && <a href={b.website} target="_blank" rel="noreferrer" className="text-dteal-600 hover:underline">Website</a>}
                            {b.profile_url && <a href={b.profile_url} target="_blank" rel="noreferrer" className="text-dteal-600 hover:underline">Maps</a>}
                          </div>
                          <button onClick={() => addLeads.mutate([b.id])} className="inline-flex items-center gap-1 rounded-md bg-dteal-50 px-2 py-1 text-[11px] font-medium text-dteal-700 hover:bg-dteal-100">
                            <UserPlus className="h-3 w-3" /> Add to pipeline
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function FilterSelect({ label, value, opts, onChange }: { label: string; value: string; opts?: { value: string; count: number }[]; onChange: (v: string) => void }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className="rounded-md border border-slate-200 bg-white px-2 py-1.5 text-sm text-slate-600">
      <option value="">{label}: all</option>
      {(opts ?? []).map((o) => (
        <option key={o.value} value={o.value}>{o.value} ({o.count})</option>
      ))}
    </select>
  );
}

function TreeRow({ label, count, depth, open, onClick, children }: { label: string; count: number; depth: number; open: boolean; onClick: () => void; children?: React.ReactNode }) {
  return (
    <div>
      <button onClick={onClick} className="flex w-full items-center justify-between gap-1 rounded px-2 py-1 text-left text-[13px] hover:bg-slate-50" style={{ paddingLeft: 8 + depth * 12 }}>
        <span className="flex items-center gap-1 truncate font-medium text-slate-700">
          {open ? <ChevronDown className="h-3.5 w-3.5 text-slate-400" /> : <ChevronRight className="h-3.5 w-3.5 text-slate-400" />}
          {label}
        </span>
        <span className="shrink-0 rounded-full bg-slate-100 px-1.5 text-[10px] text-slate-500">{count}</span>
      </button>
      {open && <div>{children}</div>}
    </div>
  );
}

// Minimal CSV parser (handles quoted fields + comma/newline). Maps header row → keys.
function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else inQ = false; }
      else cell += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") { if (ch === "\r" && text[i + 1] === "\n") i++; row.push(cell); cell = ""; if (row.some((c) => c !== "")) rows.push(row); row = []; }
    else cell += ch;
  }
  if (cell !== "" || row.length) { row.push(cell); if (row.some((c) => c !== "")) rows.push(row); }
  if (rows.length < 2) return [];
  const headers = rows[0].map((h) => h.trim().toLowerCase().replace(/\s+/g, "_"));
  return rows.slice(1).map((r) => {
    const o: Record<string, string> = {};
    headers.forEach((h, i) => (o[h] = (r[i] || "").trim()));
    return o;
  });
}
