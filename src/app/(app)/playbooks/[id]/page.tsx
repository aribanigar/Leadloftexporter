"use client";

import { use, useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Mail, MessageSquare, Phone, Plus, Send, ShieldCheck, Sparkles, Trash2, Users } from "lucide-react";
import { api } from "@/lib/api";
import type { PipelineStage, Playbook, Template } from "@/lib/types";
import { PlaybookEnrollments } from "@/components/playbook-enrollments";

const STEP_KINDS = [
  { kind: "automated_email", label: "Automated Email", icon: Mail, color: "bg-sky-100 text-sky-700" },
  { kind: "manual_email", label: "Manual Email", icon: Mail, color: "bg-blue-100 text-blue-700" },
  { kind: "task", label: "Task", icon: MessageSquare, color: "bg-pink-100 text-pink-700" },
  { kind: "call", label: "Call", icon: Phone, color: "bg-emerald-100 text-emerald-700" },
  { kind: "automated_connect", label: "Automated Connect", icon: Send, color: "bg-indigo-100 text-indigo-700" },
  { kind: "automated_message", label: "Automated Message", icon: Send, color: "bg-indigo-100 text-indigo-700" },
  { kind: "bounceshield", label: "BounceShield", icon: ShieldCheck, color: "bg-rose-100 text-rose-700" },
  { kind: "enrich_ai", label: "Enrich AI", icon: Sparkles, color: "bg-fuchsia-100 text-fuchsia-700" },
] as const;

