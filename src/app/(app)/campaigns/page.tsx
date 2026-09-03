'use client';
import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';

import { api, ApiError } from '@/lib/api';

// ── Types (match backend GET /campaigns) ───────────────────────────────────────
interface CampaignSender {
  id: string;
  address: string | null;
  provider: string;
  label: string | null;
}

interface Campaign {
  id: string;
  name: string;
  subject: string;
  status: 'draft' | 'scheduled' | 'sending' | 'paused' | 'completed' | 'cancelled' | 'failed';
  total_recipients: number;
  sent_count: number;
  failed_count: number;
  skipped_count: number;
  opened_count: number;
  clicked_count: number;
  senders?: CampaignSender[];
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  user_id?: string | null;
  created_by_name?: string | null;
}

// Provider → brand colour for the mailbox header chip
const PROVIDER_COLOR: Record<string, string> = {
  gmail: '#ea4335',
  smtp: '#0a66c2',
  resend: '#6b3600',
  sendgrid: '#1a73e8',
};

// ── Constants ──────────────────────────────────────────────────────────────────
const TABS = ['all', 'completed'] as const;
type Tab = (typeof TABS)[number];

// Alpine Editorial status badge tokens
const STATUS_BADGE: Record<string, { label: string; bg: string; color: string }> = {
  draft:     { label: 'Draft',     bg: '#e1e3e4', color: '#414942' },
  scheduled: { label: 'Scheduled', bg: '#a1e7ff', color: '#004e5f' },
  sending:   { label: 'Sending',   bg: '#ffdcc4', color: '#6b3600' },
  completed: { label: 'Completed', bg: '#b8f0c5', color: '#1d5031' },
  paused:    { label: 'Paused',    bg: '#e1e3e4', color: '#414942' },
  cancelled: { label: 'Cancelled', bg: '#e1e3e4', color: '#414942' },
  failed:    { label: 'Failed',    bg: '#ffd5d5', color: '#b91c1c' },
};

// Alpine Editorial design tokens
const T = {
  primary:          '#00361a',
  primaryContainer: '#1a4d2e',
  surface:          '#f5f1e8',
  surfaceLow:       '#f3f4f5',
  surfaceContainer: '#edeeef',
  surfaceLowest:    '#ffffff',
  onSurface:        '#191c1d',
  onSurfaceVar:     '#414942',
  secondary:        '#13677b',
  saffron:          '#ffdcc4',
  onTertiary:       '#f09f5e',
  gradientCTA:      'linear-gradient(135deg, #00361a, #1a4d2e)',
  shadow:           '0 8px 40px rgba(25,28,29,0.04)',
  shadowMd:         '0 4px 24px rgba(25,28,29,0.07)',
  shadowLg:         '0 12px 48px rgba(25,28,29,0.10)',
  rLg:              8,
  rXl:              12,
  rFull:            9999,
};

function fmtRate(numerator: number, denominator: number): string {
  if (!denominator) return '0';
  return ((numerator / denominator) * 100).toFixed(1);
}

function fmtRateDisplay(numerator: number, denominator: number): string {
  const r = fmtRate(numerator, denominator);
  return r === '0' ? '—' : r + '%';
}

function getInitial(name: string): string {
  return (name || '?').charAt(0).toUpperCase();
}

function avatarColor(name: string): string {
  const pool = [
    '#1a4d2e', '#004e5f', '#6b3600', '#1d5031', '#414942', '#13677b',
  ];
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % pool.length;
  return pool[Math.abs(h)];
}

// ── Skeleton Row ──────────────────────────────────────────────────────────────
function SkeletonRow() {
  return (
    <tr>
      {[16, 120, 80, 60, 90].map((w, i) => (
        <td key={i} style={{ padding: '14px 16px' }}>
          <div style={{
            height: 12, width: w, borderRadius: 6,
            background: 'linear-gradient(90deg, #edeeef 25%, #f8f9fa 50%, #edeeef 75%)',
            backgroundSize: '400% 100%',
            animation: 'shimmer 1.4s infinite',
          }} />
        </td>
      ))}
    </tr>
  );
}

// ── KPI Card ──────────────────────────────────────────────────────────────────
interface KpiCardProps {
  label: string;
  value: string;
  trend: string;
  trendUp: boolean;
  trendNeutral?: boolean;
}
function KpiCard({ label, value, trend, trendUp, trendNeutral }: KpiCardProps) {
  const trendColor = trendNeutral ? T.onSurfaceVar : trendUp ? '#1d5031' : '#b91c1c';
  const trendBg   = trendNeutral ? T.surfaceContainer : trendUp ? '#b8f0c5' : '#ffd5d5';
  return (
    <div style={{
      background: T.surfaceLowest,
      borderRadius: T.rXl,
      padding: '16px 18px',
      boxShadow: T.shadow,
      minWidth: 0,
    }}>
      <p style={{
        margin: '0 0 6px',
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
        color: T.onSurfaceVar,
        fontFamily: 'Inter, system-ui, sans-serif',
      }}>
        {label}
      </p>
      <p style={{
        margin: '0 0 10px',
        fontSize: 'clamp(22px, 5vw, 28px)',
        fontWeight: 700,
        color: T.onSurface,
        fontFamily: 'Manrope, Inter, system-ui, sans-serif',
        letterSpacing: '-0.5px',
        lineHeight: 1.1,
        overflowWrap: 'anywhere',
        wordBreak: 'break-word',
      }}>
        {value}
      </p>
      <span style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        background: trendBg,
        color: trendColor,
        borderRadius: T.rFull,
        padding: '3px 9px',
        fontSize: 11,
        fontWeight: 600,
        fontFamily: 'Inter, system-ui, sans-serif',
      }}>
        {!trendNeutral && (
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
            {trendUp
              ? <path d="M5 8V2M5 2L2 5M5 2L8 5" stroke={trendColor} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              : <path d="M5 2v6M5 8L2 5M5 8L8 5" stroke={trendColor} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            }
          </svg>
        )}
        {trend}
      </span>
    </div>
  );
}

