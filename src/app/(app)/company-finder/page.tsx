"use client";

import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Building2,
  Search,
  Download,
  Upload,
  Mail,
  Phone,
  MapPin,
  Star,
  Globe,
  LayoutGrid,
  ListChecks,
  UserPlus,
  ChevronRight,
  ChevronDown,
  Loader2,
  Info,
  KeyRound,
  Sparkles,
  X,
} from "lucide-react";
import { api } from "@/lib/api";
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

interface BNode { name: string; key: string; count: number }
interface ZNode { name: string; count: number; buildings: BNode[] }
interface ANode { name: string; count: number; zones: ZNode[] }
interface CNode { name: string; count: number; areas: ANode[] }

function topCounts(m: Map<string, number>) {
  return [...m.entries()].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count);
}

/** Build the country → area → zone → building tree from a flat business list. */
function buildTree(rows: Business[]): CNode[] {
  const tree = new Map<string, { name: string; count: number; areas: Map<string, { name: string; count: number; zones: Map<string, { name: string; count: number; buildings: Map<string, BNode> }> }> }>();
  for (const b of rows) {
    const cn = b.country || "—", an = b.area || "—", zn = b.zone || "—";
    const c = tree.get(cn) || tree.set(cn, { name: cn, count: 0, areas: new Map() }).get(cn)!;
    const a = c.areas.get(an) || c.areas.set(an, { name: an, count: 0, zones: new Map() }).get(an)!;
    const z = a.zones.get(zn) || a.zones.set(zn, { name: zn, count: 0, buildings: new Map() }).get(zn)!;
    const bk = b.building_key || b.building || "—";
    const bn = z.buildings.get(bk) || z.buildings.set(bk, { name: b.building || b.street || "—", key: b.building_key || "", count: 0 }).get(bk)!;
    bn.count++; z.count++; a.count++; c.count++;
  }
  const out: CNode[] = [];
  for (const c of tree.values()) {
    const areas: ANode[] = [];
    for (const a of c.areas.values()) {
      const zones: ZNode[] = [];
      for (const z of a.zones.values()) {
        zones.push({ name: z.name, count: z.count, buildings: [...z.buildings.values()].sort((x, y) => y.count - x.count) });
      }
      zones.sort((x, y) => y.count - x.count);
      areas.push({ name: a.name, count: a.count, zones });
    }
    areas.sort((x, y) => y.count - x.count);
    out.push({ name: c.name, count: c.count, areas });
  }
  return out.sort((x, y) => y.count - x.count);
}

