"use client";

/**
 * New-campaign wizard — 4 steps in one page.
 *
 *  1. Recipients — pick a stage or all-with-email; live count
 *  2. Senders    — multi-select connected mailboxes for round-robin rotation
 *  3. Compose    — subject + body with merge-tag chips + live preview
 *  4. Schedule   — batch size + seconds-between-sends + warmup toggle + Send
 *
 * Creates the campaign, then immediately /campaigns/{id}/start, then
 * redirects to /campaigns/{id} where the live progress + halt controls live.
 */

import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  Mail,
  ChevronRight,
  ChevronLeft,
  Users,
  Plug,
  PenSquare,
  Settings,
  Send,
  Loader2,
  CheckCircle2,
  AlertCircle,
  Sparkles,
} from "lucide-react";
import { api } from "@/lib/api";
import type { Lead, LeadList, PipelineStage } from "@/lib/types";
import { cn } from "@/lib/utils";

interface Sender {
  id: string;
  provider: string;
  label: string | null;
  from_address: string | null;
  status: string;
  warmup: {
    enabled: boolean;
    daily_cap_today: number;
    sent_today: number;
    day: number;
    ramp_days: number;
    daily_cap_ceiling: number;
  };
}

type Step = 1 | 2 | 3 | 4;
const TOKENS = ["{first_name}", "{last_name}", "{full_name}", "{title}", "{company}", "{email}"];

