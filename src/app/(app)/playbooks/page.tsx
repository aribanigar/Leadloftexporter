"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Send, Activity, Mail, MessageSquare, Users } from "lucide-react";
import { api } from "@/lib/api";
import type { Playbook } from "@/lib/types";

interface StatsOverview {
  contacted: number;
  replied: number;
  interested: number;
  reply_rate: number;
  interested_rate: number;
  from: string;
  to: string;
  series: { date: string; count: number }[];
}

const DATE_RANGES = [
  { label: "Last 7 Days", days: 7 },
  { label: "Last 30 Days", days: 30 },
  { label: "Last 90 Days", days: 90 },
  { label: "Last 180 Days", days: 180 },
  { label: "Last 365 Days", days: 365 },
];

export default function PlaybooksPage() {
  const qc = useQueryClient();
  const [days, setDays] = useState(90);
  const [scraperOpen, setScraperOpen] = useState(false);

  const { data: playbooks } = useQuery<Playbook[]>({
    queryKey: ["playbooks"],
    queryFn: () => api("/playbooks"),
  });
  const { data: stats } = useQuery<StatsOverview>({
    queryKey: ["playbook-stats", days],
    queryFn: () => api(`/playbooks/stats/overview?days=${days}`),
  });

  const create = useMutation({
    mutationFn: () =>
      api<Playbook>("/playbooks", {
        method: "POST",
        body: {
          name: "Untitled Playbook",
          trigger: "manual",
          is_active: false,
          steps: [
            { kind: "automated_email", wait_days: 0, wait_hours: 0, config: { ai: true } },
          ],
        },
      }),
    onSuccess: (pb) => {
      qc.invalidateQueries({ queryKey: ["playbooks"] });
      window.location.href = `/playbooks/${pb.id}`;
    },
  });

  return (
    <div className="p-6">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-lg font-semibold">Playbooks</h1>
        <div className="flex items-center gap-2">
          <select
            className="input w-auto"
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
          >
            {DATE_RANGES.map((r) => (
              <option key={r.days} value={r.days}>
                {r.label}
              </option>
            ))}
          </select>
          <button
            className="btn-primary"
            onClick={() => setScraperOpen(true)}
          >
            <Plus className="h-4 w-4" /> New playbook
          </button>
        </div>
      </div>
      {scraperOpen && (
        <NewPlaybookScraperModal
          onClose={() => setScraperOpen(false)}
          onCreated={() => {
            setScraperOpen(false);
            qc.invalidateQueries({ queryKey: ["playbooks"] });
          }}
        />
      )}

      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatCard
          icon={<Send className="h-4 w-4" />}
          label="Contacted"
          value={String(stats?.contacted ?? 0)}
          accent="bg-sky-100 text-sky-700"
        />
        <StatCard
          icon={<MessageSquare className="h-4 w-4" />}
          label="Replied"
          value={`${stats?.reply_rate ?? 0}%`}
          sub={`${stats?.replied ?? 0} replies`}
          accent="bg-violet-100 text-violet-700"
        />
        <StatCard
          icon={<Activity className="h-4 w-4" />}
          label="Interested"
          value={`${stats?.interested_rate ?? 0}%`}
          sub={`${stats?.interested ?? 0} leads`}
          accent="bg-emerald-100 text-emerald-700"
        />
      </div>

      <div className="card mb-6 p-4">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-700">Email activity</h2>
          <span className="text-xs text-slate-500">
            <Mail className="mr-1 inline h-3.5 w-3.5" />
            Outbound emails / day
          </span>
        </div>
        <Sparkline series={stats?.series || []} />
      </div>

      <h2 className="mb-2 text-sm font-semibold text-slate-700">Your playbooks</h2>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {playbooks?.map((p) => (
          <Link
            key={p.id}
            href={`/playbooks/${p.id}`}
            className="card block p-4 hover:border-brand-200"
          >
            <div className="flex items-center justify-between">
              <h3 className="font-semibold">{p.name}</h3>
              <span
                className={`pill ${
                  p.is_active
                    ? "bg-emerald-100 text-emerald-700"
                    : "bg-slate-100 text-slate-500"
                }`}
              >
                {p.is_active ? "Active" : "Paused"}
              </span>
            </div>
            <p className="mt-1 text-sm text-slate-500">{p.description || "—"}</p>
            <div className="mt-3 flex items-center gap-3 text-xs text-slate-500">
              <span>
                {p.steps.length} step{p.steps.length === 1 ? "" : "s"}
              </span>
              <span className="flex items-center gap-1">
                <Users className="h-3.5 w-3.5" /> {p.enrolled_count}
              </span>
              <span className="capitalize">
                trigger: {p.trigger.replace("_", " ")}
              </span>
            </div>
          </Link>
        ))}
        {playbooks?.length === 0 && (
          <p className="col-span-full text-sm text-slate-500">
            No playbooks yet. Create one to start outreach.
          </p>
        )}
      </div>
    </div>
  );
}

