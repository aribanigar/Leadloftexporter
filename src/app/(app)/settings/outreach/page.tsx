"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { OutreachSettings } from "@/lib/types";

const TIMEZONES = [
  "America/New_York",
  "America/Los_Angeles",
  "America/Chicago",
  "Europe/London",
  "Europe/Berlin",
  "Asia/Calcutta",
  "Asia/Singapore",
  "Asia/Tokyo",
  "Australia/Sydney",
];

const TIME_FRAMES = [
  ["07:00", "19:00"],
  ["08:00", "18:00"],
  ["09:00", "17:00"],
  ["00:00", "23:59"],
];

export default function OutreachSettingsPage() {
  const qc = useQueryClient();
  const { data } = useQuery<OutreachSettings>({
    queryKey: ["outreach-settings"],
    queryFn: () => api("/settings/outreach"),
  });
  const [form, setForm] = useState<OutreachSettings | null>(null);
  useEffect(() => {
    if (data && !form) setForm(data);
  }, [data, form]);

  const save = useMutation({
    mutationFn: (body: OutreachSettings) => api("/settings/outreach", { method: "PATCH", body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["outreach-settings"] }),
  });

  if (!form) return <div className="text-sm text-slate-500">Loading…</div>;

  return (
    <div className="card max-w-3xl p-6">
      <h2 className="mb-6 text-base font-semibold">Outreach Settings</h2>
      <div className="space-y-5">
        <div>
          <label className="label">Email Sending Pattern</label>
          <select
            className="input"
            value={form.email_sending_pattern}
            onChange={(e) => setForm({ ...form, email_sending_pattern: e.target.value })}
          >
            <option value="mimic_humans">Mimic Humans (Recommended)</option>
            <option value="burst">Burst send</option>
          </select>
        </div>
        <div>
          <label className="label">Schedule</label>
          <select
            className="input"
            value={form.schedule}
            onChange={(e) => setForm({ ...form, schedule: e.target.value })}
          >
            <option value="any_day">Any Day</option>
            <option value="weekdays">Weekdays</option>
          </select>
        </div>
        <div>
          <label className="label">Time Frame</label>
          <select
            className="input"
            value={`${form.time_frame_start}-${form.time_frame_end}`}
            onChange={(e) => {
              const [s, end] = e.target.value.split("-");
              setForm({ ...form, time_frame_start: s, time_frame_end: end });
            }}
          >
            {TIME_FRAMES.map(([s, end]) => (
              <option key={`${s}-${end}`} value={`${s}-${end}`}>
                {humanTime(s)} – {humanTime(end)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label">Timezone</label>
          <select
            className="input"
            value={form.timezone}
            onChange={(e) => setForm({ ...form, timezone: e.target.value })}
          >
            {TIMEZONES.map((tz) => (
              <option key={tz} value={tz}>
                {tz}
              </option>
            ))}
          </select>
        </div>
        <LimitSlider
          label="Email Limit"
          recommendation="Rec. 80 /day"
          max={500}
          value={form.email_limit_per_day}
          onChange={(v) => setForm({ ...form, email_limit_per_day: v })}
        />
        <LimitSlider
          label="LinkedIn Connect Limit"
          recommendation="Rec. 15 /day"
          max={100}
          value={form.linkedin_connect_limit}
          onChange={(v) => setForm({ ...form, linkedin_connect_limit: v })}
        />
        <LimitSlider
          label="LinkedIn Message Limit"
          recommendation="Rec. 30 /day"
          max={200}
          value={form.linkedin_message_limit}
          onChange={(v) => setForm({ ...form, linkedin_message_limit: v })}
        />
        <div className="flex gap-2 pt-4">
          <button className="btn-primary" disabled={save.isPending} onClick={() => save.mutate(form)}>
            {save.isPending ? "Saving…" : "Save"}
          </button>
          <button className="btn-secondary" onClick={() => setForm(data!)}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

function humanTime(s: string): string {
  const [h, m] = s.split(":").map(Number);
  const period = h >= 12 ? "pm" : "am";
  const hh = ((h + 11) % 12) + 1;
  return m === 0 ? `${hh}${period}` : `${hh}:${String(m).padStart(2, "0")}${period}`;
}

function LimitSlider({
  label,
  recommendation,
  max,
  value,
  onChange,
}: {
  label: string;
  recommendation: string;
  max: number;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <div>
      <div className="mb-1 flex items-center gap-2">
        <span className="text-sm font-medium text-slate-700">{label}</span>
        <span className="text-xs text-slate-500">{recommendation}</span>
      </div>
      <div className="flex items-center gap-3">
        <input
          type="number"
          className="input w-24 text-sm"
          value={value}
          min={0}
          max={max}
          onChange={(e) => onChange(Number(e.target.value))}
        />
        <span className="text-xs text-slate-500">/day</span>
        <input
          type="range"
          min={0}
          max={max}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          className="flex-1 accent-brand-600"
        />
      </div>
    </div>
  );
}
