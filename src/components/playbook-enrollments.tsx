"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { ExternalLink, Mail, MapPin, Phone, Sparkles, Trash2, Users } from "lucide-react";
import { api } from "@/lib/api";

interface EnrolledLead {
  id: string;
  full_name: string | null;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  title: string | null;
  linkedin_url: string | null;
  avatar_url: string | null;
  location: string | null;
}

interface Enrollment {
  id: string;
  status: string;
  current_step: number;
  ejected_reason: string | null;
  completed_at: string | null;
  created_at: string;
  needs_enrichment: boolean;
  lead: EnrolledLead;
}

function statusPill(status: string) {
  const map: Record<string, string> = {
    active: "bg-emerald-100 text-emerald-700",
    paused: "bg-amber-100 text-amber-700",
    completed: "bg-slate-100 text-slate-600",
    ejected: "bg-rose-100 text-rose-700",
  };
  return map[status] || "bg-slate-100 text-slate-600";
}

export function PlaybookEnrollments({ playbookId }: { playbookId: string }) {
  const qc = useQueryClient();
  const [filter, setFilter] = useState<"all" | "needs_enrichment">("all");

  const { data: enrollments, isLoading } = useQuery<Enrollment[]>({
    queryKey: ["playbook", playbookId, "enrollments"],
    queryFn: () => api(`/playbooks/${playbookId}/enrollments`),
    refetchInterval: 15_000, // refresh every 15s so enrichment status updates
  });

  const unenroll = useMutation({
    mutationFn: (enrollmentId: string) =>
      api(`/playbooks/${playbookId}/enrollments/${enrollmentId}`, {
        method: "DELETE",
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["playbook", playbookId, "enrollments"] });
      qc.invalidateQueries({ queryKey: ["playbook", playbookId] });
    },
  });

  const visible = (enrollments || []).filter((e) =>
    filter === "needs_enrichment" ? e.needs_enrichment : true
  );
  const needsCount = (enrollments || []).filter((e) => e.needs_enrichment).length;

  return (
    <div className="card mt-6 p-0">
      <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
        <div className="flex items-center gap-2">
          <Users className="h-4 w-4 text-slate-500" />
          <h3 className="font-semibold">
            Enrolled leads ({enrollments?.length || 0})
          </h3>
        </div>
        <div className="flex gap-1 text-xs">
          <button
            className={`rounded px-2 py-1 ${
              filter === "all"
                ? "bg-brand-100 text-brand-700"
                : "text-slate-500 hover:bg-slate-100"
            }`}
            onClick={() => setFilter("all")}
          >
            All
          </button>
          <button
            className={`rounded px-2 py-1 ${
              filter === "needs_enrichment"
                ? "bg-brand-100 text-brand-700"
                : "text-slate-500 hover:bg-slate-100"
            }`}
            onClick={() => setFilter("needs_enrichment")}
          >
            Needs enrichment ({needsCount})
          </button>
        </div>
      </div>

      {isLoading ? (
        <div className="p-6 text-sm text-slate-500">Loading enrollments…</div>
      ) : !enrollments || enrollments.length === 0 ? (
        <div className="p-6 text-sm text-slate-500">
          No leads enrolled yet. Enroll leads from the Pipeline page (hover row →
          send icon) or the Lead detail page.
        </div>
      ) : visible.length === 0 ? (
        <div className="p-6 text-sm text-slate-500">
          No leads match this filter.
        </div>
      ) : (
        <ul className="divide-y divide-slate-100">
          {visible.map((e) => (
            <li key={e.id} className="flex items-center gap-3 px-4 py-3">
              <div className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-slate-100 text-xs font-semibold text-slate-600">
                {(e.lead.full_name || "?").slice(0, 2).toUpperCase()}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <Link
                    href={`/leads/${e.lead.id}`}
                    className="truncate font-medium text-slate-900 hover:text-brand-700"
                  >
                    {e.lead.full_name || "—"}
                  </Link>
                  <span
                    className={`pill ${statusPill(e.status)} text-[10px] uppercase`}
                  >
                    {e.status}
                  </span>
                  {e.needs_enrichment && (
                    <span
                      className="pill bg-amber-50 text-amber-700 text-[10px]"
                      title="No email/phone on file — extension will enrich on next LinkedIn visit"
                    >
                      <Sparkles className="h-3 w-3" /> Enriching…
                    </span>
                  )}
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-slate-500">
                  {e.lead.title && <span className="truncate">{e.lead.title}</span>}
                  {e.lead.email && (
                    <span className="inline-flex items-center gap-1">
                      <Mail className="h-3 w-3" /> {e.lead.email}
                    </span>
                  )}
                  {e.lead.phone && (
                    <span className="inline-flex items-center gap-1">
                      <Phone className="h-3 w-3" /> {e.lead.phone}
                    </span>
                  )}
                  {e.lead.location && (
                    <span className="inline-flex items-center gap-1">
                      <MapPin className="h-3 w-3" /> {e.lead.location}
                    </span>
                  )}
                  {e.lead.linkedin_url && (
                    <a
                      href={e.lead.linkedin_url}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 hover:text-brand-700"
                    >
                      <ExternalLink className="h-3 w-3" /> LinkedIn
                    </a>
                  )}
                </div>
              </div>
              <button
                className="rounded p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600"
                title="Remove from playbook"
                onClick={() => {
                  if (confirm(`Remove ${e.lead.full_name || "this lead"} from the playbook?`)) {
                    unenroll.mutate(e.id);
                  }
                }}
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
