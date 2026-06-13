'use client';
import { useState, useRef, useEffect, useCallback, Suspense } from 'react';
import Link from 'next/link';
import { useSearchParams, useRouter } from 'next/navigation';
import { api, ApiError } from '@/lib/api';
import {
  Plus, ArrowLeft, Wand2, XCircle, CheckCircle2, X, Code2, Monitor,
  Copy, Trash2, GripVertical, FileEdit, ChevronDown, ChevronUp,
  ListChecks, Maximize2, Minimize2, Users, ShieldCheck, Eye, Save,
  Send, Smartphone, Columns, Lightbulb, TrendingUp, Upload, AlertCircle,
  Flag, Newspaper, Tag, RefreshCw, BadgeCheck, Leaf, Megaphone, Settings2,
  Bold, Italic, Underline, Link as LinkIcon, List, Download, FolderOpen,
  type LucideIcon,
} from 'lucide-react';

// ─── Icon — maps Material Symbol names → lucide components ────────────────
// All 42 icon sites in this page were originally rendered with the Material
// Symbols font (`<span className="material-symbols-outlined">name</span>`),
// but that font was never loaded, so they shipped as raw text. This component
// translates the original names to lucide-react (the icon library used
// everywhere else in the app) so they render correctly.
const ICON_MAP: Record<string, LucideIcon> = {
  add: Plus,
  arrow_back: ArrowLeft,
  auto_mode: Wand2,
  cancel: XCircle,
  check_circle: CheckCircle2,
  close: X,
  code: Code2,
  computer: Monitor,
  content_copy: Copy,
  delete: Trash2,
  drag_indicator: GripVertical,
  edit_note: FileEdit,
  error: AlertCircle,
  expand_more: ChevronDown,
  expand_less: ChevronUp,
  fact_check: ListChecks,
  fullscreen: Maximize2,
  fullscreen_exit: Minimize2,
  groups: Users,
  health_and_safety: ShieldCheck,
  people: Users,
  preview: Eye,
  save: Save,
  send: Send,
  smartphone: Smartphone,
  splitscreen: Columns,
  tips_and_updates: Lightbulb,
  trending_up: TrendingUp,
  upload_file: Upload,
  visibility: Eye,
  checklist: ListChecks,
  flag: Flag,
  newspaper: Newspaper,
  local_offer: Tag,
  refresh: RefreshCw,
  verified: BadgeCheck,
  eco: Leaf,
  campaign: Megaphone,
  tune: Settings2,
  format_bold: Bold,
  format_italic: Italic,
  format_underline: Underline,
  link: LinkIcon,
  format_list_bulleted: List,
};
interface IconProps {
  name: string;
  size?: number;
  color?: string;
  style?: React.CSSProperties;
}
function Icon({ name, size = 16, color, style }: IconProps) {
  const Cmp = ICON_MAP[name] ?? Flag;
  return <Cmp size={size} color={color} style={{ flexShrink: 0, ...style }} strokeWidth={2} />;
}

