"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";

interface Workspace {
  id: string;
  name: string;
  settings: { ai_style?: string };
}

export default function AIWriterPage() {
  const qc = useQueryClient();
  const { data: ws } = useQuery<Workspace>({
    queryKey: ["workspace"],
    queryFn: () => api("/workspaces/current"),
  });
  const [style, setStyle] = useState("");
  useEffect(() => {
    if (ws) setStyle(ws.settings?.ai_style || "");
  }, [ws]);
  const save = useMutation({
    mutationFn: () => api("/workspaces/current", { method: "PATCH", body: { settings: { ai_style: style } } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["workspace"] }),
  });
  return (
    <div className="card max-w-3xl p-6">
      <h2 className="text-base font-semibold">AI Writer</h2>
      <p className="mt-1 text-sm text-slate-500">
        Set the voice the AI uses when drafting personalized emails (e.g. tone, value props, things to avoid).
      </p>
      <textarea
        className="input mt-4 min-h-[200px]"
        value={style}
        onChange={(e) => setStyle(e.target.value)}
        placeholder={"We are X. We help Y do Z. Voice: warm, direct, no jargon. Avoid: emojis, hard sells."}
      />
      <div className="mt-3">
        <button className="btn-primary" disabled={save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? "Saving…" : "Save voice"}
        </button>
      </div>
    </div>
  );
}
