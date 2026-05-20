"use client";

import { useState } from "react";
import { api } from "@/lib/api";

export default function ImportPage() {
  const [cleaning, setCleaning] = useState(false);
  const [cleanResult, setCleanResult] = useState<string | null>(null);

  async function runCleanup() {
    if (!confirm("Delete all nameless extension leads? This cannot be undone.")) return;
    setCleaning(true);
    setCleanResult(null);
    try {
      const res = await api<{ deleted: number }>("/leads/cleanup/nameless", {
        method: "DELETE",
      });
      setCleanResult(`Deleted ${res.deleted} blank lead${res.deleted !== 1 ? "s" : ""}.`);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setCleanResult(`Error: ${msg}`);
    } finally {
      setCleaning(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="card max-w-3xl p-6">
        <h2 className="text-base font-semibold">Import Data</h2>
        <p className="mt-2 text-sm text-slate-500">
          Drop a CSV here to bulk-import leads. (CSV mapping UI coming next.)
        </p>
      </div>

      <div className="card max-w-3xl p-6">
        <h2 className="text-base font-semibold">Data Cleanup</h2>
        <p className="mt-2 text-sm text-slate-500">
          Remove blank leads — records that have a LinkedIn URL but no name.
          These are created when the extension enrichment tab scraped a profile
          before it had finished loading, and they appear as &quot;—&quot; rows in your
          pipeline alongside the real named lead for the same person.
        </p>
        <div className="mt-4 flex items-center gap-3">
          <button
            className="btn-danger"
            onClick={runCleanup}
            disabled={cleaning}
          >
            {cleaning ? "Cleaning…" : "Delete blank leads"}
          </button>
          {cleanResult && (
            <span className="text-sm text-slate-600">{cleanResult}</span>
          )}
        </div>
      </div>
    </div>
  );
}