// ── Main Page ──────────────────────────────────────────────────────────────────
export default function EmailCampaignsPage() {
  const [tab, setTab] = useState<Tab>('all');
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [dupLoading, setDupLoading] = useState<string | null>(null);
  // Bulk select-and-delete. Reuses the existing single DELETE /campaigns/:id
  // endpoint per selected campaign (small concurrency batches) rather than
  // adding a new backend bulk-delete route -- same guarantees per campaign
  // (a "sending" one is cancelled first, recipients cascade), nothing new
  // to trust on the server side.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkDeleteConfirm, setBulkDeleteConfirm] = useState(false);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const toggleSelect = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  // In-app toast for delete errors — was a native alert() popup, which is
  // jarring and blocks the tab. Auto-dismisses; doesn't touch loading/skeleton
  // state at all.
  const [toast, setToast] = useState<string | null>(null);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(t);
  }, [toast]);
  // Which sender groups are expanded. Starts empty (everything collapsed) —
  // with dozens of senders and 80+ campaigns, showing every group fully
  // expanded on load made it impossible to find one specific campaign
  // without scrolling past everything else first.
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const toggleGroup = (key: string) => {
    setExpandedGroups(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  // ── API logic ───────────────────────────────────────────────────────────────
  // `background: true` (the periodic 10s refresh) never touches the loading
  // skeleton or clears campaigns on failure — it used to call setLoading(true)
  // unconditionally, which flipped the whole table back to skeleton
  // placeholders and back every 10 seconds, forever, even mid-scroll or
  // mid-selection. The skeleton is now only ever shown for the real first load.
  const fetchCampaigns = useCallback(async (opts?: { background?: boolean }) => {
    if (!opts?.background) setLoading(true);
    try {
      const data = await api<Campaign[]>('/campaigns');
      setCampaigns(Array.isArray(data) ? data : []);
    } catch {
      if (!opts?.background) setCampaigns([]);
    } finally {
      if (!opts?.background) setLoading(false);
    }
  }, []);

  useEffect(() => { fetchCampaigns(); }, [fetchCampaigns]);

  // refresh periodically so live stats settle without a manual reload
  useEffect(() => {
    const interval = setInterval(() => { fetchCampaigns({ background: true }); }, 10000);
    return () => clearInterval(interval);
  }, [fetchCampaigns]);

  async function handleDuplicate(id: string) {
    setDupLoading(id);
    try {
      await api(`/campaigns/${id}/duplicate`, { method: 'POST' });
      await fetchCampaigns();
    } catch {
      // ignore
    } finally {
      setDupLoading(null);
    }
  }

  async function handleDelete(id: string) {
    try {
      await api(`/campaigns/${id}`, { method: 'DELETE' });
      setCampaigns(prev => prev.filter(c => c.id !== id));
    } catch (e) {
      // Surface the real reason — silently refreshing made it impossible to
      // tell that the delete had 405'd on the missing backend endpoint.
      const msg = e instanceof ApiError ? (e.message || `Delete failed (${e.status})`) : 'Delete failed';
      setToast(msg);
      await fetchCampaigns();
    } finally {
      setDeleteId(null);
    }
  }

  async function handleBulkDelete() {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    setBulkDeleting(true);
    const failed: string[] = [];
    const CONCURRENCY = 4;
    for (let i = 0; i < ids.length; i += CONCURRENCY) {
      const batch = ids.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(
        batch.map(id => api(`/campaigns/${id}`, { method: 'DELETE' }))
      );
      results.forEach((r, idx) => { if (r.status === 'rejected') failed.push(batch[idx]); });
    }
    setCampaigns(prev => prev.filter(c => !ids.includes(c.id) || failed.includes(c.id)));
    setSelectedIds(new Set(failed));
    setBulkDeleteConfirm(false);
    setBulkDeleting(false);
    if (failed.length) {
      setToast(`${failed.length} of ${ids.length} campaign${ids.length === 1 ? '' : 's'} couldn't be deleted. They're still selected — try again.`);
    }
  }

  // ── Visible slice for the chosen tab ────────────────────────────────────────
  const visible = tab === 'completed'
    ? campaigns.filter(c => c.status === 'completed')
    : campaigns;

  // "Select all" covers every campaign in the current tab's filter, not just
  // the ones currently visible in an expanded group — matches how the list
  // is understood (a collapsed group's campaigns are still "in the list").
  const allVisibleSelected = visible.length > 0 && visible.every(c => selectedIds.has(c.id));
  const toggleSelectAll = () => {
    setSelectedIds(allVisibleSelected ? new Set() : new Set(visible.map(c => c.id)));
  };

  // ── Group by SENDER DOMAIN (not individual mailbox) — sales@hudace.com,
  //     partner@hudace.com, info@hudace.com all collapse into one
  //     "hudace.com" section instead of three separate ones, same idea as
  //     the Send From picker in Campaign Builder sorting by domain. A
  //     campaign with senders on the same domain is deduped to one row in
  //     that domain's section; senders on different domains still put the
  //     same campaign in each domain's section (mirrors the old per-sender
  //     behavior, just one level coarser). Campaigns with no resolved
  //     sender fall into "Unassigned". ──────────────────────────────────
  interface CampaignGroup {
    key: string;
    domain: string;
    addresses: string[];
    provider: string;
    campaigns: Campaign[];
  }
  const groupMap = new Map<string, CampaignGroup>();
  for (const c of visible) {
    const senders = c.senders && c.senders.length > 0 ? c.senders : [null];
    const domainsSeen = new Set<string>();
    for (const s of senders) {
      const addr = s?.address || s?.label || '';
      const domain = addr.includes('@') ? addr.split('@')[1]?.toLowerCase() || '' : '';
      const key = domain || '__unassigned__';
      if (domainsSeen.has(key)) continue; // same campaign, another mailbox on the same domain
      domainsSeen.add(key);
      let g = groupMap.get(key);
      if (!g) {
        g = {
          key,
          domain: domain || 'No mailbox assigned',
          addresses: [],
          provider: s?.provider || 'smtp',
          campaigns: [],
        };
        groupMap.set(key, g);
      }
      if (addr && !g.addresses.includes(addr)) g.addresses.push(addr);
      g.campaigns.push(c);
    }
  }
  // Sort: real domains first (alphabetical), unassigned last
  const groups = Array.from(groupMap.values()).sort((a, b) => {
    if (a.key === '__unassigned__') return 1;
    if (b.key === '__unassigned__') return -1;
    return a.domain.localeCompare(b.domain);
  });

  // ── Aggregate KPIs ──────────────────────────────────────────────────────────
  const completedCampaigns = campaigns.filter(c => c.status === 'completed');

  const totalReach = campaigns.reduce((s, c) => s + (c.total_recipients || 0), 0);
  const totalSent  = completedCampaigns.reduce((s, c) => s + (c.sent_count || 0), 0);
  const totalOpens = completedCampaigns.reduce((s, c) => s + (c.opened_count || 0), 0);
  const totalClicks = completedCampaigns.reduce((s, c) => s + (c.clicked_count || 0), 0);
  const totalFailed = completedCampaigns.reduce((s, c) => s + (c.failed_count || 0), 0);

  const avgOpenRate  = totalSent ? (totalOpens / totalSent) * 100 : 0;
  const avgClickRate = totalSent ? (totalClicks / totalSent) * 100 : 0;
  const avgBounceRate = totalSent ? (totalFailed / totalSent) * 100 : 0;

  const neutralTrend = (trend: string) => ({ trend, trendUp: true, trendNeutral: true });

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Manrope:wght@600;700;800&family=Inter:wght@400;500;600&display=swap');
        @keyframes shimmer { 0%{background-position:200% 0} 100%{background-position:-200% 0} }
        @keyframes fadeSlideIn {
          from { opacity: 0; transform: translateY(-6px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        .ec-action-btn { opacity: 0.7; transition: opacity 0.15s, background 0.15s; }
        .ec-action-btn:hover { opacity: 1; }
        .ec-tab-btn { transition: all 0.15s; }
        .ec-tab-btn:hover { background: #edeeef !important; }
        .ec-row:hover { background: #fafbfb !important; }
        .ec-create-btn:hover { opacity: 0.9; }

        /* ── Mobile: swap the desktop table for a stacked card list ──────
           A wide 5-column table forces horizontal scrolling on a phone,
           which is a poor way to browse a campaign list. Below 680px we
           hide the table and show ec-mobile-cards instead — both render
           (cheap for a <=200-row list), CSS just picks one. */
        .ec-table-wrap { display: block; }
        .ec-mobile-cards { display: none; }
        .ec-mcard-action:active { opacity: 0.6; }
        @media (max-width: 680px) {
          .ec-page-pad { padding: 16px 12px !important; }
          .ec-page-title { font-size: 21px !important; }
          .ec-kpi-grid { grid-template-columns: repeat(2, 1fr) !important; gap: 10px !important; }
          .ec-table-wrap { display: none !important; }
          .ec-mobile-cards { display: block !important; }
          .ec-toolbar { width: 100%; justify-content: space-between !important; }
          .ec-create-btn-label { display: none; }
        }
      `}</style>

      <div style={{
        minHeight: '100vh',
        background: T.surface,
        fontFamily: 'Inter, system-ui, sans-serif',
        padding: '28px 24px',
      }} className="ec-page-pad">
        <div style={{ maxWidth: 1280, margin: '0 auto' }}>

          {/* ── Page Header ─────────────────────────────────────────────── */}
          <div style={{
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: 12,
            marginBottom: 28,
          }}>
            <div>
              <h1 className="ec-page-title" style={{
                margin: 0,
                fontSize: 26,
                fontWeight: 700,
                color: T.onSurface,
                fontFamily: 'Manrope, Inter, system-ui, sans-serif',
                letterSpacing: '-0.4px',
              }}>
                Email Campaigns
              </h1>
              <p style={{ margin: '4px 0 0', fontSize: 14, color: T.onSurfaceVar }}>
                Manage, schedule and track your campaigns
              </p>
            </div>
          </div>

          {/* ── KPI Cards Row ────────────────────────────────────────────── */}
          <div className="ec-kpi-grid" style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
            gap: 16,
            marginBottom: 28,
          }}>
            <KpiCard
              label="Total Reach"
              value={loading ? '—' : totalReach > 0 ? totalReach.toLocaleString() : '0'}
              {...neutralTrend(`${campaigns.length} campaign${campaigns.length !== 1 ? 's' : ''}`)}
            />
            <KpiCard
              label="Avg Open Rate"
              value={loading ? '—' : completedCampaigns.length > 0 ? avgOpenRate.toFixed(1) + '%' : '—'}
              {...neutralTrend('Across completed sends')}
            />
            <KpiCard
              label="Avg Click Rate"
              value={loading ? '—' : completedCampaigns.length > 0 ? avgClickRate.toFixed(1) + '%' : '—'}
              {...neutralTrend('Across completed sends')}
            />
            <KpiCard
              label="Bounce Rate"
              value={loading ? '—' : completedCampaigns.length > 0 ? avgBounceRate.toFixed(2) + '%' : '—'}
              {...neutralTrend(completedCampaigns.length ? 'Failed / sent' : 'No data yet')}
            />
          </div>

          {/* ── Main table area ──────────────────────────────────────────── */}
          <div style={{
            background: T.surfaceLowest,
            borderRadius: T.rXl,
            boxShadow: T.shadow,
            overflow: 'hidden',
          }}>
            {/* Table header bar */}
            <div style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '18px 24px 14px',
              flexWrap: 'wrap',
              gap: 12,
              borderBottom: `1px solid rgba(65,73,66,0.08)`,
            }}>
              <h2 style={{
                margin: 0,
                fontSize: 16,
                fontWeight: 700,
                color: T.onSurface,
                fontFamily: 'Manrope, Inter, system-ui, sans-serif',
              }}>
                Campaign Performance
              </h2>

              <div className="ec-toolbar" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                {/* Bulk-select action bar — only shown once something's selected */}
                {selectedIds.size > 0 && (
                  <div style={{
                    display: 'flex', alignItems: 'center', gap: 10,
                    background: '#ffd5d5', borderRadius: T.rFull, padding: '4px 6px 4px 14px',
                  }}>
                    <span style={{ fontSize: 12, fontWeight: 600, color: '#7a1414', whiteSpace: 'nowrap' }}>
                      {selectedIds.size} selected
                    </span>
                    <button
                      onClick={() => setBulkDeleteConfirm(true)}
                      disabled={bulkDeleting}
                      style={{
                        display: 'inline-flex', alignItems: 'center', gap: 5,
                        background: 'linear-gradient(135deg, #b91c1c, #dc2626)',
                        color: '#ffffff', border: 'none', borderRadius: T.rFull,
                        padding: '6px 14px', fontSize: 12, fontWeight: 600,
                        cursor: bulkDeleting ? 'wait' : 'pointer', whiteSpace: 'nowrap',
                        opacity: bulkDeleting ? 0.6 : 1,
                      }}
                    >
                      <svg width="12" height="12" viewBox="0 0 14 14" fill="none">
                        <path d="M2 3.5h10M5.5 3.5V2.5a.5.5 0 0 1 .5-.5h2a.5.5 0 0 1 .5.5v1M11 3.5l-.7 7.2a1 1 0 0 1-1 .8H4.7a1 1 0 0 1-1-.8L3 3.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                      Delete selected
                    </button>
                    <button
                      onClick={() => setSelectedIds(new Set())}
                      style={{
                        background: 'transparent', border: 'none', color: '#7a1414',
                        fontSize: 12, fontWeight: 600, cursor: 'pointer', padding: '6px 8px',
                      }}
                    >
                      Clear
                    </button>
                  </div>
                )}

                {/* Filter tabs: All Status / Completed */}
                <div style={{
                  display: 'flex',
                  gap: 2,
                  background: T.surfaceLow,
                  borderRadius: T.rFull,
                  padding: '3px',
                }}>
                  {TABS.map(t => (
                    <button
                      key={t}
                      className="ec-tab-btn"
                      onClick={() => setTab(t)}
                      style={{
                        padding: '5px 14px',
                        borderRadius: T.rFull,
                        border: 'none',
                        fontFamily: 'Inter, system-ui, sans-serif',
                        fontSize: 12,
                        fontWeight: tab === t ? 600 : 400,
                        cursor: 'pointer',
                        background: tab === t ? T.surfaceLowest : 'transparent',
                        color: tab === t ? T.onSurface : T.onSurfaceVar,
                        boxShadow: tab === t ? T.shadowMd : 'none',
                        transition: 'all 0.15s',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {t === 'all' ? 'All Status' : 'Completed'}
                    </button>
                  ))}
                </div>

                {/* Expand/collapse all sender groups at once */}
                {groups.length > 1 && (
                  <button
                    onClick={() => setExpandedGroups(
                      expandedGroups.size === groups.length
                        ? new Set()
                        : new Set(groups.map(g => g.key))
                    )}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 4,
                      background: 'transparent',
                      border: `1px solid rgba(65,73,66,0.15)`,
                      borderRadius: T.rFull,
                      padding: '5px 12px',
                      fontSize: 12,
                      fontWeight: 600,
                      color: T.onSurfaceVar,
                      cursor: 'pointer',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {expandedGroups.size === groups.length ? 'Collapse all' : 'Expand all'}
                  </button>
                )}

                {/* Create Campaign CTA */}
                <Link
                  href="/campaigns/new"
                  className="ec-create-btn"
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    background: T.gradientCTA,
                    color: '#ffffff',
                    fontFamily: 'Inter, system-ui, sans-serif',
                    fontWeight: 600,
                    fontSize: 13,
                    padding: '8px 16px',
                    borderRadius: T.rFull,
                    textDecoration: 'none',
                    whiteSpace: 'nowrap',
                    boxShadow: '0 4px 16px rgba(0,54,26,0.25)',
                    transition: 'opacity 0.15s',
                  }}
                >
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                    <path d="M7 1v12M1 7h12" stroke="#ffffff" strokeWidth="2" strokeLinecap="round"/>
                  </svg>
                  <span className="ec-create-btn-label">Create Campaign</span>
                </Link>
              </div>
            </div>

            {/* Table (desktop) */}
            <div className="ec-table-wrap" style={{ overflowX: 'auto' }}>
              <table style={{
                width: '100%',
                borderCollapse: 'collapse',
                fontSize: 13,
              }}>
                <thead>
                  <tr style={{ background: T.surfaceLow }}>
                    <th style={{ padding: '10px 12px', width: 1 }}>
                      <input
                        type="checkbox"
                        checked={allVisibleSelected}
                        onChange={toggleSelectAll}
                        style={{ width: 15, height: 15, cursor: 'pointer' }}
                        title={allVisibleSelected ? 'Deselect all' : 'Select all'}
                      />
                    </th>
                    {['Campaign Name', 'Status', 'Recipients', 'Open Rate', 'Actions'].map(h => (
                      <th key={h} style={{
                        padding: '10px 16px',
                        textAlign: 'left',
                        fontSize: 11,
                        fontWeight: 600,
                        letterSpacing: '0.06em',
                        textTransform: 'uppercase',
                        color: T.onSurfaceVar,
                        whiteSpace: 'nowrap',
                      }}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {loading ? (
                    [1, 2, 3, 4].map(i => <SkeletonRow key={i} />)
                  ) : visible.length === 0 ? (
                    <tr>
                      <td colSpan={6} style={{ padding: '56px 24px', textAlign: 'center' }}>
                        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" style={{ display: 'block', margin: '0 auto 14px' }}>
                          <rect x="2" y="4" width="20" height="16" rx="3" stroke="#b8bfb9" strokeWidth="1.5"/>
                          <path d="M2 8l10 7 10-7" stroke="#b8bfb9" strokeWidth="1.5" strokeLinecap="round"/>
                        </svg>
                        <p style={{ fontSize: 15, fontWeight: 600, color: T.onSurfaceVar, margin: '0 0 5px', fontFamily: 'Manrope, Inter, sans-serif' }}>
                          No campaigns yet
                        </p>
                        <p style={{ fontSize: 13, color: T.onSurfaceVar, margin: 0, opacity: 0.7 }}>
                          Create your first campaign to get started.
                        </p>
                      </td>
                    </tr>
                  ) : (
                    groups.flatMap((g) => {
                      const isOpen = expandedGroups.has(g.key);
                      return [
                      // ── Mailbox header row — one per connected account, click to expand/collapse ──
                      <tr key={`hdr-${g.key}`} onClick={() => toggleGroup(g.key)} style={{ cursor: 'pointer' }}>
                        <td colSpan={6} style={{
                          padding: '14px 16px 8px',
                          background: T.surfaceLow,
                          borderTop: `1px solid rgba(65,73,66,0.08)`,
                        }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                            <svg
                              width="12" height="12" viewBox="0 0 12 12" fill="none"
                              style={{ flexShrink: 0, transform: isOpen ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s' }}
                            >
                              <path d="M4 2.5l4 3.5-4 3.5" stroke={T.onSurfaceVar} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
                            </svg>
                            <span style={{
                              display: 'inline-grid',
                              placeItems: 'center',
                              width: 22,
                              height: 22,
                              borderRadius: T.rFull,
                              background: PROVIDER_COLOR[g.provider] || T.secondary,
                              color: '#ffffff',
                              fontSize: 11,
                              fontWeight: 700,
                            }}>
                              {(g.domain || '?').charAt(0).toUpperCase()}
                            </span>
                            <span style={{
                              fontSize: 13,
                              fontWeight: 700,
                              color: T.onSurface,
                              fontFamily: 'Manrope, Inter, sans-serif',
                            }}>
                              {g.domain}
                            </span>
                            <span style={{
                              fontSize: 11,
                              fontWeight: 600,
                              color: T.onSurfaceVar,
                              textTransform: 'uppercase',
                              letterSpacing: '0.04em',
                              padding: '2px 8px',
                              background: T.surfaceContainer,
                              borderRadius: T.rFull,
                            }}>
                              {g.addresses.length > 1 ? `${g.addresses.length} mailboxes` : g.provider}
                            </span>
                            <span style={{ marginLeft: 'auto', fontSize: 12, color: T.onSurfaceVar }}>
                              {g.campaigns.length} campaign{g.campaigns.length === 1 ? '' : 's'}
                            </span>
                          </div>
                        </td>
                      </tr>,
                      ...(isOpen ? g.campaigns : []).map((c, idx) => {
                      const badge = STATUS_BADGE[c.status] || STATUS_BADGE.draft;
                      const openRateNum = c.sent_count ? (c.opened_count / c.sent_count) * 100 : 0;
                      const openRateStr = fmtRateDisplay(c.opened_count, c.sent_count);
                      const rowAvatarColor = avatarColor(c.id || c.name || String(idx));

                      return (
                        <tr
                          key={`${g.key}-${c.id}`}
                          className="ec-row"
                          style={{
                            borderBottom: `1px solid rgba(65,73,66,0.06)`,
                            transition: 'background 0.12s',
                            background: T.surfaceLowest,
                          }}
                        >
                          {/* Select checkbox */}
                          <td style={{ padding: '14px 12px' }}>
                            <input
                              type="checkbox"
                              checked={selectedIds.has(c.id)}
                              onChange={() => toggleSelect(c.id)}
                              onClick={(e) => e.stopPropagation()}
                              style={{ width: 15, height: 15, cursor: 'pointer' }}
                            />
                          </td>

                          {/* Campaign Name + Subject */}
                          <td style={{ padding: '14px 16px', minWidth: 220 }}>
                            <Link href={`/campaigns/${c.id}`} style={{ textDecoration: 'none' }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                                {/* Circular avatar */}
                                <div style={{
                                  width: 36,
                                  height: 36,
                                  borderRadius: T.rFull,
                                  background: rowAvatarColor,
                                  display: 'flex',
                                  alignItems: 'center',
                                  justifyContent: 'center',
                                  flexShrink: 0,
                                  color: '#ffffff',
                                  fontSize: 14,
                                  fontWeight: 700,
                                  fontFamily: 'Manrope, Inter, sans-serif',
                                }}>
                                  {getInitial(c.name)}
                                </div>
                                <div style={{ minWidth: 0 }}>
                                  <div style={{
                                    fontSize: 14,
                                    fontWeight: 600,
                                    color: T.onSurface,
                                    fontFamily: 'Inter, system-ui, sans-serif',
                                    whiteSpace: 'nowrap',
                                    overflow: 'hidden',
                                    textOverflow: 'ellipsis',
                                    maxWidth: 200,
                                  }}>
                                    {c.name}
                                  </div>
                                  <div style={{
                                    fontSize: 12,
                                    color: T.onSurfaceVar,
                                    opacity: 0.7,
                                    marginTop: 2,
                                    whiteSpace: 'nowrap',
                                    overflow: 'hidden',
                                    textOverflow: 'ellipsis',
                                    maxWidth: 200,
                                  }}>
                                    {c.subject}
                                  </div>
                                </div>
                              </div>
                            </Link>
                          </td>

                          {/* Status chip */}
                          <td style={{ padding: '14px 16px', whiteSpace: 'nowrap' }}>
                            <span style={{
                              display: 'inline-block',
                              background: badge.bg,
                              color: badge.color,
                              borderRadius: T.rFull,
                              padding: '4px 11px',
                              fontSize: 11,
                              fontWeight: 600,
                              letterSpacing: '0.03em',
                              textTransform: 'uppercase',
                            }}>
                              {badge.label}
                            </span>
                          </td>

                          {/* Recipients */}
                          <td style={{ padding: '14px 16px', whiteSpace: 'nowrap', fontSize: 13, color: T.onSurface, fontWeight: 600 }}>
                            {c.total_recipients.toLocaleString()}
                          </td>

                          {/* Open Rate + thin progress bar */}
                          <td style={{ padding: '14px 16px', minWidth: 110 }}>
                            <div style={{
                              fontSize: 14,
                              fontWeight: 600,
                              color: T.onSurface,
                              marginBottom: 5,
                            }}>
                              {openRateStr}
                            </div>
                            <div style={{
                              height: 3,
                              background: T.surfaceContainer,
                              borderRadius: T.rFull,
                              overflow: 'hidden',
                              width: 80,
                            }}>
                              <div style={{
                                height: '100%',
                                width: `${Math.min(openRateNum, 100)}%`,
                                background: T.gradientCTA,
                                borderRadius: T.rFull,
                                transition: 'width 0.6s ease',
                              }} />
                            </div>
                          </td>

                          {/* Actions */}
                          <td style={{ padding: '14px 16px', whiteSpace: 'nowrap' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                              {/* Edit */}
                              <Link
                                href={`/campaigns/new?id=${c.id}`}
                                className="ec-action-btn"
                                title="Edit"
                                style={{
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  justifyContent: 'center',
                                  width: 30,
                                  height: 30,
                                  borderRadius: T.rLg,
                                  background: T.surfaceLow,
                                  textDecoration: 'none',
                                  color: T.onSurfaceVar,
                                }}
                              >
                                <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                                  <path d="M9.5 2.5l2 2L4 12H2v-2L9.5 2.5z" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
                                </svg>
                              </Link>

                              {/* View */}
                              <Link
                                href={`/campaigns/${c.id}`}
                                className="ec-action-btn"
                                title="View"
                                style={{
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  justifyContent: 'center',
                                  width: 30,
                                  height: 30,
                                  borderRadius: T.rLg,
                                  background: T.surfaceLow,
                                  textDecoration: 'none',
                                  color: T.onSurfaceVar,
                                }}
                              >
                                <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                                  <path d="M1 7s2.5-4.5 6-4.5S13 7 13 7s-2.5 4.5-6 4.5S1 7 1 7z" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
                                  <circle cx="7" cy="7" r="1.8" stroke="currentColor" strokeWidth="1.3"/>
                                </svg>
                              </Link>

                              {/* Duplicate */}
                              <button
                                className="ec-action-btn"
                                title="Duplicate"
                                onClick={() => handleDuplicate(c.id)}
                                disabled={dupLoading === c.id}
                                style={{
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  justifyContent: 'center',
                                  width: 30,
                                  height: 30,
                                  borderRadius: T.rLg,
                                  background: T.surfaceLow,
                                  border: 'none',
                                  cursor: dupLoading === c.id ? 'wait' : 'pointer',
                                  color: T.onSurfaceVar,
                                  opacity: dupLoading === c.id ? 0.45 : undefined,
                                }}
                              >
                                <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                                  <rect x="4" y="4" width="8" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.3"/>
                                  <path d="M2 10V2.5A1.5 1.5 0 0 1 3.5 1H9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
                                </svg>
                              </button>

                              {/* Delete */}
                              <button
                                className="ec-action-btn"
                                title="Delete"
                                onClick={() => setDeleteId(c.id)}
                                style={{
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  justifyContent: 'center',
                                  width: 30,
                                  height: 30,
                                  borderRadius: T.rLg,
                                  background: '#ffd5d5',
                                  border: 'none',
                                  cursor: 'pointer',
                                  color: '#b91c1c',
                                }}
                              >
                                <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                                  <path d="M2 3.5h10M5.5 3.5V2.5a.5.5 0 0 1 .5-.5h2a.5.5 0 0 1 .5.5v1M11 3.5l-.7 7.2a1 1 0 0 1-1 .8H4.7a1 1 0 0 1-1-.8L3 3.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
                                </svg>
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })];
                    })
                  )}
                </tbody>
              </table>
            </div>

            {/* Cards (mobile) — same data as the table above, laid out as
                stacked cards instead of columns so nothing needs horizontal
                scrolling to read on a phone. Toggled purely by CSS
                (.ec-mobile-cards), see the media query at the top. */}
            <div className="ec-mobile-cards">
              {loading ? (
                [1, 2, 3].map(i => (
                  <div key={i} style={{ padding: '14px 16px', borderTop: i > 1 ? `1px solid rgba(65,73,66,0.06)` : undefined }}>
                    <div style={{
                      height: 14, width: '60%', borderRadius: 6, marginBottom: 8,
                      background: 'linear-gradient(90deg, #edeeef 25%, #f8f9fa 50%, #edeeef 75%)',
                      backgroundSize: '400% 100%', animation: 'shimmer 1.4s infinite',
                    }} />
                    <div style={{
                      height: 11, width: '40%', borderRadius: 6,
                      background: 'linear-gradient(90deg, #edeeef 25%, #f8f9fa 50%, #edeeef 75%)',
                      backgroundSize: '400% 100%', animation: 'shimmer 1.4s infinite',
                    }} />
                  </div>
                ))
              ) : visible.length === 0 ? (
                <div style={{ padding: '48px 20px', textAlign: 'center' }}>
                  <svg width="40" height="40" viewBox="0 0 24 24" fill="none" style={{ display: 'block', margin: '0 auto 12px' }}>
                    <rect x="2" y="4" width="20" height="16" rx="3" stroke="#b8bfb9" strokeWidth="1.5"/>
                    <path d="M2 8l10 7 10-7" stroke="#b8bfb9" strokeWidth="1.5" strokeLinecap="round"/>
                  </svg>
                  <p style={{ fontSize: 14, fontWeight: 600, color: T.onSurfaceVar, margin: '0 0 4px', fontFamily: 'Manrope, Inter, sans-serif' }}>
                    No campaigns yet
                  </p>
                  <p style={{ fontSize: 12, color: T.onSurfaceVar, margin: 0, opacity: 0.7 }}>
                    Create your first campaign to get started.
                  </p>
                </div>
              ) : (
                groups.map((g) => {
                  const isOpen = expandedGroups.has(g.key);
                  return (
                  <div key={g.key}>
                    {/* Mailbox header — tap to expand/collapse */}
                    <div
                      onClick={() => toggleGroup(g.key)}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer',
                        padding: '12px 14px 8px', background: T.surfaceLow,
                        borderTop: `1px solid rgba(65,73,66,0.08)`,
                      }}>
                      <svg
                        width="11" height="11" viewBox="0 0 12 12" fill="none"
                        style={{ flexShrink: 0, transform: isOpen ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s' }}
                      >
                        <path d="M4 2.5l4 3.5-4 3.5" stroke={T.onSurfaceVar} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                      <span style={{
                        display: 'inline-grid', placeItems: 'center', width: 20, height: 20,
                        borderRadius: T.rFull, background: PROVIDER_COLOR[g.provider] || T.secondary,
                        color: '#ffffff', fontSize: 10, fontWeight: 700, flexShrink: 0,
                      }}>
                        {(g.domain || '?').charAt(0).toUpperCase()}
                      </span>
                      <span style={{
                        fontSize: 12.5, fontWeight: 700, color: T.onSurface,
                        fontFamily: 'Manrope, Inter, sans-serif', overflow: 'hidden',
                        textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0,
                      }}>
                        {g.domain}
                      </span>
                      <span style={{ marginLeft: 'auto', fontSize: 11, color: T.onSurfaceVar, flexShrink: 0 }}>
                        {g.campaigns.length}
                      </span>
                    </div>

                    {(isOpen ? g.campaigns : []).map((c, idx) => {
                      const badge = STATUS_BADGE[c.status] || STATUS_BADGE.draft;
                      const openRateNum = c.sent_count ? (c.opened_count / c.sent_count) * 100 : 0;
                      const openRateStr = fmtRateDisplay(c.opened_count, c.sent_count);
                      const rowAvatarColor = avatarColor(c.id || c.name || String(idx));
                      return (
                        <div
                          key={`${g.key}-${c.id}-m`}
                          style={{
                            padding: '12px 14px',
                            borderBottom: `1px solid rgba(65,73,66,0.06)`,
                            background: T.surfaceLowest,
                            display: 'flex',
                            alignItems: 'flex-start',
                            gap: 10,
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={selectedIds.has(c.id)}
                            onChange={() => toggleSelect(c.id)}
                            style={{ width: 17, height: 17, cursor: 'pointer', marginTop: 9, flexShrink: 0 }}
                          />
                          <div style={{ flex: 1, minWidth: 0 }}>
                          <Link href={`/campaigns/${c.id}`} style={{ textDecoration: 'none', display: 'block' }}>
                            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                              <div style={{
                                width: 34, height: 34, borderRadius: T.rFull, background: rowAvatarColor,
                                display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                                color: '#ffffff', fontSize: 13, fontWeight: 700, fontFamily: 'Manrope, Inter, sans-serif',
                              }}>
                                {getInitial(c.name)}
                              </div>
                              <div style={{ minWidth: 0, flex: 1 }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'space-between' }}>
                                  <div style={{
                                    fontSize: 14, fontWeight: 600, color: T.onSurface,
                                    fontFamily: 'Inter, system-ui, sans-serif', overflow: 'hidden',
                                    textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0,
                                  }}>
                                    {c.name}
                                  </div>
                                  <span style={{
                                    display: 'inline-block', flexShrink: 0, background: badge.bg, color: badge.color,
                                    borderRadius: T.rFull, padding: '3px 9px', fontSize: 10, fontWeight: 600,
                                    letterSpacing: '0.03em', textTransform: 'uppercase',
                                  }}>
                                    {badge.label}
                                  </span>
                                </div>
                                <div style={{
                                  fontSize: 12, color: T.onSurfaceVar, opacity: 0.7, marginTop: 2,
                                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                                }}>
                                  {c.subject}
                                </div>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8 }}>
                                  <span style={{ fontSize: 12, color: T.onSurfaceVar }}>
                                    <b style={{ color: T.onSurface }}>{c.total_recipients.toLocaleString()}</b> recipients
                                  </span>
                                  <span style={{ fontSize: 12, color: T.onSurfaceVar }}>
                                    Open <b style={{ color: T.onSurface }}>{openRateStr}</b>
                                  </span>
                                </div>
                                {openRateNum > 0 && (
                                  <div style={{ height: 3, background: T.surfaceContainer, borderRadius: T.rFull, overflow: 'hidden', width: '100%', marginTop: 6 }}>
                                    <div style={{ height: '100%', width: `${Math.min(openRateNum, 100)}%`, background: T.gradientCTA, borderRadius: T.rFull }} />
                                  </div>
                                )}
                              </div>
                            </div>
                          </Link>

                          {/* Actions — bigger tap targets than the desktop row */}
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, paddingLeft: 44 }}>
                            <Link
                              href={`/campaigns/new?id=${c.id}`}
                              className="ec-mcard-action"
                              title="Edit"
                              style={{
                                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                                width: 36, height: 36, borderRadius: T.rLg, background: T.surfaceLow,
                                textDecoration: 'none', color: T.onSurfaceVar,
                              }}
                            >
                              <svg width="15" height="15" viewBox="0 0 14 14" fill="none">
                                <path d="M9.5 2.5l2 2L4 12H2v-2L9.5 2.5z" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
                              </svg>
                            </Link>
                            <button
                              className="ec-mcard-action"
                              title="Duplicate"
                              onClick={() => handleDuplicate(c.id)}
                              disabled={dupLoading === c.id}
                              style={{
                                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                                width: 36, height: 36, borderRadius: T.rLg, background: T.surfaceLow, border: 'none',
                                cursor: dupLoading === c.id ? 'wait' : 'pointer', color: T.onSurfaceVar,
                                opacity: dupLoading === c.id ? 0.45 : undefined,
                              }}
                            >
                              <svg width="15" height="15" viewBox="0 0 14 14" fill="none">
                                <rect x="4" y="4" width="8" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.3"/>
                                <path d="M2 10V2.5A1.5 1.5 0 0 1 3.5 1H9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
                              </svg>
                            </button>
                            <button
                              className="ec-mcard-action"
                              title="Delete"
                              onClick={() => setDeleteId(c.id)}
                              style={{
                                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                                width: 36, height: 36, borderRadius: T.rLg, background: '#ffd5d5', border: 'none',
                                cursor: 'pointer', color: '#b91c1c', marginLeft: 'auto',
                              }}
                            >
                              <svg width="15" height="15" viewBox="0 0 14 14" fill="none">
                                <path d="M2 3.5h10M5.5 3.5V2.5a.5.5 0 0 1 .5-.5h2a.5.5 0 0 1 .5.5v1M11 3.5l-.7 7.2a1 1 0 0 1-1 .8H4.7a1 1 0 0 1-1-.8L3 3.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
                              </svg>
                            </button>
                          </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
      </div>

      {/* ── Toast — in-app error notice, replaces the old alert() popup ──── */}
      {toast && (
        <div style={{
          position: 'fixed',
          bottom: 24,
          left: '50%',
          transform: 'translateX(-50%)',
          zIndex: 1100,
          maxWidth: 480,
          width: 'calc(100% - 32px)',
          background: '#2a1414',
          color: '#ffe0e0',
          borderRadius: T.rLg,
          padding: '12px 16px',
          fontSize: 13,
          lineHeight: 1.5,
          boxShadow: T.shadowLg,
          display: 'flex',
          alignItems: 'flex-start',
          gap: 10,
          animation: 'fadeSlideIn 0.2s ease',
        }}>
          <svg width="16" height="16" viewBox="0 0 22 22" fill="none" style={{ flexShrink: 0, marginTop: 2 }}>
            <path d="M3 5.5h16M8.5 5.5V4a.5.5 0 0 1 .5-.5h4a.5.5 0 0 1 .5.5v1.5M17 5.5l-1.1 11.3a1.5 1.5 0 0 1-1.5 1.2H7.6a1.5 1.5 0 0 1-1.5-1.2L5 5.5" stroke="#ff9999" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          <span style={{ flex: 1 }}>{toast}</span>
          <button
            onClick={() => setToast(null)}
            style={{ background: 'transparent', border: 'none', color: '#ff9999', cursor: 'pointer', fontSize: 16, lineHeight: 1, padding: 0 }}
            title="Dismiss"
          >
            ×
          </button>
        </div>
      )}

      {/* ── Delete Confirm Modal (Alpine Editorial styled) ──────────────── */}
      {deleteId && (
        <div style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(25,28,29,0.5)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 1000,
          padding: 16,
          backdropFilter: 'blur(4px)',
        }}>
          <div style={{
            background: T.surfaceLowest,
            borderRadius: T.rXl + 4,
            padding: 32,
            maxWidth: 400,
            width: '100%',
            boxShadow: T.shadowLg,
            animation: 'fadeSlideIn 0.2s ease',
          }}>
            {/* Icon */}
            <div style={{
              width: 48,
              height: 48,
              borderRadius: T.rXl,
              background: '#ffd5d5',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              marginBottom: 16,
            }}>
              <svg width="22" height="22" viewBox="0 0 22 22" fill="none">
                <path d="M3 5.5h16M8.5 5.5V4a.5.5 0 0 1 .5-.5h4a.5.5 0 0 1 .5.5v1.5M17 5.5l-1.1 11.3a1.5 1.5 0 0 1-1.5 1.2H7.6a1.5 1.5 0 0 1-1.5-1.2L5 5.5" stroke="#b91c1c" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </div>

            <h3 style={{
              margin: '0 0 8px',
              color: T.onSurface,
              fontSize: 18,
              fontWeight: 700,
              fontFamily: 'Manrope, Inter, system-ui, sans-serif',
            }}>
              Delete Campaign?
            </h3>
            <p style={{
              margin: '0 0 24px',
              color: T.onSurfaceVar,
              fontSize: 14,
              lineHeight: 1.55,
            }}>
              This action cannot be undone. The campaign and all its stats will be permanently deleted.
            </p>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button
                onClick={() => setDeleteId(null)}
                style={{
                  background: T.surfaceLow,
                  color: T.onSurface,
                  border: 'none',
                  borderRadius: T.rFull,
                  padding: '10px 20px',
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: 'pointer',
                  fontFamily: 'Inter, system-ui, sans-serif',
                  transition: 'background 0.15s',
                }}
              >
                Cancel
              </button>
              <button
                onClick={() => handleDelete(deleteId)}
                style={{
                  background: 'linear-gradient(135deg, #b91c1c, #dc2626)',
                  color: '#ffffff',
                  border: 'none',
                  borderRadius: T.rFull,
                  padding: '10px 20px',
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: 'pointer',
                  fontFamily: 'Inter, system-ui, sans-serif',
                  boxShadow: '0 4px 16px rgba(185,28,28,0.3)',
                }}
              >
                Delete Campaign
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Bulk Delete Confirm Modal ────────────────────────────────────── */}
      {bulkDeleteConfirm && (
        <div style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(25,28,29,0.5)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 1000,
          padding: 16,
          backdropFilter: 'blur(4px)',
        }}>
          <div style={{
            background: T.surfaceLowest,
            borderRadius: T.rXl + 4,
            padding: 32,
            maxWidth: 400,
            width: '100%',
            boxShadow: T.shadowLg,
            animation: 'fadeSlideIn 0.2s ease',
          }}>
            <div style={{
              width: 48,
              height: 48,
              borderRadius: T.rXl,
              background: '#ffd5d5',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              marginBottom: 16,
            }}>
              <svg width="22" height="22" viewBox="0 0 22 22" fill="none">
                <path d="M3 5.5h16M8.5 5.5V4a.5.5 0 0 1 .5-.5h4a.5.5 0 0 1 .5.5v1.5M17 5.5l-1.1 11.3a1.5 1.5 0 0 1-1.5 1.2H7.6a1.5 1.5 0 0 1-1.5-1.2L5 5.5" stroke="#b91c1c" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </div>

            <h3 style={{
              margin: '0 0 8px',
              color: T.onSurface,
              fontSize: 18,
              fontWeight: 700,
              fontFamily: 'Manrope, Inter, system-ui, sans-serif',
            }}>
              Delete {selectedIds.size} campaign{selectedIds.size === 1 ? '' : 's'}?
            </h3>
            <p style={{
              margin: '0 0 24px',
              color: T.onSurfaceVar,
              fontSize: 14,
              lineHeight: 1.55,
            }}>
              This action cannot be undone. All selected campaigns and their stats will be permanently deleted. Any still sending will be cancelled first.
            </p>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button
                onClick={() => setBulkDeleteConfirm(false)}
                disabled={bulkDeleting}
                style={{
                  background: T.surfaceLow,
                  color: T.onSurface,
                  border: 'none',
                  borderRadius: T.rFull,
                  padding: '10px 20px',
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: bulkDeleting ? 'wait' : 'pointer',
                  fontFamily: 'Inter, system-ui, sans-serif',
                  transition: 'background 0.15s',
                }}
              >
                Cancel
              </button>
              <button
                onClick={handleBulkDelete}
                disabled={bulkDeleting}
                style={{
                  background: 'linear-gradient(135deg, #b91c1c, #dc2626)',
                  color: '#ffffff',
                  border: 'none',
                  borderRadius: T.rFull,
                  padding: '10px 20px',
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: bulkDeleting ? 'wait' : 'pointer',
                  fontFamily: 'Inter, system-ui, sans-serif',
                  boxShadow: '0 4px 16px rgba(185,28,28,0.3)',
                  opacity: bulkDeleting ? 0.6 : 1,
                }}
              >
                {bulkDeleting ? 'Deleting…' : `Delete ${selectedIds.size} campaign${selectedIds.size === 1 ? '' : 's'}`}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
