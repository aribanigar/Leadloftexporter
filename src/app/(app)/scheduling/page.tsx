"use client";

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarRange, Plus, Trash2, Copy, ExternalLink, Check } from "lucide-react";
import { api } from "@/lib/api";

interface Window {
  start: string;
  end: string;
}
type Availability = Record<string, Window[]>;
interface Question {
  key: string;
  label: string;
  required?: boolean;
}
interface EventType {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  duration_minutes: number;
  location_type: string;
  location_details: string | null;
  buffer_before_minutes: number;
  buffer_after_minutes: number;
  min_notice_minutes: number;
  date_range_days: number;
  slot_interval_minutes: number;
  timezone: string;
  color: string;
  active: boolean;
  availability: Availability;
  questions: Question[];
  reminder_offsets: number[];
}
interface Booking {
  id: string;
  invitee_name: string;
  invitee_email: string;
  start_at: string;
  status: string;
}

const DAYS: { key: string; label: string }[] = [
  { key: "mon", label: "Mon" },
  { key: "tue", label: "Tue" },
  { key: "wed", label: "Wed" },
  { key: "thu", label: "Thu" },
  { key: "fri", label: "Fri" },
  { key: "sat", label: "Sat" },
  { key: "sun", label: "Sun" },
];
const LOCATIONS = [
  { v: "google_meet", l: "Google Meet" },
  { v: "phone", l: "Phone call" },
  { v: "in_person", l: "In person" },
  { v: "custom", l: "Custom" },
];
const REMINDER_OFFSETS = [
  { minutes: 10080, label: "1 week before" },
  { minutes: 1440, label: "1 day before" },
  { minutes: 60, label: "1 hour before" },
  { minutes: 15, label: "15 min before" },
];

export default function SchedulingPage() {
  const qc = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null);

  const { data } = useQuery<{ event_types: EventType[]; workspace_slug: string }>({
    queryKey: ["event-types"],
    queryFn: () => api("/event-types"),
  });
  const eventTypes = useMemo(() => data?.event_types || [], [data]);
  const workspaceSlug = data?.workspace_slug || "";

  useEffect(() => {
    if (!selected && eventTypes.length) setSelected(eventTypes[0].id);
  }, [eventTypes, selected]);

  const create = useMutation({
    mutationFn: () => api<EventType>("/event-types", { method: "POST", body: { name: "New meeting", duration_minutes: 30 } }),
    onSuccess: (et) => {
      qc.invalidateQueries({ queryKey: ["event-types"] });
      setSelected(et.id);
    },
  });

  const active = eventTypes.find((e) => e.id === selected) || null;

  return (
    <div className="p-6">
      <div className="mb-4 flex items-center gap-2">
        <CalendarRange className="h-5 w-5 text-brand-600" />
        <h1 className="text-lg font-semibold">Scheduling</h1>
      </div>

      <div className="grid gap-6 lg:grid-cols-[260px_1fr]">
        <div className="space-y-2">
          <button
            onClick={() => create.mutate()}
            disabled={create.isPending}
            className="flex w-full items-center justify-center gap-2 rounded-md bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-60"
          >
            <Plus className="h-4 w-4" /> New event type
          </button>
          {eventTypes.map((e) => (
            <button
              key={e.id}
              onClick={() => setSelected(e.id)}
              className={
                "flex w-full items-center gap-2 rounded-md border px-3 py-2 text-left text-sm " +
                (selected === e.id ? "border-brand-300 bg-brand-50" : "border-slate-200 hover:bg-slate-50")
              }
            >
              <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: e.color }} />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium text-slate-800">{e.name}</span>
                <span className="block truncate text-xs text-slate-400">
                  {e.duration_minutes} min{e.active ? "" : " · inactive"}
                </span>
              </span>
            </button>
          ))}
          {eventTypes.length === 0 && (
            <p className="px-1 text-sm text-slate-500">No event types yet. Create one to get a booking link.</p>
          )}
        </div>

        {active ? (
          <Editor key={active.id} et={active} workspaceSlug={workspaceSlug} />
        ) : (
          <div className="card p-8 text-center text-sm text-slate-500">
            Select or create an event type to configure its booking page.
          </div>
        )}
      </div>
    </div>
  );
}

