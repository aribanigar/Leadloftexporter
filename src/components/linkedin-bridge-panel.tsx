"use client";

/* LinkedIn-in-CRM side panel.
 *
 * Renders a panel inside the CRM that asks the user's Chrome extension to
 * fetch a fresh snapshot of a lead's LinkedIn profile (headline, about,
 * experience, contact info) and stream it back. Backed by the
 * /linkedin-bridge endpoints — see api/app/api/v1/linkedin_bridge.py for
 * the request/poll protocol.
 *
 * Three states the panel can be in:
 *   1. Extension not paired / offline → install + sign-in CTA.
 *   2. Snapshot requested, waiting → spinner + "Open a LinkedIn tab" hint.
 *   3. Snapshot delivered → structured profile sections + Quick Reply.
 *
 * The component is intentionally light-weight: it never iframes LinkedIn
 * (X-Frame-Options blocks that). It also never embeds CSP-violating
 * content from the snapshot — everything is rendered as plain text by
 * the CRM's own components.
 */

import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  Linkedin,
  Loader2,
  Send,
  RefreshCw,
  ExternalLink,
  AlertTriangle,
  Sparkles,
  CheckCircle2,
} from "lucide-react";
import { api } from "@/lib/api";

interface BridgeStatus {
  available: boolean;
  last_seen?: string | null;
  reason?: string | null;
}

interface SnapshotResult {
  id: string;
  status: "queued" | "claimed" | "done" | "failed" | "skipped" | string;
  claimed_at?: string | null;
  completed_at?: string | null;
  linkedin_url?: string | null;
  snapshot?: Record<string, unknown> | null;
  error?: string | null;
}

interface Props {
  leadId: string;
  linkedinUrl: string | null | undefined;
}