export default function PlaybookEditorPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const qc = useQueryClient();
  const { data: playbook } = useQuery<Playbook>({
    queryKey: ["playbook", id],
    queryFn: () => api(`/playbooks/${id}`),
  });
  const { data: templates } = useQuery<Template[]>({
    queryKey: ["templates"],
    queryFn: () => api("/templates"),
  });
  const { data: stages } = useQuery<PipelineStage[]>({
    queryKey: ["stages"],
    queryFn: () => api("/pipeline/stages"),
  });

  const [draft, setDraft] = useState<Playbook | null>(null);
  const [pickingKind, setPickingKind] = useState<number | null>(null);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (playbook && !draft) setDraft(JSON.parse(JSON.stringify(playbook)));
  }, [playbook, draft]);

  const save = useMutation({
    mutationFn: () =>
      api<Playbook>(`/playbooks/${id}`, {
        method: "PATCH",
        body: {
          name: draft?.name,
          description: draft?.description,
          is_active: draft?.is_active,
          trigger: draft?.trigger,
          daily_enrollment_limit: draft?.daily_enrollment_limit,
          track_opens: draft?.track_opens,
          contact_unverified: draft?.contact_unverified,
          eject_on_reply: draft?.eject_on_reply,
          fallback_to_email_domain: draft?.fallback_to_email_domain,
          find_phone_numbers: draft?.find_phone_numbers,
          on_positive_reply_stage: draft?.on_positive_reply_stage,
          on_negative_reply_stage: draft?.on_negative_reply_stage,
          on_no_reply_stage: draft?.on_no_reply_stage,
          steps: draft?.steps.map((s, i) => ({
            kind: s.kind,
            wait_days: s.wait_days,
            wait_hours: s.wait_hours,
            config: s.config,
            template_id: s.template_id,
            position: i,
          })),
        },
      }),
    onSuccess: (pb) => {
      qc.invalidateQueries({ queryKey: ["playbook", id] });
      qc.invalidateQueries({ queryKey: ["playbooks"] });
      setDraft(JSON.parse(JSON.stringify(pb)));
      setDirty(false);
    },
  });

  if (!draft) return <div className="p-6 text-sm text-slate-500">Loading…</div>;

  function updateDraft<K extends keyof Playbook>(key: K, value: Playbook[K]) {
    setDraft({ ...draft!, [key]: value });
    setDirty(true);
  }
  function updateStep(idx: number, patch: Partial<Playbook["steps"][number]>) {
    const steps = [...draft!.steps];
    steps[idx] = { ...steps[idx], ...patch };
    setDraft({ ...draft!, steps });
    setDirty(true);
  }
  function removeStep(idx: number) {
    setDraft({ ...draft!, steps: draft!.steps.filter((_, i) => i !== idx) });
    setDirty(true);
  }
  function insertStepAt(idx: number, kind: string) {
    const steps = [...draft!.steps];
    steps.splice(idx, 0, {
      id: `tmp-${Date.now()}`,
      position: idx,
      kind,
      wait_days: idx === 0 ? 0 : 3,
      wait_hours: 0,
      config: {},
      template_id: null,
    });
    setDraft({ ...draft!, steps });
    setDirty(true);
    setPickingKind(null);
  }

  return (
    <div className="flex h-full overflow-hidden">
      <div className="flex flex-1 flex-col overflow-y-auto p-6">
        <div className="mb-4 flex items-center gap-3">
          <input
            value={draft.name}
            onChange={(e) => updateDraft("name", e.target.value)}
            className="border-none bg-transparent text-xl font-semibold outline-none"
          />
          <label className="ml-auto flex items-center gap-2 text-sm">
            <span className="text-slate-500">Active</span>
            <input
              type="checkbox"
              checked={draft.is_active}
              onChange={(e) => updateDraft("is_active", e.target.checked)}
            />
          </label>
          <button className="btn-primary" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? "Saving…" : "Save"}
          </button>
        </div>

        <div className="mb-4 rounded-lg border border-slate-200 bg-white p-3 text-sm">
          <div className="mb-2 font-medium text-slate-500">⚡ Trigger</div>
          <select
            className="input w-60"
            value={draft.trigger}
            onChange={(e) => updateDraft("trigger", e.target.value)}
          >
            <option value="manual">Manual</option>
            <option value="on_create">On lead created</option>
            <option value="on_stage">On stage change</option>
          </select>
        </div>

        <button
          className="mb-3 flex w-full items-center justify-center gap-2 rounded-md border border-dashed border-slate-300 py-2 text-sm text-slate-500 hover:border-brand-400 hover:text-brand-700"
          onClick={() => setPickingKind(0)}
        >
          <Plus className="h-4 w-4" /> Insert step at start
        </button>

        {draft.steps.map((step, i) => {
          const def = STEP_KINDS.find((k) => k.kind === step.kind);
          const Icon = def?.icon || Mail;
          return (
            <div key={step.id || i}>
              <div className="card mb-3 p-4">
                <div className="mb-3 flex items-center gap-3">
                  <div className={`grid h-8 w-8 place-items-center rounded-md ${def?.color}`}>
                    <Icon className="h-4 w-4" />
                  </div>
                  <div>
                    <div className="font-semibold">{def?.label || step.kind}</div>
                    <div className="text-xs text-slate-500">
                      Step {i + 1} • {i === 0 ? "Runs immediately" : `Wait ${step.wait_days}d ${step.wait_hours}h`}
                    </div>
                  </div>
                  <button
                    className="ml-auto rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-rose-500"
                    onClick={() => removeStep(i)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>

                {i > 0 && (
                  <div className="mb-3 flex items-center gap-2 text-sm">
                    <span className="text-slate-500">Wait</span>
                    <input
                      type="number"
                      min={0}
                      className="input w-20"
                      value={step.wait_days}
                      onChange={(e) => updateStep(i, { wait_days: Number(e.target.value) })}
                    />
                    <span className="text-slate-500">days</span>
                    <input
                      type="number"
                      min={0}
                      className="input w-20"
                      value={step.wait_hours}
                      onChange={(e) => updateStep(i, { wait_hours: Number(e.target.value) })}
                    />
                    <span className="text-slate-500">hours</span>
                  </div>
                )}

                {(step.kind === "automated_email" || step.kind === "manual_email") && (
                  <div className="space-y-2">
                    <div>
                      <label className="label">Template</label>
                      <select
                        className="input"
                        value={step.template_id || ""}
                        onChange={(e) => updateStep(i, { template_id: e.target.value || null })}
                      >
                        <option value="">— Inline / AI —</option>
                        {templates?.filter((t) => t.channel === "email").map((t) => (
                          <option key={t.id} value={t.id}>
                            {t.name}
                          </option>
                        ))}
                      </select>
                    </div>
                    {!step.template_id && (
                      <>
                        <div>
                          <label className="label">Subject</label>
                          <input
                            className="input"
                            value={(step.config?.subject as string) || ""}
                            onChange={(e) => updateStep(i, { config: { ...step.config, subject: e.target.value } })}
                            placeholder="Quick idea for {{company}}"
                          />
                        </div>
                        <div>
                          <label className="label">Body</label>
                          <textarea
                            className="input min-h-[120px]"
                            value={(step.config?.body as string) || ""}
                            onChange={(e) => updateStep(i, { config: { ...step.config, body: e.target.value } })}
                            placeholder={"Hi {{first_name}},\n\nSaw you're {{title}} at {{company}}…"}
                          />
                        </div>
                        <label className="flex items-center gap-2 text-sm text-slate-600">
                          <input
                            type="checkbox"
                            checked={Boolean(step.config?.ai)}
                            onChange={(e) => updateStep(i, { config: { ...step.config, ai: e.target.checked } })}
                          />
                          Generate with AI per lead (uses Claude)
                        </label>
                      </>
                    )}
                  </div>
                )}

                {(step.kind === "automated_connect" || step.kind === "automated_message") && (
                  <div>
                    <label className="label">Message</label>
                    <textarea
                      className="input min-h-[100px]"
                      value={(step.config?.body as string) || ""}
                      onChange={(e) => updateStep(i, { config: { ...step.config, body: e.target.value } })}
                      placeholder="Hi {{first_name}}, I saw your work at {{company}} and wanted to connect."
                    />
                    <p className="mt-1 text-xs text-slate-500">
                      Sent via your Chrome extension at a human pace inside your own LinkedIn session.
                    </p>
                  </div>
                )}

                {(step.kind === "task" || step.kind === "call") && (
                  <div>
                    <label className="label">Title</label>
                    <input
                      className="input"
                      value={(step.config?.title as string) || ""}
                      onChange={(e) => updateStep(i, { config: { ...step.config, title: e.target.value } })}
                    />
                  </div>
                )}
              </div>

              <button
                className="mb-3 flex w-full items-center justify-center gap-2 rounded-md border border-dashed border-slate-300 py-2 text-sm text-slate-500 hover:border-brand-400 hover:text-brand-700"
                onClick={() => setPickingKind(i + 1)}
              >
                <Plus className="h-4 w-4" /> Add step
              </button>
            </div>
          );
        })}

        <PlaybookEnrollments playbookId={id} />
      </div>

      <aside className="w-80 shrink-0 border-l border-slate-200 bg-white p-4">
        <h3 className="mb-3 font-semibold">Playbook Settings</h3>
        <div className="space-y-3 text-sm">
          <div>
            <label className="label">Daily Enrollment Limit</label>
            <input
              type="number"
              className="input"
              value={draft.daily_enrollment_limit}
              onChange={(e) => updateDraft("daily_enrollment_limit", Number(e.target.value))}
            />
          </div>
          <ToggleRow
            label="Track Email Opens"
            checked={draft.track_opens}
            onChange={(v) => updateDraft("track_opens", v)}
          />
          <ToggleRow
            label="Contact Unverified Emails"
            checked={draft.contact_unverified}
            onChange={(v) => updateDraft("contact_unverified", v)}
          />
          <ToggleRow
            label="Eject on Reply"
            checked={draft.eject_on_reply}
            onChange={(v) => updateDraft("eject_on_reply", v)}
          />
          <ToggleRow
            label="Fallback to Email Domain"
            checked={draft.fallback_to_email_domain}
            onChange={(v) => updateDraft("fallback_to_email_domain", v)}
          />

          <h3 className="mt-6 mb-2 font-semibold">AI Deal Router</h3>
          <StageSelect
            label="On Positive Reply"
            stages={stages || []}
            value={draft.on_positive_reply_stage}
            onChange={(v) => updateDraft("on_positive_reply_stage", v)}
          />
          <StageSelect
            label="On Negative Reply"
            stages={stages || []}
            value={draft.on_negative_reply_stage}
            onChange={(v) => updateDraft("on_negative_reply_stage", v)}
          />
          <StageSelect
            label="On No Reply"
            stages={stages || []}
            value={draft.on_no_reply_stage}
            onChange={(v) => updateDraft("on_no_reply_stage", v)}
          />
        </div>
      </aside>

      {pickingKind !== null && (
        <KindPicker onPick={(k) => insertStepAt(pickingKind, k)} onClose={() => setPickingKind(null)} />
      )}
    </div>
  );
}

