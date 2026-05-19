"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { api } from "@/lib/api";

interface Acct {
  id: string;
  provider: string;
  label?: string | null;
  external_id?: string | null;
  status: string;
}

export default function AccountsPage() {
  const qc = useQueryClient();
  const { data: accounts } = useQuery<Acct[]>({
    queryKey: ["accounts"],
    queryFn: () => api("/integrations/accounts"),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/integrations/accounts/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["accounts"] }),
  });
  return (
    <div className="card max-w-3xl p-6">
      <h2 className="mb-4 text-base font-semibold">Connected Accounts</h2>
      <p className="mb-4 text-sm text-slate-500">
        Connect your email mailbox and pair the Chrome extension to authorize LinkedIn capture and outreach.
      </p>
      <ul className="space-y-2">
        {accounts?.map((a) => (
          <li key={a.id} className="flex items-center justify-between rounded-md border border-slate-200 px-4 py-2">
            <div>
              <div className="font-medium capitalize">{a.provider}</div>
              <div className="text-xs text-slate-500">{a.external_id || a.label}</div>
            </div>
            <button className="rounded p-1 text-slate-400 hover:text-rose-500" onClick={() => remove.mutate(a.id)}>
              <Trash2 className="h-4 w-4" />
            </button>
          </li>
        ))}
        {accounts?.length === 0 && <li className="text-sm text-slate-500">No accounts connected yet.</li>}
      </ul>
    </div>
  );
}
