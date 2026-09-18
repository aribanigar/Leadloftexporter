"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Check, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { api, ApiError } from "@/lib/api";
import { copyToClipboard } from "@/lib/utils";
import type { SheetConnection } from "@/lib/types";

interface AvailableTab {
  gid: string;
  title: string;
  configured: boolean;
}

interface PreviewResult {
  headers: string[];
  rows: string[][];
  row_count: number;
  guessed_email_column: string | null;
}

export default function SheetsPage() {
  const qc = useQueryClient();
  const [copied, setCopied] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [newConn, setNewConn] = useState<{ label: string; sheet_url: string } | null>(null);
  const [configuring, setConfiguring] = useState<string | null>(null); // connection id

  const { data: serviceEmail } = useQuery<{ email: string | null }>({
    queryKey: ["sheets-service-account-email"],
    queryFn: () => api("/sheets/service-account-email"),
  });
  const { data: connections } = useQuery<SheetConnection[]>({
    queryKey: ["sheet-connections"],
    queryFn: () => api("/sheets/connections"),
  });

  const createConnection = useMutation({
    mutationFn: () => api("/sheets/connections", { method: "POST", body: newConn }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sheet-connections"] });
      setNewConn(null);
      setErr(null);
    },
    onError: (e: unknown) => setErr(e instanceof ApiError ? e.message : "Could not connect that sheet"),
  });
  const deleteConnection = useMutation({
    mutationFn: (id: string) => api(`/sheets/connections/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sheet-connections"] }),
  });
  const deleteTab = useMutation({
    mutationFn: ({ connId, tabId }: { connId: string; tabId: string }) =>
      api(`/sheets/connections/${connId}/tabs/${tabId}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sheet-connections"] }),
  });

  return (
    <div className="card max-w-3xl p-6">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold">Google Sheets</h2>
          <p className="mt-1 text-xs text-slate-500">
            Connect a sheet to import Campaign recipients from it. The CRM keeps each contact&apos;s{" "}
            <em>last emailed</em> (or last contacted) date written back into the sheet automatically.
          </p>
        </div>
        <button className="btn-primary" onClick={() => setNewConn({ label: "", sheet_url: "" })}>
          <Plus className="h-4 w-4" /> Connect a sheet
        </button>
      </div>

      {serviceEmail?.email ? (
        <div className="mb-4 flex items-center justify-between rounded-md border border-slate-200 bg-slate-50 p-3 text-xs">
          <div>
            Share each sheet (as <strong>Editor</strong>) with:{" "}
            <code className="rounded bg-white px-1.5 py-0.5">{serviceEmail.email}</code>
          </div>
          <button
            className="btn-secondary"
            onClick={async () => {
              const ok = await copyToClipboard(serviceEmail.email!);
              if (ok) { setCopied(true); setTimeout(() => setCopied(false), 2000); }
            }}
          >
            {copied ? (<><Check className="h-3.5 w-3.5 text-emerald-600" /> Copied</>) : (<><Copy className="h-3.5 w-3.5" /> Copy</>)}
          </button>
        </div>
      ) : (
        <div className="mb-4 rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-700">
          Google Sheets isn&apos;t configured on the server yet — ask your admin to set{" "}
          <code>GOOGLE_SERVICE_ACCOUNT_JSON</code>.
        </div>
      )}

      {newConn && (
        <div className="mb-4 space-y-3 rounded-md border border-slate-200 p-3">
          <input
            className="input"
            placeholder="Label (e.g. Q3 Prospect List)"
            value={newConn.label}
            onChange={(e) => setNewConn({ ...newConn, label: e.target.value })}
          />
          <input
            className="input"
            placeholder="https://docs.google.com/spreadsheets/d/…"
            value={newConn.sheet_url}
            onChange={(e) => setNewConn({ ...newConn, sheet_url: e.target.value })}
          />
          {err && <p className="text-sm text-rose-600">{err}</p>}
          <div className="flex justify-end gap-2">
            <button className="btn-secondary" onClick={() => { setNewConn(null); setErr(null); }}>Cancel</button>
            <button
              className="btn-primary"
              disabled={!newConn.label.trim() || !newConn.sheet_url.trim() || createConnection.isPending}
              onClick={() => createConnection.mutate()}
            >
              {createConnection.isPending ? "Connecting…" : "Connect"}
            </button>
          </div>
        </div>
      )}

      <ul className="divide-y divide-slate-100">
        {connections?.map((c) => (
          <li key={c.id} className="py-3">
            <div className="flex items-center justify-between">
              <div>
                <div className="flex items-center gap-2 text-sm font-medium">
                  {c.label}
                  {c.status === "error" && (
                    <span className="rounded bg-rose-50 px-1.5 py-0.5 text-[11px] font-medium text-rose-600">
                      needs attention
                    </span>
                  )}
                </div>
                <div className="text-xs text-slate-500">{c.tabs.length} configured tab{c.tabs.length === 1 ? "" : "s"}</div>
                {c.status === "error" && c.last_error && (
                  <div className="mt-1 text-xs text-rose-600">{c.last_error}</div>
                )}
              </div>
              <div className="flex items-center gap-2">
                <button className="btn-secondary" onClick={() => setConfiguring(configuring === c.id ? null : c.id)}>
                  {configuring === c.id ? "Close" : "Configure sheets"}
                </button>
                <button className="rounded p-1 text-slate-400 hover:text-rose-500" onClick={() => deleteConnection.mutate(c.id)}>
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            </div>

            {c.tabs.length > 0 && (
              <ul className="mt-2 space-y-1">
                {c.tabs.map((t) => (
                  <li key={t.id} className="flex items-center justify-between rounded bg-slate-50 px-2 py-1 text-xs">
                    <span>
                      <strong>{t.title}</strong> — email: {t.email_column}, tracking: {t.tracking_column} ({t.row_count} rows)
                    </span>
                    <button
                      className="text-slate-400 hover:text-rose-500"
                      onClick={() => deleteTab.mutate({ connId: c.id, tabId: t.id })}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
            )}

            {configuring === c.id && <ConfigureTabs connection={c} onDone={() => setConfiguring(null)} />}
          </li>
        ))}
        {connections && connections.length === 0 && (
          <li className="py-6 text-center text-sm text-slate-400">No sheets connected yet.</li>
        )}
      </ul>
    </div>
  );
}

function ConfigureTabs({ connection, onDone }: { connection: SheetConnection; onDone: () => void }) {
  const qc = useQueryClient();
  const [selectedGid, setSelectedGid] = useState<string | null>(null);
  const [emailColumn, setEmailColumn] = useState("");
  const [trackingColumn, setTrackingColumn] = useState("Last Contacted");
  const [err, setErr] = useState<string | null>(null);

  const { data: tabs, isLoading: tabsLoading } = useQuery<AvailableTab[]>({
    queryKey: ["sheet-tabs-available", connection.id],
    queryFn: () => api(`/sheets/connections/${connection.id}/tabs/available`),
  });
  const { data: preview } = useQuery<PreviewResult>({
    queryKey: ["sheet-tab-preview", connection.id, selectedGid],
    queryFn: () => api(`/sheets/connections/${connection.id}/tabs/${selectedGid}/preview`),
    enabled: !!selectedGid,
  });

  const save = useMutation({
    mutationFn: () => {
      const tab = tabs?.find((t) => t.gid === selectedGid);
      return api(`/sheets/connections/${connection.id}/tabs`, {
        method: "POST",
        body: {
          gid: selectedGid,
          title: tab?.title || "",
          email_column: emailColumn || undefined,
          tracking_column: trackingColumn,
        },
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sheet-connections"] });
      qc.invalidateQueries({ queryKey: ["sheet-tabs-available", connection.id] });
      setSelectedGid(null);
      setEmailColumn("");
      setErr(null);
    },
    onError: (e: unknown) => setErr(e instanceof ApiError ? e.message : "Could not save that tab"),
  });

  return (
    <div className="mt-3 rounded-md border border-slate-200 p-3">
      {tabsLoading && <p className="text-xs text-slate-400">Loading sheet tabs…</p>}
      {tabs && !selectedGid && (
        <div className="space-y-1">
          <p className="mb-2 text-xs text-slate-500">Pick a tab to import from:</p>
          {tabs.map((t) => (
            <button
              key={t.gid}
              className="flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-sm hover:bg-slate-50 disabled:opacity-40"
              disabled={t.configured}
              onClick={() => { setSelectedGid(t.gid); setEmailColumn(""); }}
            >
              <span>{t.title}</span>
              {t.configured && <span className="text-xs text-slate-400">already configured</span>}
            </button>
          ))}
        </div>
      )}

      {selectedGid && preview && (
        <div className="space-y-3">
          <div>
            <label className="label">Email column</label>
            <select
              className="input"
              value={emailColumn || preview.guessed_email_column || ""}
              onChange={(e) => setEmailColumn(e.target.value)}
            >
              {preview.headers.map((h) => (
                <option key={h} value={h}>{h}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">Tracking column name (auto-added if missing)</label>
            <input className="input" value={trackingColumn} onChange={(e) => setTrackingColumn(e.target.value)} />
          </div>
          <div className="overflow-x-auto rounded border border-slate-100">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-slate-50">
                  {preview.headers.map((h) => (
                    <th key={h} className="whitespace-nowrap px-2 py-1 text-left font-medium">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {preview.rows.slice(0, 5).map((row, i) => (
                  <tr key={i} className="border-t border-slate-100">
                    {row.map((cell, j) => (
                      <td key={j} className="whitespace-nowrap px-2 py-1">{cell}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="border-t border-slate-100 px-2 py-1 text-[11px] text-slate-400">
              {preview.row_count} total rows
            </div>
          </div>
          {err && <p className="text-sm text-rose-600">{err}</p>}
          <div className="flex justify-end gap-2">
            <button className="btn-secondary" onClick={() => setSelectedGid(null)}>Back</button>
            <button className="btn-primary" disabled={save.isPending} onClick={() => save.mutate()}>
              {save.isPending ? "Saving…" : "Save tab"}
            </button>
          </div>
        </div>
      )}

      <div className="mt-3 flex justify-end">
        <button className="text-xs text-slate-400 hover:underline" onClick={onDone}>Close</button>
      </div>
    </div>
  );
}
