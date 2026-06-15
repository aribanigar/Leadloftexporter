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
  CheckSquare,
  Square,
  X as XIcon,
  Users,
} from "lucide-react";
import Link from "next/link";
import { api, getToken, getWorkspaceId } from "@/lib/api";
import type { Lead, LeadList } from "@/lib/types";
import { cn, initials, fmtDate } from "@/lib/utils";
import { ConnectSmtpModal } from "@/components/connect-smtp-modal";
import { ConnectWhatsAppModal } from "@/components/connect-whatsapp-modal";

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
  error?: string | null;
  at?: string | null;
}

interface ConvMessage {
  id: string;
  channel: Channel;
  direction: "outbound" | "inbound";
  subject?: string | null;
  body: string;
  status: "queued" | "sent" | "delivered" | "failed" | string;
  error?: string | null;
  at: string | null;
  pending?: boolean;
}

interface ConnectedAccount {
  id: string;
  provider: string;
  label: string | null;
  status: string;
  // The actual from-address as returned by the senders endpoint. Used to
  // detect Resend-on-free-mailbox-domain, which Resend rejects.
  external_id?: string | null;
  from_address?: string | null;
}

// Free mailbox domains Resend refuses to send from without domain verification.
const FREE_MAILBOX_DOMAINS = new Set([
  "gmail.com", "googlemail.com",
  "yahoo.com", "yahoo.co.uk", "yahoo.in",
  "hotmail.com", "outlook.com", "live.com", "msn.com",
  "icloud.com", "me.com", "mac.com",
  "aol.com", "protonmail.com", "proton.me",
  "mail.com", "gmx.com", "yandex.com", "zoho.com",
]);

function isResendDomainBlocked(acct: ConnectedAccount): boolean {
  if (acct.provider !== "resend") return false;
  const email = (acct.from_address || acct.external_id || acct.label || "").toLowerCase();
  const at = email.lastIndexOf("@");
  if (at < 0) return false;
  const domain = email.slice(at + 1).trim();
  return FREE_MAILBOX_DOMAINS.has(domain);
}

