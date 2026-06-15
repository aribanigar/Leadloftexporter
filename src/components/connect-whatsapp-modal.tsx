"use client";

/**
 * Connect WhatsApp modal — two paths.
 *
 * The user said: "i should be able to connect my whatsapp in realtime by
 * connecting it. make it simpler and easier." Meta's Cloud API is the
 * proper API path but it requires Meta Business + Developer App +
 * permanent token — that's not "instant". So this modal offers TWO ways
 * to use WhatsApp, side by side:
 *
 * 1. CLICK-TO-CHAT (zero setup)
 *    Uses the public wa.me/<phone> deep link. On every lead the user
 *    sees a "Open in WhatsApp Web" button, click → WhatsApp Web opens
 *    with their personal account + the chat pre-filled. They tap Send
 *    in WhatsApp Web. Real real-time, real conversation, no API token.
 *
 * 2. AUTO-SEND via Meta WhatsApp Cloud API (paste a token)
 *    Same Settings → WhatsApp form, inlined here so users don't leave
 *    the Outreach page to set it up. Required for the in-CRM
 *    "Send via WhatsApp" button to dispatch programmatically without
 *    a click on WhatsApp Web.
 */

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  X,
  MessageCircle,
  Loader2,
  ExternalLink,
  CheckCircle2,
  AlertCircle,
  Zap,
  Plug,
} from "lucide-react";
import { api } from "@/lib/api";

interface Props {
  open: boolean;
  onClose: () => void;
  onConnected?: () => void;
  // Already-connected indicator so the modal can lead with a green check.
  alreadyConnected?: boolean;
  display?: string | null;
}

export function ConnectWhatsAppModal({ open, onClose, onConnected, alreadyConnected, display }: Props) {
  const [token, setToken] = useState("");
  const [phoneId, setPhoneId] = useState("");
  const save = useMutation<{ connected: boolean; display?: string | null }, Error, void>({
    mutationFn: () =>
      api("/whatsapp/config", {
        method: "POST",
        body: { access_token: token.trim(), phone_number_id: phoneId.trim() },
      }),
    onSuccess: () => {
      setToken("");
      setPhoneId("");
      onConnected?.();
    },
  });
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-slate-900/50 p-4" onClick={onClose}>
      <div className="w-full max-w-xl rounded-xl bg-white p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <MessageCircle className="h-5 w-5 text-emerald-600" />
            <h2 className="text-sm font-semibold">Use WhatsApp from LeadCaptura</h2>
          </div>
          <button className="rounded p-1 text-slate-400 hover:bg-slate-100" onClick={onClose}>
            <X className="h-4 w-4" />
          </button>
        </div>

        {alreadyConnected && (
          <div className="mb-3 flex items-center gap-2 rounded-md bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
            <CheckCircle2 className="h-4 w-4" /> WhatsApp Cloud API connected{display ? ` (${display})` : ""}.
            You can still use WhatsApp Web below as a backup.
          </div>
        )}

        {/* ─── PATH 1 — Click-to-chat via WhatsApp Web (zero setup) ─── */}
        <div className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50/50 p-4">
          <div className="mb-1 flex items-center gap-2 text-sm font-semibold text-emerald-900">
            <Zap className="h-4 w-4" />
            Click-to-chat — instant, zero setup
            <span className="ml-auto rounded-full bg-emerald-600 px-2 py-0.5 text-[10px] font-medium uppercase text-white">
              recommended
            </span>
          </div>
          <p className="text-xs leading-relaxed text-emerald-900/80">
            Every lead with a phone number gets an{" "}
            <strong>&quot;Open in WhatsApp Web&quot;</strong> button. Click it →
            WhatsApp Web opens in a new tab with the chat pre-filled and your
            message ready. You tap Send in WhatsApp Web and it goes from your
            personal WhatsApp number, real-time. No tokens, no Meta account,
            no setup at all.
          </p>
          <a
            href="https://web.whatsapp.com"
            target="_blank"
            rel="noopener noreferrer"
            className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-emerald-700 hover:underline"
          >
            Open WhatsApp Web in a tab now <ExternalLink className="h-3 w-3" />
          </a>
          <p className="mt-2 text-[11px] text-emerald-900/70">
            First time? Scan the QR code in WhatsApp Web with your phone once —
            after that every &quot;Open in WhatsApp Web&quot; click lands you
            straight in the right chat.
          </p>
        </div>

        {/* ─── PATH 2 — Meta WhatsApp Cloud API (auto-send) ─── */}
        <div className="rounded-lg border border-slate-200 p-4">
          <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-slate-800">
            <Plug className="h-4 w-4" />
            Auto-send via Meta WhatsApp Cloud API
          </div>
          <p className="mb-3 text-xs leading-relaxed text-slate-600">
            For programmatic delivery (the in-CRM &quot;Send via WhatsApp&quot;
            button dispatches without you clicking anything in WhatsApp Web).
            Requires a Meta Business Account + a permanent access token.
            Free tier: 1,000 user-initiated conversations / month.
          </p>
          <label className="label">Permanent access token</label>
          <input
            className="input"
            type="password"
            placeholder="EAAG…"
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
          <label className="label mt-3">Phone number ID</label>
          <input
            className="input"
            placeholder="e.g. 123456789012345"
            value={phoneId}
            onChange={(e) => setPhoneId(e.target.value)}
          />
          {save.isError && (
            <p className="mt-2 flex items-start gap-1 text-xs text-red-600">
              <AlertCircle className="mt-0.5 h-3 w-3 flex-shrink-0" />
              {save.error?.message || "Could not verify."}
            </p>
          )}
          {save.isSuccess && (
            <p className="mt-2 flex items-center gap-1 text-xs text-emerald-700">
              <CheckCircle2 className="h-3 w-3" /> Cloud API connected.
            </p>
          )}
          <div className="mt-3 flex items-center gap-2">
            <button
              className="btn-secondary"
              type="button"
              onClick={() =>
                window.open(
                  "https://developers.facebook.com/docs/whatsapp/cloud-api/get-started",
                  "_blank",
                  "noopener"
                )
              }
            >
              <ExternalLink className="h-3.5 w-3.5" /> Setup guide
            </button>
            <button
              className="btn-primary ml-auto disabled:opacity-50"
              disabled={token.trim().length < 10 || phoneId.trim().length < 3 || save.isPending}
              onClick={() => save.mutate()}
            >
              {save.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plug className="h-4 w-4" />}
              {save.isPending ? "Verifying…" : "Connect"}
            </button>
          </div>
        </div>

        <div className="mt-4 flex justify-end">
          <button className="btn-secondary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
