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
  Bell,
  Inbox,
  ArrowRightLeft,
  StickyNote,
  CalendarCheck,
} from "lucide-react";
import { api } from "@/lib/api";
import { PageHeader, Pill, LiveDot, Skeleton, useNow, liveRelative, type Tone } from "@/components/scheduling-ui";

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
  notify_on_create: boolean;
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
  server_configured: boolean;
  has_workspace_credentials: boolean;
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

const SOURCE_META: Record<string, { label: string; tone: Tone; icon: React.ComponentType<{ className?: string }> }> = {
  manual: { label: "Manual", tone: "slate", icon: Bell },
  inbox_reply: { label: "Reply", tone: "brand", icon: Inbox },
  stage_change: { label: "Stage", tone: "violet", icon: ArrowRightLeft },
  note: { label: "Note", tone: "amber", icon: StickyNote },
  daily_agenda: { label: "Agenda", tone: "emerald", icon: Sparkles },
  booking: { label: "Booking", tone: "brand", icon: CalendarCheck },
  booking_reminder: { label: "Meeting", tone: "brand", icon: CalendarCheck },
  pre_meeting_brief: { label: "Brief", tone: "violet", icon: Sparkles },
};
const STATUS_TONE: Record<string, Tone> = {
  pending: "amber",
  scheduled: "amber",
  sent: "emerald",
  failed: "rose",
  cancelled: "slate",
  skipped: "slate",
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
    refetchInterval: 15000,
    refetchOnWindowFocus: true,
  });

  if (isLoading || !status) {
    return (
      <div className="p-6">
        <PageHeader icon={CalendarClock} title="Calendar & Reminders" subtitle="Loading…" />
        <div className="grid gap-6 lg:grid-cols-3">
          <div className="lg:col-span-2 space-y-3">
            <Skeleton className="h-12" />
            <Skeleton className="h-16" />
            <Skeleton className="h-16" />
          </div>
          <Skeleton className="h-64" />
        </div>
      </div>
    );
  }

  const noDelivery = !status.delivery.calendar && !status.delivery.email;

  return (
    <div className="p-6">
      <PageHeader icon={CalendarClock} title="Calendar & Reminders" subtitle="Your nudges, briefings, and synced calendar — in real time">
        <LiveDot />
      </PageHeader>

      {banner && (
        <div
          className={
            "mb-4 flex items-center justify-between rounded-lg px-4 py-2.5 text-sm shadow-sm " +
            (banner.kind === "ok" ? "bg-emerald-50 text-emerald-700" : "bg-rose-50 text-rose-700")
          }
        >
          <span>{banner.msg}</span>
          <button onClick={() => setBanner(null)} className="opacity-60 hover:opacity-100">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {noDelivery && (
        <div className="mb-4 rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-800 ring-1 ring-inset ring-amber-600/10">
          Reminders need somewhere to go. Connect an email account in{" "}
          <Link href="/settings/integrations" className="font-medium underline">
            Settings → Integrations
          </Link>{" "}
          (any SMTP/Gmail inbox works), or connect Google Calendar.
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <RemindersPanel
            setBanner={setBanner}
            calendars={status.calendar?.calendars || []}
            defaultCalendarId={status.calendar?.write_calendar_id || ""}
          />
        </div>
        <div className="space-y-6">
          <DeliveryCard status={status} onChanged={() => qc.invalidateQueries({ queryKey: ["calendar-status"] })} setBanner={setBanner} />
          <ReminderSettings status={status} onChanged={() => qc.invalidateQueries({ queryKey: ["calendar-status"] })} setBanner={setBanner} />
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

  // Bring-your-own Google OAuth client so connect works with no backend env vars.
  const [setupOpen, setSetupOpen] = useState(false);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [copiedUri, setCopiedUri] = useState(false);
  const saveCreds = useMutation({
    mutationFn: () => api("/calendar/google-credentials", { method: "POST", body: { client_id: clientId.trim(), client_secret: clientSecret.trim() } }),
    onSuccess: () => connect.mutate(),
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
      <h3 className="mb-3 text-sm font-semibold text-slate-900">Delivery</h3>

      <div className="mb-4 flex items-start gap-3 rounded-lg bg-slate-50 p-3 text-sm">
        <div className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-white text-slate-500 shadow-sm">
          <Mail className="h-4 w-4" />
        </div>
        <div className="min-w-0">
          <div className="font-medium text-slate-800">Email / SMTP</div>
          {status.delivery.email ? (
            <div className="flex items-center gap-1 text-emerald-600">
              <CheckCircle2 className="h-3.5 w-3.5" /> Connected — reminders can be emailed.
            </div>
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

      <div className="flex items-start gap-3 rounded-lg bg-slate-50 p-3">
        <div className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-white text-slate-500 shadow-sm">
          <CalendarClock className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-sm font-medium text-slate-800">
            Google Calendar
            {cal && <CheckCircle2 className="h-4 w-4 text-emerald-500" />}
          </div>

          {!cal ? (
            <div className="mt-2 space-y-2">
              <button
                onClick={() => (status.configured ? connect.mutate() : setSetupOpen((v) => !v))}
                disabled={connect.isPending || saveCreds.isPending}
                className="inline-flex items-center gap-2 rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-60"
              >
                <Link2 className="h-4 w-4" />
                {connect.isPending ? "Redirecting…" : "Connect Google Calendar"}
              </button>
              {status.configured && (
                <button onClick={() => setSetupOpen((v) => !v)} className="block text-[11px] text-slate-400 hover:text-slate-600">
                  Use your own Google app
                </button>
              )}
              {(setupOpen || (!status.configured && false)) && (
                <div className="space-y-2 rounded-lg bg-slate-50 p-3 text-xs ring-1 ring-inset ring-slate-200/70">
                  <p className="text-slate-600">
                    Paste a Google OAuth <strong>Web</strong> client (Cloud Console → Credentials, Calendar API enabled).
                    Add this redirect URI to it:
                  </p>
                  <div className="flex items-center gap-1">
                    <code className="min-w-0 flex-1 truncate rounded bg-white px-2 py-1 text-[11px] text-slate-700 ring-1 ring-inset ring-slate-200">
                      {status.redirect_uri}
                    </code>
                    <button
                      onClick={() => {
                        navigator.clipboard.writeText(status.redirect_uri);
                        setCopiedUri(true);
                        setTimeout(() => setCopiedUri(false), 1500);
                      }}
                      className="rounded border border-slate-200 bg-white px-2 py-1 hover:bg-slate-50"
                    >
                      {copiedUri ? "✓" : "Copy"}
                    </button>
                  </div>
                  <input
                    value={clientId}
                    onChange={(e) => setClientId(e.target.value)}
                    placeholder="Client ID"
                    className="w-full rounded-md border border-slate-200 px-2 py-1.5"
                  />
                  <input
                    value={clientSecret}
                    onChange={(e) => setClientSecret(e.target.value)}
                    placeholder="Client Secret"
                    type="password"
                    className="w-full rounded-md border border-slate-200 px-2 py-1.5"
                  />
                  <button
                    onClick={() => saveCreds.mutate()}
                    disabled={saveCreds.isPending || connect.isPending || !clientId.trim() || !clientSecret.trim()}
                    className="w-full rounded-md bg-brand-600 px-3 py-1.5 font-medium text-white hover:bg-brand-700 disabled:opacity-60"
                  >
                    {saveCreds.isPending || connect.isPending ? "Connecting…" : "Save & connect"}
                  </button>
                  <a
                    href="https://console.cloud.google.com/apis/credentials"
                    target="_blank"
                    rel="noreferrer"
                    className="block text-brand-700 hover:underline"
                  >
                    Open Google Cloud Console →
                  </a>
                </div>
              )}
            </div>
          ) : (
            <div className="mt-2 space-y-3">
              <div className="flex items-center justify-between">
                <span className="truncate text-sm text-slate-600">{cal.email || cal.label}</span>
                <button onClick={() => disconnect.mutate()} className="text-xs text-slate-400 hover:text-rose-600">
                  Disconnect
                </button>
              </div>
              <div className="flex items-center justify-between">
                <label className="text-[11px] font-medium uppercase tracking-wide text-slate-400">Add events to</label>
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
                <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-slate-400">
                  Check for conflicts
                </label>
                <div className="space-y-1">
                  {cal.calendars.map((c) => (
                    <label key={c.id} className="flex items-center gap-2 text-sm text-slate-700">
                      <input type="checkbox" checked={conflictIds.includes(c.id)} onChange={() => toggleConflict(c.id)} />
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
        <div className="mb-3 flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-brand-600" />
          <h3 className="text-sm font-semibold text-slate-900">Daily agenda</h3>
        </div>
        <label className="mb-3 flex items-center gap-2 text-sm text-slate-700">
          <input type="checkbox" checked={agenda.enabled} onChange={(e) => setAgenda({ ...agenda, enabled: e.target.checked })} />
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
            <input type="checkbox" checked={agenda.channels.includes("email")} onChange={(e) => toggleChannel("email", e.target.checked)} />
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
          className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-gradient-to-br from-brand-500 to-brand-700 px-3 py-2 text-sm font-medium text-white shadow-sm hover:brightness-110 disabled:opacity-60"
        >
          <Sparkles className="h-4 w-4" />
          {generate.isPending ? "Generating…" : "Generate today's agenda now"}
        </button>
        {agendaPreview && (
          <pre className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap rounded-lg bg-slate-50 p-3 text-xs text-slate-700 ring-1 ring-inset ring-slate-200/60">
            {agendaPreview.body}
          </pre>
        )}
      </div>

      <div className="card p-5">
        <div className="mb-1 flex items-center gap-2">
          <Bell className="h-4 w-4 text-brand-600" />
          <h3 className="text-sm font-semibold text-slate-900">Auto-reminders from CRM</h3>
        </div>
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
        <label className="mt-3 flex items-center gap-2 border-t border-slate-100 pt-3 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={auto.notify_on_create}
            onChange={(e) => setAuto({ ...auto, notify_on_create: e.target.checked })}
          />
          <span className="flex items-center gap-1.5">
            <Mail className="h-3.5 w-3.5 text-slate-400" /> Email me the moment a reminder is created
          </span>
        </label>
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

function RemindersPanel({
  setBanner,
  calendars,
  defaultCalendarId,
}: {
  setBanner: (b: Banner) => void;
  calendars: CalendarInfo[];
  defaultCalendarId: string;
}) {
  const qc = useQueryClient();
  const now = useNow(1000);
  const { data, isFetching } = useQuery<{ reminders: Reminder[] }>({
    queryKey: ["reminders"],
    queryFn: () => api("/calendar/reminders"),
    refetchInterval: 8000,
    refetchOnWindowFocus: true,
  });
  const reminders = useMemo(() => data?.reminders || [], [data]);

  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const [when, setWhen] = useState(localInputValue(new Date(Date.now() + 60 * 60 * 1000)));
  const [channel, setChannel] = useState("email");
  const [calId, setCalId] = useState(defaultCalendarId);

  const create = useMutation({
    mutationFn: () =>
      api("/calendar/reminders", {
        method: "POST",
        body: {
          title,
          remind_at: new Date(when).toISOString(),
          channel,
          target_calendar_id: channel === "calendar" && calId ? calId : null,
        },
      }),
    onSuccess: () => {
      setTitle("");
      setAdding(false);
      qc.invalidateQueries({ queryKey: ["reminders"] });
    },
    onError: (e: unknown) => setBanner({ kind: "err", msg: (e as Error).message }),
  });

  // Optimistic delete for an instant, dynamic feel.
  const remove = useMutation({
    mutationFn: (id: string) => api(`/calendar/reminders/${id}`, { method: "DELETE" }),
    onMutate: async (id: string) => {
      await qc.cancelQueries({ queryKey: ["reminders"] });
      const prev = qc.getQueryData<{ reminders: Reminder[] }>(["reminders"]);
      qc.setQueryData<{ reminders: Reminder[] }>(["reminders"], (old) =>
        old ? { reminders: old.reminders.filter((r) => r.id !== id) } : old
      );
      return { prev };
    },
    onError: (_e, _id, ctx) => {
      if (ctx?.prev) qc.setQueryData(["reminders"], ctx.prev);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ["reminders"] }),
  });

  const upcoming = useMemo(
    () => reminders.filter((r) => r.status === "pending" || r.status === "scheduled").sort((a, b) => +new Date(a.remind_at) - +new Date(b.remind_at)),
    [reminders]
  );
  const past = useMemo(
    () => reminders.filter((r) => r.status !== "pending" && r.status !== "scheduled").sort((a, b) => +new Date(b.remind_at) - +new Date(a.remind_at)),
    [reminders]
  );
  const next = upcoming[0];

  return (
    <div className="card overflow-hidden">
      <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold text-slate-900">Reminders</h3>
          <Pill tone="amber">{upcoming.length} upcoming</Pill>
          {isFetching && <RefreshCw className="h-3 w-3 animate-spin text-slate-300" />}
        </div>
        <button
          onClick={() => setAdding((v) => !v)}
          className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-sm font-medium text-brand-700 hover:bg-brand-50"
        >
          <Plus className="h-4 w-4" /> New
        </button>
      </div>

      {/* Next-up strip */}
      {next && (
        <div className="flex items-center gap-3 border-b border-slate-100 bg-gradient-to-r from-brand-50/60 to-transparent px-5 py-2.5">
          <Bell className="h-4 w-4 shrink-0 text-brand-600" />
          <span className="min-w-0 flex-1 truncate text-sm text-slate-700">
            Next: <span className="font-medium">{next.title}</span>
          </span>
          <span className="shrink-0 font-mono text-xs font-semibold text-brand-700">{liveRelative(next.remind_at, now).text}</span>
        </div>
      )}

      {adding && (
        <div className="flex flex-wrap items-end gap-2 border-b border-slate-100 bg-slate-50 px-5 py-3">
          <input
            autoFocus
            placeholder="Remind me to…"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="min-w-[12rem] flex-1 rounded-md border border-slate-200 px-2 py-1.5 text-sm"
          />
          <input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} className="rounded-md border border-slate-200 px-2 py-1.5 text-sm" />
          <select value={channel} onChange={(e) => setChannel(e.target.value)} className="rounded-md border border-slate-200 px-2 py-1.5 text-sm">
            <option value="email">Email</option>
            <option value="calendar">Calendar</option>
          </select>
          {channel === "calendar" && calendars.length > 0 && (
            <select
              value={calId}
              onChange={(e) => setCalId(e.target.value)}
              className="max-w-[12rem] rounded-md border border-slate-200 px-2 py-1.5 text-sm"
              title="Which calendar to add this to"
            >
              {calendars.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                  {c.primary ? " (primary)" : ""}
                </option>
              ))}
            </select>
          )}
          <button
            onClick={() => title.trim() && create.mutate()}
            disabled={create.isPending || !title.trim()}
            className="rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-60"
          >
            Add
          </button>
        </div>
      )}

      <ul className="divide-y divide-slate-100">
        {upcoming.map((r) => (
          <ReminderRow key={r.id} r={r} now={now} onDelete={() => remove.mutate(r.id)} />
        ))}
        {past.length > 0 && (
          <li className="bg-slate-50/60 px-5 py-1.5 text-[11px] font-medium uppercase tracking-wide text-slate-400">Delivered</li>
        )}
        {past.map((r) => (
          <ReminderRow key={r.id} r={r} now={now} onDelete={() => remove.mutate(r.id)} muted />
        ))}
        {reminders.length === 0 && (
          <li className="flex flex-col items-center gap-2 px-5 py-12 text-center">
            <div className="grid h-10 w-10 place-items-center rounded-full bg-slate-100 text-slate-400">
              <Bell className="h-5 w-5" />
            </div>
            <p className="text-sm text-slate-500">No reminders yet.</p>
            <p className="max-w-xs text-xs text-slate-400">Add one above, or they&apos;ll appear automatically from replies, stage changes, and notes.</p>
          </li>
        )}
      </ul>
    </div>
  );
}

function ReminderRow({ r, now, onDelete, muted }: { r: Reminder; now: number; onDelete: () => void; muted?: boolean }) {
  const meta = SOURCE_META[r.source] || SOURCE_META.manual;
  const Icon = meta.icon;
  const rel = liveRelative(r.remind_at, now);
  return (
    <li className={"group flex items-center gap-3 px-5 py-2.5 transition-colors hover:bg-slate-50/70 " + (muted ? "opacity-70" : "")}>
      <div className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg ${muted ? "bg-slate-100 text-slate-400" : "bg-brand-50 text-brand-600"}`}>
        <Icon className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium text-slate-800">{r.title}</span>
          <Pill tone={STATUS_TONE[r.status] || "slate"} dot>
            {r.status}
          </Pill>
        </div>
        <div className="flex items-center gap-1.5 text-xs text-slate-400">
          <Pill tone={meta.tone}>{meta.label}</Pill>
          {r.channel === "calendar" ? <CalendarClock className="h-3 w-3" /> : <Mail className="h-3 w-3" />}
          <span>·</span>
          <span className={!rel.isPast && (r.status === "pending" || r.status === "scheduled") ? "font-medium text-brand-600" : ""}>{rel.text}</span>
          {r.error ? <span className="truncate text-rose-500">· {r.error}</span> : null}
        </div>
      </div>
      <button
        onClick={onDelete}
        className="shrink-0 rounded p-1 text-slate-300 opacity-0 transition-opacity hover:bg-rose-50 hover:text-rose-600 group-hover:opacity-100"
        title="Delete reminder"
      >
        <Trash2 className="h-4 w-4" />
      </button>
    </li>
  );
}
