"use client";
/**
 * Content Hub — a single business's asset library.
 *
 * Ported from the standalone content-hub module: store/preview/send HTML
 * emails, WhatsApp messages, captions, SMS and "other". Scoped to one
 * business (resolved from the [slug] route param). Send-test routes through
 * the existing Vercel SMTP bridge (/api/outreach/send), the same path
 * Outreach + Campaigns use.
 */
import { useState, useRef, type ComponentType } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft, FolderOpen, Plus, Search, X, Upload, Eye, Send, Download,
  Copy, Pencil, Trash2, CheckCircle2, MailCheck, MessageCircle, Camera,
  MessageSquare, FileText, Zap, Rocket, ChevronDown, ChevronUp,
  type LucideIcon,
} from "lucide-react";
import { api, ApiError, getToken, getWorkspaceId } from "@/lib/api";

const BRAND = "#00361a";
const BRAND_LIGHT = "#e6f0e8";

type AssetType = "html_email" | "whatsapp" | "caption" | "sms" | "other";

const TYPE_CFG: Record<AssetType, { label: string; Icon: LucideIcon; color: string; bg: string }> = {
  html_email: { label: "HTML Email", Icon: MailCheck,     color: "#1d4ed8", bg: "rgba(29,78,216,0.08)" },
  whatsapp:   { label: "WhatsApp",   Icon: MessageCircle,  color: "#16a34a", bg: "rgba(22,163,74,0.08)" },
  caption:    { label: "Caption",    Icon: Camera,         color: "#7c3aed", bg: "rgba(124,58,237,0.08)" },
  sms:        { label: "SMS",        Icon: MessageSquare,  color: "#ea580c", bg: "rgba(234,88,12,0.08)" },
  other:      { label: "Other",      Icon: FileText,       color: "#6b7280", bg: "rgba(107,114,128,0.08)" },
};

const PLATFORM_LABELS: Record<string, string> = {
  instagram: "Instagram", facebook: "Facebook", twitter: "Twitter / X",
  linkedin: "LinkedIn", youtube: "YouTube", threads: "Threads",
};

interface Asset {
  id: string; _id: string; business_id: string;
  title: string; type: AssetType; content: string;
  amp_content: string;
  subject: string; platform: string; tags: string[]; notes: string;
  image_url: string;
  createdAt: string | null; updatedAt: string | null;
}
interface Business { id: string; name: string; slug: string; brand_color: string; description: string; }
interface Stats { total: number; email: number; whatsapp: number; caption: number; sms: number; other: number; }

function fmtDate(d: string | null) {
  if (!d) return "";
  return new Date(d).toLocaleDateString("en-US", { day: "numeric", month: "short", year: "numeric" });
}

