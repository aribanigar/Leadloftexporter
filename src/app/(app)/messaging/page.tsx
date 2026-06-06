"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  Linkedin,
  MessageCircle,
  Send,
  Info,
  CheckCircle2,
  Loader2,
  Search,
  ExternalLink,
  ChevronRight,
  X,
  Sparkles,
  Users,
  Zap,
  AlertCircle,
} from "lucide-react";
import Link from "next/link";
import { api } from "@/lib/api";
import type { Lead, LeadList, PipelineStage } from "@/lib/types";
import { cn, initials } from "@/lib/utils";

interface WaSendResult {
  sent: number;
  failed: number;
  skipped_no_phone: number;
  total: number;
  errors: string[];
}

interface BulkMessageResult {
  queued: number;
  skipped_no_linkedin: number;
  skipped_pending: number;
  total: number;
}

interface MessageJobsStatus {
  pending: number;
  sent: number;
  failed: number;
  total: number;
}

interface Template {
  id: string;
  name: string;
  subject?: string | null;
  body: string;
  channel?: string;
}

type Channel = "linkedin" | "whatsapp";

const TOKENS = ["{first_name}", "{last_name}", "{full_name}", "{title}", "{company}"];

function renderPreview(template: string, lead: Lead): string {
  const first =
    (lead.first_name || lead.full_name?.split(" ")[0] || "there").trim() || "there";
  const map: Record<string, string> = {
    "{first_name}": first,
    "{last_name}": (lead.last_name || "").trim(),
    "{full_name}": (lead.full_name || first).trim(),
    "{title}": (lead.title || "").trim(),
    "{company}": (lead.company?.name || "").trim(),
  };
  let out = template;
  for (const [k, v] of Object.entries(map)) out = out.split(k).join(v);
  return out;
}

// Click-to-chat deep link. Strips everything but digits (wa.me needs a bare
// international number, no "+", spaces or dashes).
function waLink(phone: string | null | undefined, text: string): string {
  const num = (phone || "").replace(/\D/g, "");
  return `https://wa.me/${num}${text ? `?text=${encodeURIComponent(text)}` : ""}`;
}

