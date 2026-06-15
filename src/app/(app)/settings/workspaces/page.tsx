"use client";

import { useAuth } from "@/lib/auth";

export default function WorkspacesPage() {
  const { workspaces, workspace, switchWorkspace } = useAuth();
  return (
    <div className="card max-w-3xl p-6">
      <h2 className="mb-4 text-base font-semibold">Workspaces</h2>
      <ul className="space-y-2">
        {workspaces.map((w) => (
          <li key={w.id} className="flex items-center justify-between rounded-md border border-slate-200 px-4 py-2">
            <div>
              <div className="font-medium">{w.name}</div>
              <div className="text-xs text-slate-500 capitalize">{w.role}</div>
            </div>
            {w.id === workspace?.id ? (
              <span className="pill bg-brand-100 text-brand-700">Current</span>
            ) : (
              <button className="btn-secondary" onClick={() => switchWorkspace(w.id)}>
                Switch
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
