"use client";
/**
 * Content Hub — businesses index (Google-Drive-style folders).
 *
 * Each "business" is a folder with a dynamic slug. Clicking one opens its
 * asset library at /content-hub/[slug]. "Add a business" creates a new
 * folder (name + brand color). Rename / rebrand / delete via the card menu.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  FolderOpen, Plus, X, MoreVertical, Pencil, Trash2, Folder,
  Mail, MessageCircle, Camera, MessageSquare, FileText,
} from "lucide-react";
import { api, ApiError } from "@/lib/api";

const BRAND = "#00361a";
const ACCENT = "#c8a84b";

const FOLDER_COLORS = [
  "#00361a", "#1d4ed8", "#7c3aed", "#db2777", "#ea580c",
  "#0891b2", "#16a34a", "#ca8a04", "#dc2626", "#475569",
];

interface BizStats { total: number; email: number; whatsapp: number; caption: number; sms: number; other: number; }
interface Business {
  id: string; name: string; slug: string; description: string;
  brand_color: string; accent_color: string; tone: string; logo_url: string;
  asset_count: number; stats?: BizStats;
}

export default function ContentHubIndexPage() {
  const router = useRouter();
  const qc = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);
  const [editBiz, setEditBiz] = useState<Business | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["content-businesses"],
    queryFn: () => api<{ businesses: Business[] }>("/content-hub/businesses"),
  });
  const businesses = data?.businesses ?? [];

  const totalAssets = businesses.reduce((n, b) => n + (b.asset_count || 0), 0);

  return (
    <div style={{ padding: "28px 32px", maxWidth: 1240, margin: "0 auto" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 26, flexWrap: "wrap", gap: 14 }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 11, marginBottom: 5 }}>
            <span style={{
              width: 34, height: 34, borderRadius: 10, background: BRAND,
              display: "inline-flex", alignItems: "center", justifyContent: "center",
              boxShadow: "0 6px 18px rgba(0,54,26,0.28)",
            }}>
              <FolderOpen size={18} color="#fff" strokeWidth={2.2} />
            </span>
            <h1 style={{ fontFamily: "Manrope, Inter, sans-serif", fontWeight: 900, fontSize: 25, color: BRAND, margin: 0, letterSpacing: "-0.02em" }}>
              Content Hub
            </h1>
          </div>
          <p style={{ fontSize: 13.5, color: "#6b7280", margin: 0, maxWidth: 560, lineHeight: 1.55 }}>
            One folder per business. Store and organise HTML emails, WhatsApp messages, captions and SMS — preview, send tests, and download from anywhere.
          </p>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          style={{
            display: "flex", alignItems: "center", gap: 8, padding: "11px 22px",
            borderRadius: 11, background: BRAND, color: "#fff", border: "none",
            fontFamily: "Manrope, Inter, sans-serif", fontWeight: 800, fontSize: 14,
            cursor: "pointer", boxShadow: "0 4px 14px rgba(0,54,26,0.25)",
          }}
        >
          <Plus size={17} /> Add a business
        </button>
      </div>

      {/* Summary chips */}
      {businesses.length > 0 && (
        <div style={{ display: "flex", gap: 10, marginBottom: 22, flexWrap: "wrap" }}>
          <SummaryChip label="Businesses" value={businesses.length} />
          <SummaryChip label="Total assets" value={totalAssets} />
        </div>
      )}

      {/* Grid */}
      {isLoading ? (
        <div style={{ textAlign: "center", padding: 60, color: "#9ca3af", fontSize: 14 }}>Loading…</div>
      ) : businesses.length === 0 ? (
        <div style={{ textAlign: "center", padding: "64px 20px", background: "#f9fafb", borderRadius: 18, border: "1.5px dashed #e5e7eb" }}>
          <Folder size={44} color="#d1d5db" style={{ margin: "0 auto 14px", display: "block" }} />
          <div style={{ fontFamily: "Manrope, Inter, sans-serif", fontWeight: 800, fontSize: 17, color: "#374151", marginBottom: 6 }}>No businesses yet</div>
          <div style={{ fontSize: 13, color: "#9ca3af", marginBottom: 22 }}>Create your first business folder to start organising content.</div>
          <button onClick={() => setShowCreate(true)} style={{ display: "inline-flex", alignItems: "center", gap: 7, padding: "11px 24px", borderRadius: 10, background: BRAND, color: "#fff", border: "none", fontWeight: 800, fontSize: 14, cursor: "pointer" }}>
            <Plus size={16} /> Add a business
          </button>
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 16 }}>
          {businesses.map((b) => (
            <BusinessCard
              key={b.id}
              biz={b}
              onOpen={() => router.push(`/content-hub/${b.slug}`)}
              onEdit={() => setEditBiz(b)}
            />
          ))}
        </div>
      )}

      {showCreate && (
        <BusinessModal
          onClose={() => setShowCreate(false)}
          onSaved={(b) => {
            setShowCreate(false);
            qc.invalidateQueries({ queryKey: ["content-businesses"] });
            router.push(`/content-hub/${b.slug}`);
          }}
        />
      )}
      {editBiz && (
        <BusinessModal
          initial={editBiz}
          onClose={() => setEditBiz(null)}
          onSaved={() => { setEditBiz(null); qc.invalidateQueries({ queryKey: ["content-businesses"] }); }}
          onDeleted={() => { setEditBiz(null); qc.invalidateQueries({ queryKey: ["content-businesses"] }); }}
        />
      )}
    </div>
  );
}

