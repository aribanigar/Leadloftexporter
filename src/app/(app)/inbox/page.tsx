"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import {
  Inbox,
  Mail,
  ChevronRight,
  ChevronDown,
  ChevronLeft,
  AtSign,
  Layers,
  Loader2,
  Trash2,
  AlertTriangle,
} from "lucide-react";
import { api } from "@/lib/api";
import { cn, fmtRelative } from "@/lib/utils";

interface Thread {
  id: string;
  subject: string | null;
  lead_id: string | null;
  last_message_at: string | null;
}

interface MailboxCampaign {
  id: string;
  name: string;
  recipients: number;
}

interface Mailbox {
  id: string;
  provider: string;
  label: string | null;
  address: string | null;
  status: string;
  thread_count: number;
  campaigns: MailboxCampaign[];
}

interface MailboxesResp {
  mailboxes: Mailbox[];
  total_threads: number;
}

interface ThreadDetail {
  thread: { id: string; subject: string | null; lead_id: string | null };
  messages: Array<{
    id: string;
    direction: string;
    from_address: string;
    to_address: string;
    subject: string | null;
    body_html: string | null;
    body_text: string | null;
    status: string;
    sent_at: string | null;
    opened_at: string | null;
    replied_at: string | null;
    created_at: string;
  }>;
}

// Selection: either "all", a mailbox (by address), or a campaign within a mailbox.
type Selection =
  | { kind: "all" }
  | { kind: "mailbox"; address: string; label: string }
  | { kind: "campaign"; address: string; campaignId: string; label: string };

function providerColor(provider: string): string {
  const map: Record<string, string> = {
    gmail: "#ea4335",
    smtp: "#0a66c2",
    resend: "#6b3600",
    sendgrid: "#1a73e8",
  };
  return map[provider] || "#13677b";
}

