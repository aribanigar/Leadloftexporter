"use client";

import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  Linkedin,
  Send,
  Info,
  CheckCircle2,
  Loader2,
  Search,
} from "lucide-react";
import { api } from "@/lib/api";
import type { Lead, LeadList, PipelineStage } from "@/lib/types";
import { cn, initials } from "@/lib/utils";

interface BulkMessageResult {
  queued: number;
  skipped_no_linkedin: number;
  skipped_pending: number;
  total: number;
}

interface Template {
  id: string;
  name: string;
  subject?: string | null;
  body: string;
  channel?: string;
}

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

export default function MessagingPage() {
  const [message, setMessage] = useState("");
  const [stageId, setStageId] = useState<string>("");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<BulkMessageResult | null>(null);
  const [showTemplates, setShowTemplates] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

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

  const items = useMemo(() => leads?.items || [], [leads]);
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

  const withLinkedIn = useMemo(() => items.filter((l) => l.linkedin_url), [items]);
  const selectedWithLinkedIn = useMemo(
    () => withLinkedIn.filter((l) => selected.has(l.id)),
    [withLinkedIn, selected]
  );

  // Recipients = explicitly-selected leads if any, otherwise everyone with a
  // LinkedIn URL in the current stage filter.
  const usingSelection = selectedWithLinkedIn.length > 0;
  const recipientCount = usingSelection
    ? selectedWithLinkedIn.length
    : withLinkedIn.length;
  const previewLead = (usingSelection ? selectedWithLinkedIn : withLinkedIn)[0];

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
    const ids = shown.filter((l) => l.linkedin_url).map((l) => l.id);
    const allSelected = ids.every((id) => selected.has(id));
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
          lead_ids: usingSelection
            ? selectedWithLinkedIn.map((l) => l.id)
            : undefined,
        },
      }),
    onSuccess: (r) => {
      setResult(r);
      setSelected(new Set());
    },
  });

  const trimmed = message.trim();
  const canSend = trimmed.length > 0 && recipientCount > 0 && !send.isPending;

  return (
    <div className="mx-auto max-w-5xl p-6">
      <div className="mb-1 flex items-center gap-2">
        <Linkedin className="h-5 w-5 text-brand-600" />
        <h1 className="text-lg font-semibold">Bulk LinkedIn Messaging</h1>
      </div>
      <p className="mb-5 text-sm text-slate-500">
        Write one message and send it to your whole pipeline — or just the people you pick.
      </p>

      <div className="grid gap-5 lg:grid-cols-[1fr_360px]">
        {/* ---- Composer ---- */}
        <div className="card p-5">
          <div className="mb-2 flex items-center justify-between">
            <label className="label mb-0">Message</label>
            {/* Template picker — loads saved templates and drops one in */}
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
            placeholder={"Hi {first_name}, I came across your profile and wanted to connect…"}
            value={message}
            onChange={(e) => {
              setMessage(e.target.value);
              setResult(null);
            }}
            maxLength={8000}
          />
          <div className="mt-1 flex items-center justify-between text-xs text-slate-400">
            <span>Tags are filled in per person when each message is sent.</span>
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

          <div className="mt-4 flex gap-2 rounded-md bg-slate-50 p-3 text-xs text-slate-600">
            <Info className="mt-0.5 h-4 w-4 flex-shrink-0 text-slate-400" />
            <span>
              Messages are queued and sent gradually (a few minutes apart) from
              inside your browser by the LeadCaptura extension, so keep a LinkedIn
              tab open. Pacing protects your account. You can only message
              1st-degree connections.
            </span>
          </div>

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
                : `Send to ${recipientCount} ${
                    usingSelection ? "selected" : "lead" + (recipientCount === 1 ? "" : "s")
                  }`}
            </button>
          </div>

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

        {/* ---- Recipients ---- */}
        <div className="card flex flex-col p-4">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-sm font-medium">Recipients</span>
            <button
              type="button"
              onClick={selectAllShown}
              className="text-xs font-medium text-brand-600 hover:text-brand-700"
            >
              {shown.filter((l) => l.linkedin_url).every((l) => selected.has(l.id)) &&
              shown.some((l) => l.linkedin_url)
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
                <span className="font-semibold text-slate-700">
                  {selectedWithLinkedIn.length}
                </span>{" "}
                selected
              </>
            ) : (
              <>
                Will message{" "}
                <span className="font-semibold text-slate-700">
                  {withLinkedIn.length}
                </span>{" "}
                lead{withLinkedIn.length === 1 ? "" : "s"} with LinkedIn
              </>
            )}
          </p>

          <div className="-mx-1 max-h-[460px] flex-1 overflow-y-auto px-1">
            {shown.length === 0 && (
              <div className="py-6 text-center text-sm text-slate-400">No leads.</div>
            )}
            {shown.map((l) => {
              const hasLi = !!l.linkedin_url;
              const on = selected.has(l.id);
              return (
                <button
                  key={l.id}
                  type="button"
                  disabled={!hasLi}
                  onClick={() => toggle(l.id)}
                  className={cn(
                    "mb-0.5 flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left",
                    !hasLi
                      ? "cursor-not-allowed opacity-50"
                      : on
                      ? "bg-brand-50"
                      : "hover:bg-slate-50"
                  )}
                  title={hasLi ? "" : "No LinkedIn URL — can't be messaged"}
                >
                  <span
                    className={cn(
                      "grid h-4 w-4 flex-shrink-0 place-items-center rounded border text-[10px]",
                      on
                        ? "border-brand-600 bg-brand-600 text-white"
                        : "border-slate-300 bg-white"
                    )}
                  >
                    {on ? "✓" : ""}
                  </span>
                  <span className="grid h-7 w-7 flex-shrink-0 place-items-center rounded-full bg-slate-100 text-[10px] font-semibold uppercase text-slate-500">
                    {initials(l.full_name || l.email)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">
                      {l.full_name || "Unknown"}
                    </span>
                    <span className="block truncate text-xs text-slate-400">
                      {l.company?.name || l.title || "—"}
                    </span>
                  </span>
                  {hasLi ? (
                    <Linkedin className="h-3.5 w-3.5 flex-shrink-0 text-brand-500" />
                  ) : (
                    <span className="flex-shrink-0 text-[10px] text-slate-400">
                      no LI
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