export function LinkedInBridgePanel({ leadId, linkedinUrl }: Props) {
  const [jobId, setJobId] = useState<string | null>(null);
  const [reply, setReply] = useState("");
  const [replyDone, setReplyDone] = useState(false);

  const { data: status } = useQuery<BridgeStatus>({
    queryKey: ["linkedin-bridge-status"],
    queryFn: () => api("/linkedin-bridge/status"),
    refetchInterval: 30000,
  });

  const requestSnapshot = useMutation<{ id: string; status: string }, Error>({
    mutationFn: () =>
      api("/linkedin-bridge/snapshot", {
        method: "POST",
        body: { lead_id: leadId, surface: "profile" },
      }),
    onSuccess: (r) => {
      setJobId(r.id);
      setReplyDone(false);
    },
  });

  const { data: snapshot } = useQuery<SnapshotResult>({
    queryKey: ["linkedin-bridge-snapshot", jobId],
    queryFn: () => api(`/linkedin-bridge/snapshot/${jobId}`),
    enabled: !!jobId,
    refetchInterval: (query) => {
      const d = query.state.data as SnapshotResult | undefined;
      if (!d) return 2000;
      if (d.status === "done" || d.status === "failed" || d.status === "skipped") {
        return false;
      }
      return 2000;
    },
  });

  // Auto-request a snapshot on first mount when the bridge is available and
  // we don't already have one — saves the user a click.
  useEffect(() => {
    if (!jobId && status?.available && linkedinUrl && !requestSnapshot.isPending) {
      requestSnapshot.mutate();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status?.available, linkedinUrl]);

  const sendReply = useMutation<{ id: string }, Error>({
    mutationFn: () =>
      api("/linkedin-bridge/send-message", {
        method: "POST",
        body: { lead_id: leadId, body: reply.trim() },
      }),
    onSuccess: () => {
      setReplyDone(true);
      setReply("");
    },
  });

  // ---- 0. No LinkedIn URL on the lead ---------------------------------
  if (!linkedinUrl) {
    return (
      <div className="card p-4">
        <div className="mb-1 flex items-center gap-2 text-sm font-semibold text-slate-700">
          <Linkedin className="h-4 w-4 text-brand-600" /> LinkedIn
        </div>
        <p className="text-sm text-slate-500">
          This lead has no LinkedIn URL on file. Save one from the LeadCaptura
          extension to open the LinkedIn panel here.
        </p>
      </div>
    );
  }

  // ---- 1. Extension not paired ----------------------------------------
  if (status && !status.available) {
    return (
      <div className="card p-4">
        <div className="mb-1 flex items-center gap-2 text-sm font-semibold text-slate-700">
          <Linkedin className="h-4 w-4 text-brand-600" /> LinkedIn
        </div>
        <div className="mt-2 flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
          <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
          <div>
            <strong>Pair the LeadCaptura extension</strong> to view this
            person&apos;s LinkedIn profile inside the CRM in real time. Install
            it from Settings → API Keys, sign in on a LinkedIn tab, then
            refresh this page.
            <div className="mt-2">
              <a
                href={linkedinUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 underline"
              >
                Open in linkedin.com <ExternalLink className="h-3 w-3" />
              </a>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ---- 2. Requested, waiting on extension -----------------------------
  const isWaiting =
    !snapshot || snapshot.status === "queued" || snapshot.status === "claimed";

  // ---- 3. Snapshot delivered ------------------------------------------
  const snap = (snapshot?.snapshot || {}) as Record<string, unknown>;
  const headline = (snap.headline as string) || (snap.title as string) || "";
  const about = (snap.about as string) || "";
  const location = (snap.location as string) || "";
  const company = (snap.company as string) || "";
  const email = (snap.email as string) || "";
  const phone = (snap.phone as string) || "";
  const experience = (snap.experience as Array<Record<string, string>>) || [];

  return (
    <div className="card p-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-semibold text-slate-700">
          <Linkedin className="h-4 w-4 text-brand-600" />
          <span>LinkedIn — live</span>
          {snapshot?.status === "done" && (
            <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium uppercase text-emerald-700">
              fresh
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <button
            className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-50"
            disabled={requestSnapshot.isPending}
            onClick={() => requestSnapshot.mutate()}
            title="Refresh snapshot via extension"
          >
            <RefreshCw
              className={`h-3.5 w-3.5 ${requestSnapshot.isPending ? "animate-spin" : ""}`}
            />
          </button>
          <a
            href={linkedinUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
            title="Open in LinkedIn"
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        </div>
      </div>

      {isWaiting && (
        <div className="rounded-md border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
          <div className="flex items-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin text-slate-400" />
            <span>
              Fetching from LinkedIn via your extension… keep a LinkedIn tab
              open with Autopilot ON.
            </span>
          </div>
        </div>
      )}

      {snapshot?.status === "done" && (
        <div className="space-y-3">
          {headline && (
            <div className="text-sm font-medium text-slate-800">{headline}</div>
          )}
          {(location || company) && (
            <div className="text-xs text-slate-500">
              {company}
              {company && location ? " · " : ""}
              {location}
            </div>
          )}
          {about && (
            <div>
              <div className="mb-0.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                About
              </div>
              <p className="whitespace-pre-wrap text-sm text-slate-700">
                {about.length > 600 ? about.slice(0, 600) + "…" : about}
              </p>
            </div>
          )}
          {(email || phone) && (
            <div>
              <div className="mb-0.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                Contact info
              </div>
              <div className="text-xs text-slate-600">
                {email && <div>{email}</div>}
                {phone && <div>{phone}</div>}
              </div>
            </div>
          )}
          {experience.length > 0 && (
            <div>
              <div className="mb-0.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                Experience
              </div>
              <ul className="space-y-1 text-xs text-slate-700">
                {experience.slice(0, 4).map((e, i) => (
                  <li key={i} className="truncate">
                    <span className="font-medium">{e.title || ""}</span>
                    {e.company ? ` — ${e.company}` : ""}
                    {e.duration ? (
                      <span className="text-slate-400"> · {e.duration}</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {snapshot?.status === "failed" && (
        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-xs text-red-700">
          {snapshot.error || "Snapshot failed. Try refreshing."}
        </div>
      )}

      {/* Quick reply — always available so the user can fire off a message
          even before the snapshot arrives. */}
      <div className="mt-4 border-t border-slate-100 pt-3">
        <div className="mb-1.5 flex items-center justify-between">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
            Quick reply on LinkedIn
          </span>
          <Sparkles className="h-3 w-3 text-slate-300" />
        </div>
        <textarea
          className="input min-h-[70px] resize-y text-sm"
          placeholder="Hi {first_name}, picking up where we left off…"
          value={reply}
          onChange={(e) => {
            setReply(e.target.value);
            setReplyDone(false);
          }}
          maxLength={2000}
        />
        <div className="mt-2 flex items-center justify-between">
          <span className="text-[11px] text-slate-400">
            Delivered via the extension at a human pace.
          </span>
          <button
            className="btn bg-brand-600 text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={!reply.trim() || sendReply.isPending}
            onClick={() => sendReply.mutate()}
          >
            {sendReply.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Send className="h-3.5 w-3.5" />
            )}
            Send
          </button>
        </div>
        {sendReply.isError && (
          <p className="mt-1 text-xs text-red-600">
            {sendReply.error?.message || "Could not queue message."}
          </p>
        )}
        {replyDone && (
          <p className="mt-1 flex items-center gap-1 text-xs text-emerald-700">
            <CheckCircle2 className="h-3 w-3" /> Queued — sending on your next active
            LinkedIn tab.
          </p>
        )}
      </div>
    </div>
  );
}
