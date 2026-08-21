"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, KeyRound, Trash2 } from "lucide-react";
import { useState } from "react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { copyToClipboard } from "@/lib/utils";

// Every user can self-serve an API key for their OWN account (that's what
// connects the extension to their own workspace). Issuing one for someone
// ELSE stays admin-only — mirrors api/app/api/v1/workspaces.py::create_api_key.
// Keeping this in sync is a UX nicety (hides the teammate picker that would
// 403 for anyone else), not the actual gate — the backend enforces it
// regardless of this check.
const LICENSED_API_KEY_ADMIN_EMAIL = "acemedia.qa@gmail.com";

interface ApiKeyRow {
  id: string;
  name: string;
  key_prefix: string;
  last_used_at: string | null;
  revoked_at: string | null;
  created_at: string;
  user_email?: string;
}

interface TeamMember {
  membership_id: string;
  user_id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
}

export default function ApiKeysPage() {
  const qc = useQueryClient();
  const { user } = useAuth();
  // Everyone can create a key for themselves; only the admin additionally
  // sees the "For <teammate>" picker to issue on someone else's behalf.
  const canManageOthers = (user?.email || "").trim().toLowerCase() === LICENSED_API_KEY_ADMIN_EMAIL;
  const { data: keys } = useQuery<ApiKeyRow[]>({
    queryKey: ["api-keys"],
    queryFn: () => api("/workspaces/current/api-keys"),
  });
  // Lets the admin issue a key ON BEHALF OF a teammate — the key still
  // belongs to that teammate's own account (ApiKey.user_id -> Lead.owner_id
  // is what makes their captured leads save to them), the admin just hands
  // it to them directly instead of them self-serving it. Only fetched for
  // the admin: /workspaces/current/members is itself owner/admin-gated, and
  // a non-admin has no use for the picker anyway.
  const { data: members } = useQuery<TeamMember[]>({
    queryKey: ["team-members"],
    queryFn: () => api("/workspaces/current/members"),
    enabled: canManageOthers,
  });

  const [created, setCreated] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [forUserId, setForUserId] = useState("");

  // For a non-admin, every row in `keys` is already their own (self-scoped
  // by the backend). For the admin, rows now include teammates' keys too
  // (each tagged with user_email) — "Wipe my keys" only ever deletes the
  // caller's own (wipe_api_keys is unchanged), so this count must match
  // that, not the full list length, or the confirm dialog would overstate
  // what's about to happen.
  const ownKeyCount = canManageOthers
    ? (keys?.filter((k) => !k.user_email || k.user_email.toLowerCase() === (user?.email || "").toLowerCase()).length ?? 0)
    : (keys?.length ?? 0);

  const create = useMutation({
    mutationFn: (name: string) =>
      api<{ key: string }>("/workspaces/current/api-keys", {
        method: "POST",
        body: forUserId ? { name, user_id: forUserId } : { name },
      }),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["api-keys"] });
      setCreated(res.key);
      setCreateError(null);
      setForUserId("");
    },
    onError: () => setCreateError("Only your admin can issue a key for someone else."),
  });

  const revoke = useMutation({
    mutationFn: (id: string) => api(`/workspaces/current/api-keys/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["api-keys"] }),
  });

  const wipeAll = useMutation({
    mutationFn: () =>
      api<{ deleted: number }>("/workspaces/current/api-keys", { method: "DELETE" }),
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
              onClick={async () => {
                const ok = await copyToClipboard(created);
                if (ok) {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                }
              }}
            >
              {copied ? (
                <>
                  <Check className="h-4 w-4 text-emerald-600" /> Copied
                </>
              ) : (
                <>
                  <Copy className="h-4 w-4" /> Copy
                </>
              )}
            </button>
          </div>
          <button className="mt-2 text-amber-700 underline" onClick={() => setCreated(null)}>
            Dismiss
          </button>
        </div>
      )}

      {createError && (
        <div className="mb-4 rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
          {createError}
        </div>
      )}

      <div className="mb-4 flex flex-wrap items-center gap-2">
        {canManageOthers && (
          <select
            className="input py-1.5 text-sm"
            value={forUserId}
            onChange={(e) => setForUserId(e.target.value)}
          >
            <option value="">For myself</option>
            {members
              ?.filter((m) => m.email.toLowerCase() !== (user?.email || "").toLowerCase())
              .map((m) => (
                <option key={m.user_id} value={m.user_id}>
                  For {(`${m.first_name || ""} ${m.last_name || ""}`.trim() || m.email)} ({m.email})
                </option>
              ))}
          </select>
        )}
        <button
          className="btn-primary"
          onClick={() => create.mutate("Chrome Extension")}
          disabled={create.isPending}
        >
          <KeyRound className="h-4 w-4" /> {create.isPending ? "Creating…" : "Generate new key"}
        </button>
        {ownKeyCount > 0 && (
          <button
            className="btn-danger"
            onClick={() => {
              if (
                confirm(
                  `Delete all ${ownKeyCount} of your own API key${ownKeyCount === 1 ? "" : "s"}? Any extension or integration using ${ownKeyCount === 1 ? "it" : "them"} will stop working. This cannot be undone.${canManageOthers ? " (Keys issued to teammates are untouched.)" : ""}`
                )
              ) {
                wipeAll.mutate();
              }
            }}
            disabled={wipeAll.isPending}
          >
            <Trash2 className="h-4 w-4" />{" "}
            {wipeAll.isPending ? "Wiping…" : "Wipe my keys"}
          </button>
        )}
      </div>

      <table className="w-full text-sm">
        <thead className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
          <tr>
            <th className="py-2">Name</th>
            {canManageOthers && <th className="py-2">For</th>}
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
              {canManageOthers && <td className="py-2 text-slate-500">{k.user_email || "—"}</td>}
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
              <td colSpan={canManageOthers ? 6 : 5} className="py-6 text-center text-slate-500">
                No API keys yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