/* ═══════════════════════════════════════════════════════ */
export default function BusinessAssetsPage() {
  const params = useParams();
  const router = useRouter();
  const slug = String(params.slug);
  const qc = useQueryClient();

  // Launch a fresh draft Campaign pre-filled with this asset. The Campaign
  // Builder honours ?from_asset=<id> — it fetches the asset content + AMP
  // body and seeds the name/subject/body, while every field stays editable.
  const startCampaignFromAsset = (a: Asset) => {
    router.push(`/campaigns/new?from_asset=${encodeURIComponent(a.id)}`);
  };

  // Launch a bulk WhatsApp campaign pre-filled with this asset's message. The
  // WhatsApp page honours ?from_asset=<id> the same way the Campaign Builder
  // does — it fetches the asset content and seeds the composer's message,
  // every field stays editable, and the user attaches a product image + picks
  // recipients there.
  const sendOnWhatsApp = (a: Asset) => {
    router.push(`/whatsapp?from_asset=${encodeURIComponent(a.id)}`);
  };

  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");

  const [showCreate, setShowCreate] = useState(false);
  const [editAsset, setEditAsset] = useState<Asset | null>(null);
  const [previewAsset, setPreviewAsset] = useState<Asset | null>(null);
  const [sendTestAsset, setSendTestAsset] = useState<Asset | null>(null);

  // Resolve business by slug → gives id.
  const bizQ = useQuery({
    queryKey: ["content-business", slug],
    queryFn: () => api<Business & { stats: Stats }>(`/content-hub/businesses/${slug}`),
  });
  const business = bizQ.data;

  // debounce search
  const sTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onSearch = (v: string) => {
    setSearchInput(v);
    if (sTimer.current) clearTimeout(sTimer.current);
    sTimer.current = setTimeout(() => setSearch(v), 360);
  };

  const assetsQ = useQuery({
    queryKey: ["content-assets", business?.id, typeFilter, search],
    enabled: !!business?.id,
    queryFn: () => {
      const p = new URLSearchParams();
      if (typeFilter !== "all") p.set("type", typeFilter);
      if (search) p.set("search", search);
      return api<{ assets: Asset[]; stats: Stats }>(`/content-hub/businesses/${business!.id}/assets?${p}`);
    },
  });
  const assets = assetsQ.data?.assets ?? [];
  const stats = assetsQ.data?.stats ?? { total: 0, email: 0, whatsapp: 0, caption: 0, sms: 0, other: 0 };

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["content-assets", business?.id] });
    qc.invalidateQueries({ queryKey: ["content-businesses"] });
  };

  const handleDelete = async (id: string) => {
    await api(`/content-hub/assets/${id}`, { method: "DELETE" });
    refresh();
  };

  const TABS = [
    { key: "all",        label: "All",      count: stats.total },
    { key: "html_email", label: "Emails",   count: stats.email },
    { key: "whatsapp",   label: "WhatsApp", count: stats.whatsapp },
    { key: "caption",    label: "Captions", count: stats.caption },
    { key: "sms",        label: "SMS",      count: stats.sms },
    { key: "other",      label: "Other",    count: stats.other },
  ];

  const color = business?.brand_color || BRAND;

  return (
    <div style={{ padding: "24px 32px", maxWidth: 1240, margin: "0 auto" }}>
      {/* Breadcrumb + header */}
      <Link href="/content-hub" style={{ display: "inline-flex", alignItems: "center", gap: 6, color: "#6b7280", textDecoration: "none", fontSize: 13, fontWeight: 600, marginBottom: 14 }}>
        <ArrowLeft size={15} /> Content Hub
      </Link>

      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 22, flexWrap: "wrap", gap: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 13 }}>
          <span style={{ width: 44, height: 44, borderRadius: 12, background: `linear-gradient(135deg, ${color}, ${color}cc)`, display: "inline-flex", alignItems: "center", justifyContent: "center", boxShadow: `0 6px 16px ${color}40` }}>
            <FolderOpen size={21} color="#fff" strokeWidth={2.2} />
          </span>
          <div>
            <h1 style={{ fontFamily: "Manrope, Inter, sans-serif", fontWeight: 900, fontSize: 23, color: BRAND, margin: 0, letterSpacing: "-0.02em" }}>
              {business?.name || (bizQ.isLoading ? "Loading…" : "Business")}
            </h1>
            <div style={{ fontSize: 12.5, color: "#9ca3af", marginTop: 2 }}>
              {stats.total} {stats.total === 1 ? "asset" : "assets"} · store, preview, and send your content
            </div>
          </div>
        </div>
        <button onClick={() => setShowCreate(true)} style={{ display: "flex", alignItems: "center", gap: 8, padding: "11px 22px", borderRadius: 11, background: BRAND, color: "#fff", border: "none", fontFamily: "Manrope, Inter, sans-serif", fontWeight: 800, fontSize: 14, cursor: "pointer", boxShadow: "0 4px 14px rgba(0,54,26,0.22)" }}>
          <Plus size={17} /> Add content
        </button>
      </div>

      {/* search + tabs */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20, flexWrap: "wrap" }}>
        <div style={{ position: "relative", flex: "0 0 260px" }}>
          <Search size={16} style={{ position: "absolute", left: 11, top: "50%", transform: "translateY(-50%)", color: "#9ca3af" }} />
          <input value={searchInput} onChange={(e) => onSearch(e.target.value)} placeholder="Search by title, subject, notes…"
            style={{ width: "100%", padding: "9px 12px 9px 35px", border: "1.5px solid #e5e7eb", borderRadius: 9, fontSize: 13, fontFamily: "inherit", outline: "none", boxSizing: "border-box" }} />
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {TABS.map((tab) => (
            <button key={tab.key} onClick={() => setTypeFilter(tab.key)}
              style={{ display: "flex", alignItems: "center", gap: 5, padding: "7px 14px", borderRadius: 8, border: `1.5px solid ${typeFilter === tab.key ? BRAND : "#e5e7eb"}`, background: typeFilter === tab.key ? BRAND : "#fff", color: typeFilter === tab.key ? "#fff" : "#374151", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
              {tab.label}
              <span style={{ fontSize: 10, fontWeight: 800, padding: "1px 6px", borderRadius: 99, background: typeFilter === tab.key ? "rgba(255,255,255,0.2)" : "#f3f4f6", color: typeFilter === tab.key ? "#fff" : "#6b7280" }}>{tab.count}</span>
            </button>
          ))}
        </div>
      </div>

      {/* grid */}
      {assetsQ.isLoading || bizQ.isLoading ? (
        <div style={{ textAlign: "center", padding: 60, color: "#9ca3af", fontSize: 14 }}>Loading…</div>
      ) : assets.length === 0 ? (
        <div style={{ textAlign: "center", padding: "60px 20px", background: "#f9fafb", borderRadius: 16, border: "1.5px dashed #e5e7eb" }}>
          <FolderOpen size={40} color="#d1d5db" style={{ margin: "0 auto 12px", display: "block" }} />
          <div style={{ fontFamily: "Manrope, Inter, sans-serif", fontWeight: 700, fontSize: 16, color: "#374151", marginBottom: 6 }}>No content yet</div>
          <div style={{ fontSize: 13, color: "#9ca3af", marginBottom: 20 }}>Add your first HTML email, WhatsApp message, or caption.</div>
          <button onClick={() => setShowCreate(true)} style={{ display: "inline-flex", alignItems: "center", gap: 7, padding: "10px 22px", borderRadius: 9, background: BRAND, color: "#fff", border: "none", fontWeight: 700, fontSize: 14, cursor: "pointer" }}>
            <Plus size={16} /> Add content
          </button>
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(340px, 1fr))", gap: 16 }}>
          {assets.map((a) => (
            <AssetCard key={a.id} asset={a} onEdit={setEditAsset} onDelete={handleDelete} onPreview={setPreviewAsset} onSendTest={setSendTestAsset} onStartCampaign={startCampaignFromAsset} onSendWhatsApp={sendOnWhatsApp} />
          ))}
        </div>
      )}

      {/* modals */}
      {showCreate && business && (
        <AssetModal businessId={business.id} onClose={() => setShowCreate(false)} onSaved={() => { setShowCreate(false); refresh(); }} />
      )}
      {editAsset && business && (
        <AssetModal businessId={business.id} initial={editAsset} onClose={() => setEditAsset(null)} onSaved={() => { setEditAsset(null); refresh(); }} />
      )}
      {previewAsset && <PreviewModal asset={previewAsset} onClose={() => setPreviewAsset(null)} />}
      {sendTestAsset && <SendTestModal asset={sendTestAsset} onClose={() => setSendTestAsset(null)} />}
    </div>
  );
}

