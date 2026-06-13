"use client";

import { use, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { api } from "@/lib/api";

interface RField {
  key: string;
  label: string;
  type: string;
  options?: string[];
  required?: boolean;
}
interface PublicForm {
  name: string;
  slug: string;
  fields: RField[];
  workspace_slug: string;
}

export default function PublicRoutingPage({ params }: { params: Promise<{ workspace: string; form: string }> }) {
  const { workspace, form } = use(params);
  const base = `/route/${workspace}/${form}`;

  const { data, isLoading, isError } = useQuery<PublicForm>({
    queryKey: ["public-route", workspace, form],
    queryFn: () => api(base),
    retry: false,
  });

  const [answers, setAnswers] = useState<Record<string, string>>({});

  const submit = useMutation({
    mutationFn: () => api<{ action: { type: string; target: string }; workspace_slug: string }>(base, { method: "POST", body: { answers } }),
    onSuccess: (r) => {
      const a = r.action || {};
      if (a.type === "url" && a.target) {
        window.location.href = a.target;
      } else if (a.type === "event" && a.target) {
        window.location.href = `/book/${r.workspace_slug}/${a.target}`;
      }
    },
  });

  if (isLoading) return <Centered>Loading…</Centered>;
  if (isError || !data) return <Centered>This form isn&apos;t available.</Centered>;

  const noRoute = submit.isSuccess; // success but no redirect happened (no action configured)

  return (
    <Centered>
      <div className="w-[24rem] max-w-full">
        <h1 className="mb-4 text-lg font-semibold text-slate-800">{data.name}</h1>
        <div className="space-y-3">
          {data.fields.map((f) => (
            <label key={f.key} className="block">
              <span className="mb-1 block text-sm font-medium text-slate-700">{f.label}</span>
              {f.type === "select" ? (
                <select
                  value={answers[f.key] || ""}
                  onChange={(e) => setAnswers({ ...answers, [f.key]: e.target.value })}
                  className="w-full rounded-md border border-slate-200 px-3 py-2 text-sm"
                >
                  <option value="">Select…</option>
                  {(f.options || []).map((o) => (
                    <option key={o} value={o}>
                      {o}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  value={answers[f.key] || ""}
                  onChange={(e) => setAnswers({ ...answers, [f.key]: e.target.value })}
                  className="w-full rounded-md border border-slate-200 px-3 py-2 text-sm"
                />
              )}
            </label>
          ))}
          {noRoute && <p className="text-sm text-amber-600">Thanks! There&apos;s nothing to book based on your answers.</p>}
          <button
            onClick={() => submit.mutate()}
            disabled={submit.isPending}
            className="w-full rounded-md bg-brand-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-60"
          >
            {submit.isPending ? "Continuing…" : "Continue"}
          </button>
        </div>
      </div>
    </Centered>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid min-h-screen place-items-center bg-slate-100 p-6 text-slate-600">
      <div className="rounded-xl border border-slate-200 bg-white p-8 shadow-sm">{children}</div>
    </div>
  );
}
