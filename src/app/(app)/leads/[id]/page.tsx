"use client";

import { use, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  Linkedin,
  Mail,
  Phone,
  Send,
  Star,
  StickyNote,
  PhoneCall,
  Plus,
  CheckCircle2,
  Circle,
} from "lucide-react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import type { Lead, PipelineStage } from "@/lib/types";
import { fmtDate, initials } from "@/lib/utils";
import { EnrollPlaybookModal } from "@/components/enroll-playbook-modal";

type ComposerTab = "email" | "linkedin" | "note" | "call";

interface TimelineItem {
  kind: "activity" | "email" | "note" | "call";
  id: string;
  at: string;
  type?: string;
  payload?: Record<string, unknown>;
  direction?: "inbound" | "outbound";
  from?: string;
  to?: string;
  subject?: string | null;
  preview?: string;
  status?: string;
  body?: string;
  outcome?: string;
  duration_seconds?: number;
  notes?: string | null;
}

interface LeadTask {
  id: string;
  title: string;
  type: string;
  status: string;
  due_at: string | null;
  completed_at: string | null;
  notes: string | null;
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d`;
  return fmtDate(iso);
}

export default function LeadDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const qc = useQueryClient();
  const { user, workspace } = useAuth();
  const searchParams = useSearchParams();
  const tabParam = searchParams.get("tab");
  const initialTab: ComposerTab =
    tabParam === "linkedin" || tabParam === "note" || tabParam === "call"
      ? tabParam
      : "email";

  const { data: lead } = useQuery<Lead>({
    queryKey: ["lead", id],
    queryFn: () => api(`/leads/${id}`),
  });
  const { data: stages } = useQuery<PipelineStage[]>({
    queryKey: ["stages"],
    queryFn: () => api("/pipeline/stages"),
  });
  const { data: timeline } = useQuery<TimelineItem[]>({
    queryKey: ["lead", id, "timeline"],
    queryFn: () => api(`/leads/${id}/timeline`),
  });
  const { data: tasks } = useQuery<LeadTask[]>({
    queryKey: ["lead", id, "tasks"],
    queryFn: () => api(`/leads/${id}/tasks`),
  });

  const setStage = useMutation({
    mutationFn: (stage_id: string) =>
      api(`/leads/${id}`, { method: "PATCH", body: { stage_id } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["lead", id] });
      qc.invalidateQueries({ queryKey: ["lead", id, "timeline"] });
    },
  });

  // Generic field patcher used by the inline-editable Lead Info / Company tabs.
  const patchLead = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api(`/leads/${id}`, { method: "PATCH", body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["lead", id] }),
  });

  const stageById = useMemo(() => {
    const m = new Map<string, PipelineStage>();
    stages?.forEach((s) => m.set(s.id, s));
    return m;
  }, [stages]);
  const stage = lead?.stage_id ? stageById.get(lead.stage_id) : undefined;
  const [enrolling, setEnrolling] = useState(false);

  if (!lead) {
    return <div className="p-6 text-sm text-slate-500">Loading…</div>;
  }

  return (
    <div className="flex h-full overflow-hidden">
      <aside className="w-[380px] shrink-0 overflow-auto border-r border-slate-200 bg-white">
        <div className="border-b border-slate-200 px-4 py-3">
          <Link
            href="/prospecting"
            className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-800"
          >
            <ArrowLeft className="h-3.5 w-3.5" /> Back to Prospecting
          </Link>
        </div>

        <div className="px-4 py-4">
          <div className="flex items-start gap-3">
            <button
              className="text-slate-300 hover:text-amber-400"
              title="Star this lead"
            >
              <Star className="h-4 w-4" />
            </button>
            {lead.avatar_url ? (
              <img
                src={lead.avatar_url}
                alt=""
                className="h-12 w-12 rounded-full object-cover"
              />
            ) : (
              <div className="grid h-12 w-12 place-items-center rounded-full bg-slate-200 text-sm font-semibold uppercase text-slate-600">
                {initials(lead.full_name)}
              </div>
            )}
            <div className="min-w-0 flex-1">
              <h1 className="truncate text-base font-semibold">
                {lead.full_name || "—"}
              </h1>
              <p className="truncate text-xs text-slate-500">
                {lead.title ||
                  (lead.headline ? lead.headline.split("|")[0] : "—")}
                {lead.company?.name ? ` @${lead.company.name}` : ""}
              </p>
            </div>
          </div>

          <div className="mt-3 flex items-center gap-1">
            <ActionBtn label="Email" disabled={!lead.email}>
              <Mail className="h-4 w-4" />
            </ActionBtn>
            <ActionBtn label="Call" disabled={!lead.phone}>
              <Phone className="h-4 w-4" />
            </ActionBtn>
            <ActionBtn label="LinkedIn" href={lead.linkedin_url || undefined}>
              <Linkedin className="h-4 w-4" />
            </ActionBtn>
          </div>

          <button
            className="btn-primary mt-3 w-full"
            onClick={() => setEnrolling(true)}
          >
            <Send className="h-4 w-4" /> Add to Playbook
          </button>
          {enrolling && (
            <EnrollPlaybookModal
              leadId={id}
              leadName={lead.full_name}
              onClose={() => setEnrolling(false)}
            />
          )}

          <div className="mt-4 rounded-md border border-slate-200 p-3">
            <div className="flex items-center justify-between text-xs text-slate-500">
              <span>Stage</span>
              <span>{fmtDate(lead.created_at)}</span>
            </div>
            <select
              className="input mt-2 w-full"
              value={lead.stage_id || ""}
              onChange={(e) => setStage.mutate(e.target.value)}
            >
              {stages?.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
            {stage && (
              <span
                className="pill mt-2 inline-block"
                style={{
                  backgroundColor: (stage.color || "#e2e8f0") + "22",
                  color: stage.color || "#475569",
                }}
              >
                {stage.name}
              </span>
            )}
          </div>

          <TaskList leadId={id} tasks={tasks || []} />

          <InfoTabs
            lead={lead}
            onSaveField={(body) => patchLead.mutate(body)}
            onSaveCustom={(key, value) =>
              patchLead.mutate({
                custom: { ...(lead.custom || {}), [key]: value },
              })
            }
          />
        </div>
      </aside>

      <main className="flex flex-1 flex-col overflow-hidden">
        <Composer
          leadId={id}
          lead={lead}
          fromEmail={user?.email || ""}
          workspaceName={workspace?.name || "Workspace"}
          initialTab={initialTab}
        />
        <Timeline items={timeline || []} />
      </main>
    </div>
  );
}

function ActionBtn({
  children,
  label,
  disabled,
  href,
}: {
  children: React.ReactNode;
  label: string;
  disabled?: boolean;
  href?: string;
}) {
  const base =
    "inline-flex h-8 w-8 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-500 hover:text-slate-800";
  if (href) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className={base}
        title={label}
      >
        {children}
      </a>
    );
  }
  return (
    <button
      className={`${base} ${disabled ? "cursor-not-allowed opacity-40" : ""}`}
      title={label}
      disabled={disabled}
    >
      {children}
    </button>
  );
}

// Tabbed Lead Info / Company panel, mirroring LeadLoft's clean inline-editable
// fields. Core lead columns save directly; everything else lands in lead.custom.
function InfoTabs({
  lead,
  onSaveField,
  onSaveCustom,
}: {
  lead: Lead;
  onSaveField: (body: Record<string, unknown>) => void;
  onSaveCustom: (key: string, value: string) => void;
}) {
  const [tab, setTab] = useState<"info" | "company">("info");
  const custom = (lead.custom || {}) as Record<string, unknown>;
  const cs = (k: string) => {
    const v = custom[k];
    return v == null ? "" : String(v);
  };

  return (
    <div className="mt-4 border-t border-slate-200 pt-3">
      <div className="mb-2 flex gap-4 border-b border-slate-100">
        <TabButton active={tab === "info"} onClick={() => setTab("info")}>
          Lead Info
        </TabButton>
        <TabButton active={tab === "company"} onClick={() => setTab("company")}>
          Company
        </TabButton>
      </div>

      {tab === "info" ? (
        <div>
          <EditableField label="Email" value={lead.email} onSave={(v) => onSaveField({ email: v })} />
          <EditableField label="Phone" value={lead.phone} onSave={(v) => onSaveField({ phone: v })} />
          <EditableField label="LinkedIn URL" value={lead.linkedin_url} link onSave={(v) => onSaveField({ linkedin_url: v })} />
          <EditableField label="Location" value={lead.location} onSave={(v) => onSaveField({ location: v })} />
          <EditableField label="Title" value={lead.title} onSave={(v) => onSaveField({ title: v })} />
          <EditableField label="Segment" value={cs("segment")} onSave={(v) => onSaveCustom("segment", v)} />
          <EditableField label="UTM Campaign" value={cs("utm_campaign")} onSave={(v) => onSaveCustom("utm_campaign", v)} />
          <EditableField label="UTM Medium" value={cs("utm_medium")} onSave={(v) => onSaveCustom("utm_medium", v)} />
          <EditableField label="UTM Source" value={cs("utm_source")} onSave={(v) => onSaveCustom("utm_source", v)} />
          <EditableField label="Google Click ID" value={cs("gclid")} onSave={(v) => onSaveCustom("gclid", v)} />
          <EditableField label="Facebook Click ID" value={cs("fbclid")} onSave={(v) => onSaveCustom("fbclid", v)} />
        </div>
      ) : (
        <div>
          <EditableField label="Company Name" value={lead.company?.name || cs("company_name")} onSave={(v) => onSaveCustom("company_name", v)} />
          <EditableField label="Website" value={lead.company?.website || cs("company_website")} link onSave={(v) => onSaveCustom("company_website", v)} />
          <EditableField label="Description" value={lead.company?.description || cs("company_description")} onSave={(v) => onSaveCustom("company_description", v)} />
          <EditableField label="Phone Number" value={lead.company?.phone || cs("company_phone")} onSave={(v) => onSaveCustom("company_phone", v)} />
          <EditableField label="Headcount" value={lead.company?.headcount != null ? String(lead.company.headcount) : cs("company_headcount")} onSave={(v) => onSaveCustom("company_headcount", v)} />
          <EditableField label="Industry" value={cs("company_industry")} onSave={(v) => onSaveCustom("company_industry", v)} />
          <EditableField label="Location" value={cs("company_location")} onSave={(v) => onSaveCustom("company_location", v)} />
          <EditableField label="LinkedIn URL" value={cs("company_linkedin")} link onSave={(v) => onSaveCustom("company_linkedin", v)} />
          <EditableField label="Twitter URL" value={cs("company_twitter")} link onSave={(v) => onSaveCustom("company_twitter", v)} />
          <EditableField label="Revenue" value={cs("company_revenue")} onSave={(v) => onSaveCustom("company_revenue", v)} />
          <EditableField label="Technologies" value={cs("company_technologies")} onSave={(v) => onSaveCustom("company_technologies", v)} />
          <EditableField label="Type" value={cs("company_type")} onSave={(v) => onSaveCustom("company_type", v)} />
        </div>
      )}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={
        "relative pb-2 text-sm font-medium transition-colors " +
        (active
          ? "text-brand-700 after:absolute after:inset-x-0 after:-bottom-px after:h-0.5 after:rounded-full after:bg-brand-600"
          : "text-slate-500 hover:text-slate-700")
      }
    >
      {children}
    </button>
  );
}

// Inline-editable field: shows the value (or a muted placeholder); click to edit,
// Enter or blur saves, Escape cancels. Matches LeadLoft's "click anywhere to edit".
function EditableField({
  label,
  value,
  link,
  onSave,
}: {
  label: string;
  value?: string | null;
  link?: boolean;
  onSave: (value: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value || "");

  function commit() {
    setEditing(false);
    const trimmed = draft.trim();
    if (trimmed !== (value || "")) onSave(trimmed);
  }

  return (
    <div className="mb-2.5 text-sm">
      <div className="text-xs text-slate-500">{label}</div>
      {editing ? (
        <input
          autoFocus
          className="input mt-0.5 w-full py-1 text-sm"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") {
              setDraft(value || "");
              setEditing(false);
            }
          }}
        />
      ) : value ? (
        <div className="flex items-center justify-between gap-2">
          {link ? (
            <a
              href={value.startsWith("http") ? value : `https://${value}`}
              target="_blank"
              rel="noopener noreferrer"
              className="break-all text-brand-600 hover:underline"
            >
              {value}
            </a>
          ) : (
            <span className="break-all text-slate-800">{value}</span>
          )}
          <button
            onClick={() => {
              setDraft(value || "");
              setEditing(true);
            }}
            className="shrink-0 text-xs text-slate-400 hover:text-brand-600"
          >
            Edit
          </button>
        </div>
      ) : (
        <button
          onClick={() => {
            setDraft("");
            setEditing(true);
          }}
          className="text-slate-400 hover:text-slate-600"
        >
          Please input {label}
        </button>
      )}
    </div>
  );
}

