"use client";

import { use, useMemo, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Clock, MapPin, Calendar, Check, ArrowLeft } from "lucide-react";
import { api } from "@/lib/api";

interface Question {
  key: string;
  label: string;
  required?: boolean;
}
interface PublicEvent {
  name: string;
  slug: string;
  description: string | null;
  duration_minutes: number;
  location_type: string;
  location_details: string | null;
  timezone: string;
  color: string;
  questions: Question[];
  owner_name: string | null;
}

const LOCATION_LABEL: Record<string, string> = {
  google_meet: "Google Meet",
  phone: "Phone call",
  in_person: "In person",
  custom: "Custom",
};

export default function PublicBookingPage({
  params,
}: {
  params: Promise<{ workspace: string; event: string }>;
}) {
  const { workspace, event } = use(params);
  const base = `/book/${workspace}/${event}`;

  const { data: ev, isLoading, isError } = useQuery<PublicEvent>({
    queryKey: ["public-event", workspace, event],
    queryFn: () => api(base),
    retry: false,
  });

  const { data: slotData } = useQuery<{ slots: string[]; timezone: string; duration_minutes: number }>({
    queryKey: ["public-slots", workspace, event],
    queryFn: () => api(`${base}/slots?days=21`),
    enabled: !!ev,
  });

  const [selected, setSelected] = useState<string | null>(null);
  const [done, setDone] = useState<{ start: string } | null>(null);
  const [form, setForm] = useState({ name: "", email: "", phone: "", answers: {} as Record<string, string> });

  const book = useMutation({
    mutationFn: () =>
      api<{ start_at: string }>(base, {
        method: "POST",
        body: {
          name: form.name,
          email: form.email,
          phone: form.phone,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          start: selected,
          answers: form.answers,
        },
      }),
    onSuccess: (r) => setDone({ start: r.start_at }),
  });

  const slotsByDate = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const s of slotData?.slots || []) {
      const d = new Date(s);
      const key = d.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(s);
    }
    return Array.from(map.entries());
  }, [slotData]);

  if (isLoading) return <Centered>Loading…</Centered>;
  if (isError || !ev) return <Centered>This booking link isn&apos;t available.</Centered>;

  const tzName = Intl.DateTimeFormat().resolvedOptions().timeZone;

  if (done) {
    return (
      <Centered>
        <div className="text-center">
          <div className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-full bg-emerald-100">
            <Check className="h-6 w-6 text-emerald-600" />
          </div>
          <h1 className="text-xl font-semibold text-slate-800">You&apos;re booked!</h1>
          <p className="mt-1 text-slate-600">
            {ev.name} with {ev.owner_name || "us"}
          </p>
          <p className="mt-1 font-medium text-slate-800">
            {new Date(done.start).toLocaleString(undefined, {
              weekday: "long",
              month: "long",
              day: "numeric",
              hour: "numeric",
              minute: "2-digit",
            })}
          </p>
          <p className="mt-2 text-sm text-slate-500">A confirmation has been emailed to {form.email}.</p>
        </div>
      </Centered>
    );
  }

  return (
    <div className="min-h-screen bg-slate-100 py-10">
      <div className="mx-auto grid max-w-4xl overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm md:grid-cols-[300px_1fr]">
        {/* Event info */}
        <div className="border-b border-slate-100 p-6 md:border-b-0 md:border-r" style={{ borderTopColor: ev.color }}>
          <div className="mb-1 h-1 w-12 rounded-full" style={{ background: ev.color }} />
          {ev.owner_name && <p className="mt-3 text-sm text-slate-500">{ev.owner_name}</p>}
          <h1 className="mt-1 text-xl font-semibold text-slate-800">{ev.name}</h1>
          {ev.description && <p className="mt-2 text-sm text-slate-600">{ev.description}</p>}
          <div className="mt-4 space-y-2 text-sm text-slate-600">
            <div className="flex items-center gap-2">
              <Clock className="h-4 w-4 text-slate-400" /> {ev.duration_minutes} minutes
            </div>
            <div className="flex items-center gap-2">
              <MapPin className="h-4 w-4 text-slate-400" />
              {ev.location_details || LOCATION_LABEL[ev.location_type] || ev.location_type}
            </div>
            {selected && (
              <div className="flex items-center gap-2 font-medium text-slate-800">
                <Calendar className="h-4 w-4 text-slate-400" />
                {new Date(selected).toLocaleString(undefined, {
                  weekday: "short",
                  month: "short",
                  day: "numeric",
                  hour: "numeric",
                  minute: "2-digit",
                })}
              </div>
            )}
          </div>
        </div>

        {/* Slot picker OR form */}
        <div className="p-6">
          {!selected ? (
            <>
              <h2 className="mb-3 font-semibold text-slate-800">Select a time</h2>
              <p className="mb-4 text-xs text-slate-400">Times shown in {tzName}</p>
              {slotsByDate.length === 0 && <p className="text-sm text-slate-500">No times available right now.</p>}
              <div className="max-h-[60vh] space-y-5 overflow-auto pr-1">
                {slotsByDate.map(([date, slots]) => (
                  <div key={date}>
                    <h3 className="mb-2 text-sm font-medium text-slate-700">{date}</h3>
                    <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                      {slots.map((s) => (
                        <button
                          key={s}
                          onClick={() => setSelected(s)}
                          className="rounded-md border border-slate-200 px-2 py-1.5 text-sm font-medium text-brand-700 hover:border-brand-400 hover:bg-brand-50"
                        >
                          {new Date(s).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <>
              <button
                onClick={() => setSelected(null)}
                className="mb-3 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700"
              >
                <ArrowLeft className="h-4 w-4" /> Back
              </button>
              <h2 className="mb-3 font-semibold text-slate-800">Enter your details</h2>
              <div className="space-y-3">
                <input
                  placeholder="Your name *"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  className="w-full rounded-md border border-slate-200 px-3 py-2 text-sm"
                />
                <input
                  placeholder="Email *"
                  type="email"
                  value={form.email}
                  onChange={(e) => setForm({ ...form, email: e.target.value })}
                  className="w-full rounded-md border border-slate-200 px-3 py-2 text-sm"
                />
                <input
                  placeholder="Phone (optional)"
                  value={form.phone}
                  onChange={(e) => setForm({ ...form, phone: e.target.value })}
                  className="w-full rounded-md border border-slate-200 px-3 py-2 text-sm"
                />
                {ev.questions.map((q) => (
                  <input
                    key={q.key}
                    placeholder={q.label + (q.required ? " *" : "")}
                    value={form.answers[q.key] || ""}
                    onChange={(e) => setForm({ ...form, answers: { ...form.answers, [q.key]: e.target.value } })}
                    className="w-full rounded-md border border-slate-200 px-3 py-2 text-sm"
                  />
                ))}
                {book.isError && (
                  <p className="text-sm text-rose-600">
                    {(book.error as Error).message || "Couldn't book — that time may have just been taken."}
                  </p>
                )}
                <button
                  onClick={() => book.mutate()}
                  disabled={book.isPending || !form.name.trim() || !form.email.includes("@")}
                  className="w-full rounded-md bg-brand-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-60"
                >
                  {book.isPending ? "Booking…" : "Confirm booking"}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid min-h-screen place-items-center bg-slate-100 p-6 text-slate-600">
      <div className="rounded-xl border border-slate-200 bg-white p-8 shadow-sm">{children}</div>
    </div>
  );
}
