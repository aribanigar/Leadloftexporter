"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
      if (r.queued > 0) setSendingActive(true);
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

  const channelLabel = isWa ? "WhatsApp" : "LinkedIn";

  return (
    <div className="mx-auto max-w-5xl p-6">
      <div className="mb-1 flex items-center gap-2">
        {isWa ? (
          <MessageCircle className="h-5 w-5 text-emerald-600" />
        ) : (
          <Linkedin className="h-5 w-5 text-brand-600" />
        )}
        <h1 className="text-lg font-semibold">Bulk Messaging</h1>
      </div>
      <p className="mb-4 text-sm text-slate-500">
        Write one message and reach your whole pipeline — or just the people you pick.
      </p>

      {/* Channel switcher */}
      <div className="mb-5 inline-flex rounded-lg border border-slate-200 bg-white p-0.5">
        <button
          onClick={() => setChannel("linkedin")}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium",
            !isWa ? "bg-brand-50 text-brand-700" : "text-slate-500 hover:text-slate-800"
          )}
        >
          <Linkedin className="h-4 w-4" /> LinkedIn
        </button>
        <button
          onClick={() => setChannel("whatsapp")}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium",
            isWa ? "bg-emerald-50 text-emerald-700" : "text-slate-500 hover:text-slate-800"
          )}
        >
          <MessageCircle className="h-4 w-4" /> WhatsApp
        </button>
      </div>

      <div className="grid gap-5 lg:grid-cols-[1fr_360px]">
        {/* ---- Composer ---- */}
        <div className="card p-5">
          <div className="mb-2 flex items-center justify-between">
            <label className="label mb-0">Message</label>
            <div className="relative">
              <button
                type="button"
                onClick={() => setShowTemplates((s) => !s)}
                className="inline-flex items-center gap-1 rounded-md border border-slate-200 px-2 py-1 text-xs font-medium text-slate-600 hover:border-brand-300 hover:text-brand-700"
              >
                Use template
              </button>
              {showTemplates && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setShowTemplates(false)} />
                  <div className="absolute right-0 z-20 mt-1 max-h-64 w-64 overflow-y-auto rounded-md border border-slate-200 bg-white p-1 shadow-lg">
                    {(templates || []).length === 0 && (
                      <div className="px-3 py-2 text-xs text-slate-400">
                        No templates yet. Create them in Settings → Templates.
                      </div>
                    )}
                    {(templates || []).map((t) => (
                      <button
                        key={t.id}
                        type="button"
                        className="block w-full truncate rounded px-3 py-2 text-left text-sm hover:bg-slate-50"
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

          {/* Merge-tag buttons */}
          <div className="mb-2 flex flex-wrap gap-1.5">
            {TOKENS.map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => insertToken(t)}
                className="rounded-md border border-slate-200 bg-slate-50 px-2 py-1 font-mono text-xs text-slate-600 hover:border-brand-300 hover:text-brand-700"
                title={`Insert ${t}`}
              >
                {t}
              </button>
            ))}
          </div>

          <textarea
            ref={textareaRef}
            className="input min-h-[180px] resize-y leading-relaxed"
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
          <div className="mt-1 flex items-center justify-between text-xs text-slate-400">
            <span>Tags are filled in per person for each message.</span>
            <span>{trimmed.length}/8000</span>
          </div>

          {/* Live preview */}
          {trimmed && previewLead && (
            <div className="mt-3">
              <div className="label">
                Preview for {previewLead.full_name || "first recipient"}
              </div>
              <div className="whitespace-pre-wrap rounded-md border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
                {renderPreview(message, previewLead)}
              </div>
            </div>
          )}

          {/* How it works */}
          <div className="mt-4 flex gap-2 rounded-md bg-slate-50 p-3 text-xs text-slate-600">
            <Info className="mt-0.5 h-4 w-4 flex-shrink-0 text-slate-400" />
            {isWa ? (
              <span>
                {waConfig?.connected ? (
                  <>
                    <strong>Auto-send</strong> delivers instantly via your connected WhatsApp
                    Business API ({waConfig.display || "active"}). Or use <strong>Open chats</strong>{" "}
                    to send manually one-by-one. Numbers must include the country code.
                  </>
                ) : (
                  <>
                    <strong>Open chats</strong> opens each WhatsApp chat with your message
                    pre-filled — tap Send in WhatsApp for each. Numbers must include the
                    country code. For true automated bulk send,{" "}
                    <Link href="/settings/whatsapp" className="font-medium text-emerald-700 underline">
                      connect the WhatsApp Business API
                    </Link>
                    .
                  </>
                )}
              </span>
            ) : (
              <span>
                Messages are sent in real-time, one at a time at a human pace (45 sec –
                3 min between sends) by the LeadCaptura extension running in your browser.
                Keep a LinkedIn tab open with <strong>Autopilot ON</strong> in the extension
                popup. Only 1st-degree connections can be messaged.
              </span>
            )}
          </div>

          {/* Action */}
          <div className="mt-5 flex items-center justify-end gap-3">
            {!isWa && send.isError && (
              <span className="mr-auto text-xs text-red-600">
                {send.error?.message || "Failed to queue messages."}
              </span>
            )}
            {isWa ? (
              <div className="flex items-center gap-2">
                {waConfig?.connected && (
                  <span className="mr-1 hidden text-xs text-slate-400 sm:inline">
                    open chats manually, or
                  </span>
                )}
                <button
                  className={cn(
                    waConfig?.connected
                      ? "btn-secondary"
                      : "btn bg-emerald-600 text-white hover:bg-emerald-700",
                    "disabled:cursor-not-allowed disabled:opacity-50"
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
                    className="btn bg-emerald-600 text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
                    disabled={!canAct || waSend.isPending}
                    onClick={() => waSend.mutate()}
                    title="Send automatically via the WhatsApp Business API"
                  >
                    {waSend.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                    {waSend.isPending
                      ? "Sending…"
                      : `Auto-send · ${recipientCount}`}
                  </button>
                )}
              </div>
            ) : (
              <button
                className="btn-primary disabled:cursor-not-allowed disabled:opacity-50"
                disabled={!canAct || send.isPending}
                onClick={() => send.mutate()}
              >
                {send.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                {send.isPending
                  ? "Sending…"
                  : `Send to ${recipientCount} ${usingSelection ? "selected" : "lead" + (recipientCount === 1 ? "" : "s")}`}
              </button>
            )}
          </div>

          {result && result.queued > 0 && (
            <div className="mt-4 rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm">
              {/* Header row */}
              <div className="flex items-start gap-2 text-emerald-800">
                {sendingActive
                  ? <Loader2 className="mt-0.5 h-4 w-4 flex-shrink-0 animate-spin text-emerald-600" />
                  : <CheckCircle2 className="mt-0.5 h-4 w-4 flex-shrink-0 text-emerald-600" />
                }
                <div className="flex-1">
                  <div className="font-medium">
                    {sendingActive
                      ? `Sending ${result.queued} message${result.queued === 1 ? "" : "s"} in real-time…`
                      : `${jobStatus?.sent ?? result.queued} message${result.queued === 1 ? "" : "s"} sent ✓`}
                  </div>
                  <div className="mt-0.5 text-xs text-emerald-700">
                    {result.skipped_no_linkedin > 0 && (
                      <span>{result.skipped_no_linkedin} skipped (no LinkedIn URL). </span>
                    )}
                    {result.skipped_pending > 0 && (
                      <span>{result.skipped_pending} already had a message in-flight. </span>
                    )}
                    {sendingActive
                      ? "Keep a LinkedIn tab open with Autopilot ON in the extension."
                      : "Delivered by the extension at a human pace."}
                  </div>
                </div>
              </div>
              {/* Live progress bar */}
              {sendingActive && jobStatus && jobStatus.total > 0 && (
                <div className="mt-3">
                  <div className="mb-1 flex justify-between text-xs text-emerald-700">
                    <span>{jobStatus.sent} sent · {jobStatus.pending} in progress</span>
                    <span>{Math.round((jobStatus.sent / jobStatus.total) * 100)}%</span>
                  </div>
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-emerald-200">
                    <div
                      className="h-full rounded-full bg-emerald-500 transition-all duration-500"
                      style={{ width: `${(jobStatus.sent / jobStatus.total) * 100}%` }}
                    />
                  </div>
                </div>
              )}
            </div>
          )}
          {result && result.queued === 0 && (
            <div className="mt-4 flex items-start gap-2 rounded-md border border-slate-200 bg-slate-50 p-3 text-sm text-slate-600">
              <Info className="mt-0.5 h-4 w-4 flex-shrink-0 text-slate-400" />
              <div>No new messages sent — all recipients were already messaged or have no LinkedIn URL.</div>
            </div>
          )}

          {isWa && waSend.isError && (
            <p className="mt-3 text-sm text-red-600">
              {waSend.error?.message || "WhatsApp send failed."}
            </p>
          )}

          {waResult && (
            <div className="mt-4 rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">
              <div className="flex items-start gap-2">
                <CheckCircle2 className="mt-0.5 h-4 w-4 flex-shrink-0 text-emerald-600" />
                <div>
                  <div className="font-medium">
                    {waResult.sent} sent{waResult.failed ? `, ${waResult.failed} failed` : ""}
                    {waResult.skipped_no_phone ? `, ${waResult.skipped_no_phone} skipped (no phone)` : ""}.
                  </div>
                  {waResult.errors.length > 0 && (
                    <ul className="mt-1 list-disc pl-4 text-xs text-amber-700">
                      {waResult.errors.map((e, i) => (
                        <li key={i} className="break-all">{e}</li>
                      ))}
                      <li>
                        Failures are usually Meta&apos;s 24-hour / template rule — outside the
                        window you must use an approved template.
                      </li>
                    </ul>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* ---- Recipients ---- */}
        <div className="card flex flex-col p-4">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-sm font-medium">Recipients</span>
            <button
              type="button"
              onClick={selectAllShown}
              className="text-xs font-medium text-brand-600 hover:text-brand-700"
            >
              {shown.filter(reach).length > 0 && shown.filter(reach).every((l) => selected.has(l.id))
                ? "Clear"
                : "Select all"}
            </button>
          </div>

          <select
            className="input mb-2"
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

          <div className="relative mb-2">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-slate-400" />
            <input
              className="input pl-8"
              placeholder="Search name, company, title…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>

          <p className="mb-2 text-xs text-slate-500">
            {usingSelection ? (
              <>
                <span className="font-semibold text-slate-700">{selectedReachable.length}</span> selected
              </>
            ) : (
              <>
                Will reach{" "}
                <span className="font-semibold text-slate-700">{reachable.length}</span>{" "}
                lead{reachable.length === 1 ? "" : "s"} with {isWa ? "a phone number" : "LinkedIn"}
              </>
            )}
          </p>

          <div className="-mx-1 max-h-[460px] flex-1 overflow-y-auto px-1">
            {shown.length === 0 && (
              <div className="py-6 text-center text-sm text-slate-400">No leads.</div>
            )}
            {shown.map((l) => {
              const ok = reach(l);
              const on = selected.has(l.id);
              return (
                <div
                  key={l.id}
                  onClick={() => ok && toggle(l.id)}
                  className={cn(
                    "mb-0.5 flex items-center gap-2.5 rounded-md px-2 py-1.5 text-left",
                    !ok ? "cursor-not-allowed opacity-50" : on ? "cursor-pointer bg-brand-50" : "cursor-pointer hover:bg-slate-50"
                  )}
                  title={ok ? "" : isWa ? "No phone number — can't WhatsApp" : "No LinkedIn URL — can't message"}
                >
                  <span
                    className={cn(
                      "grid h-4 w-4 flex-shrink-0 place-items-center rounded border text-[10px]",
                      on ? "border-brand-600 bg-brand-600 text-white" : "border-slate-300 bg-white"
                    )}
                  >
                    {on ? "✓" : ""}
                  </span>
                  <span className="grid h-7 w-7 flex-shrink-0 place-items-center rounded-full bg-slate-100 text-[10px] font-semibold uppercase text-slate-500">
                    {initials(l.full_name || l.email)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">{l.full_name || "Unknown"}</span>
                    <span className="block truncate text-xs text-slate-400">
                      {isWa ? l.phone || "no phone" : l.company?.name || l.title || "—"}
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
                        className="flex-shrink-0 rounded p-1 text-emerald-600 hover:bg-emerald-50"
                        title="Open this chat in WhatsApp now"
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                      </button>
                    ) : (
                      <span className="flex-shrink-0 text-[10px] text-slate-400">no #</span>
                    )
                  ) : ok ? (
                    <Linkedin className="h-3.5 w-3.5 flex-shrink-0 text-brand-500" />
                  ) : (
                    <span className="flex-shrink-0 text-[10px] text-slate-400">no LI</span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
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