export default function MessagingPage() {
  const [channel, setChannel] = useState<Channel>("linkedin");
  const [message, setMessage] = useState("");
  const [stageId, setStageId] = useState<string>("");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<BulkMessageResult | null>(null);
  const [waResult, setWaResult] = useState<WaSendResult | null>(null);
  const [showTemplates, setShowTemplates] = useState(false);
  const [sendingActive, setSendingActive] = useState(false);
  const [stopped, setStopped] = useState(false);
  // WhatsApp guided send-queue: a list of lead ids + a cursor.
  const [waQueue, setWaQueue] = useState<{ ids: string[]; index: number } | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const isWa = channel === "whatsapp";

  const { data: stages } = useQuery<PipelineStage[]>({
    queryKey: ["stages"],
    queryFn: () => api("/pipeline/stages"),
  });
  const { data: templates } = useQuery<Template[]>({
    queryKey: ["templates"],
    queryFn: () => api("/templates"),
  });
  const { data: leads } = useQuery<LeadList>({
    queryKey: ["messaging-leads", stageId],
    queryFn: () =>
      api(`/leads?page_size=500${stageId ? `&stage_id=${stageId}` : ""}`),
  });
  const { data: waConfig } = useQuery<{ connected: boolean; display?: string | null }>({
    queryKey: ["whatsapp-config"],
    queryFn: () => api("/whatsapp/config"),
  });

  // Live progress for in-flight LinkedIn message jobs. Polls every 4s while
  // sending is active; stops automatically once no jobs are pending.
  const { data: jobStatus } = useQuery<MessageJobsStatus>({
    queryKey: ["message-jobs-status"],
    queryFn: () => api("/leads/message-jobs/status"),
    enabled: sendingActive,
    refetchInterval: (query) => {
      const d = query.state.data as MessageJobsStatus | undefined;
      if (!d) return 4000;
      if (d.pending === 0) { setSendingActive(false); return false; }
      return 4000;
    },
  });

  const items = useMemo(() => leads?.items || [], [leads]);
  const reach = useCallback(
    (l: Lead) => (isWa ? !!l.phone : !!l.linkedin_url),
    [isWa]
  );

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (l) =>
        (l.full_name || "").toLowerCase().includes(q) ||
        (l.company?.name || "").toLowerCase().includes(q) ||
        (l.title || "").toLowerCase().includes(q)
    );
  }, [items, search]);

  const reachable = useMemo(() => items.filter(reach), [items, reach]);
  const selectedReachable = useMemo(
    () => reachable.filter((l) => selected.has(l.id)),
    [reachable, selected]
  );
  const leadById = useMemo(() => {
    const m = new Map<string, Lead>();
    items.forEach((l) => m.set(l.id, l));
    return m;
  }, [items]);

  // Recipients = explicitly-selected reachable leads if any, else everyone
  // reachable on this channel in the current stage filter.
  const usingSelection = selectedReachable.length > 0;
  const recipients = usingSelection ? selectedReachable : reachable;
  const recipientCount = recipients.length;
  const previewLead = recipients[0];

  // Switching channel changes who's reachable — reset transient state.
  useEffect(() => {
    setSelected(new Set());
    setResult(null);
    setWaResult(null);
    setWaQueue(null);
    setSendingActive(false);
  }, [channel]);

  function toggle(id: string) {
    setResult(null);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectAllShown() {
    setResult(null);
    const ids = shown.filter(reach).map((l) => l.id);
    const allSelected = ids.length > 0 && ids.every((id) => selected.has(id));
    setSelected((prev) => {
      const next = new Set(prev);
      if (allSelected) ids.forEach((id) => next.delete(id));
      else ids.forEach((id) => next.add(id));
      return next;
    });
  }

  function insertToken(token: string) {
    setResult(null);
    const ta = textareaRef.current;
    if (!ta) {
      setMessage((m) => m + token);
      return;
    }
    const start = ta.selectionStart ?? message.length;
    const end = ta.selectionEnd ?? message.length;
    const next = message.slice(0, start) + token + message.slice(end);
    setMessage(next);
    requestAnimationFrame(() => {
      ta.focus();
      const pos = start + token.length;
      ta.setSelectionRange(pos, pos);
    });
  }

  const send = useMutation<BulkMessageResult, Error, void>({
    mutationFn: () =>
      api("/leads/bulk-message", {
        method: "POST",
        body: {
          message: message.trim(),
          stage_id: usingSelection ? undefined : stageId || undefined,
          lead_ids: usingSelection ? selectedReachable.map((l) => l.id) : undefined,
        },
      }),
    onSuccess: (r) => {
      setResult(r);
      setSelected(new Set());
      setStopped(false);
      if (r.queued > 0) setSendingActive(true);
    },
  });

  const stopSending = useMutation<{ stopped: number }, Error, void>({
    mutationFn: () => api("/leads/bulk-message/stop", { method: "POST" }),
    onSuccess: () => {
      setSendingActive(false);
      setStopped(true);
    },
  });

  // WhatsApp Business API — true server-side automated send (when connected).
  const waSend = useMutation<WaSendResult, Error, void>({
    mutationFn: () =>
      api("/whatsapp/send", {
        method: "POST",
        body: {
          message: message.trim(),
          stage_id: usingSelection ? undefined : stageId || undefined,
          lead_ids: usingSelection ? selectedReachable.map((l) => l.id) : undefined,
        },
      }),
    onSuccess: (r) => {
      setWaResult(r);
      setSelected(new Set());
    },
  });

  // ----- WhatsApp click-to-chat -----
  function openWhatsApp(lead: Lead) {
    const text = message.trim() ? renderPreview(message, lead) : "";
    window.open(waLink(lead.phone, text), "_blank", "noopener");
  }
  function startWaQueue() {
    const ids = recipients.map((l) => l.id);
    if (!ids.length) return;
    setWaQueue({ ids, index: 0 });
  }

  const trimmed = message.trim();
  const canAct = trimmed.length > 0 && recipientCount > 0;
  const progressPct =
    jobStatus && jobStatus.total > 0
      ? Math.round((jobStatus.sent / jobStatus.total) * 100)
      : 0;

  // Channel icon component, flipped with the channel.
  const ChannelIcon = isWa ? MessageCircle : Linkedin;

  return (
    <div className="mx-auto max-w-6xl p-6 lg:p-8">
      {/* ─── Hero header ───────────────────────────────────────────────── */}
      <header className="mb-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <div className="mb-1 inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-2.5 py-0.5 text-[11px] font-medium uppercase tracking-wide text-slate-500">
              <Sparkles className="h-3 w-3" /> Outreach
            </div>
            <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
              Bulk Messaging
            </h1>
            <p className="mt-0.5 text-sm text-slate-500">
              Compose once. Reach your whole pipeline at a human pace, in real-time.
            </p>
          </div>

          {/* Live stat strip */}
          <div className="flex flex-wrap items-center gap-2">
            <StatPill
              icon={<Users className="h-3.5 w-3.5" />}
              label="Reachable"
              value={reachable.length}
            />
            <StatPill
              icon={<Send className="h-3.5 w-3.5" />}
              label="Sent (24h)"
              value={jobStatus?.sent ?? 0}
              tone="emerald"
            />
            <StatPill
              icon={<Zap className="h-3.5 w-3.5" />}
              label="In progress"
              value={jobStatus?.pending ?? 0}
              tone={
                (jobStatus?.pending ?? 0) > 0 ? "brand" : "slate"
              }
              pulse={(jobStatus?.pending ?? 0) > 0}
            />
          </div>
        </div>

        {/* Channel switcher — segmented control with active pill */}
        <div className="mt-5 inline-flex rounded-xl border border-slate-200 bg-white p-1 shadow-sm">
          <ChannelButton
            active={!isWa}
            onClick={() => setChannel("linkedin")}
            icon={<Linkedin className="h-4 w-4" />}
            label="LinkedIn"
            activeClass="bg-gradient-to-r from-brand-50 to-brand-100 text-brand-700"
          />
          <ChannelButton
            active={isWa}
            onClick={() => setChannel("whatsapp")}
            icon={<MessageCircle className="h-4 w-4" />}
            label="WhatsApp"
            activeClass="bg-gradient-to-r from-emerald-50 to-emerald-100 text-emerald-700"
          />
        </div>
      </header>

      <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
        {/* ─── Composer ─────────────────────────────────────────────── */}
        <section className="card overflow-hidden p-0">
          {/* Composer header */}
          <div className="flex items-center justify-between border-b border-slate-100 px-6 py-3">
            <div className="flex items-center gap-2 text-sm font-medium text-slate-700">
              <ChannelIcon
                className={cn(
                  "h-4 w-4",
                  isWa ? "text-emerald-600" : "text-brand-600"
                )}
              />
              Write your message
            </div>
            <div className="relative">
              <button
                type="button"
                onClick={() => setShowTemplates((s) => !s)}
                className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2 py-1 text-xs font-medium text-slate-600 shadow-soft transition hover:border-slate-300 hover:text-slate-800"
              >
                <Sparkles className="h-3 w-3" /> Use template
              </button>
              {showTemplates && (
                <>
                  <div
                    className="fixed inset-0 z-10"
                    onClick={() => setShowTemplates(false)}
                  />
                  <div className="absolute right-0 z-20 mt-1.5 max-h-72 w-72 overflow-y-auto rounded-lg border border-slate-200 bg-white p-1 shadow-xl">
                    {(templates || []).length === 0 && (
                      <div className="px-3 py-3 text-xs text-slate-400">
                        No templates yet. Create them in Settings → Templates.
                      </div>
                    )}
                    {(templates || []).map((t) => (
                      <button
                        key={t.id}
                        type="button"
                        className="block w-full truncate rounded-md px-3 py-2 text-left text-sm hover:bg-slate-50"
                        title={t.body}
                        onClick={() => {
                          setMessage(t.body || "");
                          setResult(null);
                          setShowTemplates(false);
                        }}
                      >
                        {t.name}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>

          {/* Composer body */}
          <div className="space-y-4 px-6 py-5">
            {/* Merge-tag chips */}
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs font-medium text-slate-500">Personalize:</span>
              {TOKENS.map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => insertToken(t)}
                  className="group inline-flex items-center gap-1 rounded-full border border-slate-200 bg-white px-2.5 py-0.5 text-xs text-slate-600 shadow-soft transition hover:border-brand-300 hover:bg-brand-50 hover:text-brand-700"
                  title={`Insert ${t}`}
                >
                  <span className="font-mono">{t}</span>
                </button>
              ))}
            </div>

            {/* Textarea */}
            <div
              className={cn(
                "rounded-xl border border-slate-200 bg-white shadow-soft transition focus-within:border-transparent focus-within:ring-2",
                isWa
                  ? "focus-within:ring-emerald-400/30"
                  : "focus-within:ring-brand-400/30"
              )}
            >
              <textarea
                ref={textareaRef}
                className="block min-h-[200px] w-full resize-y rounded-xl bg-transparent px-4 py-3 text-sm leading-relaxed text-slate-800 outline-none placeholder:text-slate-400"
                placeholder={
                  isWa
                    ? "Hi {first_name}, great connecting! …"
                    : "Hi {first_name}, I came across your profile and wanted to connect…"
                }
                value={message}
                onChange={(e) => {
                  setMessage(e.target.value);
                  setResult(null);
                }}
                maxLength={8000}
              />
              <div className="flex items-center justify-between border-t border-slate-100 px-4 py-2 text-xs text-slate-400">
                <span>Tags are filled in per person for each message.</span>
                <span>
                  <span className="font-medium text-slate-600">{trimmed.length}</span>
                  /8000
                </span>
              </div>
            </div>

            {/* Message-bubble preview */}
            {trimmed && previewLead && (
              <div>
                <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-slate-500">
                  <ChannelIcon className="h-3 w-3" />
                  Preview · what {previewLead.full_name || "the first recipient"} will see
                </div>
                <div className="flex items-start gap-2.5">
                  <span className="grid h-8 w-8 flex-shrink-0 place-items-center rounded-full bg-slate-100 text-[10px] font-semibold uppercase text-slate-500">
                    {initials(previewLead.full_name || previewLead.email)}
                  </span>
                  <div
                    className={cn(
                      "max-w-[80%] whitespace-pre-wrap rounded-2xl rounded-tl-sm border px-4 py-2.5 text-sm leading-relaxed shadow-soft",
                      isWa
                        ? "border-emerald-200 bg-gradient-to-br from-emerald-50 to-white text-slate-800"
                        : "border-brand-200 bg-gradient-to-br from-brand-50 to-white text-slate-800"
                    )}
                  >
                    {renderPreview(message, previewLead)}
                  </div>
                </div>
              </div>
            )}

            {/* How it works callout */}
            <div
              className={cn(
                "flex items-start gap-2.5 rounded-xl border bg-gradient-to-br p-3 text-xs",
                isWa
                  ? "border-emerald-100 from-emerald-50/60 to-white text-slate-600"
                  : "border-brand-100 from-brand-50/60 to-white text-slate-600"
              )}
            >
              <Info
                className={cn(
                  "mt-0.5 h-4 w-4 flex-shrink-0",
                  isWa ? "text-emerald-500" : "text-brand-500"
                )}
              />
              {isWa ? (
                <span>
                  {waConfig?.connected ? (
                    <>
                      <strong>Auto-send</strong> delivers instantly via your connected
                      WhatsApp Business API ({waConfig.display || "active"}). Or use{" "}
                      <strong>Open chats</strong> to send manually one-by-one. Numbers
                      must include the country code.
                    </>
                  ) : (
                    <>
                      <strong>Open chats</strong> opens each WhatsApp chat with your
                      message pre-filled — tap Send in WhatsApp for each. Numbers
                      must include the country code. For true automated bulk send,{" "}
                      <Link
                        href="/settings/whatsapp"
                        className="font-medium text-emerald-700 underline underline-offset-2 hover:text-emerald-800"
                      >
                        connect the WhatsApp Business API
                      </Link>
                      .
                    </>
                  )}
                </span>
              ) : (
                <span>
                  Messages send <strong>in real-time</strong>, one at a time at a
                  human pace (45 sec – 3 min between sends) by the LeadCaptura
                  extension running in your browser. Keep a LinkedIn tab open with{" "}
                  <strong>Autopilot ON</strong> in the extension popup. Only
                  1st-degree connections can be messaged.
                </span>
              )}
            </div>

            {/* Action bar */}
            <div className="flex items-center justify-between gap-3 border-t border-slate-100 pt-4">
              {!isWa && send.isError ? (
                <span className="flex items-center gap-1.5 text-xs text-red-600">
                  <AlertCircle className="h-3.5 w-3.5" />
                  {send.error?.message || "Failed to queue messages."}
                </span>
              ) : (
                <span className="text-xs text-slate-500">
                  Ready to reach{" "}
                  <span className="font-semibold text-slate-700">
                    {recipientCount}
                  </span>{" "}
                  {recipientCount === 1 ? "person" : "people"}
                </span>
              )}
              {isWa ? (
                <div className="flex items-center gap-2">
                  <button
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-medium shadow-soft transition disabled:cursor-not-allowed disabled:opacity-50",
                      waConfig?.connected
                        ? "border border-slate-200 bg-white text-slate-700 hover:border-slate-300"
                        : "bg-gradient-to-r from-emerald-500 to-emerald-600 text-white hover:from-emerald-600 hover:to-emerald-700"
                    )}
                    disabled={!canAct}
                    onClick={startWaQueue}
                    title="Open each chat in WhatsApp to send manually"
                  >
                    <MessageCircle className="h-4 w-4" />
                    {waConfig?.connected
                      ? "Open chats"
                      : `Open ${recipientCount} chat${recipientCount === 1 ? "" : "s"}`}
                  </button>
                  {waConfig?.connected && (
                    <button
                      className="inline-flex items-center gap-1.5 rounded-lg bg-gradient-to-r from-emerald-500 to-emerald-600 px-4 py-2 text-sm font-medium text-white shadow-soft transition hover:from-emerald-600 hover:to-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
                      disabled={!canAct || waSend.isPending}
                      onClick={() => waSend.mutate()}
                      title="Send automatically via the WhatsApp Business API"
                    >
                      {waSend.isPending ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Send className="h-4 w-4" />
                      )}
                      {waSend.isPending ? "Sending…" : `Auto-send · ${recipientCount}`}
                    </button>
                  )}
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  {sendingActive && (
                    <button
                      className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm font-medium text-red-700 shadow-soft transition hover:bg-red-100 disabled:opacity-50"
                      disabled={stopSending.isPending}
                      onClick={() => stopSending.mutate()}
                    >
                      {stopSending.isPending ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <X className="h-4 w-4" />
                      )}
                      Stop
                    </button>
                  )}
                  <button
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-lg bg-gradient-to-r from-brand-500 to-brand-700 px-5 py-2 text-sm font-medium text-white shadow-md transition hover:from-brand-600 hover:to-brand-800 disabled:cursor-not-allowed disabled:opacity-50",
                      !send.isPending && canAct && !sendingActive && "hover:shadow-lg"
                    )}
                    disabled={!canAct || send.isPending || sendingActive}
                    onClick={() => send.mutate()}
                  >
                    {send.isPending ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Send className="h-4 w-4" />
                    )}
                    {send.isPending
                      ? "Queuing…"
                      : sendingActive
                      ? "Sending…"
                      : `Send to ${recipientCount} ${
                          usingSelection
                            ? "selected"
                            : "lead" + (recipientCount === 1 ? "" : "s")
                        }`}
                  </button>
                </div>
              )}
            </div>

            {/* Live progress / result */}
            {result && result.queued > 0 && (
              <div className="overflow-hidden rounded-xl border border-emerald-200 bg-gradient-to-br from-emerald-50 to-white shadow-soft">
                <div className="flex items-start gap-2.5 px-4 py-3">
                  {sendingActive ? (
                    <span className="relative mt-0.5 flex h-2.5 w-2.5 flex-shrink-0">
                      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                      <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-emerald-500" />
                    </span>
                  ) : stopped ? (
                    <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-500" />
                  ) : (
                    <CheckCircle2 className="mt-0.5 h-4 w-4 flex-shrink-0 text-emerald-600" />
                  )}
                  <div className="flex-1">
                    <div className={cn("text-sm font-medium", stopped ? "text-amber-900" : "text-emerald-900")}>
                      {sendingActive
                        ? `Sending ${result.queued} message${result.queued === 1 ? "" : "s"} in real-time…`
                        : stopped
                        ? `Stopped — ${jobStatus?.sent ?? 0} sent before stopping`
                        : `${jobStatus?.sent ?? result.queued} message${result.queued === 1 ? "" : "s"} sent`}
                    </div>
                    <div className={cn("mt-0.5 text-xs", stopped ? "text-amber-700" : "text-emerald-700")}>
                      {result.skipped_no_linkedin > 0 && (
                        <span>{result.skipped_no_linkedin} skipped (no LinkedIn URL). </span>
                      )}
                      {sendingActive
                        ? "Extension navigates each profile and sends at a human pace."
                        : stopped
                        ? "Remaining queued messages have been cancelled."
                        : "Delivered by the extension at a human pace."}
                    </div>
                  </div>
                  {sendingActive && (
                    <span className="text-sm font-semibold tabular-nums text-emerald-700">
                      {progressPct}%
                    </span>
                  )}
                </div>

                {sendingActive && jobStatus && jobStatus.total > 0 && (
                  <>
                    <div className="h-1.5 w-full overflow-hidden bg-emerald-100">
                      <div
                        className="h-full bg-gradient-to-r from-emerald-500 to-emerald-600 transition-all duration-700 ease-out"
                        style={{ width: `${progressPct}%` }}
                      />
                    </div>
                    <div className="flex items-center justify-between gap-3 border-t border-emerald-100 bg-emerald-50/40 px-4 py-2 text-xs">
                      <span className="inline-flex items-center gap-1.5 text-emerald-800">
                        <CheckCircle2 className="h-3 w-3" />
                        <span className="font-semibold tabular-nums">{jobStatus.sent}</span> sent
                      </span>
                      <span className="inline-flex items-center gap-1.5 text-emerald-700">
                        <Loader2 className="h-3 w-3 animate-spin" />
                        <span className="font-semibold tabular-nums">{jobStatus.pending}</span> in progress
                      </span>
                      {jobStatus.failed > 0 && (
                        <span className="inline-flex items-center gap-1.5 text-amber-700">
                          <AlertCircle className="h-3 w-3" />
                          <span className="font-semibold tabular-nums">{jobStatus.failed}</span> failed
                        </span>
                      )}
                    </div>
                  </>
                )}
              </div>
            )}
            {result && result.queued === 0 && (
              <div className="flex items-start gap-2.5 rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm text-slate-600">
                <Info className="mt-0.5 h-4 w-4 flex-shrink-0 text-slate-400" />
                <div>
                  No new messages sent — all recipients were already messaged or
                  have no LinkedIn URL.
                </div>
              </div>
            )}

            {isWa && waSend.isError && (
              <div className="flex items-center gap-1.5 text-sm text-red-600">
                <AlertCircle className="h-4 w-4" />
                {waSend.error?.message || "WhatsApp send failed."}
              </div>
            )}

            {waResult && (
              <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">
                <div className="flex items-start gap-2.5">
                  <CheckCircle2 className="mt-0.5 h-4 w-4 flex-shrink-0 text-emerald-600" />
                  <div>
                    <div className="font-medium">
                      {waResult.sent} sent
                      {waResult.failed ? `, ${waResult.failed} failed` : ""}
                      {waResult.skipped_no_phone
                        ? `, ${waResult.skipped_no_phone} skipped (no phone)`
                        : ""}
                      .
                    </div>
                    {waResult.errors.length > 0 && (
                      <ul className="mt-1 list-disc pl-4 text-xs text-amber-700">
                        {waResult.errors.map((e, i) => (
                          <li key={i} className="break-all">
                            {e}
                          </li>
                        ))}
                        <li>
                          Failures are usually Meta&apos;s 24-hour / template rule —
                          outside the window you must use an approved template.
                        </li>
                      </ul>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
        </section>

        {/* ─── Recipients sidebar ──────────────────────────────────── */}
        <aside className="card flex flex-col overflow-hidden p-0">
          <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
            <div>
              <div className="text-sm font-semibold text-slate-800">Recipients</div>
              <div className="mt-0.5 text-[11px] text-slate-500">
                {usingSelection ? (
                  <>
                    <span className="font-semibold text-slate-700">
                      {selectedReachable.length}
                    </span>{" "}
                    selected
                  </>
                ) : (
                  <>
                    <span className="font-semibold text-slate-700">
                      {reachable.length}
                    </span>{" "}
                    reachable
                  </>
                )}
              </div>
            </div>
            <button
              type="button"
              onClick={selectAllShown}
              className={cn(
                "rounded-md px-2 py-1 text-xs font-medium transition",
                isWa
                  ? "text-emerald-600 hover:bg-emerald-50"
                  : "text-brand-600 hover:bg-brand-50"
              )}
            >
              {shown.filter(reach).length > 0 &&
              shown.filter(reach).every((l) => selected.has(l.id))
                ? "Clear"
                : "Select all"}
            </button>
          </div>

          <div className="space-y-2 px-4 py-3">
            <select
              className="input"
              value={stageId}
              onChange={(e) => {
                setStageId(e.target.value);
                setResult(null);
              }}
            >
              <option value="">All stages</option>
              {(stages || []).map((s) => (
                <option key={s.id} value={s.id}>
                  Stage: {s.name}
                </option>
              ))}
            </select>
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-slate-400" />
              <input
                className="input pl-8"
                placeholder="Search name, company, title…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
          </div>

          <div className="flex-1 overflow-y-auto px-2 pb-3">
            {shown.length === 0 && (
              <div className="py-10 text-center">
                <Users className="mx-auto mb-2 h-6 w-6 text-slate-300" />
                <div className="text-sm text-slate-400">No leads to show.</div>
              </div>
            )}
            {shown.map((l) => {
              const ok = reach(l);
              const on = selected.has(l.id);
              return (
                <div
                  key={l.id}
                  onClick={() => ok && toggle(l.id)}
                  className={cn(
                    "group mb-0.5 flex items-center gap-2.5 rounded-lg px-2 py-2 text-left transition",
                    !ok
                      ? "cursor-not-allowed opacity-50"
                      : on
                      ? cn(
                          "cursor-pointer",
                          isWa
                            ? "bg-emerald-50 ring-1 ring-emerald-200"
                            : "bg-brand-50 ring-1 ring-brand-200"
                        )
                      : "cursor-pointer hover:bg-slate-50"
                  )}
                  title={
                    ok
                      ? ""
                      : isWa
                      ? "No phone number — can't WhatsApp"
                      : "No LinkedIn URL — can't message"
                  }
                >
                  <span
                    className={cn(
                      "grid h-4 w-4 flex-shrink-0 place-items-center rounded border text-[10px] transition",
                      on
                        ? isWa
                          ? "border-emerald-600 bg-emerald-600 text-white"
                          : "border-brand-600 bg-brand-600 text-white"
                        : "border-slate-300 bg-white group-hover:border-slate-400"
                    )}
                  >
                    {on ? "✓" : ""}
                  </span>
                  <span
                    className={cn(
                      "grid h-8 w-8 flex-shrink-0 place-items-center rounded-full text-[11px] font-semibold uppercase",
                      on
                        ? isWa
                          ? "bg-emerald-100 text-emerald-700"
                          : "bg-brand-100 text-brand-700"
                        : "bg-slate-100 text-slate-500"
                    )}
                  >
                    {initials(l.full_name || l.email)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-slate-800">
                      {l.full_name || "Unknown"}
                    </span>
                    <span className="block truncate text-xs text-slate-500">
                      {isWa
                        ? l.phone || "no phone"
                        : l.company?.name || l.title || "—"}
                    </span>
                  </span>
                  {isWa ? (
                    ok ? (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          openWhatsApp(l);
                        }}
                        className="flex-shrink-0 rounded-md p-1.5 text-emerald-600 transition hover:bg-emerald-100"
                        title="Open this chat in WhatsApp now"
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                      </button>
                    ) : (
                      <span className="flex-shrink-0 rounded-full bg-slate-100 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-slate-400">
                        no #
                      </span>
                    )
                  ) : ok ? (
                    <Linkedin className="h-4 w-4 flex-shrink-0 text-brand-500" />
                  ) : (
                    <span className="flex-shrink-0 rounded-full bg-slate-100 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-slate-400">
                      no LI
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </aside>
      </div>

      {/* WhatsApp guided send-queue */}
      {waQueue && (
        <WaQueueModal
          queue={waQueue}
          leadById={leadById}
          message={message}
          onOpen={openWhatsApp}
          onAdvance={(nextIndex) =>
            setWaQueue((q) => (q ? { ...q, index: nextIndex } : null))
          }
          onClose={() => setWaQueue(null)}
        />
      )}
    </div>
  );
}

// ─── Small presentational helpers ──────────────────────────────────────────

function StatPill({
  icon,
  label,
  value,
  tone = "slate",
  pulse = false,
}: {
  icon: ReactNode;
  label: string;
  value: number;
  tone?: "slate" | "brand" | "emerald";
  pulse?: boolean;
}) {
  const toneClass =
    tone === "brand"
      ? "border-brand-200 bg-brand-50 text-brand-700"
      : tone === "emerald"
      ? "border-emerald-200 bg-emerald-50 text-emerald-700"
      : "border-slate-200 bg-white text-slate-600";
  return (
    <div
      className={cn(
        "inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium shadow-soft",
        toneClass
      )}
    >
      <span className={cn("flex h-4 w-4 items-center justify-center", pulse && "animate-pulse")}>
        {icon}
      </span>
      <span className="text-slate-500">{label}</span>
      <span className="tabular-nums font-semibold">{value}</span>
    </div>
  );
}

function ChannelButton({
  active,
  onClick,
  icon,
  label,
  activeClass,
}: {
  active: boolean;
  onClick: () => void;
  icon: ReactNode;
  label: string;
  activeClass: string;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-lg px-4 py-1.5 text-sm font-medium transition",
        active
          ? `${activeClass} shadow-sm`
          : "text-slate-500 hover:text-slate-800"
      )}
    >
      {icon}
      {label}
    </button>
  );
}

function WaQueueModal({
  queue,
  leadById,
  message,
  onOpen,
  onAdvance,
  onClose,
}: {
  queue: { ids: string[]; index: number };
  leadById: Map<string, Lead>;
  message: string;
  onOpen: (lead: Lead) => void;
  onAdvance: (nextIndex: number) => void;
  onClose: () => void;
}) {
  const { ids, index } = queue;
  const done = index >= ids.length;
  const lead = done ? null : leadById.get(ids[index]);
  const trimmed = message.trim();

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-slate-900/40 p-4">
      <div className="w-full max-w-md rounded-xl bg-white p-5 shadow-2xl">
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <MessageCircle className="h-5 w-5 text-emerald-600" />
            <h2 className="text-sm font-semibold">Send via WhatsApp</h2>
          </div>
          <button className="rounded p-1 text-slate-400 hover:bg-slate-100" onClick={onClose}>
            <X className="h-4 w-4" />
          </button>
        </div>

        {done ? (
          <div className="py-6 text-center">
            <CheckCircle2 className="mx-auto mb-2 h-8 w-8 text-emerald-600" />
            <p className="text-sm font-medium text-slate-700">All {ids.length} chats opened.</p>
            <button className="btn-primary mt-4" onClick={onClose}>
              Done
            </button>
          </div>
        ) : lead ? (
          <>
            <div className="mb-1 text-xs text-slate-400">
              Recipient {index + 1} of {ids.length}
            </div>
            <div className="mb-3 flex items-center gap-2.5">
              <span className="grid h-9 w-9 place-items-center rounded-full bg-slate-100 text-xs font-semibold uppercase text-slate-500">
                {initials(lead.full_name || lead.email)}
              </span>
              <div className="min-w-0">
                <div className="truncate text-sm font-medium">{lead.full_name || "Unknown"}</div>
                <div className="truncate text-xs text-slate-400">{lead.phone}</div>
              </div>
            </div>
            <div className="mb-4 max-h-32 overflow-y-auto whitespace-pre-wrap rounded-md border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
              {trimmed ? renderPreview(message, lead) : "(no message — chat opens empty)"}
            </div>
            <div className="flex items-center gap-2">
              <button
                className="btn bg-emerald-600 text-white hover:bg-emerald-700"
                onClick={() => {
                  onOpen(lead);
                  onAdvance(index + 1);
                }}
              >
                <ExternalLink className="h-4 w-4" /> Open &amp; next
              </button>
              <button className="btn-secondary" onClick={() => onAdvance(index + 1)}>
                Skip <ChevronRight className="h-4 w-4" />
              </button>
              <span className="ml-auto text-xs text-slate-400">{ids.length - index - 1} left</span>
            </div>
          </>
        ) : (
          // Lead scrolled out of the loaded set — just advance.
          <button className="btn-secondary" onClick={() => onAdvance(index + 1)}>
            Skip missing lead
          </button>
        )}
      </div>
    </div>
  );
}
