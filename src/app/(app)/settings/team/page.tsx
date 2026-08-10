"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Check, Copy, Mail, Trash2, UserPlus, Users } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { copyToClipboard } from "@/lib/utils";

interface TeamMember {
  membership_id: string;
  user_id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  role: string;
  campaign_count: number;
  created_at: string;
}

const ROLE_LABEL: Record<string, string> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member (full access)",
  campaigns_only: "Campaigns only",
};

const ASSIGNABLE_ROLES = ["campaigns_only", "member", "admin"] as const;

function roleBadgeClass(role: string) {
  if (role === "owner") return "bg-brand-100 text-brand-700";
  if (role === "admin") return "bg-violet-100 text-violet-700";
  if (role === "campaigns_only") return "bg-amber-100 text-amber-800";
  return "bg-slate-100 text-slate-600";
}

export default function TeamPage() {
  const qc = useQueryClient();
  const { user, workspace } = useAuth();
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({
    email: "",
    password: "",
    first_name: "",
    last_name: "",
    role: "campaigns_only" as string,
  });
  const [justCreated, setJustCreated] = useState<{ email: string; password: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const {
    data: members,
    isLoading,
    error: listError,
  } = useQuery<TeamMember[]>({
    queryKey: ["team-members"],
    queryFn: () => api("/workspaces/current/members"),
  });

  const create = useMutation({
    mutationFn: (body: typeof form) =>
      api<TeamMember>("/workspaces/current/members", { method: "POST", body }),
    onSuccess: (_res, vars) => {
      qc.invalidateQueries({ queryKey: ["team-members"] });
      setJustCreated({ email: vars.email, password: vars.password });
      setForm({ email: "", password: "", first_name: "", last_name: "", role: "campaigns_only" });
      setShowAdd(false);
      setError(null);
    },
    onError: (e) => {
      const msg = e instanceof ApiError && e.body && typeof e.body === "object" && "detail" in (e.body as Record<string, unknown>)
        ? String((e.body as Record<string, unknown>).detail)
        : (e as Error).message;
      setError(
        msg === "email_in_use"
          ? "That email already has a LeadCaptura account."
          : msg || "Couldn't create the account."
      );
    },
  });

  const changeRole = useMutation({
    mutationFn: ({ membershipId, role }: { membershipId: string; role: string }) =>
      api(`/workspaces/current/members/${membershipId}`, { method: "PATCH", body: { role } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["team-members"] }),
  });

  const remove = useMutation({
    mutationFn: (membershipId: string) =>
      api(`/workspaces/current/members/${membershipId}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["team-members"] }),
  });

  const isManager = workspace?.role === "owner" || workspace?.role === "admin";
  const forbidden = listError instanceof ApiError && listError.status === 403;

  if (forbidden || !isManager) {
    return (
      <div className="card max-w-3xl p-6">
        <h2 className="text-base font-semibold">Manage Team</h2>
        <p className="mt-2 text-sm text-slate-500">
          Only the workspace owner or an admin can view and manage team members.
        </p>
      </div>
    );
  }

  return (
    <div className="card max-w-3xl p-6">
      <div className="mb-1 flex items-center justify-between">
        <h2 className="text-base font-semibold">Manage Team</h2>
        <button className="btn-primary" onClick={() => { setShowAdd((v) => !v); setError(null); }}>
          <UserPlus className="h-4 w-4" /> Add team member
        </button>
      </div>
      <p className="mb-6 text-sm text-slate-500">
        Create a login for a teammate and choose what they can access. <b>Campaigns only</b> gives
        them just the Campaigns section — they can create, send and analyse campaigns, and can&apos;t
        see leads, pipeline, inbox or any other workspace data. <b>Member</b> gets the same full
        access as you. <b>Admin</b> can also manage the team and workspace settings.
      </p>

      {justCreated && (
        <div className="mb-6 rounded-md border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          <div className="mb-2 font-medium">
            Account created — share these credentials with your teammate (shown once).
          </div>
          <div className="space-y-1.5">
            <div className="flex items-center gap-2">
              <span className="w-16 shrink-0 text-xs text-amber-700">Email</span>
              <code className="flex-1 break-all rounded bg-white px-2 py-1 font-mono text-xs">{justCreated.email}</code>
            </div>
            <div className="flex items-center gap-2">
              <span className="w-16 shrink-0 text-xs text-amber-700">Password</span>
              <code className="flex-1 break-all rounded bg-white px-2 py-1 font-mono text-xs">{justCreated.password}</code>
              <button
                className="btn-secondary"
                onClick={async () => {
                  const ok = await copyToClipboard(`${justCreated.email}\n${justCreated.password}`);
                  if (ok) { setCopied(true); setTimeout(() => setCopied(false), 2000); }
                }}
              >
                {copied ? (<><Check className="h-4 w-4 text-emerald-600" /> Copied</>) : (<><Copy className="h-4 w-4" /> Copy</>)}
              </button>
            </div>
          </div>
          <button className="mt-2 text-amber-700 underline" onClick={() => setJustCreated(null)}>
            Dismiss
          </button>
        </div>
      )}

      {showAdd && (
        <form
          className="mb-6 grid grid-cols-2 gap-3 rounded-md border border-slate-200 p-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!form.email.trim() || form.password.length < 8) {
              setError("Enter an email and a password of at least 8 characters.");
              return;
            }
            create.mutate(form);
          }}
        >
          <label className="col-span-2 text-sm">
            <span className="mb-1 block text-slate-600">Email</span>
            <input
              type="email"
              required
              className="input w-full"
              value={form.email}
              onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
              placeholder="teammate@company.com"
            />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-slate-600">First name</span>
            <input
              className="input w-full"
              value={form.first_name}
              onChange={(e) => setForm((f) => ({ ...f, first_name: e.target.value }))}
            />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-slate-600">Last name</span>
            <input
              className="input w-full"
              value={form.last_name}
              onChange={(e) => setForm((f) => ({ ...f, last_name: e.target.value }))}
            />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-slate-600">Password</span>
            <input
              type="text"
              required
              minLength={8}
              className="input w-full font-mono"
              value={form.password}
              onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
              placeholder="min. 8 characters"
            />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-slate-600">Access</span>
            <select
              className="input w-full"
              value={form.role}
              onChange={(e) => setForm((f) => ({ ...f, role: e.target.value }))}
            >
              {ASSIGNABLE_ROLES.map((r) => (
                <option key={r} value={r}>{ROLE_LABEL[r]}</option>
              ))}
            </select>
          </label>
          {error && <div className="col-span-2 text-sm text-rose-600">{error}</div>}
          <div className="col-span-2 flex gap-2">
            <button type="submit" className="btn-primary" disabled={create.isPending}>
              <Mail className="h-4 w-4" /> {create.isPending ? "Creating…" : "Create account"}
            </button>
            <button type="button" className="btn-secondary" onClick={() => setShowAdd(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}

      <table className="w-full text-sm">
        <thead className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
          <tr>
            <th className="py-2">Name</th>
            <th className="py-2">Access</th>
            <th className="py-2 text-center">Campaigns created</th>
            <th className="py-2">Joined</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {members?.map((m) => {
            const isSelf = m.user_id === user?.id;
            const isOwner = m.role === "owner";
            const name = `${m.first_name || ""} ${m.last_name || ""}`.trim() || m.email;
            return (
              <tr key={m.membership_id} className="border-b border-slate-100">
                <td className="py-2">
                  <div className="font-medium">
                    {name} {isSelf && <span className="text-xs text-slate-400">(you)</span>}
                  </div>
                  <div className="text-xs text-slate-500">{m.email}</div>
                </td>
                <td className="py-2">
                  {isOwner ? (
                    <span className={`pill ${roleBadgeClass(m.role)}`}>{ROLE_LABEL[m.role]}</span>
                  ) : (
                    <select
                      className="input py-1 text-xs"
                      value={m.role}
                      disabled={changeRole.isPending}
                      onChange={(e) => changeRole.mutate({ membershipId: m.membership_id, role: e.target.value })}
                    >
                      {ASSIGNABLE_ROLES.map((r) => (
                        <option key={r} value={r}>{ROLE_LABEL[r]}</option>
                      ))}
                    </select>
                  )}
                </td>
                <td className="py-2 text-center">
                  <span className="inline-flex items-center gap-1 text-slate-600">
                    <Users className="h-3.5 w-3.5 text-slate-400" /> {m.campaign_count}
                  </span>
                </td>
                <td className="py-2 text-slate-500">{new Date(m.created_at).toLocaleDateString()}</td>
                <td className="py-2 text-right">
                  {!isOwner && !isSelf && (
                    <button
                      className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-rose-500"
                      title="Remove from workspace"
                      onClick={() => {
                        if (confirm(`Remove ${name} from this workspace? They'll lose access immediately.`)) {
                          remove.mutate(m.membership_id);
                        }
                      }}
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
          {!isLoading && members?.length === 0 && (
            <tr>
              <td colSpan={5} className="py-6 text-center text-slate-500">
                No team members yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
