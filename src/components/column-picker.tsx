"use client";

import { X } from "lucide-react";
import { useState } from "react";
import type { LeadField } from "@/lib/types";

interface Props {
  fields: LeadField[];
  selected: string[];
  onClose: () => void;
  onSave: (cols: string[]) => void;
}

export function ColumnPicker({ fields, selected, onClose, onSave }: Props) {
  const [sel, setSel] = useState<Set<string>>(new Set(selected));

  function toggle(key: string) {
    const next = new Set(sel);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setSel(next);
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-slate-900/40 p-4">
      <div className="w-full max-w-md overflow-hidden rounded-xl bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3">
          <h2 className="font-semibold">Columns</h2>
          <button onClick={onClose} className="rounded p-1 hover:bg-slate-100">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="max-h-96 overflow-y-auto px-3 py-2">
          {fields.map((f) => (
            <label key={f.id} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-slate-50">
              <input type="checkbox" checked={sel.has(f.key)} onChange={() => toggle(f.key)} />
              <span>{f.label}</span>
              {f.is_system && (
                <span className="ml-auto text-[10px] uppercase tracking-wide text-slate-400">system</span>
              )}
            </label>
          ))}
        </div>
        <div className="flex justify-end gap-2 border-t border-slate-100 px-5 py-3">
          <button onClick={onClose} className="btn-secondary">
            Cancel
          </button>
          <button
            className="btn-primary"
            onClick={() => onSave(fields.filter((f) => sel.has(f.key)).map((f) => f.key))}
          >
            Apply
          </button>
        </div>
      </div>
    </div>
  );
}
