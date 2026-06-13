"use client";

import { use, useMemo, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Calendar, Check, X, ArrowLeft } from "lucide-react";
import { api } from "@/lib/api";

interface ManageInfo {
  id: string;
  status: string;
  start_at: string;
  end_at: string;
  invitee_name: string;
  event_name: string;
  duration_minutes: number | null;
  workspace_slug: string | null;
  event_slug: string | null;
}

export default function ManageBookingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [mode, setMode] = useState<"view" | "reschedule">("view");
  const [result, setResult] = useState<"cancelled" | "rescheduled" | null>(null);

  const { data: info, isLoading, isError, refetch } = useQuery<ManageInfo>({
    queryKey: ["manage", id],
    queryFn: () => api(`/book/manage/${id}`),
    retry: false,
  });

  const cancel = useMutation({
    mutationFn: () => api(`/book/manage/${id}/cancel`, { method: "POST" }),
    onSuccess: () => {
      setResult("cancelled");
      refetch();
    },
  });

  if (isLoading) return <Centered>Loading…</Centered>;
  if (isError || !info) return <Centered>This booking link isn&apos;t available.</Centered>;

  if (result === "cancelled" || info.status === "cancelled") {
    return (
      <Centered>
        <div className="text-center">
          <div className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-full bg-slate-100">
            <X className="h-6 w-6 text-slate-500" />
          </div>
          <h1 className="text-xl font-semibold text-slate-800">Booking cancelled</h1>
          <p className="mt-1 text-slate-600">{info.event_name}</p>
        </div>
      </Centered>
    );
  }

  if (mode === "reschedule" && info.workspace_slug && info.event_slug) {
    return (
      <Reschedule
        id={id}
        workspace={info.workspace_slug}
        event={info.event_slug}
        onBack={() => setMode("view")}
        onDone={() => {
          setResult("rescheduled");
          setMode("view");
          refetch();
        }}
      />
    );
  }

  return (
    <Centered>
      <div className="w-[22rem] max-w-full">
        <h1 className="text-lg font-semibold text-slate-800">Manage your booking</h1>
        <p className="mt-1 text-sm text-slate-500">{info.event_name}</p>
        <div className="mt-4 flex items-center gap-2 rounded-md bg-slate-50 px-3 py-2 text-sm font-medium text-slate-800">
          <Calendar className="h-4 w-4 text-slate-400" />
          {new Date(info.start_at).toLocaleString(undefined, {
            weekday: "long",
            month: "long",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
          })}
        </div>
        {result === "rescheduled" && (
          <p className="mt-3 flex items-center gap-1 text-sm text-emerald-600">
            <Check className="h-4 w-4" /> Rescheduled.
          </p>
        )}
        <div className="mt-5 flex gap-2">
          <button
            onClick={() => setMode("reschedule")}
            className="flex-1 rounded-md bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700"
          >
            Reschedule
          </button>
          <button
            onClick={() => confirm("Cancel this booking?") && cancel.mutate()}
            disabled={cancel.isPending}
            className="flex-1 rounded-md border border-rose-200 px-3 py-2 text-sm font-medium text-rose-600 hover:bg-rose-50 disabled:opacity-60"
          >
            {cancel.isPending ? "Cancelling…" : "Cancel"}
          </button>
        </div>
      </div>
    </Centered>
  );
}

function Reschedule({
  id,
  workspace,
  event,
  onBack,
  onDone,
}: {
  id: string;
  workspace: string;
  event: string;
  onBack: () => void;
  onDone: () => void;
}) {
  const { data } = useQuery<{ slots: string[] }>({
    queryKey: ["reschedule-slots", workspace, event],
    queryFn: () => api(`/book/${workspace}/${event}/slots?days=21`),
  });
  const book = useMutation({
    mutationFn: (start: string) => api(`/book/manage/${id}/reschedule`, { method: "POST", body: { start } }),
    onSuccess: () => onDone(),
  });

  const byDate = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const s of data?.slots || []) {
      const key = new Date(s).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(s);
    }
    return Array.from(map.entries());
  }, [data]);

  return (
    <Centered>
      <div className="w-[26rem] max-w-full">
        <button onClick={onBack} className="mb-2 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700">
          <ArrowLeft className="h-4 w-4" /> Back
        </button>
        <h1 className="mb-1 text-lg font-semibold text-slate-800">Pick a new time</h1>
        {book.isError && (
          <p className="mb-2 text-sm text-rose-600">That time was just taken — pick another.</p>
        )}
        <div className="max-h-[60vh] space-y-4 overflow-auto pr-1">
          {byDate.length === 0 && <p className="text-sm text-slate-500">No times available.</p>}
          {byDate.map(([date, slots]) => (
            <div key={date}>
              <h3 className="mb-2 text-sm font-medium text-slate-700">{date}</h3>
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                {slots.map((s) => (
                  <button
                    key={s}
                    onClick={() => book.mutate(s)}
                    disabled={book.isPending}
                    className="rounded-md border border-slate-200 px-2 py-1.5 text-sm font-medium text-brand-700 hover:border-brand-400 hover:bg-brand-50 disabled:opacity-50"
                  >
                    {new Date(s).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </Centered>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid min-h-screen place-items-center bg-slate-100 p-6 text-slate-600">
      <div className="rounded-xl border border-slate-200 bg-white p-8 shadow-sm">{children}</div>
    </div>
  );
}