function Editor({ et, workspaceSlug }: { et: EventType; workspaceSlug: string }) {
  const qc = useQueryClient();
  const [form, setForm] = useState<EventType>(et);
  const [copied, setCopied] = useState(false);
  const set = <K extends keyof EventType>(k: K, v: EventType[K]) => setForm((f) => ({ ...f, [k]: v }));

  const bookingUrl = useMemo(() => {
    const origin = typeof window !== "undefined" ? window.location.origin : "";
    return `${origin}/book/${workspaceSlug}/${form.slug}`;
  }, [workspaceSlug, form.slug]);

  const save = useMutation({
    mutationFn: () =>
      api<EventType>(`/event-types/${et.id}`, {
        method: "PATCH",
        body: {
          name: form.name,
          description: form.description,
          duration_minutes: form.duration_minutes,
          location_type: form.location_type,
          location_details: form.location_details,
          buffer_before_minutes: form.buffer_before_minutes,
          buffer_after_minutes: form.buffer_after_minutes,
          min_notice_minutes: form.min_notice_minutes,
          date_range_days: form.date_range_days,
          slot_interval_minutes: form.slot_interval_minutes,
          timezone: form.timezone,
          color: form.color,
          active: form.active,
          availability: form.availability,
          questions: form.questions,
          reminder_offsets: form.reminder_offsets,
        },
      }),
    onSuccess: (updated) => {
      setForm(updated);
      qc.invalidateQueries({ queryKey: ["event-types"] });
    },
  });

  const del = useMutation({
    mutationFn: () => api(`/event-types/${et.id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["event-types"] }),
  });

  const { data: bookingsData } = useQuery<{ bookings: Booking[] }>({
    queryKey: ["event-bookings", et.id],
    queryFn: () => api(`/event-types/${et.id}/bookings`),
  });
  const cancelBooking = useMutation({
    mutationFn: (id: string) => api(`/bookings/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["event-bookings", et.id] }),
  });

  const setDayWindows = (day: string, windows: Window[]) =>
    set("availability", { ...form.availability, [day]: windows });

  return (
    <div className="space-y-5">
      {/* Share link */}
      <div className="card flex flex-wrap items-center gap-2 p-4">
        <span className="text-xs font-medium uppercase tracking-wide text-slate-400">Booking link</span>
        <code className="min-w-0 flex-1 truncate rounded bg-slate-50 px-2 py-1 text-sm text-slate-700">{bookingUrl}</code>
        <button
          onClick={() => {
            navigator.clipboard.writeText(bookingUrl);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
          className="inline-flex items-center gap-1 rounded-md border border-slate-200 px-2.5 py-1 text-sm hover:bg-slate-50"
        >
          {copied ? <Check className="h-4 w-4 text-emerald-600" /> : <Copy className="h-4 w-4" />}
          {copied ? "Copied" : "Copy"}
        </button>
        <a
          href={bookingUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 rounded-md border border-slate-200 px-2.5 py-1 text-sm hover:bg-slate-50"
        >
          <ExternalLink className="h-4 w-4" /> Open
        </a>
      </div>

      {/* Basics */}
      <div className="card space-y-3 p-5">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name">
            <input className="input" value={form.name} onChange={(e) => set("name", e.target.value)} />
          </Field>
          <Field label="Duration (min)">
            <input
              type="number"
              className="input"
              value={form.duration_minutes}
              onChange={(e) => set("duration_minutes", Number(e.target.value))}
            />
          </Field>
        </div>
        <Field label="Description">
          <textarea
            className="input"
            rows={2}
            value={form.description || ""}
            onChange={(e) => set("description", e.target.value)}
          />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Location">
            <select className="input" value={form.location_type} onChange={(e) => set("location_type", e.target.value)}>
              {LOCATIONS.map((l) => (
                <option key={l.v} value={l.v}>
                  {l.l}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Location details">
            <input
              className="input"
              placeholder="Zoom link, phone, address…"
              value={form.location_details || ""}
              onChange={(e) => set("location_details", e.target.value)}
            />
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Timezone">
            <input className="input" value={form.timezone} onChange={(e) => set("timezone", e.target.value)} />
          </Field>
          <Field label="Slot interval (min)">
            <input
              type="number"
              className="input"
              value={form.slot_interval_minutes}
              onChange={(e) => set("slot_interval_minutes", Number(e.target.value))}
            />
          </Field>
          <Field label="Color">
            <input type="color" className="h-9 w-full rounded-md border border-slate-200" value={form.color} onChange={(e) => set("color", e.target.value)} />
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-4">
          <Field label="Buffer before">
            <input type="number" className="input" value={form.buffer_before_minutes} onChange={(e) => set("buffer_before_minutes", Number(e.target.value))} />
          </Field>
          <Field label="Buffer after">
            <input type="number" className="input" value={form.buffer_after_minutes} onChange={(e) => set("buffer_after_minutes", Number(e.target.value))} />
          </Field>
          <Field label="Min notice (min)">
            <input type="number" className="input" value={form.min_notice_minutes} onChange={(e) => set("min_notice_minutes", Number(e.target.value))} />
          </Field>
          <Field label="Bookable days out">
            <input type="number" className="input" value={form.date_range_days} onChange={(e) => set("date_range_days", Number(e.target.value))} />
          </Field>
        </div>
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input type="checkbox" checked={form.active} onChange={(e) => set("active", e.target.checked)} />
          Active (accepting bookings)
        </label>
      </div>

      {/* Availability */}
      <div className="card p-5">
        <h3 className="mb-3 font-semibold">Weekly availability</h3>
        <div className="space-y-2">
          {DAYS.map((d) => {
            const windows = form.availability?.[d.key] || [];
            return (
              <div key={d.key} className="flex flex-wrap items-center gap-2">
                <span className="w-10 text-sm font-medium text-slate-600">{d.label}</span>
                {windows.length === 0 && <span className="text-sm text-slate-400">Unavailable</span>}
                {windows.map((w, i) => (
                  <span key={i} className="flex items-center gap-1">
                    <input
                      type="time"
                      value={w.start}
                      onChange={(e) => {
                        const next = [...windows];
                        next[i] = { ...w, start: e.target.value };
                        setDayWindows(d.key, next);
                      }}
                      className="rounded-md border border-slate-200 px-2 py-1 text-sm"
                    />
                    <span className="text-slate-400">–</span>
                    <input
                      type="time"
                      value={w.end}
                      onChange={(e) => {
                        const next = [...windows];
                        next[i] = { ...w, end: e.target.value };
                        setDayWindows(d.key, next);
                      }}
                      className="rounded-md border border-slate-200 px-2 py-1 text-sm"
                    />
                    <button
                      onClick={() => setDayWindows(d.key, windows.filter((_, j) => j !== i))}
                      className="rounded p-1 text-slate-400 hover:text-rose-600"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </span>
                ))}
                <button
                  onClick={() => setDayWindows(d.key, [...windows, { start: "09:00", end: "17:00" }])}
                  className="rounded-md border border-slate-200 px-2 py-1 text-xs text-slate-600 hover:bg-slate-50"
                >
                  + Add
                </button>
              </div>
            );
          })}
        </div>
      </div>

      {/* Invitee reminders */}
      <div className="card p-5">
        <h3 className="mb-1 font-semibold">Invitee reminders</h3>
        <p className="mb-3 text-xs text-slate-500">
          Automatically email the invitee before the meeting (reduces no-shows).
        </p>
        <div className="flex flex-wrap gap-3 text-sm">
          {REMINDER_OFFSETS.map((o) => (
            <label key={o.minutes} className="flex items-center gap-1.5 text-slate-700">
              <input
                type="checkbox"
                checked={form.reminder_offsets.includes(o.minutes)}
                onChange={(e) =>
                  set(
                    "reminder_offsets",
                    e.target.checked
                      ? [...form.reminder_offsets, o.minutes].sort((a, b) => b - a)
                      : form.reminder_offsets.filter((m) => m !== o.minutes)
                  )
                }
              />
              {o.label}
            </label>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-2">
        <button
          onClick={() => save.mutate()}
          disabled={save.isPending}
          className="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-60"
        >
          {save.isPending ? "Saving…" : "Save event type"}
        </button>
        <button
          onClick={() => {
            if (confirm("Delete this event type?")) del.mutate();
          }}
          className="rounded-md border border-rose-200 px-4 py-2 text-sm font-medium text-rose-600 hover:bg-rose-50"
        >
          Delete
        </button>
      </div>

      {/* Bookings */}
      <div className="card">
        <div className="border-b border-slate-100 px-5 py-3 font-semibold">Bookings</div>
        <ul>
          {(bookingsData?.bookings || []).map((b) => (
            <li key={b.id} className="flex items-center gap-3 border-b border-slate-100 px-5 py-2.5 last:border-0">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-slate-800">
                  {b.invitee_name} <span className="font-normal text-slate-400">· {b.invitee_email}</span>
                </div>
                <div className="text-xs text-slate-400">
                  {new Date(b.start_at).toLocaleString()} · {b.status}
                </div>
              </div>
              {b.status === "confirmed" && (
                <button
                  onClick={() => cancelBooking.mutate(b.id)}
                  className="rounded p-1 text-slate-400 hover:bg-rose-50 hover:text-rose-600"
                  title="Cancel booking"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              )}
            </li>
          ))}
          {(bookingsData?.bookings || []).length === 0 && (
            <li className="px-5 py-6 text-sm text-slate-500">No bookings yet. Share your link to start receiving them.</li>
          )}
        </ul>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-400">{label}</span>
      {children}
    </label>
  );
}