export default function InboxPage() {
  const qc = useQueryClient();
  const [active, setActive] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection>({ kind: "all" });
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  // Mobile drill-down: which pane is in front (mailboxes ↔ threads). Detail
  // takes over whenever `active` is set.
  const [mobilePane, setMobilePane] = useState<"boxes" | "threads">("boxes");
  const [confirmClear, setConfirmClear] = useState(false);

  // Mailboxes — graceful degradation if the endpoint is not yet deployed (404/error).
  const { data: mbResp } = useQuery<MailboxesResp>({
    queryKey: ["inbox-mailboxes"],
    queryFn: () => api("/inbox/mailboxes"),
    refetchInterval: 20000,
    retry: false,
  });

  // Build the threads query key + path from the current selection.
  const threadsParams = useMemo(() => {
    const params = new URLSearchParams();
    if (selection.kind === "mailbox") params.set("mailbox", selection.address);
    if (selection.kind === "campaign") {
      params.set("mailbox", selection.address);
      params.set("campaign_id", selection.campaignId);
    }
    return params.toString();
  }, [selection]);
  const threadsPath = `/inbox/threads${threadsParams ? `?${threadsParams}` : ""}`;

  const { data: threads, isLoading: threadsLoading } = useQuery<Thread[]>({
    queryKey: ["inbox-threads", threadsPath],
    queryFn: () => api(threadsPath),
    refetchInterval: 20000,
  });

  const { data: detail, isLoading: detailLoading } = useQuery<ThreadDetail | null>({
    queryKey: ["inbox-thread", active],
    queryFn: () => (active ? api(`/inbox/threads/${active}`) : Promise.resolve(null)),
    enabled: !!active,
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["inbox-threads"] });
    qc.invalidateQueries({ queryKey: ["inbox-mailboxes"] });
  };

  const deleteThread = useMutation({
    mutationFn: (id: string) => api(`/inbox/threads/${id}`, { method: "DELETE" }),
    onSuccess: (_d, id) => {
      if (active === id) setActive(null);
      invalidate();
    },
  });

  const clearThreads = useMutation({
    mutationFn: () => api(`/inbox/threads${threadsParams ? `?${threadsParams}` : ""}`, { method: "DELETE" }),
    onSuccess: () => {
      setActive(null);
      setConfirmClear(false);
      invalidate();
    },
  });

  const mailboxes = mbResp?.mailboxes ?? [];

  const headerLabel =
    selection.kind === "all" ? "All conversations" : selection.label;

  const openSelection = (s: Selection) => {
    setSelection(s);
    setActive(null);
    setMobilePane("threads");
  };

  const threadCount = threads?.length ?? 0;

  return (
    <div className="flex h-full">
      {/* ── Pane 1: Mailbox → Campaigns tree ─────────────────────────── */}
      <div
        className={cn(
          "w-full flex-col border-r border-slate-200 bg-slate-50 lg:flex lg:w-64",
          active || mobilePane !== "boxes" ? "hidden lg:flex" : "flex"
        )}
      >
        <div className="flex items-center gap-2 border-b border-slate-200 bg-gradient-to-r from-emerald-50 to-white px-4 py-3">
          <Inbox className="h-4 w-4 text-emerald-600" />
          <h1 className="text-sm font-semibold text-slate-800">Mailboxes</h1>
        </div>
        <div className="flex-1 overflow-y-auto py-2">
          {/* All conversations */}
          <button
            onClick={() => openSelection({ kind: "all" })}
            className={`flex w-full items-center justify-between px-4 py-2.5 text-left text-sm transition hover:bg-slate-100 ${
              selection.kind === "all" ? "bg-emerald-50 font-medium text-emerald-700" : "text-slate-700"
            }`}
          >
            <span className="flex items-center gap-2">
              <Layers className="h-4 w-4 text-emerald-500" />
              All conversations
            </span>
            {mbResp?.total_threads ? (
              <span className="rounded-full bg-slate-200 px-2 py-0.5 text-[11px] font-medium text-slate-600">{mbResp.total_threads}</span>
            ) : null}
          </button>

          {mailboxes.length === 0 && (
            <div className="px-4 py-6 text-center text-xs text-slate-400">
              No connected mailboxes yet. Connect one in Settings → Senders.
            </div>
          )}

          {mailboxes.map((mb) => {
            const addr = mb.address || "";
            const isOpen = expanded[mb.id] ?? false;
            const mbSelected = selection.kind === "mailbox" && selection.address === addr;
            return (
              <div key={mb.id} className="mt-0.5">
                <div
                  className={`flex w-full items-center gap-1 px-2 py-2 text-left text-sm transition hover:bg-slate-100 ${
                    mbSelected ? "bg-emerald-50" : ""
                  }`}
                >
                  <button
                    onClick={() => setExpanded((e) => ({ ...e, [mb.id]: !isOpen }))}
                    className="grid h-6 w-6 flex-shrink-0 place-items-center rounded text-slate-400 hover:bg-slate-200"
                    aria-label={isOpen ? "Collapse" : "Expand"}
                  >
                    {mb.campaigns.length > 0 ? (
                      isOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />
                    ) : (
                      <span className="h-3.5 w-3.5" />
                    )}
                  </button>
                  <button
                    onClick={() => {
                      openSelection({ kind: "mailbox", address: addr, label: addr || mb.label || mb.provider });
                      if (mb.campaigns.length) setExpanded((e) => ({ ...e, [mb.id]: true }));
                    }}
                    className="flex min-w-0 flex-1 items-center gap-2"
                  >
                    <span
                      className="grid h-5 w-5 flex-shrink-0 place-items-center rounded text-white"
                      style={{ background: providerColor(mb.provider) }}
                    >
                      <AtSign className="h-3 w-3" />
                    </span>
                    <span
                      className={`truncate ${mbSelected ? "font-medium text-emerald-700" : "text-slate-700"}`}
                      title={addr}
                    >
                      {addr || mb.label || mb.provider}
                    </span>
                    {mb.thread_count > 0 && (
                      <span className="ml-auto flex-shrink-0 text-xs text-slate-400">{mb.thread_count}</span>
                    )}
                  </button>
                </div>

                {isOpen && mb.campaigns.length > 0 && (
                  <div className="ml-7 border-l border-slate-200">
                    {mb.campaigns.map((c) => {
                      const cSelected =
                        selection.kind === "campaign" && selection.campaignId === c.id && selection.address === addr;
                      return (
                        <button
                          key={c.id}
                          onClick={() => openSelection({ kind: "campaign", address: addr, campaignId: c.id, label: c.name })}
                          className={`flex w-full items-center justify-between gap-2 py-1.5 pl-3 pr-2 text-left text-[13px] transition hover:bg-slate-100 ${
                            cSelected ? "bg-emerald-50 font-medium text-emerald-700" : "text-slate-600"
                          }`}
                        >
                          <span className="truncate" title={c.name}>{c.name}</span>
                          <span className="flex-shrink-0 text-[11px] text-slate-400">{c.recipients}</span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Pane 2: Thread list ──────────────────────────────────────── */}
      <div
        className={cn(
          "w-full flex-col border-r border-slate-200 bg-white lg:flex lg:w-80",
          active ? "hidden lg:flex" : mobilePane === "threads" ? "flex" : "hidden lg:flex"
        )}
      >
        <div className="flex items-center gap-2 border-b border-slate-100 px-3 py-2.5 sm:px-4">
          {/* mobile back to mailboxes */}
          <button
            onClick={() => setMobilePane("boxes")}
            className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-slate-500 hover:bg-slate-100 lg:hidden"
            aria-label="Back to mailboxes"
          >
            <ChevronLeft className="h-5 w-5" />
          </button>
          <Mail className="hidden h-4 w-4 text-slate-500 lg:block" />
          <h2 className="min-w-0 flex-1 truncate text-sm font-semibold" title={headerLabel}>
            {headerLabel}
          </h2>
          {threadCount > 0 && (
            <button
              onClick={() => setConfirmClear(true)}
              className="flex shrink-0 items-center gap-1 rounded-md border border-rose-200 bg-rose-50 px-2 py-1 text-[12px] font-medium text-rose-600 hover:bg-rose-100"
              title="Clear all conversations in this view"
            >
              <Trash2 className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Clear all</span>
            </button>
          )}
        </div>
        <div className="flex-1 overflow-y-auto">
          {threadsLoading && (
            <div className="flex items-center justify-center p-8">
              <Loader2 className="h-5 w-5 animate-spin text-slate-400" />
            </div>
          )}
          {!threadsLoading && threadCount === 0 && (
            <div className="p-8 text-center text-sm text-slate-500">
              No conversations here yet. Replies and outbound emails will land here.
            </div>
          )}
          {!threadsLoading &&
            threads?.map((t) => (
              <div
                key={t.id}
                className={`group flex items-center gap-1 border-b border-slate-100 hover:bg-slate-50 ${
                  active === t.id ? "bg-emerald-50" : ""
                }`}
              >
                <button
                  onClick={() => setActive(t.id)}
                  className="min-w-0 flex-1 px-3 py-3 text-left text-sm sm:px-4"
                >
                  <div className="truncate font-medium text-slate-800">{t.subject || "(no subject)"}</div>
                  <div className="text-xs text-slate-500">{fmtRelative(t.last_message_at)}</div>
                </button>
                <button
                  onClick={() => deleteThread.mutate(t.id)}
                  disabled={deleteThread.isPending}
                  className="mr-2 grid h-8 w-8 shrink-0 place-items-center rounded-md text-slate-300 hover:bg-rose-50 hover:text-rose-500 sm:opacity-0 sm:group-hover:opacity-100"
                  title="Delete conversation"
                  aria-label="Delete conversation"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            ))}
        </div>
      </div>

      {/* ── Pane 3: Thread detail ────────────────────────────────────── */}
      <div className={cn("flex-1 flex-col", active ? "flex" : "hidden lg:flex")}>
        {!active && (
          <div className="grid flex-1 place-items-center text-slate-400">
            <div className="text-center">
              <Mail className="mx-auto h-10 w-10 text-slate-300" />
              <p className="mt-2 text-sm">Select a conversation</p>
            </div>
          </div>
        )}
        {active && detailLoading && (
          <div className="grid flex-1 place-items-center">
            <Loader2 className="h-6 w-6 animate-spin text-slate-400" />
          </div>
        )}
        {active && !detailLoading && detail && (
          <>
            <div className="flex items-center gap-2 border-b border-slate-200 bg-white px-3 py-3 sm:px-6">
              {/* mobile back to thread list */}
              <button
                onClick={() => setActive(null)}
                className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-slate-500 hover:bg-slate-100 lg:hidden"
                aria-label="Back to conversations"
              >
                <ChevronLeft className="h-5 w-5" />
              </button>
              <h2 className="min-w-0 flex-1 truncate text-base font-semibold">
                {detail.thread.subject || "(no subject)"}
              </h2>
              <button
                onClick={() => deleteThread.mutate(detail.thread.id)}
                disabled={deleteThread.isPending}
                className="flex shrink-0 items-center gap-1 rounded-md border border-rose-200 bg-rose-50 px-2.5 py-1.5 text-[12px] font-medium text-rose-600 hover:bg-rose-100"
                title="Delete this conversation"
              >
                <Trash2 className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">Delete</span>
              </button>
            </div>
            <div className="flex-1 space-y-4 overflow-y-auto bg-slate-50 p-3 sm:p-6">
              {detail.messages.map((m) => (
                <div
                  key={m.id}
                  className={`rounded-lg border bg-white p-4 shadow-soft ${
                    m.direction === "outbound" ? "border-emerald-100" : "border-slate-200"
                  }`}
                >
                  <div className="mb-2 flex items-center justify-between gap-2 text-xs text-slate-500">
                    <span className="min-w-0 truncate">
                      <span className="font-medium text-slate-700">{m.from_address}</span> →{" "}
                      {m.direction === "outbound" ? m.to_address : "you"}
                    </span>
                    <span className="shrink-0">{fmtRelative(m.sent_at || m.created_at)}</span>
                  </div>
                  {m.body_html ? (
                    <div className="prose prose-sm max-w-none break-words" dangerouslySetInnerHTML={{ __html: m.body_html }} />
                  ) : (
                    <pre className="whitespace-pre-wrap break-words font-sans text-sm">{m.body_text || ""}</pre>
                  )}
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      {/* ── Clear-all confirm ────────────────────────────────────────── */}
      {confirmClear && (
        <div className="fixed inset-0 z-[300] grid place-items-center bg-slate-900/40 p-4" onClick={() => setConfirmClear(false)}>
          <div className="w-full max-w-sm rounded-2xl bg-white p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="mb-3 flex items-center gap-2">
              <span className="grid h-9 w-9 place-items-center rounded-full bg-rose-100 text-rose-600">
                <AlertTriangle className="h-5 w-5" />
              </span>
              <h3 className="text-base font-semibold text-slate-900">Clear conversations?</h3>
            </div>
            <p className="text-sm text-slate-600">
              This permanently deletes{" "}
              <span className="font-semibold">
                {selection.kind === "all" ? "all conversations" : `the conversations in “${headerLabel}”`}
              </span>{" "}
              and their messages. This cannot be undone.
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={() => setConfirmClear(false)}
                className="rounded-lg border border-slate-200 px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50"
              >
                Cancel
              </button>
              <button
                onClick={() => clearThreads.mutate()}
                disabled={clearThreads.isPending}
                className="inline-flex items-center gap-1.5 rounded-lg bg-rose-600 px-3 py-2 text-sm font-semibold text-white hover:bg-rose-700 disabled:opacity-60"
              >
                {clearThreads.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                Clear all
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
