"use client";

/**
 * Campaigns list — landing page for the Email Marketing surface.
 *
 * One row per campaign with live status pill + recipient progress bar.
 * "New campaign" CTA leads into the wizard at /campaigns/new. Rows link
 * into /campaigns/{id} for the detail view.
 *
 * No polling here — the detail page does the live polling. The list
 * refetches every 10 s so completed campaigns show their final stats
 * without a refresh.
 */

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import {
  Mail,
  Plus,
  Loader2,
  CheckCircle2,
  PauseCircle,
  PlayCircle,
  AlertCircle,
  XCircle,
} from "lucide-react";
import { api } from "@/lib/api";
import { cn, fmtDate } from "@/lib/utils";

interface CampaignRow {
  id: string;
  name: string;
  subject: string;
  status: string;
  total_recipients: number;
  sent_count: number;
  failed_count: number;
  skipped_count: number;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

const STATUS_STYLES: Record<string, { label: string; cls: string; Icon: typeof Mail }> = {
  draft: { label: "Draft", cls: "bg-slate-100 text-slate-600", Icon: Mail },
  scheduled: { label: "Scheduled", cls: "bg-amber-50 text-amber-700", Icon: PlayCircle },
  sending: { label: "Sending", cls: "bg-indigo-50 text-indigo-700", Icon: Loader2 },
  paused: { label: "Paused", cls: "bg-yellow-50 text-yellow-800", Icon: PauseCircle },
  completed: { label: "Completed", cls: "bg-emerald-50 text-emerald-700", Icon: CheckCircle2 },
  cancelled: { label: "Cancelled", cls: "bg-slate-100 text-slate-500", Icon: XCircle },
  failed: { label: "Failed", cls: "bg-red-50 text-red-700", Icon: AlertCircle },
};

export default function CampaignsPage() {
  const { data: campaigns } = useQuery<CampaignRow[]>({
    queryKey: ["campaigns"],
    queryFn: () => api("/campaigns"),
    refetchInterval: 10_000,
  });

  return (
    <div className="mx-auto max-w-6xl p-6">
      <div className="mb-5 flex items-start justify-between">
        <div>
          <div className="mb-1 flex items-center gap-2">
            <Mail className="h-5 w-5 text-indigo-600" />
            <h1 className="text-lg font-semibold">Email Campaigns</h1>
          </div>
          <p className="text-sm text-slate-500">
            Send individual emails in bulk through one or more of your
            connected mailboxes. Warmup ramps each sender automatically;
            pause and halt any time.
          </p>
        </div>
        <Link href="/campaigns/new" className="btn-primary">
          <Plus className="h-4 w-4" />
          New campaign
        </Link>
      </div>

      <div className="card overflow-hidden">
        {!campaigns ? (
          <div className="grid place-items-center p-16 text-sm text-slate-400">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : campaigns.length === 0 ? (
          <div className="grid place-items-center gap-3 p-16 text-center text-sm text-slate-500">
            <Mail className="h-8 w-8 text-slate-300" />
            <p>
              No campaigns yet. Click <strong>New campaign</strong> to
              broadcast your first message.
            </p>
            <Link href="/campaigns/new" className="btn-primary mt-1">
              <Plus className="h-4 w-4" />
              New campaign
            </Link>
          </div>
        ) : (
          <table className="w-full">
            <thead className="border-b border-slate-100 bg-slate-50 text-left text-[11px] font-semibold uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-2.5">Name</th>
                <th className="px-4 py-2.5">Status</th>
                <th className="px-4 py-2.5">Progress</th>
                <th className="px-4 py-2.5">Recipients</th>
                <th className="px-4 py-2.5">Started</th>
              </tr>
            </thead>
            <tbody>
              {campaigns.map((c) => {
                const meta = STATUS_STYLES[c.status] || STATUS_STYLES.draft;
                const total = Math.max(1, c.total_recipients);
                const sent = c.sent_count + c.failed_count + c.skipped_count;
                const pct = Math.round((sent / total) * 100);
                return (
                  <tr key={c.id} className="border-b border-slate-50 hover:bg-slate-50/60">
                    <td className="px-4 py-3">
                      <Link
                        href={`/campaigns/${c.id}`}
                        className="block font-medium text-slate-800 hover:text-indigo-700"
                      >
                        {c.name}
                      </Link>
                      <div className="truncate text-xs text-slate-400">
                        {c.subject || "(no subject)"}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={cn(
                          "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium",
                          meta.cls
                        )}
                      >
                        <meta.Icon
                          className={cn(
                            "h-3 w-3",
                            c.status === "sending" && "animate-spin"
                          )}
                        />
                        {meta.label}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex w-40 items-center gap-2">
                        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-100">
                          <div
                            className={cn(
                              "h-full rounded-full transition-all duration-500",
                              c.status === "failed"
                                ? "bg-red-500"
                                : c.status === "completed"
                                ? "bg-emerald-500"
                                : "bg-indigo-500"
                            )}
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                        <span className="text-[10px] text-slate-500">{pct}%</span>
                      </div>
                      <div className="mt-1 flex gap-2 text-[10px] text-slate-500">
                        <span className="text-emerald-700">{c.sent_count} sent</span>
                        {c.failed_count > 0 && (
                          <span className="text-red-700">{c.failed_count} failed</span>
                        )}
                        {c.skipped_count > 0 && (
                          <span className="text-slate-500">{c.skipped_count} skipped</span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-sm text-slate-600">
                      {c.total_recipients.toLocaleString()}
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-500">
                      {fmtDate(c.started_at || c.created_at)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
