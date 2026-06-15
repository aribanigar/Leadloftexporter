"use client";

import { useEffect, useState } from "react";
import type { ComponentType } from "react";

/** Ticking clock for live countdowns. Returns epoch ms, updates on an interval. */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

/** Compact live relative time: "in 2h 5m", "in 45m", "in 30s", "5m ago", "just now". */
export function liveRelative(target: string | number | Date, now: number): { text: string; isPast: boolean } {
  const t = new Date(target).getTime();
  if (Number.isNaN(t)) return { text: "", isPast: false };
  const diff = t - now;
  const isPast = diff < 0;
  const abs = Math.abs(diff);
  const sec = Math.floor(abs / 1000);
  const min = Math.floor(sec / 60);
  const hr = Math.floor(min / 60);
  const day = Math.floor(hr / 24);

  let core: string;
  if (sec < 30) core = "just now";
  else if (min < 1) core = `${sec}s`;
  else if (min < 60) core = `${min}m`;
  else if (hr < 24) core = `${hr}h${min % 60 ? ` ${min % 60}m` : ""}`;
  else if (day < 7) core = `${day}d${hr % 24 ? ` ${hr % 24}h` : ""}`;
  else core = new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });

  if (core === "just now") return { text: "just now", isPast };
  return { text: isPast ? `${core} ago` : `in ${core}`, isPast };
}

/** Polished page header: gradient icon chip + title + subtitle + optional actions. */
export function PageHeader({
  icon: Icon,
  title,
  subtitle,
  children,
}: {
  icon: ComponentType<{ className?: string }>;
  title: string;
  subtitle?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div className="flex items-center gap-3">
        <div className="grid h-10 w-10 place-items-center rounded-xl bg-gradient-to-br from-brand-500 to-brand-700 text-white shadow-sm">
          <Icon className="h-5 w-5" />
        </div>
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-slate-900">{title}</h1>
          {subtitle && <p className="text-sm text-slate-500">{subtitle}</p>}
        </div>
      </div>
      {children && <div className="flex items-center gap-2">{children}</div>}
    </div>
  );
}

export type Tone = "amber" | "emerald" | "rose" | "slate" | "brand" | "violet";

const PILL_TONE: Record<Tone, string> = {
  amber: "bg-amber-50 text-amber-700 ring-amber-600/20",
  emerald: "bg-emerald-50 text-emerald-700 ring-emerald-600/20",
  rose: "bg-rose-50 text-rose-700 ring-rose-600/20",
  slate: "bg-slate-100 text-slate-600 ring-slate-500/20",
  brand: "bg-brand-50 text-brand-700 ring-brand-600/20",
  violet: "bg-violet-50 text-violet-700 ring-violet-600/20",
};
const DOT_TONE: Record<Tone, string> = {
  amber: "bg-amber-500",
  emerald: "bg-emerald-500",
  rose: "bg-rose-500",
  slate: "bg-slate-400",
  brand: "bg-brand-500",
  violet: "bg-violet-500",
};

export function Pill({ tone = "slate", dot = false, children }: { tone?: Tone; dot?: boolean; children: React.ReactNode }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset ${PILL_TONE[tone]}`}>
      {dot && <span className={`h-1.5 w-1.5 rounded-full ${DOT_TONE[tone]}`} />}
      {children}
    </span>
  );
}

/** Animated "live" pulse dot — signals the view auto-updates. */
export function LiveDot({ label = "Live" }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-slate-500">
      <span className="relative flex h-2 w-2">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
      </span>
      {label}
    </span>
  );
}

export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded-md bg-slate-100 ${className}`} />;
}
