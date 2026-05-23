"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Linkedin, Send, Info, CheckCircle2, Loader2 } from "lucide-react";
import { api } from "@/lib/api";
import type { LeadList, PipelineStage } from "@/lib/types";

interface BulkMessageResult {
  queued: number;
  skipped_no_linkedin: number;
  skipped_pending: number;
  total: number;
}

export default function MessagingPage() {
  const [message, setMessage] = useState("");
  const [stageId, setStageId] = useState<string>("");
  const [result, setResult] = useState<BulkMessageResult | null>(null);

  const { data: stages } = useQuery<PipelineStage[]>({
    queryKey: ["stages"],
    queryFn: () => api("/pipeline/stages"),
  });

  // Pull the pipeline so we can show exactly how many leads will be messaged
  // (only those with a LinkedIn URL can receive a message).
  const { data: leads } = useQuery<LeadList>({
    queryKey: ["messaging-leads", stageId],
    queryFn: () =>
      api(
        `/leads?page_size=500${stageId ? `&stage_id=${stageId}` : ""}`
      ),
  });

  const { withLinkedIn, total } = useMemo(() => {
    const items = leads?.items || [];
    return {
      total: items.length,
      withLinkedIn: items.filter((l) => !!l.linkedin_url).length,
    };
  }, [leads]);

  const send = useMutation<BulkMessageResult, Error, void>({
    mutationFn: () =>
      api("/leads/bulk-message", {
        method: "POST",
        body: { message: message.trim(), stage_id: stageId || undefined },
      }),
    onSuccess: (r) => setResult(r),
  });

  const trimmed = message.trim();
  const canSend = trimmed.length > 0 && withLinkedIn > 0 && !send.isPending;

  return (
    <div className="mx-auto max-w-2xl p-6">
      <div className="mb-1 flex items-center gap-2">
        <Linkedin className="h-5 w-5 text-brand-600" />
        <h1 className="text-lg font-semibold">Bulk LinkedIn Messaging</h1>
      </div>
      <p className="mb-5 text-sm text-slate-500">
        Write one message and send it to everyone in your pipeline at once.
      </p>

      <div className="card p-5">
        {/* Audience */}
        <label className="label">Send to</label>
        <select
          className="input mb-1"
          value={stageId}
          onChange={(e) => {
            setStageId(e.target.value);
            setResult(null);
          }}
        >
          <option value="">All leads in pipeline</option>
          {(stages || []).map((s) => (
            <option key={s.id} value={s.id}>
              Stage: {s.name}
            </option>
          ))}
        </select>
        <p className="mb-4 text-xs text-slate-500">
          <span className="font-semibold text-slate-700">{withLinkedIn}</span> of{" "}
          {total} leads have a LinkedIn profile and will be messaged.
          {total - withLinkedIn > 0 && (
            <> {total - withLinkedIn} without a LinkedIn URL will be skipped.</>
          )}
        </p>

        {/* Message */}
        <label className="label">Message</label>
        <textarea
          className="input min-h-[160px] resize-y leading-relaxed"
          placeholder={"Hi! I came across your profile and wanted to connect…"}
          value={message}
          onChange={(e) => {
            setMessage(e.target.value);
            setResult(null);
          }}
          maxLength={8000}
        />
        <div className="mt-1 flex items-center justify-between text-xs text-slate-400">
          <span>Sent from your own LinkedIn session via the browser extension.</span>
          <span>{trimmed.length}/8000</span>
        </div>

        {/* How it works */}
        <div className="mt-4 flex gap-2 rounded-md bg-slate-50 p-3 text-xs text-slate-600">
          <Info className="mt-0.5 h-4 w-4 flex-shrink-0 text-slate-400" />
          <span>
            Messages are queued and sent gradually (a few minutes apart) from
            inside your browser by the LeadCaptura extension, so keep a LinkedIn
            tab open. Pacing protects your account — LinkedIn restricts accounts
            that message too fast. You can only message 1st-degree connections.
          </span>
        </div>

        {/* Action */}
        <div className="mt-5 flex items-center justify-end gap-3">
          {send.isError && (
            <span className="mr-auto text-xs text-red-600">
              {send.error?.message || "Failed to queue messages."}
            </span>
          )}
          <button
            className="btn-primary disabled:cursor-not-allowed disabled:opacity-50"
            disabled={!canSend}
            onClick={() => send.mutate()}
          >
            {send.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Send className="h-4 w-4" />
            )}
            {send.isPending
              ? "Queueing…"
              : `Send to ${withLinkedIn} lead${withLinkedIn === 1 ? "" : "s"}`}
          </button>
        </div>

        {/* Result */}
        {result && (
          <div className="mt-4 flex items-start gap-2 rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">
            <CheckCircle2 className="mt-0.5 h-4 w-4 flex-shrink-0 text-emerald-600" />
            <div>
              <div className="font-medium">
                {result.queued} message{result.queued === 1 ? "" : "s"} queued.
              </div>
              <div className="text-xs text-emerald-700">
                {result.skipped_no_linkedin > 0 && (
                  <>{result.skipped_no_linkedin} skipped (no LinkedIn URL). </>
                )}
                {result.skipped_pending > 0 && (
                  <>{result.skipped_pending} already had a pending message. </>
                )}
                Keep a LinkedIn tab open so the extension can deliver them.
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
