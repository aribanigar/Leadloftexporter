"use client";

import { useCallback, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Upload,
  FileText,
  ChevronRight,
  CheckCircle2,
  AlertCircle,
  X,
  Loader2,
} from "lucide-react";
import { api, apiBase, getToken, getWorkspaceId } from "@/lib/api";
import type { PipelineStage } from "@/lib/types";

type WipeResult = { deleted: Record<string, number> };

const LEAD_FIELDS: { value: string; label: string }[] = [
  { value: "", label: "— skip column —" },
  { value: "full_name", label: "Full Name" },
  { value: "first_name", label: "First Name" },
  { value: "last_name", label: "Last Name" },
  { value: "email", label: "Email" },
  { value: "phone", label: "Phone" },
  { value: "linkedin_url", label: "LinkedIn URL" },
  { value: "title", label: "Job Title" },
  { value: "company_name", label: "Company" },
  { value: "location", label: "Location" },
  { value: "stage_name", label: "Stage Name" },
];

interface PreviewResult {
  columns: string[];
  preview: Record<string, string>[];
  total_rows: number;
}

interface ImportResult {
  imported: number;
  updated: number;
  skipped: number;
  errors: string[];
}

function autoGuess(col: string): string {
  const c = col.toLowerCase().replace(/[\s_-]+/g, "");
  if (c.includes("firstname") || c === "first") return "first_name";
  if (c.includes("lastname") || c === "last") return "last_name";
  if (c.includes("fullname") || c === "name") return "full_name";
  if (c.includes("email") || c.includes("mail")) return "email";
  if (c.includes("phone") || c.includes("mobile") || c.includes("tel")) return "phone";
  if (c.includes("linkedin") || c.includes("li")) return "linkedin_url";
  if (c.includes("title") || c.includes("role") || c.includes("position")) return "title";
  if (c.includes("company") || c.includes("org") || c.includes("employer")) return "company_name";
  if (c.includes("location") || c.includes("city") || c.includes("country")) return "location";
  if (c.includes("stage")) return "stage_name";
  return "";
}