/* ─── Asset card ─────────────────────────────────────── */
function AssetCard({ asset, onEdit, onDelete, onPreview, onSendTest, onStartCampaign, onSendWhatsApp }: {
  asset: Asset;
  onEdit: (a: Asset) => void;
  onDelete: (id: string) => void;
  onPreview: (a: Asset) => void;
  onSendTest: (a: Asset) => void;
  onStartCampaign: (a: Asset) => void;
  onSendWhatsApp: (a: Asset) => void;
}) {
  const cfg = TYPE_CFG[asset.type] || TYPE_CFG.other;
  const Icon = cfg.Icon;
  const [copied, setCopied] = useState(false);
  const [delConfirm, setDelConfirm] = useState(false);

  const copy = async () => { await navigator.clipboard.writeText(asset.content); setCopied(true); setTimeout(() => setCopied(false), 2000); };
  const download = (ext: string, mime: string) => {
    const blob = new Blob([asset.content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `${asset.title.replace(/[^a-z0-9]/gi, "-").toLowerCase()}.${ext}`; a.click();
    URL.revokeObjectURL(url);
  };

  const preview160 = asset.content.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 160);

  return (
    <div style={{ background: "#fff", border: "1.5px solid #e5e7eb", borderRadius: 14, overflow: "hidden", display: "flex", flexDirection: "column", boxShadow: "0 1px 3px rgba(0,0,0,0.05)" }}
      onMouseEnter={(e) => (e.currentTarget.style.boxShadow = "0 4px 16px rgba(0,0,0,0.10)")}
      onMouseLeave={(e) => (e.currentTarget.style.boxShadow = "0 1px 3px rgba(0,0,0,0.05)")}
    >
      <div style={{ padding: "14px 18px", borderBottom: "1px solid #f3f4f6", display: "flex", alignItems: "flex-start", gap: 12 }}>
        <div style={{ width: 36, height: 36, borderRadius: 9, background: cfg.bg, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
          <Icon size={18} color={cfg.color} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontFamily: "Manrope, Inter, sans-serif", fontWeight: 800, fontSize: 14, color: "#111827", lineHeight: 1.3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{asset.title}</div>
          <div style={{ display: "flex", gap: 6, marginTop: 4, flexWrap: "wrap", alignItems: "center" }}>
            <span style={{ fontSize: 10, fontWeight: 700, color: cfg.color, background: cfg.bg, padding: "2px 7px", borderRadius: 99 }}>{cfg.label}</span>
            {asset.amp_content && (
              <span title="AMP-for-Email body attached — Gmail will render it" style={{ display: "inline-flex", alignItems: "center", gap: 3, fontSize: 10, fontWeight: 800, color: "#fff", background: "linear-gradient(135deg, #6366f1, #a855f7)", padding: "2px 7px", borderRadius: 99 }}>
                <Zap size={9} /> AMP
              </span>
            )}
            {asset.platform && <span style={{ fontSize: 10, fontWeight: 600, color: "#6b7280", background: "#f9fafb", padding: "2px 7px", borderRadius: 99, border: "1px solid #e5e7eb" }}>{PLATFORM_LABELS[asset.platform] || asset.platform}</span>}
            {asset.subject && <span style={{ fontSize: 10, color: "#6b7280", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 170 }}>Sub: {asset.subject}</span>}
          </div>
        </div>
        <div style={{ fontSize: 11, color: "#9ca3af", flexShrink: 0 }}>{fmtDate(asset.createdAt)}</div>
      </div>

      <div style={{ padding: "12px 18px", flex: 1 }}>
        {asset.image_url && (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img src={asset.image_url} alt={asset.title} style={{ width: "100%", maxHeight: 150, objectFit: "cover", borderRadius: 8, border: "1px solid #e5e7eb", marginBottom: 10 }} />
        )}
        <p style={{ fontSize: 12.5, color: "#6b7280", lineHeight: 1.6, margin: 0, overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical" as const }}>
          {preview160}{asset.content.length > 160 ? "…" : ""}
        </p>
        <div style={{ marginTop: 8, fontSize: 11, color: "#9ca3af" }}>
          {asset.type === "html_email" ? `${(asset.content.length / 1024).toFixed(1)} KB HTML` : `${asset.content.length} characters`}
        </div>
        {asset.tags?.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginTop: 10 }}>
            {asset.tags.map((t) => <span key={t} style={{ fontSize: 10, fontWeight: 600, color: BRAND, background: BRAND_LIGHT, padding: "2px 7px", borderRadius: 99 }}>#{t}</span>)}
          </div>
        )}
        {asset.notes && (
          <div style={{ marginTop: 10, padding: "7px 10px", borderRadius: 7, background: "#fef9c3", border: "1px solid #fde68a", fontSize: 11, color: "#78350f", lineHeight: 1.5 }}>{asset.notes}</div>
        )}
      </div>

      <div style={{ padding: "10px 14px", borderTop: "1px solid #f3f4f6", display: "flex", flexWrap: "wrap", gap: 6 }}>
        {asset.type === "html_email" && (
          <>
            <ActionBtn Icon={Rocket} label="Start Campaign" color={BRAND} onClick={() => onStartCampaign(asset)} prominent />
            <ActionBtn Icon={Eye} label="Preview" color="#1d4ed8" onClick={() => onPreview(asset)} />
            <ActionBtn Icon={Send} label="Send Test" color="#7c3aed" onClick={() => onSendTest(asset)} />
            <ActionBtn Icon={Download} label="Download" color={BRAND} onClick={() => download("html", "text/html")} />
            <ActionBtn Icon={Copy} label={copied ? "Copied!" : "Copy HTML"} color="#374151" onClick={copy} />
          </>
        )}
        {asset.type === "whatsapp" && (
          <ActionBtn Icon={Rocket} label="Send on WhatsApp" color="#16a34a" onClick={() => onSendWhatsApp(asset)} prominent />
        )}
        {(asset.type === "whatsapp" || asset.type === "sms" || asset.type === "caption" || asset.type === "other") && (
          <>
            <ActionBtn Icon={Copy} label={copied ? "Copied!" : "Copy"} color={cfg.color} onClick={copy} />
            <ActionBtn Icon={Download} label="Download .txt" color={BRAND} onClick={() => download("txt", "text/plain")} />
            {asset.image_url && (
              <a href={asset.image_url} download={asset.title.replace(/[^a-z0-9]/gi, "-").toLowerCase()}
                style={{ display: "flex", alignItems: "center", gap: 5, padding: "5px 10px", borderRadius: 7, border: "1.5px solid #16a34a20", background: "#16a34a0d", fontSize: 11, fontWeight: 700, color: "#16a34a", textDecoration: "none" }}>
                <Download size={13} /> Photo
              </a>
            )}
          </>
        )}
        <div style={{ marginLeft: "auto", display: "flex", gap: 5 }}>
          <button onClick={() => onEdit(asset)} style={{ display: "flex", alignItems: "center", gap: 4, padding: "5px 10px", borderRadius: 7, border: "1.5px solid #e5e7eb", background: "#fff", fontSize: 11, fontWeight: 700, color: "#374151", cursor: "pointer" }}>
            <Pencil size={13} /> Edit
          </button>
          {delConfirm ? (
            <button onClick={() => onDelete(asset.id)} style={{ padding: "5px 10px", borderRadius: 7, border: "1.5px solid #fca5a5", background: "#fee2e2", fontSize: 11, fontWeight: 700, color: "#dc2626", cursor: "pointer" }}>Confirm?</button>
          ) : (
            <button onClick={() => setDelConfirm(true)} style={{ display: "flex", alignItems: "center", padding: "5px 10px", borderRadius: 7, border: "1.5px solid #e5e7eb", background: "#fff", fontSize: 11, fontWeight: 700, color: "#9ca3af", cursor: "pointer" }}>
              <Trash2 size={13} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function ActionBtn({ Icon, label, color, onClick, prominent }: {
  Icon: ComponentType<{ size?: number; color?: string }>;
  label: string; color: string; onClick: () => void;
  prominent?: boolean;
}) {
  const styles: React.CSSProperties = prominent
    ? { display: "flex", alignItems: "center", gap: 5, padding: "6px 12px", borderRadius: 7, border: "none", background: color, fontSize: 11, fontWeight: 800, color: "#fff", cursor: "pointer", boxShadow: `0 2px 8px ${color}55` }
    : { display: "flex", alignItems: "center", gap: 5, padding: "5px 10px", borderRadius: 7, border: `1.5px solid ${color}20`, background: `${color}0d`, fontSize: 11, fontWeight: 700, color, cursor: "pointer" };
  return (
    <button onClick={onClick} style={styles}
      onMouseEnter={(e) => (e.currentTarget.style.opacity = "0.85")}
      onMouseLeave={(e) => (e.currentTarget.style.opacity = "1")}
    >
      <Icon size={13} color={prominent ? "#fff" : color} /> {label}
    </button>
  );
}

/* ─── Create / edit asset modal ──────────────────────── */
function AssetModal({ businessId, initial, onClose, onSaved }: {
  businessId: string; initial?: Asset; onClose: () => void; onSaved: () => void;
}) {
  const isEdit = !!initial;
  const [title, setTitle] = useState(initial?.title || "");
  const [type, setType] = useState<AssetType>(initial?.type || "html_email");
  const [content, setContent] = useState(initial?.content || "");
  const [ampContent, setAmpContent] = useState(initial?.amp_content || "");
  const [ampOpen, setAmpOpen] = useState(!!initial?.amp_content);
  const [subject, setSubject] = useState(initial?.subject || "");
  const [platform, setPlatform] = useState(initial?.platform || "");
  const [tags, setTags] = useState((initial?.tags || []).join(", "));
  const [notes, setNotes] = useState(initial?.notes || "");
  const [imageUrl, setImageUrl] = useState(initial?.image_url || "");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const ampFileRef = useRef<HTMLInputElement>(null);
  const imageRef = useRef<HTMLInputElement>(null);

  const handleImage = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (!file.type.startsWith("image/")) { setErr("Please choose an image file."); return; }
    if (file.size > 5 * 1024 * 1024) { setErr("Image too large (max 5MB)."); return; }
    const reader = new FileReader();
    reader.onload = (ev) => { setImageUrl((ev.target?.result as string) || ""); setErr(""); };
    reader.readAsDataURL(file); // stored as a data: URL on the asset
  };

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => { setContent((ev.target?.result as string) || ""); if (!title) setTitle(file.name.replace(/\.[^.]+$/, "")); };
    reader.readAsText(file);
  };

  const handleAmpFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => setAmpContent((ev.target?.result as string) || "");
    reader.readAsText(file);
  };

  const save = async () => {
    // Title always required; need a message OR an attached image.
    if (!title.trim() || (!content.trim() && !imageUrl)) { setErr("Add a title and a message (or an image)."); return; }
    setSaving(true); setErr("");
    try {
      // AMP is only meaningful on html_email assets; ignore the field for
      // other types and clear it server-side via empty string. The image is
      // only relevant for non-email assets (WhatsApp/SMS/caption/other).
      const payload = {
        title, type, content, subject, platform, tags, notes,
        amp_content: type === "html_email" ? ampContent : "",
        image_url: type === "html_email" ? "" : imageUrl,
      };
      if (isEdit) await api(`/content-hub/assets/${initial!.id}`, { method: "PATCH", body: payload });
      else await api(`/content-hub/businesses/${businessId}/assets`, { method: "POST", body: payload });
      onSaved();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const label: React.CSSProperties = { fontSize: 11, fontWeight: 700, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 6, display: "block" };
  const input: React.CSSProperties = { width: "100%", padding: "9px 12px", border: "1.5px solid #e5e7eb", borderRadius: 8, fontSize: 14, fontFamily: "inherit", outline: "none", boxSizing: "border-box" };

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 1000, background: "rgba(0,0,0,0.45)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "#fff", borderRadius: 18, width: "100%", maxWidth: 640, maxHeight: "92vh", overflowY: "auto", boxShadow: "0 24px 60px rgba(0,0,0,0.2)" }}>
        <div style={{ padding: "22px 28px", borderBottom: "1px solid #f3f4f6", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ fontFamily: "Manrope, sans-serif", fontWeight: 900, fontSize: 17, color: BRAND }}>{isEdit ? "Edit content" : "Add content"}</div>
          <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", padding: 4, color: "#9ca3af" }}><X size={20} /></button>
        </div>
        <div style={{ padding: "24px 28px", display: "flex", flexDirection: "column", gap: 18 }}>
          <div>
            <span style={label}>Content type</span>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {(Object.keys(TYPE_CFG) as AssetType[]).map((t) => {
                const c = TYPE_CFG[t]; const active = type === t; const TIcon = c.Icon;
                return (
                  <button key={t} type="button" onClick={() => setType(t)}
                    style={{ display: "flex", alignItems: "center", gap: 6, padding: "7px 14px", borderRadius: 8, border: `1.5px solid ${active ? c.color : "#e5e7eb"}`, background: active ? c.bg : "#fff", color: active ? c.color : "#374151", fontWeight: 700, fontSize: 12, cursor: "pointer" }}>
                    <TIcon size={14} /> {c.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <span style={label}>Title</span>
            <input style={input} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Welcome Email — Week 1" />
          </div>

          {type === "html_email" && (
            <div>
              <span style={label}>Email subject line</span>
              <input style={input} value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="e.g. Your plan is ready" />
            </div>
          )}

          {type === "caption" && (
            <div>
              <span style={label}>Platform</span>
              <select style={input} value={platform} onChange={(e) => setPlatform(e.target.value)}>
                <option value="">Select platform…</option>
                {Object.entries(PLATFORM_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </div>
          )}

          <div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
              <span style={label}>Content</span>
              {type === "html_email" && (
                <>
                  <button type="button" onClick={() => fileRef.current?.click()} style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, fontWeight: 700, color: BRAND, background: BRAND_LIGHT, border: "none", borderRadius: 6, padding: "4px 10px", cursor: "pointer" }}>
                    <Upload size={13} /> Upload .html
                  </button>
                  <input ref={fileRef} type="file" accept=".html,.htm,.txt" onChange={handleFile} style={{ display: "none" }} />
                </>
              )}
              {type !== "html_email" && <span style={{ fontSize: 11, color: "#9ca3af" }}>{content.length} chars</span>}
            </div>
            <textarea value={content} onChange={(e) => setContent(e.target.value)} rows={type === "html_email" ? 12 : 6}
              placeholder={type === "html_email" ? "Paste your HTML email code here, or upload a .html file above…" : "Paste your content here…"}
              style={{ ...input, height: type === "html_email" ? 220 : 130, resize: "vertical", fontFamily: type === "html_email" ? "monospace" : "inherit", fontSize: type === "html_email" ? 12 : 14, lineHeight: 1.6 }} />
          </div>

          {/* Photo — for WhatsApp/SMS/caption/other. Rides along as the WhatsApp
              media (the message becomes its caption) when "Send on WhatsApp". */}
          {type !== "html_email" && (
            <div>
              <span style={label}>Photo {type === "whatsapp" ? "(sent with the message as its caption)" : "(optional)"}</span>
              {imageUrl ? (
                <div style={{ display: "flex", alignItems: "center", gap: 12, padding: 10, border: "1.5px solid #e5e7eb", borderRadius: 10, background: "#fafafa" }}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={imageUrl} alt="attachment" style={{ width: 64, height: 64, objectFit: "cover", borderRadius: 8, border: "1px solid #e5e7eb" }} />
                  <div style={{ flex: 1, minWidth: 0, fontSize: 12, color: "#6b7280" }}>
                    Image attached
                    <div style={{ fontSize: 11, color: "#9ca3af" }}>~{Math.round((imageUrl.length * 0.75) / 1024)} KB</div>
                  </div>
                  <a href={imageUrl} download={`${(title || "image").replace(/[^a-z0-9]/gi, "-").toLowerCase()}`}
                    style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, fontWeight: 700, color: BRAND, background: BRAND_LIGHT, borderRadius: 6, padding: "5px 10px", textDecoration: "none" }}>
                    <Download size={13} /> Download
                  </a>
                  <button type="button" onClick={() => setImageUrl("")}
                    style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, fontWeight: 700, color: "#dc2626", background: "#fee2e2", border: "none", borderRadius: 6, padding: "5px 10px", cursor: "pointer" }}>
                    <X size={13} /> Remove
                  </button>
                </div>
              ) : (
                <button type="button" onClick={() => imageRef.current?.click()}
                  style={{ display: "flex", alignItems: "center", gap: 7, padding: "10px 14px", border: "1.5px dashed #cbd5e1", borderRadius: 10, background: "#fff", fontSize: 12.5, fontWeight: 700, color: "#16a34a", cursor: "pointer", width: "100%", justifyContent: "center" }}>
                  <Upload size={15} /> Upload photo
                </button>
              )}
              <input ref={imageRef} type="file" accept="image/*" onChange={handleImage} style={{ display: "none" }} />
            </div>
          )}

          {/* AMP-for-Email body — optional second-channel alternative for HTML
              emails. Gmail renders this version (carousels, GIFs, forms);
              every other client falls through to the HTML above. Hidden
              behind a toggle so it doesn't clutter the basic flow. */}
          {type === "html_email" && (
            <div style={{ border: "1.5px solid #e5e7eb", borderRadius: 10, overflow: "hidden" }}>
              <button type="button" onClick={() => setAmpOpen((v) => !v)}
                style={{ width: "100%", display: "flex", alignItems: "center", gap: 10, padding: "11px 14px", background: ampOpen ? "rgba(99,102,241,0.06)" : "#fafafa", border: "none", cursor: "pointer", fontFamily: "inherit", textAlign: "left" }}>
                <span style={{ width: 26, height: 26, borderRadius: 7, background: "linear-gradient(135deg, #6366f1, #a855f7)", display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                  <Zap size={13} color="#fff" strokeWidth={2.4} />
                </span>
                <span style={{ fontSize: 13, fontWeight: 800, color: "#4338ca", fontFamily: "Manrope, sans-serif", letterSpacing: "-0.01em" }}>AMP for Email</span>
                <span style={{ fontSize: 11, color: "#6b7280", flex: 1 }}>
                  {ampContent.trim()
                    ? `${(ampContent.length / 1024).toFixed(1)} KB · Gmail will render this; other clients fall back to HTML`
                    : "Optional. Add an AMP version for Gmail (carousels, GIFs, forms)."}
                </span>
                {ampOpen ? <ChevronUp size={16} color="#6b7280" /> : <ChevronDown size={16} color="#6b7280" />}
              </button>
              {ampOpen && (
                <div style={{ padding: "14px", borderTop: "1px solid #e5e7eb" }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
                    <span style={{ fontSize: 11, color: "#6b7280", lineHeight: 1.5 }}>
                      Must start with <code style={{ background: "#f3f4f6", padding: "1px 5px", borderRadius: 4 }}>&lt;!doctype html&gt;&lt;html ⚡4email&gt;</code> and include the AMP boilerplate.
                    </span>
                    <button type="button" onClick={() => ampFileRef.current?.click()}
                      style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, fontWeight: 700, color: "#4338ca", background: "rgba(99,102,241,0.10)", border: "none", borderRadius: 6, padding: "4px 10px", cursor: "pointer", flexShrink: 0 }}>
                      <Upload size={13} /> Upload AMP file
                    </button>
                    <input ref={ampFileRef} type="file" accept=".html,.htm,.amp" onChange={handleAmpFile} style={{ display: "none" }} />
                  </div>
                  <textarea value={ampContent} onChange={(e) => setAmpContent(e.target.value)} rows={10}
                    placeholder={'<!doctype html>\n<html ⚡4email lang="en"><head><meta charset="utf-8">\n<script async src="https://cdn.ampproject.org/v0.js"></script>\n<style amp4email-boilerplate>body{visibility:hidden}</style>\n<style amp-custom>/* your styles */</style>\n</head><body>\n  <!-- AMP body here -->\n</body></html>'}
                    style={{ ...input, height: 200, resize: "vertical", fontFamily: "monospace", fontSize: 12, lineHeight: 1.6, background: "#0f172a", color: "#dcdcaa", border: "1px solid #1e293b" }} />
                </div>
              )}
            </div>
          )}

          <div>
            <span style={label}>Tags (comma-separated)</span>
            <input style={input} value={tags} onChange={(e) => setTags(e.target.value)} placeholder="welcome, week1, english" />
          </div>
          <div>
            <span style={label}>Internal notes (optional)</span>
            <input style={input} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. For cold leads in July batch" />
          </div>

          {err && <div style={{ padding: "10px 14px", borderRadius: 8, background: "rgba(220,38,38,0.08)", border: "1px solid rgba(220,38,38,0.2)", fontSize: 13, color: "#dc2626" }}>{err}</div>}

          <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", paddingTop: 4 }}>
            <button onClick={onClose} style={{ padding: "10px 20px", borderRadius: 9, border: "1.5px solid #e5e7eb", background: "#fff", fontSize: 14, fontWeight: 700, cursor: "pointer", color: "#374151" }}>Cancel</button>
            <button onClick={save} disabled={saving} style={{ padding: "10px 24px", borderRadius: 9, border: "none", background: BRAND, color: "#fff", fontSize: 14, fontWeight: 700, cursor: saving ? "not-allowed" : "pointer", opacity: saving ? 0.7 : 1 }}>
              {saving ? "Saving…" : isEdit ? "Save changes" : "Add content"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ─── Preview modal ──────────────────────────────────── */
function PreviewModal({ asset, onClose }: { asset: Asset; onClose: () => void }) {
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 1000, background: "rgba(0,0,0,0.6)", display: "flex", flexDirection: "column", padding: 16 }} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "#fff", borderRadius: 18, width: "100%", maxWidth: 680, margin: "0 auto", display: "flex", flexDirection: "column", height: "100%", maxHeight: "92vh", overflow: "hidden", boxShadow: "0 24px 60px rgba(0,0,0,0.25)" }}>
        <div style={{ padding: "16px 22px", borderBottom: "1px solid #f3f4f6", display: "flex", alignItems: "center", gap: 12, flexShrink: 0 }}>
          <Eye size={20} color={BRAND} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontFamily: "Manrope, sans-serif", fontWeight: 800, fontSize: 14, color: BRAND, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{asset.title}</div>
            {asset.subject && <div style={{ fontSize: 12, color: "#6b7280", marginTop: 1 }}>Subject: {asset.subject}</div>}
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", padding: 4, color: "#9ca3af" }}><X size={22} /></button>
        </div>
        <iframe srcDoc={asset.content} title="Email Preview" style={{ flex: 1, border: "none", width: "100%", background: "#fff" }} />
      </div>
    </div>
  );
}

/* ─── Send test modal — routes through the Vercel SMTP bridge ─── */
function SendTestModal({ asset, onClose }: { asset: Asset; onClose: () => void }) {
  const [to, setTo] = useState("");
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState("");
  const [err, setErr] = useState("");

  const send = async () => {
    if (!to.trim()) { setErr("Enter an email address."); return; }
    setSending(true); setErr(""); setResult("");
    try {
      const res = await fetch("/api/outreach/send", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${getToken() || ""}`,
          "X-Workspace-Id": getWorkspaceId() || "",
        },
        body: JSON.stringify({
          lead_id: null,
          to: to.trim(),
          subject: `[TEST] ${asset.subject || asset.title}`,
          body_html: asset.content,
          body_text: "",
          body_amp: asset.amp_content || "",
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (res.ok && json.ok !== false) setResult(`Sent to ${to.trim()}`);
      else setErr(json.error || `Failed to send (${res.status})`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  };

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 1100, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "#fff", borderRadius: 16, width: "100%", maxWidth: 420, padding: 28, boxShadow: "0 20px 50px rgba(0,0,0,0.2)" }}>
        <div style={{ fontFamily: "Manrope, sans-serif", fontWeight: 900, fontSize: 17, color: BRAND, marginBottom: 4 }}>Send test email</div>
        <div style={{ fontSize: 13, color: "#6b7280", marginBottom: 20 }}>&ldquo;{asset.title}&rdquo;</div>
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 6 }}>Recipient email</div>
          <input type="email" value={to} onChange={(e) => { setTo(e.target.value); setErr(""); }} placeholder="you@example.com" autoFocus
            style={{ width: "100%", padding: "10px 12px", border: "1.5px solid #e5e7eb", borderRadius: 8, fontSize: 14, fontFamily: "inherit", outline: "none", boxSizing: "border-box" }} />
        </div>
        <div style={{ fontSize: 11.5, color: "#9ca3af", marginBottom: 14, lineHeight: 1.5 }}>
          Sends via your connected email sender (Settings → Email Senders), the same path Campaigns use.
        </div>
        {asset.amp_content && (
          <div style={{ marginBottom: 12, padding: "8px 11px", borderRadius: 7, background: "linear-gradient(135deg, rgba(99,102,241,0.08), rgba(168,85,247,0.08))", border: "1px solid rgba(99,102,241,0.20)", fontSize: 11.5, color: "#4338ca", display: "flex", alignItems: "center", gap: 7, lineHeight: 1.5 }}>
            <Zap size={13} /> AMP body attached — Gmail will render the AMP version; other clients fall back to HTML.
          </div>
        )}
        {err && <div style={{ marginBottom: 12, padding: "9px 12px", borderRadius: 7, background: "rgba(220,38,38,0.08)", fontSize: 13, color: "#dc2626" }}>{err}</div>}
        {result && <div style={{ marginBottom: 12, padding: "9px 12px", borderRadius: 7, background: "rgba(22,163,74,0.08)", fontSize: 13, color: "#16a34a", display: "flex", alignItems: "center", gap: 7 }}><CheckCircle2 size={16} /> {result}</div>}
        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
          <button onClick={onClose} style={{ padding: "9px 18px", borderRadius: 8, border: "1.5px solid #e5e7eb", background: "#fff", fontSize: 13, fontWeight: 700, cursor: "pointer", color: "#374151" }}>Close</button>
          <button onClick={send} disabled={sending} style={{ display: "flex", alignItems: "center", gap: 7, padding: "9px 20px", borderRadius: 8, border: "none", background: "#1d4ed8", color: "#fff", fontSize: 13, fontWeight: 700, cursor: sending ? "not-allowed" : "pointer", opacity: sending ? 0.7 : 1 }}>
            <Send size={15} /> {sending ? "Sending…" : "Send"}
          </button>
        </div>
      </div>
    </div>
  );
}
