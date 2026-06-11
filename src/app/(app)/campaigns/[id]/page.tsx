"use client";

/**
 * Campaign Detail — live progress, pause/resume/cancel, and recipient list.
 *
 * The frontend POLLS /campaigns/{id}/tick every 3 s while the campaign is
 * in "sending" status. That same endpoint runs on Celery beat too, but on
 * Render free tier no worker exists, so this poll IS the send loop. Each
 * tick advances the campaign by `batch_size` recipients and returns the
 * fresh counters in one call, so we don't need separate /status fetches.
 *
 * The recipient list refreshes alongside the status. Pause stops the
 * poll; Resume restarts it. Cancel finalizes the campaign.
 */

import { use, useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import {
  Mail,
  Pause,
  Play,
  X,
  CheckCircle2,
  AlertCircle,
  Loader2,
  ChevronLeft,
  Clock,
} from "lucide-react";
import { api } from "@/lib/api";
import { cn, fmtDate } from "@/lib/utils";

interface CampaignDetail {
  id: string;
  name: string;
  subject: string;
  preheader: string | null;
  body_html: string;
  body_text: string | null;
  status: string;
  total_recipients: number;
  sent_count: number;
  failed_count: number;
  skipped_count: number;
  started_at: string | null;
  finished_at: string | null;
  last_tick_at: string | null;
  batch_size: number;
  seconds_between_sends: number;
  warmup_enabled: boolean;
  sender_account_ids: string[];
  error: string | null;
}

interface Recipient {
  id: string;
  lead_id: string;
  lead_name: string | null;
  email: string;
  status: string;
  error: string | null;
  sent_at: string | null;
  sender_account_id: string | null;
}

interface TickResp {
  status: string;
  totals: {
    total_recipients: number;
    sent_count: number;
    failed_count: number;
    skipped_count: number;
  };
}

export default function CampaignDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const qc = useQueryClient();

  const { data: campaign } = useQuery<CampaignDetail>({
    queryKey: ["campaign", id],
    queryFn: () => api(`/campaigns/${id}`),
    refetchInterval: (query) => {
      const d = query.state.data as CampaignDetail | undefined;
      return d && d.status === "sending" ? 3000 : 15_000;
    },
  });

  const { data: recipients } = useQuery<Recipient[]>({
    queryKey: ["campaign-recipients", id],
    queryFn: () => api(`/campaigns/${id}/recipients?limit=200`),
    refetchInterval: (query) => {
      const d = (qc.getQueryData(["campaign", id]) as CampaignDetail | undefined);
      return d && d.status === "sending" ? 5000 : 30_000;
    },
  });

  // The poll-driven send tick. Runs every 3 s while status === "sending".
  const tick = useMutation<TickResp, Error, void>({
    mutationFn: () => api(`/campaigns/${id}/tick`, { method: "POST" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["campaign", id] });
      qc.invalidateQueries({ queryKey: ["campaign-recipients", id] });
    },
  });

  useEffect(() => {
    if (campaign?.status !== "sending") return;
    const i = setInterval(() => {
      tick.mutate();
    }, 3000);
    return () => clearInterval(i);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campaign?.status]);

  const pause = useMutation({
    mutationFn: () => api(`/campaigns/${id}/pause`, { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["campaign", id] }),
  });
  const resume = useMutation({
    mutationFn: () => api(`/campaigns/${id}/resume`, { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["campaign", id] }),
  });
  const cancel = useMutation({
    mutationFn: () => api(`/campaigns/${id}/cancel`, { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["campaign", id] }),
  });

  if (!campaign) {
    return (
      <div className="grid h-full place-items-center text-sm text-slate-400">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    );
  }

  const total = Math.max(1, campaign.total_recipients);
  const finishedRecipients =
    campaign.sent_count + campaign.failed_count + campaign.skipped_count;
  const pct = Math.round((finishedRecipients / total) * 100);
  const isLive = campaign.status === "sending";
  const isPaused = campaign.status === "paused";
  const isDone =
    campaign.status === "completed" || campaign.status === "cancelled";

  return (
    <div className="mx-auto max-w-5xl p-6">
      {/* Header */}
      <Link
        href="/campaigns"
        className="mb-3 inline-flex items-center gap-1 text-xs text-slate-500 hover:text-indigo-700"
      >
        <ChevronLeft className="h-3.5 w-3.5" />
        Back to campaigns
      </Link>
      <div className="mb-1 flex items-start justify-between gap-3">
        <div>
          <div className="mb-1 flex items-center gap-2">
            <Mail className="h-5 w-5 text-indigo-600" />
            <h1 className="text-lg font-semibold">{campaign.name}</h1>
            <StatusPill status={campaign.status} />
          </div>
          <div className="text-sm text-slate-500">
            <strong>Subject:</strong> {campaign.subject || "(none)"}
          </div>
        </div>
        <div className="flex gap-2">
          {isLive && (
            <button className="btn-secondary" onClick={() => pause.mutate()}>
              <Pause className="h-4 w-4" /> Pause
            </button>
          )}
          {isPaused && (
            <button
              className="btn bg-indigo-600 text-white hover:bg-indigo-700"
              onClick={() => resume.mutate()}
            >
              <Play className="h-4 w-4" /> Resume
            </button>
          )}
          {(isLive || isPaused) && (
            <button
              className="btn-danger"
              onClick={() => {
                if (window.confirm("Cancel this campaign? Pending recipients won't be sent.")) {
                  cancel.mutate();
                }
              }}
            >
              <X className="h-4 w-4" /> Halt
            </button>
          )}
        </div>
      </div>

      {/* Progress card */}
      <div className="card mb-5 p-5">
        <div className="mb-2 flex items-center justify-between text-sm">
          <div className="flex items-center gap-3">
            <span className="font-semibold">
              {finishedRecipients.toLocaleString()} /{" "}
              {campaign.total_recipients.toLocaleString()} processed
            </span>
            <span className="text-slate-400">·</span>
            <span className="text-slate-500">{pct}%</span>
          </div>
          {campaign.last_tick_at && (
            <span className="inline-flex items-center gap-1 text-[11px] text-slate-400">
              <Clock className="h-3 w-3" />
              Last tick {fmtDate(campaign.last_tick_at)}
            </span>
          )}
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-slate-100">
          <div
            className={cn(
              "h-full rounded-full transition-all duration-500",
              campaign.status === "failed"
                ? "bg-red-500"
                : isDone && campaign.failed_count > 0
                ? "bg-amber-500"
                : isDone
                ? "bg-emerald-500"
                : "bg-indigo-500"
            )}
            style={{ width: `${pct}%` }}
          />
        </div>
        <div className="mt-3 grid grid-cols-3 gap-3 text-sm">
          <Stat
            label="Sent"
            value={campaign.sent_count}
            color="text-emerald-700"
            icon={CheckCircle2}
          />
          <Stat
            label="Failed"
            value={campaign.failed_count}
            color="text-red-700"
            icon={AlertCircle}
          />
          <Stat
            label="Skipped"
            value={campaign.skipped_count}
            color="text-slate-600"
            icon={X}
          />
        </div>
        {isLive && (
          <p className="mt-3 text-[11px] text-indigo-700">
            Keeping this page open accelerates the send — each browser tick
            advances {campaign.batch_size} emails.
          </p>
        )}
        {campaign.error && (
          <div className="mt-3 flex items-start gap-2 rounded-md bg-red-50 p-3 text-sm text-red-700">
            <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
            {campaign.error}
          </div>
        )}
      </div>

      {/* Recipients table */}
      <div className="card overflow-hidden">
        <div className="border-b border-slate-100 bg-slate-50 px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
          Recipients
        </div>
        {!recipients?.length ? (
          <div className="grid place-items-center p-10 text-sm text-slate-400">
            No recipients yet.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b border-slate-100 text-left text-[11px] font-semibold uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-2">Lead</th>
                <th className="px-4 py-2">Email</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2">Sent at</th>
              </tr>
            </thead>
            <tbody>
              {recipients.map((r) => (
                <tr
                  key={r.id}
                  className="border-b border-slate-50 last:border-0"
                >
                  <td className="px-4 py-2 font-medium text-slate-800">
                    {r.lead_name || "—"}
                  </td>
                  <td className="px-4 py-2 text-slate-500">{r.email}</td>
                  <td className="px-4 py-2">
                    <RecipientStatus status={r.status} error={r.error} />
                  </td>
                  <td className="px-4 py-2 text-xs text-slate-400">
                    {r.sent_at ? fmtDate(r.sent_at) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const map: Record<string, { cls: string; label: string }> = {
    draft: { cls: "bg-slate-100 text-slate-600", label: "Draft" },
    scheduled: { cls: "bg-amber-50 text-amber-700", label: "Scheduled" },
    sending: { cls: "bg-indigo-50 text-indigo-700", label: "Sending" },
    paused: { cls: "bg-yellow-50 text-yellow-800", label: "Paused" },
    completed: { cls: "bg-emerald-50 text-emerald-700", label: "Completed" },
    cancelled: { cls: "bg-slate-100 text-slate-500", label: "Cancelled" },
    failed: { cls: "bg-red-50 text-red-700", label: "Failed" },
  };
  const m = map[status] || map.draft;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium",
        m.cls
      )}
    >
      {status === "sending" && <Loader2 className="h-3 w-3 animate-spin" />}
      {m.label}
    </span>
  );
}

function Stat({
  label,
  value,
  color,
  icon: Icon,
}: {
  label: string;
  value: number;
  color: string;
  icon: typeof CheckCircle2;
}) {
  return (
    <div className="rounded-md border border-slate-100 p-2.5">
      <div className="flex items-center gap-1 text-[11px] uppercase text-slate-500">
        <Icon className={cn("h-3.5 w-3.5", color)} />
        {label}
      </div>
      <div className={cn("text-lg font-semibold", color)}>
        {value.toLocaleString()}
      </div>
    </div>
  );
}

function RecipientStatus({ status, error }: { status: string; error: string | null }) {
  if (status === "sent")
    return (
      <span className="inline-flex items-center gap-1 text-xs text-emerald-700">
        <CheckCircle2 className="h-3.5 w-3.5" /> Sent
      </span>
    );
  if (status === "failed")
    return (
      <span
        className="inline-flex items-center gap-1 text-xs text-red-700"
        title={error || undefined}
      >
        <AlertCircle className="h-3.5 w-3.5" />
        Failed
      </span>
    );
  if (status === "skipped")
    return (
      <span
        className="inline-flex items-center gap-1 text-xs text-slate-500"
        title={error || undefined}
      >
        <X className="h-3.5 w-3.5" />
        Skipped
      </span>
    );
  if (status === "sending")
    return (
      <span className="inline-flex items-center gap-1 text-xs text-indigo-700">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Sending
      </span>
    );
  return (
    <span className="inline-flex items-center gap-1 text-xs text-slate-500">
      <Clock className="h-3.5 w-3.5" /> Pending
    </span>
  );
}