export default function ImportPage() {
  // --- CSV import state ---
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // --- Cleanup state ---
  const [cleaning, setCleaning] = useState(false);
  const [cleanResult, setCleanResult] = useState<string | null>(null);
  const [cleaningPolluted, setCleaningPolluted] = useState(false);
  const [pollutedResult, setPollutedResult] = useState<string | null>(null);
  const [wiping, setWiping] = useState(false);
  const [wipeResult, setWipeResult] = useState<string | null>(null);

  const { data: stages } = useQuery<PipelineStage[]>({
    queryKey: ["stages"],
    queryFn: () => api("/pipeline/stages"),
  });

  // --- File handling ---
  async function loadFile(f: File) {
    setFile(f);
    setPreview(null);
    setImportResult(null);
    setPreviewError(null);
    setPreviewLoading(true);

    const token = getToken();
    const ws = getWorkspaceId();
    const form = new FormData();
    form.append("file", f);

    try {
      const res = await fetch(`${apiBase()}/api/v1/leads/import-csv/preview`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "X-Workspace-Id": ws || "",
        },
        body: form,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || `Server error ${res.status}`);
      }
      const data: PreviewResult = await res.json();
      const guessed: Record<string, string> = {};
      data.columns.forEach((col) => {
        guessed[col] = autoGuess(col);
      });
      setPreview(data);
      setMapping(guessed);
    } catch (e) {
      setPreviewError(e instanceof Error ? e.message : "Failed to read file.");
    } finally {
      setPreviewLoading(false);
    }
  }

  const onInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) loadFile(f);
  };

  const onDrop = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files?.[0];
    if (f) loadFile(f);
  }, []);

  async function runImport() {
    if (!file || !preview) return;
    setImporting(true);
    setImportResult(null);

    const token = getToken();
    const ws = getWorkspaceId();
    const form = new FormData();
    form.append("file", file);

    // mapping: { lead_field: csv_column }
    const reverseMap: Record<string, string> = {};
    Object.entries(mapping).forEach(([csvCol, leadField]) => {
      if (leadField) reverseMap[leadField] = csvCol;
    });
    form.append("mapping", JSON.stringify(reverseMap));

    try {
      const res = await fetch(`${apiBase()}/api/v1/leads/import-csv`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "X-Workspace-Id": ws || "",
        },
        body: form,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || `Import failed (${res.status})`);
      }
      const result: ImportResult = await res.json();
      setImportResult(result);
    } catch (e) {
      setPreviewError(e instanceof Error ? e.message : "Import failed.");
    } finally {
      setImporting(false);
    }
  }

  function reset() {
    setFile(null);
    setPreview(null);
    setMapping({});
    setImportResult(null);
    setPreviewError(null);
    if (fileRef.current) fileRef.current.value = "";
  }

  // --- Cleanup helpers ---
  async function runCleanup() {
    if (!confirm("Delete every lead that has no email AND no phone number? This cannot be undone.")) return;
    setCleaning(true);
    setCleanResult(null);
    try {
      const res = await api<{ deleted: number }>("/leads/cleanup/no-contact", { method: "DELETE" });
      setCleanResult(`Deleted ${res.deleted} lead${res.deleted !== 1 ? "s" : ""} with no contact info.`);
    } catch (e: unknown) {
      setCleanResult(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setCleaning(false);
    }
  }

  async function runPollutedCleanup() {
    if (!confirm('Delete all leads with LinkedIn button-label names? This cannot be undone.')) return;
    setCleaningPolluted(true);
    setPollutedResult(null);
    try {
      const res = await api<{ deleted: number; examples: string[] }>(
        "/leads/cleanup/polluted-names",
        { method: "DELETE" }
      );
      setPollutedResult(
        `Deleted ${res.deleted} polluted-name lead${res.deleted === 1 ? "" : "s"}` +
          (res.examples?.length ? `: ${res.examples.slice(0, 5).join(", ")}` : "")
      );
    } catch (e: unknown) {
      setPollutedResult(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setCleaningPolluted(false);
    }
  }

  async function runWipe() {
    if (!confirm("Wipe ALL pipeline data?\n\nThis deletes every lead, activity, note, task, call log, email, playbook enrollment, and extension job in this workspace.\n\nThis cannot be undone."))
      return;
    const typed = prompt('Type "WIPE" to confirm:');
    if (typed !== "WIPE") return;
    setWiping(true);
    setWipeResult(null);
    try {
      const res = await api<WipeResult>("/leads/cleanup/wipe-pipeline", { method: "DELETE" });
      const lines = Object.entries(res.deleted)
        .filter(([, n]) => (n as number) > 0)
        .map(([k, n]) => `${k}: ${n}`)
        .join(", ");
      setWipeResult(`Wiped ✓ (${lines || "nothing to delete"})`);
    } catch (e: unknown) {
      setWipeResult(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setWiping(false);
    }
  }

  const hasAnyMapping = Object.values(mapping).some(Boolean);
  const step = importResult ? 3 : preview ? 2 : 1;

  return (
    <div className="max-w-3xl space-y-6">
      {/* ---- CSV Import ---- */}
      <div className="card p-6">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold">Import Leads from CSV</h2>
            <p className="mt-0.5 text-sm text-slate-500">
              Upload a CSV file, map its columns to lead fields, then import.
              Existing leads are matched by LinkedIn URL or email and updated
              rather than duplicated.
            </p>
          </div>
          {(step === 2 || step === 3) && (
            <button onClick={reset} className="action-icon ml-4 shrink-0" title="Start over">
              <X className="h-4 w-4" />
            </button>
          )}
        </div>

        {/* Step indicators */}
        <div className="mb-5 flex items-center gap-2 text-xs text-slate-400">
          {["Upload file", "Map columns", "Import"].map((label, i) => (
            <div key={i} className="flex items-center gap-2">
              {i > 0 && <ChevronRight className="h-3 w-3 shrink-0" />}
              <span
                className={`flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-bold ${
                  step > i + 1
                    ? "bg-emerald-500 text-white"
                    : step === i + 1
                    ? "bg-brand-600 text-white"
                    : "bg-slate-100 text-slate-400"
                }`}
              >
                {step > i + 1 ? "✓" : i + 1}
              </span>
              <span className={step === i + 1 ? "font-medium text-slate-700" : ""}>{label}</span>
            </div>
          ))}
        </div>

        {/* Step 1: File drop zone */}
        {step === 1 && (
          <>
            <div
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={onDrop}
              onClick={() => fileRef.current?.click()}
              className={`flex cursor-pointer flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed py-12 transition-colors ${
                dragOver
                  ? "border-brand-400 bg-brand-50"
                  : "border-slate-200 bg-slate-50 hover:border-slate-300 hover:bg-slate-100"
              }`}
            >
              <Upload className="h-8 w-8 text-slate-400" />
              <div className="text-center">
                <p className="text-sm font-medium text-slate-600">
                  Drop a CSV file here, or{" "}
                  <span className="text-brand-600 underline">browse</span>
                </p>
                <p className="mt-1 text-xs text-slate-400">
                  Supports .csv files up to 50 MB. Encoding: UTF-8 or Latin-1.
                </p>
              </div>
              <input
                ref={fileRef}
                type="file"
                accept=".csv,text/csv"
                className="hidden"
                onChange={onInputChange}
              />
            </div>

            {previewLoading && (
              <div className="mt-4 flex items-center gap-2 text-sm text-slate-500">
                <Loader2 className="h-4 w-4 animate-spin text-brand-600" />
                Reading file…
              </div>
            )}
            {previewError && (
              <div className="mt-3 flex items-start gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                {previewError}
              </div>
            )}

            <div className="mt-4 rounded-md bg-slate-50 p-3 text-xs text-slate-500">
              <p className="font-medium text-slate-600">Supported column names (auto-detected):</p>
              <p className="mt-1">
                Full Name / First Name / Last Name / Email / Phone / LinkedIn URL /
                Title / Company / Location / Stage
              </p>
            </div>
          </>
        )}

        {/* Step 2: Column mapping */}
        {step === 2 && preview && (
          <>
            <div className="mb-4 flex items-center gap-2 rounded-md border border-slate-200 bg-slate-50 p-3">
              <FileText className="h-5 w-5 shrink-0 text-slate-400" />
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-slate-700">{file?.name}</p>
                <p className="text-xs text-slate-400">
                  {preview.total_rows.toLocaleString()} data rows · {preview.columns.length} columns
                </p>
              </div>
            </div>

            <div className="mb-4 space-y-2">
              <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2 pb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">
                <span>CSV Column</span>
                <span />
                <span>Maps to</span>
              </div>
              {preview.columns.map((col) => (
                <div
                  key={col}
                  className="grid grid-cols-[1fr_auto_1fr] items-center gap-2 rounded-md border border-slate-100 bg-white px-3 py-2"
                >
                  <span className="truncate text-sm font-medium text-slate-700" title={col}>
                    {col}
                  </span>
                  <ChevronRight className="h-4 w-4 shrink-0 text-slate-300" />
                  <select
                    className="input py-1 text-sm"
                    value={mapping[col] || ""}
                    onChange={(e) =>
                      setMapping((prev) => ({ ...prev, [col]: e.target.value }))
                    }
                  >
                    {LEAD_FIELDS.map((f) => (
                      <option key={f.value} value={f.value}>
                        {f.label}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
            </div>

            {/* Preview table */}
            <details className="mb-4">
              <summary className="cursor-pointer text-xs font-medium text-slate-500 hover:text-slate-700">
                Preview first {preview.preview.length} rows
              </summary>
              <div className="mt-2 overflow-x-auto rounded-md border border-slate-200">
                <table className="min-w-full text-xs">
                  <thead className="bg-slate-50">
                    <tr>
                      {preview.columns.map((c) => (
                        <th key={c} className="px-3 py-2 text-left font-semibold text-slate-500">
                          {c}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {preview.preview.map((row, i) => (
                      <tr key={i} className="bg-white">
                        {preview.columns.map((c) => (
                          <td key={c} className="max-w-[200px] truncate px-3 py-1.5 text-slate-600">
                            {row[c] || ""}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>

            {/* Stage hint */}
            {mapping[Object.keys(mapping).find((k) => mapping[k] === "stage_name") ?? ""] === "stage_name" && (
              <div className="mb-4 rounded-md bg-amber-50 p-3 text-xs text-amber-700">
                Matching stages by name (case-insensitive). Your workspace stages:{" "}
                {(stages || []).map((s) => s.name).join(", ") || "none loaded yet"}. Leads whose stage
                value doesn&apos;t match will go to your default first stage.
              </div>
            )}

            {previewError && (
              <div className="mb-3 flex items-start gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                {previewError}
              </div>
            )}

            <div className="flex items-center justify-end gap-3">
              <button className="btn-secondary" onClick={reset}>
                Cancel
              </button>
              <button
                className="btn-primary disabled:opacity-50"
                disabled={!hasAnyMapping || importing}
                onClick={runImport}
              >
                {importing ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" /> Importing…
                  </>
                ) : (
                  <>
                    Import {preview.total_rows.toLocaleString()} leads
                  </>
                )}
              </button>
            </div>
          </>
        )}

        {/* Step 3: Results */}
        {step === 3 && importResult && (
          <div className="text-center">
            <CheckCircle2 className="mx-auto mb-3 h-10 w-10 text-emerald-500" />
            <h3 className="text-base font-semibold text-slate-800">Import complete</h3>
            <div className="mt-3 flex justify-center gap-6 text-sm">
              <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-5 py-3">
                <div className="text-2xl font-bold text-emerald-700">{importResult.imported}</div>
                <div className="text-xs text-emerald-600">New leads</div>
              </div>
              <div className="rounded-lg border border-brand-200 bg-brand-50 px-5 py-3">
                <div className="text-2xl font-bold text-brand-700">{importResult.updated}</div>
                <div className="text-xs text-brand-600">Updated</div>
              </div>
              <div className="rounded-lg border border-slate-200 bg-slate-50 px-5 py-3">
                <div className="text-2xl font-bold text-slate-600">{importResult.skipped}</div>
                <div className="text-xs text-slate-500">Skipped</div>
              </div>
            </div>
            {importResult.errors.length > 0 && (
              <div className="mx-auto mt-4 max-w-lg rounded-md border border-amber-200 bg-amber-50 p-3 text-left text-xs text-amber-700">
                <p className="mb-1 font-medium">
                  {importResult.errors.length} row{importResult.errors.length === 1 ? "" : "s"} had errors:
                </p>
                <ul className="list-disc space-y-0.5 pl-4">
                  {importResult.errors.map((e, i) => (
                    <li key={i}>{e}</li>
                  ))}
                </ul>
              </div>
            )}
            <div className="mt-5 flex justify-center gap-3">
              <button className="btn-secondary" onClick={reset}>
                Import another file
              </button>
              <a href="/pipeline" className="btn-primary">
                View Pipeline →
              </a>
            </div>
          </div>
        )}
      </div>

      {/* ---- Data Cleanup ---- */}
      <div className="card p-6">
        <h2 className="text-base font-semibold">Data Cleanup</h2>
        <p className="mt-1 text-sm text-slate-500">
          Remove bad records created by early extension versions.
        </p>

        <div className="mt-4 space-y-4">
          <div>
            <p className="text-sm text-slate-600">
              <strong>No-contact leads</strong> — have neither an email nor a phone number, so
              they can&apos;t be reached. Removes them from Prospecting.
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-3">
              <button className="btn-danger" onClick={runCleanup} disabled={cleaning}>
                {cleaning ? "Cleaning…" : "Delete no-contact leads"}
              </button>
              {cleanResult && <span className="text-sm text-slate-600">{cleanResult}</span>}
            </div>
          </div>

          <div className="border-t border-slate-100 pt-4">
            <p className="text-sm text-slate-600">
              <strong>Polluted-name leads</strong> — name is a LinkedIn button label like
              &quot;Connect&quot; or &quot;Message&quot;.
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-3">
              <button className="btn-danger" onClick={runPollutedCleanup} disabled={cleaningPolluted}>
                {cleaningPolluted ? "Cleaning…" : "Delete polluted-name leads"}
              </button>
              {pollutedResult && <span className="text-sm text-slate-600">{pollutedResult}</span>}
            </div>
          </div>
        </div>
      </div>

      {/* ---- Danger Zone ---- */}
      <div className="card border-red-200 p-6">
        <h2 className="text-base font-semibold text-red-700">Danger zone</h2>
        <p className="mt-1 text-sm text-slate-500">
          Wipe every lead, activity, note, task, call log, email, playbook enrollment, and
          extension job in this workspace. Pipeline stages, playbook definitions, custom fields,
          and settings are preserved — only captured data is removed.
        </p>
        <div className="mt-4 flex items-center gap-3">
          <button className="btn-danger" onClick={runWipe} disabled={wiping}>
            {wiping ? "Wiping…" : "Wipe all pipeline data"}
          </button>
          {wipeResult && <span className="text-sm text-slate-600">{wipeResult}</span>}
        </div>
      </div>
    </div>
  );
}
