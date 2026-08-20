"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import {
  Check,
  Copy,
  KeyRound,
  RotateCcw,
  Search,
  ShieldCheck,
  ShieldOff,
  Trash2,
} from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { copyToClipboard } from "@/lib/utils";

// Mirrors the backend restriction in api/app/api/v1/licenses.py::create_license_key.
// Every signup is auto-made "owner" of their own trial workspace, so the
// owner/admin role check alone doesn't stop self-issued license keys — this
// keeps the UI in sync with that server-side gate (a UX nicety, not the gate
// itself).
const LICENSE_KEY_ISSUER_EMAIL = "acemedia.qa@gmail.com";

interface TeamMember {
  membership_id: string;
  user_id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  role: string;
}

interface LicenseKeyRow {
  id: string;
  label: string | null;
  key_prefix: string;
  status: "active" | "expired" | "revoked";
  assigned_user_id: string | null;
  assigned_user_email: string | null;
  assigned_user_name: string | null;
  expires_at: string | null;
  last_used_at: string | null;
  created_at: string;
  revoked_at: string | null;
}

interface RevealedKey {
  id: string;
  label: string | null;
  key: string;
}

// ── Expiry duration picker ───────────────────────────────────────────────
// "how many days or months should this be valid for" is a much easier
// question for an admin to answer than "pick a calendar date" — presets
// cover the common cases in one click, Custom covers everything else.
type ExpiryPresetKey = "none" | "30d" | "90d" | "6m" | "1y" | "custom";

const EXPIRY_PRESETS: { key: ExpiryPresetKey; label: string }[] = [
  { key: "none", label: "No expiry" },
  { key: "30d", label: "30 days" },
  { key: "90d", label: "90 days" },
  { key: "6m", label: "6 months" },
  { key: "1y", label: "1 year" },
  { key: "custom", label: "Custom" },
];

function addDays(base: Date, days: number): Date {
  const d = new Date(base);
  d.setDate(d.getDate() + days);
  return d;
}
function addMonths(base: Date, months: number): Date {
  const d = new Date(base);
  d.setMonth(d.getMonth() + months);
  return d;
}

function computeExpiry(
  mode: ExpiryPresetKey,
  customAmount: number,
  customUnit: "days" | "months"
): Date | null {
  const now = new Date();
  switch (mode) {
    case "none":
      return null;
    case "30d":
      return addDays(now, 30);
    case "90d":
      return addDays(now, 90);
    case "6m":
      return addMonths(now, 6);
    case "1y":
      return addMonths(now, 12);
    case "custom": {
      const n = Math.max(1, Math.floor(customAmount) || 1);
      return customUnit === "months" ? addMonths(now, n) : addDays(now, n);
    }
  }
}

function statusPillClass(status: string) {
  if (status === "active") return "bg-emerald-50 text-emerald-700";
  if (status === "expired") return "bg-amber-100 text-amber-800";
  return "bg-rose-50 text-rose-600";
}

