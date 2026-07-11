"use client";

import { Download, Chrome, Puzzle, RefreshCw, CheckCircle2, Sparkles, History } from "lucide-react";

/**
 * Extension release catalogue — newest first. To publish a new build:
 *   1. zip the extension into  public/extensions/leadcaptura-extension-v<ver>.zip
 *   2. prepend a new entry here (set `latest: true`, clear it on the old one)
 *   3. also refresh  public/leadcaptura-extension.zip  (the stable "latest" alias)
 */
type Release = {
  version: string;
  date: string;
  size: string;
  file: string;
  latest?: boolean;
  changes: string[];
};

const RELEASES: Release[] = [
  {
    version: "1.0.351",
    date: "Jul 11, 2026",
    size: "285 KB",
    file: "/extensions/leadcaptura-extension-v1.0.351.zip",
    latest: true,
    changes: [
      "Mass Apply (LinkedIn Jobs): added a per-card '⚡ Auto Apply' button on each job card, so you can apply to a single job on its own — it runs the exact same apply flow as the bulk run, just for that one card.",
      "Additive — the bulk run and apply logic are unchanged; the chip can't overlap a bulk run (they share one lock) and is hidden while any apply is in progress.",
    ],
  },
  {
    version: "1.0.350",
    date: "Jul 11, 2026",
    size: "285 KB",
    file: "/extensions/leadcaptura-extension-v1.0.350.zip",
    changes: [
      "Mass Apply (LinkedIn Jobs): more robust pagination. The engine already finishes every job on the current page before moving on; this adds a fallback so that, if the Next-page button isn't clickable, it advances via the numbered page indicators (Page 1 / Page 2 …) instead of stopping — and correctly stops on the last page.",
      "Additive — only the between-page step changed; per-job applying is untouched, and it never leaves a page before all its jobs are done.",
    ],
  },
  {
    version: "1.0.349",
    date: "Jul 11, 2026",
    size: "285 KB",
    file: "/extensions/leadcaptura-extension-v1.0.349.zip",
    changes: [
      "Mass Apply (LinkedIn Jobs): added a ~45-second human-pace wait between each job. LinkedIn now temporarily pauses 'LinkedIn Apply' when it detects a fast application pace — this gap keeps the run under that threshold so it isn't paused and your account isn't put at risk. A live countdown shows in the toolbar, and Stop is still instant.",
      "Additive — only the between-jobs gap changed; the apply flow itself is untouched.",
    ],
  },
];

const LATEST = RELEASES.find((r) => r.latest) ?? RELEASES[0];

const STEPS = [
  {
    icon: Download,
    title: "Download & unzip",
    body: "Download the version you want, then unzip it to a folder you'll keep — Chrome loads the extension from this folder, so don't delete it.",
  },
  {
    icon: Chrome,
    title: "Open Chrome extensions",
    body: "Go to chrome://extensions and turn on “Developer mode” using the toggle in the top-right corner.",
  },
  {
    icon: Puzzle,
    title: "Load unpacked",
    body: "Click “Load unpacked” and select the unzipped extension folder. LeadCaptura appears in your toolbar.",
  },
  {
    icon: RefreshCw,
    title: "Reload LinkedIn",
    body: "Hard-reload any open LinkedIn tab (Ctrl/Cmd + R). Chrome only injects the extension on a fresh page load.",
  },
  {
    icon: CheckCircle2,
    title: "Confirm it's live",
    body: `Check the bottom toolbar on LinkedIn shows the badge “LeadCaptura v${LATEST.version}”. An older number means the tab is still on stale code — reload again.`,
  },
];

export default function ExtensionPage() {
  return (
    <div className="max-w-3xl space-y-6">
      {/* Hero / latest download */}
      <div className="card overflow-hidden">
        <div className="gradient-brand px-6 py-6 text-white">
          <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-white/80">
            <Puzzle className="h-4 w-4" />
            Chrome Extension
          </div>
          <h2 className="mt-1 text-xl font-semibold">LeadCaptura for LinkedIn</h2>
          <p className="mt-1 max-w-xl text-sm text-white/85">
            Capture profiles, run human-paced Connect &amp; Message campaigns, and enrich contact
            info — all from inside your own browser.
          </p>
        </div>
        <div className="flex flex-col items-start gap-3 px-6 py-5 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-slate-800">Latest version</span>
              <span className="pill bg-emerald-50 text-emerald-700">
                <Sparkles className="h-3 w-3" /> v{LATEST.version}
              </span>
            </div>
            <div className="text-xs text-slate-500">
              Released {LATEST.date} · {LATEST.size}
            </div>
          </div>
          <a href={LATEST.file} download className="btn-primary px-5 py-2.5 text-sm">
            <Download className="h-4 w-4" />
            Download latest
          </a>
        </div>
      </div>

      {/* Version history (Java-style table of releases) */}
      <div className="card overflow-hidden">
        <div className="flex items-center gap-2 border-b border-slate-100 px-6 py-4">
          <History className="h-4 w-4 text-slate-400" />
          <h3 className="text-base font-semibold">All versions</h3>
        </div>
        <ul className="divide-y divide-slate-100">
          {RELEASES.map((r) => (
            <li key={r.version} className="px-6 py-5">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-sm font-semibold text-slate-800">
                      v{r.version}
                    </span>
                    {r.latest && (
                      <span className="pill bg-emerald-50 text-emerald-700">Latest</span>
                    )}
                    <span className="text-xs text-slate-400">
                      {r.date} · {r.size}
                    </span>
                  </div>
                  <div className="mt-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
                    What&apos;s new
                  </div>
                  <ul className="mt-1 space-y-1">
                    {r.changes.map((c, i) => (
                      <li key={i} className="flex gap-2 text-sm text-slate-600">
                        <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-brand-400" />
                        <span>{c}</span>
                      </li>
                    ))}
                  </ul>
                </div>
                <a
                  href={r.file}
                  download
                  className={
                    r.latest
                      ? "btn-primary shrink-0 self-start px-4 py-2 text-sm"
                      : "btn-secondary shrink-0 self-start px-4 py-2 text-sm"
                  }
                >
                  <Download className="h-4 w-4" />
                  Download
                </a>
              </div>
            </li>
          ))}
        </ul>
      </div>

      {/* Install instructions */}
      <div className="card p-6">
        <h3 className="mb-1 text-base font-semibold">How to install</h3>
        <p className="mb-5 text-sm text-slate-500">
          The extension isn&apos;t on the Chrome Web Store — install it manually in under a minute.
          Updating to a newer version is the same flow: download it, replace your old folder, then
          click the refresh icon on the LeadCaptura card in <span className="font-mono text-xs">chrome://extensions</span>.
        </p>
        <ol className="space-y-4">
          {STEPS.map((step, i) => {
            const Icon = step.icon;
            return (
              <li key={i} className="flex gap-4">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-50 text-brand-700">
                  <Icon className="h-4 w-4" />
                </div>
                <div className="pt-0.5">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-semibold text-slate-400">Step {i + 1}</span>
                    <span className="text-sm font-medium text-slate-800">{step.title}</span>
                  </div>
                  <p className="mt-0.5 text-sm text-slate-600">{step.body}</p>
                </div>
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}