// ─── AI Generator Panel ───────────────────────────────────────────────────────
// Inline at the top of the editor. Marketer types a brief → calls
// POST /ai/write/marketing-html → Claude returns subject + preview_text +
// responsive HTML + (optional) AMP-for-Email HTML. Result is merged into the
// form via onResult — we don't overwrite the user's subject if they already
// typed one.
interface AIGenResult {
  subject: string;
  preview_text: string;
  html: string;
  amp_html: string;
  mode?: 'ai' | 'fallback';
  mode_reason?: string;
}
function AIGeneratorPanel({
  brandColor,
  onBrandColor,
  generateAmp,
  onResult,
  onPreview,
  onDownload,
}: {
  brandColor: string;
  onBrandColor: (c: string) => void;
  generateAmp: boolean;
  onResult: (r: AIGenResult) => void;
  onPreview: () => void;
  onDownload: () => void;
}) {
  const [brief, setBrief] = useState('');
  const [tone, setTone] = useState<'professional' | 'friendly' | 'witty' | 'urgent'>('professional');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState(true);
  const [lastResult, setLastResult] = useState<AIGenResult | null>(null);

  async function generate() {
    if (!brief.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      // Strip HTML tags from the brief — if the user accidentally pasted HTML
      // (closing tags, DOCTYPE, etc.) we'd otherwise send it as the AI prompt
      // AND the fallback template would echo it back as visible body text.
      const cleanBrief = brief
        .replace(/<[^>]+>/g, ' ')      // strip tags
        .replace(/&[a-z]+;/gi, ' ')    // strip entities
        .replace(/\s+/g, ' ')
        .trim();
      if (!cleanBrief) {
        setErr('Brief looks like HTML markup — describe your email in plain words.');
        return;
      }
      const result = await api<AIGenResult>('/ai/write/marketing-html', {
        method: 'POST',
        body: {
          brief: cleanBrief,
          brand_color: brandColor,
          tone,
          include_amp: generateAmp,
        },
      });
      setLastResult(result);
      onResult(result);
      // Auto-open the live preview so the user immediately sees their email.
      onPreview();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{
      borderBottom: '1px solid rgba(99, 102, 241, 0.18)',
      background: 'linear-gradient(135deg, rgba(99,102,241,0.06) 0%, rgba(168,85,247,0.06) 100%)',
      padding: open ? '14px 18px' : '8px 18px',
      transition: 'padding 0.18s ease',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: open ? 10 : 0 }}>
        <div style={{
          width: 24, height: 24, borderRadius: 8,
          background: 'linear-gradient(135deg, #6366f1, #a855f7)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <Wand2 size={13} color="#fff" strokeWidth={2.4} />
        </div>
        <span style={{
          fontSize: 12, fontWeight: 700, letterSpacing: '-0.01em',
          fontFamily: 'Manrope, Inter, sans-serif',
          background: 'linear-gradient(135deg, #4f46e5, #a855f7)',
          WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent',
        }}>
          AI Email Builder {generateAmp && '· AMP'}
        </span>
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
          <input
            type="color"
            value={brandColor}
            onChange={e => onBrandColor(e.target.value)}
            title="Brand color — used in hero + CTA"
            style={{
              width: 24, height: 24, border: 'none', cursor: 'pointer',
              padding: 0, background: 'transparent',
            }}
          />
          <button
            type="button"
            onClick={() => setOpen(v => !v)}
            style={{
              background: 'none', border: 'none', cursor: 'pointer',
              color: '#6366f1', fontSize: 11, fontWeight: 600,
              fontFamily: 'Inter, sans-serif',
              display: 'flex', alignItems: 'center', gap: 4,
            }}
          >
            {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            {open ? 'Hide' : 'Show'}
          </button>
        </span>
      </div>
      {open && (
        <>
          <textarea
            value={brief}
            onChange={e => setBrief(e.target.value)}
            placeholder="Describe the email you want — e.g. 'Welcome new SaaS subscribers. Highlight 3 product wins. Friendly tone. Drive to a Setup Guide button.'"
            rows={3}
            style={{
              width: '100%',
              padding: '10px 12px',
              fontSize: 12.5,
              lineHeight: 1.55,
              color: '#1e293b',
              backgroundColor: '#ffffff',
              border: '1px solid rgba(99, 102, 241, 0.25)',
              borderRadius: 10,
              fontFamily: 'Inter, sans-serif',
              outline: 'none',
              resize: 'vertical',
              boxSizing: 'border-box',
            }}
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
            <select
              value={tone}
              onChange={e => setTone(e.target.value as 'professional' | 'friendly' | 'witty' | 'urgent')}
              style={{
                padding: '6px 10px',
                fontSize: 11,
                fontWeight: 600,
                color: '#475569',
                background: '#ffffff',
                border: '1px solid rgba(99, 102, 241, 0.25)',
                borderRadius: 8,
                fontFamily: 'Inter, sans-serif',
                cursor: 'pointer',
              }}
            >
              <option value="professional">Professional</option>
              <option value="friendly">Friendly</option>
              <option value="witty">Witty</option>
              <option value="urgent">Urgent</option>
            </select>
            <span style={{ fontSize: 11, color: '#64748b', flex: 1 }}>
              {generateAmp
                ? 'Generates both responsive HTML AND an AMP version (Gmail interactive).'
                : 'Generates responsive, table-based HTML with inline styles for max client compatibility.'}
            </span>
            <button
              type="button"
              onClick={generate}
              disabled={busy || !brief.trim()}
              style={{
                padding: '8px 18px',
                fontSize: 12,
                fontWeight: 700,
                color: '#fff',
                background: brief.trim() && !busy
                  ? 'linear-gradient(135deg, #6366f1, #a855f7)'
                  : 'linear-gradient(135deg, #cbd5e1, #94a3b8)',
                border: 'none',
                borderRadius: 9,
                cursor: brief.trim() && !busy ? 'pointer' : 'not-allowed',
                fontFamily: 'Inter, sans-serif',
                display: 'flex', alignItems: 'center', gap: 6,
                boxShadow: brief.trim() && !busy ? '0 4px 12px rgba(99,102,241,0.28)' : 'none',
                transition: 'all 0.15s',
              }}
            >
              {busy ? <RefreshCw size={13} className="lc-spin" /> : <Wand2 size={13} />}
              {busy ? 'Generating…' : 'Generate'}
            </button>
          </div>
          {err && (
            <div style={{
              marginTop: 8, padding: '6px 10px', fontSize: 11, color: '#b91c1c',
              background: '#fee2e2', borderRadius: 6,
            }}>
              {err}
            </div>
          )}
          {lastResult && !busy && !err && lastResult.mode === 'fallback' && (
            <div style={{
              marginTop: 10, padding: '10px 12px',
              background: 'linear-gradient(135deg, rgba(234,179,8,0.10), rgba(245,158,11,0.10))',
              border: '1px solid rgba(245,158,11,0.30)', borderRadius: 9,
              display: 'flex', alignItems: 'center', gap: 10,
              fontSize: 11.5, fontFamily: 'Inter, sans-serif',
            }}>
              <AlertCircle size={14} color="#b45309" />
              <span style={{ color: '#92400e', fontWeight: 600, lineHeight: 1.5 }}>
                <strong>Template mode</strong> — Claude AI is not configured on the API server, so a hand-built template was rendered instead of an AI-written campaign.
                Set <code style={{ background: '#fef3c7', padding: '0 5px', borderRadius: 4 }}>ANTHROPIC_API_KEY</code> on Render to switch to real AI generation.
              </span>
            </div>
          )}
          {lastResult && !busy && !err && (
            <div style={{
              marginTop: 10, padding: '8px 12px',
              background: 'linear-gradient(135deg, rgba(16,185,129,0.10), rgba(99,102,241,0.10))',
              border: '1px solid rgba(16,185,129,0.25)', borderRadius: 9,
              display: 'flex', alignItems: 'center', gap: 10,
              fontSize: 11.5, fontFamily: 'Inter, sans-serif',
            }}>
              <CheckCircle2 size={14} color="#059669" />
              <span style={{ color: '#065f46', fontWeight: 600 }}>
                Generated · {lastResult.html.length.toLocaleString()} chars
                {generateAmp && lastResult.amp_html ? ` · AMP ${lastResult.amp_html.length.toLocaleString()} chars` : ''}
                {generateAmp && !lastResult.amp_html ? ' · AMP empty ⚠' : ''}
                {lastResult.mode === 'ai' ? ' · Claude AI' : ''}
              </span>
              <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                <button
                  type="button"
                  onClick={onPreview}
                  style={{
                    padding: '5px 11px', fontSize: 11, fontWeight: 600, color: '#4338ca',
                    background: '#fff', border: '1px solid rgba(99,102,241,0.35)', borderRadius: 7,
                    cursor: 'pointer', fontFamily: 'Inter, sans-serif',
                    display: 'flex', alignItems: 'center', gap: 4,
                  }}
                >
                  <Eye size={12} /> Live Preview
                </button>
                <button
                  type="button"
                  onClick={onDownload}
                  style={{
                    padding: '5px 11px', fontSize: 11, fontWeight: 600, color: '#4338ca',
                    background: '#fff', border: '1px solid rgba(99,102,241,0.35)', borderRadius: 7,
                    cursor: 'pointer', fontFamily: 'Inter, sans-serif',
                    display: 'flex', alignItems: 'center', gap: 4,
                  }}
                >
                  <Download size={12} /> Download HTML
                </button>
              </span>
            </div>
          )}
          <style>{`@keyframes lc-spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}.lc-spin{animation:lc-spin 0.8s linear infinite;}`}</style>
        </>
      )}
    </div>
  );
}

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
  ampHtml: string;          // AMP for Email body — delivered as text/x-amp-html alternative
  plainText: string;
  previewText: string;      // <90-char preheader shown in inbox under subject
  brandColor: string;       // Used by AI generator + future visual builder
  contentMode: 'visual' | 'html' | 'upload' | 'plain' | 'amp';
  manualEmails: string;
  includeAllLeads: boolean;
  stageId: string;         // Pipeline stage filter — pull every lead in this stage
  followUps: FollowUp[];
  sendDelay: number;       // seconds_between_sends
  dailyLimit: number;      // daily_limit (0 = unlimited)
  warmupEnabled: boolean;  // warmup_enabled
  batchSize: number;       // batch_size
  senderIds: string[];     // sender_account_ids
  mergeColumns: string[];
  csvRecipients: CsvRecipient[];
}

// Pipeline stage from GET /pipeline/stages
interface Stage {
  id: string;
  name: string;
  color: string;
  lead_count: number;
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
  recipient_filter?: { stage_id?: string; lead_ids?: string[] };
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

// ─── Content Hub picker (browse + pick a saved HTML email asset) ────────────

interface HubAsset {
  id: string;
  title: string;
  subject: string;
  has_amp: boolean;
  content_kb: number;
  updated_at: string | null;
  business_id: string;
  business_name: string;
  business_slug: string;
  business_color: string;
}

function ContentHubPickerModal({
  assets, loading, onClose, onPick,
}: {
  assets: HubAsset[];
  loading: boolean;
  onClose: () => void;
  onPick: (a: HubAsset) => void;
}) {
  const [q, setQ] = useState('');
  const filtered = assets.filter(a => {
    const needle = q.trim().toLowerCase();
    if (!needle) return true;
    return (
      a.title.toLowerCase().includes(needle) ||
      a.subject.toLowerCase().includes(needle) ||
      a.business_name.toLowerCase().includes(needle)
    );
  });
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 1100, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        background: '#fff', borderRadius: 18, width: '100%', maxWidth: 720,
        maxHeight: '88vh', display: 'flex', flexDirection: 'column', overflow: 'hidden',
        boxShadow: '0 24px 60px rgba(0,0,0,0.2)',
      }}>
        <div style={{ padding: '18px 24px', borderBottom: '1px solid #f3f4f6', display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{
            width: 30, height: 30, borderRadius: 9,
            background: 'linear-gradient(135deg, #00361a, #1e6e3a)',
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <FolderOpen size={15} color="#fff" strokeWidth={2.4} />
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontFamily: 'Manrope, Inter, sans-serif', fontWeight: 800, fontSize: 16, color: '#0f172a' }}>Use an email from Content Hub</div>
            <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>Pick a saved HTML email — it pre-fills this draft.</div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4, color: '#9ca3af' }}><X size={20} /></button>
        </div>
        <div style={{ padding: '12px 24px', borderBottom: '1px solid #f3f4f6' }}>
          <input
            autoFocus value={q} onChange={(e) => setQ(e.target.value)}
            placeholder="Search by title, subject, or business…"
            style={{ width: '100%', padding: '9px 12px', border: '1.5px solid #e5e7eb', borderRadius: 9, fontSize: 13, outline: 'none', fontFamily: 'Inter, sans-serif', boxSizing: 'border-box' }}
          />
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: '8px 12px' }}>
          {loading && <div style={{ padding: 30, textAlign: 'center', color: '#9ca3af', fontSize: 13 }}>Loading…</div>}
          {!loading && filtered.length === 0 && (
            <div style={{ padding: 30, textAlign: 'center', color: '#9ca3af', fontSize: 13 }}>
              No HTML emails in Content Hub yet. Add one from <Link href="/content-hub" style={{ color: '#00361a', fontWeight: 700 }}>Content Hub →</Link>
            </div>
          )}
          {filtered.map((a) => (
            <button key={a.id} onClick={() => onPick(a)} style={{
              display: 'flex', alignItems: 'center', gap: 12, width: '100%', padding: '11px 12px',
              border: '1.5px solid transparent', borderRadius: 11, background: 'transparent',
              cursor: 'pointer', textAlign: 'left', marginBottom: 4, fontFamily: 'inherit',
            }}
              onMouseEnter={(e) => { e.currentTarget.style.background = '#f9fafb'; e.currentTarget.style.borderColor = '#e5e7eb'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.borderColor = 'transparent'; }}
            >
              <span style={{
                width: 36, height: 36, borderRadius: 8, flexShrink: 0,
                background: `linear-gradient(135deg, ${a.business_color}, ${a.business_color}cc)`,
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <FolderOpen size={16} color="#fff" />
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                  <span style={{ fontWeight: 800, fontSize: 13.5, color: '#0f172a', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.title}</span>
                  {a.has_amp && (
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2, fontSize: 9, fontWeight: 800, color: '#fff', background: 'linear-gradient(135deg,#6366f1,#a855f7)', padding: '2px 6px', borderRadius: 99 }}>
                      AMP
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 11.5, color: '#6b7280', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {a.business_name} · {a.subject ? `Subject: ${a.subject}` : `${a.content_kb} KB`}
                </div>
              </div>
              <span style={{ fontSize: 11, fontWeight: 700, color: '#00361a', background: 'rgba(0,54,26,0.08)', padding: '4px 10px', borderRadius: 7, flexShrink: 0 }}>
                Use →
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}


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
      <Icon name={type === 'success' ? 'check_circle' : 'error'} size={18} />
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
            <Icon name={'close'} size={20} />
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
      <Icon name={icon} size={16} color={T.saffron} />
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
  // /campaigns/new?from_asset=<id> — start a fresh draft pre-filled from a
  // Content Hub HTML email asset. Skipped when an edit id is also present.
  const fromAssetId = searchParams.get('from_asset') || '';
  const [hydratedFromAsset, setHydratedFromAsset] = useState(false);
  const [fromAssetMeta, setFromAssetMeta] = useState<{ id: string; title: string; business_name: string } | null>(null);
  const [showHubPicker, setShowHubPicker] = useState(false);
  const [hubAssets, setHubAssets] = useState<HubAsset[]>([]);
  const [hubLoading, setHubLoading] = useState(false);

  const [form, setForm] = useState<FormState>({
    name: '',
    goal: '',
    subject: '',
    fromName: '',
    fromEmail: '',
    replyTo: '',
    tags: '',
    htmlContent: '',
    ampHtml: '',
    plainText: '',
    previewText: '',
    brandColor: '#0a66c2',
    contentMode: 'html',
    manualEmails: prefillEmail,
    includeAllLeads: false,
    stageId: '',
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
  const [stages, setStages] = useState<Stage[]>([]);
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
    : form.contentMode === 'amp' && form.ampHtml
      ? form.ampHtml
      : form.htmlContent;

  // Render-safe variant of currentHtml for the preview iframe:
  // - AMP boilerplate hides <body> until the AMP runtime reveals it; without
  //   that runtime, our srcDoc iframe shows a blank rectangle. Force the
  //   body visible.
  // - Bare HTML fragments (no <html>/<body>) are wrapped in a default shell
  //   so things like `<div>Hi</div>` render with a sensible font baseline.
  function buildPreviewDoc(src: string): string {
    if (!src || !src.trim()) return '';
    const hasHtml = /<html[\s>]/i.test(src);
    const unhide = '<style>html,body{visibility:visible !important;opacity:1 !important;}</style>';
    if (hasHtml) {
      // Inject the visibility reset just before </head> (or, failing that,
      // at the very top) so it wins over amp4email-boilerplate.
      if (/<\/head>/i.test(src)) {
        return src.replace(/<\/head>/i, `${unhide}</head>`);
      }
      return unhide + src;
    }
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${unhide}<style>body{margin:0;padding:24px;font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#1f2937;background:#fff;}</style></head><body>${src}</body></html>`;
  }
  const previewDoc = buildPreviewDoc(currentHtml);

  // Download the active body as a .html file the marketer can preview /
  // archive / hand off to a designer. Picks AMP when the AMP tab is active
  // and ampHtml is populated; otherwise the HTML body.
  function downloadCurrentEmail() {
    const isAmp = form.contentMode === 'amp' && form.ampHtml.trim().length > 0;
    const body = isAmp ? form.ampHtml : (form.htmlContent || currentHtml);
    if (!body || !body.trim()) return;
    const safeName = (form.name || 'campaign')
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'campaign';
    const suffix = isAmp ? '-amp.html' : '.html';
    const blob = new Blob([body], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${safeName}${suffix}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const manualCount = (() => {
    const emails = parseEmails(form.manualEmails).filter(e => e.includes('@'));
    return emails.length;
  })();
  const selectedStage = stages.find(s => s.id === form.stageId) || null;
  const stageCount = selectedStage ? selectedStage.lead_count : 0;
  const recipientCount = form.includeAllLeads
    ? Math.max(manualCount + stageCount, 1)
    : manualCount + stageCount;

  const health = computeScores(form, recipientCount);

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

  // ── Load pipeline stages (for the "Pick from Pipeline stages" audience option)
  const fetchStages = useCallback(async () => {
    try {
      const list = await api<Stage[]>('/pipeline/stages');
      setStages(Array.isArray(list) ? list : []);
    } catch {
      setStages([]);
    }
  }, []);

  useEffect(() => {
    fetchSenders();
    fetchStages();
  }, [fetchSenders, fetchStages]);

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
          ampHtml: (c as CampaignDetail & { body_amp?: string }).body_amp || '',
          plainText: (c as CampaignDetail & { body_text?: string }).body_text || '',
          previewText: (c as CampaignDetail & { preview_text?: string }).preview_text || '',
          brandColor: (c as CampaignDetail & { brand_color?: string }).brand_color || '#0a66c2',
          contentMode: 'html',
          manualEmails: (c.recipient_data || []).map(r => r.email).join('\n'),
          includeAllLeads: !!c.include_all_leads,
          stageId: c.recipient_filter?.stage_id || '',
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

  // ── Pre-fill a fresh draft from a Content Hub HTML email asset.
  // Triggered when /campaigns/new?from_asset=<id> is present AND we're not
  // editing an existing campaign. The form stays fully editable — this is
  // a one-time hydration, not a binding.
  useEffect(() => {
    if (!fromAssetId || editId || hydratedFromAsset) return;
    let cancelled = false;
    type AssetPayload = {
      id: string; title: string; subject?: string; content: string;
      amp_content?: string; business_id: string;
    };
    type BusinessPayload = { name: string };
    api<AssetPayload>(`/content-hub/assets/${fromAssetId}`)
      .then(async (a) => {
        if (cancelled || !a) return;
        // Fetch business for a nicer pre-filled campaign name like
        // "{Business} — {Asset title}". Best-effort — fall back to plain.
        let bizName = '';
        try {
          const biz = await api<BusinessPayload>(`/content-hub/businesses/${a.business_id}`);
          bizName = biz?.name || '';
        } catch { /* ignore */ }
        if (cancelled) return;
        const presetName = bizName ? `${bizName} — ${a.title}` : a.title;
        const presetSubject = a.subject || a.title;
        setForm(f => ({
          ...f,
          name: f.name || presetName,
          subject: f.subject || presetSubject,
          htmlContent: f.htmlContent || a.content || '',
          ampHtml: f.ampHtml || a.amp_content || '',
          contentMode: 'html',
        }));
        setFromAssetMeta({ id: a.id, title: a.title, business_name: bizName });
        setHydratedFromAsset(true);
      })
      .catch(() => { if (!cancelled) setHydratedFromAsset(true); });
    return () => { cancelled = true; };
  }, [fromAssetId, editId, hydratedFromAsset]);

  // ── Load Content Hub HTML emails count once. The full list is
  // re-fetched when the picker actually opens (kept tiny + fast on mount).
  useEffect(() => {
    let cancelled = false;
    api<{ assets: HubAsset[]; count: number }>('/content-hub/assets/html-emails')
      .then((r) => { if (!cancelled) setHubAssets(r?.assets || []); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  function openHubPicker() {
    setShowHubPicker(true);
    setHubLoading(true);
    api<{ assets: HubAsset[]; count: number }>('/content-hub/assets/html-emails')
      .then((r) => setHubAssets(r?.assets || []))
      .catch(() => {})
      .finally(() => setHubLoading(false));
  }

  function applyHubAsset(a: HubAsset) {
    // Fetch the full asset (the list endpoint omits .content + .amp_content
    // to keep the payload tiny).
    type FullAsset = { id: string; title: string; subject?: string; content: string; amp_content?: string };
    api<FullAsset>(`/content-hub/assets/${a.id}`).then((full) => {
      if (!full) return;
      const presetName = a.business_name ? `${a.business_name} — ${a.title}` : a.title;
      const presetSubject = full.subject || a.subject || a.title;
      setForm(f => ({
        ...f,
        name: presetName,
        subject: presetSubject,
        htmlContent: full.content || '',
        ampHtml: full.amp_content || '',
        contentMode: 'html',
      }));
      setFromAssetMeta({ id: a.id, title: a.title, business_name: a.business_name });
      setShowHubPicker(false);
    }).catch(() => {});
  }

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
      body_amp: form.ampHtml || undefined,
      body_text: form.plainText || '',
      preview_text: form.previewText || undefined,
      brand_color: form.brandColor || undefined,
      from_name: form.fromName || undefined,
      from_email: form.fromEmail || undefined,
      reply_to: form.replyTo || undefined,
      goal: form.goal || undefined,
      tags: form.tags ? form.tags.split(',').map(t => t.trim()).filter(Boolean) : [],
      merge_columns: form.mergeColumns,
      recipients,
      manual_emails: manualOnly,
      include_all_leads: form.includeAllLeads,
      stage_id: form.stageId || undefined,
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
      body_amp: form.ampHtml || undefined,
      body_text: form.plainText || '',
      preview_text: form.previewText || undefined,
      brand_color: form.brandColor || undefined,
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
      <Icon name={icon} size={14} />
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
          <Icon name={'arrow_back'} size={16} />
          Back
        </Link>

        <div style={{ width: '1px', height: '20px', backgroundColor: T.surfaceContainer }} />

        {/* Title */}
        <h1 style={{
          fontSize: '20px', fontWeight: 800, color: T.onSurface, margin: 0,
          fontFamily: 'Manrope, Inter, sans-serif', letterSpacing: '-0.02em',
          flex: 1,
          display: 'flex', alignItems: 'center', gap: '10px',
        }}>
          <span style={{
            width: '28px', height: '28px', borderRadius: '9px',
            background: 'linear-gradient(135deg, #4f46e5 0%, #a855f7 60%, #ec4899 100%)',
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            boxShadow: '0 4px 14px rgba(99,102,241,0.32)',
          }}>
            <Wand2 size={14} color="#fff" strokeWidth={2.4} />
          </span>
          <span style={{
            background: 'linear-gradient(135deg, #0f172a 0%, #334155 100%)',
            WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent',
          }}>
            {editId ? 'Edit Campaign' : 'Campaign Builder'}
          </span>
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

        {/* From-inbox chip — always visible so the user knows exactly which
            connected inbox(es) this campaign will send through. Bound 1:1 to
            form.senderIds so there's no chance of a mismatch between the
            chosen mailbox in the right panel and the live send. */}
        {!noSenders && (
          <button
            onClick={() => {
              const el = document.getElementById('senders-section');
              if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }}
            title={form.senderIds.length === 0
              ? 'No inbox selected — pick one or more on the right'
              : 'Inboxes that will send this campaign'}
            style={{
              display: 'flex', alignItems: 'center', gap: '8px',
              padding: '6px 12px',
              borderRadius: T.radiusFull,
              border: `1.5px solid ${form.senderIds.length === 0 ? '#dc2626' : T.primary}`,
              background: form.senderIds.length === 0 ? 'rgba(220,38,38,0.08)' : 'rgba(0,54,26,0.08)',
              cursor: 'pointer', fontFamily: 'Inter, sans-serif',
              maxWidth: '380px', overflow: 'hidden',
            }}
          >
            <Icon name="send" size={14} color={form.senderIds.length === 0 ? '#dc2626' : T.primary} />
            <span style={{
              fontSize: '11px', fontWeight: 800, textTransform: 'uppercase',
              letterSpacing: '0.06em',
              color: form.senderIds.length === 0 ? '#dc2626' : T.primary,
            }}>From</span>
            <span style={{
              fontSize: '12px', fontWeight: 600, color: T.onSurface,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>
              {form.senderIds.length === 0
                ? 'Pick an inbox →'
                : form.senderIds.length === 1
                  ? (activeSenders.find(s => s.id === form.senderIds[0])?.from_address
                      || activeSenders.find(s => s.id === form.senderIds[0])?.label
                      || 'inbox')
                  : `${form.senderIds.length} inboxes · rotating`}
            </span>
          </button>
        )}

        {/* Live Preview toggle — label flips so a second click is obviously
            "Hide", not the mystery toggle people reported. */}
        <button
          onClick={() => setShowSplitPreview(v => !v)}
          style={{
            display: 'flex', alignItems: 'center', gap: '6px',
            padding: '7px 14px',
            borderRadius: T.radiusLg,
            border: showSplitPreview ? `1px solid ${T.primary}` : '1px solid transparent',
            backgroundColor: showSplitPreview ? 'rgba(0,54,26,0.10)' : T.surfaceContainerLow,
            color: showSplitPreview ? T.primary : T.onSurfaceVariant,
            fontSize: '12px', fontWeight: 700, cursor: 'pointer',
            fontFamily: 'Inter, sans-serif',
          }}
        >
          <Icon name={showSplitPreview ? 'visibility' : 'splitscreen'} size={15} />
          {showSplitPreview ? 'Hide Preview' : 'Live Preview'}
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
            <Icon name={'save'} size={15} />
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
            <Icon name={'send'} size={15} />
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
                  <Icon name={GOALS.find(g => g.value === form.goal)?.icon || 'flag'} size={14} color={T.onSurfaceVariant} style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }} />
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
                  <Icon name={'expand_more'} size={14} color={T.onSurfaceVariant} style={{ position: 'absolute', right: '10px', top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }} />
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
                <Icon name={'groups'} size={16} color={form.includeAllLeads ? T.primary : T.onSurfaceVariant} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: '13px', fontWeight: 600, color: T.onSurface }}>Include all CRM leads</div>
                  <div style={{ fontSize: '10px', color: T.onSurfaceVariant }}>Every lead with an email on file</div>
                </div>
              </label>

              {/* Pick from Pipeline stages — auto-pulls every lead in the chosen
                  stage that has an email on file. */}
              <div style={{
                display: 'flex', alignItems: 'center', gap: '10px',
                padding: '10px 14px',
                borderRadius: T.radiusLg,
                backgroundColor: form.stageId ? 'rgba(0,54,26,0.08)' : T.surfaceContainerLow,
                transition: 'background 0.15s',
              }}>
                <span className="material-symbols-outlined" style={{ fontSize: '16px', color: form.stageId ? T.primary : T.onSurfaceVariant }}>
                  filter_list
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: '13px', fontWeight: 600, color: T.onSurface, marginBottom: '4px' }}>
                    Pick from Pipeline stages
                  </div>
                  <select
                    value={form.stageId}
                    onChange={e => setForm(f => ({ ...f, stageId: e.target.value }))}
                    style={{
                      width: '100%',
                      padding: '7px 10px',
                      borderRadius: '8px',
                      border: '1px solid rgba(65,73,66,0.18)',
                      background: T.surfaceContainerLowest,
                      fontSize: '12px',
                      fontFamily: 'Inter, sans-serif',
                      color: T.onSurface,
                      cursor: 'pointer',
                    }}
                  >
                    <option value="">No stage filter</option>
                    {stages.map(s => (
                      <option key={s.id} value={s.id}>
                        {s.name} ({s.lead_count} lead{s.lead_count !== 1 ? 's' : ''})
                      </option>
                    ))}
                  </select>
                  {selectedStage && (
                    <div style={{ fontSize: '10px', color: T.onSurfaceVariant, marginTop: '4px' }}>
                      {stageCount} lead{stageCount !== 1 ? 's' : ''} in “{selectedStage.name}” will be added (those with an email).
                    </div>
                  )}
                </div>
              </div>

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
                <Icon name={'upload_file'} size={16} />
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
                      <Icon name={validationResult.invalid > 0 ? 'error' : 'check_circle'} size={14} color={validationResult.invalid > 0 ? '#dc2626' : '#16a34a'} />
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
                          <Icon name={'cancel'} size={13} color={'#dc2626'} style={{ flexShrink: 0 }} />
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
                <Icon name={'people'} size={14} color={T.primary} />
                <span style={{ fontSize: '12px', fontWeight: 700, color: T.primary }}>
                  {form.includeAllLeads
                    ? `All CRM leads${manualCount > 0 ? ` + ${manualCount.toLocaleString()}` : ''}`
                    : `${manualCount.toLocaleString()} recipients`}
                </span>
              </div>
            )}
          </PanelSection>

          {/* ── Senders ── */}
          <div id="senders-section" />
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
              <Icon name={'trending_up'} size={16} color={form.warmupEnabled ? T.primary : T.onSurfaceVariant} />
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
              <Icon name={'fact_check'} size={14} color={T.primary} />
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
              <Icon name={'health_and_safety'} size={14} color={T.saffron} />
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
                  <Icon name={'tips_and_updates'} size={12} />
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

          {/* ── From Content Hub banner — pick a saved HTML email ── */}
          {!editId && (
            <div style={{ margin: '16px 32px 0', flexShrink: 0 }}>
              {fromAssetMeta ? (
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 12,
                  padding: '10px 14px', borderRadius: 11,
                  background: 'linear-gradient(135deg, rgba(0,54,26,0.06), rgba(0,54,26,0.10))',
                  border: '1px solid rgba(0,54,26,0.18)',
                }}>
                  <span style={{
                    width: 28, height: 28, borderRadius: 8,
                    background: 'linear-gradient(135deg, #00361a, #1e6e3a)',
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  }}>
                    <FolderOpen size={14} color="#fff" strokeWidth={2.4} />
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12.5, fontWeight: 800, color: T.primary, fontFamily: 'Manrope, Inter, sans-serif' }}>
                      Pre-filled from Content Hub
                    </div>
                    <div style={{ fontSize: 11.5, color: '#475569', marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {fromAssetMeta.business_name ? `${fromAssetMeta.business_name} · ` : ''}{fromAssetMeta.title} — fully editable below
                    </div>
                  </div>
                  <button onClick={openHubPicker} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 11, fontWeight: 700, color: T.primary, textDecoration: 'underline', fontFamily: 'Inter, sans-serif' }}>
                    Change…
                  </button>
                </div>
              ) : (
                <button onClick={openHubPicker} style={{
                  display: 'flex', alignItems: 'center', gap: 11, width: '100%',
                  padding: '12px 16px', borderRadius: 11,
                  background: 'linear-gradient(135deg, rgba(99,102,241,0.04), rgba(168,85,247,0.04))',
                  border: '1px dashed rgba(99,102,241,0.30)',
                  cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit',
                }}>
                  <span style={{
                    width: 30, height: 30, borderRadius: 9,
                    background: 'linear-gradient(135deg, #00361a, #1e6e3a)',
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  }}>
                    <FolderOpen size={15} color="#fff" strokeWidth={2.4} />
                  </span>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13, fontWeight: 800, color: T.onSurface, fontFamily: 'Manrope, Inter, sans-serif', letterSpacing: '-0.01em' }}>
                      Use an email from Content Hub
                    </div>
                    <div style={{ fontSize: 11.5, color: '#6b7280', marginTop: 1 }}>
                      {hubAssets.length === 0
                        ? 'No saved HTML emails yet — add one in Content Hub, then start a campaign from it in one click.'
                        : `${hubAssets.length} HTML email${hubAssets.length === 1 ? '' : 's'} available · name + subject + body pre-fill, then edit as a draft.`}
                    </div>
                  </div>
                  <span style={{
                    fontSize: 11, fontWeight: 700, color: '#4338ca',
                    background: 'rgba(99,102,241,0.10)', padding: '6px 12px', borderRadius: 8,
                  }}>
                    Browse →
                  </span>
                </button>
              )}
            </div>
          )}

          {/* ── Email Content Editor Card ── */}
          <div style={{
            margin: '20px 32px 0',
            backgroundColor: T.surfaceContainerLowest,
            borderRadius: T.radiusXl,
            overflow: 'hidden',
            flexShrink: 0,
            border: '1px solid rgba(99,102,241,0.10)',
            boxShadow: '0 1px 2px rgba(15,23,42,0.04), 0 8px 28px -8px rgba(99,102,241,0.10), 0 0 0 1px rgba(255,255,255,0.6) inset',
            position: 'relative',
          }}>
            {/* Gradient accent strip — royal indigo→purple→pink hairline */}
            <div style={{
              position: 'absolute', top: 0, left: 0, right: 0, height: '3px',
              background: 'linear-gradient(90deg, #4f46e5 0%, #a855f7 50%, #ec4899 100%)',
              opacity: 0.85,
            }} />

            {/* Tab bar + header row */}
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '14px 20px',
              borderBottom: `1px solid ${T.surfaceContainer}`,
              gap: '12px',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <span style={{
                  width: '26px', height: '26px', borderRadius: '8px',
                  background: 'linear-gradient(135deg, rgba(99,102,241,0.12), rgba(168,85,247,0.12))',
                  border: '1px solid rgba(99,102,241,0.20)',
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                }}>
                  <FileEdit size={13} color="#6366f1" strokeWidth={2.4} />
                </span>
                <span style={{
                  fontSize: '14px', fontWeight: 800, color: T.onSurface,
                  fontFamily: 'Manrope, Inter, sans-serif', letterSpacing: '-0.01em',
                }}>
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
                  { mode: 'amp'    as const, label: 'AMP ✨' },
                  { mode: 'plain'  as const, label: 'Plain Text' },
                  { mode: 'upload' as const, label: 'Upload HTML' },
                  { mode: 'visual' as const, label: 'Preview' },
                ]).map(({ mode, label: lbl }) => {
                  const active = form.contentMode === mode;
                  const isAmp = mode === 'amp';
                  return (
                    <button
                      key={mode}
                      onClick={() => setForm(f => ({ ...f, contentMode: mode }))}
                      style={{
                        padding: '6px 14px',
                        borderRadius: '7px',
                        border: 'none',
                        background: active
                          ? (isAmp
                              ? 'linear-gradient(135deg, #6366f1, #a855f7)'
                              : T.surfaceContainerLowest)
                          : 'transparent',
                        color: active
                          ? (isAmp ? '#fff' : T.primary)
                          : (isAmp ? '#7c3aed' : T.onSurfaceVariant),
                        fontSize: '12px',
                        fontWeight: active ? 700 : (isAmp ? 700 : 500),
                        cursor: 'pointer',
                        fontFamily: 'Inter, sans-serif',
                        transition: 'all 0.15s',
                        boxShadow: active
                          ? (isAmp
                              ? '0 3px 10px rgba(99,102,241,0.32)'
                              : '0 1px 3px rgba(0,0,0,0.08)')
                          : 'none',
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
                <Icon name={showSplitPreview ? 'fullscreen_exit' : 'fullscreen'} size={18} />
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
                <Icon name={healthOpen ? 'expand_less' : 'checklist'} size={14} />
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
                        <Icon name={item.done ? 'check_circle' : 'cancel'} size={13} color={item.done ? '#16a34a' : '#dc2626'} style={{ flexShrink: 0, marginTop: '1px' }} />
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

                {/* AI Generator panel — visible in HTML and AMP modes. Click
                    Generate → backend Claude call → HTML (and AMP if asked)
                    populated. Brief stays in state so the user can iterate. */}
                {(form.contentMode === 'html' || form.contentMode === 'amp') && (
                  <AIGeneratorPanel
                    brandColor={form.brandColor}
                    onBrandColor={(c) => setForm(f => ({ ...f, brandColor: c }))}
                    generateAmp={form.contentMode === 'amp'}
                    onResult={(r) => {
                      // Defensive: reject AI subject/preview if they leak HTML
                      // — the fallback echoes raw brief otherwise.
                      const looksLikeHtml = (s: string) => /<[a-z!\/][^>]*>/i.test(s);
                      const cleanSubject = looksLikeHtml(r.subject) ? '' : r.subject;
                      const cleanPreview = looksLikeHtml(r.preview_text) ? '' : r.preview_text;
                      setForm(f => ({
                        ...f,
                        subject: f.subject || cleanSubject,
                        previewText: f.previewText || cleanPreview,
                        htmlContent: r.html || f.htmlContent,
                        ampHtml: r.amp_html || f.ampHtml,
                      }));
                    }}
                    onPreview={() => setShowSplitPreview(true)}
                    onDownload={downloadCurrentEmail}
                  />
                )}

                {/* Preview-text input — universal, lives in inbox preview pane */}
                {(form.contentMode === 'html' || form.contentMode === 'amp') && (
                  <input
                    type="text"
                    value={form.previewText}
                    onChange={e => setForm(f => ({ ...f, previewText: e.target.value }))}
                    placeholder="Preview text (shown next to subject in inbox) — keep it under 90 chars"
                    maxLength={120}
                    style={{
                      display: 'block',
                      width: '100%',
                      padding: '10px 18px',
                      fontSize: '12px',
                      color: T.onSurface,
                      backgroundColor: T.surfaceContainerLowest,
                      border: 'none',
                      borderBottom: `1px solid ${T.surfaceContainer}`,
                      fontFamily: 'Inter, sans-serif',
                      outline: 'none',
                      boxSizing: 'border-box',
                    }}
                  />
                )}

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

                {/* AMP for Email mode — separate body, Gmail uses this when
                    delivered as the text/x-amp-html MIME alternative. Other
                    clients fall back to body_html silently. Lets the marketer
                    embed <amp-anim> GIFs, <amp-carousel> sliders, <amp-form>
                    inline RSVP / NPS without leaving the inbox. */}
                {form.contentMode === 'amp' && (
                  <textarea
                    value={form.ampHtml}
                    onChange={e => setForm(f => ({ ...f, ampHtml: e.target.value }))}
                    placeholder={'<!doctype html>\n<html ⚡4email lang="en"><head><meta charset="utf-8">\n<script async src="https://cdn.ampproject.org/v0.js"></script>\n<script async custom-element="amp-anim" src="https://cdn.ampproject.org/v0/amp-anim-0.1.js"></script>\n<style amp4email-boilerplate>body{visibility:hidden}</style>\n<style amp-custom>.cta{background:#0a66c2;color:#fff;padding:14px 28px;border-radius:10px;}</style>\n</head>\n<body>\n  <h1>Hi {first_name},</h1>\n  <amp-anim width="600" height="360" layout="responsive" src="https://media.tenor.com/m/EW5N0gI2VJsAAAAd/celebrate-party.gif" alt="celebrate"></amp-anim>\n  <p><a class="cta" href="https://">Take a look</a></p>\n</body></html>'}
                    style={{
                      flex: 1,
                      display: 'block',
                      width: '100%',
                      minHeight: '460px',
                      padding: '18px 20px',
                      backgroundColor: '#1e1e1e',
                      color: '#dcdcaa',
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

                {/* Plain Text mode — the email body sent as text/plain. Sent
                    as the SMTP `text` part; if HTML is also set the recipient's
                    client will pick the best version. Many spam filters give a
                    score boost when both parts exist. */}
                {form.contentMode === 'plain' && (
                  <div style={{ display: 'flex', flexDirection: 'column', flex: 1 }}>
                    <div style={{
                      padding: '10px 16px',
                      backgroundColor: T.surfaceContainerLow,
                      borderBottom: `1px solid ${T.surfaceContainer}`,
                      display: 'flex', alignItems: 'center', gap: '6px',
                      fontSize: '11px', color: T.onSurfaceVariant,
                      fontFamily: 'Inter, sans-serif',
                    }}>
                      <Icon name="tips_and_updates" size={13} color={T.saffron} />
                      Merge tokens: <code>{'{first_name}'}</code>, <code>{'{company}'}</code>, <code>{'{email}'}</code>. Sent as <code>text/plain</code> alongside HTML when both are filled — improves inbox placement.
                    </div>
                    <textarea
                      value={form.plainText}
                      onChange={e => setForm(f => ({ ...f, plainText: e.target.value }))}
                      placeholder={'Hi {first_name},\n\nQuick idea for {company} — wanted to see if it makes sense to chat.\n\nWorth 10 minutes this week?\n\nThanks,'}
                      style={{
                        flex: 1,
                        display: 'block',
                        width: '100%',
                        minHeight: '420px',
                        padding: '18px 20px',
                        backgroundColor: '#ffffff',
                        color: T.onSurface,
                        border: 'none',
                        fontFamily: '"SF Mono", Menlo, Consolas, monospace',
                        fontSize: '13px',
                        lineHeight: '1.7',
                        outline: 'none',
                        resize: 'none',
                        boxSizing: 'border-box',
                      }}
                    />
                  </div>
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
                          <Icon name={btn.icon} size={15} />
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
                      <Icon name={'upload_file'} size={40} color={isDragOver ? T.primary : T.onSurfaceVariant} style={{ marginBottom: '12px', display: 'block' }} />
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
                        <Icon name={'check_circle'} size={16} color={T.primary} />
                        <span style={{ fontSize: '13px', color: T.primary, fontWeight: 600 }}>
                          HTML loaded ({form.htmlContent.length.toLocaleString()} characters)
                        </span>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Right: Quick Preview thumbnail */}
              <div style={{
                display: 'flex', flexDirection: 'column',
                background: 'linear-gradient(180deg, rgba(99,102,241,0.04), rgba(168,85,247,0.04))',
              }}>
                <div style={{
                  padding: '10px 14px',
                  borderBottom: `1px solid ${T.surfaceContainer}`,
                  display: 'flex', alignItems: 'center', gap: '6px',
                  flexShrink: 0,
                }}>
                  <Icon name={'preview'} size={13} color={T.onSurfaceVariant} />
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
                      <Icon name={'computer'} size={13} />
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
                      <Icon name={'smartphone'} size={13} />
                    </button>
                    <button
                      onClick={downloadCurrentEmail}
                      disabled={!currentHtml || !currentHtml.trim()}
                      title="Download current email as .html"
                      style={{
                        padding: '3px 7px', borderRadius: '5px', border: 'none',
                        cursor: currentHtml && currentHtml.trim() ? 'pointer' : 'not-allowed',
                        backgroundColor: T.surfaceContainer,
                        color: currentHtml && currentHtml.trim() ? T.primary : T.onSurfaceVariant,
                        opacity: currentHtml && currentHtml.trim() ? 1 : 0.45,
                        display: 'flex', alignItems: 'center',
                      }}
                    >
                      <Download size={13} />
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
                    boxShadow: '0 4px 24px -4px rgba(15,23,42,0.12), 0 0 0 1px rgba(99,102,241,0.10)',
                    overflow: 'hidden',
                    backgroundColor: '#ffffff',
                    display: 'flex',
                    flexDirection: 'column',
                  }}>
                    <iframe
                      key={`quick-${form.contentMode}-${previewDoc.length}`}
                      srcDoc={
                        previewDoc ||
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
                <Icon name={'auto_mode'} size={18} color={T.saffron} />
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
                <Icon name={'add'} size={15} />
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
                          <Icon name={'content_copy'} size={14} />
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
                          <Icon name={'delete'} size={14} />
                        </button>
                      </div>
                    </div>

                    {/* HTML filename / content row */}
                    <div style={{
                      padding: '12px 18px',
                      borderBottom: `1px solid ${T.surfaceContainer}`,
                      display: 'flex', alignItems: 'center', gap: '10px',
                    }}>
                      <Icon name={'code'} size={15} color={T.onSurfaceVariant} />
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
                        <Icon name={'visibility'} size={13} />
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
                              <Icon name={'upload_file'} size={28} color={T.onSurfaceVariant} style={{ marginBottom: '6px', display: 'block' }} />
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
                                <Icon name={'check_circle'} size={13} color={T.primary} />
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
                    <Icon name={'add'} size={14} />
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
                  <Icon name={'drag_indicator'} size={18} color={T.onSurfaceVariant} />
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
        {/* Rendered as a FIXED overlay so it can't get pushed off-screen by
            narrow viewports and so it doesn't have to fight the flex row for
            horizontal space. Anchored top-right under the 60px header. */}
        {showSplitPreview && (
          <div style={{
            position: 'fixed',
            top: '60px',
            right: 0,
            bottom: 0,
            width: '440px',
            maxWidth: 'calc(100vw - 320px)',
            zIndex: 90,
            borderLeft: `1px solid ${T.surfaceContainer}`,
            backgroundColor: T.surfaceContainerLowest,
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            boxShadow: '-12px 0 32px -8px rgba(15,23,42,0.18)',
          }}>
            <div style={{
              padding: '10px 14px',
              borderBottom: `1px solid ${T.surfaceContainer}`,
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              flexShrink: 0,
              minHeight: '46px',
              background: 'linear-gradient(180deg, rgba(99,102,241,0.04), transparent)',
            }}>
              <span style={{
                fontSize: '13px', fontWeight: 800, color: T.primary,
                fontFamily: 'Manrope, Inter, sans-serif',
                display: 'flex', alignItems: 'center', gap: '6px',
              }}>
                <Eye size={14} /> Live Preview
              </span>
              <div style={{ display: 'flex', alignItems: 'center', gap: '4px', flexShrink: 0 }}>
                <button
                  onClick={() => setPreviewDevice('desktop')}
                  title="Desktop view"
                  style={{
                    padding: '5px 8px', borderRadius: '7px',
                    border: 'none',
                    backgroundColor: previewDevice === 'desktop' ? T.primary : T.surfaceContainerLow,
                    color: previewDevice === 'desktop' ? '#fff' : T.onSurfaceVariant,
                    cursor: 'pointer', display: 'flex', alignItems: 'center',
                  }}
                >
                  <Icon name={'computer'} size={14} />
                </button>
                <button
                  onClick={() => setPreviewDevice('mobile')}
                  title="Mobile view"
                  style={{
                    padding: '5px 8px', borderRadius: '7px',
                    border: 'none',
                    backgroundColor: previewDevice === 'mobile' ? T.primary : T.surfaceContainerLow,
                    color: previewDevice === 'mobile' ? '#fff' : T.onSurfaceVariant,
                    cursor: 'pointer', display: 'flex', alignItems: 'center',
                  }}
                >
                  <Icon name={'smartphone'} size={14} />
                </button>
                <button
                  onClick={downloadCurrentEmail}
                  disabled={!currentHtml || !currentHtml.trim()}
                  title="Download current email as .html"
                  style={{
                    padding: '5px 8px', borderRadius: '7px',
                    border: 'none',
                    backgroundColor: T.surfaceContainerLow,
                    color: currentHtml && currentHtml.trim() ? T.primary : T.onSurfaceVariant,
                    opacity: currentHtml && currentHtml.trim() ? 1 : 0.45,
                    cursor: currentHtml && currentHtml.trim() ? 'pointer' : 'not-allowed',
                    display: 'flex', alignItems: 'center',
                  }}
                >
                  <Download size={14} />
                </button>
                <button
                  onClick={() => setShowSplitPreview(false)}
                  title="Close preview"
                  style={{
                    background: 'none', border: 'none', cursor: 'pointer',
                    display: 'flex', alignItems: 'center', color: T.onSurfaceVariant, padding: '5px 6px',
                  }}
                >
                  <Icon name={'close'} size={16} />
                </button>
              </div>
            </div>

            <div style={{
              flex: 1,
              minHeight: 0,
              overflow: 'auto',
              backgroundColor: T.surfaceContainerLow,
              display: 'flex',
              justifyContent: 'center',
              alignItems: 'stretch',
              padding: previewDevice === 'mobile' ? '20px' : '0',
            }}>
              <iframe
                key={`live-${form.contentMode}-${previewDoc.length}`}
                srcDoc={previewDoc || `<p style="padding:40px;color:#9ca3af;text-align:center;font-family:Inter,sans-serif;font-size:13px">Start writing your email to see the preview here…</p>`}
                style={{
                  border: 'none',
                  width: previewDevice === 'mobile' ? '375px' : '100%',
                  height: 'auto',
                  minHeight: previewDevice === 'mobile' ? '600px' : '500px',
                  alignSelf: 'stretch',
                  backgroundColor: '#ffffff',
                  boxShadow: previewDevice === 'mobile' ? '0 4px 20px rgba(0,0,0,0.12)' : 'none',
                  borderRadius: previewDevice === 'mobile' ? T.radiusXl : '0',
                  flexShrink: 0,
                  display: 'block',
                }}
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

      {/* ── Content Hub picker */}
      {showHubPicker && (
        <ContentHubPickerModal
          assets={hubAssets}
          loading={hubLoading}
          onClose={() => setShowHubPicker(false)}
          onPick={applyHubAsset}
        />
      )}

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
