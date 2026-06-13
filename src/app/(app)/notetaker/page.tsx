"use client";

import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Mic, Upload, Trash2, FileText, AlertTriangle, ListChecks } from "lucide-react";
import { api, API_BASE, getToken, getWorkspaceId } from "@/lib/api";
import { fmtRelative } from "@/lib/utils";

interface MeetingNote {
  id: string;
  title: string;
  transcript: string | null;
  summary: string | null;
  action_items: string[];
  source: string;
  status: string;
  error: string | null;
  lead_id: string | null;
  created_at: string;
}

export default function NotetakerPage() {
  const qc = useQueryClient();
  const [title, setTitle] = useState("");
  const [transcript, setTranscript] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const { data: status } = useQuery<{ transcription_enabled: boolean }>({
    queryKey: ["notetaker-status"],
    queryFn: () => api("/notetaker/status"),
  });
  const { data } = useQuery<{ notes: MeetingNote[] }>({
    queryKey: ["notetaker"],
    queryFn: () => api("/notetaker"),
  });
  const notes = data?.notes || [];

  const submit = useMutation({
    mutationFn: async () => {
      const fd = new FormData();
      fd.append("title", title.trim() || (file ? file.name : "Meeting"));
      if (transcript.trim()) fd.append("transcript", transcript.trim());
      if (file) fd.append("file", file);
      const headers: Record<string, string> = {};
      const t = getToken();
      const w = getWorkspaceId();
      if (t) headers["Authorization"] = `Bearer ${t}`;
      if (w) headers["X-Workspace-Id"] = w;
      const res = await fetch(`${API_BASE}/api/v1/notetaker/transcribe`, { method: "POST", headers, body: fd });
      const text = await res.text();
      const json = text ? JSON.parse(text) : null;
      if (!res.ok) throw new Error(json?.detail || `Error ${res.status}`);
      return json;
    },
    onSuccess: () => {
      setTitle("");
      setTranscript("");
      setFile(null);
      if (fileRef.current) fileRef.current.value = "";
      setErr(null);
      qc.invalidateQueries({ queryKey: ["notetaker"] });
    },
    onError: (e: unknown) => setErr((e as Error).message),
  });

  const del = useMutation({
    mutationFn: (id: string) => api(`/notetaker/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["notetaker"] }),
  });

  const canSubmit = (!!transcript.trim() || !!file) && !submit.isPending;

  return (
    <div className="p-6">
      <div className="mb-4 flex items-center gap-2">
        <Mic className="h-5 w-5 text-brand-600" />
        <h1 className="text-lg font-semibold">Meeting Notetaker</h1>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Upload */}
        <div className="card space-y-3 p-5">
          {status && !status.transcription_enabled && (
            <div className="flex items-start gap-2 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              Audio transcription isn&apos;t configured (set <code>OPENAI_API_KEY</code> on the backend). You can still
              paste a transcript below.
            </div>
          )}
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-400">Title</span>
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Discovery call — Acme" className="w-full rounded-md border border-slate-200 px-3 py-2 text-sm" />
          </label>

          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-400">Recording (mp3 / m4a / wav)</span>
            <input
              ref={fileRef}
              type="file"
              accept="audio/*,.mp3,.m4a,.wav,.mp4"
              onChange={(e) => setFile(e.target.files?.[0] || null)}
              className="block w-full text-sm text-slate-600 file:mr-3 file:rounded-md file:border-0 file:bg-brand-50 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-brand-700 hover:file:bg-brand-100"
            />
          </label>

          <div className="text-center text-xs text-slate-400">— or —</div>

          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-400">Paste a transcript</span>
            <textarea
              value={transcript}
              onChange={(e) => setTranscript(e.target.value)}
              rows={6}
              placeholder="Paste the meeting transcript here…"
              className="w-full rounded-md border border-slate-200 px-3 py-2 text-sm"
            />
          </label>

          {err && <p className="text-sm text-rose-600">{err}</p>}
          <button
            onClick={() => submit.mutate()}
            disabled={!canSubmit}
            className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-brand-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-60"
          >
            <Upload className="h-4 w-4" />
            {submit.isPending ? "Processing…" : "Generate notes"}
          </button>
          {submit.isPending && file && (
            <p className="text-center text-xs text-slate-400">Transcribing audio can take a minute…</p>
          )}
        </div>

        {/* History */}
        <div className="space-y-3">
          {notes.length === 0 && (
            <div className="card p-8 text-center text-sm text-slate-500">
              No meeting notes yet. Upload a recording or paste a transcript to get a summary + action items.
            </div>
          )}
          {notes.map((n) => (
            <NoteCard key={n.id} note={n} onDelete={() => del.mutate(n.id)} />
          ))}
        </div>
      </div>
    </div>
  );
}

function NoteCard({ note, onDelete }: { note: MeetingNote; onDelete: () => void }) {
  const [showTranscript, setShowTranscript] = useState(false);
  return (
    <div className="card p-5">
      <div className="mb-2 flex items-start justify-between gap-2">
        <div>
          <h3 className="font-semibold text-slate-800">{note.title}</h3>
          <p className="text-xs text-slate-400">
            {fmtRelative(note.created_at)} · {note.source}
            {note.lead_id ? " · attached to lead" : ""}
          </p>
        </div>
        <button onClick={onDelete} className="rounded p-1 text-slate-400 hover:bg-rose-50 hover:text-rose-600" title="Delete">
          <Trash2 className="h-4 w-4" />
        </button>
      </div>
      {note.summary && <p className="whitespace-pre-wrap text-sm text-slate-700">{note.summary}</p>}
      {note.action_items.length > 0 && (
        <div className="mt-3">
          <div className="mb-1 flex items-center gap-1 text-xs font-medium uppercase tracking-wide text-slate-400">
            <ListChecks className="h-3.5 w-3.5" /> Action items
          </div>
          <ul className="space-y-1">
            {note.action_items.map((a, i) => (
              <li key={i} className="flex gap-2 text-sm text-slate-700">
                <span className="text-brand-500">•</span>
                <span>{a}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {note.transcript && (
        <div className="mt-3">
          <button onClick={() => setShowTranscript((v) => !v)} className="inline-flex items-center gap-1 text-xs font-medium text-brand-700 hover:underline">
            <FileText className="h-3.5 w-3.5" /> {showTranscript ? "Hide" : "Show"} transcript
          </button>
          {showTranscript && (
            <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-slate-50 p-3 text-xs text-slate-600">
              {note.transcript}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
