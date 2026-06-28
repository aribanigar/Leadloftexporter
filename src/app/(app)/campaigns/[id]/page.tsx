'use client';

/**
 * Campaign Detail / Report — ported from the email-marketing module, rewired
 * to the LeadCaptura FastAPI backend (api() client only).
 *
 * Backend contract used here:
 *   GET  /campaigns/{id}              → full campaign dict
 *   GET  /campaigns/{id}/stats        → deliverability report (snake_case)
 *   GET  /campaigns/{id}/recipients   → recipient rows (id,email,status,error,sent_at,…)
 *   POST /campaigns/{id}/start        → begin sending (validates senders + first tick)
 *   POST /campaigns/{id}/tick         → advance one batch (frontend poll IS the send loop)
 *   POST /campaigns/{id}/pause|resume|cancel
 *   POST /campaigns/{id}/duplicate
 *
 * There is no DELETE endpoint and no open/click tracking per-recipient beyond
 * the recipient `status` (opened|clicked). "Campaign Replies" was Via-Kashmir
 * filler in the source and is dropped. See the report at end of session.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { api, ApiError, getToken, getWorkspaceId } from '@/lib/api';

// ─── Types (backend shapes) ────────────────────────────────────────────────

interface RecipientRow {
  id: string;
  lead_id: string | null;
  lead_name: string | null;
  email: string;
  status: string; // pending | sending | sent | failed | skipped | opened | clicked | bounced
  error: string | null;
  sent_at: string | null;
  sender_account_id: string | null;
}

interface TrackedLink {
  tracking_id?: string;
  original_url?: string;
  url?: string;
  clicks?: number;
}

interface StatsResp {
  campaign: { name: string; subject: string; status: string; goal: string | null; sent_at: string | null };
  stats: {
    total: number;
    sent: number;
    opened: number;
    clicked: number;
    bounced: number;
    open_rate: number;
    click_rate: number;
    bounce_rate: number;
    delivery_rate: number;
  };
  status_counts: Record<string, number>;
  performance: 'good' | 'average' | 'critical';
  what_went_well: string[];
  what_needs_work: string[];
  analysis: string[];
  goal_achieved: number;
  goal_label: string;
  benchmarks: { open_target: number; click_target: number };
  links: TrackedLink[];
}

interface Campaign {
  id: string;
  name: string;
  subject: string;
  preheader: string | null;
  body_html: string;
  status: string;
  from_name: string | null;
  from_email: string | null;
  reply_to: string | null;
  goal: string | null;
  tags: string[];
  merge_columns: string[];
  sender_account_ids: string[];
  batch_size: number;
  seconds_between_sends: number;
  warmup_enabled: boolean;
  scheduled_for: string | null;
  started_at: string | null;
  finished_at: string | null;
  last_tick_at: string | null;
  total_recipients: number;
  sent_count: number;
  failed_count: number;
  skipped_count: number;
  opened_count: number;
  clicked_count: number;
  bounced_count: number;
  queued_count?: number;
  error: string | null;
  created_at: string;
}

// ── Normalised UI shapes (kept from the source module) ──

type Perf = 'good' | 'average' | 'critical' | 'pending';

interface UiRecipient {
  email: string;
  status: 'pending' | 'sent' | 'opened' | 'clicked' | 'bounced' | 'failed' | 'skipped';
  opened: boolean;
  clicks: number;
  bouncedAt?: string;
  error?: string;
}

interface UiLink {
  trackingId?: string;
  url: string;
  clicks: number;
}

interface UiStats {
  totalRecipients: number;
  sent: number;
  opened: number;
  clicked: number;
  bounced: number;
  deliveryRate: number;
  openRate: number;
  clickRate: number;
  bounceRate: number;
  performance: Perf;
  statusCounts: Record<string, number>;
  analysis: string[];
  whatWentWell: string[];
  whatNeedsWork: string[];
  goalAchieved?: number;
  goalLabel?: string;
  benchmarks?: { openTarget: number; clickTarget: number };
  links: UiLink[];
  recipients: UiRecipient[];
}

// ─── Design Tokens ──────────────────────────────────────────────────────────

const T = {
  primary: '#00361a',
  primaryContainer: '#1a4d2e',
  surface: '#f5f1e8',
  surfaceContainerLow: '#f3f4f5',
  surfaceContainer: '#edeeef',
  surfaceContainerLowest: '#ffffff',
  onSurface: '#191c1d',
  onSurfaceVariant: '#414942',
  secondary: '#13677b',
  saffron: '#ffdcc4',
  ghost: 'rgba(193,201,191,0.15)',
  shadow: '0 8px 40px rgba(25,28,29,0.04)',
  gradientCta: 'linear-gradient(135deg, #00361a, #1a4d2e)',
};

const PAGE_SIZE = 50;

const RECIPIENT_STATUS_CFG: Record<UiRecipient['status'], { bg: string; color: string; label: string }> = {
  pending: { bg: 'rgba(65,73,66,0.08)', color: '#414942', label: 'Pending' },
  sent: { bg: 'rgba(19,103,123,0.1)', color: '#13677b', label: 'Sent' },
  opened: { bg: 'rgba(255,220,196,0.45)', color: '#92400e', label: 'Opened' },
  clicked: { bg: 'rgba(0,54,26,0.1)', color: '#00361a', label: 'Clicked' },
  bounced: { bg: 'rgba(220,38,38,0.1)', color: '#dc2626', label: 'Bounced' },
  // Transport/sender failure — NOT a bad recipient. Amber, not red, so it's
  // visibly distinct from a real bounce, and the row shows the actual error.
  failed: { bg: 'rgba(217,119,6,0.12)', color: '#b45309', label: 'Send failed' },
  skipped: { bg: 'rgba(65,73,66,0.06)', color: '#6b7280', label: 'Skipped' },
};

// ─── Helpers ────────────────────────────────────────────────────────────────

function fmtDate(dateStr?: string | null): string {
  if (!dateStr) return '—';
  try {
    return new Date(dateStr).toLocaleString('en-US', {
      day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: true,
    });
  } catch {
    return dateStr;
  }
}

function timeAgo(dateStr?: string | null): string {
  if (!dateStr) return '—';
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} minute${mins !== 1 ? 's' : ''} ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hour${hrs !== 1 ? 's' : ''} ago`;
  const days = Math.floor(hrs / 24);
  return `${days} day${days !== 1 ? 's' : ''} ago`;
}

function normaliseRecipient(r: RecipientRow): UiRecipient {
  const opened = r.status === 'opened' || r.status === 'clicked';
  const clicks = r.status === 'clicked' ? 1 : 0;
  let status: UiRecipient['status'] = 'pending';
  if (r.status === 'clicked') status = 'clicked';
  else if (r.status === 'opened') status = 'opened';
  else if (r.status === 'bounced') status = 'bounced';
  else if (r.status === 'failed') status = 'failed';   // transport/sender error — distinct from a real bounce
  else if (r.status === 'skipped') status = 'skipped';
  else if (r.status === 'sent') status = 'sent';
  return {
    email: r.email,
    status,
    opened,
    clicks,
    bouncedAt: r.status === 'bounced' || r.status === 'failed' ? r.sent_at ?? undefined : undefined,
    error: r.error ?? undefined,
  };
}

// ─── Toast ─────────────────────────────────────────────────────────────────

function Toast({ msg, type, onClose }: { msg: string; type: 'success' | 'error'; onClose: () => void }) {
  useEffect(() => { const t = setTimeout(onClose, 3500); return () => clearTimeout(t); }, [onClose]);
  return (
    <div style={{
      position: 'fixed', bottom: '28px', left: '50%', transform: 'translateX(-50%)',
      background: type === 'success' ? T.gradientCta : 'linear-gradient(135deg, #dc2626, #b91c1c)',
      color: '#fff', borderRadius: '12px', padding: '13px 26px',
      fontSize: '13px', fontWeight: 600, zIndex: 9999,
      boxShadow: '0 8px 32px rgba(0,0,0,0.18)',
      display: 'flex', alignItems: 'center', gap: '10px',
      whiteSpace: 'nowrap', fontFamily: 'Inter, sans-serif',
    }}>
      <span className="material-symbols-outlined" style={{ fontSize: '17px', fontVariationSettings: "'FILL' 1" }}>
        {type === 'success' ? 'check_circle' : 'error'}
      </span>
      {msg}
    </div>
  );
}

// ─── Confirm Dialog ─────────────────────────────────────────────────────────

function ConfirmDialog({ message, confirmLabel, onConfirm, onCancel }: {
  message: string; confirmLabel: string; onConfirm: () => void; onCancel: () => void;
}) {
  return (
    <div style={{
      position: 'fixed', inset: 0, backgroundColor: 'rgba(25,28,29,0.45)',
      zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px',
      backdropFilter: 'blur(4px)',
    }}>
      <div style={{
        backgroundColor: T.surfaceContainerLowest, borderRadius: '16px', padding: '32px',
        maxWidth: '420px', width: '100%', boxShadow: '0 24px 80px rgba(25,28,29,0.18)',
      }}>
        <h3 style={{ fontSize: '17px', fontWeight: 700, color: T.onSurface, margin: '0 0 10px', fontFamily: 'Manrope, sans-serif' }}>
          Confirm Action
        </h3>
        <p style={{ fontSize: '14px', color: T.onSurfaceVariant, margin: '0 0 28px', lineHeight: 1.65, fontFamily: 'Inter, sans-serif' }}>
          {message}
        </p>
        <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
          <button onClick={onCancel} style={{
            padding: '10px 20px', border: 'none', borderRadius: '8px',
            fontSize: '13px', fontWeight: 600, color: T.onSurfaceVariant,
            backgroundColor: T.surfaceContainer, cursor: 'pointer', fontFamily: 'Inter, sans-serif',
          }}>Cancel</button>
          <button onClick={onConfirm} style={{
            padding: '10px 20px', border: 'none', borderRadius: '8px',
            fontSize: '13px', fontWeight: 600, color: '#fff', backgroundColor: '#dc2626',
            cursor: 'pointer', fontFamily: 'Inter, sans-serif',
          }}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}

// ─── Mini Bar Chart ─────────────────────────────────────────────────────────

function MiniBarChart({ value }: { value: number }) {
  const bars = Array.from({ length: 7 }, (_, i) => {
    const seed = (value * (i + 1) * 31) % 100;
    return Math.max(15, seed);
  });
  const max = Math.max(...bars);
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: '3px', height: '40px' }}>
      {bars.map((h, i) => (
        <div key={i} style={{
          width: '8px',
          height: `${(h / max) * 100}%`,
          backgroundColor: i === bars.length - 1 ? T.primary : `rgba(0,54,26,${0.3 + (i / bars.length) * 0.5})`,
          borderRadius: '3px 3px 0 0',
          transition: 'height 0.4s ease',
        }} />
      ))}
    </div>
  );
}

// ─── Campaign Status Badge (perf) ─────────────────────────────────────────────

function CampaignStatusBadge({ performance }: { performance?: Perf }) {
  if (!performance) return null;
  const cfg = {
    good: { bg: 'rgba(0,54,26,0.08)', border: 'rgba(0,54,26,0.15)', icon: 'check_circle', color: T.primary, label: 'Good', iconColor: '#16a34a' },
    average: { bg: 'rgba(255,220,196,0.5)', border: 'rgba(146,64,14,0.2)', icon: 'warning', color: '#92400e', label: 'Average', iconColor: '#d97706' },
    critical: { bg: 'rgba(220,38,38,0.08)', border: 'rgba(220,38,38,0.2)', icon: 'warning', color: '#dc2626', label: 'Critical Attention', iconColor: '#dc2626' },
    // Backend now returns "pending" while a freshly-launched campaign is
    // still draining its queue — show that as neutral "Sending" instead of
    // smashing "Critical Attention" onto a 0-delivered campaign.
    pending: { bg: 'rgba(99,102,241,0.10)', border: 'rgba(99,102,241,0.22)', icon: 'sync', color: '#4338ca', label: 'Sending', iconColor: '#6366f1' },
  }[performance];
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: '8px',
      backgroundColor: cfg.bg,
      border: `1px solid ${cfg.border}`,
      borderRadius: '10px', padding: '8px 14px',
    }}>
      <span className="material-symbols-outlined" style={{ fontSize: '15px', color: cfg.iconColor, fontVariationSettings: "'FILL' 1" }}>
        {cfg.icon}
      </span>
      <div>
        <div style={{ fontSize: '9px', fontWeight: 700, color: cfg.color, textTransform: 'uppercase', letterSpacing: '0.08em', fontFamily: 'Inter, sans-serif' }}>
          Campaign Status
        </div>
        <div style={{ fontSize: '12px', fontWeight: 700, color: cfg.color, fontFamily: 'Manrope, sans-serif' }}>
          {cfg.label}
        </div>
      </div>
    </div>
  );
}

// ─── Three-dot Menu ───────────────────────────────────────────────────────────

function ActionMenu({
  campaign, sending, duplicating, onStart, onDuplicate, onCancel, onPause, onResume, onNudge, onSendRemaining,
}: {
  campaign: Campaign; sending: boolean; duplicating: boolean;
  onStart: () => void; onDuplicate: () => void; onCancel: () => void;
  onPause: () => void; onResume: () => void; onNudge: () => void; onSendRemaining: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const canStart = campaign.status === 'draft' || campaign.status === 'scheduled';
  const items: { label: string; icon: string; color?: string; onClick: () => void; disabled?: boolean }[] = [
    ...(canStart ? [{
      label: sending ? 'Starting…' : 'Send Campaign',
      icon: 'send', color: T.primary,
      onClick: () => { setOpen(false); onStart(); },
      disabled: sending,
    }] : []),
    ...(campaign.status === 'paused' ? [{
      label: sending ? 'Resuming…' : 'Resume Campaign',
      icon: 'play_arrow', color: T.primary,
      onClick: () => { setOpen(false); onResume(); },
      disabled: sending,
    }] : []),
    ...(campaign.status === 'sending' ? [{
      label: 'Pause Campaign',
      icon: 'pause_circle', color: '#c8a84b',
      onClick: () => { setOpen(false); onPause(); },
    }] : []),
    ...(campaign.status === 'sending' || campaign.status === 'paused' ? [{
      label: 'Send Now (reset schedule)',
      icon: 'bolt', color: T.primary,
      onClick: () => { setOpen(false); onNudge(); },
    }] : []),
    ...(campaign.status !== 'draft' && campaign.status !== 'scheduled' ? [{
      label: sending ? 'Sending…' : 'Send Remaining Emails',
      icon: 'forward_to_inbox', color: T.primary,
      onClick: () => { setOpen(false); onSendRemaining(); },
      disabled: sending,
    }] : []),
    {
      label: 'Edit Campaign',
      icon: 'edit',
      onClick: () => { window.location.href = `/campaigns/new?id=${campaign.id}`; },
    },
    {
      label: duplicating ? 'Duplicating…' : 'Duplicate',
      icon: 'content_copy',
      onClick: () => { setOpen(false); onDuplicate(); },
      disabled: duplicating,
    },
    ...(campaign.status === 'sending' || campaign.status === 'paused' ? [{
      label: 'Cancel Campaign',
      icon: 'cancel', color: '#dc2626',
      onClick: () => { setOpen(false); onCancel(); },
    }] : []),
  ];

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          width: '38px', height: '38px', borderRadius: '8px', border: 'none',
          backgroundColor: open ? T.surfaceContainer : 'transparent',
          cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
          transition: 'background 0.15s',
        }}
        aria-label="Campaign actions"
      >
        <span className="material-symbols-outlined" style={{ fontSize: '20px', color: T.onSurfaceVariant }}>more_vert</span>
      </button>
      {open && (
        <div style={{
          position: 'absolute', top: '44px', right: 0,
          backgroundColor: T.surfaceContainerLowest,
          borderRadius: '12px', padding: '6px',
          boxShadow: '0 12px 40px rgba(25,28,29,0.14)',
          minWidth: '180px', zIndex: 200,
        }}>
          {items.map((item, i) => (
            <button
              key={i}
              onClick={item.onClick}
              disabled={item.disabled}
              style={{
                width: '100%', display: 'flex', alignItems: 'center', gap: '10px',
                padding: '10px 14px', border: 'none', borderRadius: '8px',
                backgroundColor: 'transparent', cursor: item.disabled ? 'not-allowed' : 'pointer',
                fontSize: '13px', fontWeight: 600, color: item.color ?? T.onSurface,
                fontFamily: 'Inter, sans-serif', textAlign: 'left',
                opacity: item.disabled ? 0.5 : 1,
                transition: 'background 0.1s',
              }}
              onMouseEnter={e => { if (!item.disabled) (e.currentTarget as HTMLButtonElement).style.backgroundColor = T.surfaceContainerLow; }}
              onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'transparent'; }}
            >
              <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>{item.icon}</span>
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Hero Stat Card ─────────────────────────────────────────────────────────

function HeroStatCard({
  icon, label, value, trend, trendUp, progressPct,
}: {
  icon: string; label: string; value: string; trend?: string; trendUp?: boolean; progressPct: number;
}) {
  return (
    <div style={{
      backgroundColor: T.surfaceContainerLowest,
      borderRadius: '12px',
      padding: '24px 24px 0',
      boxShadow: T.shadow,
      display: 'flex', flexDirection: 'column', gap: '12px',
      overflow: 'hidden', flex: 1,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <div style={{
            width: '36px', height: '36px', borderRadius: '10px',
            backgroundColor: T.surfaceContainerLow,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <span className="material-symbols-outlined" style={{ fontSize: '18px', color: T.primary, fontVariationSettings: "'FILL' 1" }}>
              {icon}
            </span>
          </div>
          <span style={{ fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.09em', color: T.onSurfaceVariant, fontFamily: 'Inter, sans-serif' }}>
            {label}
          </span>
        </div>
        {trend && (
          <span style={{
            fontSize: '12px', fontWeight: 700,
            backgroundColor: trendUp ? 'rgba(22,163,74,0.1)' : 'rgba(220,38,38,0.1)',
            color: trendUp ? '#16a34a' : '#dc2626',
            borderRadius: '6px', padding: '3px 8px', fontFamily: 'Inter, sans-serif',
          }}>
            {trend}
          </span>
        )}
      </div>
      <div style={{ fontSize: '48px', fontWeight: 900, color: T.onSurface, fontFamily: 'Manrope, sans-serif', lineHeight: 1, letterSpacing: '-0.02em' }}>
        {value}
      </div>
      <div style={{
        height: '3px', backgroundColor: T.surfaceContainer, borderRadius: '0',
        margin: '0 -24px',
      }}>
        <div style={{
          height: '100%',
          width: `${Math.min(progressPct, 100)}%`,
          background: T.gradientCta,
          borderRadius: '0',
          transition: 'width 0.6s ease',
        }} />
      </div>
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function CampaignDetailPage() {
  const params = useParams();
  const id = (params?.id as string) || '';

  const [campaign, setCampaign] = useState<Campaign | null>(null);
  const [stats, setStats] = useState<UiStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [statsLoading, setStatsLoading] = useState(false);
  // Live heartbeat for the Integrity Report: when stats last refreshed + a 1s
  // ticker so the "updated Ns ago" label counts up in real time.
  const [lastStatsAt, setLastStatsAt] = useState<number | null>(null);
  const [, setNowTick] = useState(0);
  const [toast, setToast] = useState<{ msg: string; type: 'success' | 'error' } | null>(null);
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [page, setPage] = useState(1);
  const [sending, setSending] = useState(false);
  const [duplicating, setDuplicating] = useState(false);
  // Why a 'sending' campaign isn't actually dispatching (surfaced from the tick
  // response note) — e.g. no active sender, or a brief rate-limit cooldown.
  const [tickNote, setTickNote] = useState<string | null>(null);
  const [selectedLinkUrl, setSelectedLinkUrl] = useState<string | null>(null);
  const [showAllLinks, setShowAllLinks] = useState(false);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const statusRef = useRef<string | null>(null);

  // ── Fetch campaign
  const fetchCampaign = useCallback(async () => {
    try {
      const c = await api<Campaign>(`/campaigns/${id}`);
      setCampaign(c);
      statusRef.current = c.status;
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, [id]);

  // ── Fetch stats + recipients (merged into the UiStats shape the UI expects)
  const fetchStats = useCallback(async (quiet = false) => {
    if (!quiet) setStatsLoading(true);
    try {
      const [s, recips] = await Promise.all([
        api<StatsResp>(`/campaigns/${id}/stats`),
        api<RecipientRow[]>(`/campaigns/${id}/recipients?limit=500`),
      ]);
      const links: UiLink[] = (s.links ?? []).map(l => ({
        trackingId: l.tracking_id,
        url: l.original_url ?? l.url ?? '',
        clicks: l.clicks ?? 0,
      }));
      setStats({
        totalRecipients: s.stats.total,
        sent: s.stats.sent,
        opened: s.stats.opened,
        clicked: s.stats.clicked,
        bounced: s.stats.bounced,
        deliveryRate: s.stats.delivery_rate,
        openRate: s.stats.open_rate,
        clickRate: s.stats.click_rate,
        bounceRate: s.stats.bounce_rate,
        performance: s.performance,
        statusCounts: s.status_counts ?? {},
        analysis: s.analysis ?? [],
        whatWentWell: s.what_went_well ?? [],
        whatNeedsWork: s.what_needs_work ?? [],
        goalAchieved: s.goal_achieved,
        goalLabel: s.goal_label,
        benchmarks: s.benchmarks
          ? { openTarget: s.benchmarks.open_target, clickTarget: s.benchmarks.click_target }
          : undefined,
        links,
        recipients: (recips ?? []).map(normaliseRecipient),
      });
      setLastStatsAt(Date.now());
    } catch {
      // silent — stats may 404 transiently before first tick
    } finally {
      if (!quiet) setStatsLoading(false);
    }
  }, [id]);

  // 1s ticker so "updated Ns ago" stays live between refreshes.
  useEffect(() => {
    const t = setInterval(() => setNowTick((n) => (n + 1) % 1000000), 1000);
    return () => clearInterval(t);
  }, []);

  // ── The poll-driven send tick. Calls the Next.js /api/campaigns/{id}/tick
  // route which sends from Vercel's network (no SMTP port block) then commits
  // results back to Python. Falls back to the Python tick endpoint for Gmail
  // and other OAuth senders where nodemailer isn't needed.
  const runTick = useCallback(async () => {
    try {
      const token = getToken();
      const wsId = getWorkspaceId();
      const res = await fetch(`/api/campaigns/${id}/tick`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token || ''}`,
          'X-Workspace-Id': wsId || '',
        },
        body: '{}',
      });
      const r = await res.json() as { status?: string; note?: string };
      // Surface WHY nothing is sending (no active sender, cooldown, …) so a
      // 'Sending… 0 delivered' campaign never sits there silently.
      setTickNote(r.note ?? null);
      // Refresh status + counters cheaply via the full campaign read.
      await fetchCampaign();
      await fetchStats(true);
      if (r.status !== 'sending' && pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    } catch {
      // silent — keep polling
    }
  }, [id, fetchCampaign, fetchStats]);

  // ── Initial load
  useEffect(() => {
    fetchCampaign();
    fetchStats();
  }, [fetchCampaign, fetchStats]);

  // ── Polling: tick + refresh while sending
  useEffect(() => {
    if (campaign?.status === 'sending') {
      if (!pollRef.current) {
        pollRef.current = setInterval(() => { runTick(); }, 3000);
      }
    } else if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    return () => {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    };
  }, [campaign?.status, runTick]);

  // ── Live engagement refresh. Opens/clicks keep trickling in for hours after
  // a campaign finishes sending, so the reading rate must stay dynamic even
  // when the campaign is completed/paused. A quiet 15s poll keeps the numbers
  // current without the visible spinner. (The 3s send-tick above owns the
  // refresh while status === 'sending', so we skip it then to avoid double work.)
  useEffect(() => {
    if (campaign?.status === 'sending') return;
    // Refresh BOTH the campaign counters (which back the Integrity Report +
    // Real-time Delivery) and engagement stats, so every panel stays live.
    const t = setInterval(() => { fetchCampaign(); fetchStats(true); }, 15000);
    return () => clearInterval(t);
  }, [campaign?.status, fetchCampaign, fetchStats]);

  // ── Start campaign
  const handleStart = async () => {
    setSending(true);
    try {
      await api(`/campaigns/${id}/start`, { method: 'POST' });
      setToast({ msg: 'Campaign is sending…', type: 'success' });
      setCampaign(prev => prev ? { ...prev, status: 'sending' } : prev);
      await fetchStats(true);
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : 'Failed to start';
      setToast({ msg, type: 'error' });
    } finally {
      setSending(false);
    }
  };

  // ── Pause
  const handlePause = async () => {
    try {
      await api(`/campaigns/${id}/pause`, { method: 'POST' });
      setToast({ msg: 'Campaign paused — stops after the current batch', type: 'success' });
      setCampaign(prev => prev ? { ...prev, status: 'paused' } : prev);
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : 'Failed to pause';
      setToast({ msg, type: 'error' });
    }
  };

  // ── Resume
  const handleResume = async () => {
    setSending(true);
    try {
      await api(`/campaigns/${id}/resume`, { method: 'POST' });
      setToast({ msg: 'Campaign resumed', type: 'success' });
      setCampaign(prev => prev ? { ...prev, status: 'sending' } : prev);
      await fetchStats(true);
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : 'Failed to resume';
      setToast({ msg, type: 'error' });
    } finally {
      setSending(false);
    }
  };

  // ── Send Remaining — resume a campaign that stopped half-way and dispatch
  //    only the balance emails so it reaches 100%. Works on any stopped
  //    campaign (paused, cancelled, failed, stalled, or wrongly "completed").
  const handleSendRemaining = async () => {
    setSending(true);
    try {
      // The endpoint is idempotent (it only flips state + marks the balance
      // due-now), so it's safe to retry. Absorb a Render free-tier cold-start
      // or a brief redeploy by retrying a few times with backoff instead of
      // surfacing a scary "couldn't reach the server" on the first miss.
      type SendRemainingRes = { status?: string; remaining?: number; resumed_remaining?: number; message?: string };
      let res: SendRemainingRes | undefined;
      let lastErr: unknown;
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          res = await api<SendRemainingRes>(`/campaigns/${id}/send-remaining`, { method: 'POST' });
          lastErr = undefined;
          break;
        } catch (e) {
          lastErr = e;
          // A real client error (4xx) won't fix itself — stop retrying.
          if (e instanceof ApiError && e.status >= 400 && e.status < 500) break;
          if (attempt < 3) {
            setToast({ msg: 'Waking the server… one moment', type: 'success' });
            await new Promise(r => setTimeout(r, 4000 * (attempt + 1)));
          }
        }
      }
      if (lastErr || !res) throw lastErr ?? new Error('no_response');
      if (res?.remaining === 0) {
        setToast({ msg: 'Nothing left to send — campaign is already 100% complete', type: 'success' });
        if (res.status) setCampaign(prev => prev ? { ...prev, status: res.status as Campaign['status'] } : prev);
      } else {
        const n = res?.resumed_remaining;
        setToast({
          msg: n
            ? `Resuming — ${n} remaining email${n === 1 ? '' : 's'} will send`
            : 'Resuming the remaining emails',
          type: 'success',
        });
        setCampaign(prev => prev ? { ...prev, status: 'sending' } : prev);
      }
      await fetchStats(true);
    } catch (e) {
      const msg = e instanceof ApiError
        ? e.message
        : "Couldn't reach the server — it may be waking up. Try again in a few seconds.";
      setToast({ msg, type: 'error' });
    } finally {
      setSending(false);
    }
  };

  // ── Nudge — reset every pending recipient's send_after to NOW so a
  //    campaign launched on the old pre-stretch schedule (or stalled after a
  //    cooldown) drains immediately at the configured per-sender pace.
  const handleNudge = async () => {
    try {
      const res = await api<{ nudged: number; ticked: boolean }>(
        `/campaigns/${id}/nudge`, { method: 'POST' }
      );
      setToast({
        msg: res.nudged
          ? `Nudged ${res.nudged} recipient${res.nudged === 1 ? '' : 's'} — sending now`
          : 'No pending recipients to nudge',
        type: 'success',
      });
      await fetchStats(true);
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : 'Failed to nudge';
      setToast({ msg, type: 'error' });
    }
  };

  // ── Cancel
  const handleCancel = async () => {
    setShowCancelConfirm(false);
    try {
      await api(`/campaigns/${id}/cancel`, { method: 'POST' });
      setToast({ msg: 'Campaign cancelled', type: 'success' });
      setCampaign(prev => prev ? { ...prev, status: 'cancelled' } : prev);
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : 'Failed to cancel';
      setToast({ msg, type: 'error' });
    }
  };

  // ── Duplicate
  const handleDuplicate = async () => {
    setDuplicating(true);
    try {
      const r = await api<{ id: string }>(`/campaigns/${id}/duplicate`, { method: 'POST' });
      setToast({ msg: 'Campaign duplicated', type: 'success' });
      setTimeout(() => { window.location.href = `/campaigns/${r.id}`; }, 900);
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : 'Failed to duplicate';
      setToast({ msg, type: 'error' });
    } finally {
      setDuplicating(false);
    }
  };

  // ── Derived
  const filteredRecipients = (stats?.recipients ?? []).filter(r =>
    r.email.toLowerCase().includes(searchQuery.toLowerCase())
  );
  const totalPages = Math.ceil(filteredRecipients.length / PAGE_SIZE);
  const pagedRecipients = filteredRecipients.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  // ── Loading state
  if (loading) {
    return (
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        minHeight: '100vh', backgroundColor: T.surface, flexDirection: 'column', gap: '16px',
        fontFamily: 'Inter, sans-serif',
      }}>
        <div style={{
          width: '36px', height: '36px', border: `3px solid ${T.primary}`,
          borderTopColor: 'transparent', borderRadius: '50%',
          animation: 'spin 0.7s linear infinite',
        }} />
        <span style={{ fontSize: '14px', color: T.onSurfaceVariant }}>Loading campaign…</span>
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    );
  }

  if (!campaign) {
    return (
      <div style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        minHeight: '100vh', gap: '16px', backgroundColor: T.surface, fontFamily: 'Inter, sans-serif',
      }}>
        <span className="material-symbols-outlined" style={{ fontSize: '48px', color: T.surfaceContainer }}>campaign</span>
        <p style={{ fontSize: '16px', color: T.onSurfaceVariant }}>Campaign not found</p>
        <Link href="/campaigns" style={{ color: T.primary, fontSize: '14px', fontWeight: 600 }}>
          Back to campaigns
        </Link>
      </div>
    );
  }

  const updatedAt = campaign.finished_at || campaign.started_at || campaign.created_at;
  const openRate = stats?.openRate ?? 0;
  const clickRate = stats?.clickRate ?? 0;

  const openTrend = stats?.benchmarks
    ? `${openRate >= stats.benchmarks.openTarget ? '+' : ''}${(openRate - stats.benchmarks.openTarget).toFixed(1)}%`
    : null;
  const clickTrend = stats?.benchmarks
    ? `${clickRate >= stats.benchmarks.clickTarget ? '+' : ''}${(clickRate - stats.benchmarks.clickTarget).toFixed(1)}%`
    : null;

  const bouncedRecipients = (stats?.recipients ?? []).filter(r => r.status === 'bounced');
  const maxLinkClicks = stats ? Math.max(...(stats.links.map(l => l.clicks)), 1) : 1;

  // ── Live integrity figures ──
  // Sourced from the SAME live campaign counters the "Real-time Delivery" panel
  // uses (campaign.*_count, refreshed every tick) so the two never disagree.
  const intTotal = campaign.total_recipients;
  const intDelivered = campaign.sent_count;
  const intBounced = campaign.bounced_count;
  const intFailed = campaign.failed_count;
  const intSkipped = campaign.skipped_count;
  // Queued = recipients still genuinely waiting to send. Prefer the live
  // queued_count field returned by the backend (actual pending+sending row
  // count) which is immune to counter drift. Fall back to counter arithmetic
  // for responses from older deploys that don't include the field.
  const intQueued = typeof campaign.queued_count === 'number'
    ? campaign.queued_count
    : Math.max(intTotal - intDelivered - intFailed - intSkipped - intBounced, 0);
  const intIssues = intBounced + intFailed;
  // Deliverability = quality of what's been attempted (delivered vs bounced),
  // from the same counters so the gauge agrees with the tiles.
  const intAttempted = intDelivered + intBounced;
  const intBounceRate = intAttempted > 0 ? (intBounced / intAttempted) * 100 : 0;
  const intDeliveryPct = intAttempted > 0 ? 100 - intBounceRate : 0;
  // Live "updated Ns ago" — recomputed every second via the ticker.
  const statsAgeSec = lastStatsAt ? Math.max(0, Math.floor((Date.now() - lastStatsAt) / 1000)) : null;

  return (
    <div style={{ fontFamily: 'Inter, sans-serif', backgroundColor: T.surface, minHeight: '100vh', paddingBottom: '60px' }}>
      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.35} }
        @keyframes liveDot { 0%,100%{transform:scale(1);opacity:1} 50%{transform:scale(1.4);opacity:0.7} }
        * { box-sizing: border-box; }
      `}</style>

      {/* ─── Header ──────────────────────────────────────────────────────────── */}
      <div style={{
        backgroundColor: T.surfaceContainerLowest,
        borderBottom: `1px solid ${T.ghost}`,
        padding: '20px 32px',
        position: 'sticky', top: 0, zIndex: 100,
        boxShadow: '0 2px 12px rgba(25,28,29,0.04)',
      }}>
        <Link href="/campaigns" style={{
          display: 'inline-flex', alignItems: 'center', gap: '5px',
          color: T.onSurfaceVariant, textDecoration: 'none', fontSize: '12px', fontWeight: 600,
          letterSpacing: '0.02em', marginBottom: '10px',
          transition: 'color 0.15s',
        }}>
          <span className="material-symbols-outlined" style={{ fontSize: '15px' }}>arrow_back</span>
          Back to Campaigns
        </Link>

        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: '16px', flexWrap: 'wrap' }}>
          <div>
            <h1 style={{
              fontSize: '28px', fontWeight: 900, color: T.onSurface,
              margin: '0 0 4px', fontFamily: 'Manrope, sans-serif', lineHeight: 1.15,
              letterSpacing: '-0.02em',
            }}>
              {campaign.name}
            </h1>
            <p style={{ fontSize: '13px', color: T.onSurfaceVariant, margin: 0, fontFamily: 'Inter, sans-serif' }}>
              Individual campaign performance &mdash;&nbsp;Last updated {timeAgo(updatedAt)}
              {campaign.status === 'sending' && (
                <span style={{ marginLeft: '12px', display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
                  <span style={{
                    width: '6px', height: '6px', borderRadius: '50%', backgroundColor: '#16a34a',
                    animation: 'liveDot 1.4s ease-in-out infinite', display: 'inline-block',
                  }} />
                  <span style={{ fontSize: '12px', fontWeight: 600, color: '#16a34a' }}>Live — sending every 3s</span>
                </span>
              )}
            </p>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <CampaignStatusBadge performance={stats?.performance} />
            <ActionMenu
              campaign={campaign}
              sending={sending}
              duplicating={duplicating}
              onStart={handleStart}
              onDuplicate={handleDuplicate}
              onCancel={() => setShowCancelConfirm(true)}
              onPause={handlePause}
              onResume={handleResume}
              onNudge={handleNudge}
              onSendRemaining={handleSendRemaining}
            />
          </div>
        </div>
      </div>

      <div style={{ maxWidth: '1160px', margin: '0 auto', padding: '28px 20px' }}>

        {/* ═══ Send-blocked banner ════════════════════════════════════
            The campaign says 'Sending' but nothing is going out. Tell the
            user WHY instead of leaving them staring at 'Sending… 0'. */}
        {campaign.status === 'sending' && tickNote === 'no_active_senders' && (
          <div style={{
            backgroundColor: 'rgba(220,38,38,0.08)',
            border: '1px solid rgba(220,38,38,0.30)',
            borderRadius: '12px', padding: '14px 18px', marginBottom: '20px',
            display: 'flex', alignItems: 'flex-start', gap: '12px',
          }}>
            <span className="material-symbols-outlined" style={{ fontSize: '20px', color: '#dc2626' }}>error</span>
            <div style={{ fontSize: '13px', color: '#7f1d1d', lineHeight: 1.5 }}>
              <strong>No active sender — nothing can send.</strong> This campaign is set to send
              from <strong>{campaign.from_email || 'an inbox'}</strong>, but that mailbox isn’t a
              connected, active sender. Connect it (or pick an already-connected inbox) in{' '}
              <a href="/settings/email" style={{ color: '#b91c1c', fontWeight: 700, textDecoration: 'underline' }}>Settings → Senders</a>,
              then press <strong>⋮ → Send Remaining</strong>. (Bounced/queued counts won’t move until a sender is active.)
            </div>
          </div>
        )}

        {/* ═══ Campaign Meta Info Bar ══════════════════════════════ */}
        <div style={{
          backgroundColor: T.surfaceContainerLowest,
          borderRadius: '12px', padding: '16px 20px',
          marginBottom: '20px', boxShadow: T.shadow,
          display: 'flex', flexWrap: 'wrap', gap: '20px', alignItems: 'flex-start',
        }}>
          {[
            { icon: 'person', label: 'From', value: campaign.from_name ? `${campaign.from_name}${campaign.from_email ? ` <${campaign.from_email}>` : ''}` : (campaign.from_email || '—') },
            { icon: 'reply', label: 'Reply-to', value: campaign.reply_to || campaign.from_email || '—' },
            { icon: 'flag', label: 'Goal', value: campaign.goal || '—' },
            {
              icon: 'schedule', label: campaign.finished_at ? 'Finished at' : campaign.started_at ? 'Started at' : 'Scheduled',
              value: campaign.finished_at ? fmtDate(campaign.finished_at) : campaign.started_at ? fmtDate(campaign.started_at) : campaign.scheduled_for ? fmtDate(campaign.scheduled_for) : '—',
            },
            { icon: 'timer', label: 'Send delay', value: `${campaign.seconds_between_sends}s between sends` },
            { icon: 'all_inbox', label: 'Batch size', value: `${campaign.batch_size} / tick` },
            { icon: 'local_fire_department', label: 'Warmup', value: campaign.warmup_enabled ? 'Enabled' : 'Off' },
          ].map(item => (
            <div key={item.label} style={{ minWidth: '160px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '5px', marginBottom: '3px' }}>
                <span className="material-symbols-outlined" style={{ fontSize: '13px', color: T.onSurfaceVariant }}>{item.icon}</span>
                <span style={{ fontSize: '10px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', color: T.onSurfaceVariant, fontFamily: 'Inter, sans-serif' }}>
                  {item.label}
                </span>
              </div>
              <div style={{ fontSize: '13px', fontWeight: 600, color: T.onSurface, fontFamily: 'Inter, sans-serif' }}>
                {item.value}
              </div>
            </div>
          ))}
          {campaign.merge_columns && campaign.merge_columns.length > 0 && (
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '5px', marginBottom: '5px' }}>
                <span className="material-symbols-outlined" style={{ fontSize: '13px', color: T.onSurfaceVariant }}>data_table</span>
                <span style={{ fontSize: '10px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', color: T.onSurfaceVariant, fontFamily: 'Inter, sans-serif' }}>
                  Personalisation tags
                </span>
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '5px' }}>
                {campaign.merge_columns.map(col => (
                  <span key={col} style={{
                    padding: '2px 8px', borderRadius: '99px',
                    backgroundColor: 'rgba(0,54,26,0.07)', color: T.primary,
                    fontSize: '11px', fontWeight: 700, fontFamily: '"Fira Code", monospace',
                  }}>{`{${col}}`}</span>
                ))}
              </div>
            </div>
          )}
          {campaign.tags && campaign.tags.length > 0 && (
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '5px', marginBottom: '5px' }}>
                <span className="material-symbols-outlined" style={{ fontSize: '13px', color: T.onSurfaceVariant }}>label</span>
                <span style={{ fontSize: '10px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', color: T.onSurfaceVariant, fontFamily: 'Inter, sans-serif' }}>Tags</span>
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '5px' }}>
                {campaign.tags.map(tag => (
                  <span key={tag} style={{
                    padding: '2px 8px', borderRadius: '99px',
                    backgroundColor: T.surfaceContainerLow, color: T.onSurfaceVariant,
                    fontSize: '11px', fontWeight: 600, fontFamily: 'Inter, sans-serif',
                  }}>{tag}</span>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* ═══ Hero Stats ══════════════════════════════ */}
        <div style={{ display: 'flex', gap: '16px', marginBottom: '20px', flexWrap: 'wrap' }}>
          <HeroStatCard
            icon="visibility"
            label="Reading Rate"
            value={stats ? `${openRate.toFixed(1)}%` : '—'}
            trend={openTrend ?? undefined}
            trendUp={openTrend ? !openTrend.startsWith('-') : undefined}
            progressPct={openRate}
          />
          <HeroStatCard
            icon="ads_click"
            label="Click Rate"
            value={stats ? `${clickRate.toFixed(1)}%` : '—'}
            trend={clickTrend ?? undefined}
            trendUp={clickTrend ? !clickTrend.startsWith('-') : undefined}
            progressPct={clickRate}
          />
        </div>

        {/* ═══ Real-time Delivery + Link Analytics ══════════════════════════════ */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginBottom: '20px' }}>

          {/* Real-time Delivery */}
          <div style={{
            backgroundColor: T.surfaceContainerLowest,
            borderRadius: '12px',
            padding: '24px',
            boxShadow: T.shadow,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
              <span style={{
                width: '7px', height: '7px', borderRadius: '50%',
                backgroundColor: '#16a34a',
                animation: campaign.status === 'sending' ? 'liveDot 1.4s ease-in-out infinite' : 'none',
                display: 'inline-block', flexShrink: 0,
              }} />
              <h2 style={{ fontSize: '15px', fontWeight: 700, color: T.onSurface, margin: 0, fontFamily: 'Manrope, sans-serif' }}>
                Real-time Delivery
              </h2>
            </div>
            <p style={{ fontSize: '12px', color: T.onSurfaceVariant, margin: '0 0 20px', fontFamily: 'Inter, sans-serif' }}>
              Live feed of transmission progress
            </p>

            <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
                <div>
                  <div style={{ fontSize: '10px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em', color: '#16a34a', marginBottom: '2px', fontFamily: 'Inter, sans-serif' }}>
                    Delivered
                  </div>
                  <div style={{ fontSize: '34px', fontWeight: 900, color: '#16a34a', fontFamily: 'Manrope, sans-serif', lineHeight: 1 }}>
                    {campaign.sent_count.toLocaleString()}
                  </div>
                </div>
                <div>
                  <div style={{ fontSize: '10px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em', color: T.onSurfaceVariant, marginBottom: '2px', fontFamily: 'Inter, sans-serif' }}>
                    Queued
                  </div>
                  <div style={{ fontSize: '28px', fontWeight: 900, color: T.onSurfaceVariant, fontFamily: 'Manrope, sans-serif', lineHeight: 1 }}>
                    {Math.max(0, campaign.total_recipients - campaign.sent_count - campaign.failed_count - campaign.skipped_count).toLocaleString()}
                  </div>
                  {/* Pace estimate — human-paced drip across inboxes. The send
                      loop deals each recipient a send_after stamp dealt round-
                      robin across active inboxes, advancing each by ~pace
                      seconds (with ±40% jitter). So effective throughput per
                      minute = 60 * inboxes / pace, and the queue drains in
                      roughly queued / (per-min) minutes. */}
                  {campaign.status === 'sending' && (() => {
                    const queued = typeof campaign.queued_count === 'number'
                      ? campaign.queued_count
                      : Math.max(0, campaign.total_recipients - campaign.sent_count - campaign.failed_count - campaign.skipped_count - campaign.bounced_count);
                    const pace = Math.max(1, campaign.seconds_between_sends || 30);
                    const inboxes = Math.max(1, (campaign.sender_account_ids || []).length);
                    const perMin = Math.max(1, Math.round((60 / pace) * inboxes));
                    if (queued <= 0) return null;
                    const minsLeft = Math.ceil(queued / perMin);
                    const fmt = minsLeft >= 60
                      ? `~${Math.floor(minsLeft / 60)}h ${minsLeft % 60}m`
                      : `~${minsLeft}m`;
                    return (
                      <div style={{
                        marginTop: '6px', fontSize: '11px',
                        color: T.onSurfaceVariant, fontFamily: 'Inter, sans-serif',
                      }}>
                        {fmt} left · ~{perMin}/min across {inboxes} inbox{inboxes !== 1 ? 'es' : ''}
                      </div>
                    );
                  })()}
                </div>
                <div>
                  <div style={{ fontSize: '10px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em', color: T.onSurfaceVariant, marginBottom: '2px', fontFamily: 'Inter, sans-serif' }}>
                    Failed / Skipped
                  </div>
                  <div style={{ fontSize: '20px', fontWeight: 800, color: T.onSurface, fontFamily: 'Manrope, sans-serif' }}>
                    {(campaign.failed_count + campaign.skipped_count).toLocaleString()}
                  </div>
                </div>
              </div>

              <MiniBarChart value={campaign.sent_count} />
            </div>
          </div>

          {/* Link Analytics */}
          <div style={{
            backgroundColor: T.surfaceContainerLowest,
            borderRadius: '12px', padding: '24px',
            boxShadow: T.shadow, display: 'flex', flexDirection: 'column',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
              <div>
                <h2 style={{ fontSize: '15px', fontWeight: 700, color: T.onSurface, margin: '0 0 2px', fontFamily: 'Manrope, sans-serif' }}>
                  Link Analytics
                </h2>
                <p style={{ fontSize: '11px', color: T.onSurfaceVariant, margin: 0, fontFamily: 'Inter, sans-serif' }}>
                  {stats ? `${stats.links.length} tracked link${stats.links.length !== 1 ? 's' : ''}` : 'Loading…'}
                </p>
              </div>
              {selectedLinkUrl && (
                <button onClick={() => setSelectedLinkUrl(null)} style={{
                  fontSize: '11px', fontWeight: 600, color: T.primary, background: 'rgba(0,54,26,0.07)',
                  border: 'none', borderRadius: '6px', padding: '4px 10px', cursor: 'pointer', fontFamily: 'Inter, sans-serif',
                }}>
                  ← All links
                </button>
              )}
            </div>

            {!stats || stats.links.length === 0 ? (
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '32px 0', gap: '8px' }}>
                <span className="material-symbols-outlined" style={{ fontSize: '32px', color: T.surfaceContainer }}>link_off</span>
                <p style={{ fontSize: '13px', color: T.onSurfaceVariant, margin: 0, fontFamily: 'Inter, sans-serif', textAlign: 'center' }}>
                  No links tracked yet. Links are tracked once the campaign starts sending.
                </p>
              </div>
            ) : selectedLinkUrl ? (
              (() => {
                const matched = stats.recipients.filter(r => r.status === 'clicked' || r.clicks > 0);
                const linkObj = stats.links.find(l => l.url === selectedLinkUrl);
                return (
                  <div style={{ flex: 1 }}>
                    <div style={{
                      padding: '10px 12px', borderRadius: '8px',
                      backgroundColor: 'rgba(0,54,26,0.06)', marginBottom: '14px',
                    }}>
                      <div style={{ fontSize: '10px', fontWeight: 700, textTransform: 'uppercase', color: T.primary, letterSpacing: '0.07em', marginBottom: '4px', fontFamily: 'Inter, sans-serif' }}>
                        Selected link
                      </div>
                      <a href={selectedLinkUrl} target="_blank" rel="noreferrer" style={{
                        fontSize: '12px', color: T.primary, fontFamily: 'Inter, sans-serif',
                        wordBreak: 'break-all', textDecoration: 'none', fontWeight: 500,
                      }}>
                        {selectedLinkUrl}
                      </a>
                      <div style={{ fontSize: '20px', fontWeight: 900, color: T.primary, fontFamily: 'Manrope, sans-serif', marginTop: '6px' }}>
                        {(linkObj?.clicks ?? 0).toLocaleString()} <span style={{ fontSize: '12px', fontWeight: 600 }}>total clicks</span>
                      </div>
                    </div>
                    <div style={{ fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', color: T.onSurfaceVariant, marginBottom: '8px', fontFamily: 'Inter, sans-serif' }}>
                      Recipients who clicked ({matched.length})
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', maxHeight: '220px', overflowY: 'auto' }}>
                      {matched.length === 0 ? (
                        <p style={{ fontSize: '12px', color: T.onSurfaceVariant, margin: 0, fontFamily: 'Inter, sans-serif' }}>No recipients have clicked yet.</p>
                      ) : matched.map((r, i) => (
                        <div key={i} style={{
                          display: 'flex', alignItems: 'center', gap: '10px',
                          padding: '7px 10px', borderRadius: '7px',
                          backgroundColor: T.surfaceContainerLow,
                        }}>
                          <span className="material-symbols-outlined" style={{ fontSize: '14px', color: '#16a34a', fontVariationSettings: "'FILL' 1" }}>ads_click</span>
                          <span style={{ fontSize: '12px', color: T.onSurface, fontFamily: 'Inter, sans-serif', flex: 1 }}>{r.email}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })()
            ) : (
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '0' }}>
                {(showAllLinks ? stats.links : stats.links.slice(0, 6))
                  .slice()
                  .sort((a, b) => (b.clicks ?? 0) - (a.clicks ?? 0))
                  .map((link, i) => {
                    const ctr = stats.sent > 0 ? ((link.clicks / stats.sent) * 100).toFixed(1) : '0.0';
                    const barPct = maxLinkClicks > 0 ? (link.clicks / maxLinkClicks) * 100 : 0;
                    const domain = (() => { try { return new URL(link.url).hostname.replace('www.', ''); } catch { return link.url; } })();
                    return (
                      <div
                        key={i}
                        onClick={() => setSelectedLinkUrl(link.url)}
                        style={{
                          padding: '10px 8px', borderRadius: '8px', cursor: 'pointer',
                          borderBottom: i < (showAllLinks ? stats.links.length : Math.min(6, stats.links.length)) - 1
                            ? `1px solid ${T.surfaceContainer}` : 'none',
                          transition: 'background 0.12s',
                        }}
                        onMouseEnter={e => (e.currentTarget as HTMLDivElement).style.background = T.surfaceContainerLow}
                        onMouseLeave={e => (e.currentTarget as HTMLDivElement).style.background = 'transparent'}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '6px' }}>
                          <div style={{
                            width: '20px', height: '20px', borderRadius: '5px', flexShrink: 0,
                            backgroundColor: i === 0 ? 'rgba(0,54,26,0.12)' : T.surfaceContainerLow,
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            fontSize: '10px', fontWeight: 700, color: i === 0 ? T.primary : T.onSurfaceVariant,
                            fontFamily: 'Manrope, sans-serif',
                          }}>
                            {i + 1}
                          </div>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{
                              fontSize: '12px', fontWeight: 600, color: T.onSurface,
                              fontFamily: 'Inter, sans-serif',
                              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                            }} title={link.url}>
                              {domain}
                            </div>
                            <div style={{
                              fontSize: '10px', color: T.onSurfaceVariant, fontFamily: 'Inter, sans-serif',
                              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                            }} title={link.url}>
                              {link.url.replace(/^https?:\/\//, '').slice(0, 45)}{link.url.length > 48 ? '…' : ''}
                            </div>
                          </div>
                          <div style={{ textAlign: 'right', flexShrink: 0 }}>
                            <div style={{ fontSize: '15px', fontWeight: 900, color: T.primary, fontFamily: 'Manrope, sans-serif', lineHeight: 1 }}>
                              {(link.clicks ?? 0).toLocaleString()}
                            </div>
                            <div style={{ fontSize: '10px', color: T.onSurfaceVariant, fontFamily: 'Inter, sans-serif' }}>
                              {ctr}% CTR
                            </div>
                          </div>
                        </div>
                        <div style={{ height: '3px', backgroundColor: T.surfaceContainerLow, borderRadius: '2px' }}>
                          <div style={{
                            height: '100%', width: `${barPct}%`,
                            background: i === 0 ? T.gradientCta : `rgba(0,54,26,${0.3 + (1 - i / stats.links.length) * 0.5})`,
                            borderRadius: '2px', transition: 'width 0.5s ease',
                          }} />
                        </div>
                      </div>
                    );
                  })}
                {stats.links.length > 6 && (
                  <button
                    onClick={() => setShowAllLinks(v => !v)}
                    style={{
                      marginTop: '10px', border: 'none', borderRadius: '8px',
                      backgroundColor: T.surfaceContainerLow, color: T.primary,
                      fontSize: '12px', fontWeight: 700, padding: '9px 16px',
                      cursor: 'pointer', fontFamily: 'Inter, sans-serif', transition: 'background 0.15s',
                    }}
                  >
                    {showAllLinks ? 'Show less' : `View all ${stats.links.length} links`}
                  </button>
                )}
              </div>
            )}
          </div>
        </div>

        {/* ═══ Integrity Report (real-time) ══════════════════════════════ */}
        {(() => {
          const healthColor = intBounceRate > 5 ? '#dc2626' : intBounceRate > 2 ? '#b45309' : '#16a34a';
          const healthBg = intBounceRate > 5 ? 'rgba(220,38,38,0.1)' : intBounceRate > 2 ? 'rgba(217,119,6,0.12)' : 'rgba(22,163,74,0.1)';
          const updatedLabel = statsAgeSec === null ? 'syncing…' : statsAgeSec < 2 ? 'just now' : statsAgeSec < 60 ? `${statsAgeSec}s ago` : `${Math.floor(statsAgeSec / 60)}m ago`;
          const tiles = [
            { key: 'delivered', label: 'Delivered', value: intDelivered, color: '#13677b', bg: 'rgba(19,103,123,0.08)', icon: 'mark_email_read' },
            { key: 'queued', label: 'Queued', value: intQueued, color: '#6b7280', bg: 'rgba(107,114,128,0.08)', icon: 'schedule_send' },
            { key: 'bounced', label: 'Bounced', value: intBounced, color: '#dc2626', bg: 'rgba(220,38,38,0.07)', icon: 'error' },
            { key: 'failed', label: 'Failed', value: intFailed, color: '#b45309', bg: 'rgba(217,119,6,0.1)', icon: 'warning' },
          ];
          return (
        <div style={{
          backgroundColor: T.surfaceContainerLowest,
          borderRadius: '12px',
          padding: '24px',
          boxShadow: T.shadow,
          marginBottom: '20px',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '18px', flexWrap: 'wrap' }}>
            <h2 style={{ fontSize: '15px', fontWeight: 700, color: T.onSurface, margin: 0, fontFamily: 'Manrope, sans-serif' }}>
              Integrity Report
            </h2>
            {/* live heartbeat pill */}
            <span style={{
              display: 'inline-flex', alignItems: 'center', gap: '5px',
              fontSize: '10px', fontWeight: 800, letterSpacing: '0.08em',
              color: '#16a34a', backgroundColor: 'rgba(22,163,74,0.1)',
              borderRadius: '6px', padding: '3px 8px', fontFamily: 'Inter, sans-serif',
            }}>
              <span style={{ width: '7px', height: '7px', borderRadius: '50%', backgroundColor: '#16a34a', animation: 'liveDot 1.4s ease-in-out infinite' }} />
              LIVE
            </span>
            {intIssues > 0 && (
              <span style={{
                fontSize: '11px', fontWeight: 700, color: '#fff',
                backgroundColor: '#dc2626', borderRadius: '6px',
                padding: '2px 8px', fontFamily: 'Inter, sans-serif',
              }}>
                {intIssues} issue{intIssues !== 1 ? 's' : ''}
              </span>
            )}
            <span style={{ marginLeft: 'auto', fontSize: '11px', color: T.onSurfaceVariant, fontFamily: 'Inter, sans-serif' }}>
              {statsLoading ? 'refreshing…' : `updated ${updatedLabel}`}
            </span>
          </div>

          {/* ── live deliverability gauge ── */}
          <div style={{ backgroundColor: healthBg, borderRadius: '10px', padding: '16px', marginBottom: '12px' }}>
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: '8px' }}>
              <span style={{ fontSize: '13px', fontWeight: 700, color: T.onSurface, fontFamily: 'Inter, sans-serif' }}>
                Deliverability
              </span>
              <span style={{ fontSize: '22px', fontWeight: 900, color: healthColor, fontFamily: 'Manrope, sans-serif', fontVariantNumeric: 'tabular-nums' }}>
                {`${intDeliveryPct.toFixed(1)}%`}
              </span>
            </div>
            <div style={{ height: '8px', borderRadius: '999px', backgroundColor: 'rgba(0,0,0,0.06)', overflow: 'hidden' }}>
              <div style={{
                height: '100%', borderRadius: '999px',
                width: `${Math.min(Math.max(intDeliveryPct, 0), 100)}%`,
                backgroundColor: healthColor,
                transition: 'width 0.6s ease, background-color 0.4s ease',
              }} />
            </div>
            <div style={{ marginTop: '8px', fontSize: '12px', color: T.onSurfaceVariant, fontFamily: 'Inter, sans-serif', lineHeight: 1.5 }}>
              Bounce rate {`${intBounceRate.toFixed(1)}%`}
              {intBounceRate > 5 ? ' — above safe threshold, review your list.' : ' — within safe parameters.'}
            </div>
          </div>

          {/* ── live count tiles ── */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '10px', marginBottom: '12px' }}>
            {tiles.map(t => (
              <div key={t.key} style={{ backgroundColor: t.bg, borderRadius: '10px', padding: '12px 14px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' }}>
                  <span className="material-symbols-outlined" style={{ fontSize: '15px', color: t.color, fontVariationSettings: "'FILL' 1" }}>{t.icon}</span>
                  <span style={{ fontSize: '11px', fontWeight: 600, color: T.onSurfaceVariant, fontFamily: 'Inter, sans-serif' }}>{t.label}</span>
                </div>
                <div style={{ fontSize: '20px', fontWeight: 800, color: t.color, fontFamily: 'Manrope, sans-serif', fontVariantNumeric: 'tabular-nums' }}>
                  {t.value.toLocaleString()}
                </div>
              </div>
            ))}
          </div>

          {/* ── bounced/failed detail ── */}
          <div style={{
            display: 'flex', alignItems: 'flex-start', gap: '12px',
            backgroundColor: intIssues > 0 ? 'rgba(220,38,38,0.05)' : 'rgba(22,163,74,0.05)',
            borderRadius: '10px', padding: '14px',
          }}>
            <div style={{
              width: '32px', height: '32px', borderRadius: '8px',
              backgroundColor: intIssues > 0 ? 'rgba(220,38,38,0.1)' : 'rgba(22,163,74,0.12)',
              display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
            }}>
              <span className="material-symbols-outlined" style={{ fontSize: '16px', color: intIssues > 0 ? '#dc2626' : '#16a34a', fontVariationSettings: "'FILL' 1" }}>
                {intIssues > 0 ? 'error' : 'verified'}
              </span>
            </div>
            <div>
              <div style={{ fontSize: '13px', fontWeight: 700, color: T.onSurface, marginBottom: '2px', fontFamily: 'Inter, sans-serif' }}>
                Bounced / Failed
              </div>
              <div style={{ fontSize: '12px', color: T.onSurfaceVariant, fontFamily: 'Inter, sans-serif', lineHeight: 1.5 }}>
                {bouncedRecipients.length > 0
                  ? `${bouncedRecipients.slice(0, 2).map(r => r.email).join(', ')}${bouncedRecipients.length > 2 ? ` +${bouncedRecipients.length - 2} more` : ''} — auto-suppressed on hard failure.`
                  : intIssues > 0
                    ? `${intIssues} address${intIssues !== 1 ? 'es' : ''} bounced or failed — auto-suppressed.`
                    : 'No bounced or failed addresses detected.'}
              </div>
            </div>
          </div>
        </div>
          );
        })()}

        {/* ═══ Performance Analysis ══════════════════════════════ */}
        {stats && (stats.whatWentWell.length > 0 || stats.whatNeedsWork.length > 0 || stats.goalAchieved !== undefined) && (
          <div style={{
            backgroundColor: T.surfaceContainerLowest,
            borderRadius: '12px', padding: '24px 28px',
            boxShadow: T.shadow, marginBottom: '20px',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '20px', flexWrap: 'wrap' }}>
              <h2 style={{ fontSize: '15px', fontWeight: 700, color: T.onSurface, margin: 0, fontFamily: 'Manrope, sans-serif' }}>
                Campaign Performance
              </h2>
              {stats.performance && (
                <span style={{
                  fontSize: '11px', fontWeight: 700,
                  backgroundColor: stats.performance === 'good' ? 'rgba(0,54,26,0.1)' : stats.performance === 'average' ? 'rgba(255,220,196,0.5)' : 'rgba(220,38,38,0.1)',
                  color: stats.performance === 'good' ? T.primary : stats.performance === 'average' ? '#92400e' : '#dc2626',
                  borderRadius: '6px', padding: '3px 10px', letterSpacing: '0.06em',
                  fontFamily: 'Inter, sans-serif', textTransform: 'uppercase',
                }}>{stats.performance}</span>
              )}
              {stats.goalLabel && (
                <span style={{ fontSize: '11px', color: T.onSurfaceVariant, fontWeight: 600, fontFamily: 'Inter, sans-serif' }}>
                  Goal: {stats.goalLabel}
                </span>
              )}
            </div>

            {stats.goalAchieved !== undefined && stats.benchmarks && (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '12px', marginBottom: '20px' }}>
                <div style={{
                  textAlign: 'center', padding: '16px 12px', borderRadius: '10px',
                  backgroundColor: stats.goalAchieved >= 75 ? 'rgba(0,54,26,0.05)' : stats.goalAchieved >= 50 ? 'rgba(255,220,196,0.3)' : 'rgba(220,38,38,0.05)',
                }}>
                  <div style={{ fontSize: '28px', fontWeight: 900, color: stats.goalAchieved >= 75 ? T.primary : stats.goalAchieved >= 50 ? '#92400e' : '#dc2626', fontFamily: 'Manrope, sans-serif' }}>
                    {stats.goalAchieved}%
                  </div>
                  <div style={{ fontSize: '11px', color: T.onSurfaceVariant, fontWeight: 600, marginTop: '2px', fontFamily: 'Inter, sans-serif' }}>Goal Achieved</div>
                </div>
                <div style={{ textAlign: 'center', padding: '16px 12px', borderRadius: '10px', backgroundColor: T.surfaceContainerLow }}>
                  <div style={{ fontSize: '11px', color: T.onSurfaceVariant, fontWeight: 600, marginBottom: '4px', fontFamily: 'Inter, sans-serif' }}>Open Target</div>
                  <div style={{ fontSize: '22px', fontWeight: 800, color: T.primary, fontFamily: 'Manrope, sans-serif' }}>{stats.benchmarks.openTarget}%</div>
                  <div style={{ fontSize: '11px', marginTop: '2px', color: stats.openRate >= stats.benchmarks.openTarget ? '#16a34a' : '#dc2626', fontWeight: 600, fontFamily: 'Inter, sans-serif' }}>
                    {stats.openRate >= stats.benchmarks.openTarget ? `Achieved (${stats.openRate}%)` : `Actual: ${stats.openRate}%`}
                  </div>
                </div>
                <div style={{ textAlign: 'center', padding: '16px 12px', borderRadius: '10px', backgroundColor: T.surfaceContainerLow }}>
                  <div style={{ fontSize: '11px', color: T.onSurfaceVariant, fontWeight: 600, marginBottom: '4px', fontFamily: 'Inter, sans-serif' }}>Click Target</div>
                  <div style={{ fontSize: '22px', fontWeight: 800, color: T.primary, fontFamily: 'Manrope, sans-serif' }}>{stats.benchmarks.clickTarget}%</div>
                  <div style={{ fontSize: '11px', marginTop: '2px', color: stats.clickRate >= stats.benchmarks.clickTarget ? '#16a34a' : '#dc2626', fontWeight: 600, fontFamily: 'Inter, sans-serif' }}>
                    {stats.clickRate >= stats.benchmarks.clickTarget ? `Achieved (${stats.clickRate}%)` : `Actual: ${stats.clickRate}%`}
                  </div>
                </div>
              </div>
            )}

            {stats.whatWentWell.length > 0 && (
              <div style={{ marginBottom: '12px' }}>
                <div style={{ fontSize: '11px', fontWeight: 700, color: '#16a34a', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: '8px', display: 'flex', alignItems: 'center', gap: '5px', fontFamily: 'Inter, sans-serif' }}>
                  <span className="material-symbols-outlined" style={{ fontSize: '14px' }}>thumb_up</span> What went well
                </div>
                <div style={{ display: 'grid', gap: '6px' }}>
                  {stats.whatWentWell.map((item, i) => (
                    <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: '8px', padding: '10px 14px', backgroundColor: 'rgba(0,54,26,0.04)', borderRadius: '8px' }}>
                      <span className="material-symbols-outlined" style={{ fontSize: '14px', color: '#16a34a', flexShrink: 0, marginTop: '1px', fontVariationSettings: "'FILL' 1" }}>check_circle</span>
                      <span style={{ fontSize: '13px', color: T.onSurface, lineHeight: 1.55, fontFamily: 'Inter, sans-serif' }}>{item}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {stats.whatNeedsWork.length > 0 && (
              <div>
                <div style={{ fontSize: '11px', fontWeight: 700, color: '#dc2626', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: '8px', display: 'flex', alignItems: 'center', gap: '5px', fontFamily: 'Inter, sans-serif' }}>
                  <span className="material-symbols-outlined" style={{ fontSize: '14px' }}>build</span> What needs work
                </div>
                <div style={{ display: 'grid', gap: '6px' }}>
                  {stats.whatNeedsWork.map((item, i) => (
                    <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: '8px', padding: '10px 14px', backgroundColor: 'rgba(220,38,38,0.04)', borderRadius: '8px' }}>
                      <span className="material-symbols-outlined" style={{ fontSize: '14px', color: '#dc2626', flexShrink: 0, marginTop: '1px', fontVariationSettings: "'FILL' 1" }}>warning</span>
                      <span style={{ fontSize: '13px', color: T.onSurface, lineHeight: 1.55, fontFamily: 'Inter, sans-serif' }}>{item}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* ═══ Recipients Table ══════════════════════════════ */}
        <div style={{
          backgroundColor: T.surfaceContainerLowest,
          borderRadius: '12px', padding: '24px 28px',
          boxShadow: T.shadow,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '12px', marginBottom: '18px' }}>
            <h2 style={{ fontSize: '15px', fontWeight: 700, color: T.onSurface, margin: 0, fontFamily: 'Manrope, sans-serif' }}>
              Recipients
              {stats && (
                <span style={{ fontSize: '12px', color: T.onSurfaceVariant, fontWeight: 400, marginLeft: '8px', fontFamily: 'Inter, sans-serif' }}>
                  ({stats.totalRecipients.toLocaleString()} total{searchQuery ? `, ${filteredRecipients.length} shown` : ''})
                </span>
              )}
            </h2>
            <div style={{ position: 'relative' }}>
              <span className="material-symbols-outlined" style={{
                position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)',
                fontSize: '15px', color: T.onSurfaceVariant, pointerEvents: 'none',
              }}>search</span>
              <input
                value={searchQuery}
                onChange={e => { setSearchQuery(e.target.value); setPage(1); }}
                placeholder="Search emails…"
                style={{
                  paddingLeft: '32px', paddingRight: '12px', paddingTop: '8px', paddingBottom: '8px',
                  border: 'none', borderRadius: '8px',
                  backgroundColor: T.surfaceContainerLow,
                  fontSize: '13px', color: T.onSurface, outline: 'none',
                  fontFamily: 'Inter, sans-serif', width: '200px',
                }}
              />
            </div>
          </div>

          {!stats || stats.recipients.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '48px', backgroundColor: T.surfaceContainerLow, borderRadius: '10px' }}>
              <span className="material-symbols-outlined" style={{ fontSize: '40px', color: T.surfaceContainer, display: 'block', marginBottom: '8px' }}>
                group
              </span>
              <p style={{ fontSize: '13px', color: T.onSurfaceVariant, margin: 0, fontFamily: 'Inter, sans-serif' }}>No recipients data yet</p>
            </div>
          ) : (
            <>
              {statsLoading && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' }}>
                  <div style={{ width: '14px', height: '14px', border: `2px solid ${T.primary}`, borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />
                  <span style={{ fontSize: '12px', color: T.onSurfaceVariant, fontFamily: 'Inter, sans-serif' }}>Refreshing…</span>
                </div>
              )}
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: '560px' }}>
                  <thead>
                    <tr>
                      {['Email', 'Status', 'Opened', 'Clicked', 'Sent At'].map(col => (
                        <th key={col} style={{
                          textAlign: col === 'Email' ? 'left' : 'center',
                          padding: '8px 12px 12px',
                          fontSize: '11px', fontWeight: 700, color: T.onSurfaceVariant,
                          textTransform: 'uppercase', letterSpacing: '0.08em',
                          whiteSpace: 'nowrap', fontFamily: 'Inter, sans-serif',
                          borderBottom: `2px solid ${T.surfaceContainerLow}`,
                        }}>
                          {col}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {pagedRecipients.map((recipient, i) => {
                      const sc = RECIPIENT_STATUS_CFG[recipient.status];
                      return (
                        <tr key={i}
                          style={{ transition: 'background 0.1s' }}
                          onMouseEnter={e => (e.currentTarget.style.backgroundColor = T.surfaceContainerLow)}
                          onMouseLeave={e => (e.currentTarget.style.backgroundColor = 'transparent')}
                        >
                          <td style={{ padding: '11px 12px', fontSize: '13px', color: T.onSurface, fontFamily: 'monospace', borderBottom: `1px solid ${T.ghost}` }}>
                            {recipient.email}
                            {(recipient.status === 'failed' || recipient.status === 'bounced') && recipient.error && (
                              <div style={{ marginTop: '3px', fontSize: '11px', color: recipient.status === 'failed' ? '#b45309' : '#dc2626', fontFamily: 'Inter, sans-serif', wordBreak: 'break-word' }}>
                                {recipient.error}
                              </div>
                            )}
                          </td>
                          <td style={{ padding: '11px 12px', textAlign: 'center', borderBottom: `1px solid ${T.ghost}` }}>
                            <span style={{
                              fontSize: '11px', fontWeight: 700,
                              backgroundColor: sc.bg, color: sc.color,
                              borderRadius: '6px', padding: '3px 9px',
                              letterSpacing: '0.04em', fontFamily: 'Inter, sans-serif',
                            }}>
                              {sc.label}
                            </span>
                          </td>
                          <td style={{ padding: '11px 12px', textAlign: 'center', borderBottom: `1px solid ${T.ghost}` }}>
                            {recipient.opened ? (
                              <span className="material-symbols-outlined" style={{ fontSize: '18px', color: '#16a34a', fontVariationSettings: "'FILL' 1" }}>check_circle</span>
                            ) : (
                              <span style={{ fontSize: '13px', color: T.surfaceContainer }}>—</span>
                            )}
                          </td>
                          <td style={{ padding: '11px 12px', textAlign: 'center', borderBottom: `1px solid ${T.ghost}` }}>
                            {recipient.clicks > 0 ? (
                              <span className="material-symbols-outlined" style={{ fontSize: '18px', color: T.primary, fontVariationSettings: "'FILL' 1" }}>ads_click</span>
                            ) : (
                              <span style={{ fontSize: '13px', color: T.surfaceContainer }}>—</span>
                            )}
                          </td>
                          <td style={{ padding: '11px 12px', textAlign: 'center', fontSize: '12px', color: T.onSurfaceVariant, borderBottom: `1px solid ${T.ghost}`, fontFamily: 'Inter, sans-serif' }}>
                            {recipient.bouncedAt ? '—' : '✓'}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {totalPages > 1 && (
                <div style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  marginTop: '16px', paddingTop: '16px', borderTop: `1px solid ${T.surfaceContainerLow}`,
                  flexWrap: 'wrap', gap: '10px',
                }}>
                  <span style={{ fontSize: '12px', color: T.onSurfaceVariant, fontFamily: 'Inter, sans-serif' }}>
                    Showing {((page - 1) * PAGE_SIZE) + 1}–{Math.min(page * PAGE_SIZE, filteredRecipients.length)} of {filteredRecipients.length}
                  </span>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <button
                      onClick={() => setPage(p => Math.max(1, p - 1))}
                      disabled={page === 1}
                      style={{
                        padding: '7px 14px', border: 'none', borderRadius: '8px',
                        backgroundColor: T.surfaceContainerLow,
                        fontSize: '12px', fontWeight: 600,
                        color: page === 1 ? T.surfaceContainer : T.onSurface,
                        cursor: page === 1 ? 'not-allowed' : 'pointer',
                        fontFamily: 'Inter, sans-serif',
                        display: 'flex', alignItems: 'center', gap: '4px',
                      }}
                    >
                      <span className="material-symbols-outlined" style={{ fontSize: '14px' }}>chevron_left</span>
                      Previous
                    </button>
                    <span style={{
                      padding: '7px 14px', borderRadius: '8px',
                      background: T.gradientCta,
                      fontSize: '12px', fontWeight: 700, color: '#fff',
                      fontFamily: 'Inter, sans-serif',
                    }}>
                      {page} / {totalPages}
                    </span>
                    <button
                      onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                      disabled={page === totalPages}
                      style={{
                        padding: '7px 14px', border: 'none', borderRadius: '8px',
                        backgroundColor: T.surfaceContainerLow,
                        fontSize: '12px', fontWeight: 600,
                        color: page === totalPages ? T.surfaceContainer : T.onSurface,
                        cursor: page === totalPages ? 'not-allowed' : 'pointer',
                        fontFamily: 'Inter, sans-serif',
                        display: 'flex', alignItems: 'center', gap: '4px',
                      }}
                    >
                      Next
                      <span className="material-symbols-outlined" style={{ fontSize: '14px' }}>chevron_right</span>
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {showCancelConfirm && (
        <ConfirmDialog
          message={`Cancel the campaign "${campaign.name}"? Pending recipients won't be sent.`}
          confirmLabel="Cancel Campaign"
          onConfirm={handleCancel}
          onCancel={() => setShowCancelConfirm(false)}
        />
      )}

      {toast && <Toast msg={toast.msg} type={toast.type} onClose={() => setToast(null)} />}
    </div>
  );
}
