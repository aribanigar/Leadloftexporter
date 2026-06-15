"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { BarChart3, Users, Send, MessageSquare, Flame } from "lucide-react";
import { api } from "@/lib/api";
import type { PipelineStage } from "@/lib/types";

interface Stats {
  contacted: number;
  replied: number;
  interested: number;
  reply_rate: number;
  interested_rate: number;
  series: { date: string; count: number }[];
}

const RANGES = [
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
  { days: 365, label: "12 months" },
];

export default function AnalyticsPage() {
  const [days, setDays] = useState(30);

  const { data: stages } = useQuery<PipelineStage[]>({
    queryKey: ["stages"],
    queryFn: () => api("/pipeline/stages"),
  });
  const { data: stats, isLoading } = useQuery<Stats>({
    queryKey: ["stats", days],
    queryFn: () => api(`/playbooks/stats/overview?days=${days}`),
  });

  const totalLeads = useMemo(
    () => (stages || []).reduce((sum, s) => sum + (s.lead_count || 0), 0),
    [stages]
  );
  const maxStage = useMemo(
    () => Math.max(1, ...(stages || []).map((s) => s.lead_count || 0)),
    [stages]
  );
  const maxDay = useMemo(
    () => Math.max(1, ...((stats?.series || []).map((p) => p.count) || [1])),
    [stats]
  );

  return (
    <div className="p-6">
      <div className="mb-4 flex items-center gap-2">
        <BarChart3 className="h-5 w-5 text-brand-600" />
        <h1 className="text-lg font-semibold">Analytics</h1>
        <div className="ml-auto flex rounded-md border border-slate-200 bg-white p-0.5">
          {RANGES.map((r) => (
            <button
              key={r.days}
              onClick={() => setDays(r.days)}
              className={`rounded px-3 py-1 text-sm font-medium ${
                days === r.days ? "bg-brand-50 text-brand-700" : "text-slate-500 hover:text-slate-800"
              }`}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {/* Scorecards */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
        <Card icon={Users} label="Total leads" value={totalLeads} tone="slate" />
        <Card icon={Send} label="Contacted" value={stats?.contacted ?? 0} tone="sky" />
        <Card icon={MessageSquare} label="Replied" value={stats?.replied ?? 0} tone="violet" />
        <Card icon={BarChart3} label="Reply rate" value={`${stats?.reply_rate ?? 0}%`} tone="emerald" />
        <Card icon={Flame} label="Interested" value={stats?.interested ?? 0} tone="amber" />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        {/* Pipeline by stage */}
        <div className="card p-5">
          <h2 className="mb-4 text-sm font-semibold text-slate-700">Pipeline by stage</h2>
          <div className="space-y-3">
            {(stages || []).map((s) => (
              <div key={s.id}>
                <div className="mb-1 flex items-center justify-between text-xs">
                  <span className="flex items-center gap-1.5 text-slate-600">
                    <span
                      className="inline-block h-2.5 w-2.5 rounded-full"
                      style={{ backgroundColor: s.color || "#94a3b8" }}
                    />
                    {s.name}
                  </span>
                  <span className="font-semibold text-slate-700">{s.lead_count || 0}</span>
                </div>
                <div className="h-2 w-full overflow-hidden rounded-full bg-slate-100">
                  <div
                    className="h-full rounded-full"
                    style={{
                      width: `${((s.lead_count || 0) / maxStage) * 100}%`,
                      backgroundColor: s.color || "#3b82f6",
                    }}
                  />
                </div>
              </div>
            ))}
            {(stages || []).length === 0 && (
              <p className="text-sm text-slate-400">No stages yet.</p>
            )}
          </div>
        </div>

        {/* Outbound activity */}
        <div className="card p-5">
          <h2 className="mb-1 text-sm font-semibold text-slate-700">Outbound activity</h2>
          <p className="mb-4 text-xs text-slate-400">Emails sent per day over the last {days} days.</p>
          {isLoading ? (
            <p className="text-sm text-slate-400">Loading…</p>
          ) : (stats?.series || []).every((p) => p.count === 0) ? (
            <p className="py-8 text-center text-sm text-slate-400">
              No outbound activity yet. Send via a playbook or the Inbox to see it here.
            </p>
          ) : (
            <div className="flex h-40 items-end gap-px overflow-x-auto">
              {(stats?.series || []).map((p) => (
                <div
                  key={p.date}
                  className="min-w-[3px] flex-1 rounded-t bg-brand-400 hover:bg-brand-600"
                  style={{ height: `${Math.max(2, (p.count / maxDay) * 100)}%` }}
                  title={`${p.date}: ${p.count}`}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const TONES: Record<string, string> = {
  slate: "bg-slate-100 text-slate-600",
  sky: "bg-sky-100 text-sky-700",
  violet: "bg-violet-100 text-violet-700",
  emerald: "bg-emerald-100 text-emerald-700",
  amber: "bg-amber-100 text-amber-700",
};

function Card({
  icon: Icon,
  label,
  value,
  tone,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: number | string;
  tone: string;
}) {
  return (
    <div className="card flex items-center gap-3 p-4">
      <div className={`grid h-9 w-9 place-items-center rounded-lg ${TONES[tone] || TONES.slate}`}>
        <Icon className="h-4 w-4" />
      </div>
      <div className="min-w-0">
        <div className="truncate text-xs text-slate-500">{label}</div>
        <div className="text-lg font-semibold text-slate-800">{value}</div>
      </div>
    </div>
  );
}