function StatCard({
  icon,
  label,
  value,
  sub,
  accent,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub?: string;
  accent: string;
}) {
  return (
    <div className="card flex items-center gap-3 p-4">
      <div className={`grid h-10 w-10 place-items-center rounded-md ${accent}`}>
        {icon}
      </div>
      <div>
        <div className="text-xs uppercase tracking-wide text-slate-500">
          {label}
        </div>
        <div className="text-2xl font-semibold text-slate-800">{value}</div>
        {sub && <div className="text-xs text-slate-500">{sub}</div>}
      </div>
    </div>
  );
}

function Sparkline({ series }: { series: { date: string; count: number }[] }) {
  const width = 800;
  const height = 160;
  const padX = 32;
  const padY = 16;

  const { path, max, points } = useMemo(() => {
    if (series.length === 0) {
      return {
        path: "",
        max: 0,
        points: [] as { x: number; y: number; date: string; count: number }[],
      };
    }
    const max = Math.max(1, ...series.map((s) => s.count));
    const stepX = (width - padX * 2) / Math.max(1, series.length - 1);
    const pts = series.map((s, i) => ({
      x: padX + i * stepX,
      y: height - padY - (s.count / max) * (height - padY * 2),
      date: s.date,
      count: s.count,
    }));
    const d = pts
      .map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
      .join(" ");
    return { path: d, max, points: pts };
  }, [series]);

  if (series.length === 0 || points.length === 0) {
    return (
      <div className="flex h-40 items-center justify-center text-sm text-slate-400">
        No data in this range.
      </div>
    );
  }

  const firstDate = series[0]?.date;
  const lastDate = series[series.length - 1]?.date;
  const last = points[points.length - 1];

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="h-40 w-full"
      preserveAspectRatio="none"
    >
      <defs>
        <linearGradient id="splfill" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="rgb(16 185 129)" stopOpacity="0.18" />
          <stop offset="100%" stopColor="rgb(16 185 129)" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path
        d={`${path} L ${last.x} ${height - padY} L ${points[0].x} ${height - padY} Z`}
        fill="url(#splfill)"
      />
      <path
        d={path}
        fill="none"
        stroke="rgb(16 185 129)"
        strokeWidth={2}
        strokeLinejoin="round"
      />
      <line
        x1={padX}
        x2={width - padX}
        y1={height - padY}
        y2={height - padY}
        stroke="rgb(226 232 240)"
        strokeWidth={1}
      />
      <text x={padX} y={padY} fontSize={11} fill="rgb(100 116 139)">
        {max}
      </text>
      <text x={padX} y={height - 2} fontSize={11} fill="rgb(100 116 139)">
        {firstDate}
      </text>
      <text
        x={width - padX}
        y={height - 2}
        fontSize={11}
        fill="rgb(100 116 139)"
        textAnchor="end"
      >
        {lastDate}
      </text>
    </svg>
  );
}