function fmt(dt: string | Date | null) {
  if (!dt) return "—";
  return new Date(dt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

// Relative "expires in N days" / "expired N days ago" line for the table,
// color-coded so an admin can spot keys about to lapse at a glance.
function expiryMeta(expiresAt: string | null): { text: string; cls: string } | null {
  if (!expiresAt) return null;
  const diffDays = Math.round((new Date(expiresAt).getTime() - Date.now()) / 86_400_000);
  if (diffDays < 0) return { text: `Expired ${Math.abs(diffDays)}d ago`, cls: "text-rose-600" };
  if (diffDays === 0) return { text: "Expires today", cls: "text-amber-600" };
  if (diffDays <= 14) return { text: `Expires in ${diffDays}d`, cls: "text-amber-600" };
  return { text: `${diffDays}d left`, cls: "text-slate-400" };
}

function displayName(m: { first_name?: string | null; last_name?: string | null; email: string }) {
  return `${m.first_name || ""} ${m.last_name || ""}`.trim() || m.email;
}

const DEFAULT_FORM = {
  label: "",
  assigned_user_id: "",
  expiryMode: "none" as ExpiryPresetKey,
  customAmount: 30,
  customUnit: "days" as "days" | "months",
};

export default function LicenseKeysPage() {
  const qc = useQueryClient();
  const { workspace, user } = useAuth();
  const canIssueKeys = (user?.email || "").trim().toLowerCase() === LICENSE_KEY_ISSUER_EMAIL;
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState(DEFAULT_FORM);
  const [revealed, setRevealed] = useState<RevealedKey | null>(null);
  const [copiedKeyId, setCopiedKeyId] = useState<string | null>(null);
  const [copiedPrefixId, setCopiedPrefixId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const {
    data: keys,
    isLoading,
    error: listError,
  } = useQuery<LicenseKeyRow[]>({
    queryKey: ["license-keys"],
    queryFn: () => api("/workspaces/current/license-keys"),
  });

  const { data: members } = useQuery<TeamMember[]>({
    queryKey: ["team-members"],
    queryFn: () => api("/workspaces/current/members"),
  });

  function extractDetail(e: unknown): string {
    if (e instanceof ApiError && e.body && typeof e.body === "object" && "detail" in (e.body as Record<string, unknown>)) {
      return String((e.body as Record<string, unknown>).detail);
    }
    return (e as Error)?.message || "Something went wrong.";
  }

  const previewExpiry = computeExpiry(form.expiryMode, form.customAmount, form.customUnit);

  const create = useMutation({
    mutationFn: (body: typeof form) =>
      api<LicenseKeyRow & { key: string }>("/workspaces/current/license-keys", {
        method: "POST",
        body: {
          label: body.label.trim() || undefined,
          assigned_user_id: body.assigned_user_id || undefined,
          expires_at: computeExpiry(body.expiryMode, body.customAmount, body.customUnit)?.toISOString(),
        },
      }),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["license-keys"] });
      setRevealed({ id: res.id, label: res.label, key: res.key });
      setForm(DEFAULT_FORM);
      setShowAdd(false);
      setError(null);
    },
    onError: (e) => {
      const msg = extractDetail(e);
      setError(
        msg === "assignee_not_in_workspace"
          ? "That teammate isn't in this workspace."
          : msg === "license_key_creation_restricted"
          ? "Only the account holder can generate license keys."
          : msg
      );
    },
  });

  const reset = useMutation({
    mutationFn: (id: string) => api<LicenseKeyRow & { key: string }>(`/workspaces/current/license-keys/${id}/reset`, { method: "POST" }),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["license-keys"] });
      setRevealed({ id: res.id, label: res.label, key: res.key });
    },
  });

  const toggleStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: "active" | "revoked" }) =>
      api(`/workspaces/current/license-keys/${id}`, { method: "PATCH", body: { status } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["license-keys"] }),
  });

  const reassign = useMutation({
    mutationFn: ({ id, assigned_user_id }: { id: string; assigned_user_id: string }) =>
      api(`/workspaces/current/license-keys/${id}`, {
        method: "PATCH",
        body: assigned_user_id ? { assigned_user_id } : { clear_assigned_user: true },
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["license-keys"] }),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api(`/workspaces/current/license-keys/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["license-keys"] }),
  });

  const isManager = workspace?.role === "owner" || workspace?.role === "admin";
  const forbidden = listError instanceof ApiError && listError.status === 403;

  const filteredKeys = useMemo(() => {
    if (!keys) return keys;
    const q = query.trim().toLowerCase();
    if (!q) return keys;
    return keys.filter((k) =>
      [k.label, k.key_prefix, k.assigned_user_name, k.assigned_user_email]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q))
    );
  }, [keys, query]);

  const counts = useMemo(() => {
    const c = { active: 0, expired: 0, revoked: 0 };
    for (const k of keys || []) c[k.status]++;
    return c;
  }, [keys]);

  async function copyPrefix(k: LicenseKeyRow) {
    const ok = await copyToClipboard(`${k.key_prefix}…`);
    if (ok) {
      setCopiedPrefixId(k.id);
      setTimeout(() => setCopiedPrefixId((id) => (id === k.id ? null : id)), 1500);
    }
  }

  if (forbidden || !isManager) {
    return (
      <div className="card max-w-3xl p-6">
        <h2 className="text-base font-semibold">License Keys</h2>
        <p className="mt-2 text-sm text-slate-500">
          Only the workspace owner or an admin can view and manage license keys.
        </p>
      </div>
    );
  }

  return (
    <div className="card max-w-4xl p-6">
      <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h2 className="text-base font-semibold">License Keys</h2>
          {!!keys?.length && (
            <span className="flex items-center gap-1.5 text-xs text-slate-500">
              <span className="pill bg-emerald-50 text-emerald-700">{counts.active} active</span>
              {counts.expired > 0 && <span className="pill bg-amber-100 text-amber-800">{counts.expired} expired</span>}
              {counts.revoked > 0 && <span className="pill bg-rose-50 text-rose-600">{counts.revoked} revoked</span>}
            </span>
          )}
        </div>
        {canIssueKeys && (
          <button className="btn-primary" onClick={() => { setShowAdd((v) => !v); setError(null); }}>
            <KeyRound className="h-4 w-4" /> Generate license key
          </button>
        )}
      </div>
      {!canIssueKeys && (
        <p className="mb-4 text-sm text-slate-500">
          Only the account holder can generate license keys. Existing keys below can still be managed.
        </p>
      )}
      <p className="mb-6 text-sm text-slate-500">
        The Chrome extension only activates once it has BOTH a personal API key (each person
        generates their own from their own account in <b>Settings → API Keys</b> — that&apos;s what
        makes captured leads save to their account) AND a license key from here. A license key is
        your control switch: give one to each person you want to use the extension, set an
        optional expiry, and revoke, reset, or delete it any time — no need to touch their login or
        their API key.
      </p>

      {revealed && (
        <div className="mb-6 rounded-md border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          <div className="mb-2 font-medium">
            License key {revealed.label ? `“${revealed.label}” ` : ""}— copy it now, it won&apos;t be shown again.
          </div>
          <div className="flex items-center gap-2">
            <code className="flex-1 break-all rounded bg-white px-2 py-1 font-mono text-xs">{revealed.key}</code>
            <button
              className="btn-secondary"
              onClick={async () => {
                const ok = await copyToClipboard(revealed.key);
                if (ok) { setCopiedKeyId(revealed.id); setTimeout(() => setCopiedKeyId((id) => (id === revealed.id ? null : id)), 2000); }
              }}
            >
              {copiedKeyId === revealed.id ? (<><Check className="h-4 w-4 text-emerald-600" /> Copied</>) : (<><Copy className="h-4 w-4" /> Copy</>)}
            </button>
          </div>
          <button className="mt-2 text-amber-700 underline" onClick={() => setRevealed(null)}>
            Dismiss
          </button>
        </div>
      )}

      {canIssueKeys && showAdd && (
        <form
          className="mb-6 grid grid-cols-2 gap-3 rounded-md border border-slate-200 p-4"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate(form);
          }}
        >
          <label className="col-span-2 text-sm">
            <span className="mb-1 block text-slate-600">Label (optional)</span>
            <input
              className="input w-full"
              value={form.label}
              onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))}
              placeholder="e.g. Jane's laptop"
            />
          </label>
          <label className="col-span-2 text-sm sm:col-span-1">
            <span className="mb-1 block text-slate-600">Assign to (optional)</span>
            <select
              className="input w-full"
              value={form.assigned_user_id}
              onChange={(e) => setForm((f) => ({ ...f, assigned_user_id: e.target.value }))}
            >
              <option value="">Unassigned — anyone in this workspace</option>
              {members?.map((m) => (
                <option key={m.user_id} value={m.user_id}>
                  {displayName(m)} ({m.email})
                </option>
              ))}
            </select>
          </label>

          <div className="col-span-2">
            <span className="mb-1 block text-sm text-slate-600">Valid for</span>
            <div className="flex flex-wrap gap-1.5">
              {EXPIRY_PRESETS.map((p) => (
                <button
                  key={p.key}
                  type="button"
                  className={`rounded-full border px-3 py-1 text-xs font-medium transition ${
                    form.expiryMode === p.key
                      ? "border-brand-500 bg-brand-50 text-brand-700"
                      : "border-slate-200 text-slate-600 hover:border-slate-300"
                  }`}
                  onClick={() => setForm((f) => ({ ...f, expiryMode: p.key }))}
                >
                  {p.label}
                </button>
              ))}
            </div>

            {form.expiryMode === "custom" && (
              <div className="mt-2 flex items-center gap-2">
                <input
                  type="number"
                  min={1}
                  className="input w-24"
                  value={form.customAmount}
                  onChange={(e) => setForm((f) => ({ ...f, customAmount: Number(e.target.value) }))}
                />
                <select
                  className="input w-32"
                  value={form.customUnit}
                  onChange={(e) => setForm((f) => ({ ...f, customUnit: e.target.value as "days" | "months" }))}
                >
                  <option value="days">Days</option>
                  <option value="months">Months</option>
                </select>
              </div>
            )}

            <p className="mt-1.5 text-xs text-slate-500">
              {previewExpiry ? <>Expires <b>{fmt(previewExpiry)}</b></> : "Never expires."}
            </p>
          </div>

          {error && <div className="col-span-2 text-sm text-rose-600">{error}</div>}
          <div className="col-span-2 flex gap-2">
            <button type="submit" className="btn-primary" disabled={create.isPending}>
              <KeyRound className="h-4 w-4" /> {create.isPending ? "Generating…" : "Generate key"}
            </button>
            <button type="button" className="btn-secondary" onClick={() => { setShowAdd(false); setForm(DEFAULT_FORM); }}>
              Cancel
            </button>
          </div>
        </form>
      )}

      {!!keys?.length && (
        <div className="relative mb-3">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input
            className="input w-full pl-8 sm:w-64"
            placeholder="Search by label or person…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="py-2">Label / key</th>
              <th className="py-2">Status</th>
              <th className="py-2">Assigned to</th>
              <th className="py-2">Expires</th>
              <th className="py-2">Last used</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {filteredKeys?.map((k) => {
              const meta = expiryMeta(k.expires_at);
              return (
                <tr key={k.id} className="border-b border-slate-100">
                  <td className="py-2">
                    <div className="font-medium">{k.label || <span className="text-slate-400">Untitled</span>}</div>
                    <button
                      className="group inline-flex items-center gap-1 font-mono text-xs text-slate-400 hover:text-brand-600"
                      title="Copy key prefix (the full secret is only shown once, at creation)"
                      onClick={() => copyPrefix(k)}
                    >
                      {k.key_prefix}…
                      {copiedPrefixId === k.id ? (
                        <Check className="h-3 w-3 text-emerald-600" />
                      ) : (
                        <Copy className="h-3 w-3 opacity-0 transition-opacity group-hover:opacity-100" />
                      )}
                    </button>
                  </td>
                  <td className="py-2">
                    <span className={`pill ${statusPillClass(k.status)}`}>{k.status}</span>
                  </td>
                  <td className="py-2">
                    <select
                      className="input py-1 text-xs"
                      value={k.assigned_user_id || ""}
                      disabled={reassign.isPending}
                      onChange={(e) => reassign.mutate({ id: k.id, assigned_user_id: e.target.value })}
                    >
                      <option value="">Unassigned</option>
                      {members?.map((m) => (
                        <option key={m.user_id} value={m.user_id}>
                          {displayName(m)}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="py-2 text-slate-500">
                    {k.expires_at ? (
                      <div title={fmt(k.expires_at)}>
                        <div>{fmt(k.expires_at)}</div>
                        {meta && <div className={`text-xs ${meta.cls}`}>{meta.text}</div>}
                      </div>
                    ) : (
                      "Never"
                    )}
                  </td>
                  <td className="py-2 text-slate-500">{fmt(k.last_used_at)}</td>
                  <td className="py-2">
                    <div className="flex items-center justify-end gap-1">
                      <button
                        className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-brand-600"
                        title="Reset — issue a new key, invalidating this one"
                        onClick={() => {
                          if (confirm("Generate a new secret for this key? The old one stops working immediately.")) {
                            reset.mutate(k.id);
                          }
                        }}
                      >
                        <RotateCcw className="h-4 w-4" />
                      </button>
                      {k.status === "revoked" ? (
                        <button
                          className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-emerald-600"
                          title="Reactivate"
                          onClick={() => toggleStatus.mutate({ id: k.id, status: "active" })}
                        >
                          <ShieldCheck className="h-4 w-4" />
                        </button>
                      ) : (
                        <button
                          className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-amber-600"
                          title="Revoke"
                          onClick={() => toggleStatus.mutate({ id: k.id, status: "revoked" })}
                        >
                          <ShieldOff className="h-4 w-4" />
                        </button>
                      )}
                      <button
                        className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-rose-500"
                        title="Delete"
                        onClick={() => {
                          if (confirm("Delete this license key permanently? Anyone using it will be locked out immediately.")) {
                            remove.mutate(k.id);
                          }
                        }}
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
            {!isLoading && keys?.length === 0 && (
              <tr>
                <td colSpan={6} className="py-6 text-center text-slate-500">
                  No license keys yet — generate one to give someone access to the extension.
                </td>
              </tr>
            )}
            {!isLoading && keys && keys.length > 0 && filteredKeys?.length === 0 && (
              <tr>
                <td colSpan={6} className="py-6 text-center text-slate-500">
                  No keys match “{query}”.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
