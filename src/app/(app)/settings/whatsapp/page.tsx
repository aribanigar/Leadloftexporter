"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MessageCircle, CheckCircle2, Loader2, ExternalLink, Users } from "lucide-react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";

interface WaConfig {
  connected: boolean;
  phone_number_id?: string;
  display?: string | null;
}

export default function WhatsAppSettingsPage() {
  const qc = useQueryClient();
  const { workspace } = useAuth();
  const isManager = workspace?.role === "owner" || workspace?.role === "admin";
  const [token, setToken] = useState("");
  const [phoneId, setPhoneId] = useState("");

  const { data: config, isLoading } = useQuery<WaConfig>({
    queryKey: ["whatsapp-config"],
    queryFn: () => api("/whatsapp/config"),
  });

  const save = useMutation<WaConfig, Error, void>({
    mutationFn: () =>
      api("/whatsapp/config", {
        method: "POST",
        body: { access_token: token.trim(), phone_number_id: phoneId.trim() },
      }),
    onSuccess: () => {
      setToken("");
      setPhoneId("");
      qc.invalidateQueries({ queryKey: ["whatsapp-config"] });
    },
  });

  const disconnect = useMutation({
    mutationFn: () => api("/whatsapp/config", { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["whatsapp-config"] }),
  });

  return (
    <div className="max-w-2xl">
      <div className="mb-1 flex items-center gap-2">
        <MessageCircle className="h-5 w-5 text-emerald-600" />
        <h1 className="text-lg font-semibold">WhatsApp Business API</h1>
      </div>
      <p className="mb-5 text-sm text-slate-500">
        One connection covers the whole workspace — once an admin connects it here,
        everyone can send WhatsApp messages from the Messaging tab with no setup of
        their own.
      </p>

      {isLoading ? (
        <div className="card p-5 text-sm text-slate-400">Loading…</div>
      ) : config?.connected ? (
        <div className="card p-5">
          <div className="flex items-center gap-2 text-sm">
            <CheckCircle2 className="h-5 w-5 text-emerald-600" />
            <span className="font-medium text-slate-800">Connected</span>
            {config.display && (
              <span className="rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
                {config.display}
              </span>
            )}
          </div>
          <p className="mt-2 text-xs text-slate-500">
            Phone number ID: <span className="font-mono">{config.phone_number_id}</span>
          </p>
          <p className="mt-2 flex items-center gap-1.5 text-xs text-slate-500">
            <Users className="h-3.5 w-3.5" /> Shared with everyone in this workspace — no one else needs to connect their own.
          </p>
          {isManager ? (
            <button
              className="btn-danger mt-4"
              disabled={disconnect.isPending}
              onClick={() => {
                if (window.confirm("Disconnect WhatsApp Business API? This stops sending for the whole workspace.")) disconnect.mutate();
              }}
            >
              {disconnect.isPending ? "Disconnecting…" : "Disconnect"}
            </button>
          ) : (
            <p className="mt-4 text-xs text-slate-400">Only the workspace owner or an admin can disconnect this.</p>
          )}
        </div>
      ) : !isManager ? (
        <div className="card p-5 text-sm text-slate-500">
          WhatsApp isn&apos;t connected yet. Ask your workspace owner or an admin to connect it here —
          once they do, you&apos;ll be able to send from the Messaging tab right away, with nothing to set up
          on your end.
        </div>
      ) : (
        <div className="card p-5">
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
            <p className="mt-3 text-sm text-red-600">
              {save.error?.message || "Could not connect."}
            </p>
          )}

          <button
            className="btn-primary mt-4 disabled:opacity-50"
            disabled={token.trim().length < 10 || phoneId.trim().length < 3 || save.isPending}
            onClick={() => save.mutate()}
          >
            {save.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {save.isPending ? "Verifying…" : "Connect"}
          </button>

          <div className="mt-5 rounded-md bg-slate-50 p-3 text-xs text-slate-600">
            <p className="mb-1 font-medium text-slate-700">How to get these</p>
            <ol className="list-decimal space-y-1 pl-4">
              <li>Create a Meta app at developers.facebook.com and add the WhatsApp product.</li>
              <li>Copy the <strong>Phone number ID</strong> from WhatsApp → API Setup.</li>
              <li>Generate a <strong>permanent access token</strong> (System User token with whatsapp_business_messaging).</li>
            </ol>
            <a
              href="https://developers.facebook.com/docs/whatsapp/cloud-api/get-started"
              target="_blank"
              rel="noopener noreferrer"
              className="mt-2 inline-flex items-center gap-1 text-brand-600 hover:underline"
            >
              Meta setup guide <ExternalLink className="h-3 w-3" />
            </a>
          </div>
        </div>
      )}

      <div className="mt-4 rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
        Meta only delivers free-form text within 24h of a customer&apos;s last
        message. For cold outreach outside that window, WhatsApp requires a
        pre-approved <strong>message template</strong> — those sends will return
        an error until you use one. (Template support can be added next.)
      </div>
    </div>
  );
}