interface NewPlaybookScraperModalProps {
  onClose: () => void;
  onCreated: () => void;
}

function NewPlaybookScraperModal({ onClose, onCreated }: NewPlaybookScraperModalProps) {
  const [searchUrl, setSearchUrl] = useState("");
  const [daily, setDaily] = useState(30);
  const [total, setTotal] = useState(1000);
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const { data: playbooks } = useQuery<Playbook[]>({
    queryKey: ["playbooks"],
    queryFn: () => api("/playbooks"),
  });
  const [playbookId, setPlaybookId] = useState<string>("");

  async function submit() {
    setErr(null);
    if (!searchUrl.trim()) {
      setErr("Paste a LinkedIn search URL");
      return;
    }
    if (!searchUrl.includes("linkedin.com/")) {
      setErr("URL must be a LinkedIn search URL");
      return;
    }
    setSubmitting(true);
    try {
      // 1. Create the playbook (or reuse an existing one)
      let pb: Playbook;
      if (playbookId) {
        pb = await api<Playbook>(`/playbooks/${playbookId}`);
      } else {
        pb = await api<Playbook>("/playbooks", {
          method: "POST",
          body: {
            name: name.trim() || "Untitled Playbook",
            trigger: "manual",
            is_active: true,
            steps: [
              { kind: "automated_email", wait_days: 0, wait_hours: 0, config: { ai: true } },
            ],
          },
        });
      }
      // 2. Create the search scraper bound to that playbook
      await api("/search-scrapers", {
        method: "POST",
        body: {
          name: name.trim() || null,
          search_url: searchUrl.trim(),
          daily_save_cap: daily,
          total_save_cap: total,
          playbook_id: pb.id,
        },
      });
      onCreated();
      window.location.href = `/playbooks/${pb.id}`;
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
      onClick={onClose}
    >
      <div
        className="card w-full max-w-lg p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="mb-1 text-base font-semibold">LinkedIn Scraper Settings</h3>
        <p className="mb-4 text-xs text-slate-500">
          Paste a LinkedIn people-search URL. We will save{" "}
          <strong>{daily}</strong> contacts per day from this search, stopping
          after <strong>{total}</strong> contacts. Each new lead auto-enrolls
          into the playbook below.
        </p>

        <div className="mb-3 grid grid-cols-2 gap-3">
          <div>
            <label className="label">Save per day</label>
            <input
              className="input"
              type="number"
              min={1}
              max={100}
              value={daily}
              onChange={(e) => setDaily(Number(e.target.value) || 1)}
            />
          </div>
          <div>
            <label className="label">Stop after (total)</label>
            <input
              className="input"
              type="number"
              min={1}
              max={10000}
              value={total}
              onChange={(e) => setTotal(Number(e.target.value) || 1)}
            />
          </div>
        </div>

        <div className="mb-3">
          <label className="label">LinkedIn search URL</label>
          <input
            className="input"
            type="url"
            value={searchUrl}
            onChange={(e) => setSearchUrl(e.target.value)}
            placeholder="https://www.linkedin.com/search/results/people/?keywords=..."
          />
        </div>

        <div className="mb-3">
          <label className="label">Playbook</label>
          <select
            className="input"
            value={playbookId}
            onChange={(e) => setPlaybookId(e.target.value)}
          >
            <option value="">Create new playbook</option>
            {(playbooks || []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>

        {!playbookId && (
          <div className="mb-3">
            <label className="label">New playbook name</label>
            <input
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Untitled Playbook"
            />
          </div>
        )}

        {err && (
          <div className="mb-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {err}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <button className="btn-ghost" onClick={onClose} type="button">
            Go back
          </button>
          <button className="btn-primary" onClick={submit} disabled={submitting} type="button">
            {submitting ? "Creating…" : "Continue"}
          </button>
        </div>
      </div>
    </div>
  );
}