export default function NewCampaignPage() {
  const router = useRouter();
  const [step, setStep] = useState<Step>(1);

  // Step 1 — recipients
  const [stageId, setStageId] = useState<string>("");

  // Step 2 — senders
  const [senderIds, setSenderIds] = useState<string[]>([]);

  // Step 3 — content
  const [name, setName] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");

  // Step 4 — throttle
  const [batchSize, setBatchSize] = useState(8);
  const [secondsBetween, setSecondsBetween] = useState(30);
  const [warmupEnabled, setWarmupEnabled] = useState(true);

  const { data: stages } = useQuery<PipelineStage[]>({
    queryKey: ["stages"],
    queryFn: () => api("/pipeline/stages"),
  });
  const { data: leads } = useQuery<LeadList>({
    queryKey: ["leads-for-campaign", stageId],
    queryFn: () =>
      api(`/leads?page_size=500${stageId ? `&stage_id=${stageId}` : ""}`),
  });
  const { data: senders } = useQuery<Sender[]>({
    queryKey: ["campaign-senders"],
    queryFn: () => api("/campaigns/senders/list"),
  });

  const eligible = useMemo<Lead[]>(
    () =>
      (leads?.items || []).filter((l) => (l.email || "").trim().length > 0),
    [leads]
  );
  const previewLead = eligible[0];

  const create = useMutation<{ id: string }, Error, void>({
    mutationFn: () =>
      api("/campaigns", {
        method: "POST",
        body: {
          name: name.trim() || subject.trim() || "Untitled campaign",
          subject: subject.trim(),
          body_html: body.trim().replace(/\n/g, "<br/>"),
          body_text: body.trim(),
          stage_id: stageId || undefined,
          sender_account_ids: senderIds,
          batch_size: batchSize,
          seconds_between_sends: secondsBetween,
          warmup_enabled: warmupEnabled,
        },
      }),
  });

  const start = useMutation<{ id: string }, Error, string>({
    mutationFn: (id) => api(`/campaigns/${id}/start`, { method: "POST" }),
  });

  async function launch() {
    try {
      const created = await create.mutateAsync();
      await start.mutateAsync(created.id);
      router.push(`/campaigns/${created.id}`);
    } catch {
      /* error shown in banner */
    }
  }

  const stepValid: Record<Step, boolean> = {
    1: eligible.length > 0,
    2: (senders || []).filter((s) => s.status === "active").length > 0,
    3: subject.trim().length > 0 && body.trim().length > 0,
    4: batchSize > 0 && secondsBetween >= 0,
  };

  return (
    <div className="mx-auto max-w-5xl p-6">
      <div className="mb-1 flex items-center gap-2">
        <Mail className="h-5 w-5 text-indigo-600" />
        <h1 className="text-lg font-semibold">New Campaign</h1>
      </div>
      <p className="mb-5 text-sm text-slate-500">
        Send the same message to many leads — each one gets an INDIVIDUAL
        email (no BCC blast), rotated across your connected mailboxes with
        warmup pacing.
      </p>

      {/* Stepper */}
      <ol className="mb-6 flex items-center gap-2 text-xs">
        {(
          [
            { n: 1, label: "Recipients", Icon: Users },
            { n: 2, label: "Senders", Icon: Plug },
            { n: 3, label: "Compose", Icon: PenSquare },
            { n: 4, label: "Throttle & Send", Icon: Settings },
          ] as const
        ).map((s, i) => {
          const active = step === s.n;
          const done = step > s.n;
          return (
            <li key={s.n} className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setStep(s.n as Step)}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full px-3 py-1 font-medium",
                  active
                    ? "bg-indigo-600 text-white"
                    : done
                    ? "bg-emerald-50 text-emerald-700"
                    : "bg-slate-100 text-slate-500"
                )}
              >
                <s.Icon className="h-3.5 w-3.5" />
                {s.label}
              </button>
              {i < 3 && <ChevronRight className="h-3 w-3 text-slate-300" />}
            </li>
          );
        })}
      </ol>

      <div className="card p-5">
        {step === 1 && (
          <RecipientsStep
            stages={stages || []}
            stageId={stageId}
            setStageId={setStageId}
            eligibleCount={eligible.length}
            totalLoaded={leads?.items.length || 0}
          />
        )}
        {step === 2 && (
          <SendersStep
            senders={senders || []}
            senderIds={senderIds}
            setSenderIds={setSenderIds}
          />
        )}
        {step === 3 && (
          <ComposeStep
            name={name}
            setName={setName}
            subject={subject}
            setSubject={setSubject}
            body={body}
            setBody={setBody}
            previewLead={previewLead}
          />
        )}
        {step === 4 && (
          <ThrottleStep
            batchSize={batchSize}
            setBatchSize={setBatchSize}
            secondsBetween={secondsBetween}
            setSecondsBetween={setSecondsBetween}
            warmupEnabled={warmupEnabled}
            setWarmupEnabled={setWarmupEnabled}
            recipientCount={eligible.length}
            senderCount={senderIds.length || (senders || []).filter((s) => s.status === "active").length}
          />
        )}

        {(create.isError || start.isError) && (
          <div className="mt-4 flex items-start gap-2 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
            <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
            {create.error?.message || start.error?.message || "Failed."}
          </div>
        )}

        {/* Footer nav */}
        <div className="mt-5 flex items-center justify-between border-t border-slate-100 pt-4">
          <button
            className="btn-secondary disabled:opacity-50"
            disabled={step === 1}
            onClick={() => setStep((s) => (s - 1) as Step)}
          >
            <ChevronLeft className="h-4 w-4" />
            Back
          </button>
          {step < 4 ? (
            <button
              className="btn-primary disabled:opacity-50"
              disabled={!stepValid[step]}
              onClick={() => setStep((s) => (s + 1) as Step)}
            >
              Next
              <ChevronRight className="h-4 w-4" />
            </button>
          ) : (
            <button
              className="btn bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50"
              disabled={
                !stepValid[3] ||
                !stepValid[4] ||
                eligible.length === 0 ||
                create.isPending ||
                start.isPending
              }
              onClick={launch}
            >
              {create.isPending || start.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Send className="h-4 w-4" />
              )}
              Start campaign — send to {eligible.length}{" "}
              recipient{eligible.length === 1 ? "" : "s"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
// Step components

function RecipientsStep({
  stages,
  stageId,
  setStageId,
  eligibleCount,
  totalLoaded,
}: {
  stages: PipelineStage[];
  stageId: string;
  setStageId: (s: string) => void;
  eligibleCount: number;
  totalLoaded: number;
}) {
  return (
    <div>
      <h2 className="mb-3 flex items-center gap-1.5 text-sm font-semibold">
        <Users className="h-4 w-4 text-indigo-600" />
        Who gets this campaign?
      </h2>
      <label className="label">Pipeline stage</label>
      <select
        className="input max-w-md"
        value={stageId}
        onChange={(e) => setStageId(e.target.value)}
      >
        <option value="">Every lead with an email address</option>
        {stages.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>
      <div className="mt-4 rounded-md border border-indigo-200 bg-indigo-50/60 p-3 text-sm text-indigo-900">
        <strong>{eligibleCount.toLocaleString()}</strong>{" "}
        lead{eligibleCount === 1 ? "" : "s"} will receive this campaign
        {totalLoaded > 0 && eligibleCount < totalLoaded && (
          <span className="text-indigo-700/70">
            {" "}
            ({totalLoaded - eligibleCount} excluded — no email on file)
          </span>
        )}
        . Addresses already on your suppression list are skipped
        automatically at send time.
      </div>
    </div>
  );
}

function SendersStep({
  senders,
  senderIds,
  setSenderIds,
}: {
  senders: Sender[];
  senderIds: string[];
  setSenderIds: (ids: string[]) => void;
}) {
  function toggle(id: string) {
    setSenderIds(
      senderIds.includes(id)
        ? senderIds.filter((s) => s !== id)
        : [...senderIds, id]
    );
  }
  const active = senders.filter((s) => s.status === "active");
  return (
    <div>
      <h2 className="mb-3 flex items-center gap-1.5 text-sm font-semibold">
        <Plug className="h-4 w-4 text-indigo-600" />
        Which mailboxes should send?
      </h2>
      {active.length === 0 ? (
        <div className="rounded-md border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
          <p className="font-medium">No email senders connected.</p>
          <p className="mt-1 text-xs">
            Connect at least one SMTP, Resend, SendGrid, or Gmail account so
            the campaign has something to dispatch from.
          </p>
          <Link
            href="/settings/email"
            className="mt-2 inline-block font-medium underline"
          >
            Connect a sender →
          </Link>
        </div>
      ) : (
        <>
          <p className="mb-3 text-xs text-slate-500">
            Pick one or more — the campaign rotates evenly across them. Leave
            empty to use every active sender.
          </p>
          <ul className="grid gap-2 sm:grid-cols-2">
            {active.map((s) => {
              const on = senderIds.includes(s.id) || senderIds.length === 0;
              const ratio = Math.min(
                100,
                Math.round((s.warmup.sent_today / Math.max(1, s.warmup.daily_cap_today)) * 100)
              );
              return (
                <li
                  key={s.id}
                  onClick={() => toggle(s.id)}
                  className={cn(
                    "cursor-pointer rounded-md border p-3 transition-colors",
                    on
                      ? "border-indigo-300 bg-indigo-50/60"
                      : "border-slate-200 bg-white hover:border-slate-300"
                  )}
                >
                  <div className="flex items-center gap-2">
                    <span
                      className={cn(
                        "grid h-4 w-4 place-items-center rounded border text-[10px]",
                        on
                          ? "border-indigo-600 bg-indigo-600 text-white"
                          : "border-slate-300 bg-white"
                      )}
                    >
                      {on ? "✓" : ""}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-semibold">
                        {s.from_address || s.label || s.provider}
                      </div>
                      <div className="truncate text-[11px] uppercase tracking-wide text-slate-400">
                        {s.provider}
                      </div>
                    </div>
                  </div>
                  <div className="mt-2 flex items-center gap-2 text-[11px] text-slate-600">
                    <span>
                      Warmup day {s.warmup.day} / {s.warmup.ramp_days}
                    </span>
                    <span className="text-slate-400">·</span>
                    <span>
                      {s.warmup.sent_today} / {s.warmup.daily_cap_today} today
                    </span>
                  </div>
                  <div className="mt-1 h-1 overflow-hidden rounded-full bg-slate-200">
                    <div
                      className={cn(
                        "h-full transition-all",
                        ratio >= 100 ? "bg-amber-500" : "bg-emerald-500"
                      )}
                      style={{ width: `${ratio}%` }}
                    />
                  </div>
                </li>
              );
            })}
          </ul>
          <p className="mt-3 text-[11px] text-slate-500">
            {senderIds.length === 0
              ? `Auto-rotating across all ${active.length} active sender${active.length === 1 ? "" : "s"}.`
              : `${senderIds.length} of ${active.length} selected.`}
          </p>
        </>
      )}
    </div>
  );
}

function ComposeStep({
  name,
  setName,
  subject,
  setSubject,
  body,
  setBody,
  previewLead,
}: {
  name: string;
  setName: (s: string) => void;
  subject: string;
  setSubject: (s: string) => void;
  body: string;
  setBody: (s: string) => void;
  previewLead?: Lead;
}) {
  function insertToken(token: string) {
    setBody(body + token);
  }
  function preview(s: string): string {
    if (!previewLead) return s;
    const first =
      previewLead.first_name ||
      (previewLead.full_name || "").split(" ")[0] ||
      "there";
    const map: Record<string, string> = {
      "{first_name}": first,
      "{last_name}": previewLead.last_name || "",
      "{full_name}": previewLead.full_name || first,
      "{title}": previewLead.title || "",
      "{company}": previewLead.company?.name || "",
      "{email}": previewLead.email || "",
    };
    return Object.entries(map).reduce(
      (acc, [k, v]) => acc.split(k).join(v),
      s
    );
  }
  return (
    <div>
      <h2 className="mb-3 flex items-center gap-1.5 text-sm font-semibold">
        <PenSquare className="h-4 w-4 text-indigo-600" />
        Compose
      </h2>
      <label className="label">Campaign name (internal)</label>
      <input
        className="input"
        placeholder="Q3 launch announcement"
        value={name}
        onChange={(e) => setName(e.target.value)}
        maxLength={240}
      />
      <label className="label mt-3">Subject</label>
      <input
        className="input"
        placeholder="Quick idea for {company}"
        value={subject}
        onChange={(e) => setSubject(e.target.value)}
        maxLength={500}
      />
      <div className="mt-3 flex items-center justify-between">
        <label className="label mb-0">Body</label>
        <div className="flex flex-wrap gap-1">
          {TOKENS.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => insertToken(t)}
              className="rounded-md border border-slate-200 bg-slate-50 px-2 py-0.5 font-mono text-[11px] text-slate-600 hover:border-indigo-300 hover:text-indigo-700"
            >
              {t}
            </button>
          ))}
        </div>
      </div>
      <textarea
        className="input mt-1 min-h-[180px] resize-y leading-relaxed"
        placeholder="Hi {first_name},&#10;&#10;…"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        maxLength={20000}
      />
      {body.trim() && previewLead && (
        <div className="mt-3">
          <div className="label">
            Preview for {previewLead.full_name || "first recipient"}
          </div>
          <div className="rounded-md border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
            <div className="mb-2 font-semibold">{preview(subject)}</div>
            <div className="whitespace-pre-wrap">{preview(body)}</div>
          </div>
        </div>
      )}
    </div>
  );
}

