"use client";

import { useState } from "react";
import { api } from "@/lib/api";

type WipeResult = { deleted: Record<string, number> };

export default function ImportPage() {
  const [cleaning, setCleaning] = useState(false);
  const [cleanResult, setCleanResult] = useState<string | null>(null);
  const [wiping, setWiping] = useState(false);
  const [wipeResult, setWipeResult] = useState<string | null>(null);
  const [cleaningPolluted, setCleaningPolluted] = useState(false);
  const [pollutedResult, setPollutedResult] = useState<string | null>(null);

  async function runPollutedCleanup() {
    if (
      !confirm(
        'Delete all leads where the name is actually a LinkedIn button label ("View LinkedIn profile", "Connect", "Message", etc.)? This cannot be undone.'
      )
    )
      return;
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

  async function runWipe() {
    const confirm1 = confirm(
      "Wipe ALL pipeline data?\n\nThis deletes every lead, activity, note, task, call log, email, playbook enrollment, and extension job in this workspace.\n\nPipeline stages, playbook definitions, custom fields, and settings stay intact.\n\nThis cannot be undone."
    );
    if (!confirm1) return;
    const typed = prompt('Type "WIPE" to confirm:');
    if (typed !== "WIPE") return;

    setWiping(true);
    setWipeResult(null);
    try {
      const res = await api<WipeResult>("/leads/cleanup/wipe-pipeline", {
        method: "DELETE",
      });
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
        <div className="mt-4 flex flex-wrap items-center gap-3">
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
        <p className="mt-4 text-sm text-slate-500">
          Remove leads where the name is actually a LinkedIn button label
          like &quot;View LinkedIn profile&quot;, &quot;Connect&quot;, or
          &quot;Message&quot; — the result of older extension versions
          scraping the wrong DOM element.
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button
            className="btn-danger"
            onClick={runPollutedCleanup}
            disabled={cleaningPolluted}
          >
            {cleaningPolluted ? "Cleaning…" : "Delete polluted-name leads"}
          </button>
          {pollutedResult && (
            <span className="text-sm text-slate-600">{pollutedResult}</span>
          )}
        </div>
      </div>

      <div className="card max-w-3xl border-red-200 p-6">
        <h2 className="text-base font-semibold text-red-700">Danger zone</h2>
        <p className="mt-2 text-sm text-slate-500">
          Wipe every lead, activity, note, task, call log, email, playbook
          enrollment, and extension job in this workspace. Use this to start
          fresh after a bad capture session. Pipeline stages, playbook
          definitions, custom fields, and other settings are preserved — only
          the captured data is removed.
        </p>
        <div className="mt-4 flex items-center gap-3">
          <button className="btn-danger" onClick={runWipe} disabled={wiping}>
            {wiping ? "Wiping…" : "Wipe all pipeline data"}
          </button>
          {wipeResult && (
            <span className="text-sm text-slate-600">{wipeResult}</span>
          )}
        </div>
      </div>
    </div>
  );
}