function TaskList({ leadId, tasks }: { leadId: string; tasks: LeadTask[] }) {
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");

  const create = useMutation({
    mutationFn: (t: string) =>
      api(`/leads/${leadId}/tasks`, { method: "POST", body: { title: t } }),
    onSuccess: () => {
      setTitle("");
      setAdding(false);
      qc.invalidateQueries({ queryKey: ["lead", leadId, "tasks"] });
    },
  });
  const toggle = useMutation({
    mutationFn: ({ id, done }: { id: string; done: boolean }) =>
      api(`/leads/tasks/${id}`, {
        method: "PATCH",
        body: { status: done ? "done" : "open" },
      }),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["lead", leadId, "tasks"] }),
  });

  return (
    <div className="mt-4 border-t border-slate-200 pt-4">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          Tasks
        </h3>
        <button
          className="text-xs text-brand-600 hover:underline"
          onClick={() => setAdding(true)}
        >
          + New Task
        </button>
      </div>
      {adding && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (title.trim()) create.mutate(title.trim());
          }}
          className="mb-2 flex gap-2"
        >
          <input
            autoFocus
            className="input flex-1"
            placeholder="Task title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
          <button type="submit" className="btn-primary">
            Add
          </button>
        </form>
      )}
      {tasks.length === 0 && !adding && (
        <p className="text-xs text-slate-400">No tasks yet.</p>
      )}
      <ul className="space-y-1">
        {tasks.map((t) => (
          <li key={t.id} className="flex items-center gap-2 text-sm">
            <button
              onClick={() =>
                toggle.mutate({ id: t.id, done: t.status !== "done" })
              }
              className="text-slate-400 hover:text-emerald-600"
            >
              {t.status === "done" ? (
                <CheckCircle2 className="h-4 w-4 text-emerald-600" />
              ) : (
                <Circle className="h-4 w-4" />
              )}
            </button>
            <span
              className={
                t.status === "done"
                  ? "text-slate-400 line-through"
                  : "text-slate-700"
              }
            >
              {t.title}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Composer({
  leadId,
  lead,
  fromEmail,
  workspaceName,
  initialTab,
}: {
  leadId: string;
  lead: Lead;
  fromEmail: string;
  workspaceName: string;
  initialTab: ComposerTab;
}) {
  const qc = useQueryClient();
  const [tab, setTab] = useState<ComposerTab>(initialTab);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [noteBody, setNoteBody] = useState("");
  const [callOutcome, setCallOutcome] = useState("connected");
  const [callNotes, setCallNotes] = useState("");

  const sendEmail = useMutation({
    mutationFn: () =>
      api("/inbox/send", {
        method: "POST",
        body: {
          lead_id: leadId,
          to: lead.email,
          subject,
          body_html: body,
        },
      }),
    onSuccess: () => {
      setSubject("");
      setBody("");
      qc.invalidateQueries({ queryKey: ["lead", leadId, "timeline"] });
    },
  });

  const addNote = useMutation({
    mutationFn: () =>
      api(`/leads/${leadId}/notes`, {
        method: "POST",
        body: { body: noteBody },
      }),
    onSuccess: () => {
      setNoteBody("");
      qc.invalidateQueries({ queryKey: ["lead", leadId, "timeline"] });
    },
  });

  const logCall = useMutation({
    mutationFn: () =>
      api(`/leads/${leadId}/log-call`, {
        method: "POST",
        body: { outcome: callOutcome, notes: callNotes },
      }),
    onSuccess: () => {
      setCallOutcome("connected");
      setCallNotes("");
      qc.invalidateQueries({ queryKey: ["lead", leadId, "timeline"] });
    },
  });

  return (
    <div className="border-b border-slate-200 bg-white">
      <div className="flex items-center gap-1 border-b border-slate-200 px-4">
        <Tab
          active={tab === "email"}
          onClick={() => setTab("email")}
          icon={<Mail className="h-4 w-4" />}
          label="Email"
        />
        <Tab
          active={tab === "linkedin"}
          onClick={() => setTab("linkedin")}
          icon={<Linkedin className="h-4 w-4" />}
          label="LinkedIn"
        />
        <Tab
          active={tab === "note"}
          onClick={() => setTab("note")}
          icon={<StickyNote className="h-4 w-4" />}
          label="Note"
        />
        <Tab
          active={tab === "call"}
          onClick={() => setTab("call")}
          icon={<PhoneCall className="h-4 w-4" />}
          label="Log Call"
        />
      </div>

      <div className="p-4">
        {tab === "email" && (
          <div className="space-y-2">
            <Row label="From" value={`${workspaceName} <${fromEmail}>`} />
            <Row
              label="To"
              value={lead.email || ""}
              placeholder="(no email — capture or enrich first)"
            />
            <input
              className="input w-full"
              placeholder="Subject"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
            />
            <textarea
              className="input min-h-[160px] w-full"
              placeholder="Write your message…"
              value={body}
              onChange={(e) => setBody(e.target.value)}
            />
            <div className="flex items-center justify-end gap-2">
              <button
                className="btn-primary"
                disabled={!lead.email || !body.trim() || sendEmail.isPending}
                onClick={() => sendEmail.mutate()}
              >
                <Send className="h-4 w-4" />
                {sendEmail.isPending ? "Sending…" : "Send"}
              </button>
            </div>
          </div>
        )}
        {tab === "linkedin" && (
          <div className="text-sm text-slate-500">
            LinkedIn messages are sent through the Chrome extension when the
            lead is enrolled in a Playbook.{" "}
            {lead.linkedin_url ? (
              <a
                href={lead.linkedin_url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-brand-600 hover:underline"
              >
                Open profile on LinkedIn →
              </a>
            ) : (
              "No LinkedIn URL on this lead."
            )}
          </div>
        )}
        {tab === "note" && (
          <div className="space-y-2">
            <textarea
              className="input min-h-[120px] w-full"
              placeholder="Internal note (only your team sees this)"
              value={noteBody}
              onChange={(e) => setNoteBody(e.target.value)}
            />
            <div className="flex justify-end">
              <button
                className="btn-primary"
                disabled={!noteBody.trim() || addNote.isPending}
                onClick={() => addNote.mutate()}
              >
                {addNote.isPending ? "Saving…" : "Save Note"}
              </button>
            </div>
          </div>
        )}
        {tab === "call" && (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <label className="text-sm text-slate-600">Outcome</label>
              <select
                className="input"
                value={callOutcome}
                onChange={(e) => setCallOutcome(e.target.value)}
              >
                <option value="connected">Connected</option>
                <option value="voicemail">Voicemail</option>
                <option value="no_answer">No Answer</option>
                <option value="bad_number">Bad Number</option>
              </select>
            </div>
            <textarea
              className="input min-h-[100px] w-full"
              placeholder="Call notes"
              value={callNotes}
              onChange={(e) => setCallNotes(e.target.value)}
            />
            <div className="flex justify-end">
              <button
                className="btn-primary"
                disabled={logCall.isPending}
                onClick={() => logCall.mutate()}
              >
                {logCall.isPending ? "Logging…" : "Log Call"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Tab({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm transition-colors ${
        active
          ? "border-brand-500 text-brand-700"
          : "border-transparent text-slate-500 hover:text-slate-800"
      }`}
    >
      {icon}
      {label}
    </button>
  );
}

function Row({
  label,
  value,
  placeholder,
}: {
  label: string;
  value: string;
  placeholder?: string;
}) {
  return (
    <div className="flex items-center gap-2 text-sm">
      <span className="w-12 shrink-0 text-slate-500">{label}</span>
      <span className={value ? "text-slate-700" : "text-slate-400"}>
        {value || placeholder || "—"}
      </span>
    </div>
  );
}

function Timeline({ items }: { items: TimelineItem[] }) {
  if (items.length === 0) {
    return (
      <div className="flex-1 overflow-auto bg-slate-50 p-6 text-sm text-slate-400">
        No activity yet.
      </div>
    );
  }
  return (
    <div className="flex-1 overflow-auto bg-slate-50 p-4">
      <ul className="space-y-3">
        {items.map((it) => (
          <li
            key={`${it.kind}-${it.id}`}
            className="rounded-md border border-slate-200 bg-white p-3"
          >
            <div className="mb-1 flex items-center justify-between text-xs text-slate-500">
              <span className="flex items-center gap-1.5">
                {it.kind === "email" && <Mail className="h-3.5 w-3.5" />}
                {it.kind === "note" && <StickyNote className="h-3.5 w-3.5" />}
                {it.kind === "call" && <PhoneCall className="h-3.5 w-3.5" />}
                {it.kind === "activity" && <Plus className="h-3.5 w-3.5" />}
                <strong className="font-medium text-slate-700">
                  {labelFor(it)}
                </strong>
              </span>
              <span>{relativeTime(it.at)}</span>
            </div>
            {it.kind === "email" && (
              <div>
                {it.subject && (
                  <div className="text-sm font-medium text-slate-800">
                    {it.subject}
                  </div>
                )}
                {it.preview && (
                  <p className="mt-1 text-sm text-slate-600">{it.preview}</p>
                )}
                <div className="mt-1 text-xs text-slate-400">
                  {it.direction === "outbound" ? "To" : "From"}: {it.to || it.from} ·{" "}
                  {it.status}
                </div>
              </div>
            )}
            {it.kind === "note" && (
              <p className="whitespace-pre-wrap text-sm text-slate-700">
                {it.body}
              </p>
            )}
            {it.kind === "call" && (
              <div>
                <div className="text-sm text-slate-700">
                  {it.outcome}
                  {it.duration_seconds
                    ? ` · ${Math.round((it.duration_seconds || 0) / 60)} min`
                    : ""}
                </div>
                {it.notes && (
                  <p className="mt-1 text-sm text-slate-600">{it.notes}</p>
                )}
              </div>
            )}
            {it.kind === "activity" && (
              <p className="text-sm text-slate-600">{it.type}</p>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function labelFor(it: TimelineItem): string {
  if (it.kind === "email")
    return it.direction === "outbound" ? "Email sent" : "Email received";
  if (it.kind === "note") return "Note";
  if (it.kind === "call") return "Call logged";
  if (it.type === "lead_captured") return "Lead captured";
  if (it.type === "lead_created_manual") return "Lead created";
  if (it.type === "stage_changed") return "Stage changed";
  if (it.type === "note_added") return "Note added";
  if (it.type === "call_logged") return "Call logged";
  return it.type || "Activity";
}