export default function CompanyFinderPage() {
  const qc = useQueryClient();
  const [view, setView] = useState<"table" | "card">("table");
  const [filters, setFilters] = useState<Filters>(EMPTY);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [treeOpen, setTreeOpen] = useState<Record<string, boolean>>({});
  const [notice, setNotice] = useState("");
  const [results, setResults] = useState<Business[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [source, setSource] = useState<"osm" | "google">("osm");
  const [deep, setDeep] = useState(false);
  const [grid, setGrid] = useState(5);
  const [showKeyModal, setShowKeyModal] = useState(false);
  const [keyInput, setKeyInput] = useState("");
  const importRef = useRef<HTMLInputElement>(null);

  const { data: config } = useQuery<{ configured: boolean; source: string; masked: string }>({
    queryKey: ["cf-config"],
    queryFn: () => api("/company-finder/config"),
  });

  // ── on-demand search: results live in memory, never persisted in bulk ──
  const searchMut = useMutation({
    mutationFn: (query: string) =>
      api<{ businesses: Business[]; found: number; query: string; deep?: boolean; source: string }>(
        "/company-finder/search",
        {
          method: "POST",
          body:
            source === "google"
              ? (deep ? { query, source: "google", deep: true, grid } : { query, source: "google", max_pages: 3 })
              : { query, source: "osm" },
        }
      ),
    onSuccess: (r) => {
      setResults(r.businesses || []);
      setSelected(new Set());
      setFilters(EMPTY);
      setNotice(
        r.found === 0
          ? `No businesses found for "${r.query}". Try a different niche or area.`
          : `Found ${r.found} for "${r.query}" (${r.source === "openstreetmap" ? "OpenStreetMap" : "Google"}).`
      );
    },
    onError: (e: unknown) => {
      const msg = e instanceof Error ? e.message : "Search failed.";
      setNotice(msg);
      if (/api key/i.test(msg)) setShowKeyModal(true);
    },
  });

  const addLeads = useMutation({
    mutationFn: (businesses: Business[]) =>
      api<{ created: number }>("/company-finder/add-leads", { method: "POST", body: { businesses } }),
    onSuccess: (r) => {
      setNotice(`Added ${r.created} business${r.created === 1 ? "" : "es"} to your pipeline.`);
      setSelected(new Set());
    },
    onError: () => setNotice("Couldn't add to pipeline — try again."),
  });

  const saveKey = useMutation({
    mutationFn: (google_api_key: string) =>
      api<{ ok: boolean; configured: boolean }>("/company-finder/config", { method: "POST", body: { google_api_key } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["cf-config"] });
      setShowKeyModal(false);
      setKeyInput("");
      setNotice("Google API key saved. You can search now.");
    },
  });

  const deepRequests = grid * grid + 1;
  const deepCost = (deepRequests * 0.035).toFixed(2);

  function runSearch() {
    const q = searchQuery.trim();
    if (!q) return;
    if (source === "google" && !config?.configured) { setShowKeyModal(true); return; }
    searchMut.mutate(q);
  }

  // ── client-side filtering / facets / hierarchy (zero DB load) ──
  const filtered = useMemo(() => {
    const q = filters.q.trim().toLowerCase();
    return results.filter((b) => {
      if (q && !`${b.name} ${b.category} ${b.address} ${b.email}`.toLowerCase().includes(q)) return false;
      if (filters.category && !(b.category || "").toLowerCase().includes(filters.category.toLowerCase())) return false;
      if (filters.country && b.country !== filters.country) return false;
      if (filters.area && b.area !== filters.area) return false;
      if (filters.zone && b.zone !== filters.zone) return false;
      if (filters.building_key && b.building_key !== filters.building_key) return false;
      if (filters.has_email && !b.email) return false;
      return true;
    });
  }, [results, filters]);

  const facets = useMemo(() => {
    const cat = new Map<string, number>(), cty = new Map<string, number>(), ar = new Map<string, number>(), zo = new Map<string, number>();
    const bset = new Set<string>();
    let withEmail = 0;
    for (const b of results) {
      if (b.category) cat.set(b.category, (cat.get(b.category) || 0) + 1);
      if (b.country) cty.set(b.country, (cty.get(b.country) || 0) + 1);
      if (b.area) ar.set(b.area, (ar.get(b.area) || 0) + 1);
      if (b.zone) zo.set(b.zone, (zo.get(b.zone) || 0) + 1);
      if (b.email) withEmail++;
      if (b.building_key) bset.add(b.building_key);
    }
    return { total: results.length, with_email: withEmail, buildings: bset.size,
      categories: topCounts(cat), countries: topCounts(cty), areas: topCounts(ar), zones: topCounts(zo) };
  }, [results]);

  const tree = useMemo(() => ({ countries: buildTree(results) }), [results]);
  const items = filtered;

  const buildingGroups = useMemo(() => {
    const m = new Map<string, Business[]>();
    for (const b of items) {
      const k = b.building_key || b.building || "—";
      (m.get(k) || m.set(k, []).get(k)!).push(b);
    }
    return [...m.entries()].sort((a, b) => b[1].length - a[1].length);
  }, [items]);

  // ── import a CSV/JSON into the in-memory list (normalized server-side, not stored) ──
  const importMut = useMutation({
    mutationFn: async (rows: Record<string, unknown>[]) => {
      const BATCH = 5000;
      const all: Business[] = [];
      for (let i = 0; i < rows.length; i += BATCH) {
        const r = await api<{ businesses: Business[] }>("/company-finder/normalize", {
          method: "POST", body: { businesses: rows.slice(i, i + BATCH) },
        });
        all.push(...(r.businesses || []));
        setNotice(`Loading… ${Math.min(i + BATCH, rows.length).toLocaleString()}/${rows.length.toLocaleString()}`);
      }
      return all;
    },
    onSuccess: (all) => {
      setResults(all);
      setSelected(new Set());
      setFilters(EMPTY);
      setNotice(`Loaded ${all.length.toLocaleString()} businesses from file.`);
    },
    onError: () => setNotice("Import failed — check the file format."),
  });

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

  // ── export the current (filtered) list as CSV, fully client-side ──
  function downloadCsv() {
    const cols = ["name", "category", "phone", "email", "website", "address", "country", "area", "zone", "building", "latitude", "longitude", "rating", "rating_count", "profile_url"];
    const esc = (v: unknown) => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const body = filtered.map((b) => cols.map((c) => esc((b as unknown as Record<string, unknown>)[c])).join(",")).join("\n");
    const blob = new Blob([cols.join(",") + "\n" + body], { type: "text/csv" });
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
  const selectedBusinesses = () => results.filter((b) => selected.has(b.id));
  const hasFilters = filters.q || filters.category || filters.country || filters.area || filters.zone || filters.building_key || filters.has_email;
  const busy = searchMut.isPending || importMut.isPending;

  return (
    <div className="flex h-full flex-col">
      {/* Search bar — backend fetches businesses; results stay in memory (nothing bulk-stored). */}
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
            disabled={busy || !searchQuery.trim()}
            className="inline-flex items-center gap-1.5 rounded-lg bg-dteal-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-dteal-700 disabled:opacity-50"
          >
            {searchMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : (source === "google" && deep) ? <Sparkles className="h-4 w-4" /> : <Search className="h-4 w-4" />}
            {searchMut.isPending ? (source === "google" && deep ? "Sweeping city…" : "Searching…") : (source === "google" && deep ? "Deep sweep" : "Find businesses")}
          </button>
          {source === "google" && (
            <button
              onClick={() => { setKeyInput(""); setShowKeyModal(true); }}
              className="inline-flex items-center gap-1.5 rounded-lg border border-dteal-200 bg-white px-3 py-2.5 text-sm font-medium text-dteal-700 hover:bg-dteal-50"
              title="Google API key"
            >
              <KeyRound className="h-4 w-4" />
              {config?.configured ? "API key ✓" : "Set API key"}
            </button>
          )}
        </div>

        {/* source toggle + options */}
        <div className="mt-2 flex flex-wrap items-center gap-3 pl-7">
          <div className="inline-flex rounded-lg bg-slate-100 p-0.5 text-sm font-medium">
            <button onClick={() => setSource("osm")} className={cn("rounded-md px-3 py-1", source === "osm" ? "bg-white text-dteal-700 shadow-sm" : "text-slate-500")}>
              🌍 OpenStreetMap · Free
            </button>
            <button onClick={() => setSource("google")} className={cn("rounded-md px-3 py-1", source === "google" ? "bg-white text-dteal-700 shadow-sm" : "text-slate-500")}>
              Google · Paid
            </button>
          </div>
          {source === "osm" ? (
            <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">
              Free · no API key · no result cap · ~10–30s
            </span>
          ) : (
            <>
              <label className="inline-flex items-center gap-2 text-sm font-medium text-dteal-800">
                <input type="checkbox" checked={deep} onChange={(e) => setDeep(e.target.checked)} className="h-4 w-4 rounded border-dteal-300 text-dteal-600 focus:ring-dteal-200" />
                Deep sweep (scan the whole city)
              </label>
              {deep && (
                <>
                  <div className="inline-flex items-center gap-1.5 text-sm text-slate-600">
                    <span>Coverage:</span>
                    <select value={grid} onChange={(e) => setGrid(Number(e.target.value))} className="rounded-md border border-slate-200 bg-white px-2 py-1 text-sm">
                      <option value={4}>Standard (4×4)</option>
                      <option value={5}>Deep (5×5)</option>
                      <option value={6}>Thorough (6×6)</option>
                      <option value={7}>Max (7×7)</option>
                    </select>
                  </div>
                  <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700">
                    ~{deepRequests} Google requests ≈ ${deepCost} · ~{Math.round(deepRequests * 0.5)}s
                  </span>
                </>
              )}
            </>
          )}
        </div>

        <p className="mt-1.5 flex items-center gap-1.5 pl-7 text-xs text-dteal-700/80">
          <Info className="h-3 w-3" />
          On-demand search — results show here instantly and are <strong>not bulk-stored</strong>; only businesses you add become leads. Fully separate from LinkedIn.
          {source === "google" && !config?.configured && <strong className="text-amber-700"> Add your Google Places API key to use this source.</strong>}
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
              Paste a Google Maps Platform key with <strong>“Places API (New)”</strong> enabled. Get one at{" "}
              <a href="https://console.cloud.google.com/google/maps-apis/credentials" target="_blank" rel="noreferrer" className="font-medium text-dteal-700 underline">console.cloud.google.com</a>
              {" "}→ Credentials → Create API key, then enable “Places API (New)”.
            </p>
            <input value={keyInput} onChange={(e) => setKeyInput(e.target.value)} placeholder="AIza…" className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-dteal-400 focus:outline-none focus:ring-2 focus:ring-dteal-100" />
            {config?.configured && <p className="mt-1.5 text-xs text-slate-500">Current: {config.masked} ({config.source})</p>}
            <div className="mt-4 flex justify-end gap-2">
              {config?.configured && (
                <button onClick={() => saveKey.mutate("")} disabled={saveKey.isPending} className="rounded-lg px-3 py-2 text-sm font-medium text-rose-600 hover:bg-rose-50 disabled:opacity-50">Remove key</button>
              )}
              <button onClick={() => keyInput.trim() && saveKey.mutate(keyInput.trim())} disabled={saveKey.isPending || !keyInput.trim()} className="inline-flex items-center gap-1.5 rounded-lg bg-dteal-600 px-4 py-2 text-sm font-semibold text-white hover:bg-dteal-700 disabled:opacity-50">
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
          {facets.total.toLocaleString()} result{facets.total === 1 ? "" : "s"}
        </span>
        {facets.with_email > 0 && (
          <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700">{facets.with_email.toLocaleString()} with email</span>
        )}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {selected.size > 0 && (
            <button onClick={() => addLeads.mutate(selectedBusinesses())} disabled={addLeads.isPending} className="inline-flex items-center gap-1.5 rounded-md bg-dteal-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-dteal-700 disabled:opacity-50">
              <UserPlus className="h-4 w-4" /> Add {selected.size} to pipeline
            </button>
          )}
          <button onClick={() => importRef.current?.click()} className="btn-secondary">
            <Upload className="h-4 w-4" /> Import CSV/JSON
          </button>
          <input ref={importRef} type="file" accept=".csv,.json,.txt" onChange={onImportFile} className="hidden" />
          <button onClick={downloadCsv} disabled={!filtered.length} className="btn-secondary disabled:opacity-50">
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
          <input value={filters.q} onChange={(e) => setFilters((f) => ({ ...f, q: e.target.value }))} placeholder="Filter name, niche, address, email…" className="w-64 max-w-full rounded-md border border-slate-200 py-1.5 pl-8 pr-3 text-sm" />
        </div>
        <FilterSelect label="Niche" value={filters.category} opts={facets.categories} onChange={(v) => setFilters((f) => ({ ...f, category: v }))} />
        <FilterSelect label="Country" value={filters.country} opts={facets.countries} onChange={(v) => setFilters((f) => ({ ...f, country: v, area: "", zone: "" }))} />
        <FilterSelect label="City / area" value={filters.area} opts={facets.areas} onChange={(v) => setFilters((f) => ({ ...f, area: v, zone: "" }))} />
        <FilterSelect label="Zone" value={filters.zone} opts={facets.zones} onChange={(v) => setFilters((f) => ({ ...f, zone: v }))} />
        <label className="flex items-center gap-1.5 text-sm text-slate-600">
          <input type="checkbox" checked={filters.has_email} onChange={(e) => setFilters((f) => ({ ...f, has_email: e.target.checked }))} />
          Has email
        </label>
        {hasFilters && (
          <button onClick={() => setFilters(EMPTY)} className="text-xs font-medium text-rose-600 hover:underline">Clear filters</button>
        )}
        {notice && <span className="ml-auto text-xs text-slate-500">{notice}</span>}
      </div>

      <div className="flex min-h-0 flex-1">
        {/* hierarchy tree */}
        <aside className="hidden w-64 shrink-0 overflow-y-auto border-r border-slate-200 bg-white p-2 lg:block">
          <div className="px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400">Location hierarchy</div>
          {tree.countries.map((c) => (
            <TreeRow key={c.name} label={c.name} count={c.count} depth={0} open={!!treeOpen[c.name]} onClick={() => setTreeOpen((o) => ({ ...o, [c.name]: !o[c.name] }))}>
              {c.areas.map((a) => (
                <TreeRow key={a.name} label={a.name} count={a.count} depth={1} open={!!treeOpen[c.name + a.name]} onClick={() => setTreeOpen((o) => ({ ...o, [c.name + a.name]: !o[c.name + a.name] }))}>
                  {a.zones.map((z) => (
                    <TreeRow key={z.name} label={z.name} count={z.count} depth={2} open={!!treeOpen[c.name + a.name + z.name]} onClick={() => setTreeOpen((o) => ({ ...o, [c.name + a.name + z.name]: !o[c.name + a.name + z.name] }))}>
                      {z.buildings.map((b) => (
                        <button key={b.key || b.name} onClick={() => setFilters((f) => ({ ...f, building_key: b.key, country: c.name === "—" ? "" : c.name, area: a.name === "—" ? "" : a.name }))} className={cn("flex w-full items-center justify-between gap-1 rounded px-2 py-1 pl-10 text-left text-[12px] hover:bg-slate-50", filters.building_key === b.key && "bg-dteal-50 text-dteal-700")} title={b.name}>
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
          {tree.countries.length === 0 && (
            <p className="px-2 py-4 text-xs text-slate-400">Search for businesses above to populate the map.</p>
          )}
        </aside>

        {/* results */}
        <div className="min-w-0 flex-1 overflow-auto bg-slate-50/50">
          {busy && results.length === 0 ? (
            <div className="grid place-items-center p-16"><Loader2 className="h-6 w-6 animate-spin text-slate-400" /></div>
          ) : items.length === 0 ? (
            <div className="grid place-items-center p-16 text-center">
              <div>
                <Building2 className="mx-auto h-10 w-10 text-slate-300" />
                <p className="mt-2 text-sm text-slate-500">{results.length === 0 ? "No businesses yet." : "No results match your filters."}</p>
                <p className="mt-1 max-w-md text-xs text-slate-400">
                  {results.length === 0
                    ? "Type a niche + city above (e.g. “restaurants in Dubai”) and hit Find businesses, or import a CSV/JSON."
                    : "Clear or change the filters to see results."}
                </p>
              </div>
            </div>
          ) : view === "table" ? (
            <table className="min-w-full text-sm">
              <thead className="sticky top-0 z-10 bg-slate-100 text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-3 py-2"><input type="checkbox" checked={allOnPage} onChange={() => setSelected(allOnPage ? new Set() : new Set(items.map((b) => b.id)))} /></th>
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
                        {b.profile_url && <a href={b.profile_url} target="_blank" rel="noreferrer" className="text-dteal-600 hover:underline">map↗</a>}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-slate-600">{b.category}</td>
                    <td className="px-3 py-2">{b.email ? <a href={`mailto:${b.email}`} className="text-dteal-700 hover:underline">{b.email}</a> : <span className="text-slate-300">—</span>}</td>
                    <td className="px-3 py-2 text-slate-600">{b.phone || <span className="text-slate-300">—</span>}</td>
                    <td className="px-3 py-2 text-xs text-slate-500">{[b.building, b.area, b.country].filter(Boolean).join(", ")}</td>
                    <td className="px-3 py-2">
                      <button onClick={() => addLeads.mutate([b])} className="rounded p-1 text-slate-400 hover:bg-dteal-50 hover:text-dteal-700" title="Add to pipeline"><UserPlus className="h-4 w-4" /></button>
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
                          <button onClick={() => addLeads.mutate([b])} className="inline-flex items-center gap-1 rounded-md bg-dteal-50 px-2 py-1 text-[11px] font-medium text-dteal-700 hover:bg-dteal-100">
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
