"use client";

/**
 * Outreach workspace — per-lead conversation view across Email + WhatsApp.
 *
 * Different from the /messaging page which is bulk-blast — this one is
 * one-to-one and conversation-shaped. You pick a lead from the left rail,
 * see every previous email/WhatsApp message in the right pane (newest at
 * bottom, chat-style), and compose + send live with optimistic UI +
 * background poll until the backend confirms the send.
 *
 * Real-time behaviour:
 *  - The conversation polls /leads/{id}/timeline every 3 s while a send is
 *    in flight. The just-sent message appears immediately as a pending
 *    bubble; the poll flips it to "sent" once the backend records the
 *    EmailMessage row / whatsapp_sent activity.
 *  - The lead list polls every 30 s for newly-added leads but is otherwise
 *    static — the right pane is where the activity lives.
 *
 * Wire deps (all already shipped):
 *  - GET  /leads?page_size=500     → lead list
 *  - GET  /leads/{id}/timeline     → conversation history (EmailMessage +
 *                                    whatsapp_sent Activity, plus notes/calls
 *                                    we filter out client-side)
 *  - POST /inbox/send              → send email through connected sender
 *  - POST /whatsapp/send           → send WhatsApp via Meta Cloud API
 *  - GET  /whatsapp/config         → check if WhatsApp is connected
 *  - GET  /integrations/accounts   → check if an email sender is connected
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Mail,
  MessageCircle,
  Send,
  Search,
  Plug,
  CheckCheck,
  Loader2,
  AlertCircle,
  Inbox,
  Phone,
  ExternalLink,
  Sparkles,
} from "lucide-react";
import Link from "next/link";
import { api } from "@/lib/api";
import type { Lead, LeadList } from "@/lib/types";
import { cn, initials, fmtDate } from "@/lib/utils";

type Channel = "email" | "whatsapp";

interface TimelineItem {
  kind: "activity" | "email" | "note" | "call";
  id: string;
  type?: string; // for kind=activity
  payload?: { to?: string; body_preview?: string; preview?: string } | null;
  direction?: "inbound" | "outbound";
  from?: string;
  to?: string;
  subject?: string | null;
  preview?: string;
  status?: string;
  at?: string | null;
}

interface ConvMessage {
  id: string;
  channel: Channel;
  direction: "outbound" | "inbound";
  subject?: string | null;
  body: string;
  status: "queued" | "sent" | "delivered" | "failed" | string;
  at: string | null;
  pending?: boolean;
}

interface ConnectedAccount {
  id: string;
  provider: string;
  label: string | null;
  status: string;
}

export default function OutreachPage() {
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"all" | "email" | "whatsapp">("all");
  const [activeLeadId, setActiveLeadId] = useState<string | null>(null);
  const [channel, setChannel] = useState<Channel>("email");
  // Pending sends keyed by client-generated id so they render instantly
  // and flip to "confirmed" when the backend timeline catches up.
  const [pending, setPending] = useState<ConvMessage[]>([]);

  // ───── Data ─────────────────────────────────────────────────────────────
  const { data: leadsData } = useQuery<LeadList>({
    queryKey: ["outreach-leads"],
    queryFn: () => api("/leads?page_size=500"),
    refetchInterval: 30_000,
  });
  const leads = useMemo(() => leadsData?.items || [], [leadsData]);

  const { data: waConfig } = useQuery<{ connected: boolean; display?: string | null }>({
    queryKey: ["whatsapp-config"],
    queryFn: () => api("/whatsapp/config"),
  });

  const { data: emailAccts } = useQuery<ConnectedAccount[]>({
    queryKey: ["connected-accounts"],
    queryFn: () => api("/integrations/accounts"),
  });
  const emailConnected = useMemo(
    () =>
      (emailAccts || []).some((a) =>
        ["smtp", "gmail", "resend", "sendgrid"].includes(a.provider) && a.status === "active"
      ),
    [emailAccts]
  );

  const filteredLeads = useMemo(() => {
    const q = search.trim().toLowerCase();
    return leads.filter((l) => {
      if (filter === "email" && !l.email) return false;
      if (filter === "whatsapp" && !l.phone) return false;
      if (!q) return true;
      return (
        (l.full_name || "").toLowerCase().includes(q) ||
        (l.email || "").toLowerCase().includes(q) ||
        (l.phone || "").includes(q) ||
        (l.company?.name || "").toLowerCase().includes(q) ||
        (l.title || "").toLowerCase().includes(q)
      );
    });
  }, [leads, search, filter]);

  // Auto-select first lead the moment the list loads.
  useEffect(() => {
    if (!activeLeadId && filteredLeads.length) {
      setActiveLeadId(filteredLeads[0].id);
    }
  }, [filteredLeads, activeLeadId]);

  const activeLead = useMemo(
    () => leads.find((l) => l.id === activeLeadId) || null,
    [leads, activeLeadId]
  );

  // Reset channel when switching lead — prefer Email if available, else WA.
  useEffect(() => {
    if (!activeLead) return;
    if (channel === "email" && !activeLead.email && activeLead.phone) setChannel("whatsapp");
    if (channel === "whatsapp" && !activeLead.phone && activeLead.email) setChannel("email");
    // Clear pending bubbles when switching leads.
    setPending((p) => p.filter((m) => false || (m as ConvMessage).pending !== true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeLeadId]);

  // Conversation history — polls every 3 s while a send is in flight,
  // every 15 s otherwise so reps see inbound replies show up fast enough.
  const hasPendingForLead = pending.some((p) => p.pending);
  const { data: timeline } = useQuery<TimelineItem[]>({
    queryKey: ["lead-timeline", activeLeadId],
    queryFn: () => api(`/leads/${activeLeadId}/timeline`),
    enabled: !!activeLeadId,
    refetchInterval: hasPendingForLead ? 3000 : 15_000,
  });

  // Project timeline into a channel-filtered ordered message list (oldest → newest).
  const conversation = useMemo<ConvMessage[]>(() => {
    if (!timeline) return [];
    const out: ConvMessage[] = [];
    for (const t of timeline) {
      if (t.kind === "email") {
        out.push({
          id: t.id,
          channel: "email",
          direction: (t.direction as ConvMessage["direction"]) || "outbound",
          subject: t.subject || null,
          body: t.preview || "",
          status: t.status || "sent",
          at: t.at || null,
        });
      } else if (t.kind === "activity" && t.type === "whatsapp_sent") {
        out.push({
          id: t.id,
          channel: "whatsapp",
          direction: "outbound",
          body: (t.payload?.body_preview || "") as string,
          status: "sent",
          at: t.at || null,
        });
      } else if (t.kind === "activity" && t.type === "whatsapp_received") {
        out.push({
          id: t.id,
          channel: "whatsapp",
          direction: "inbound",
          body: (t.payload?.body_preview || "") as string,
          status: "delivered",
          at: t.at || null,
        });
      }
    }
    // sort oldest → newest for natural chat rendering
    out.sort((a, b) =>
      (a.at || "").localeCompare(b.at || "")
    );
    // merge pending bubbles (these have client ids prefixed "p_")
    const pendingForLead = pending.filter((p) => p.pending);
    return [...out, ...pendingForLead];
  }, [timeline, pending]);

  // Once the backend timeline contains a message matching our pending body,
  // drop the pending bubble so it doesn't double-render.
  useEffect(() => {
    if (!timeline || !pending.length) return;
    const backendBodies = new Set(
      timeline
        .filter((t) => t.kind === "email" || (t.kind === "activity" && t.type === "whatsapp_sent"))
        .map((t) => ((t.payload?.body_preview || t.preview || "") as string).trim().slice(0, 120))
    );
    setPending((cur) =>
      cur.filter((p) => !backendBodies.has(p.body.trim().slice(0, 120)))
    );
  }, [timeline]);  // eslint-disable-line react-hooks/exhaustive-deps

  // ───── Send mutations ───────────────────────────────────────────────────
  const sendEmail = useMutation<unknown, Error, { subject: string; body: string }>({
    mutationFn: ({ subject, body }) =>
      api("/inbox/send", {
        method: "POST",
        body: {
          lead_id: activeLeadId,
          to: activeLead?.email,
          subject,
          body_html: body.replace(/\n/g, "<br/>"),
        },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["lead-timeline", activeLeadId] });
    },
  });

  const sendWhatsApp = useMutation<{ sent: number; failed: number; errors: string[] }, Error, string>({
    mutationFn: (body) =>
      api("/whatsapp/send", {
        method: "POST",
        body: { message: body, lead_ids: [activeLeadId] },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["lead-timeline", activeLeadId] });
    },
  });

  function dispatchSend(args: { subject?: string; body: string }) {
    if (!activeLead || !args.body.trim()) return;
    const pendingId = "p_" + Math.random().toString(36).slice(2);
    const pendingMsg: ConvMessage = {
      id: pendingId,
      channel,
      direction: "outbound",
      subject: args.subject || null,
      body: args.body.trim(),
      status: "queued",
      at: new Date().toISOString(),
      pending: true,
    };
    setPending((cur) => [...cur, pendingMsg]);

    if (channel === "email") {
      sendEmail.mutate(
        { subject: args.subject || "", body: args.body.trim() },
        {
          onError: () => {
            setPending((cur) =>
              cur.map((p) => (p.id === pendingId ? { ...p, status: "failed", pending: false } : p))
            );
          },
        }
      );
    } else {
      sendWhatsApp.mutate(args.body.trim(), {
        onError: () => {
          setPending((cur) =>
            cur.map((p) => (p.id === pendingId ? { ...p, status: "failed", pending: false } : p))
          );
        },
        onSuccess: (r) => {
          if (r.failed > 0) {
            setPending((cur) =>
              cur.map((p) => (p.id === pendingId ? { ...p, status: "failed", pending: false } : p))
            );
          }
        },
      });
    }
  }

  return (
    <div className="flex h-full overflow-hidden bg-slate-50">
      {/* ───────── LEFT: lead picker ───────── */}
      <aside className="flex w-[320px] shrink-0 flex-col border-r border-slate-200 bg-white">
        <div className="border-b border-slate-100 px-4 py-3">
          <div className="mb-2 flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-indigo-600" />
            <h1 className="text-sm font-semibold">Outreach</h1>
          </div>
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-slate-400" />
            <input
              className="input pl-8"
              placeholder="Search name, email, phone…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <div className="mt-2 flex gap-1">
            {(["all", "email", "whatsapp"] as const).map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={cn(
                  "rounded-full px-2.5 py-1 text-[11px] font-medium",
                  filter === f
                    ? "bg-indigo-600 text-white"
                    : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                )}
              >
                {f === "all" ? "All" : f === "email" ? "Has email" : "Has phone"}
              </button>
            ))}
            <span className="ml-auto self-center text-[11px] text-slate-400">
              {filteredLeads.length}
            </span>
          </div>
        </div>

        <ul className="flex-1 overflow-y-auto">
          {filteredLeads.map((l) => {
            const active = l.id === activeLeadId;
            return (
              <li key={l.id}>
                <button
                  type="button"
                  onClick={() => setActiveLeadId(l.id)}
                  className={cn(
                    "flex w-full items-start gap-2.5 border-l-2 px-3 py-2.5 text-left transition-colors",
                    active
                      ? "border-indigo-500 bg-indigo-50/60"
                      : "border-transparent hover:bg-slate-50"
                  )}
                >
                  <span className="grid h-9 w-9 flex-shrink-0 place-items-center rounded-full bg-slate-100 text-[10px] font-semibold uppercase text-slate-500">
                    {initials(l.full_name || l.email)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-slate-800">
                      {l.full_name || "Unknown"}
                    </span>
                    <span className="block truncate text-xs text-slate-500">
                      {l.title || l.company?.name || "—"}
                    </span>
                    <span className="mt-1 flex items-center gap-2 text-[10px] text-slate-400">
                      {l.email && (
                        <span className="inline-flex items-center gap-0.5">
                          <Mail className="h-3 w-3" /> mail
                        </span>
                      )}
                      {l.phone && (
                        <span className="inline-flex items-center gap-0.5">
                          <MessageCircle className="h-3 w-3" /> wa
                        </span>
                      )}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
          {filteredLeads.length === 0 && (
            <li className="px-4 py-10 text-center text-xs text-slate-400">
              No leads match.
            </li>
          )}
        </ul>
      </aside>

      {/* ───────── RIGHT: conversation pane ───────── */}
      <main className="flex flex-1 flex-col overflow-hidden">
        {!activeLead ? (
          <EmptyState />
        ) : (
          <>
            <LeadHeader lead={activeLead} />
            <ChannelTabs
              lead={activeLead}
              channel={channel}
              setChannel={setChannel}
              emailConnected={emailConnected}
              waConnected={!!waConfig?.connected}
            />
            <ConversationStream messages={conversation.filter((m) => m.channel === channel)} channel={channel} />
            <Composer
              lead={activeLead}
              channel={channel}
              isSending={
                channel === "email" ? sendEmail.isPending : sendWhatsApp.isPending
              }
              canSend={
                channel === "email"
                  ? !!activeLead.email && emailConnected
                  : !!activeLead.phone && !!waConfig?.connected
              }
              onSend={dispatchSend}
              emailConnected={emailConnected}
              waConnected={!!waConfig?.connected}
            />
          </>
        )}
      </main>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Sub-components

function EmptyState() {
  return (
    <div className="grid flex-1 place-items-center text-center text-sm text-slate-400">
      <div>
        <Inbox className="mx-auto mb-2 h-8 w-8 text-slate-300" />
        Pick a lead on the left to start a conversation.
      </div>
    </div>
  );
}

function LeadHeader({ lead }: { lead: Lead }) {
  return (
    <div className="flex items-center gap-3 border-b border-slate-200 bg-white px-5 py-3.5">
      <span className="grid h-11 w-11 place-items-center rounded-full bg-slate-100 text-xs font-semibold uppercase text-slate-500">
        {initials(lead.full_name || lead.email)}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <h2 className="truncate text-sm font-semibold text-slate-800">
            {lead.full_name || "Unknown"}
          </h2>
          {lead.linkedin_url && (
            <a
              href={lead.linkedin_url}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-brand-600"
              title="Open LinkedIn profile"
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          )}
        </div>
        <div className="mt-0.5 truncate text-xs text-slate-500">
          {lead.title || ""}
          {lead.title && lead.company?.name ? " · " : ""}
          {lead.company?.name || ""}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-3 text-[11px] text-slate-500">
          {lead.email && (
            <span className="inline-flex items-center gap-1">
              <Mail className="h-3 w-3" /> {lead.email}
            </span>
          )}
          {lead.phone && (
            <span className="inline-flex items-center gap-1">
              <Phone className="h-3 w-3" /> {lead.phone}
            </span>
          )}
        </div>
      </div>
      <Link
        href={`/leads/${lead.id}`}
        className="rounded-md border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-600 hover:border-indigo-300 hover:text-indigo-700"
      >
        Lead detail →
      </Link>
    </div>
  );
}

function ChannelTabs({
  lead,
  channel,
  setChannel,
  emailConnected,
  waConnected,
}: {
  lead: Lead;
  channel: Channel;
  setChannel: (c: Channel) => void;
  emailConnected: boolean;
  waConnected: boolean;
}) {
  const tabs: { id: Channel; label: string; icon: typeof Mail; reachable: boolean; configured: boolean }[] = [
    { id: "email", label: "Email", icon: Mail, reachable: !!lead.email, configured: emailConnected },
    { id: "whatsapp", label: "WhatsApp", icon: MessageCircle, reachable: !!lead.phone, configured: waConnected },
  ];
  return (
    <div className="flex border-b border-slate-200 bg-white px-3">
      {tabs.map((t) => {
        const active = channel === t.id;
        const live = t.reachable && t.configured;
        return (
          <button
            key={t.id}
            onClick={() => setChannel(t.id)}
            className={cn(
              "relative inline-flex items-center gap-2 px-4 py-2.5 text-sm font-medium",
              active
                ? "text-indigo-700"
                : "text-slate-500 hover:text-slate-800"
            )}
          >
            <t.icon className="h-4 w-4" />
            {t.label}
            <span
              className={cn(
                "ml-1 h-1.5 w-1.5 rounded-full",
                live ? "bg-emerald-500" : "bg-slate-300"
              )}
              title={live ? "Connected" : "Not reachable on this lead"}
            />
            {active && (
              <span className="absolute inset-x-3 -bottom-px h-0.5 rounded-full bg-indigo-600" />
            )}
          </button>
        );
      })}
    </div>
  );
}

function ConversationStream({
  messages,
  channel,
}: {
  messages: ConvMessage[];
  channel: Channel;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Stick to bottom on new messages.
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length]);
  return (
    <div ref={scrollRef} className="flex-1 overflow-y-auto bg-slate-50 px-6 py-5">
      {messages.length === 0 ? (
        <div className="grid h-full place-items-center text-xs text-slate-400">
          No {channel === "email" ? "emails" : "WhatsApp messages"} with this lead yet — send the first one below.
        </div>
      ) : (
        <ul className="mx-auto flex max-w-3xl flex-col gap-3">
          {messages.map((m) => (
            <Bubble key={m.id} message={m} />
          ))}
        </ul>
      )}
    </div>
  );
}

function Bubble({ message }: { message: ConvMessage }) {
  const isOut = message.direction === "outbound";
  const palette =
    message.channel === "whatsapp"
      ? "bg-emerald-600 text-white"
      : "bg-indigo-600 text-white";
  return (
    <li className={cn("flex", isOut ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "max-w-[72%] rounded-2xl px-3.5 py-2.5 text-sm shadow-sm",
          isOut
            ? message.status === "failed"
              ? "bg-red-50 text-red-700 ring-1 ring-red-200"
              : palette
            : "bg-white text-slate-800 ring-1 ring-slate-200"
        )}
      >
        {message.subject && (
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide opacity-80">
            {message.subject}
          </div>
        )}
        <div className="whitespace-pre-wrap break-words">{message.body || "(empty)"}</div>
        <div className="mt-1 flex items-center justify-end gap-1 text-[10px] opacity-80">
          {message.at ? fmtDate(message.at) : ""}
          {isOut && (
            <span className="ml-1">
              {message.status === "failed" ? (
                <AlertCircle className="h-3 w-3" />
              ) : message.pending || message.status === "queued" ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <CheckCheck className="h-3 w-3" />
              )}
            </span>
          )}
        </div>
      </div>
    </li>
  );
}

function Composer({
  lead,
  channel,
  isSending,
  canSend,
  onSend,
  emailConnected,
  waConnected,
}: {
  lead: Lead;
  channel: Channel;
  isSending: boolean;
  canSend: boolean;
  onSend: (args: { subject?: string; body: string }) => void;
  emailConnected: boolean;
  waConnected: boolean;
}) {
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  // Reset composer when lead or channel changes.
  useEffect(() => {
    setSubject("");
    setBody("");
  }, [lead.id, channel]);

  const trimmed = body.trim();
  const isEmail = channel === "email";
  const missingContact = isEmail ? !lead.email : !lead.phone;
  const missingProvider = isEmail ? !emailConnected : !waConnected;
  const send = () => {
    if (!trimmed || isSending || !canSend) return;
    onSend({ subject: isEmail ? subject || "(no subject)" : undefined, body: trimmed });
    setBody("");
    setSubject("");
  };
  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      send();
    }
  }

  return (
    <div className="border-t border-slate-200 bg-white px-5 py-3">
      {/* Banner: missing config / contact */}
      {missingContact && (
        <div className="mb-2 flex items-start gap-2 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
          This lead has no {isEmail ? "email address" : "phone number"} on file.
        </div>
      )}
      {missingProvider && !missingContact && (
        <div className="mb-2 flex items-start gap-2 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">
          <Plug className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
          {isEmail ? (
            <span>
              No email sender connected.{" "}
              <Link href="/settings/email" className="font-medium underline">
                Connect SMTP / Resend / SendGrid →
              </Link>
            </span>
          ) : (
            <span>
              WhatsApp Business API not connected.{" "}
              <Link href="/settings/whatsapp" className="font-medium underline">
                Connect WhatsApp →
              </Link>
            </span>
          )}
        </div>
      )}

      {isEmail && (
        <input
          className="input mb-2"
          placeholder="Subject"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          maxLength={250}
        />
      )}
      <textarea
        className="input min-h-[110px] resize-y leading-relaxed"
        placeholder={
          isEmail
            ? `Hi ${lead.first_name || (lead.full_name || "").split(" ")[0] || "there"},\n\n…`
            : `Hi ${lead.first_name || (lead.full_name || "").split(" ")[0] || "there"}, …`
        }
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={onKeyDown}
        maxLength={8000}
      />

      <div className="mt-2 flex items-center justify-between">
        <span className="text-[11px] text-slate-400">
          {isEmail
            ? "Cmd / Ctrl + Enter to send. Lands in their inbox via your connected sender."
            : "Cmd / Ctrl + Enter to send. Delivered via WhatsApp Cloud API."}
        </span>
        <button
          className={cn(
            "btn",
            isEmail
              ? "bg-indigo-600 text-white hover:bg-indigo-700"
              : "bg-emerald-600 text-white hover:bg-emerald-700",
            "disabled:cursor-not-allowed disabled:opacity-50"
          )}
          disabled={!trimmed || isSending || !canSend}
          onClick={send}
        >
          {isSending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Send className="h-4 w-4" />
          )}
          {isSending ? "Sending…" : `Send via ${isEmail ? "Email" : "WhatsApp"}`}
        </button>
      </div>
    </div>
  );
}
