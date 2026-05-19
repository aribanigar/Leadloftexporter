"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, KeyRound, Trash2 } from "lucide-react";
import { useState } from "react";
import { api } from "@/lib/api";

interface ApiKeyRow {
  id: string;
  name: string;
  key_prefix: string;
  last_used_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

export default function ApiKeysPage() {
  const qc = useQueryClient();
  const { data: keys } = useQuery<ApiKeyRow[]>({
    queryKey: ["api-keys"],
    queryFn: () => api("/workspaces/current/api-keys"),
  });

  const [created, setCreated] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: (name: string) =>
      api<{ key: string }>("/workspaces/current/api-keys", { method: "POST", body: { name } }),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["api-keys"] });
      setCreated(res.key);
    },
  });

  const revoke = useMutation({
    mutationFn: (id: string) => api(`/workspaces/current/api-keys/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["api-keys"] }),
  });

  return (
    <div className="card max-w-3xl p-6">
      <h2 className="mb-1 text-base font-semibold">API Keys</h2>
      <p className="mb-6 text-sm text-slate-500">
        Used by the LeadCaptura Chrome extension and external integrations to sync leads and execute actions.
      </p>

      {created && (
        <div className="mb-6 rounded-md border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          <div className="mb-2 font-medium">Save this key — it won&apos;t be shown again.</div>
          <div className="flex items-center gap-2">
            <code className="flex-1 break-all rounded bg-white px-2 py-1 font-mono text-xs">{created}</code>
            <button
              className="btn-secondary"
              onClick={() => {
                void navigator.clipboard.writeText(created);
              }}
            >
              <Copy className="h-4 w-4" /> Copy
            </button>
          </div>
          <button className="mt-2 text-amber-700 underline" onClick={() => setCreated(null)}>
            Dismiss
          </button>
        </div>
      )}

      <button
        className="btn-primary mb-4"
        onClick={() => create.mutate("Chrome Extension")}
        disabled={create.isPending}
      >
        <KeyRound className="h-4 w-4" /> {create.isPending ? "Creating…" : "Generate new key"}
      </button>

      <table className="w-full text-sm">
        <thead className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
          <tr>
            <th className="py-2">Name</th>
            <th className="py-2">Prefix</th>
            <th className="py-2">Last used</th>
            <th className="py-2">Status</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {keys?.map((k) => (
            <tr key={k.id} className="border-b border-slate-100">
              <td className="py-2">{k.name}</td>
              <td className="py-2 font-mono text-xs">{k.key_prefix}…</td>
              <td className="py-2 text-slate-500">{k.last_used_at ? new Date(k.last_used_at).toLocaleString() : "Never"}</td>
              <td className="py-2">
                {k.revoked_at ? (
                  <span className="pill bg-rose-100 text-rose-700">Revoked</span>
                ) : (
                  <span className="pill bg-emerald-100 text-emerald-700">Active</span>
                )}
              </td>
              <td className="py-2 text-right">
                {!k.revoked_at && (
                  <button
                    className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-rose-500"
                    onClick={() => revoke.mutate(k.id)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                )}
              </td>
            </tr>
          ))}
          {keys?.length === 0 && (
            <tr>
              <td colSpan={5} className="py-6 text-center text-slate-500">
                No API keys yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