function ToggleRow({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-slate-700">{label}</span>
      <label className="relative inline-flex h-5 w-9 cursor-pointer items-center">
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          className="peer sr-only"
        />
        <span className="h-5 w-9 rounded-full bg-slate-200 peer-checked:bg-brand-500 transition" />
        <span className="absolute left-0.5 h-4 w-4 rounded-full bg-white shadow transition peer-checked:translate-x-4" />
      </label>
    </div>
  );
}

function StageSelect({
  label,
  stages,
  value,
  onChange,
}: {
  label: string;
  stages: PipelineStage[];
  value: string | null | undefined;
  onChange: (v: string | null) => void;
}) {
  return (
    <div>
      <label className="label">{label}</label>
      <select
        className="input"
        value={value || ""}
        onChange={(e) => onChange(e.target.value || null)}
      >
        <option value="">— No change —</option>
        {stages.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>
    </div>
  );
}

function KindPicker({ onPick, onClose }: { onPick: (k: string) => void; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-slate-900/40 p-4" onClick={onClose}>
      <div
        className="w-full max-w-md overflow-hidden rounded-xl bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-slate-100 px-5 py-3">
          <h3 className="font-semibold">Add Playbook Step</h3>
          <p className="text-sm text-slate-500">
            Select what kind of step you&apos;d like to add. You can customize and reorder it afterwards.
          </p>
        </div>
        <div className="divide-y divide-slate-100">
          {STEP_KINDS.map(({ kind, label, icon: Icon, color }) => (
            <button
              key={kind}
              onClick={() => onPick(kind)}
              className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-slate-50"
            >
              <div className={`grid h-9 w-9 place-items-center rounded-md ${color}`}>
                <Icon className="h-4 w-4" />
              </div>
              <span className="flex-1 text-sm font-medium">{label}</span>
              <span className="text-xs text-brand-600">Add Step</span>
            </button>
          ))}
        </div>
        <div className="border-t border-slate-100 px-5 py-3 text-right">
          <button className="btn-secondary" onClick={onClose}>
            Go Back
          </button>
        </div>
      </div>
    </div>
  );
}
