"use client";

import { useAuth } from "@/lib/auth";
import { initials } from "@/lib/utils";

export default function ProfileSettingsPage() {
  const { user, logout } = useAuth();
  return (
    <div className="card max-w-3xl p-6">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold">Profile</h2>
        <button className="text-sm text-brand-600 hover:underline" onClick={logout}>
          Log Out
        </button>
      </div>
      <div className="mt-6 flex items-start gap-6">
        <div className="grid h-16 w-16 place-items-center rounded-md bg-slate-100 text-base font-semibold uppercase">
          {initials(user?.first_name || user?.email)}
        </div>
        <div className="grid w-full grid-cols-2 gap-4 text-sm">
          <Field label="First name" value={user?.first_name || ""} />
          <Field label="Last name" value={user?.last_name || ""} />
          <Field label="Email" value={user?.email || ""} disabled />
        </div>
      </div>
    </div>
  );
}

function Field({ label, value, disabled }: { label: string; value: string; disabled?: boolean }) {
  return (
    <div>
      <label className="label">{label}</label>
      <input className="input" defaultValue={value} disabled={disabled} />
    </div>
  );
}
