"use client";

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarRange, Plus, Trash2, Copy, ExternalLink, Check, Code } from "lucide-react";
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
  assignment: string;
  host_ids: string[];
  brief_offset_minutes: number;
}
interface Member {
  id: string;
  name: string;
}
interface Booking {
  id: string;
  invitee_name: string;
  invitee_email: string;
  start_at: string;
  status: string;
  disposition: string | null;
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

  const { data } = useQuery<{ event_types: EventType[]; workspace_slug: string; members: Member[] }>({
    queryKey: ["event-types"],
    queryFn: () => api("/event-types"),
  });
  const eventTypes = useMemo(() => data?.event_types || [], [data]);
  const workspaceSlug = data?.workspace_slug || "";
  const members = useMemo(() => data?.members || [], [data]);

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
  const [tab, setTab] = useState<"events" | "workflows" | "routing">("events");

  return (
    <div className="p-6">
      <div className="mb-4 flex items-center gap-2">
        <CalendarRange className="h-5 w-5 text-brand-600" />
        <h1 className="text-lg font-semibold">Scheduling</h1>
      </div>

      <div className="mb-4 flex gap-1 border-b border-slate-200">
        {(["events", "workflows", "routing"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={
              "relative px-4 py-2 text-sm font-medium capitalize " +
              (tab === t
                ? "text-brand-700 after:absolute after:inset-x-3 after:-bottom-px after:h-0.5 after:bg-brand-600"
                : "text-slate-500 hover:text-slate-700")
            }
          >
            {t === "events" ? "Event types" : t}
          </button>
        ))}
      </div>

      {tab === "workflows" ? (
        <WorkflowsManager eventTypes={eventTypes} />
      ) : tab === "routing" ? (
        <RoutingManager eventTypes={eventTypes} />
      ) : (
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
          <Editor key={active.id} et={active} workspaceSlug={workspaceSlug} members={members} />
        ) : (
          <div className="card p-8 text-center text-sm text-slate-500">
            Select or create an event type to configure its booking page.
          </div>
        )}
      </div>
      )}
    </div>
  );
}

