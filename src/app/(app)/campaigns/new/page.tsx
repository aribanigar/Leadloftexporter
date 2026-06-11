'use client';
import { useState, useRef, useEffect, useCallback, Suspense } from 'react';
import Link from 'next/link';
import { useSearchParams, useRouter } from 'next/navigation';
import { api, ApiError } from '@/lib/api';

// ─── Types ───────────────────────────────────────────────────────────────────

interface FollowUp {
  id: string;
  subject: string;
  htmlContent: string;
  contentMode: 'visual' | 'html' | 'upload';
  scheduleType: 'delay' | 'specific';
  delayValue: number;
  delayUnit: 'minutes' | 'hours' | 'days';
  scheduleAt: string;
}

interface CsvRecipient {
  email: string;
  [key: string]: string;
}

interface FormState {
  name: string;
  goal: string;
  subject: string;
  fromName: string;
  fromEmail: string;
  replyTo: string;
  tags: string;
  htmlContent: string;
  contentMode: 'visual' | 'html' | 'upload';
  manualEmails: string;
  includeAllLeads: boolean;
  followUps: FollowUp[];
  sendDelay: number;       // seconds_between_sends
  dailyLimit: number;      // daily_limit (0 = unlimited)
  warmupEnabled: boolean;  // warmup_enabled
  batchSize: number;       // batch_size
  senderIds: string[];     // sender_account_ids
  mergeColumns: string[];
  csvRecipients: CsvRecipient[];
}

// Sender from GET /campaigns/senders/list
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

// GET /campaigns/{id} (subset we hydrate from)
interface CampaignDetail {
  id: string;
  name: string;
  subject: string;
  body_html: string;
  from_name: string | null;
  from_email: string | null;
  reply_to: string | null;
  goal: string | null;
  tags: string[];
  follow_ups: Array<{
    subject?: string;
    body_html?: string;
    delay_hours?: number;
    status?: string;
  }>;
  merge_columns: string[];
  recipient_data: Array<{ email: string; name?: string; merge?: Record<string, string> }>;
  sender_account_ids: string[];
  batch_size: number;
  seconds_between_sends: number;
  warmup_enabled: boolean;
  include_all_leads?: boolean;
}

// ─── Alpine Editorial Design Tokens ─────────────────────────────────────────

const T = {
  primary:               '#00361a',
  primaryContainer:      '#1a4d2e',
  surface:               '#f8f9fa',
  surfaceContainerLow:   '#f3f4f5',
  surfaceContainer:      '#edeeef',
  surfaceContainerLowest:'#ffffff',
  onSurface:             '#191c1d',
  onSurfaceVariant:      '#414942',
  saffron:               '#c8a84b',
  ghostBorder:           'rgba(193,201,191,0.15)',
  gradientCTA:           'linear-gradient(135deg, #00361a, #1a4d2e)',
  radiusLg:              '8px',
  radiusXl:              '12px',
  radiusFull:            '9999px',
} as const;

// ─── Constants ───────────────────────────────────────────────────────────────

const GOALS = [
  { value: '',               label: 'Select a goal…',           icon: 'flag',           multiplier: 0.6 },
  { value: 'newsletter',     label: 'Newsletter / Update',       icon: 'newspaper',      multiplier: 0.85 },
  { value: 'promotional',    label: 'Promotional Offer',         icon: 'local_offer',    multiplier: 0.75 },
  { value: 'reengagement',   label: 'Re-engagement',             icon: 'refresh',        multiplier: 0.60 },
  { value: 'outreach',       label: 'Cold Outreach',             icon: 'send',           multiplier: 0.65 },
  { value: 'verification',   label: 'Verification Drive',        icon: 'verified',       multiplier: 0.78 },
  { value: 'nurture',        label: 'Nurture',                   icon: 'eco',            multiplier: 0.72 },
  { value: 'announcement',   label: 'Announcement',              icon: 'campaign',       multiplier: 0.88 },
  { value: 'custom',         label: 'Custom / Other',            icon: 'tune',           multiplier: 0.70 },
];

// ─── Score engine ─────────────────────────────────────────────────────────────

interface ScoreItem { label: string; done: boolean; points: number; tip?: string; }

function computeScores(form: FormState, recipientCount: number): {
  completionItems: ScoreItem[];
  completionPct: number;
  optimizationItems: ScoreItem[];
  optimizationScore: number;
  goalProbability: number;
  performanceLabel: 'excellent' | 'good' | 'average' | 'critical';
  tips: string[];
} {
  const html = form.htmlContent || '';
  const subj = form.subject || '';
  const hasLinks = /<a\s[^>]*href/i.test(html);
  const hasImages = /<img/i.test(html);
  const hasUnsubscribe = /unsubscribe/i.test(html);
  const spamWords = /\b(FREE|CLICK NOW|BUY NOW|LIMITED TIME|ACT NOW|WINNER|GUARANTEED|CASH|PRIZE)\b/i.test(subj);
  const subjLen = subj.length;
  const goal = GOALS.find(g => g.value === form.goal);

  const completionItems: ScoreItem[] = [
    { label: 'Campaign name',       done: form.name.trim().length > 0,       points: 1 },
    { label: 'Goal selected',       done: !!form.goal,                        points: 1, tip: 'Set a goal to get personalised optimisation tips.' },
    { label: 'Subject line',        done: subjLen >= 5,                       points: 1, tip: 'Add a compelling subject line.' },
    { label: 'Email content',       done: html.length >= 200,                 points: 1, tip: 'Write at least 200 characters of email content.' },
    { label: 'Has CTA link',        done: hasLinks,                           points: 1, tip: 'Add at least one clickable link or button.' },
    { label: 'Recipients selected', done: recipientCount > 0 || form.includeAllLeads, points: 1, tip: 'Choose who will receive this campaign.' },
    { label: 'Sender chosen',       done: form.senderIds.length > 0,          points: 1, tip: 'Pick at least one connected mailbox to send from.' },
    { label: 'Tags added',          done: form.tags.trim().length > 0,        points: 1, tip: 'Tags help you find campaigns later.' },
  ];
  const completionPct = Math.round((completionItems.filter(i => i.done).length / completionItems.length) * 100);

  const optimizationItems: ScoreItem[] = [
    { label: 'Subject: 30–60 chars',   done: subjLen >= 30 && subjLen <= 60,  points: 15, tip: `Your subject is ${subjLen} chars. Optimal is 30–60.` },
    { label: 'No spam trigger words',  done: !spamWords,                      points: 10, tip: 'Avoid words like FREE, CLICK NOW — they hurt deliverability.' },
    { label: 'Email content 500+ chars', done: html.length >= 500,            points: 12, tip: 'Longer, richer content improves engagement.' },
    { label: 'Has CTA link',           done: hasLinks,                        points: 12, tip: 'Add a button or link to drive action.' },
    { label: 'Has images',             done: hasImages,                       points: 8,  tip: 'Visual emails get 3× more engagement.' },
    { label: 'Unsubscribe link',       done: hasUnsubscribe,                  points: 8,  tip: 'Required by law and improves sender reputation.' },
    { label: 'Reply-to configured',    done: form.replyTo.trim().length > 0,  points: 6,  tip: 'Let recipients reply directly.' },
    { label: 'Goal defined',           done: !!form.goal,                     points: 8,  tip: 'Setting a goal enables smarter scoring.' },
    { label: 'Follow-up scheduled',    done: form.followUps.length > 0,       points: 10, tip: 'Follow-ups increase conversion by 22%.' },
    { label: 'Tags set',               done: form.tags.trim().length > 0,     points: 3,  tip: 'Helps organise campaigns.' },
    { label: 'Subject not ALL CAPS',   done: !/[A-Z]{4,}/.test(subj),        points: 4,  tip: 'All-caps subjects trigger spam filters.' },
    { label: '50+ recipients',         done: recipientCount >= 50 || form.includeAllLeads, points: 4, tip: 'Larger audiences give better signal data.' },
  ];
  const totalPoints = optimizationItems.reduce((s, i) => s + i.points, 0);
  const earnedPoints = optimizationItems.filter(i => i.done).reduce((s, i) => s + i.points, 0);
  const optimizationScore = Math.round((earnedPoints / totalPoints) * 100);

  const multiplier = goal?.multiplier ?? 0.65;
  const goalProbability = Math.min(98, Math.round(optimizationScore * multiplier));

  const performanceLabel =
    goalProbability >= 75 ? 'excellent' :
    goalProbability >= 55 ? 'good' :
    goalProbability >= 35 ? 'average' : 'critical';

  const tips = optimizationItems
    .filter(i => !i.done && i.tip)
    .sort((a, b) => b.points - a.points)
    .slice(0, 3)
    .map(i => i.tip as string);

  return { completionItems, completionPct, optimizationItems, optimizationScore, goalProbability, performanceLabel, tips };
}

// ─── Alpine Input Style ───────────────────────────────────────────────────────

function alpineInput(extra?: React.CSSProperties): React.CSSProperties {
  return {
    width: '100%',
    padding: '12px 14px',
    background: T.surfaceContainerLow,
    border: 'none',
    borderRadius: T.radiusLg,
    fontSize: '13px',
    color: T.onSurface,
    fontFamily: 'Inter, sans-serif',
    outline: 'none',
    boxSizing: 'border-box' as const,
    transition: 'background 0.15s',
    ...extra,
  };
}

function alpineLabel(extra?: React.CSSProperties): React.CSSProperties {
  return {
    display: 'block',
    fontSize: '11px',
    fontWeight: 700,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.07em',
    color: T.onSurfaceVariant,
    marginBottom: '6px',
    ...extra,
  };
}

// ─── Toast ───────────────────────────────────────────────────────────────────

function Toast({ msg, type, onClose }: { msg: string; type: 'success' | 'error'; onClose: () => void }) {
  useEffect(() => {
    const t = setTimeout(onClose, 3500);
    return () => clearTimeout(t);
  }, [onClose]);
  return (
    <div style={{
      position: 'fixed', bottom: '90px', left: '50%', transform: 'translateX(-50%)',
      backgroundColor: type === 'success' ? T.primary : '#dc2626',
      color: '#fff', borderRadius: T.radiusXl, padding: '12px 24px',
      fontSize: '13px', fontWeight: 600, zIndex: 9999,
      boxShadow: '0 4px 20px rgba(0,0,0,0.2)',
      display: 'flex', alignItems: 'center', gap: '10px',
      fontFamily: 'Inter, sans-serif',
    }}>
      <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>
        {type === 'success' ? 'check_circle' : 'error'}
      </span>
      {msg}
    </div>
  );
}

// ─── Preview Modal ────────────────────────────────────────────────────────────

function PreviewModal({ html, onClose }: { html: string; onClose: () => void }) {
  return (
    <div style={{
      position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.55)',
      zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: '20px',
    }} onClick={onClose}>
      <div style={{
        backgroundColor: T.surfaceContainerLowest, borderRadius: '16px',
        width: '100%', maxWidth: '700px', maxHeight: '90vh',
        overflow: 'hidden', display: 'flex', flexDirection: 'column',
        boxShadow: '0 20px 60px rgba(0,0,0,0.25)',
      }} onClick={e => e.stopPropagation()}>
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '16px 20px', borderBottom: `1px solid ${T.surfaceContainer}`,
        }}>
          <span style={{ fontSize: '14px', fontWeight: 700, color: T.primary, fontFamily: 'Manrope, Inter, sans-serif' }}>
            Email Preview
          </span>
          <button onClick={onClose} style={{
            background: 'none', border: 'none', cursor: 'pointer',
            display: 'flex', alignItems: 'center', color: T.onSurfaceVariant,
          }}>
            <span className="material-symbols-outlined" style={{ fontSize: '20px' }}>close</span>
          </button>
        </div>
        <iframe
          srcDoc={html || '<p style="padding:40px;color:#9ca3af;text-align:center">No content yet</p>'}
          style={{ flex: 1, border: 'none', minHeight: '500px' }}
          sandbox="allow-same-origin"
          title="Email Preview"
        />
      </div>
    </div>
  );
}

// ─── Ring Dial ───────────────────────────────────────────────────────────────

function RingDial({ value, label, color, sublabel }: { value: number; label: string; color: string; sublabel?: string }) {
  const r = 26;
  const circ = 2 * Math.PI * r;
  const offset = circ * (1 - value / 100);
  return (
    <div style={{ textAlign: 'center', flex: 1 }}>
      <div style={{ fontSize: '10px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', color: T.onSurfaceVariant, marginBottom: '8px' }}>
        {label}
      </div>
      <div style={{ position: 'relative', width: '64px', height: '64px', margin: '0 auto 6px' }}>
        <svg width="64" height="64" viewBox="0 0 64 64">
          <circle cx="32" cy="32" r={r} fill="none" stroke={T.surfaceContainer} strokeWidth="6" />
          <circle cx="32" cy="32" r={r} fill="none"
            stroke={color}
            strokeWidth="6" strokeLinecap="round"
            strokeDasharray={`${circ}`}
            strokeDashoffset={`${offset}`}
            transform="rotate(-90 32 32)"
            style={{ transition: 'stroke-dashoffset 0.5s ease' }}
          />
        </svg>
        <span style={{
          position: 'absolute', inset: 0, display: 'flex', alignItems: 'center',
          justifyContent: 'center', fontSize: '14px', fontWeight: 800, color: T.onSurface,
          fontFamily: 'Manrope, Inter, sans-serif',
        }}>
          {value}%
        </span>
      </div>
      {sublabel && (
        <div style={{ fontSize: '10px', color: T.onSurfaceVariant }}>{sublabel}</div>
      )}
    </div>
  );
}