function SummaryChip({ label, value }: { label: string; value: number }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 16px", borderRadius: 11, border: "1.5px solid #e5e7eb", background: "#fff" }}>
      <span style={{ fontFamily: "Manrope, sans-serif", fontWeight: 900, fontSize: 18, color: "#111827" }}>{value}</span>
      <span style={{ fontSize: 12, color: "#6b7280", fontWeight: 600 }}>{label}</span>
    </div>
  );
}

const TYPE_META = [
  { key: "email", Icon: Mail, color: "#1d4ed8" },
  { key: "whatsapp", Icon: MessageCircle, color: "#16a34a" },
  { key: "caption", Icon: Camera, color: "#7c3aed" },
  { key: "sms", Icon: MessageSquare, color: "#ea580c" },
  { key: "other", Icon: FileText, color: "#6b7280" },
] as const;

function BusinessCard({ biz, onOpen, onEdit }: { biz: Business; onOpen: () => void; onEdit: () => void }) {
  const color = biz.brand_color || BRAND;
  return (
    <div
      onClick={onOpen}
      style={{
        background: "#fff", border: "1.5px solid #e5e7eb", borderRadius: 16,
        padding: 18, cursor: "pointer", transition: "box-shadow .15s, transform .15s",
        display: "flex", flexDirection: "column", gap: 14, position: "relative",
      }}
      onMouseEnter={(e) => { e.currentTarget.style.boxShadow = "0 8px 24px rgba(0,0,0,0.10)"; e.currentTarget.style.transform = "translateY(-2px)"; }}
      onMouseLeave={(e) => { e.currentTarget.style.boxShadow = "none"; e.currentTarget.style.transform = "none"; }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between" }}>
        <span style={{
          width: 46, height: 46, borderRadius: 13,
          background: `linear-gradient(135deg, ${color}, ${color}cc)`,
          display: "inline-flex", alignItems: "center", justifyContent: "center",
          boxShadow: `0 6px 16px ${color}40`,
        }}>
          <FolderOpen size={22} color="#fff" strokeWidth={2.2} />
        </span>
        <button
          onClick={(e) => { e.stopPropagation(); onEdit(); }}
          title="Edit business"
          style={{ background: "none", border: "none", cursor: "pointer", padding: 5, borderRadius: 7, color: "#9ca3af" }}
          onMouseEnter={(e) => (e.currentTarget.style.background = "#f3f4f6")}
          onMouseLeave={(e) => (e.currentTarget.style.background = "none")}
        >
          <MoreVertical size={17} />
        </button>
      </div>

      <div>
        <div style={{ fontFamily: "Manrope, Inter, sans-serif", fontWeight: 800, fontSize: 16, color: "#111827", lineHeight: 1.25, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{biz.name}</div>
        <div style={{ fontSize: 11.5, color: "#9ca3af", marginTop: 2, fontFamily: "ui-monospace, Menlo, monospace" }}>/{biz.slug}</div>
        {biz.description && (
          <div style={{ fontSize: 12, color: "#6b7280", marginTop: 7, lineHeight: 1.5, overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" as const }}>{biz.description}</div>
        )}
      </div>

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: "auto", paddingTop: 12, borderTop: "1px solid #f3f4f6" }}>
        <span style={{ fontSize: 12.5, fontWeight: 700, color: "#374151" }}>
          {biz.asset_count} {biz.asset_count === 1 ? "asset" : "assets"}
        </span>
        <div style={{ display: "flex", gap: 5 }}>
          {TYPE_META.map(({ key, Icon, color: c }) => {
            const n = biz.stats?.[key as keyof BizStats] ?? 0;
            if (!n) return null;
            return (
              <span key={key} title={`${n} ${key}`} style={{ display: "inline-flex", alignItems: "center", gap: 2, fontSize: 11, fontWeight: 700, color: c }}>
                <Icon size={12} /> {n}
              </span>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/* ─── Create / edit business modal ─────────────────────── */
function BusinessModal({
  initial, onClose, onSaved, onDeleted,
}: {
  initial?: Business;
  onClose: () => void;
  onSaved: (b: Business) => void;
  onDeleted?: () => void;
}) {
  const isEdit = !!initial;
  const [name, setName] = useState(initial?.name || "");
  const [description, setDescription] = useState(initial?.description || "");
  const [brandColor, setBrandColor] = useState(initial?.brand_color || BRAND);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");
  const [delConfirm, setDelConfirm] = useState(false);

  const save = async () => {
    if (!name.trim()) { setErr("Business name is required."); return; }
    setSaving(true); setErr("");
    try {
      const payload = { name: name.trim(), description: description || null, brand_color: brandColor };
      const b = isEdit
        ? await api<Business>(`/content-hub/businesses/${initial!.id}`, { method: "PATCH", body: payload })
        : await api<Business>("/content-hub/businesses", { method: "POST", body: payload });
      onSaved(b);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    setSaving(true);
    try {
      await api(`/content-hub/businesses/${initial!.id}`, { method: "DELETE" });
      onDeleted?.();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
      setSaving(false);
    }
  };

  const label: React.CSSProperties = { fontSize: 11, fontWeight: 700, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 6, display: "block" };
  const input: React.CSSProperties = { width: "100%", padding: "10px 12px", border: "1.5px solid #e5e7eb", borderRadius: 9, fontSize: 14, fontFamily: "inherit", outline: "none", boxSizing: "border-box" };

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 1000, background: "rgba(0,0,0,0.45)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "#fff", borderRadius: 18, width: "100%", maxWidth: 460, boxShadow: "0 24px 60px rgba(0,0,0,0.2)", overflow: "hidden" }}>
        <div style={{ padding: "20px 26px", borderBottom: "1px solid #f3f4f6", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ fontFamily: "Manrope, sans-serif", fontWeight: 900, fontSize: 17, color: BRAND }}>{isEdit ? "Edit business" : "Add a business"}</div>
          <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", padding: 4, color: "#9ca3af" }}><X size={20} /></button>
        </div>
        <div style={{ padding: "22px 26px", display: "flex", flexDirection: "column", gap: 18 }}>
          <div>
            <span style={label}>Business name</span>
            <input autoFocus style={input} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Via Kashmir Travel" />
          </div>
          <div>
            <span style={label}>Description (optional)</span>
            <input style={input} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What this business is about" />
          </div>
          <div>
            <span style={label}>Folder colour</span>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              {FOLDER_COLORS.map((c) => (
                <button key={c} type="button" onClick={() => setBrandColor(c)}
                  style={{ width: 28, height: 28, borderRadius: 8, background: c, cursor: "pointer", border: brandColor === c ? "3px solid #111827" : "1px solid rgba(0,0,0,0.1)" }} />
              ))}
              <input type="color" value={brandColor} onChange={(e) => setBrandColor(e.target.value)} style={{ width: 30, height: 30, border: "none", padding: 0, background: "transparent", cursor: "pointer" }} />
            </div>
          </div>
          {err && <div style={{ padding: "9px 12px", borderRadius: 8, background: "rgba(220,38,38,0.08)", fontSize: 13, color: "#dc2626" }}>{err}</div>}
          <div style={{ display: "flex", gap: 10, justifyContent: "space-between", alignItems: "center", paddingTop: 2 }}>
            <div>
              {isEdit && onDeleted && (
                delConfirm ? (
                  <button onClick={remove} disabled={saving} style={{ padding: "9px 14px", borderRadius: 8, border: "1.5px solid #fca5a5", background: "#fee2e2", fontSize: 13, fontWeight: 700, color: "#dc2626", cursor: "pointer" }}>
                    Delete — confirm?
                  </button>
                ) : (
                  <button onClick={() => setDelConfirm(true)} style={{ display: "flex", alignItems: "center", gap: 5, padding: "9px 14px", borderRadius: 8, border: "1.5px solid #e5e7eb", background: "#fff", fontSize: 13, fontWeight: 700, color: "#9ca3af", cursor: "pointer" }}>
                    <Trash2 size={14} /> Delete
                  </button>
                )
              )}
            </div>
            <div style={{ display: "flex", gap: 10 }}>
              <button onClick={onClose} style={{ padding: "10px 18px", borderRadius: 9, border: "1.5px solid #e5e7eb", background: "#fff", fontSize: 14, fontWeight: 700, cursor: "pointer", color: "#374151" }}>Cancel</button>
              <button onClick={save} disabled={saving} style={{ display: "flex", alignItems: "center", gap: 6, padding: "10px 22px", borderRadius: 9, border: "none", background: BRAND, color: "#fff", fontSize: 14, fontWeight: 700, cursor: saving ? "not-allowed" : "pointer", opacity: saving ? 0.7 : 1 }}>
                {isEdit ? <Pencil size={14} /> : <Plus size={15} />}
                {saving ? "Saving…" : isEdit ? "Save" : "Create"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