export default function OutreachPage() {
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"all" | "email" | "whatsapp">("all");
  const [activeLeadId, setActiveLeadId] = useState<string | null>(null);
  const [channel, setChannel] = useState<Channel>("email");
  // When ON: after a successful single send, jump to the next lead in the
  // filtered list. Lets you blow through the whole list with no clicks
  // between sends — same effect as Bulk mode but with one composer per lead
  // (good if you want to tweak each subject/body before sending).
  const [autoAdvance, setAutoAdvance] = useState(true);
  // Pending sends keyed by client-generated id so they render instantly
  // and flip to "confirmed" when the backend timeline catches up.
  const [pending, setPending] = useState<ConvMessage[]>([]);

  // ── Bulk-select state. When `selectedIds.size > 0` the right pane switches
  // from the per-lead conversation view to a Bulk Compose panel that sends
  // one /inbox/send POST per selected lead, with {first_name}/{full_name}/
  // {company} merge substitution. Each selection is a Lead.id from the same
  // list shown on the left, so the count and the actual send targets cannot
  // disagree.
  const [bulkMode, setBulkMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const toggleSelect = (id: string) => {
    setSelectedIds((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

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

  // Use /campaigns/senders/list — the SAME endpoint Campaign Builder uses,
  // which returns ONLY email-capable senders (SMTP, Gmail, Resend, SendGrid)
  // filtered server-side. Previously this called /integrations/accounts
  // which returns every connected account (LinkedIn, HubSpot, etc.) and
  // missed senders that Campaigns could see — leaving users staring at the
  // "Connect SMTP" modal even though Campaigns showed 3 active mailboxes.
  // Refetches on window focus + every 30s so a newly-connected sender in
  // Settings or Campaign Builder reflects here without a manual reload.
  const { data: emailAccts } = useQuery<ConnectedAccount[]>({
    queryKey: ["outreach-senders"],
    queryFn: () => api("/campaigns/senders/list"),
    refetchOnWindowFocus: true,
    refetchInterval: 30_000,
    staleTime: 0,
  });
  const emailConnected = useMemo(
    () => (emailAccts || []).some((a) => a.status === "active"),
    [emailAccts]
  );

  // Critical guardrail: detect the "Resend connected but the from-address is
  // a free mailbox domain" case. Resend silently refuses ALL such sends with
  // a 403/422 and a vague error string, which used to surface as red bubbles
  // with no explanation. We now show a prominent banner pointing the user at
  // the only two fixes (verify a domain in Resend OR connect SMTP).
  const resendDomainBlock = useMemo(() => {
    const accts = (emailAccts || []).filter((a) => a.status === "active");
    if (accts.length === 0) return null;
    const allBlocked = accts.every((a) => isResendDomainBlocked(a));
    if (!allBlocked) return null;
    return accts[0];
  }, [emailAccts]);

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
          error: t.error || null,
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
    // Merge ALL pending bubbles (both still-pending and just-resolved-by-mutation).
    // The composer used to disappear the user's text because we dedup'd
    // pending against the backend timeline by body prefix — if any earlier
    // send had the same opener, the new bubble vanished instantly. Now we
    // keep pending bubbles in the conversation until they age out (30 s
    // after the mutation resolves), so the user always sees their just-
    // sent message land, with a clear ✓ or ⚠️ status icon.
    return [...out, ...pending];
  }, [timeline, pending]);

  // Age-out pending bubbles 30 s AFTER they resolve (pending=false). We
  // never time out a still-pending bubble — that would make the user think
  // a slow Render-tier backend "lost" their message.
  useEffect(() => {
    if (!pending.length) return;
    const t = setInterval(() => {
      const cutoff = Date.now() - 30_000;
      setPending((cur) =>
        cur.filter((p) => {
          if (p.pending) return true;
          const ageStart = p.at ? Date.parse(p.at) : 0;
          return ageStart > cutoff;
        })
      );
    }, 5000);
    return () => clearInterval(t);
  }, [pending.length]);

  // ───── Send mutations ───────────────────────────────────────────────────
  // /inbox/send now dispatches the SMTP/HTTPS call synchronously and
  // returns the resolved status — we use that to flip the pending bubble
  // straight to "sent" or "failed" without waiting for the next 3 s
  // timeline poll. The mutation context carries the pending bubble id so
  // onSuccess/onError can target the right one.
  type SendEmailResp = {
    id?: string;
    status?: string;
    ok: boolean;
    error?: string | null;
    from_address?: string | null;
  };
  const sendEmail = useMutation<
    SendEmailResp,
    Error,
    { subject: string; body: string; pendingId: string }
  >({
    // Route the single-lead send through the Vercel bridge (/api/outreach/send)
    // instead of calling Python /inbox/send directly. Render's free tier
    // blocks outbound SMTP ports — Python can't actually deliver, so direct
    // sends silently fell through to Resend, which rejected every send
    // ("sending domain isn't verified"). The bridge does prepare-send on
    // Python, dispatches via nodemailer/Resend/SendGrid FROM Vercel (which
    // CAN open SMTP), then commit-send on Python. This is the same path
    // bulk send uses — now both work identically.
    mutationFn: async ({ subject, body }) => {
      const token = getToken();
      const wsId = getWorkspaceId();
      const res = await fetch("/api/outreach/send", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token || ""}`,
          "X-Workspace-Id": wsId || "",
        },
        body: JSON.stringify({
          lead_id: activeLeadId,
          to: activeLead?.email,
          subject,
          body_html: body.replace(/\n/g, "<br/>"),
          body_text: body,
        }),
      });
      const text = await res.text();
      let r: SendEmailResp = { ok: false };
      try { r = JSON.parse(text); } catch { r = { ok: false, error: "non_json_response" }; }
      return r;
    },
    onSuccess: (r, vars) => {
      // Resolved synchronously — flip the bubble immediately.
      setPending((cur) =>
        cur.map((p) =>
          p.id === vars.pendingId
            ? {
                ...p,
                status: r.ok ? "sent" : "failed",
                pending: false,
              }
            : p
        )
      );
      qc.invalidateQueries({ queryKey: ["lead-timeline", activeLeadId] });
      qc.invalidateQueries({ queryKey: ["outreach-leads"] });
      // Auto-advance to the next lead in the filtered list (skip ones with
      // no email since they can't receive). Stops at the end of the list.
      if (autoAdvance && r.ok && channel === "email") {
        const targets = filteredLeads.filter((l) => (l.email || "").trim() !== "");
        const idx = targets.findIndex((l) => l.id === activeLeadId);
        const next = idx >= 0 && idx < targets.length - 1 ? targets[idx + 1] : null;
        if (next) {
          // Give the user a beat to see "sent" flip, then advance.
          setTimeout(() => setActiveLeadId(next.id), 600);
        }
      }
    },
    onError: (_e, vars) => {
      setPending((cur) =>
        cur.map((p) =>
          p.id === vars.pendingId ? { ...p, status: "failed", pending: false } : p
        )
      );
    },
  });

  const sendWhatsApp = useMutation<
    { sent: number; failed: number; errors: string[] },
    Error,
    { body: string; pendingId: string }
  >({
    mutationFn: ({ body }) =>
      api("/whatsapp/send", {
        method: "POST",
        body: { message: body, lead_ids: [activeLeadId] },
      }),
    onSuccess: (r, vars) => {
      setPending((cur) =>
        cur.map((p) =>
          p.id === vars.pendingId
            ? {
                ...p,
                status: r.failed > 0 ? "failed" : "sent",
                pending: false,
              }
            : p
        )
      );
      qc.invalidateQueries({ queryKey: ["lead-timeline", activeLeadId] });
    },
    onError: (_e, vars) => {
      setPending((cur) =>
        cur.map((p) =>
          p.id === vars.pendingId ? { ...p, status: "failed", pending: false } : p
        )
      );
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
      sendEmail.mutate({
        subject: args.subject || "",
        body: args.body.trim(),
        pendingId,
      });
    } else {
      sendWhatsApp.mutate({ body: args.body.trim(), pendingId });
    }
  }

  const [smtpModalOpen, setSmtpModalOpen] = useState(false);
  const [waModalOpen, setWaModalOpen] = useState(false);

  // ── Bulk send: loop sequentially through selectedIds and call /inbox/send
  // per lead. Sequential (not parallel) so SMTP servers and warmup caps
  // don't get hammered, and so the progress bar advances visibly.
  type BulkResult = {
    leadId: string;
    name: string;
    email: string;
    status: "queued" | "sent" | "failed";
    error?: string;
  };
  const [bulkSending, setBulkSending] = useState(false);
  const [bulkResults, setBulkResults] = useState<BulkResult[]>([]);
  const bulkAbortRef = useRef<boolean>(false);

  function renderMergeTokens(template: string, lead: Lead): string {
    const first =
      lead.first_name ||
      (lead.full_name || "").trim().split(/\s+/)[0] ||
      "there";
    return template
      .replace(/\{first_name\}/gi, first)
      .replace(/\{full_name\}/gi, lead.full_name || first)
      .replace(/\{company\}/gi, lead.company?.name || "")
      .replace(/\{title\}/gi, lead.title || "")
      .replace(/\{email\}/gi, lead.email || "");
  }

  async function runBulkSend(opts: { subject: string; body: string }) {
    if (bulkSending) return;
    const targets = leads.filter(
      (l) => selectedIds.has(l.id) && (l.email || "").trim() !== ""
    );
    if (targets.length === 0) return;

    bulkAbortRef.current = false;
    setBulkSending(true);
    setBulkResults(
      targets.map((l) => ({
        leadId: l.id,
        name: l.full_name || l.email || "Lead",
        email: l.email || "",
        status: "queued",
      }))
    );

    // Route every send through the Next.js bridge route at /api/outreach/send
    // (NOT the Python /inbox/send), because the actual SMTP TCP has to leave
    // from Vercel — Render's free tier blocks outbound SMTP ports and the
    // direct dispatch was failing red on every recipient. The bridge calls
    // Python /inbox/prepare-send → nodemailer → Python /inbox/commit-send.
    const token = getToken();
    const wsId = getWorkspaceId();
    for (let i = 0; i < targets.length; i++) {
      if (bulkAbortRef.current) break;
      const lead = targets[i];
      const subject = renderMergeTokens(opts.subject, lead);
      const body = renderMergeTokens(opts.body, lead);
      try {
        const res = await fetch("/api/outreach/send", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${token || ""}`,
            "X-Workspace-Id": wsId || "",
          },
          body: JSON.stringify({
            lead_id: lead.id,
            to: lead.email,
            subject,
            body_html: body.replace(/\n/g, "<br/>"),
            body_text: body,
          }),
        });
        const text = await res.text();
        let r: { ok?: boolean; error?: string | null } = {};
        try { r = JSON.parse(text); } catch { r = { ok: false, error: "non_json_response" }; }
        setBulkResults((cur) =>
          cur.map((b) =>
            b.leadId === lead.id
              ? { ...b, status: r.ok ? "sent" : "failed", error: r.error || undefined }
              : b
          )
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setBulkResults((cur) =>
          cur.map((b) =>
            b.leadId === lead.id ? { ...b, status: "failed", error: msg } : b
          )
        );
      }
      // Small pacing gap so we don't hammer the SMTP server or trip rate
      // limits — matches the campaign default of ~1.2 s between sends.
      if (i < targets.length - 1 && !bulkAbortRef.current) {
        await new Promise((r) => setTimeout(r, 1200));
      }
    }
    setBulkSending(false);
    qc.invalidateQueries({ queryKey: ["outreach-leads"] });
  }

  // When the user toggles bulk mode off, clear selection so we don't surprise
  // them by re-entering bulk with old picks still active.
  useEffect(() => {
    if (!bulkMode) {
      setSelectedIds(new Set());
      setBulkResults([]);
    }
  }, [bulkMode]);

  return (
    <div className="app-canvas flex h-full flex-col overflow-hidden md:flex-row">
      <ConnectSmtpModal
        open={smtpModalOpen}
        onClose={() => setSmtpModalOpen(false)}
        onConnected={() => {
          // Invalidate both keys — outreach-senders is what THIS page reads,
          // connected-accounts is what other pages (e.g. Settings) may still use.
          qc.invalidateQueries({ queryKey: ["outreach-senders"] });
          qc.invalidateQueries({ queryKey: ["connected-accounts"] });
          setSmtpModalOpen(false);
        }}
      />
      <ConnectWhatsAppModal
        open={waModalOpen}
        onClose={() => setWaModalOpen(false)}
        alreadyConnected={!!waConfig?.connected}
        display={waConfig?.display}
        onConnected={() => {
          qc.invalidateQueries({ queryKey: ["whatsapp-config"] });
          setTimeout(() => setWaModalOpen(false), 600);
        }}
      />
      {/* ───────── LEFT: lead picker ───────── */}
      <aside className="flex w-full shrink-0 flex-col border-b border-slate-200 bg-white md:w-[320px] md:border-b-0 md:border-r">
        <div className="border-b border-slate-100 px-4 py-3">
          <div className="mb-2 flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-indigo-600" />
            <h1 className="text-sm font-semibold">Outreach</h1>
            {/* Always-visible Connect SMTP button so users can set up an
                email sender without leaving this page. Quietly shows the
                Settings link too for the longer flow with Gmail/Resend/etc. */}
            <div className="ml-auto flex items-center gap-1">
              <button
                type="button"
                onClick={() => setSmtpModalOpen(true)}
                className={cn(
                  "inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium",
                  emailConnected
                    ? "text-slate-500 hover:bg-slate-100"
                    : "bg-indigo-600 text-white hover:bg-indigo-700"
                )}
                title="Set up SMTP to send email"
              >
                <Mail className="h-3 w-3" />
                {emailConnected ? "+SMTP" : "SMTP"}
              </button>
              <button
                type="button"
                onClick={() => setWaModalOpen(true)}
                className={cn(
                  "inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium",
                  waConfig?.connected
                    ? "text-slate-500 hover:bg-slate-100"
                    : "bg-emerald-600 text-white hover:bg-emerald-700"
                )}
                title="Connect WhatsApp"
              >
                <MessageCircle className="h-3 w-3" />
                WhatsApp
              </button>
            </div>
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

          {/* Bulk-select bar — toggles checkboxes on every row and swaps the
              right pane into Bulk Compose mode. Tracks count + a one-click
              "Select all with email" since that's the only useful target for
              email sends anyway. */}
          <div className="mt-2 flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setBulkMode((v) => !v)}
              className={cn(
                "inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium",
                bulkMode
                  ? "bg-indigo-600 text-white hover:bg-indigo-700"
                  : "bg-slate-100 text-slate-600 hover:bg-slate-200"
              )}
              title="Pick multiple leads and send the same message to all of them"
            >
              <Users className="h-3 w-3" />
              {bulkMode ? `Bulk · ${selectedIds.size}` : "Bulk"}
            </button>
            {bulkMode && (
              <>
                <button
                  type="button"
                  onClick={() => {
                    const withEmail = filteredLeads
                      .filter((l) => (l.email || "").trim() !== "")
                      .map((l) => l.id);
                    setSelectedIds(new Set(withEmail));
                  }}
                  className="rounded-md px-2 py-1 text-[11px] font-medium text-indigo-600 hover:bg-indigo-50"
                >
                  All w/ email
                </button>
                {selectedIds.size > 0 && (
                  <button
                    type="button"
                    onClick={() => setSelectedIds(new Set())}
                    className="rounded-md px-2 py-1 text-[11px] font-medium text-slate-500 hover:bg-slate-100"
                  >
                    Clear
                  </button>
                )}
              </>
            )}
          </div>
        </div>

        <ul className="flex-1 overflow-y-auto">
          {filteredLeads.map((l) => {
            const active = l.id === activeLeadId;
            const checked = selectedIds.has(l.id);
            return (
              <li key={l.id}>
                <button
                  type="button"
                  onClick={() => {
                    if (bulkMode) toggleSelect(l.id);
                    else setActiveLeadId(l.id);
                  }}
                  className={cn(
                    "flex w-full items-start gap-2.5 border-l-2 px-3 py-2.5 text-left transition-colors",
                    bulkMode && checked
                      ? "border-indigo-500 bg-indigo-50/80"
                      : !bulkMode && active
                      ? "border-indigo-500 bg-indigo-50/60"
                      : "border-transparent hover:bg-slate-50"
                  )}
                >
                  {bulkMode && (
                    <span className="mt-1 flex-shrink-0 text-indigo-600">
                      {checked ? (
                        <CheckSquare className="h-4 w-4" />
                      ) : (
                        <Square className="h-4 w-4 text-slate-300" />
                      )}
                    </span>
                  )}
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

      {/* ───────── RIGHT: bulk compose OR per-lead conversation ───────── */}
      <main className="hidden flex-1 flex-col overflow-hidden md:flex">
        {/* Resend-domain-block banner. Surfaces ABOVE both bulk and single
            modes because the failure mode is identical either way: Resend
            refuses the send before any of our code can do anything about
            it. Without this banner the user just saw red bubbles with no
            explanation. */}
        {resendDomainBlock && (
          <div className="border-b border-amber-200 bg-amber-50 px-5 py-3">
            <div className="flex items-start gap-2.5">
              <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-600" />
              <div className="flex-1 text-xs leading-relaxed text-amber-900">
                <div className="mb-0.5 font-semibold">
                  Resend won&apos;t deliver from{" "}
                  <code className="rounded bg-amber-100 px-1">{resendDomainBlock.external_id || resendDomainBlock.label}</code>
                </div>
                Resend refuses sends from free mailbox domains (gmail.com,
                outlook.com, etc). Every email you try will come back red
                until you do one of these:
                <ul className="mt-1 ml-4 list-disc">
                  <li>
                    Verify a domain you own at{" "}
                    <a href="https://resend.com/domains" target="_blank" rel="noopener noreferrer" className="underline">resend.com/domains</a>
                    {" "}— then reconnect this sender using an address on that domain.
                  </li>
                  <li>
                    Or connect a regular SMTP mailbox (Hostinger, Zoho, your
                    own server) from{" "}
                    <button
                      type="button"
                      onClick={() => setSmtpModalOpen(true)}
                      className="underline font-semibold"
                    >
                      Connect SMTP
                    </button>
                    {" "}— works immediately, no DNS setup.
                  </li>
                </ul>
              </div>
            </div>
          </div>
        )}
        {bulkMode ? (
          <BulkComposer
            count={selectedIds.size}
            targets={leads.filter(
              (l) => selectedIds.has(l.id) && (l.email || "").trim() !== ""
            )}
            allSelectedCount={selectedIds.size}
            results={bulkResults}
            sending={bulkSending}
            emailConnected={emailConnected}
            onConnectEmail={() => setSmtpModalOpen(true)}
            onSend={(subject, body) => runBulkSend({ subject, body })}
            onCancel={() => {
              bulkAbortRef.current = true;
            }}
            onClose={() => setBulkMode(false)}
          />
        ) : !activeLead ? (
          <EmptyState />
        ) : (
          <>
            <LeadHeader
              lead={activeLead}
              autoAdvance={autoAdvance}
              onToggleAutoAdvance={setAutoAdvance}
            />
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
              onConnectEmail={() => setSmtpModalOpen(true)}
              onConnectWhatsApp={() => setWaModalOpen(true)}
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

function LeadHeader({
  lead,
  autoAdvance,
  onToggleAutoAdvance,
}: {
  lead: Lead;
  autoAdvance: boolean;
  onToggleAutoAdvance: (v: boolean) => void;
}) {
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
      {/* WhatsApp Web quick-open — opens the real chat in WhatsApp Web
          so the rep can have a live, two-way conversation in their
          actual WhatsApp inbox. No API setup required. */}
      {lead.phone && (
        <a
          href={`https://wa.me/${lead.phone.replace(/\D/g, "")}`}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700"
          title="Open the live chat in WhatsApp Web — real inbox, real-time"
        >
          <MessageCircle className="h-3.5 w-3.5" />
          WhatsApp Web
          <ExternalLink className="h-3 w-3" />
        </a>
      )}
      {/* Auto-advance toggle: after a successful single-send, jump to the
          next lead in the filtered list. Lets the rep blow through 50
          one-tweak emails without ever clicking a lead manually. */}
      <button
        type="button"
        onClick={() => onToggleAutoAdvance(!autoAdvance)}
        className={cn(
          "inline-flex items-center gap-1 rounded-md px-2 py-1.5 text-[11px] font-medium",
          autoAdvance
            ? "bg-indigo-50 text-indigo-700 hover:bg-indigo-100"
            : "border border-slate-200 text-slate-500 hover:border-indigo-300 hover:text-indigo-700"
        )}
        title="When ON: after sending, auto-jump to the next lead in the list (skip ones with no email). OFF: stay on current lead."
      >
        {autoAdvance ? <CheckSquare className="h-3 w-3" /> : <Square className="h-3 w-3" />}
        Auto-next
      </button>
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

// Translates raw provider errors into one-line plain-English instructions.
// The most common one we see — Resend rejecting sends from @gmail.com (and
// other free mailbox domains) because the user hasn't verified a domain in
// their Resend dashboard — was previously invisible: each failed bubble
// just had a tiny warning icon. Users had no way to know they needed to
// either verify a domain or switch to SMTP.
function humanFailReason(error: string): string {
  const e = (error || "").toLowerCase();
  if (
    e.includes("resend_http_403") ||
    (e.includes("resend") && (e.includes("domain") || e.includes("not verified")))
  ) {
    return "Resend rejected this send — your sending domain isn't verified. Either (1) verify a domain at resend.com/domains, or (2) connect an SMTP mailbox (Hostinger / Zoho / your own server) in Settings → Email Senders.";
  }
  if (e.includes("resend_http_429")) {
    return "Resend rate-limited this send. Wait a minute and try again.";
  }
  if (
    e.includes("resend") &&
    (e.includes("testing emails") || e.includes("your own email"))
  ) {
    return "Resend sandbox mode — you can only send to your own email until you verify a domain. Connect an SMTP sender or verify your domain at resend.com/domains.";
  }
  if (e.includes("smtp_auth_failed") || /535|invalid login/i.test(error)) {
    return "SMTP rejected the username / password. Double-check the credentials in Settings → Email Senders.";
  }
  if (e.includes("no_active_sender_connected")) {
    return "No connected email sender. Add one in Settings → Email Senders.";
  }
  if (e.includes("relay_http_404") || e.includes("host_not_allowed")) {
    return "The Vercel SMTP relay isn't reachable from this backend yet. Wait for the latest deploy or re-check the relay URL.";
  }
  // Fall back to the raw error so we never leave the user guessing.
  return error;
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
    <div ref={scrollRef} className="app-canvas flex-1 overflow-y-auto px-6 py-5">
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
        {/* Why-it-failed line. The earlier UX showed only a tiny warning
            icon on failed sends, leaving the user guessing. We now surface
            the actual provider error inline and translate the common
            Resend "domain not verified" case to a plain-English fix
            instruction so they don't have to read raw API errors. */}
        {message.status === "failed" && message.error && (
          <div className="mt-1.5 rounded bg-red-100 px-2 py-1 text-[11px] text-red-800">
            {humanFailReason(message.error)}
          </div>
        )}
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
  onConnectEmail,
  onConnectWhatsApp,
}: {
  lead: Lead;
  channel: Channel;
  isSending: boolean;
  canSend: boolean;
  onSend: (args: { subject?: string; body: string }) => void;
  emailConnected: boolean;
  waConnected: boolean;
  onConnectEmail?: () => void;
  onConnectWhatsApp?: () => void;
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
    // Don't clear the textarea here — the parent's mutation runs async
    // and clearing before it resolves made users think their message
    // disappeared. We clear it once the mutation is no longer in flight.
  };
  // When the parent's mutation flips from isSending=true to isSending=false
  // AND we previously dispatched, clear the textarea.
  const wasSendingRef = useRef(false);
  useEffect(() => {
    if (wasSendingRef.current && !isSending) {
      setBody("");
      setSubject("");
    }
    wasSendingRef.current = isSending;
  }, [isSending]);
  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      send();
    }
  }
  // wa.me deep-link — opens WhatsApp Web (desktop) or the WhatsApp app
  // (mobile) with the recipient prefilled, the same number we'd send to
  // via the Cloud API. Reps use this to open their inbox-style chat with
  // the lead in WhatsApp Web — best real-time experience until we wire
  // the inbound webhook + WhatsApp inbox view inline.
  const waWebHref = useMemo(() => {
    if (channel !== "whatsapp" || !lead.phone) return null;
    const digits = lead.phone.replace(/\D/g, "");
    const txt = trimmed ? `?text=${encodeURIComponent(trimmed)}` : "";
    return `https://wa.me/${digits}${txt}`;
  }, [channel, lead.phone, trimmed]);

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
        <div className="mb-2 flex items-center justify-between gap-2 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">
          <span className="flex items-start gap-2">
            <Plug className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
            {isEmail
              ? "No email sender connected — connect any SMTP and send instantly."
              : "WhatsApp Cloud API not connected — or just use the green WhatsApp Web button above."}
          </span>
          <button
            type="button"
            onClick={() =>
              isEmail
                ? onConnectEmail?.()
                : onConnectWhatsApp?.()
            }
            className={cn(
              "rounded-md px-2.5 py-1 text-[11px] font-semibold text-white",
              isEmail ? "bg-indigo-600 hover:bg-indigo-700" : "bg-emerald-600 hover:bg-emerald-700"
            )}
          >
            Connect now
          </button>
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

      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="text-[11px] text-slate-400">
          {isEmail
            ? "Cmd / Ctrl + Enter to send. Lands in their inbox via your connected sender."
            : "Cmd / Ctrl + Enter to send. Delivered via WhatsApp Cloud API."}
        </span>
        <div className="flex items-center gap-2">
          {waWebHref && (
            <a
              href={waWebHref}
              target="_blank"
              rel="noopener noreferrer"
              className="btn-secondary"
              title="Open WhatsApp Web with this chat pre-filled — your real inbox, real-time"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              WhatsApp Web
            </a>
          )}
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
    </div>
  );
}


// ─────────────────────────────────────────────────────────────────────────
// BulkComposer — replaces the per-lead conversation pane when bulkMode is on.
// One Subject + one Body, applied to every selected lead with simple merge
// substitution. The send loop is sequential (see runBulkSend) so we can show
// a live per-lead progress list and so SMTP rate limits aren't blown.

interface BulkResultRow {
  leadId: string;
  name: string;
  email: string;
  status: "queued" | "sent" | "failed";
  error?: string;
}

interface BulkComposerProps {
  count: number;
  targets: Lead[];
  allSelectedCount: number;
  results: BulkResultRow[];
  sending: boolean;
  emailConnected: boolean;
  onConnectEmail: () => void;
  onSend: (subject: string, body: string) => void;
  onCancel: () => void;
  onClose: () => void;
}

function BulkComposer({
  count,
  targets,
  allSelectedCount,
  results,
  sending,
  emailConnected,
  onConnectEmail,
  onSend,
  onCancel,
  onClose,
}: BulkComposerProps) {
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");

  const skipped = allSelectedCount - targets.length;
  const sent = results.filter((r) => r.status === "sent").length;
  const failed = results.filter((r) => r.status === "failed").length;
  const totalProgress = results.length;
  const done = sent + failed;

  const canSend =
    !sending && emailConnected && targets.length > 0 && subject.trim() && body.trim();

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-3 border-b border-slate-200 bg-white px-5 py-3.5">
        <span className="grid h-11 w-11 place-items-center rounded-full bg-indigo-100 text-indigo-700">
          <Users className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-slate-800">
            Bulk email — {count} selected
            {skipped > 0 && (
              <span className="ml-2 text-xs font-normal text-amber-600">
                ({skipped} skipped — no email on file)
              </span>
            )}
          </h2>
          <div className="mt-0.5 text-xs text-slate-500">
            One message, sent individually to each lead. Tokens like{" "}
            <code className="rounded bg-slate-100 px-1">{"{first_name}"}</code>{" "}
            and <code className="rounded bg-slate-100 px-1">{"{company}"}</code>{" "}
            are personalised per recipient.
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
          title="Exit bulk mode"
        >
          <XIcon className="h-4 w-4" />
        </button>
      </div>

      {!emailConnected && (
        <div className="mx-5 mt-3 flex items-center justify-between gap-2 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">
          <span className="flex items-start gap-2">
            <Plug className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
            No email sender connected — connect any SMTP first.
          </span>
          <button
            type="button"
            onClick={onConnectEmail}
            className="rounded-md bg-indigo-600 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-indigo-700"
          >
            Connect now
          </button>
        </div>
      )}

      {/* Composer */}
      <div className="flex flex-1 flex-col overflow-hidden p-5 pb-3">
        <input
          className="input mb-2"
          placeholder="Subject — supports {first_name}, {company}, {title}…"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          maxLength={250}
          disabled={sending}
        />
        <textarea
          className="input flex-1 min-h-[200px] resize-none leading-relaxed"
          placeholder={
            "Hi {first_name},\n\nQuick idea for {company} — wanted to see if it makes sense to chat.\n\nWorth 10 minutes this week?\n\nThanks,"
          }
          value={body}
          onChange={(e) => setBody(e.target.value)}
          maxLength={8000}
          disabled={sending}
        />
      </div>

      {/* Live progress / per-recipient status — only renders once a send started */}
      {totalProgress > 0 && (
        <div className="mx-5 mb-3 max-h-[220px] overflow-y-auto rounded-md border border-slate-200 bg-white">
          <div className="sticky top-0 flex items-center gap-3 border-b border-slate-100 bg-slate-50 px-3 py-2 text-[11px] font-medium text-slate-600">
            <span>
              {done} of {totalProgress} processed
            </span>
            {sent > 0 && (
              <span className="inline-flex items-center gap-1 text-emerald-700">
                <CheckCheck className="h-3 w-3" /> {sent} sent
              </span>
            )}
            {failed > 0 && (
              <span className="inline-flex items-center gap-1 text-rose-600">
                <AlertCircle className="h-3 w-3" /> {failed} failed
              </span>
            )}
            {sending && (
              <span className="ml-auto inline-flex items-center gap-1 text-indigo-600">
                <Loader2 className="h-3 w-3 animate-spin" /> Sending…
              </span>
            )}
          </div>
          <ul className="divide-y divide-slate-100 text-xs">
            {results.map((r) => (
              <li
                key={r.leadId}
                className="flex items-center gap-2 px-3 py-1.5"
              >
                <span className="w-4 flex-shrink-0 text-center">
                  {r.status === "sent" ? (
                    <CheckCheck className="h-3 w-3 text-emerald-600" />
                  ) : r.status === "failed" ? (
                    <AlertCircle className="h-3 w-3 text-rose-600" />
                  ) : (
                    <Loader2 className="h-3 w-3 animate-spin text-slate-400" />
                  )}
                </span>
                <span className="min-w-0 flex-1 truncate text-slate-700">
                  {r.name}
                </span>
                <span className="truncate text-[10px] text-slate-400">
                  {r.email}
                </span>
                {r.error && (
                  <span
                    className="truncate text-[10px] text-rose-600"
                    title={r.error}
                  >
                    {r.error}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Footer actions */}
      <div className="flex items-center justify-between gap-2 border-t border-slate-200 bg-white px-5 py-3">
        <span className="text-[11px] text-slate-400">
          Sends one email per lead through your connected SMTP / Resend sender.
          ~1.2 s pacing between sends.
        </span>
        <div className="flex items-center gap-2">
          {sending ? (
            <button
              type="button"
              onClick={onCancel}
              className="btn-secondary"
            >
              Stop
            </button>
          ) : null}
          <button
            type="button"
            disabled={!canSend}
            onClick={() => onSend(subject, body)}
            className={cn(
              "btn bg-indigo-600 text-white hover:bg-indigo-700",
              "disabled:cursor-not-allowed disabled:opacity-50"
            )}
          >
            {sending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Send className="h-4 w-4" />
            )}
            {sending
              ? `Sending ${done}/${totalProgress}…`
              : `Send to ${targets.length}`}
          </button>
        </div>
      </div>
    </div>
  );
}
