"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Inbox, Mail } from "lucide-react";
import { api } from "@/lib/api";
import { fmtRelative } from "@/lib/utils";

interface Thread {
  id: string;
  subject: string | null;
  lead_id: string | null;
  last_message_at: string | null;
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

export default function InboxPage() {
  const [active, setActive] = useState<string | null>(null);
  const { data: threads } = useQuery<Thread[]>({
    queryKey: ["inbox-threads"],
    queryFn: () => api("/inbox/threads"),
  });
  const { data: detail } = useQuery<ThreadDetail | null>({
    queryKey: ["inbox-thread", active],
    queryFn: () => (active ? api(`/inbox/threads/${active}`) : Promise.resolve(null)),
    enabled: !!active,
  });

  return (
    <div className="flex h-full">
      <div className="flex w-80 flex-col border-r border-slate-200 bg-white">
        <div className="flex items-center gap-2 border-b border-slate-100 px-4 py-3">
          <Inbox className="h-4 w-4 text-slate-500" />
          <h1 className="text-sm font-semibold">Inbox</h1>
        </div>
        <div className="flex-1 overflow-y-auto">
          {threads?.length === 0 && (
            <div className="p-8 text-center text-sm text-slate-500">
              No conversations yet. Replies and outbound emails will land here.
            </div>
          )}
          {threads?.map((t) => (
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
      <div className="flex flex-1 flex-col">
        {!detail && (
          <div className="grid flex-1 place-items-center text-slate-400">
            <div className="text-center">
              <Mail className="mx-auto h-10 w-10 text-slate-300" />
              <p className="mt-2 text-sm">Select a conversation</p>
            </div>
          </div>
        )}
        {detail && (
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
                      <span className="font-medium text-slate-700">{m.direction === "outbound" ? "You" : m.from_address}</span> →{" "}
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