function Editor({ et, workspaceSlug, members }: { et: EventType; workspaceSlug: string; members: Member[] }) {
  const qc = useQueryClient();
  const [form, setForm] = useState<EventType>(et);
  const [copied, setCopied] = useState(false);
  const [embedCopied, setEmbedCopied] = useState(false);
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
          assignment: form.assignment,
          host_ids: form.host_ids,
          brief_offset_minutes: form.brief_offset_minutes,
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
  const disposition = useMutation({
    mutationFn: ({ id, disposition }: { id: string; disposition: string }) =>
      api(`/bookings/${id}/disposition`, { method: "PATCH", body: { disposition } }),
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
        <button
          onClick={() => {
            const snippet = `<iframe src="${bookingUrl}?embed=1" width="100%" height="720" frameborder="0" style="border:0;"></iframe>`;
            navigator.clipboard.writeText(snippet);
            setEmbedCopied(true);
            setTimeout(() => setEmbedCopied(false), 1500);
          }}
          className="inline-flex items-center gap-1 rounded-md border border-slate-200 px-2.5 py-1 text-sm hover:bg-slate-50"
          title="Copy an iframe snippet to embed this booking page on any website"
        >
          {embedCopied ? <Check className="h-4 w-4 text-emerald-600" /> : <Code className="h-4 w-4" />}
          {embedCopied ? "Copied" : "Embed"}
        </button>
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

      {/* Team scheduling */}
      <div className="card p-5">
        <h3 className="mb-1 font-semibold">Team scheduling</h3>
        <p className="mb-3 text-xs text-slate-500">Distribute bookings across teammates (round-robin by load + availability).</p>
        <div className="mb-3 flex gap-4 text-sm">
          {(["single", "round_robin"] as const).map((a) => (
            <label key={a} className="flex items-center gap-1.5 text-slate-700">
              <input type="radio" checked={form.assignment === a} onChange={() => set("assignment", a)} />
              {a === "single" ? "Just me" : "Round-robin"}
            </label>
          ))}
        </div>
        {form.assignment === "round_robin" && (
          <div className="space-y-1">
            <span className="text-xs font-medium uppercase tracking-wide text-slate-400">Hosts</span>
            {members.map((m) => (
              <label key={m.id} className="flex items-center gap-2 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={form.host_ids.includes(m.id)}
                  onChange={(e) =>
                    set("host_ids", e.target.checked ? [...form.host_ids, m.id] : form.host_ids.filter((x) => x !== m.id))
                  }
                />
                {m.name}
              </label>
            ))}
            {members.length === 0 && <p className="text-xs text-slate-400">No teammates in this workspace yet.</p>}
          </div>
        )}
      </div>

      {/* Pre-meeting brief */}
      <div className="card p-5">
        <h3 className="mb-1 font-semibold">Pre-meeting brief</h3>
        <p className="mb-3 text-xs text-slate-500">
          Send the host a brief (lead context + the invitee&apos;s answers) before the meeting.
        </p>
        <div className="flex items-center gap-2 text-sm">
          <input
            type="number"
            min={0}
            value={form.brief_offset_minutes}
            onChange={(e) => set("brief_offset_minutes", Number(e.target.value))}
            className="w-24 rounded-md border border-slate-200 px-2 py-1"
          />
          <span className="text-slate-500">minutes before (0 = off)</span>
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
                  {b.disposition ? ` · ${b.disposition.replace("_", "-")}` : ""}
                </div>
              </div>
              {b.status === "confirmed" && !b.disposition && new Date(b.start_at).getTime() < Date.now() && (
                <>
                  <button
                    onClick={() => disposition.mutate({ id: b.id, disposition: "completed" })}
                    className="rounded border border-emerald-200 px-2 py-0.5 text-xs font-medium text-emerald-700 hover:bg-emerald-50"
                    title="Mark completed"
                  >
                    Done
                  </button>
                  <button
                    onClick={() => disposition.mutate({ id: b.id, disposition: "no_show" })}
                    className="rounded border border-amber-200 px-2 py-0.5 text-xs font-medium text-amber-700 hover:bg-amber-50"
                    title="Mark no-show"
                  >
                    No-show
                  </button>
                </>
              )}
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

// ---------------------------------------------------------------------------
// Workflows
// ---------------------------------------------------------------------------

interface WfAction {
  type: string;
  params: Record<string, string | number>;
}
interface Workflow {
  id: string;
  name: string;
  trigger: string;
  active: boolean;
  filters: Record<string, string>;
  actions: WfAction[];
}

const TRIGGER_LABEL: Record<string, string> = {
  booking_created: "When a booking is made",
  booking_cancelled: "When a booking is cancelled",
  meeting_completed: "When a meeting is marked completed",
  meeting_no_show: "When a meeting is marked no-show",
};
const ACTION_LABEL: Record<string, string> = {
  send_email: "Send email",
  create_task: "Create task",
  move_stage: "Move pipeline stage",
  add_tag: "Add tag",
  schedule_reminder: "Schedule reminder",
};

function WorkflowsManager({ eventTypes }: { eventTypes: EventType[] }) {
  const qc = useQueryClient();
  const { data } = useQuery<{ workflows: Workflow[]; triggers: string[]; action_types: string[] }>({
    queryKey: ["workflows"],
    queryFn: () => api("/workflows"),
  });
  const workflows = data?.workflows || [];

  const create = useMutation({
    mutationFn: () =>
      api("/workflows", {
        method: "POST",
        body: { name: "New workflow", trigger: "booking_created", actions: [] },
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["workflows"] }),
  });

  return (
    <div className="max-w-3xl space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-slate-500">
          Automate what happens around your meetings — send a follow-up, create a task, move the lead, or tag it.
        </p>
        <button
          onClick={() => create.mutate()}
          disabled={create.isPending}
          className="flex shrink-0 items-center gap-1.5 rounded-md bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-60"
        >
          <Plus className="h-4 w-4" /> New workflow
        </button>
      </div>
      {workflows.length === 0 && (
        <div className="card p-8 text-center text-sm text-slate-500">No workflows yet.</div>
      )}
      {workflows.map((w) => (
        <WorkflowCard key={w.id} wf={w} eventTypes={eventTypes} actionTypes={data?.action_types || []} />
      ))}
    </div>
  );
}

function WorkflowCard({
  wf,
  eventTypes,
  actionTypes,
}: {
  wf: Workflow;
  eventTypes: EventType[];
  actionTypes: string[];
}) {
  const qc = useQueryClient();
  const [form, setForm] = useState<Workflow>(wf);

  const save = useMutation({
    mutationFn: () =>
      api(`/workflows/${wf.id}`, {
        method: "PATCH",
        body: { name: form.name, trigger: form.trigger, active: form.active, filters: form.filters, actions: form.actions },
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["workflows"] }),
  });
  const del = useMutation({
    mutationFn: () => api(`/workflows/${wf.id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["workflows"] }),
  });

  const setAction = (i: number, next: WfAction) =>
    setForm({ ...form, actions: form.actions.map((a, j) => (j === i ? next : a)) });
  const addAction = () =>
    setForm({ ...form, actions: [...form.actions, { type: "send_email", params: { to: "invitee" } }] });
  const removeAction = (i: number) => setForm({ ...form, actions: form.actions.filter((_, j) => j !== i) });

  return (
    <div className="card space-y-3 p-5">
      <div className="flex items-center gap-2">
        <input
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          className="flex-1 rounded-md border border-slate-200 px-2 py-1.5 text-sm font-medium"
        />
        <label className="flex items-center gap-1.5 text-sm text-slate-600">
          <input type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} />
          Active
        </label>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-400">Trigger</span>
          <select
            value={form.trigger}
            onChange={(e) => setForm({ ...form, trigger: e.target.value })}
            className="w-full rounded-md border border-slate-200 px-2 py-1.5 text-sm"
          >
            {Object.keys(TRIGGER_LABEL).map((t) => (
              <option key={t} value={t}>
                {TRIGGER_LABEL[t]}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-400">Limit to event type</span>
          <select
            value={form.filters?.event_type_id || ""}
            onChange={(e) => setForm({ ...form, filters: e.target.value ? { event_type_id: e.target.value } : {} })}
            className="w-full rounded-md border border-slate-200 px-2 py-1.5 text-sm"
          >
            <option value="">Any event type</option>
            {eventTypes.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="space-y-2">
        <span className="text-xs font-medium uppercase tracking-wide text-slate-400">Actions</span>
        {form.actions.map((a, i) => (
          <ActionEditor
            key={i}
            action={a}
            actionTypes={actionTypes}
            onChange={(next) => setAction(i, next)}
            onRemove={() => removeAction(i)}
          />
        ))}
        <button onClick={addAction} className="rounded-md border border-slate-200 px-2 py-1 text-xs text-slate-600 hover:bg-slate-50">
          + Add action
        </button>
      </div>

      <div className="flex items-center gap-2 pt-1">
        <button
          onClick={() => save.mutate()}
          disabled={save.isPending}
          className="rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-60"
        >
          {save.isPending ? "Saving…" : "Save"}
        </button>
        <button
          onClick={() => confirm("Delete this workflow?") && del.mutate()}
          className="rounded-md border border-rose-200 px-3 py-1.5 text-sm font-medium text-rose-600 hover:bg-rose-50"
        >
          Delete
        </button>
      </div>
    </div>
  );
}

function ActionEditor({
  action,
  actionTypes,
  onChange,
  onRemove,
}: {
  action: WfAction;
  actionTypes: string[];
  onChange: (a: WfAction) => void;
  onRemove: () => void;
}) {
  const p = action.params || {};
  const setP = (k: string, v: string | number) => onChange({ ...action, params: { ...p, [k]: v } });
  const types = actionTypes.length ? actionTypes : Object.keys(ACTION_LABEL);

  return (
    <div className="rounded-md border border-slate-200 p-3">
      <div className="mb-2 flex items-center gap-2">
        <select
          value={action.type}
          onChange={(e) => onChange({ type: e.target.value, params: {} })}
          className="rounded-md border border-slate-200 px-2 py-1 text-sm font-medium"
        >
          {types.map((t) => (
            <option key={t} value={t}>
              {ACTION_LABEL[t] || t}
            </option>
          ))}
        </select>
        <button onClick={onRemove} className="ml-auto rounded p-1 text-slate-400 hover:text-rose-600">
          <Trash2 className="h-4 w-4" />
        </button>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {action.type === "send_email" && (
          <>
            <Sel label="To" value={String(p.to || "invitee")} options={["invitee", "owner"]} onChange={(v) => setP("to", v)} />
            <Inp label="Subject" value={String(p.subject || "")} onChange={(v) => setP("subject", v)} />
            <div className="sm:col-span-2">
              <Inp label="Body" value={String(p.body || "")} onChange={(v) => setP("body", v)} textarea />
            </div>
          </>
        )}
        {action.type === "create_task" && (
          <>
            <Inp label="Title" value={String(p.title || "")} onChange={(v) => setP("title", v)} />
            <Inp label="Due in (hours)" value={String(p.due_in_hours ?? "")} onChange={(v) => setP("due_in_hours", v)} />
          </>
        )}
        {action.type === "move_stage" && (
          <Inp label="Stage slug" value={String(p.stage_slug || "")} onChange={(v) => setP("stage_slug", v)} />
        )}
        {action.type === "add_tag" && <Inp label="Tag" value={String(p.tag || "")} onChange={(v) => setP("tag", v)} />}
        {action.type === "schedule_reminder" && (
          <>
            <Sel label="To" value={String(p.to || "owner")} options={["owner", "invitee"]} onChange={(v) => setP("to", v)} />
            <Inp label="Offset (min, +after start)" value={String(p.offset_minutes ?? "60")} onChange={(v) => setP("offset_minutes", v)} />
            <div className="sm:col-span-2">
              <Inp label="Message" value={String(p.body || "")} onChange={(v) => setP("body", v)} textarea />
            </div>
          </>
        )}
      </div>
      <p className="mt-2 text-[11px] text-slate-400">
        Merge tags: {"{invitee_name}"} {"{event_name}"} {"{owner_name}"} {"{start}"} {"{lead_name}"}
      </p>
    </div>
  );
}

function Inp({
  label,
  value,
  onChange,
  textarea,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  textarea?: boolean;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-slate-400">{label}</span>
      {textarea ? (
        <textarea value={value} onChange={(e) => onChange(e.target.value)} rows={2} className="w-full rounded-md border border-slate-200 px-2 py-1 text-sm" />
      ) : (
        <input value={value} onChange={(e) => onChange(e.target.value)} className="w-full rounded-md border border-slate-200 px-2 py-1 text-sm" />
      )}
    </label>
  );
}

function Sel({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (v: string) => void;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-slate-400">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} className="w-full rounded-md border border-slate-200 px-2 py-1 text-sm">
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </label>
  );
}

// ---------------------------------------------------------------------------
// Routing forms
// ---------------------------------------------------------------------------

interface RFField {
  key: string;
  label: string;
  type: string;
  options?: string[];
}
interface RFAction {
  type: string;
  target: string;
}
interface RFRule {
  conditions: { field: string; op: string; value: string }[];
  action: RFAction;
}
interface RoutingFormT {
  id: string;
  name: string;
  slug: string;
  active: boolean;
  fields: RFField[];
  rules: RFRule[];
  default_action: RFAction;
}

function RoutingManager({ eventTypes }: { eventTypes: EventType[] }) {
  const qc = useQueryClient();
  const { data } = useQuery<{ forms: RoutingFormT[]; workspace_slug: string }>({
    queryKey: ["routing-forms"],
    queryFn: () => api("/routing-forms"),
  });
  const forms = data?.forms || [];
  const wsSlug = data?.workspace_slug || "";

  const create = useMutation({
    mutationFn: () => api("/routing-forms", { method: "POST", body: { name: "New routing form" } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["routing-forms"] }),
  });

  return (
    <div className="max-w-3xl space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-slate-500">Ask qualifying questions, then send each prospect to the right meeting or a URL.</p>
        <button
          onClick={() => create.mutate()}
          disabled={create.isPending}
          className="flex shrink-0 items-center gap-1.5 rounded-md bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-60"
        >
          <Plus className="h-4 w-4" /> New form
        </button>
      </div>
      {forms.length === 0 && <div className="card p-8 text-center text-sm text-slate-500">No routing forms yet.</div>}
      {forms.map((f) => (
        <RoutingCard key={f.id} form={f} eventTypes={eventTypes} workspaceSlug={wsSlug} />
      ))}
    </div>
  );
}

function RoutingCard({ form: initial, eventTypes, workspaceSlug }: { form: RoutingFormT; eventTypes: EventType[]; workspaceSlug: string }) {
  const qc = useQueryClient();
  const [form, setForm] = useState<RoutingFormT>(initial);
  const [copied, setCopied] = useState(false);
  const url = typeof window !== "undefined" ? `${window.location.origin}/route/${workspaceSlug}/${form.slug}` : "";

  const save = useMutation({
    mutationFn: () =>
      api(`/routing-forms/${form.id}`, {
        method: "PATCH",
        body: { name: form.name, active: form.active, fields: form.fields, rules: form.rules, default_action: form.default_action },
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["routing-forms"] }),
  });
  const del = useMutation({
    mutationFn: () => api(`/routing-forms/${form.id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["routing-forms"] }),
  });

  const fieldKeys = form.fields.map((f) => f.key).filter(Boolean);

  return (
    <div className="card space-y-3 p-5">
      <div className="flex items-center gap-2">
        <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="flex-1 rounded-md border border-slate-200 px-2 py-1.5 text-sm font-medium" />
        <label className="flex items-center gap-1.5 text-sm text-slate-600">
          <input type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} /> Active
        </label>
      </div>

      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded bg-slate-50 px-2 py-1 text-xs text-slate-600">{url}</code>
        <button
          onClick={() => {
            navigator.clipboard.writeText(url);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
          className="inline-flex items-center gap-1 rounded-md border border-slate-200 px-2 py-1 text-xs hover:bg-slate-50"
        >
          {copied ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Copy className="h-3.5 w-3.5" />} {copied ? "Copied" : "Copy"}
        </button>
      </div>

      {/* Fields */}
      <div>
        <span className="text-xs font-medium uppercase tracking-wide text-slate-400">Questions</span>
        <div className="mt-1 space-y-2">
          {form.fields.map((fld, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2">
              <input
                placeholder="Question label"
                value={fld.label}
                onChange={(e) => {
                  const label = e.target.value;
                  const key = label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
                  setForm({ ...form, fields: form.fields.map((x, j) => (j === i ? { ...x, label, key } : x)) });
                }}
                className="min-w-[10rem] flex-1 rounded-md border border-slate-200 px-2 py-1 text-sm"
              />
              <select
                value={fld.type}
                onChange={(e) => setForm({ ...form, fields: form.fields.map((x, j) => (j === i ? { ...x, type: e.target.value } : x)) })}
                className="rounded-md border border-slate-200 px-2 py-1 text-sm"
              >
                <option value="text">Text</option>
                <option value="select">Choices</option>
              </select>
              {fld.type === "select" && (
                <input
                  placeholder="Option A, Option B"
                  value={(fld.options || []).join(", ")}
                  onChange={(e) =>
                    setForm({ ...form, fields: form.fields.map((x, j) => (j === i ? { ...x, options: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) } : x)) })
                  }
                  className="min-w-[10rem] flex-1 rounded-md border border-slate-200 px-2 py-1 text-sm"
                />
              )}
              <button onClick={() => setForm({ ...form, fields: form.fields.filter((_, j) => j !== i) })} className="rounded p-1 text-slate-400 hover:text-rose-600">
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
          <button
            onClick={() => setForm({ ...form, fields: [...form.fields, { key: "", label: "", type: "text" }] })}
            className="rounded-md border border-slate-200 px-2 py-1 text-xs text-slate-600 hover:bg-slate-50"
          >
            + Add question
          </button>
        </div>
      </div>

      {/* Rules */}
      <div>
        <span className="text-xs font-medium uppercase tracking-wide text-slate-400">Rules (first match wins)</span>
        <div className="mt-1 space-y-2">
          {form.rules.map((rule, ri) => (
            <div key={ri} className="rounded-md border border-slate-200 p-2">
              {rule.conditions.map((c, ci) => (
                <div key={ci} className="mb-1 flex flex-wrap items-center gap-1 text-sm">
                  <span className="text-slate-400">If</span>
                  <select
                    value={c.field}
                    onChange={(e) => updateCond(setForm, form, ri, ci, { field: e.target.value })}
                    className="rounded border border-slate-200 px-1.5 py-1 text-sm"
                  >
                    <option value="">field…</option>
                    {fieldKeys.map((k) => (
                      <option key={k} value={k}>
                        {k}
                      </option>
                    ))}
                  </select>
                  <select
                    value={c.op}
                    onChange={(e) => updateCond(setForm, form, ri, ci, { op: e.target.value })}
                    className="rounded border border-slate-200 px-1.5 py-1 text-sm"
                  >
                    <option value="equals">is</option>
                    <option value="not_equals">is not</option>
                    <option value="contains">contains</option>
                  </select>
                  <input
                    value={c.value}
                    onChange={(e) => updateCond(setForm, form, ri, ci, { value: e.target.value })}
                    placeholder="value"
                    className="w-28 rounded border border-slate-200 px-1.5 py-1 text-sm"
                  />
                </div>
              ))}
              <button
                onClick={() =>
                  setForm({ ...form, rules: form.rules.map((r, j) => (j === ri ? { ...r, conditions: [...r.conditions, { field: "", op: "equals", value: "" }] } : r)) })
                }
                className="mb-2 text-xs text-brand-700 hover:underline"
              >
                + condition
              </button>
              <ActionPicker
                eventTypes={eventTypes}
                value={rule.action}
                onChange={(a) => setForm({ ...form, rules: form.rules.map((r, j) => (j === ri ? { ...r, action: a } : r)) })}
              />
              <button onClick={() => setForm({ ...form, rules: form.rules.filter((_, j) => j !== ri) })} className="mt-1 text-xs text-rose-600 hover:underline">
                Remove rule
              </button>
            </div>
          ))}
          <button
            onClick={() => setForm({ ...form, rules: [...form.rules, { conditions: [{ field: "", op: "equals", value: "" }], action: { type: "event", target: "" } }] })}
            className="rounded-md border border-slate-200 px-2 py-1 text-xs text-slate-600 hover:bg-slate-50"
          >
            + Add rule
          </button>
        </div>
      </div>

      {/* Default action */}
      <div>
        <span className="text-xs font-medium uppercase tracking-wide text-slate-400">Otherwise (default)</span>
        <div className="mt-1">
          <ActionPicker eventTypes={eventTypes} value={form.default_action} onChange={(a) => setForm({ ...form, default_action: a })} />
        </div>
      </div>

      <div className="flex items-center gap-2 pt-1">
        <button onClick={() => save.mutate()} disabled={save.isPending} className="rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-60">
          {save.isPending ? "Saving…" : "Save"}
        </button>
        <button onClick={() => confirm("Delete this form?") && del.mutate()} className="rounded-md border border-rose-200 px-3 py-1.5 text-sm font-medium text-rose-600 hover:bg-rose-50">
          Delete
        </button>
      </div>
    </div>
  );
}

function updateCond(
  setForm: React.Dispatch<React.SetStateAction<RoutingFormT>>,
  form: RoutingFormT,
  ri: number,
  ci: number,
  patch: Partial<{ field: string; op: string; value: string }>
) {
  setForm({
    ...form,
    rules: form.rules.map((r, j) =>
      j === ri ? { ...r, conditions: r.conditions.map((c, k) => (k === ci ? { ...c, ...patch } : c)) } : r
    ),
  });
}

function ActionPicker({ eventTypes, value, onChange }: { eventTypes: EventType[]; value: RFAction; onChange: (a: RFAction) => void }) {
  const v = value || { type: "event", target: "" };
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <span className="text-slate-400">→</span>
      <select value={v.type} onChange={(e) => onChange({ type: e.target.value, target: "" })} className="rounded border border-slate-200 px-1.5 py-1 text-sm">
        <option value="event">Book event</option>
        <option value="url">External URL</option>
      </select>
      {v.type === "event" ? (
        <select value={v.target} onChange={(e) => onChange({ ...v, target: e.target.value })} className="rounded border border-slate-200 px-1.5 py-1 text-sm">
          <option value="">choose…</option>
          {eventTypes.map((e) => (
            <option key={e.id} value={e.slug}>
              {e.name}
            </option>
          ))}
        </select>
      ) : (
        <input value={v.target} onChange={(e) => onChange({ ...v, target: e.target.value })} placeholder="https://…" className="min-w-[12rem] flex-1 rounded border border-slate-200 px-1.5 py-1 text-sm" />
      )}
    </div>
  );
}
