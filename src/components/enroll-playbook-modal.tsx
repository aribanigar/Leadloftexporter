"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Search, X, Loader2, Check } from "lucide-react";
import Link from "next/link";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";

interface Playbook {
  id: string;
  name: string;
  description?: string | null;
  is_active: boolean;
  enrolled_count?: number;
  steps?: Array<{ id: string; kind: string }>;
}

interface Props {
  leadId: string;
  leadName?: string | null;
  onClose: () => void;
}

export function EnrollPlaybookModal({ leadId, leadName, onClose }: Props) {
  const qc = useQueryClient();
  const { user } = useAuth();
  const [search, setSearch] = useState("");
  const [enrolledIds, setEnrolledIds] = useState<Set<string>>(new Set());

  const { data: playbooks, isLoading } = useQuery<Playbook[]>({
    queryKey: ["playbooks"],
    queryFn: () => api("/playbooks"),
  });

  const enroll = useMutation({
    mutationFn: (playbookId: string) =>
      api(`/playbooks/${playbookId}/enroll`, {
        method: "POST",
        body: { lead_ids: [leadId] },
      }),
    onSuccess: (_data, playbookId) => {
      setEnrolledIds((prev) => new Set(prev).add(playbookId));
      qc.invalidateQueries({ queryKey: ["lead", leadId, "timeline"] });
      qc.invalidateQueries({ queryKey: ["playbooks"] });
    },
  });

  const filtered = (playbooks || []).filter((p) =>
    p.name.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-xl rounded-lg bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between border-b border-slate-200 px-5 py-4">
          <div>
            <h2 className="text-base font-semibold">
              {leadName ? `Add ${leadName} to a Playbook` : "Add to a Playbook"}
            </h2>
            <p className="mt-1 text-xs text-slate-500">
              Enroll the contact by clicking <strong>Enroll</strong> next to a playbook.
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-slate-700"
            title="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="px-5 py-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              autoFocus
              className="input pl-9"
              placeholder="Search playbooks"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          {user?.email && (
            <p className="mt-2 text-xs text-slate-500">
              Sender: <span className="text-slate-700">{user.email}</span>
            </p>
          )}
        </div>

        <div className="max-h-96 overflow-y-auto px-5 pb-5">
          {isLoading && (
            <p className="py-6 text-center text-sm text-slate-400">Loading…</p>
          )}
          {!isLoading && filtered.length === 0 && (
            <div className="py-8 text-center">
              <p className="text-sm text-slate-500">
                {playbooks?.length
                  ? "No playbooks match your search."
                  : "No playbooks yet."}
              </p>
              {!playbooks?.length && (
                <Link
                  href="/playbooks"
                  className="mt-2 inline-block text-xs text-brand-600 hover:underline"
                  onClick={onClose}
                >
                  Create your first playbook →
                </Link>
              )}
            </div>
          )}
          <ul className="space-y-2">
            {filtered.map((p) => {
              const enrolled = enrolledIds.has(p.id);
              return (
                <li
                  key={p.id}
                  className="flex items-center justify-between rounded-md border border-slate-200 px-3 py-2"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-medium text-slate-800">
                        {p.name}
                      </span>
                      {!p.is_active && (
                        <span className="pill bg-slate-100 text-slate-500">
                          Paused
                        </span>
                      )}
                    </div>
                    {p.description && (
                      <p className="truncate text-xs text-slate-500">
                        {p.description}
                      </p>
                    )}
                    <p className="mt-0.5 text-xs text-slate-400">
                      {p.steps?.length || 0} step
                      {(p.steps?.length || 0) === 1 ? "" : "s"} ·{" "}
                      {p.enrolled_count ?? 0} enrolled
                    </p>
                  </div>
                  {enrolled ? (
                    <span className="inline-flex items-center gap-1 rounded-md bg-emerald-50 px-3 py-1 text-sm font-medium text-emerald-700">
                      <Check className="h-4 w-4" /> Enrolled
                    </span>
                  ) : (
                    <button
                      className="btn-primary"
                      disabled={enroll.isPending && enroll.variables === p.id}
                      onClick={() => enroll.mutate(p.id)}
                    >
                      {enroll.isPending && enroll.variables === p.id ? (
                        <>
                          <Loader2 className="h-4 w-4 animate-spin" /> Enrolling…
                        </>
                      ) : (
                        "Enroll"
                      )}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </div>

        <div className="flex justify-end gap-2 border-t border-slate-200 px-5 py-3">
          <button onClick={onClose} className="btn-secondary">
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
