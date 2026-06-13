"use client";

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import {
  CalendarClock,
  CheckCircle2,
  Trash2,
  Plus,
  Sparkles,
  Mail,
  RefreshCw,
  Link2,
  X,
} from "lucide-react";
import { api } from "@/lib/api";
import { fmtRelative } from "@/lib/utils";

interface CalendarInfo {
  id: string;
  name: string;
  primary?: boolean;
  background_color?: string;
}
interface AgendaCfg {
  enabled: boolean;
  hour: number;
  timezone: string;
  channels: string[];
}
interface AutoReminders {
  inbox_reply: boolean;
  stage_change: boolean;
  note: boolean;
  default_offset_minutes: number;
}
interface CalConn {
  id: string;
  email: string | null;
  label: string | null;
  status: string;
  write_calendar_id: string;
  conflict_calendar_ids: string[];
  calendars: CalendarInfo[];
}
interface CalStatus {
  configured: boolean;
  connected: boolean;
  provider: string | null;
  delivery: { calendar: boolean; email: boolean };
  prefs: { agenda: AgendaCfg; auto_reminders: AutoReminders };
  calendar: CalConn | null;
  redirect_uri: string;
}
interface Reminder {
  id: string;
  title: string;
  body: string | null;
  remind_at: string;
  duration_minutes: number;
  channel: string;
  status: string;
  source: string;
  lead_id: string | null;
  payload: Record<string, unknown>;
  sent_at: string | null;
  error: string | null;
  created_at: string;
}

type Banner = { kind: "ok" | "err"; msg: string } | null;

const SOURCE_LABEL: Record<string, string> = {
  manual: "Manual",
  inbox_reply: "Inbox reply",
  stage_change: "Stage change",
  note: "Note",
  daily_agenda: "Daily agenda",
  booking: "Booking",
};
const STATUS_STYLE: Record<string, string> = {
  pending: "bg-amber-50 text-amber-700",
  scheduled: "bg-amber-50 text-amber-700",
  sent: "bg-emerald-50 text-emerald-700",
  failed: "bg-rose-50 text-rose-700",
  cancelled: "bg-slate-100 text-slate-500",
  skipped: "bg-slate-100 text-slate-500",
};

function localInputValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function CalendarPage() {
  const qc = useQueryClient();
  const [banner, setBanner] = useState<Banner>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const connected = params.get("connected");
    if (connected === "google") setBanner({ kind: "ok", msg: "Google Calendar connected." });
    else if (connected === "error")
      setBanner({ kind: "err", msg: `Connection failed: ${params.get("reason") || "unknown"}` });
    if (connected) window.history.replaceState({}, "", "/calendar");
  }, []);

  const { data: status, isLoading } = useQuery<CalStatus>({
    queryKey: ["calendar-status"],
    queryFn: () => api("/calendar/status"),
    refetchInterval: 30000,
  });

  if (isLoading || !status) {
    return <div className="p-6 text-sm text-slate-500">Loading calendar…</div>;
  }

  const noDelivery = !status.delivery.calendar && !status.delivery.email;

  return (
    <div className="p-6">
      <div className="mb-4 flex items-center gap-2">
        <CalendarClock className="h-5 w-5 text-brand-600" />
        <h1 className="text-lg font-semibold">Calendar &amp; Reminders</h1>
      </div>

      {banner && (
        <div
          className={
            "mb-4 flex items-center justify-between rounded-md px-4 py-2.5 text-sm " +
            (banner.kind === "ok" ? "bg-emerald-50 text-emerald-700" : "bg-rose-50 text-rose-700")
          }
        >
          <span>{banner.msg}</span>
          <button onClick={() => setBanner(null)}>
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {noDelivery && (
        <div className="mb-4 rounded-md bg-amber-50 px-4 py-3 text-sm text-amber-800">
          Reminders need somewhere to go. Connect an email account in{" "}
          <Link href="/settings/integrations" className="font-medium underline">
            Settings → Integrations
          </Link>{" "}
          (any SMTP/Gmail inbox works), or connect Google Calendar below.
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <RemindersPanel setBanner={setBanner} />
        </div>
        <div className="space-y-6">
          <DeliveryCard
            status={status}
            onChanged={() => qc.invalidateQueries({ queryKey: ["calendar-status"] })}
            setBanner={setBanner}
          />
          <ReminderSettings
            status={status}
            onChanged={() => qc.invalidateQueries({ queryKey: ["calendar-status"] })}
            setBanner={setBanner}
          />
        </div>
      </div>
    </div>
  );
}

function DeliveryCard({
  status,
  onChanged,
  setBanner,
}: {
  status: CalStatus;
  onChanged: () => void;
  setBanner: (b: Banner) => void;
}) {
  const qc = useQueryClient();
  const cal = status.calendar;

  const connect = useMutation({
    mutationFn: () => api<{ url: string }>("/calendar/connect/google"),
    onSuccess: (d) => {
      window.location.href = d.url;
    },
    onError: (e: unknown) => setBanner({ kind: "err", msg: (e as Error).message }),
  });
  const disconnect = useMutation({
    mutationFn: () => api("/calendar/connection", { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["calendar-status"] }),
  });
  const refreshCals = useMutation({
    mutationFn: () => api("/calendar/calendars"),
    onSuccess: () => onChanged(),
  });

  const [writeId, setWriteId] = useState(cal?.write_calendar_id || "primary");
  const [conflictIds, setConflictIds] = useState<string[]>(cal?.conflict_calendar_ids || []);
  const saveRoles = useMutation({
    mutationFn: () =>
      api("/calendar/config", {
        method: "PATCH",
        body: { write_calendar_id: writeId, conflict_calendar_ids: conflictIds },
      }),
    onSuccess: () => {
      setBanner({ kind: "ok", msg: "Calendar settings saved." });
      onChanged();
    },
    onError: (e: unknown) => setBanner({ kind: "err", msg: (e as Error).message }),
  });
  const toggleConflict = (id: string) =>
    setConflictIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  return (
    <div className="card p-5">
      <h3 className="mb-3 font-semibold">Delivery</h3>

      {/* Email/SMTP delivery — the simple default */}
      <div className="mb-4 flex items-start gap-2 text-sm">
        <Mail className="mt-0.5 h-4 w-4 shrink-0 text-slate-500" />
        <div>
          <div className="font-medium text-slate-800">Email / SMTP</div>
          {status.delivery.email ? (
            <div className="text-emerald-600">Connected — reminders can be emailed.</div>
          ) : (
            <div className="text-slate-500">
              No email account.{" "}
              <Link href="/settings/integrations" className="text-brand-700 underline">
                Connect one
              </Link>
              .
            </div>
          )}
        </div>
      </div>

      {/* Google Calendar — optional upgrade */}
      <div className="border-t border-slate-100 pt-4">
        <div className="mb-1 flex items-center gap-2">
          <CalendarClock className="h-4 w-4 text-slate-500" />
          <span className="text-sm font-medium text-slate-800">Google Calendar</span>
          {cal && <CheckCircle2 className="h-4 w-4 text-emerald-500" />}
        </div>

        {!cal ? (
          status.configured ? (
            <button
              onClick={() => connect.mutate()}
              disabled={connect.isPending}
              className="mt-1 inline-flex items-center gap-2 rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-60"
            >
              <Link2 className="h-4 w-4" />
              {connect.isPending ? "Redirecting…" : "Connect (optional)"}
            </button>
          ) : (
            <p className="text-xs text-slate-500">Not configured on the server. Email reminders work without it.</p>
          )
        ) : (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="truncate text-sm text-slate-600">{cal.email || cal.label}</span>
              <button onClick={() => disconnect.mutate()} className="text-xs text-slate-400 hover:text-rose-600">
                Disconnect
              </button>
            </div>
            <div className="flex items-center justify-between">
              <label className="text-xs font-medium uppercase tracking-wide text-slate-400">Add events to</label>
              <button
                onClick={() => refreshCals.mutate()}
                className="flex items-center gap-1 text-xs text-slate-500 hover:text-brand-600"
              >
                <RefreshCw className={"h-3.5 w-3.5 " + (refreshCals.isPending ? "animate-spin" : "")} /> Refresh
              </button>
            </div>
            <select
              value={writeId}
              onChange={(e) => setWriteId(e.target.value)}
              className="w-full rounded-md border border-slate-200 px-2 py-1.5 text-sm"
            >
              {cal.calendars.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                  {c.primary ? " (primary)" : ""}
                </option>
              ))}
            </select>
            <div>
              <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-400">
                Check for conflicts
              </label>
              <div className="space-y-1">
                {cal.calendars.map((c) => (
                  <label key={c.id} className="flex items-center gap-2 text-sm text-slate-700">
                    <input
                      type="checkbox"
                      checked={conflictIds.includes(c.id)}
                      onChange={() => toggleConflict(c.id)}
                    />
                    <span className="truncate">{c.name}</span>
                  </label>
                ))}
              </div>
            </div>
            <button
              onClick={() => saveRoles.mutate()}
              disabled={saveRoles.isPending}
              className="w-full rounded-md border border-brand-600 px-3 py-1.5 text-sm font-medium text-brand-700 hover:bg-brand-50 disabled:opacity-60"
            >
              {saveRoles.isPending ? "Saving…" : "Save calendar roles"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function ReminderSettings({
  status,
  onChanged,
  setBanner,
}: {
  status: CalStatus;
  onChanged: () => void;
  setBanner: (b: Banner) => void;
}) {
  const qc = useQueryClient();
  const [agenda, setAgenda] = useState<AgendaCfg>(status.prefs.agenda);
  const [auto, setAuto] = useState<AutoReminders>(status.prefs.auto_reminders);
  const [agendaPreview, setAgendaPreview] = useState<Reminder | null>(null);

  const save = useMutation({
    mutationFn: () => api("/calendar/config", { method: "PATCH", body: { agenda, auto_reminders: auto } }),
    onSuccess: () => {
      setBanner({ kind: "ok", msg: "Reminder settings saved." });
      onChanged();
    },
    onError: (e: unknown) => setBanner({ kind: "err", msg: (e as Error).message }),
  });

  const generate = useMutation({
    mutationFn: () => api<Reminder>("/calendar/agenda/generate", { method: "POST" }),
    onSuccess: (r) => {
      setBanner({ kind: "ok", msg: "Daily agenda generated." });
      qc.invalidateQueries({ queryKey: ["reminders"] });
      setAgendaPreview(r);
    },
    onError: (e: unknown) => setBanner({ kind: "err", msg: (e as Error).message }),
  });

  const calendarAvailable = status.delivery.calendar;

  const toggleChannel = (ch: string, on: boolean) =>
    setAgenda({
      ...agenda,
      channels: on ? [...agenda.channels.filter((c) => c !== ch), ch] : agenda.channels.filter((x) => x !== ch),
    });

  return (
    <>
      <div className="card p-5">
        <h3 className="mb-3 font-semibold">Daily agenda</h3>
        <label className="mb-3 flex items-center gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={agenda.enabled}
            onChange={(e) => setAgenda({ ...agenda, enabled: e.target.checked })}
          />
          Deliver a daily &quot;your day&quot; briefing
        </label>
        <div className="mb-3 flex items-center gap-2 text-sm">
          <span className="text-slate-500">Each day at</span>
          <select
            value={agenda.hour}
            onChange={(e) => setAgenda({ ...agenda, hour: Number(e.target.value) })}
            className="rounded-md border border-slate-200 px-2 py-1"
          >
            {Array.from({ length: 24 }).map((_, h) => (
              <option key={h} value={h}>
                {String(h).padStart(2, "0")}:00
              </option>
            ))}
          </select>
          <span className="text-slate-400">{agenda.timezone}</span>
        </div>
        <div className="mb-4 flex gap-3 text-sm">
          <label className="flex items-center gap-1.5 text-slate-700">
            <input
              type="checkbox"
              checked={agenda.channels.includes("email")}
              onChange={(e) => toggleChannel("email", e.target.checked)}
            />
            Email
          </label>
          <label className={"flex items-center gap-1.5 " + (calendarAvailable ? "text-slate-700" : "text-slate-300")}>
            <input
              type="checkbox"
              disabled={!calendarAvailable}
              checked={agenda.channels.includes("calendar")}
              onChange={(e) => toggleChannel("calendar", e.target.checked)}
            />
            Calendar
          </label>
        </div>
        <button
          onClick={() => generate.mutate()}
          disabled={generate.isPending}
          className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-60"
        >
          <Sparkles className="h-4 w-4" />
          {generate.isPending ? "Generating…" : "Generate today's agenda now"}
        </button>
        {agendaPreview && (
          <pre className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-slate-50 p-3 text-xs text-slate-700">
            {agendaPreview.body}
          </pre>
        )}
      </div>

      <div className="card p-5">
        <h3 className="mb-3 font-semibold">Auto-reminders from CRM</h3>
        <p className="mb-3 text-xs text-slate-500">Create a reminder automatically when these happen.</p>
        {(
          [
            ["inbox_reply", "A lead replies"],
            ["stage_change", "A lead changes pipeline stage"],
            ["note", "I add a note"],
          ] as const
        ).map(([key, label]) => (
          <label key={key} className="mb-2 flex items-center gap-2 text-sm text-slate-700">
            <input type="checkbox" checked={auto[key]} onChange={(e) => setAuto({ ...auto, [key]: e.target.checked })} />
            {label}
          </label>
        ))}
        <div className="mt-2 flex items-center gap-2 text-sm">
          <span className="text-slate-500">Remind</span>
          <input
            type="number"
            min={5}
            value={auto.default_offset_minutes}
            onChange={(e) => setAuto({ ...auto, default_offset_minutes: Number(e.target.value) })}
            className="w-20 rounded-md border border-slate-200 px-2 py-1"
          />
          <span className="text-slate-500">min later</span>
        </div>
      </div>

      <button
        onClick={() => save.mutate()}
        disabled={save.isPending}
        className="w-full rounded-md border border-brand-600 px-3 py-2 text-sm font-medium text-brand-700 hover:bg-brand-50 disabled:opacity-60"
      >
        {save.isPending ? "Saving…" : "Save reminder settings"}
      </button>
    </>
  );
}

function RemindersPanel({ setBanner }: { setBanner: (b: Banner) => void }) {
  const qc = useQueryClient();
  const { data } = useQuery<{ reminders: Reminder[] }>({
    queryKey: ["reminders"],
    queryFn: () => api("/calendar/reminders"),
    refetchInterval: 20000,
  });
  const reminders = useMemo(() => data?.reminders || [], [data]);

  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const [when, setWhen] = useState(localInputValue(new Date(Date.now() + 60 * 60 * 1000)));
  const [channel, setChannel] = useState("email");

  const create = useMutation({
    mutationFn: () =>
      api("/calendar/reminders", {
        method: "POST",
        body: { title, remind_at: new Date(when).toISOString(), channel },
      }),
    onSuccess: () => {
      setTitle("");
      setAdding(false);
      qc.invalidateQueries({ queryKey: ["reminders"] });
    },
    onError: (e: unknown) => setBanner({ kind: "err", msg: (e as Error).message }),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api(`/calendar/reminders/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["reminders"] }),
  });

  const upcoming = useMemo(
    () => reminders.filter((r) => r.status === "pending" || r.status === "scheduled"),
    [reminders]
  );
  const past = useMemo(
    () => reminders.filter((r) => r.status !== "pending" && r.status !== "scheduled"),
    [reminders]
  );

  return (
    <div className="card">
      <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3">
        <h3 className="font-semibold">Reminders</h3>
        <button
          onClick={() => setAdding((v) => !v)}
          className="inline-flex items-center gap-1 text-sm font-medium text-brand-700 hover:text-brand-800"
        >
          <Plus className="h-4 w-4" /> New
        </button>
      </div>

      {adding && (
        <div className="flex flex-wrap items-end gap-2 border-b border-slate-100 bg-slate-50 px-5 py-3">
          <input
            autoFocus
            placeholder="Remind me to…"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="min-w-[12rem] flex-1 rounded-md border border-slate-200 px-2 py-1.5 text-sm"
          />
          <input
            type="datetime-local"
            value={when}
            onChange={(e) => setWhen(e.target.value)}
            className="rounded-md border border-slate-200 px-2 py-1.5 text-sm"
          />
          <select
            value={channel}
            onChange={(e) => setChannel(e.target.value)}
            className="rounded-md border border-slate-200 px-2 py-1.5 text-sm"
          >
            <option value="email">Email</option>
            <option value="calendar">Calendar</option>
          </select>
          <button
            onClick={() => title.trim() && create.mutate()}
            disabled={create.isPending || !title.trim()}
            className="rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-60"
          >
            Add
          </button>
        </div>
      )}

      <ul>
        {[...upcoming, ...past].map((r) => (
          <li key={r.id} className="flex items-center gap-3 border-b border-slate-100 px-5 py-2.5 last:border-0">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate text-sm font-medium text-slate-800">{r.title}</span>
                <span
                  className={
                    "shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium " +
                    (STATUS_STYLE[r.status] || "bg-slate-100 text-slate-500")
                  }
                >
                  {r.status}
                </span>
              </div>
              <div className="text-xs text-slate-400">
                {SOURCE_LABEL[r.source] || r.source} · {r.channel} · {fmtRelative(r.remind_at)}
                {r.error ? ` · ${r.error}` : ""}
              </div>
            </div>
            <button
              onClick={() => remove.mutate(r.id)}
              className="shrink-0 rounded p-1 text-slate-400 hover:bg-rose-50 hover:text-rose-600"
              title="Delete reminder"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </li>
        ))}
        {reminders.length === 0 && (
          <li className="px-5 py-6 text-sm text-slate-500">
            No reminders yet. Add one above, or they&apos;ll appear automatically from replies, stage changes, and
            notes.
          </li>
        )}
      </ul>
    </div>
  );
}
