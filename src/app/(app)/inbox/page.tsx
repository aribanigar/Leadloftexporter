"use client";

import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Inbox, Mail, ChevronRight, ChevronDown, AtSign, Layers, Loader2 } from "lucide-react";
import { api } from "@/lib/api";
import { fmtRelative } from "@/lib/utils";

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
  const [active, setActive] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection>({ kind: "all" });
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  // Mailboxes — graceful degradation if the endpoint is not yet deployed (404/error).
  const { data: mbResp } = useQuery<MailboxesResp>({
    queryKey: ["inbox-mailboxes"],
    queryFn: () => api("/inbox/mailboxes"),
    refetchInterval: 20000,
    retry: false,
  });

  // Build the threads query key + path from the current selection.
  const threadsPath = useMemo(() => {
    const params = new URLSearchParams();
    if (selection.kind === "mailbox") params.set("mailbox", selection.address);
    if (selection.kind === "campaign") {
      params.set("mailbox", selection.address);
      params.set("campaign_id", selection.campaignId);
    }
    const qs = params.toString();
    return `/inbox/threads${qs ? `?${qs}` : ""}`;
  }, [selection]);

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

  const mailboxes = mbResp?.mailboxes ?? [];

  const headerLabel =
    selection.kind === "all"
      ? "All conversations"
      : selection.kind === "mailbox"
      ? selection.label
      : selection.label;

  return (
    <div className="flex h-full">
      {/* ── Pane 1: Mailbox → Campaigns tree ─────────────────────────── */}
      <div className="flex w-64 flex-col border-r border-slate-200 bg-slate-50">
        <div className="flex items-center gap-2 border-b border-slate-200 px-4 py-3">
          <Inbox className="h-4 w-4 text-slate-500" />
          <h1 className="text-sm font-semibold">Mailboxes</h1>
        </div>
        <div className="flex-1 overflow-y-auto py-2">
          {/* All conversations */}
          <button
            onClick={() => { setSelection({ kind: "all" }); setActive(null); }}
            className={`flex w-full items-center justify-between px-4 py-2 text-left text-sm transition hover:bg-slate-100 ${
              selection.kind === "all" ? "bg-brand-50 font-medium text-brand-700" : "text-slate-700"
            }`}
          >
            <span className="flex items-center gap-2">
              <Layers className="h-4 w-4 text-slate-400" />
              All conversations
            </span>
            {mbResp?.total_threads ? (
              <span className="text-xs text-slate-400">{mbResp.total_threads}</span>
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
            const mbSelected =
              selection.kind === "mailbox" && selection.address === addr;
            return (
              <div key={mb.id} className="mt-0.5">
                <div
                  className={`flex w-full items-center gap-1 px-2 py-2 text-left text-sm transition hover:bg-slate-100 ${
                    mbSelected ? "bg-brand-50" : ""
                  }`}
                >
                  {/* expand/collapse chevron (only if it has campaigns) */}
                  <button
                    onClick={() =>
                      setExpanded((e) => ({ ...e, [mb.id]: !isOpen }))
                    }
                    className="grid h-5 w-5 flex-shrink-0 place-items-center rounded text-slate-400 hover:bg-slate-200"
                    aria-label={isOpen ? "Collapse" : "Expand"}
                  >
                    {mb.campaigns.length > 0 ? (
                      isOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />
                    ) : (
                      <span className="h-3.5 w-3.5" />
                    )}
                  </button>
                  {/* mailbox label — clicking filters threads to this mailbox */}
                  <button
                    onClick={() => {
                      setSelection({ kind: "mailbox", address: addr, label: addr || mb.label || mb.provider });
                      setActive(null);
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
                      className={`truncate ${mbSelected ? "font-medium text-brand-700" : "text-slate-700"}`}
                      title={addr}
                    >
                      {addr || mb.label || mb.provider}
                    </span>
                    {mb.thread_count > 0 && (
                      <span className="ml-auto flex-shrink-0 text-xs text-slate-400">
                        {mb.thread_count}
                      </span>
                    )}
                  </button>
                </div>

                {/* Campaigns under this mailbox */}
                {isOpen && mb.campaigns.length > 0 && (
                  <div className="ml-7 border-l border-slate-200">
                    {mb.campaigns.map((c) => {
                      const cSelected =
                        selection.kind === "campaign" &&
                        selection.campaignId === c.id &&
                        selection.address === addr;
                      return (
                        <button
                          key={c.id}
                          onClick={() => {
                            setSelection({
                              kind: "campaign",
                              address: addr,
                              campaignId: c.id,
                              label: c.name,
                            });
                            setActive(null);
                          }}
                          className={`flex w-full items-center justify-between gap-2 py-1.5 pl-3 pr-2 text-left text-[13px] transition hover:bg-slate-100 ${
                            cSelected ? "bg-brand-50 font-medium text-brand-700" : "text-slate-600"
                          }`}
                        >
                          <span className="truncate" title={c.name}>{c.name}</span>
                          <span className="flex-shrink-0 text-[11px] text-slate-400">
                            {c.recipients}
                          </span>
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
      <div className="flex w-80 flex-col border-r border-slate-200 bg-white">
        <div className="flex items-center gap-2 border-b border-slate-100 px-4 py-3">
          <Mail className="h-4 w-4 text-slate-500" />
          <h2 className="truncate text-sm font-semibold" title={headerLabel}>{headerLabel}</h2>
        </div>
        <div className="flex-1 overflow-y-auto">
          {threadsLoading && (
            <div className="flex items-center justify-center p-8">
              <Loader2 className="h-5 w-5 animate-spin text-slate-400" />
            </div>
          )}
          {!threadsLoading && threads?.length === 0 && (
            <div className="p-8 text-center text-sm text-slate-500">
              No conversations here yet. Replies and outbound emails will land here.
            </div>
          )}
          {!threadsLoading && threads?.map((t) => (
            <button
              key={t.id}
              onClick={() => setActive(t.id)}
              className={`block w-full border-b border-slate-100 px-4 py-3 text-left text-sm hover:bg-slate-50 ${
                active === t.id ? "bg-brand-50" : ""
              }`}
            >
              <div className="truncate font-medium">{t.subject || "(no subject)"}</div>
              <div className="text-xs text-slate-500">{fmtRelative(t.last_message_at)}</div>
            </button>
          ))}
        </div>
      </div>

      {/* ── Pane 3: Thread detail ────────────────────────────────────── */}
      <div className="flex flex-1 flex-col">
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
            <div className="border-b border-slate-200 bg-white px-6 py-3">
              <h2 className="text-base font-semibold">{detail.thread.subject || "(no subject)"}</h2>
            </div>
            <div className="flex-1 space-y-4 overflow-y-auto bg-slate-50 p-6">
              {detail.messages.map((m) => (
                <div
                  key={m.id}
                  className={`rounded-lg border bg-white p-4 shadow-soft ${
                    m.direction === "outbound" ? "border-brand-100" : "border-slate-200"
                  }`}
                >
                  <div className="mb-2 flex items-center justify-between text-xs text-slate-500">
                    <span>
                      <span className="font-medium text-slate-700">{m.from_address}</span> →{" "}
                      {m.direction === "outbound" ? m.to_address : "you"}
                    </span>
                    <span>{fmtRelative(m.sent_at || m.created_at)}</span>
                  </div>
                  {m.body_html ? (
                    <div className="prose prose-sm max-w-none" dangerouslySetInnerHTML={{ __html: m.body_html }} />
                  ) : (
                    <pre className="whitespace-pre-wrap font-sans text-sm">{m.body_text || ""}</pre>
                  )}
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
