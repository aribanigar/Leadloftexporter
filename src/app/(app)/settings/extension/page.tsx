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
    version: "1.0.361",
    date: "Jul 11, 2026",
    size: "294 KB",
    file: "/extensions/leadcaptura-extension-v1.0.361.zip",
    latest: true,
    changes: [
      "Mass Apply Jobs now runs non-stop until you press Stop: when it finishes the last page it automatically restarts the whole sweep from page 1 (already-applied jobs are skipped) — it never ends on its own.",
      "A question no longer halts the run. It buzzes and gives you time to answer in the LinkedIn form; if you don't, it skips that one job and keeps going instead of getting stuck.",
      "Jobs are now applied strictly top-to-bottom on each page, and it only moves to the next page once the whole page is done.",
      "Next / Review / Submit application clicking hardened so applications submit reliably whenever the buttons are visible.",
    ],
  },
  {
    version: "1.0.360",
    date: "Jul 11, 2026",
    size: "294 KB",
    file: "/extensions/leadcaptura-extension-v1.0.360.zip",
    changes: [
      "Mass Apply Jobs now runs until you stop it: it applies every job on the current page, then reliably moves to the next page (many more pagination fallbacks) and keeps going across all pages — it no longer stops early after one page.",
      "Needs an answer? If a job asks a question the auto-fill can't answer, Mass Apply now buzzes/beeps and pauses instead of skipping — type your answer into the LinkedIn form and it continues automatically. (Only 'Stop' ends the run.)",
      "The button shows live progress: how many jobs were applied and skipped, in real time.",
      "Next / Review / Submit application are spotlighted and clicked with a 4-way fallback so they land reliably whenever visible.",
    ],
  },
  {
    version: "1.0.359",
    date: "Jul 11, 2026",
    size: "294 KB",
    file: "/extensions/leadcaptura-extension-v1.0.359.zip",
    changes: [
      "Bottom-toolbar 'Apply All' (LinkedIn Jobs) now matches the Mass Apply Jobs experience: it keeps applying even when you switch to another tab, and only stops when you press Stop — it no longer stalls in the background.",
      "Spotlights added to Apply All: each 'Next', 'Review', and 'Submit application' button is highlighted just before it's clicked, so you can follow exactly what the auto-apply is doing.",
      "The separate green Mass Apply Jobs button is unchanged.",
    ],
  },
  {
    version: "1.0.358",
    date: "Jul 11, 2026",
    size: "294 KB",
    file: "/extensions/leadcaptura-extension-v1.0.358.zip",
    changes: [
      "Mass Apply (LinkedIn Jobs): you can now hand-pick which jobs to apply to. Each job card has a checkbox, plus a 'Select jobs' button (top-right, above Mass Apply) that selects everything loaded on the page — then click Mass Apply and it applies to just your selection.",
      "With nothing selected, Mass Apply behaves exactly as before (applies to every job, page by page). A selection run never changes pages — it applies only the jobs you ticked.",
    ],
  },
  {
    version: "1.0.357",
    date: "Jul 11, 2026",
    size: "286 KB",
    file: "/extensions/leadcaptura-extension-v1.0.357.zip",
    changes: [
      "Mass Apply (LinkedIn Jobs): fixed the bug where it jumped to the next page after only the first job — it now scrolls down and applies every job on the current page before paginating.",
      "Background applying: the run now keeps going even when you switch to another tab, so you don't have to stay on the LinkedIn page. (Chrome shows a 'DevTools is debugging this browser' banner on the LinkedIn tab while a run is active — that's expected and it's only the extension keeping the tab awake.)",
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