// ─── Left Panel Section wrapper ───────────────────────────────────────────────

function PanelSection({ children, noBorder }: { children: React.ReactNode; noBorder?: boolean }) {
  return (
    <div style={{
      padding: '20px 20px',
      borderBottom: noBorder ? 'none' : `1px solid ${T.surfaceContainer}`,
    }}>
      {children}
    </div>
  );
}

function PanelSectionTitle({ icon, children }: { icon: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '14px' }}>
      <span className="material-symbols-outlined" style={{ fontSize: '16px', color: T.saffron }}>{icon}</span>
      <span style={{
        fontSize: '13px', fontWeight: 700, color: T.onSurface,
        fontFamily: 'Manrope, Inter, sans-serif', letterSpacing: '-0.01em',
      }}>
        {children}
      </span>
    </div>
  );
}

// ─── Email helpers ────────────────────────────────────────────────────────────

const EMAIL_RE = /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/;

function parseEmails(raw: string): string[] {
  return raw.split(/[\n,]+/).map(e => e.trim()).filter(Boolean);
}

// ─── Main Component ───────────────────────────────────────────────────────────

function NewCampaignPageInner() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const prefillEmail = searchParams.get('prefill') || '';
  const editId = searchParams.get('id') || '';

  const [form, setForm] = useState<FormState>({
    name: '',
    goal: '',
    subject: '',
    fromName: '',
    fromEmail: '',
    replyTo: '',
    tags: '',
    htmlContent: '',
    contentMode: 'html',
    manualEmails: prefillEmail,
    includeAllLeads: false,
    followUps: [],
    sendDelay: 30,
    dailyLimit: 0,
    warmupEnabled: true,
    batchSize: 8,
    senderIds: [],
    mergeColumns: [],
    csvRecipients: [],
  });

  const [campaignId, setCampaignId] = useState<string | null>(editId || null);
  const [loadingEdit, setLoadingEdit] = useState(false);
  const [saving, setSaving] = useState(false);
  const [sending, setSending] = useState(false);
  const [showSplitPreview, setShowSplitPreview] = useState(false);
  const [previewDevice, setPreviewDevice] = useState<'desktop' | 'mobile'>('desktop');
  const [showPreviewFor, setShowPreviewFor] = useState<string | null>(null);
  const [toast, setToast] = useState<{ msg: string; type: 'success' | 'error' } | null>(null);
  const [senders, setSenders] = useState<Sender[]>([]);
  type EmailResult = { email: string; valid: boolean; reason: string; tag: 'valid' | 'invalid_format' };
  const [validationResult, setValidationResult] = useState<{ valid: number; invalid: number; results: EmailResult[] } | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [healthOpen, setHealthOpen] = useState(false);

  const editorRef = useRef<HTMLDivElement>(null);
  const fuEditorRefs = useRef<(HTMLDivElement | null)[]>([]);
  const fuFileInputRefs = useRef<(HTMLInputElement | null)[]>([]);
  const csvInputRef = useRef<HTMLInputElement>(null);
  const htmlFileInputRef = useRef<HTMLInputElement>(null);

  const activeSenders = senders.filter(s => s.status === 'active');

  const currentHtml = form.contentMode === 'visual' && editorRef.current
    ? editorRef.current.innerHTML
    : form.htmlContent;

  const manualCount = (() => {
    const emails = parseEmails(form.manualEmails).filter(e => e.includes('@'));
    return emails.length;
  })();
  const recipientCount = form.includeAllLeads ? Math.max(manualCount, 1) : manualCount;

  const health = computeScores(form, manualCount);

  const tagPills = form.tags
    .split(',')
    .map(t => t.trim())
    .filter(Boolean);

  // ── Load connected senders
  const fetchSenders = useCallback(async () => {
    try {
      const list = await api<Sender[]>('/campaigns/senders/list');
      setSenders(list);
    } catch {
      setSenders([]);
    }
  }, []);

  useEffect(() => {
    fetchSenders();
  }, [fetchSenders]);

  // ── Load existing campaign for editing (when ?id= is in URL)
  useEffect(() => {
    if (!editId) return;
    let cancelled = false;
    setLoadingEdit(true);
    api<CampaignDetail>(`/campaigns/${editId}`)
      .then(c => {
        if (cancelled || !c || !c.name) return;

        const parseDelay = (h: number): { delayValue: number; delayUnit: 'minutes' | 'hours' | 'days' } => {
          if (h < 1) return { delayValue: Math.max(1, Math.round(h * 60)), delayUnit: 'minutes' };
          if (h < 24) return { delayValue: Math.round(h), delayUnit: 'hours' };
          return { delayValue: Math.max(1, Math.round(h / 24)), delayUnit: 'days' };
        };

        setForm({
          name: c.name || '',
          goal: c.goal || '',
          subject: c.subject || '',
          fromName: c.from_name || '',
          fromEmail: c.from_email || '',
          replyTo: c.reply_to || '',
          tags: Array.isArray(c.tags) ? c.tags.join(', ') : '',
          htmlContent: c.body_html || '',
          contentMode: 'html',
          manualEmails: (c.recipient_data || []).map(r => r.email).join('\n'),
          includeAllLeads: !!c.include_all_leads,
          followUps: (c.follow_ups || []).map((fu, i) => {
            const { delayValue, delayUnit } = parseDelay(fu.delay_hours ?? 24);
            return {
              id: String(i),
              subject: fu.subject || '',
              htmlContent: fu.body_html || '',
              contentMode: 'html' as const,
              scheduleType: 'delay' as const,
              delayValue,
              delayUnit,
              scheduleAt: '',
            };
          }),
          sendDelay: c.seconds_between_sends ?? 30,
          dailyLimit: 0,
          warmupEnabled: c.warmup_enabled ?? true,
          batchSize: c.batch_size ?? 8,
          senderIds: c.sender_account_ids || [],
          mergeColumns: c.merge_columns || [],
          csvRecipients: (c.recipient_data || []).map(r => ({
            email: r.email,
            ...(r.merge || {}),
          })),
        });
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoadingEdit(false); });
    return () => { cancelled = true; };
  }, [editId]);

  // ── execCommand helpers (main editor)
  const exec = (cmd: string, val?: string) => {
    document.execCommand(cmd, false, val);
    if (editorRef.current) {
      setForm(f => ({ ...f, htmlContent: editorRef.current!.innerHTML }));
    }
  };

  const insertLink = () => {
    const url = prompt('Enter URL:');
    if (url) exec('createLink', url);
  };

  // ── execCommand helpers (follow-up editors)
  const execFu = (idx: number, cmd: string, val?: string) => {
    const el = fuEditorRefs.current[idx];
    if (!el) return;
    el.focus();
    document.execCommand(cmd, false, val);
    updateFollowUp(idx, { htmlContent: el.innerHTML });
  };

  const insertLinkFu = (idx: number) => {
    const url = prompt('Enter URL:');
    if (url) execFu(idx, 'createLink', url);
  };

  // ── Editor blur sync (main)
  const syncEditor = () => {
    if (editorRef.current) {
      setForm(f => ({ ...f, htmlContent: editorRef.current!.innerHTML }));
    }
  };

  // ── File upload: HTML (main)
  const handleHtmlFileUpload = (file: File) => {
    const reader = new FileReader();
    reader.onload = e => {
      const content = e.target?.result as string;
      setForm(f => ({ ...f, htmlContent: content }));
      if (editorRef.current) editorRef.current.innerHTML = content;
    };
    reader.readAsText(file);
  };

  // ── File upload: HTML (follow-up)
  const handleFuHtmlFileUpload = (idx: number, file: File) => {
    const reader = new FileReader();
    reader.onload = e => {
      const content = e.target?.result as string;
      updateFollowUp(idx, { htmlContent: content });
    };
    reader.readAsText(file);
  };

  // ── File upload: CSV emails
  // Finds the "email" column, uses ALL other columns as merge placeholders.
  const handleCsvUpload = (file: File) => {
    const reader = new FileReader();
    reader.onload = e => {
      const text = e.target?.result as string;
      const lines = text.split(/\r?\n/).filter(l => l.trim());

      const parseRow = (row: string): string[] =>
        row.split(',').map(cell => cell.trim().replace(/^["']|["']$/g, ''));

      let newEmails: string[] = [];
      let newRecipients: CsvRecipient[] = [];
      let columns: string[] = [];

      if (lines.length > 0) {
        const rawHeaders = parseRow(lines[0]);
        const headers = rawHeaders.map(h => h.toLowerCase().replace(/\s+/g, '_'));
        let emailColIdx = headers.findIndex(h => h === 'email' || h === 'email_address' || h === 'e-mail');
        if (emailColIdx === -1) emailColIdx = 0; // fall back to first column

        // All columns except email become merge placeholders
        columns = headers.filter((_, i) => i !== emailColIdx);

        for (let i = 1; i < lines.length; i++) {
          const cells = parseRow(lines[i]);
          const emailVal = cells[emailColIdx]?.trim().toLowerCase();
          if (!emailVal || !emailVal.includes('@')) continue;

          const row: CsvRecipient = { email: emailVal };
          headers.forEach((h, ci) => {
            if (ci !== emailColIdx) row[h] = cells[ci]?.trim() ?? '';
          });
          newEmails.push(emailVal);
          newRecipients.push(row);
        }
      }

      const newEmailStr = newEmails.join('\n');
      const combined = form.manualEmails
        ? form.manualEmails + '\n' + newEmailStr
        : newEmailStr;

      // Merge new recipients into existing list (deduplicate by email)
      const existingEmails = new Set(form.csvRecipients.map(r => r.email));
      const mergedRecipients = [
        ...form.csvRecipients,
        ...newRecipients.filter(r => !existingEmails.has(r.email)),
      ];

      // Merge columns (union of all CSV columns seen so far)
      const allColumns = Array.from(new Set([...form.mergeColumns, ...columns]));

      setForm(f => ({
        ...f,
        manualEmails: combined,
        csvRecipients: mergedRecipients,
        mergeColumns: allColumns,
      }));
      triggerValidation(combined);

      if (columns.length > 0) {
        setToast({
          msg: `${newEmails.length} emails loaded. Placeholders: ${columns.map(c => `{${c}}`).join(', ')}`,
          type: 'success',
        });
      } else {
        setToast({ msg: `${newEmails.length} emails loaded from CSV`, type: 'success' });
      }
    };
    reader.readAsText(file);
  };

  // ── Build API body (CampaignCreateIn / CampaignUpdateIn compatible)
  const buildCreateBody = () => {
    const bodyHtml = form.contentMode === 'visual' && editorRef.current
      ? editorRef.current.innerHTML
      : form.htmlContent;

    const unitToHours = (val: number, unit: string): number => {
      if (unit === 'minutes') return val / 60;
      if (unit === 'days')    return val * 24;
      return val; // hours
    };

    // Recipients with merge data (from CSV), and plain manual emails.
    const csvEmails = new Set(form.csvRecipients.map(r => r.email.toLowerCase()));
    const manualOnly = parseEmails(form.manualEmails)
      .map(e => e.toLowerCase())
      .filter(e => e.includes('@') && !csvEmails.has(e));

    const recipients = form.csvRecipients.map(({ email, ...rest }) => ({
      email,
      merge: rest,
    }));

    return {
      name: form.name.trim() || form.subject.trim() || 'Untitled campaign',
      subject: form.subject,
      body_html: bodyHtml,
      body_text: '',
      from_name: form.fromName || undefined,
      from_email: form.fromEmail || undefined,
      reply_to: form.replyTo || undefined,
      goal: form.goal || undefined,
      tags: form.tags ? form.tags.split(',').map(t => t.trim()).filter(Boolean) : [],
      merge_columns: form.mergeColumns,
      recipients,
      manual_emails: manualOnly,
      include_all_leads: form.includeAllLeads,
      sender_account_ids: form.senderIds,
      batch_size: form.batchSize,
      seconds_between_sends: form.sendDelay,
      daily_limit: form.dailyLimit > 0 ? form.dailyLimit : undefined,
      warmup_enabled: form.warmupEnabled,
      follow_ups: form.followUps.map(fu => ({
        subject: fu.subject,
        body_html: fu.htmlContent,
        delay_hours: fu.scheduleType === 'delay' ? unitToHours(fu.delayValue, fu.delayUnit) : 24,
        status: 'draft',
      })),
    };
  };

  // PATCH body — only the fields CampaignUpdateIn accepts.
  const buildPatchBody = () => {
    const bodyHtml = form.contentMode === 'visual' && editorRef.current
      ? editorRef.current.innerHTML
      : form.htmlContent;
    const unitToHours = (val: number, unit: string): number => {
      if (unit === 'minutes') return val / 60;
      if (unit === 'days')    return val * 24;
      return val;
    };
    return {
      name: form.name.trim() || form.subject.trim() || 'Untitled campaign',
      subject: form.subject,
      body_html: bodyHtml,
      body_text: '',
      from_name: form.fromName || undefined,
      from_email: form.fromEmail || undefined,
      reply_to: form.replyTo || undefined,
      goal: form.goal || undefined,
      tags: form.tags ? form.tags.split(',').map(t => t.trim()).filter(Boolean) : [],
      sender_account_ids: form.senderIds,
      batch_size: form.batchSize,
      seconds_between_sends: form.sendDelay,
      warmup_enabled: form.warmupEnabled,
      follow_ups: form.followUps.map(fu => ({
        subject: fu.subject,
        body_html: fu.htmlContent,
        delay_hours: fu.scheduleType === 'delay' ? unitToHours(fu.delayValue, fu.delayUnit) : 24,
        status: 'draft',
      })),
    };
  };

  // ── Save draft (create or PATCH)
  const saveDraft = async () => {
    if (!form.name.trim() && !form.subject.trim()) {
      setToast({ msg: 'Campaign name or subject is required', type: 'error' });
      return;
    }
    setSaving(true);
    try {
      if (campaignId) {
        await api(`/campaigns/${campaignId}`, { method: 'PATCH', body: buildPatchBody() });
        setToast({ msg: 'Campaign saved', type: 'success' });
      } else {
        const created = await api<{ id: string }>('/campaigns', { method: 'POST', body: buildCreateBody() });
        setCampaignId(String(created.id));
        // Reflect the new id in the URL so a reload keeps editing the same draft.
        router.replace(`/campaigns/new?id=${created.id}`);
        setToast({ msg: 'Draft saved successfully', type: 'success' });
      }
    } catch (e) {
      setToast({ msg: e instanceof ApiError ? e.message : 'Failed to save draft', type: 'error' });
    } finally {
      setSaving(false);
    }
  };

  // ── Launch campaign — create (or patch) then /start, then go to the report page.
  const sendCampaign = async () => {
    const bodyHtml = form.contentMode === 'visual' && editorRef.current
      ? editorRef.current.innerHTML
      : form.htmlContent;
    if (!bodyHtml || bodyHtml.trim().length < 10) {
      setToast({ msg: 'Email body is required. Write or upload your email content before launching.', type: 'error' });
      return;
    }
    if (!form.subject.trim()) {
      setToast({ msg: 'A subject line is required before launching.', type: 'error' });
      return;
    }
    if (activeSenders.length === 0) {
      setToast({ msg: 'Connect an email sender before launching.', type: 'error' });
      return;
    }
    setSending(true);
    try {
      let id = campaignId;
      if (id) {
        await api(`/campaigns/${id}/${''}`.replace(/\/$/, ''), { method: 'PATCH', body: buildPatchBody() });
      } else {
        const created = await api<{ id: string }>('/campaigns', { method: 'POST', body: buildCreateBody() });
        id = String(created.id);
        setCampaignId(id);
      }
      await api(`/campaigns/${id}/start`, { method: 'POST' });
      setToast({ msg: 'Campaign launched!', type: 'success' });
      router.push(`/campaigns/${id}`);
    } catch (e) {
      setToast({ msg: e instanceof ApiError ? e.message : 'Failed to launch campaign', type: 'error' });
      setSending(false);
    }
  };

  // ── Client-side email validation (format only)
  const runValidation = useCallback((raw: string) => {
    const all = parseEmails(raw);
    if (all.length === 0) { setValidationResult(null); return; }
    const results: EmailResult[] = all.map(email => {
      const ok = EMAIL_RE.test(email);
      return {
        email,
        valid: ok,
        reason: ok ? 'ok' : 'invalid format',
        tag: ok ? 'valid' : 'invalid_format',
      };
    });
    const valid = results.filter(r => r.valid).length;
    setValidationResult({ valid, invalid: results.length - valid, results });
  }, []);

  const validateDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const triggerValidation = useCallback((raw: string) => {
    if (validateDebounceRef.current) clearTimeout(validateDebounceRef.current);
    validateDebounceRef.current = setTimeout(() => runValidation(raw), 600);
  }, [runValidation]);

  const validateNow = useCallback(() => {
    if (validateDebounceRef.current) clearTimeout(validateDebounceRef.current);
    const all = parseEmails(form.manualEmails);
    if (all.length === 0) { setToast({ msg: 'Add email addresses first', type: 'error' }); return; }
    runValidation(form.manualEmails);
    const valid = all.filter(e => EMAIL_RE.test(e)).length;
    const invalid = all.length - valid;
    setToast({ msg: `${valid} valid, ${invalid} invalid`, type: invalid > 0 ? 'error' : 'success' });
  }, [form.manualEmails, runValidation]);

  // ── Remove bad emails
  const removeBadEmails = () => {
    if (!validationResult) return;
    const badSet = new Set(
      validationResult.results.filter(r => !r.valid).map(r => r.email.toLowerCase())
    );
    const cleaned = parseEmails(form.manualEmails)
      .filter(e => !badSet.has(e.toLowerCase()))
      .join('\n');
    const removed = validationResult.invalid;
    setForm(f => ({ ...f, manualEmails: cleaned }));
    setValidationResult(null);
    triggerValidation(cleaned);
    setToast({ msg: `Removed ${removed} invalid email(s)`, type: 'success' });
  };

  // ── Sender toggle
  const toggleSender = (id: string) => {
    setForm(f => ({
      ...f,
      senderIds: f.senderIds.includes(id)
        ? f.senderIds.filter(s => s !== id)
        : [...f.senderIds, id],
    }));
  };

  // ── Follow-up CRUD
  const addFollowUp = () => {
    setForm(f => ({
      ...f,
      followUps: [
        ...f.followUps,
        {
          id: Date.now().toString(),
          subject: '',
          htmlContent: '',
          contentMode: 'html',
          scheduleType: 'delay',
          delayValue: 24,
          delayUnit: 'hours',
          scheduleAt: '',
        },
      ],
    }));
  };

  const updateFollowUp = (idx: number, patch: Partial<FollowUp>) => {
    setForm(f => {
      const fus = [...f.followUps];
      fus[idx] = { ...fus[idx], ...patch };
      return { ...f, followUps: fus };
    });
  };

  const removeFollowUp = (idx: number) => {
    setForm(f => ({ ...f, followUps: f.followUps.filter((_, i) => i !== idx) }));
  };

  const duplicateFollowUp = (idx: number) => {
    const copy = { ...form.followUps[idx], id: Date.now().toString(), subject: form.followUps[idx].subject + ' (Copy)' };
    const fus = [...form.followUps];
    fus.splice(idx + 1, 0, copy);
    setForm(f => ({ ...f, followUps: fus }));
  };

  const calcDelayDate = (value: number, unit: 'minutes' | 'hours' | 'days'): string => {
    const ms = unit === 'minutes' ? value * 60_000 : unit === 'hours' ? value * 3_600_000 : value * 86_400_000;
    return new Date(Date.now() + ms).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  };

  // ── Ring color helper
  const ringColor = (val: number) =>
    val >= 75 ? '#16a34a' : val >= 50 ? T.saffron : '#dc2626';

  // ── Follow-up toolbar button
  const fuToolbarBtn = (idx: number, icon: string, action: () => void, title: string) => (
    <button
      key={title}
      title={title}
      onMouseDown={e => { e.preventDefault(); action(); }}
      style={{
        padding: '4px 7px',
        border: `1px solid ${T.surfaceContainer}`,
        borderRadius: '5px',
        background: T.surfaceContainerLowest,
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        color: T.onSurfaceVariant,
      }}
    >
      <span className="material-symbols-outlined" style={{ fontSize: '14px' }}>{icon}</span>
    </button>
  );

  const noSenders = activeSenders.length === 0;

  // ─────────────────────────────────────────────────────────────────────────────
  // RENDER
  // ─────────────────────────────────────────────────────────────────────────────

  return (
    <div style={{
      fontFamily: 'Inter, sans-serif',
      backgroundColor: T.surface,
      minHeight: '100vh',
      display: 'flex',
      flexDirection: 'column',
    }}>
      {/* ═══ HEADER BAR ═══════════════════════════════════════════════════════ */}
      <div style={{
        backgroundColor: T.surfaceContainerLowest,
        borderBottom: `1px solid ${T.surfaceContainer}`,
        padding: '0 28px',
        height: '60px',
        display: 'flex',
        alignItems: 'center',
        gap: '16px',
        position: 'sticky',
        top: 0,
        zIndex: 100,
        flexShrink: 0,
      }}>
        {/* Back link */}
        <Link href="/campaigns" style={{
          display: 'flex', alignItems: 'center', gap: '5px',
          color: T.onSurfaceVariant, textDecoration: 'none', fontSize: '13px',
          fontWeight: 500, flexShrink: 0,
        }}>
          <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>arrow_back</span>
          Back
        </Link>

        <div style={{ width: '1px', height: '20px', backgroundColor: T.surfaceContainer }} />

        {/* Title */}
        <h1 style={{
          fontSize: '20px', fontWeight: 800, color: T.onSurface, margin: 0,
          fontFamily: 'Manrope, Inter, sans-serif', letterSpacing: '-0.02em',
          flex: 1,
        }}>
          {editId ? 'Edit Campaign' : 'Campaign Builder'}
        </h1>

        {loadingEdit && (
          <span style={{ fontSize: '12px', color: T.onSurfaceVariant, fontFamily: 'Inter, sans-serif' }}>Loading...</span>
        )}

        {campaignId && !loadingEdit && (
          <span style={{
            fontSize: '10px', fontWeight: 700,
            backgroundColor: editId ? 'rgba(0,54,26,0.10)' : 'rgba(200,168,75,0.12)',
            color: editId ? T.primary : T.saffron,
            borderRadius: T.radiusFull, padding: '3px 10px',
            letterSpacing: '0.06em', textTransform: 'uppercase',
          }}>
            {editId ? 'Editing' : 'Draft'}
          </span>
        )}

        {/* Live Preview toggle */}
        <button
          onClick={() => setShowSplitPreview(v => !v)}
          style={{
            display: 'flex', alignItems: 'center', gap: '6px',
            padding: '7px 14px',
            borderRadius: T.radiusLg,
            border: 'none',
            backgroundColor: showSplitPreview ? T.surfaceContainer : T.surfaceContainerLow,
            color: showSplitPreview ? T.primary : T.onSurfaceVariant,
            fontSize: '12px', fontWeight: 600, cursor: 'pointer',
            fontFamily: 'Inter, sans-serif',
          }}
        >
          <span className="material-symbols-outlined" style={{ fontSize: '15px' }}>splitscreen</span>
          Live Preview
        </button>

        {/* Save Draft */}
        <button
          onClick={saveDraft}
          disabled={saving}
          style={{
            display: 'flex', alignItems: 'center', gap: '6px',
            padding: '9px 18px',
            borderRadius: T.radiusLg,
            border: 'none',
            backgroundColor: T.surfaceContainer,
            color: T.onSurface,
            fontSize: '13px', fontWeight: 600, cursor: saving ? 'not-allowed' : 'pointer',
            fontFamily: 'Inter, sans-serif',
            opacity: saving ? 0.7 : 1,
          }}
        >
          {saving ? (
            <span style={{
              width: '13px', height: '13px', border: `2px solid ${T.onSurface}`,
              borderTopColor: 'transparent', borderRadius: '50%',
              animation: 'spin 0.7s linear infinite', display: 'inline-block',
            }} />
          ) : (
            <span className="material-symbols-outlined" style={{ fontSize: '15px' }}>save</span>
          )}
          Save Draft
        </button>

        {/* Launch Campaign */}
        <button
          onClick={sendCampaign}
          disabled={sending || noSenders}
          title={noSenders ? 'Connect an email sender first' : undefined}
          style={{
            display: 'flex', alignItems: 'center', gap: '6px',
            padding: '9px 20px',
            borderRadius: T.radiusLg,
            border: 'none',
            background: (sending || noSenders) ? '#9ca3af' : T.gradientCTA,
            color: '#fff',
            fontSize: '13px', fontWeight: 700, cursor: (sending || noSenders) ? 'not-allowed' : 'pointer',
            fontFamily: 'Inter, sans-serif',
            boxShadow: (sending || noSenders) ? 'none' : '0 2px 12px rgba(0,54,26,0.3)',
          }}
        >
          {sending ? (
            <span style={{
              width: '13px', height: '13px', border: '2px solid #fff',
              borderTopColor: 'transparent', borderRadius: '50%',
              animation: 'spin 0.7s linear infinite', display: 'inline-block',
            }} />
          ) : (
            <span className="material-symbols-outlined" style={{ fontSize: '15px' }}>send</span>
          )}
          {sending ? 'Launching…' : 'Launch Campaign'}
        </button>
      </div>

      {/* ═══ BODY: split layout ═══════════════════════════════════════════════ */}
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>

        {/* ─── LEFT PANEL (~320px) ─────────────────────────────────────────── */}
        <div style={{
          width: '320px',
          flexShrink: 0,
          backgroundColor: T.surfaceContainerLowest,
          borderRight: `1px solid ${T.surfaceContainer}`,
          overflowY: 'auto',
          height: 'calc(100vh - 60px)',
          position: 'sticky',
          top: '60px',
        }}>

          {/* ── Campaign Details ── */}
          <PanelSection>
            <PanelSectionTitle icon="campaign">Campaign Details</PanelSectionTitle>

            <div style={{ display: 'grid', gap: '12px' }}>
              {/* Internal Name */}
              <div>
                <span style={alpineLabel()}>Campaign Internal Name</span>
                <input
                  style={alpineInput()}
                  value={form.name}
                  onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                  placeholder="e.g. Q3 launch announcement"
                  onFocus={e => { e.target.style.background = '#e8eaeb'; e.target.style.outline = '2px solid rgba(0,54,26,0.2)'; }}
                  onBlur={e => { e.target.style.background = T.surfaceContainerLow; e.target.style.outline = 'none'; }}
                />
              </div>

              {/* Goal */}
              <div>
                <span style={alpineLabel()}>Campaign Goal</span>
                <div style={{ position: 'relative' }}>
                  <span className="material-symbols-outlined" style={{
                    position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)',
                    fontSize: '14px', color: T.onSurfaceVariant, pointerEvents: 'none',
                  }}>
                    {GOALS.find(g => g.value === form.goal)?.icon || 'flag'}
                  </span>
                  <select
                    value={form.goal}
                    onChange={e => setForm(f => ({ ...f, goal: e.target.value }))}
                    style={{
                      ...alpineInput({ paddingLeft: '34px' }),
                      appearance: 'none',
                      cursor: 'pointer',
                    } as React.CSSProperties}
                  >
                    {GOALS.map(g => (
                      <option key={g.value} value={g.value}>{g.label}</option>
                    ))}
                  </select>
                  <span className="material-symbols-outlined" style={{
                    position: 'absolute', right: '10px', top: '50%', transform: 'translateY(-50%)',
                    fontSize: '14px', color: T.onSurfaceVariant, pointerEvents: 'none',
                  }}>expand_more</span>
                </div>
              </div>

              {/* Subject Line */}
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
                  <span style={alpineLabel({ marginBottom: 0 })}>Email Subject Line</span>
                  <span style={{ fontSize: '10px', color: form.subject.length > 100 ? '#dc2626' : T.onSurfaceVariant }}>
                    {form.subject.length}/100
                  </span>
                </div>
                <input
                  style={alpineInput()}
                  value={form.subject}
                  onChange={e => setForm(f => ({ ...f, subject: e.target.value }))}
                  placeholder="Quick idea for {company}"
                  maxLength={120}
                  onFocus={e => { e.target.style.background = '#e8eaeb'; e.target.style.outline = '2px solid rgba(0,54,26,0.2)'; }}
                  onBlur={e => { e.target.style.background = T.surfaceContainerLow; e.target.style.outline = 'none'; }}
                />
              </div>

              {/* From Name + Email */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                <div>
                  <span style={alpineLabel()}>From Name</span>
                  <input
                    style={alpineInput()}
                    value={form.fromName}
                    onChange={e => setForm(f => ({ ...f, fromName: e.target.value }))}
                    placeholder="(uses sender)"
                    onFocus={e => { e.target.style.background = '#e8eaeb'; e.target.style.outline = '2px solid rgba(0,54,26,0.2)'; }}
                    onBlur={e => { e.target.style.background = T.surfaceContainerLow; e.target.style.outline = 'none'; }}
                  />
                </div>
                <div>
                  <span style={alpineLabel()}>From Email</span>
                  <input
                    type="email"
                    style={alpineInput()}
                    value={form.fromEmail}
                    onChange={e => setForm(f => ({ ...f, fromEmail: e.target.value }))}
                    placeholder="(uses sender)"
                    onFocus={e => { e.target.style.background = '#e8eaeb'; e.target.style.outline = '2px solid rgba(0,54,26,0.2)'; }}
                    onBlur={e => { e.target.style.background = T.surfaceContainerLow; e.target.style.outline = 'none'; }}
                  />
                </div>
              </div>

              {/* Reply-To */}
              <div>
                <span style={alpineLabel()}>Reply-To</span>
                <input
                  type="email"
                  style={alpineInput()}
                  value={form.replyTo}
                  onChange={e => setForm(f => ({ ...f, replyTo: e.target.value }))}
                  placeholder="replies@yourdomain.com"
                  onFocus={e => { e.target.style.background = '#e8eaeb'; e.target.style.outline = '2px solid rgba(0,54,26,0.2)'; }}
                  onBlur={e => { e.target.style.background = T.surfaceContainerLow; e.target.style.outline = 'none'; }}
                />
              </div>

              {/* Tags */}
              <div>
                <span style={alpineLabel()}>Tags</span>
                <input
                  style={alpineInput()}
                  value={form.tags}
                  onChange={e => setForm(f => ({ ...f, tags: e.target.value }))}
                  placeholder="q3, promotional (comma-separated)"
                  onFocus={e => { e.target.style.background = '#e8eaeb'; e.target.style.outline = '2px solid rgba(0,54,26,0.2)'; }}
                  onBlur={e => { e.target.style.background = T.surfaceContainerLow; e.target.style.outline = 'none'; }}
                />
                {tagPills.length > 0 && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '5px', marginTop: '7px' }}>
                    {tagPills.map((tag, i) => (
                      <span key={i} style={{
                        fontSize: '11px', fontWeight: 600,
                        backgroundColor: 'rgba(0,54,26,0.08)',
                        color: T.primary, borderRadius: T.radiusFull,
                        padding: '2px 9px',
                      }}>{tag}</span>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </PanelSection>

          {/* ── Target Audience ── */}
          <PanelSection>
            <PanelSectionTitle icon="group">Target Audience</PanelSectionTitle>

            <div style={{ display: 'grid', gap: '8px', marginBottom: '12px' }}>
              {/* Include all CRM leads chip */}
              <label style={{
                display: 'flex', alignItems: 'center', gap: '10px',
                padding: '10px 14px',
                borderRadius: T.radiusLg,
                cursor: 'pointer',
                backgroundColor: form.includeAllLeads
                  ? 'rgba(0,54,26,0.08)' : T.surfaceContainerLow,
                transition: 'background 0.15s',
              }}>
                <input
                  type="checkbox"
                  checked={form.includeAllLeads}
                  onChange={e => setForm(f => ({ ...f, includeAllLeads: e.target.checked }))}
                  style={{ width: '15px', height: '15px', accentColor: T.primary, flexShrink: 0 }}
                />
                <span className="material-symbols-outlined" style={{ fontSize: '16px', color: form.includeAllLeads ? T.primary : T.onSurfaceVariant }}>
                  groups
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: '13px', fontWeight: 600, color: T.onSurface }}>Include all CRM leads</div>
                  <div style={{ fontSize: '10px', color: T.onSurfaceVariant }}>Every lead with an email on file</div>
                </div>
              </label>

              {/* CSV Upload button */}
              <button
                onClick={() => csvInputRef.current?.click()}
                style={{
                  display: 'flex', alignItems: 'center', gap: '8px',
                  padding: '10px 14px',
                  borderRadius: T.radiusLg,
                  border: 'none',
                  backgroundColor: T.surfaceContainerLow,
                  color: T.onSurfaceVariant,
                  fontSize: '13px', fontWeight: 600, cursor: 'pointer',
                  fontFamily: 'Inter, sans-serif', textAlign: 'left',
                  width: '100%',
                }}
              >
                <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>upload_file</span>
                CSV Upload (with merge columns)
              </button>
              <input ref={csvInputRef} type="file" accept=".csv" style={{ display: 'none' }}
                onChange={e => { const f = e.target.files?.[0]; if (f) handleCsvUpload(f); }} />
            </div>

            {/* Manual Entry / Paste emails */}
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
                <span style={alpineLabel({ marginBottom: 0 })}>Paste Emails</span>
                <span style={{ fontSize: '10px', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '5px' }}>
                  {validationResult && (
                    <span style={{ color: validationResult.invalid > 0 ? '#dc2626' : '#16a34a' }}>
                      {validationResult.valid} valid · {validationResult.invalid} invalid
                    </span>
                  )}
                </span>
              </div>
              <textarea
                value={form.manualEmails}
                onChange={e => {
                  const val = e.target.value;
                  setForm(f => ({ ...f, manualEmails: val }));
                  triggerValidation(val);
                }}
                placeholder="email1@company.com, email2@company.com..."
                style={{
                  ...alpineInput({ resize: 'vertical' as const, minHeight: '80px', lineHeight: '1.5' }),
                  fontFamily: '"Fira Code", monospace',
                  fontSize: '12px',
                  borderBottom: validationResult
                    ? `2px solid ${validationResult.invalid > 0 ? '#dc2626' : '#16a34a'}`
                    : undefined,
                }}
                onFocus={e => { e.target.style.background = '#e8eaeb'; e.target.style.outline = '2px solid rgba(0,54,26,0.2)'; }}
                onBlur={e => { e.target.style.background = T.surfaceContainerLow; e.target.style.outline = 'none'; }}
              />

              {/* Validation results */}
              {validationResult && (
                <div style={{ marginTop: '6px' }}>
                  <div style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    padding: '8px 12px',
                    backgroundColor: validationResult.invalid > 0 ? 'rgba(220,38,38,0.06)' : 'rgba(22,163,74,0.06)',
                    borderRadius: T.radiusLg,
                    marginBottom: validationResult.invalid > 0 ? '6px' : 0,
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px' }}>
                      <span className="material-symbols-outlined" style={{ fontSize: '14px', color: validationResult.invalid > 0 ? '#dc2626' : '#16a34a' }}>
                        {validationResult.invalid > 0 ? 'error' : 'check_circle'}
                      </span>
                      <span style={{ fontWeight: 600, color: validationResult.invalid > 0 ? '#dc2626' : '#16a34a' }}>
                        {validationResult.invalid > 0
                          ? `${validationResult.invalid} rejected · ${validationResult.valid} valid`
                          : `All ${validationResult.valid} emails look valid ✓`}
                      </span>
                    </div>
                    {validationResult.invalid > 0 && (
                      <button onClick={removeBadEmails} style={{
                        fontSize: '11px', fontWeight: 700, color: '#dc2626',
                        background: 'none', border: '1px solid #dc2626',
                        borderRadius: '6px', padding: '2px 10px', cursor: 'pointer',
                        fontFamily: 'Inter, sans-serif',
                      }}>
                        Remove all invalid
                      </button>
                    )}
                  </div>

                  {validationResult.results.filter(r => !r.valid).length > 0 && (
                    <div style={{
                      backgroundColor: T.surfaceContainerLow,
                      borderRadius: T.radiusLg,
                      overflow: 'hidden',
                    }}>
                      {validationResult.results.filter(r => !r.valid).map((r, i, arr) => (
                        <div key={i} style={{
                          display: 'flex', alignItems: 'center', gap: '8px',
                          padding: '7px 12px',
                          borderBottom: i < arr.length - 1 ? `1px solid ${T.surfaceContainer}` : 'none',
                        }}>
                          <span className="material-symbols-outlined" style={{ fontSize: '13px', color: '#dc2626', flexShrink: 0 }}>
                            cancel
                          </span>
                          <span style={{ fontSize: '11px', fontFamily: '"Fira Code", monospace', color: T.onSurface, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {r.email}
                          </span>
                          <span style={{
                            fontSize: '10px', fontWeight: 700, color: '#dc2626',
                            backgroundColor: 'rgba(220,38,38,0.08)', borderRadius: T.radiusFull,
                            padding: '2px 7px', flexShrink: 0,
                          }}>
                            Bad format
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* ── Merge placeholder chips (default {email} + CSV columns) */}
            <div style={{ marginTop: '10px' }}>
              <div style={{ fontSize: '10px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: T.onSurfaceVariant, marginBottom: '6px' }}>
                Personalisation tags — click to copy
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                {['email', ...form.mergeColumns].map(col => (
                  <button
                    key={col}
                    onClick={() => {
                      navigator.clipboard?.writeText(`{${col}}`);
                      setToast({ msg: `{${col}} copied to clipboard`, type: 'success' });
                    }}
                    title={`Copy {${col}} to clipboard then paste into your email subject or body`}
                    style={{
                      padding: '3px 10px',
                      borderRadius: T.radiusFull,
                      border: `1.5px solid rgba(0,54,26,0.2)`,
                      background: 'rgba(0,54,26,0.05)',
                      color: T.primary,
                      fontSize: '11px', fontWeight: 700,
                      cursor: 'pointer',
                      fontFamily: '"Fira Code", monospace',
                      transition: 'all 0.15s',
                    }}
                    onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(0,54,26,0.12)'; }}
                    onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(0,54,26,0.05)'; }}
                  >
                    {`{${col}}`}
                  </button>
                ))}
              </div>
              <div style={{ fontSize: '10px', color: T.onSurfaceVariant, marginTop: '5px' }}>
                Use these tags in your subject line or email body. Each recipient sees their own value.
              </div>
            </div>

            {/* Recipient count pill */}
            {recipientCount > 0 && (
              <div style={{
                marginTop: '10px',
                display: 'inline-flex', alignItems: 'center', gap: '6px',
                padding: '6px 12px',
                backgroundColor: 'rgba(0,54,26,0.07)',
                borderRadius: T.radiusFull,
              }}>
                <span className="material-symbols-outlined" style={{ fontSize: '14px', color: T.primary }}>people</span>
                <span style={{ fontSize: '12px', fontWeight: 700, color: T.primary }}>
                  {form.includeAllLeads
                    ? `All CRM leads${manualCount > 0 ? ` + ${manualCount.toLocaleString()}` : ''}`
                    : `${manualCount.toLocaleString()} recipients`}
                </span>
              </div>
            )}
          </PanelSection>

          {/* ── Senders ── */}
          <PanelSection>
            <PanelSectionTitle icon="alternate_email">Send From</PanelSectionTitle>

            {noSenders ? (
              <div style={{
                padding: '14px',
                borderRadius: T.radiusLg,
                backgroundColor: 'rgba(200,168,75,0.10)',
                fontSize: '12px', color: T.onSurface, lineHeight: 1.5,
              }}>
                <div style={{ fontWeight: 700, marginBottom: '4px' }}>No active mailboxes connected.</div>
                Connect at least one mailbox so the campaign has somewhere to send from.
                <Link href="/settings/email" style={{
                  marginTop: '8px', display: 'inline-block', fontWeight: 700,
                  color: T.primary, textDecoration: 'underline',
                }}>
                  Connect a sender →
                </Link>
              </div>
            ) : (
              <>
                <div style={{ fontSize: '11px', color: T.onSurfaceVariant, marginBottom: '10px', lineHeight: 1.4 }}>
                  Pick one or more — the campaign rotates evenly across them.
                </div>
                <div style={{ display: 'grid', gap: '8px' }}>
                  {activeSenders.map(s => {
                    const on = form.senderIds.includes(s.id);
                    const cap = Math.max(1, s.warmup.daily_cap_today);
                    const ratio = Math.min(100, Math.round((s.warmup.sent_today / cap) * 100));
                    return (
                      <label key={s.id} style={{
                        display: 'flex', flexDirection: 'column', gap: '6px',
                        padding: '10px 12px',
                        borderRadius: T.radiusLg,
                        cursor: 'pointer',
                        backgroundColor: on ? 'rgba(0,54,26,0.08)' : T.surfaceContainerLow,
                        transition: 'background 0.15s',
                      }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                          <input
                            type="checkbox"
                            checked={on}
                            onChange={() => toggleSender(s.id)}
                            style={{ width: '15px', height: '15px', accentColor: T.primary, flexShrink: 0 }}
                          />
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: '12px', fontWeight: 700, color: T.onSurface, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {s.from_address || s.label || s.provider}
                            </div>
                            <div style={{ fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.05em', color: T.onSurfaceVariant }}>
                              {s.provider}
                            </div>
                          </div>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '10px', color: T.onSurfaceVariant }}>
                          <span>warmup {s.warmup.sent_today}/{s.warmup.daily_cap_today} today</span>
                        </div>
                        <div style={{ height: '3px', background: T.surfaceContainer, borderRadius: '99px', overflow: 'hidden' }}>
                          <div style={{
                            height: '100%', width: `${ratio}%`,
                            background: ratio >= 100 ? T.saffron : '#16a34a',
                            transition: 'width 0.3s',
                          }} />
                        </div>
                      </label>
                    );
                  })}
                </div>
                <div style={{ fontSize: '10px', color: T.onSurfaceVariant, marginTop: '8px' }}>
                  {form.senderIds.length === 0
                    ? `Select at least one of ${activeSenders.length} active mailbox${activeSenders.length === 1 ? '' : 'es'}.`
                    : `${form.senderIds.length} of ${activeSenders.length} selected.`}
                </div>
              </>
            )}
          </PanelSection>

          {/* ── Sending Options ── */}
          <PanelSection>
            <PanelSectionTitle icon="tune">Sending Options</PanelSectionTitle>

            {/* Row 1: Batch + Delay */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '12px' }}>
              {/* Batch size */}
              <div>
                <span style={alpineLabel()}>Batch size / tick</span>
                <input
                  type="number"
                  min={1}
                  max={50}
                  value={form.batchSize}
                  onChange={e => setForm(f => ({ ...f, batchSize: Math.max(1, Math.min(50, parseInt(e.target.value) || 1)) }))}
                  style={alpineInput({ padding: '8px 10px', fontSize: '13px' })}
                  onFocus={e => { e.target.style.background = '#e8eaeb'; e.target.style.outline = '2px solid rgba(0,54,26,0.2)'; }}
                  onBlur={e => { e.target.style.background = T.surfaceContainerLow; e.target.style.outline = 'none'; }}
                />
                <span style={{ fontSize: '10px', color: T.onSurfaceVariant, marginTop: '3px', display: 'block' }}>
                  Emails per scheduler tick
                </span>
              </div>

              {/* Delay between emails */}
              <div>
                <span style={alpineLabel()}>Delay between sends (sec)</span>
                <input
                  type="number"
                  min={0}
                  max={3600}
                  value={form.sendDelay}
                  onChange={e => setForm(f => ({ ...f, sendDelay: Math.max(0, parseInt(e.target.value) || 0) }))}
                  style={alpineInput({ padding: '8px 10px', fontSize: '13px' })}
                  onFocus={e => { e.target.style.background = '#e8eaeb'; e.target.style.outline = '2px solid rgba(0,54,26,0.2)'; }}
                  onBlur={e => { e.target.style.background = T.surfaceContainerLow; e.target.style.outline = 'none'; }}
                />
                <span style={{ fontSize: '10px', color: T.onSurfaceVariant, marginTop: '3px', display: 'block' }}>
                  Throttles send rate to avoid spam flags
                </span>
              </div>
            </div>

            {/* Row 2: Daily limit */}
            <div style={{ marginBottom: '14px' }}>
              <span style={alpineLabel()}>Daily send limit</span>
              <input
                type="number"
                min={0}
                value={form.dailyLimit}
                onChange={e => setForm(f => ({ ...f, dailyLimit: Math.max(0, parseInt(e.target.value) || 0) }))}
                style={alpineInput({ padding: '8px 10px', fontSize: '13px', width: '50%' })}
                onFocus={e => { e.target.style.background = '#e8eaeb'; e.target.style.outline = '2px solid rgba(0,54,26,0.2)'; }}
                onBlur={e => { e.target.style.background = T.surfaceContainerLow; e.target.style.outline = 'none'; }}
              />
              <span style={{ fontSize: '10px', color: T.onSurfaceVariant, marginTop: '3px', display: 'block' }}>
                0 = unlimited. Providers typically cap at 300–500/day.
              </span>
            </div>

            {/* Warmup toggle */}
            <label style={{
              display: 'flex', alignItems: 'center', gap: '10px',
              padding: '10px 12px',
              borderRadius: T.radiusLg,
              cursor: 'pointer',
              backgroundColor: form.warmupEnabled ? 'rgba(0,54,26,0.07)' : T.surfaceContainerLow,
              marginBottom: '12px',
            }}>
              <input
                type="checkbox"
                checked={form.warmupEnabled}
                onChange={e => setForm(f => ({ ...f, warmupEnabled: e.target.checked }))}
                style={{ width: '15px', height: '15px', accentColor: T.primary, flexShrink: 0 }}
              />
              <span className="material-symbols-outlined" style={{ fontSize: '16px', color: form.warmupEnabled ? T.primary : T.onSurfaceVariant }}>
                trending_up
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: '12px', fontWeight: 700, color: T.onSurface }}>Warmup enabled</div>
                <div style={{ fontSize: '10px', color: T.onSurfaceVariant }}>Ramp volume gradually per mailbox</div>
              </div>
            </label>

            {/* Validate Emails button */}
            <button
              onClick={validateNow}
              style={{
                display: 'flex', alignItems: 'center', gap: '6px',
                padding: '8px 14px',
                borderRadius: T.radiusFull,
                border: `1.5px solid ${T.surfaceContainer}`,
                background: T.surfaceContainerLowest,
                color: T.onSurface,
                fontSize: '12px', fontWeight: 600,
                cursor: 'pointer',
                transition: 'all 0.15s',
                fontFamily: 'Inter, system-ui, sans-serif',
              }}
              onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = T.surfaceContainerLow; }}
              onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = T.surfaceContainerLowest; }}
            >
              <span className="material-symbols-outlined" style={{ fontSize: '14px', color: T.primary }}>fact_check</span>
              Validate Emails
            </button>
          </PanelSection>

          {/* ── Campaign Health Trackers (left panel, always visible) ── */}
          <div style={{
            borderTop: `1px solid ${T.surfaceContainer}`,
            backgroundColor: T.surfaceContainerLow,
            padding: '16px 20px',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '14px' }}>
              <span className="material-symbols-outlined" style={{ fontSize: '14px', color: T.saffron }}>
                health_and_safety
              </span>
              <span style={{
                fontSize: '11px', fontWeight: 700, textTransform: 'uppercase',
                letterSpacing: '0.07em', color: T.onSurfaceVariant,
                fontFamily: 'Manrope, Inter, sans-serif',
              }}>
                Campaign Health
              </span>
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '4px' }}>
              <RingDial
                value={health.completionPct}
                label="Completion"
                color={ringColor(health.completionPct)}
                sublabel={`${health.completionItems.filter(i => i.done).length}/${health.completionItems.length} done`}
              />
              <RingDial
                value={health.optimizationScore}
                label="Optimisation"
                color={ringColor(health.optimizationScore)}
                sublabel="out of 100"
              />
              <RingDial
                value={health.goalProbability}
                label="Goal Achieve"
                color={ringColor(health.goalProbability)}
                sublabel={health.performanceLabel}
              />
            </div>

            <div style={{ marginTop: '14px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '5px' }}>
                <span style={{ fontSize: '10px', fontWeight: 600, color: T.onSurfaceVariant }}>Setup Progress</span>
                <span style={{ fontSize: '10px', fontWeight: 700, color: ringColor(health.completionPct) }}>
                  {health.completionPct}%
                </span>
              </div>
              <div style={{ height: '4px', background: T.surfaceContainer, borderRadius: '99px', overflow: 'hidden' }}>
                <div style={{
                  height: '100%', borderRadius: '99px',
                  width: `${health.completionPct}%`,
                  background: ringColor(health.completionPct),
                  transition: 'width 0.4s ease',
                }} />
              </div>
            </div>

            {health.tips.length > 0 && (
              <div style={{
                marginTop: '12px',
                background: 'rgba(200,168,75,0.08)',
                borderRadius: T.radiusLg,
                padding: '10px 12px',
              }}>
                <div style={{
                  fontSize: '10px', fontWeight: 700, color: '#92400e',
                  marginBottom: '6px',
                  display: 'flex', alignItems: 'center', gap: '4px',
                }}>
                  <span className="material-symbols-outlined" style={{ fontSize: '12px' }}>tips_and_updates</span>
                  Top improvements
                </div>
                {health.tips.map((tip, i) => (
                  <div key={i} style={{
                    display: 'flex', alignItems: 'flex-start', gap: '5px',
                    fontSize: '11px', color: T.onSurface,
                    marginBottom: i < health.tips.length - 1 ? '4px' : 0,
                  }}>
                    <span style={{ color: T.saffron, fontWeight: 700, flexShrink: 0 }}>{i + 1}.</span>
                    {tip}
                  </div>
                ))}
              </div>
            )}
          </div>

        </div>
        {/* ─── END LEFT PANEL ──────────────────────────────────────────────── */}

        {/* ─── RIGHT PANEL (main editor area) ─────────────────────────────── */}
        <div style={{
          flex: 1,
          minWidth: 0,
          display: 'flex',
          flexDirection: 'column',
          backgroundColor: T.surface,
          overflowY: 'auto',
          height: 'calc(100vh - 60px)',
        }}>

          {/* Page header text */}
          <div style={{ padding: '28px 32px 0', flexShrink: 0 }}>
            <p style={{
              fontSize: '13px', color: T.onSurfaceVariant, margin: '4px 0 0',
              maxWidth: '520px', lineHeight: '1.5',
            }}>
              Each recipient gets an individual email (no BCC blast), rotated across your connected mailboxes with warmup pacing.
            </p>
          </div>

          {/* ── Email Content Editor Card ── */}
          <div style={{
            margin: '20px 32px 0',
            backgroundColor: T.surfaceContainerLowest,
            borderRadius: T.radiusXl,
            overflow: 'hidden',
            flexShrink: 0,
          }}>

            {/* Tab bar + header row */}
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '14px 20px',
              borderBottom: `1px solid ${T.surfaceContainer}`,
              gap: '12px',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span className="material-symbols-outlined" style={{ fontSize: '16px', color: T.saffron }}>edit_note</span>
                <span style={{ fontSize: '13px', fontWeight: 700, color: T.onSurface, fontFamily: 'Manrope, Inter, sans-serif' }}>
                  Email Content
                </span>
              </div>

              {/* Connected tabs */}
              <div style={{
                display: 'inline-flex',
                backgroundColor: T.surfaceContainerLow,
                borderRadius: T.radiusLg,
                padding: '3px',
                gap: '2px',
              }}>
                {([
                  { mode: 'html'   as const, label: 'Write HTML' },
                  { mode: 'upload' as const, label: 'Upload HTML' },
                  { mode: 'visual' as const, label: 'Preview' },
                ]).map(({ mode, label: lbl }) => {
                  const active = form.contentMode === mode;
                  return (
                    <button
                      key={mode}
                      onClick={() => setForm(f => ({ ...f, contentMode: mode }))}
                      style={{
                        padding: '6px 14px',
                        borderRadius: '6px',
                        border: 'none',
                        backgroundColor: active ? T.surfaceContainerLowest : 'transparent',
                        color: active ? T.primary : T.onSurfaceVariant,
                        fontSize: '12px',
                        fontWeight: active ? 700 : 500,
                        cursor: 'pointer',
                        fontFamily: 'Inter, sans-serif',
                        transition: 'all 0.15s',
                        boxShadow: active ? '0 1px 3px rgba(0,0,0,0.08)' : 'none',
                        borderBottom: active ? `2px solid ${T.primary}` : '2px solid transparent',
                      }}
                    >
                      {lbl}
                    </button>
                  );
                })}
              </div>

              {/* Expand / fullscreen hint */}
              <button
                onClick={() => setShowSplitPreview(v => !v)}
                style={{
                  background: 'none', border: 'none', cursor: 'pointer',
                  display: 'flex', alignItems: 'center', color: T.onSurfaceVariant,
                  padding: '4px',
                }}
                title="Toggle split preview"
              >
                <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>
                  {showSplitPreview ? 'fullscreen_exit' : 'fullscreen'}
                </span>
              </button>
            </div>

            {/* ── Health strip (inside editor card, below tabs) ── */}
            <div style={{
              padding: '12px 20px',
              backgroundColor: T.surfaceContainer,
              borderBottom: `1px solid ${T.surfaceContainerLow}`,
              display: 'flex', alignItems: 'center', gap: '0',
            }}>
              <RingDial
                value={health.completionPct}
                label="Completion"
                color={ringColor(health.completionPct)}
                sublabel={`${health.completionItems.filter(i => i.done).length}/${health.completionItems.length} done`}
              />
              <div style={{ width: '1px', height: '56px', backgroundColor: T.surfaceContainerLow }} />
              <RingDial
                value={health.optimizationScore}
                label="Optimisation"
                color={ringColor(health.optimizationScore)}
                sublabel="out of 100"
              />
              <div style={{ width: '1px', height: '56px', backgroundColor: T.surfaceContainerLow }} />
              <RingDial
                value={health.goalProbability}
                label="Goal Achievement"
                color={ringColor(health.goalProbability)}
                sublabel={health.performanceLabel.charAt(0).toUpperCase() + health.performanceLabel.slice(1)}
              />

              <button
                onClick={() => setHealthOpen(v => !v)}
                style={{
                  marginLeft: 'auto',
                  display: 'flex', alignItems: 'center', gap: '5px',
                  padding: '6px 12px',
                  borderRadius: T.radiusLg,
                  border: 'none',
                  backgroundColor: T.surfaceContainerLow,
                  color: T.onSurfaceVariant,
                  fontSize: '11px', fontWeight: 600, cursor: 'pointer',
                  fontFamily: 'Inter, sans-serif',
                  flexShrink: 0,
                }}
              >
                <span className="material-symbols-outlined" style={{ fontSize: '14px' }}>
                  {healthOpen ? 'expand_less' : 'checklist'}
                </span>
                {healthOpen ? 'Hide' : 'Checklist'}
              </button>
            </div>

            {/* Collapsible health details */}
            {healthOpen && (
              <div style={{
                padding: '20px 24px',
                backgroundColor: T.surfaceContainer,
                borderBottom: `1px solid ${T.surfaceContainerLow}`,
                display: 'grid',
                gridTemplateColumns: '1fr 1fr',
                gap: '20px',
              }}>
                {/* LEFT: Optimisation breakdown */}
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' }}>
                    <span style={{ fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', color: T.onSurfaceVariant }}>
                      Optimisation Checklist
                    </span>
                    <span style={{ fontSize: '11px', fontWeight: 700, color: ringColor(health.optimizationScore) }}>
                      {health.optimizationScore}/100
                    </span>
                  </div>
                  <div style={{ height: '4px', background: T.surfaceContainerLow, borderRadius: '99px', marginBottom: '12px', overflow: 'hidden' }}>
                    <div style={{ height: '100%', width: `${health.optimizationScore}%`, background: ringColor(health.optimizationScore), borderRadius: '99px', transition: 'width 0.4s ease' }} />
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
                    {health.optimizationItems.map((item, i) => (
                      <div key={i} style={{
                        display: 'flex', alignItems: 'flex-start', gap: '7px',
                        padding: '6px 8px',
                        borderRadius: '6px',
                        backgroundColor: item.done ? 'rgba(22,163,74,0.05)' : 'rgba(220,38,38,0.04)',
                      }}>
                        <span className="material-symbols-outlined" style={{
                          fontSize: '13px', flexShrink: 0, marginTop: '1px',
                          color: item.done ? '#16a34a' : '#dc2626',
                        }}>
                          {item.done ? 'check_circle' : 'cancel'}
                        </span>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <span style={{ fontSize: '11px', fontWeight: 600, color: item.done ? T.onSurface : T.onSurfaceVariant }}>
                              {item.label}
                            </span>
                            <span style={{
                              fontSize: '10px', fontWeight: 700,
                              color: item.done ? '#16a34a' : '#dc2626',
                              backgroundColor: item.done ? 'rgba(22,163,74,0.1)' : 'rgba(220,38,38,0.08)',
                              borderRadius: '99px', padding: '1px 6px', flexShrink: 0, marginLeft: '4px',
                            }}>
                              +{item.points}pts
                            </span>
                          </div>
                          {!item.done && item.tip && (
                            <p style={{ margin: '2px 0 0', fontSize: '10px', color: T.onSurfaceVariant, lineHeight: 1.4 }}>
                              {item.tip}
                            </p>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* RIGHT: Goal Achievement breakdown */}
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' }}>
                    <span style={{ fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', color: T.onSurfaceVariant }}>
                      Goal Achievement
                    </span>
                    <span style={{ fontSize: '11px', fontWeight: 700, color: ringColor(health.goalProbability) }}>
                      {health.goalProbability}% — {health.performanceLabel.charAt(0).toUpperCase() + health.performanceLabel.slice(1)}
                    </span>
                  </div>

                  <div style={{
                    background: 'rgba(0,54,26,0.05)', borderRadius: T.radiusLg,
                    padding: '10px 12px', marginBottom: '12px',
                  }}>
                    <p style={{ margin: '0 0 4px', fontSize: '10px', fontWeight: 700, color: T.primary, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                      How it&apos;s calculated
                    </p>
                    <p style={{ margin: 0, fontSize: '11px', color: T.onSurface, lineHeight: 1.5 }}>
                      <strong>Optimisation Score ({health.optimizationScore})</strong> × <strong>Goal Multiplier ({GOALS.find(g => g.value === form.goal)?.multiplier ?? 0.65}×)</strong> = <strong style={{ color: ringColor(health.goalProbability) }}>{health.goalProbability}%</strong>
                    </p>
                    <p style={{ margin: '4px 0 0', fontSize: '10px', color: T.onSurfaceVariant, lineHeight: 1.4 }}>
                      Each goal type has a difficulty multiplier. Boost your Optimisation score to raise Goal Achievement proportionally.
                    </p>
                  </div>

                  <p style={{ margin: '0 0 8px', fontSize: '11px', fontWeight: 700, color: T.onSurface }}>
                    To reach 100% — fix these first:
                  </p>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
                    {health.optimizationItems
                      .filter(i => !i.done)
                      .sort((a, b) => b.points - a.points)
                      .map((item, i) => (
                        <div key={i} style={{
                          display: 'flex', alignItems: 'flex-start', gap: '7px',
                          padding: '7px 10px',
                          borderRadius: '6px',
                          backgroundColor: T.surfaceContainerLow,
                          borderLeft: `3px solid ${i === 0 ? '#dc2626' : i === 1 ? T.saffron : T.surfaceContainer}`,
                        }}>
                          <span style={{
                            fontSize: '10px', fontWeight: 800,
                            color: '#fff',
                            backgroundColor: i === 0 ? '#dc2626' : i === 1 ? '#92400e' : T.onSurfaceVariant,
                            borderRadius: '4px', padding: '1px 5px', flexShrink: 0, marginTop: '1px',
                          }}>
                            #{i + 1}
                          </span>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                              <span style={{ fontSize: '11px', fontWeight: 600, color: T.onSurface }}>{item.label}</span>
                              <span style={{ fontSize: '10px', fontWeight: 700, color: T.saffron, flexShrink: 0, marginLeft: '4px' }}>+{item.points}pts</span>
                            </div>
                            {item.tip && (
                              <p style={{ margin: '2px 0 0', fontSize: '10px', color: T.onSurfaceVariant, lineHeight: 1.4 }}>{item.tip}</p>
                            )}
                          </div>
                        </div>
                      ))
                    }
                    {health.optimizationItems.filter(i => !i.done).length === 0 && (
                      <div style={{ padding: '12px', textAlign: 'center', color: '#16a34a', fontSize: '12px', fontWeight: 600 }}>
                        All optimisation checks passed!
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* ── Editor + Quick Preview split ── */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 280px', minHeight: '460px' }}>

              {/* Left: editor area */}
              <div style={{ borderRight: `1px solid ${T.surfaceContainer}`, display: 'flex', flexDirection: 'column' }}>

                {/* HTML Code mode */}
                {form.contentMode === 'html' && (
                  <textarea
                    value={form.htmlContent}
                    onChange={e => setForm(f => ({ ...f, htmlContent: e.target.value }))}
                    placeholder={'<!-- Paste your HTML here -->\n<div style="background:#f0f0fa; padding: 40px;">\n  <h1 style="font-family: Manrope; color: #00361a;">\n    Hi {first_name}\n  </h1>\n  <p>Quick idea for {company}.</p>\n</div>'}
                    style={{
                      flex: 1,
                      display: 'block',
                      width: '100%',
                      minHeight: '460px',
                      padding: '18px 20px',
                      backgroundColor: '#1e1e1e',
                      color: '#4ec9b0',
                      border: 'none',
                      fontFamily: '"Fira Code", "Courier New", monospace',
                      fontSize: '12.5px',
                      lineHeight: '1.65',
                      outline: 'none',
                      resize: 'none',
                      boxSizing: 'border-box',
                    }}
                  />
                )}

                {/* Visual Editor mode */}
                {form.contentMode === 'visual' && (
                  <div style={{ display: 'flex', flexDirection: 'column', flex: 1 }}>
                    <div style={{
                      display: 'flex', flexWrap: 'wrap', gap: '4px',
                      padding: '8px 14px',
                      backgroundColor: T.surfaceContainerLow,
                      borderBottom: `1px solid ${T.surfaceContainer}`,
                      flexShrink: 0,
                    }}>
                      {[
                        { icon: 'format_bold', action: () => exec('bold'), title: 'Bold' },
                        { icon: 'format_italic', action: () => exec('italic'), title: 'Italic' },
                        { icon: 'format_underline', action: () => exec('underline'), title: 'Underline' },
                        { icon: 'link', action: insertLink, title: 'Insert Link' },
                        { icon: 'format_list_bulleted', action: () => exec('insertUnorderedList'), title: 'Bullet List' },
                      ].map(btn => (
                        <button
                          key={btn.title}
                          title={btn.title}
                          onMouseDown={e => { e.preventDefault(); btn.action(); }}
                          style={{
                            padding: '5px 8px',
                            border: `1px solid ${T.surfaceContainer}`,
                            borderRadius: '6px',
                            background: T.surfaceContainerLowest,
                            cursor: 'pointer',
                            display: 'flex',
                            alignItems: 'center',
                            color: T.onSurfaceVariant,
                          }}
                        >
                          <span className="material-symbols-outlined" style={{ fontSize: '15px' }}>{btn.icon}</span>
                        </button>
                      ))}
                      <button
                        title="Heading 2"
                        onMouseDown={e => { e.preventDefault(); exec('formatBlock', 'h2'); }}
                        style={{
                          padding: '4px 8px', border: `1px solid ${T.surfaceContainer}`, borderRadius: '6px',
                          background: T.surfaceContainerLowest, cursor: 'pointer', color: T.onSurfaceVariant,
                          fontSize: '11px', fontWeight: 700,
                        }}
                      >
                        H2
                      </button>
                    </div>
                    <div
                      ref={editorRef}
                      contentEditable
                      suppressContentEditableWarning
                      onBlur={syncEditor}
                      onInput={syncEditor}
                      data-placeholder="Start writing your email content..."
                      style={{
                        flex: 1,
                        minHeight: '400px',
                        padding: '20px 24px',
                        backgroundColor: T.surfaceContainerLowest,
                        fontSize: '14px',
                        lineHeight: '1.7',
                        color: T.onSurface,
                        outline: 'none',
                      }}
                    />
                  </div>
                )}

                {/* Upload HTML mode */}
                {form.contentMode === 'upload' && (
                  <div style={{ padding: '24px', flex: 1 }}>
                    <div
                      onDragOver={e => { e.preventDefault(); setIsDragOver(true); }}
                      onDragLeave={() => setIsDragOver(false)}
                      onDrop={e => {
                        e.preventDefault();
                        setIsDragOver(false);
                        const file = e.dataTransfer.files[0];
                        if (file) handleHtmlFileUpload(file);
                      }}
                      onClick={() => htmlFileInputRef.current?.click()}
                      style={{
                        border: `2px dashed ${isDragOver ? T.primary : T.surfaceContainer}`,
                        borderRadius: T.radiusXl,
                        padding: '56px 24px',
                        textAlign: 'center',
                        cursor: 'pointer',
                        backgroundColor: isDragOver ? 'rgba(0,54,26,0.04)' : T.surfaceContainerLow,
                        transition: 'all 0.2s',
                      }}
                    >
                      <span className="material-symbols-outlined" style={{ fontSize: '40px', color: isDragOver ? T.primary : T.onSurfaceVariant, marginBottom: '12px', display: 'block' }}>
                        upload_file
                      </span>
                      <p style={{ fontSize: '14px', fontWeight: 600, color: T.onSurface, margin: '0 0 4px', fontFamily: 'Manrope, Inter, sans-serif' }}>
                        Drop your HTML file here
                      </p>
                      <p style={{ fontSize: '12px', color: T.onSurfaceVariant, margin: 0 }}>or click to browse — .html files only</p>
                    </div>
                    <input
                      ref={htmlFileInputRef}
                      type="file"
                      accept=".html,.htm"
                      style={{ display: 'none' }}
                      onChange={e => { const f = e.target.files?.[0]; if (f) handleHtmlFileUpload(f); }}
                    />
                    {form.htmlContent && (
                      <div style={{
                        marginTop: '12px', padding: '10px 14px',
                        backgroundColor: 'rgba(0,54,26,0.06)',
                        borderRadius: T.radiusLg, display: 'flex', alignItems: 'center', gap: '8px',
                      }}>
                        <span className="material-symbols-outlined" style={{ fontSize: '16px', color: T.primary }}>check_circle</span>
                        <span style={{ fontSize: '13px', color: T.primary, fontWeight: 600 }}>
                          HTML loaded ({form.htmlContent.length.toLocaleString()} characters)
                        </span>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Right: Quick Preview thumbnail */}
              <div style={{ display: 'flex', flexDirection: 'column', backgroundColor: T.surfaceContainerLow }}>
                <div style={{
                  padding: '10px 14px',
                  borderBottom: `1px solid ${T.surfaceContainer}`,
                  display: 'flex', alignItems: 'center', gap: '6px',
                  flexShrink: 0,
                }}>
                  <span className="material-symbols-outlined" style={{ fontSize: '13px', color: T.onSurfaceVariant }}>preview</span>
                  <span style={{ fontSize: '11px', fontWeight: 700, color: T.onSurfaceVariant, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                    Quick Preview
                  </span>
                  <div style={{ marginLeft: 'auto', display: 'flex', gap: '3px' }}>
                    <button
                      onClick={() => setPreviewDevice('desktop')}
                      style={{
                        padding: '3px 7px', borderRadius: '5px', border: 'none', cursor: 'pointer',
                        backgroundColor: previewDevice === 'desktop' ? T.primary : T.surfaceContainer,
                        color: previewDevice === 'desktop' ? '#fff' : T.onSurfaceVariant,
                        display: 'flex', alignItems: 'center',
                      }}
                    >
                      <span className="material-symbols-outlined" style={{ fontSize: '13px' }}>computer</span>
                    </button>
                    <button
                      onClick={() => setPreviewDevice('mobile')}
                      style={{
                        padding: '3px 7px', borderRadius: '5px', border: 'none', cursor: 'pointer',
                        backgroundColor: previewDevice === 'mobile' ? T.primary : T.surfaceContainer,
                        color: previewDevice === 'mobile' ? '#fff' : T.onSurfaceVariant,
                        display: 'flex', alignItems: 'center',
                      }}
                    >
                      <span className="material-symbols-outlined" style={{ fontSize: '13px' }}>smartphone</span>
                    </button>
                  </div>
                </div>

                <div style={{
                  flex: 1,
                  padding: '10px',
                  minHeight: '380px',
                  display: 'flex',
                  flexDirection: 'column',
                }}>
                  <div style={{
                    flex: 1,
                    minHeight: '360px',
                    borderRadius: T.radiusLg,
                    boxShadow: '0 2px 12px rgba(0,0,0,0.1)',
                    overflow: 'hidden',
                    backgroundColor: '#ffffff',
                    display: 'flex',
                    flexDirection: 'column',
                  }}>
                    <iframe
                      srcDoc={
                        currentHtml ||
                        '<div style="padding:40px 24px;text-align:center;font-family:Inter,sans-serif;color:#9ca3af"><div style="font-size:32px;margin-bottom:12px">✉</div><p style="font-size:13px;margin:0;line-height:1.6">Start writing HTML<br/>to see a live preview</p></div>'
                      }
                      style={{
                        border: 'none',
                        width: previewDevice === 'mobile' ? '375px' : '100%',
                        maxWidth: '100%',
                        flex: 1,
                        minHeight: '360px',
                        display: 'block',
                        backgroundColor: '#ffffff',
                      }}
                      sandbox="allow-same-origin"
                      title="Quick Email Preview"
                    />
                  </div>
                </div>
              </div>

            </div>
          </div>
          {/* ── END Email Content Card ── */}

          {/* ── Follow-up Sequence ── */}
          <div style={{ margin: '24px 32px', flexShrink: 0 }}>

            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              marginBottom: '16px',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span className="material-symbols-outlined" style={{ fontSize: '18px', color: T.saffron }}>auto_mode</span>
                <h2 style={{
                  fontSize: '17px', fontWeight: 800, color: T.onSurface, margin: 0,
                  fontFamily: 'Manrope, Inter, sans-serif', letterSpacing: '-0.02em',
                }}>
                  Follow-up Sequence
                </h2>
              </div>
              <button
                onClick={addFollowUp}
                style={{
                  display: 'flex', alignItems: 'center', gap: '6px',
                  padding: '8px 16px',
                  borderRadius: T.radiusLg,
                  border: 'none',
                  background: T.gradientCTA,
                  color: '#fff',
                  fontSize: '12px', fontWeight: 700, cursor: 'pointer',
                  fontFamily: 'Inter, sans-serif',
                  boxShadow: '0 2px 8px rgba(0,54,26,0.2)',
                }}
              >
                <span className="material-symbols-outlined" style={{ fontSize: '15px' }}>add</span>
                Add Sequence Step
              </button>
            </div>

            {/* Steps timeline */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0' }}>
              {form.followUps.map((fu, idx) => (
                <div key={fu.id} style={{ display: 'flex', gap: '0', alignItems: 'stretch' }}>
                  {/* Timeline connector */}
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: '40px', flexShrink: 0 }}>
                    <div style={{
                      width: '28px', height: '28px', borderRadius: T.radiusFull,
                      backgroundColor: T.primary, color: '#fff',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: '12px', fontWeight: 800, flexShrink: 0,
                      fontFamily: 'Manrope, Inter, sans-serif',
                      marginTop: '16px',
                    }}>
                      {idx + 1}
                    </div>
                    {idx < form.followUps.length - 1 && (
                      <div style={{ width: '2px', flex: 1, backgroundColor: T.surfaceContainer, margin: '4px 0' }} />
                    )}
                  </div>

                  {/* Step card */}
                  <div style={{
                    flex: 1,
                    margin: '10px 0 16px',
                    backgroundColor: T.surfaceContainerLowest,
                    borderRadius: T.radiusXl,
                    overflow: 'hidden',
                  }}>
                    <div style={{
                      padding: '14px 18px',
                      backgroundColor: T.surfaceContainerLow,
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                      gap: '10px',
                    }}>
                      <div>
                        <div style={{ fontSize: '13px', fontWeight: 700, color: T.onSurface, fontFamily: 'Manrope, Inter, sans-serif' }}>
                          Sequence Step #{idx + 1}: {fu.subject || 'Follow-up'}
                        </div>
                        <div style={{ fontSize: '11px', color: T.onSurfaceVariant, marginTop: '2px' }}>
                          {fu.scheduleType === 'delay'
                            ? `Triggers ${fu.delayValue} ${fu.delayUnit} after the initial email`
                            : `Sends at ${fu.scheduleAt || 'specific time'}`}
                        </div>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <button
                          onClick={() => duplicateFollowUp(idx)}
                          title="Duplicate"
                          style={{
                            background: 'none', border: `1px solid ${T.surfaceContainer}`,
                            cursor: 'pointer', color: T.onSurfaceVariant,
                            display: 'flex', alignItems: 'center',
                            borderRadius: '6px', padding: '5px 8px',
                          }}
                        >
                          <span className="material-symbols-outlined" style={{ fontSize: '14px' }}>content_copy</span>
                        </button>
                        <button
                          onClick={() => removeFollowUp(idx)}
                          title="Delete step"
                          style={{
                            background: 'none', border: '1px solid rgba(220,38,38,0.2)',
                            cursor: 'pointer', color: '#dc2626',
                            display: 'flex', alignItems: 'center',
                            borderRadius: '6px', padding: '5px 8px',
                          }}
                        >
                          <span className="material-symbols-outlined" style={{ fontSize: '14px' }}>delete</span>
                        </button>
                      </div>
                    </div>

                    {/* HTML filename / content row */}
                    <div style={{
                      padding: '12px 18px',
                      borderBottom: `1px solid ${T.surfaceContainer}`,
                      display: 'flex', alignItems: 'center', gap: '10px',
                    }}>
                      <span className="material-symbols-outlined" style={{ fontSize: '15px', color: T.onSurfaceVariant }}>code</span>
                      <span style={{ fontSize: '12px', color: T.onSurfaceVariant, fontFamily: '"Fira Code", monospace', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {fu.htmlContent
                          ? `followup-${idx + 1}.html (${fu.htmlContent.length.toLocaleString()} chars)`
                          : 'No HTML content yet'}
                      </span>
                      <button
                        onClick={() => setShowPreviewFor(fu.id)}
                        style={{
                          display: 'flex', alignItems: 'center', gap: '5px',
                          padding: '5px 12px',
                          borderRadius: T.radiusLg,
                          border: `1px solid ${T.primary}`,
                          backgroundColor: 'transparent',
                          color: T.primary,
                          fontSize: '11px', fontWeight: 700, cursor: 'pointer',
                          fontFamily: 'Inter, sans-serif',
                          flexShrink: 0,
                        }}
                      >
                        <span className="material-symbols-outlined" style={{ fontSize: '13px' }}>visibility</span>
                        Preview
                      </button>
                    </div>

                    {/* Expandable editor area */}
                    <div style={{ padding: '16px 18px' }}>
                      {/* Subject */}
                      <div style={{ marginBottom: '12px' }}>
                        <span style={alpineLabel()}>Subject Line</span>
                        <input
                          style={alpineInput()}
                          value={fu.subject}
                          onChange={e => updateFollowUp(idx, { subject: e.target.value })}
                          placeholder="Follow-up subject line..."
                          onFocus={e => { e.target.style.background = '#e8eaeb'; e.target.style.outline = '2px solid rgba(0,54,26,0.2)'; }}
                          onBlur={e => { e.target.style.background = T.surfaceContainerLow; e.target.style.outline = 'none'; }}
                        />
                      </div>

                      {/* Mode tabs for follow-up */}
                      <div style={{ marginBottom: '10px' }}>
                        <span style={alpineLabel()}>Email Content</span>
                        <div style={{
                          display: 'inline-flex',
                          backgroundColor: T.surfaceContainerLow,
                          borderRadius: T.radiusLg,
                          padding: '3px',
                          gap: '2px',
                          marginBottom: '10px',
                        }}>
                          {([
                            { mode: 'html' as const, label: 'HTML Code' },
                            { mode: 'visual' as const, label: 'Visual' },
                            { mode: 'upload' as const, label: 'Upload' },
                          ]).map(({ mode, label: lbl }) => {
                            const active = fu.contentMode === mode;
                            return (
                              <button
                                key={mode}
                                onClick={() => updateFollowUp(idx, { contentMode: mode })}
                                style={{
                                  padding: '5px 12px',
                                  borderRadius: '6px',
                                  border: 'none',
                                  backgroundColor: active ? T.surfaceContainerLowest : 'transparent',
                                  color: active ? T.primary : T.onSurfaceVariant,
                                  fontSize: '11px', fontWeight: active ? 700 : 500,
                                  cursor: 'pointer', fontFamily: 'Inter, sans-serif',
                                  boxShadow: active ? '0 1px 3px rgba(0,0,0,0.08)' : 'none',
                                }}
                              >
                                {lbl}
                              </button>
                            );
                          })}
                        </div>

                        {/* HTML Code */}
                        {fu.contentMode === 'html' && (
                          <textarea
                            value={fu.htmlContent}
                            onChange={e => updateFollowUp(idx, { htmlContent: e.target.value })}
                            placeholder="<!-- Follow-up email HTML -->"
                            style={{
                              width: '100%', minHeight: '180px', padding: '12px',
                              backgroundColor: '#1e1e1e', color: '#4ec9b0',
                              border: 'none', borderRadius: T.radiusLg,
                              fontFamily: '"Fira Code", monospace', fontSize: '12px',
                              outline: 'none', resize: 'vertical', boxSizing: 'border-box',
                            }}
                          />
                        )}

                        {/* Visual Editor */}
                        {fu.contentMode === 'visual' && (
                          <div>
                            <div style={{
                              display: 'flex', flexWrap: 'wrap', gap: '3px',
                              padding: '6px', backgroundColor: T.surfaceContainerLow,
                              borderRadius: '6px 6px 0 0',
                              borderBottom: `1px solid ${T.surfaceContainer}`,
                            }}>
                              {fuToolbarBtn(idx, 'format_bold', () => execFu(idx, 'bold'), 'Bold')}
                              {fuToolbarBtn(idx, 'format_italic', () => execFu(idx, 'italic'), 'Italic')}
                              {fuToolbarBtn(idx, 'format_underline', () => execFu(idx, 'underline'), 'Underline')}
                              {fuToolbarBtn(idx, 'link', () => insertLinkFu(idx), 'Insert Link')}
                              <button
                                title="Heading 2"
                                onMouseDown={e => { e.preventDefault(); execFu(idx, 'formatBlock', 'h2'); }}
                                style={{
                                  padding: '3px 7px', border: `1px solid ${T.surfaceContainer}`, borderRadius: '5px',
                                  background: T.surfaceContainerLowest, cursor: 'pointer', color: T.onSurfaceVariant,
                                  fontSize: '11px', fontWeight: 700,
                                }}
                              >
                                H2
                              </button>
                              {fuToolbarBtn(idx, 'format_list_bulleted', () => execFu(idx, 'insertUnorderedList'), 'Bullet List')}
                            </div>
                            <div
                              ref={el => { fuEditorRefs.current[idx] = el; }}
                              contentEditable
                              suppressContentEditableWarning
                              onBlur={() => {
                                const el = fuEditorRefs.current[idx];
                                if (el) updateFollowUp(idx, { htmlContent: el.innerHTML });
                              }}
                              onInput={() => {
                                const el = fuEditorRefs.current[idx];
                                if (el) updateFollowUp(idx, { htmlContent: el.innerHTML });
                              }}
                              dangerouslySetInnerHTML={{ __html: fu.htmlContent }}
                              style={{
                                minHeight: '160px',
                                padding: '12px 14px',
                                border: `1px solid ${T.surfaceContainer}`,
                                borderRadius: '0 0 6px 6px',
                                backgroundColor: T.surfaceContainerLowest,
                                fontSize: '13px',
                                lineHeight: '1.6',
                                color: T.onSurface,
                                outline: 'none',
                              }}
                            />
                          </div>
                        )}

                        {/* Upload HTML */}
                        {fu.contentMode === 'upload' && (
                          <div>
                            <div
                              onDragOver={e => e.preventDefault()}
                              onDrop={e => {
                                e.preventDefault();
                                const file = e.dataTransfer.files[0];
                                if (file) handleFuHtmlFileUpload(idx, file);
                              }}
                              onClick={() => fuFileInputRefs.current[idx]?.click()}
                              style={{
                                border: `2px dashed ${T.surfaceContainer}`,
                                borderRadius: T.radiusLg,
                                padding: '28px 16px',
                                textAlign: 'center',
                                cursor: 'pointer',
                                backgroundColor: T.surfaceContainerLow,
                              }}
                            >
                              <span className="material-symbols-outlined" style={{ fontSize: '28px', color: T.onSurfaceVariant, marginBottom: '6px', display: 'block' }}>
                                upload_file
                              </span>
                              <p style={{ fontSize: '12px', fontWeight: 600, color: T.onSurface, margin: '0 0 3px' }}>
                                Drop HTML file here
                              </p>
                              <p style={{ fontSize: '11px', color: T.onSurfaceVariant, margin: 0 }}>or click to browse</p>
                            </div>
                            <input
                              ref={el => { fuFileInputRefs.current[idx] = el; }}
                              type="file"
                              accept=".html,.htm"
                              style={{ display: 'none' }}
                              onChange={e => { const f = e.target.files?.[0]; if (f) handleFuHtmlFileUpload(idx, f); }}
                            />
                            {fu.htmlContent && (
                              <div style={{
                                marginTop: '8px', padding: '8px 12px',
                                backgroundColor: 'rgba(0,54,26,0.06)',
                                borderRadius: T.radiusLg, display: 'flex', alignItems: 'center', gap: '6px',
                              }}>
                                <span className="material-symbols-outlined" style={{ fontSize: '13px', color: T.primary }}>check_circle</span>
                                <span style={{ fontSize: '11px', color: T.primary, fontWeight: 600 }}>
                                  HTML loaded ({fu.htmlContent.length.toLocaleString()} chars)
                                </span>
                              </div>
                            )}
                          </div>
                        )}
                      </div>

                      {/* Schedule (delay only — backend uses delay_hours) */}
                      <div>
                        <span style={alpineLabel({ marginBottom: '8px' })}>Schedule</span>
                        <div style={{
                          padding: '10px 14px',
                          borderRadius: T.radiusLg,
                          backgroundColor: 'rgba(0,54,26,0.06)',
                        }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                            <span style={{ fontSize: '12px', color: T.onSurfaceVariant }}>Send</span>
                            <input
                              type="number"
                              min={1}
                              value={fu.delayValue}
                              onChange={e => updateFollowUp(idx, { delayValue: parseInt(e.target.value) || 1 })}
                              style={alpineInput({ width: '68px', textAlign: 'center' as const, padding: '8px 10px' })}
                            />
                            <select
                              value={fu.delayUnit}
                              onChange={e => updateFollowUp(idx, { delayUnit: e.target.value as FollowUp['delayUnit'] })}
                              style={{
                                ...alpineInput({ width: 'auto', padding: '8px 10px' }),
                                cursor: 'pointer',
                              } as React.CSSProperties}
                            >
                              <option value="minutes">Minutes</option>
                              <option value="hours">Hours</option>
                              <option value="days">Days</option>
                            </select>
                            <span style={{ fontSize: '12px', color: T.onSurfaceVariant }}>after primary email</span>
                          </div>
                          <div style={{ marginTop: '5px', fontSize: '10px', color: T.onSurfaceVariant }}>
                            Approx: {calcDelayDate(fu.delayValue, fu.delayUnit)}
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              ))}

              {/* Add placeholder step (dashed) */}
              <div style={{ display: 'flex', gap: '0', alignItems: 'center' }}>
                <div style={{ width: '40px', display: 'flex', justifyContent: 'center', flexShrink: 0 }}>
                  <div style={{
                    width: '28px', height: '28px', borderRadius: T.radiusFull,
                    border: `2px dashed ${T.surfaceContainer}`,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    color: T.onSurfaceVariant,
                  }}>
                    <span className="material-symbols-outlined" style={{ fontSize: '14px' }}>add</span>
                  </div>
                </div>
                <div style={{
                  flex: 1,
                  margin: '8px 0',
                  padding: '14px 18px',
                  border: `2px dashed ${T.surfaceContainer}`,
                  borderRadius: T.radiusXl,
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  cursor: 'pointer',
                  transition: 'border-color 0.15s',
                }}
                  onClick={addFollowUp}
                >
                  <span style={{ fontSize: '12px', color: T.onSurfaceVariant, fontStyle: 'italic' }}>
                    Add another step to keep the momentum…
                  </span>
                  <span className="material-symbols-outlined" style={{ fontSize: '18px', color: T.onSurfaceVariant }}>
                    drag_indicator
                  </span>
                </div>
              </div>
            </div>
          </div>
          {/* ── END Follow-up Sequence ── */}

          {/* Bottom spacer */}
          <div style={{ height: '80px', flexShrink: 0 }} />

        </div>
        {/* ─── END RIGHT PANEL ────────────────────────────────────────────── */}

        {/* ─── DETACHED SPLIT PREVIEW PANEL ────────────────────────────────── */}
        {showSplitPreview && (
          <div style={{
            width: '400px',
            flexShrink: 0,
            position: 'sticky',
            top: '60px',
            height: 'calc(100vh - 60px)',
            borderLeft: `1px solid ${T.surfaceContainer}`,
            backgroundColor: T.surfaceContainerLowest,
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
          }}>
            <div style={{
              padding: '12px 16px',
              borderBottom: `1px solid ${T.surfaceContainer}`,
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              flexShrink: 0,
            }}>
              <span style={{ fontSize: '13px', fontWeight: 700, color: T.primary, fontFamily: 'Manrope, Inter, sans-serif' }}>
                Live Preview
              </span>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <button
                  onClick={() => setPreviewDevice('desktop')}
                  style={{
                    padding: '5px 10px', borderRadius: T.radiusLg,
                    border: 'none',
                    backgroundColor: previewDevice === 'desktop' ? T.primary : T.surfaceContainerLow,
                    color: previewDevice === 'desktop' ? '#fff' : T.onSurfaceVariant,
                    fontSize: '11px', fontWeight: 600, cursor: 'pointer',
                    fontFamily: 'Inter, sans-serif', display: 'flex', alignItems: 'center', gap: '4px',
                  }}
                >
                  <span className="material-symbols-outlined" style={{ fontSize: '13px' }}>computer</span>
                  Desktop
                </button>
                <button
                  onClick={() => setPreviewDevice('mobile')}
                  style={{
                    padding: '5px 10px', borderRadius: T.radiusLg,
                    border: 'none',
                    backgroundColor: previewDevice === 'mobile' ? T.primary : T.surfaceContainerLow,
                    color: previewDevice === 'mobile' ? '#fff' : T.onSurfaceVariant,
                    fontSize: '11px', fontWeight: 600, cursor: 'pointer',
                    fontFamily: 'Inter, sans-serif', display: 'flex', alignItems: 'center', gap: '4px',
                  }}
                >
                  <span className="material-symbols-outlined" style={{ fontSize: '13px' }}>smartphone</span>
                  Mobile
                </button>
                <button
                  onClick={() => setShowSplitPreview(false)}
                  style={{
                    background: 'none', border: 'none', cursor: 'pointer',
                    display: 'flex', alignItems: 'center', color: T.onSurfaceVariant, padding: '4px',
                  }}
                >
                  <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>close</span>
                </button>
              </div>
            </div>

            <div style={{
              flex: 1,
              overflow: 'auto',
              backgroundColor: T.surfaceContainerLow,
              display: 'flex',
              justifyContent: 'center',
              padding: previewDevice === 'mobile' ? '20px' : '0',
            }}>
              <iframe
                srcDoc={currentHtml || `<p style="padding:40px;color:#9ca3af;text-align:center;font-family:Inter,sans-serif;font-size:13px">Start writing your email to see the preview here…</p>`}
                style={{
                  border: 'none',
                  width: previewDevice === 'mobile' ? '375px' : '100%',
                  height: '100%',
                  minHeight: previewDevice === 'mobile' ? '600px' : 'auto',
                  backgroundColor: T.surfaceContainerLowest,
                  boxShadow: previewDevice === 'mobile' ? '0 4px 20px rgba(0,0,0,0.12)' : 'none',
                  borderRadius: previewDevice === 'mobile' ? T.radiusXl : '0',
                  flexShrink: 0,
                }}
                sandbox="allow-same-origin"
                title="Live Email Preview"
              />
            </div>
          </div>
        )}

      </div>
      {/* ═══ END BODY ═════════════════════════════════════════════════════════ */}

      {/* ── Follow-up Preview Modal */}
      {showPreviewFor !== null && (() => {
        const fu = form.followUps.find(f => f.id === showPreviewFor);
        return fu ? (
          <PreviewModal html={fu.htmlContent} onClose={() => setShowPreviewFor(null)} />
        ) : null;
      })()}

      {/* ── Toast */}
      {toast && <Toast msg={toast.msg} type={toast.type} onClose={() => setToast(null)} />}

      {/* ── Keyframe */}
      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        [data-placeholder]:empty:before {
          content: attr(data-placeholder);
          color: #9ca3af;
          pointer-events: none;
        }
      `}</style>
    </div>
  );
}

export default function NewCampaignPage() {
  return (
    <Suspense fallback={
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '300px' }}>
        <div style={{
          width: 32, height: 32, borderRadius: '50%',
          border: '3px solid #edeeef', borderTopColor: '#00361a',
          animation: 'spin 0.8s linear infinite',
        }} />
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    }>
      <NewCampaignPageInner />
    </Suspense>
  );
}