function ThrottleStep({
  batchSize,
  setBatchSize,
  secondsBetween,
  setSecondsBetween,
  warmupEnabled,
  setWarmupEnabled,
  recipientCount,
  senderCount,
}: {
  batchSize: number;
  setBatchSize: (n: number) => void;
  secondsBetween: number;
  setSecondsBetween: (n: number) => void;
  warmupEnabled: boolean;
  setWarmupEnabled: (b: boolean) => void;
  recipientCount: number;
  senderCount: number;
}) {
  // Crude ETA: total recipients ÷ batch size × seconds between ticks.
  // Assumes one tick per minute on average.
  const eta = Math.ceil((recipientCount / Math.max(1, batchSize)) * Math.max(60, secondsBetween) / 60);
  return (
    <div>
      <h2 className="mb-3 flex items-center gap-1.5 text-sm font-semibold">
        <Settings className="h-4 w-4 text-indigo-600" />
        Throttle & warmup
      </h2>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className="label">Batch size — emails per tick</label>
          <input
            type="number"
            className="input"
            value={batchSize}
            onChange={(e) =>
              setBatchSize(Math.max(1, Math.min(50, parseInt(e.target.value || "1", 10))))
            }
            min={1}
            max={50}
          />
          <p className="mt-1 text-[11px] text-slate-500">
            Each tick (~1 min) advances by this many emails. Lower = slower
            + safer.
          </p>
        </div>
        <div>
          <label className="label">Seconds between sends (within a tick)</label>
          <input
            type="number"
            className="input"
            value={secondsBetween}
            onChange={(e) =>
              setSecondsBetween(Math.max(0, Math.min(3600, parseInt(e.target.value || "0", 10))))
            }
            min={0}
            max={3600}
          />
          <p className="mt-1 text-[11px] text-slate-500">
            Spreads the batch evenly inside each tick.
          </p>
        </div>
      </div>

      <label className="mt-4 flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={warmupEnabled}
          onChange={(e) => setWarmupEnabled(e.target.checked)}
          className="h-4 w-4 rounded border-slate-300 text-indigo-600"
        />
        <Sparkles className="h-4 w-4 text-indigo-600" />
        <span>
          Respect sender warmup — gradually ramp daily volume per mailbox
          (day 1 = 20 emails, doubles every ~3 days, capped per sender)
        </span>
      </label>

      <div className="mt-5 rounded-md border border-emerald-200 bg-emerald-50/60 p-3 text-sm text-emerald-900">
        <div className="flex items-center gap-2 font-semibold">
          <CheckCircle2 className="h-4 w-4" /> Ready to launch
        </div>
        <ul className="mt-1 list-disc pl-5 text-xs text-emerald-900/80">
          <li>
            {recipientCount.toLocaleString()} recipient
            {recipientCount === 1 ? "" : "s"}
          </li>
          <li>
            {senderCount} sender mailbox{senderCount === 1 ? "" : "es"} rotating
          </li>
          <li>
            Estimated total send time: ~{eta} minute{eta === 1 ? "" : "s"}
          </li>
          <li>Pause and halt at any time from the campaign page.</li>
        </ul>
      </div>
    </div>
  );
}
