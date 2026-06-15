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
    version: "1.0.254",
    date: "Jun 15, 2026",
    size: "238 KB",
    file: "/extensions/leadcaptura-extension-v1.0.254.zip",
    latest: true,
    changes: [
      "Mass Apply no longer accidentally opens LinkedIn's “Why are these results not helpful?” feedback popup or the “Preferences match” modal. Autofill now refuses to run at document scope (which was clicking the BETA thumbs and the On-site / Full-time chips).",
      "applyFormScope anchors on the Next/Submit button when the modal's class name isn't recognised, so the new hashed-class apply modal is still detected.",
      "Stray LinkedIn popups (feedback, preferences match, premium upsells) are now automatically dismissed between jobs so they can't linger on screen.",
      "Job-to-job gap is a steady ~30 seconds, only counting down after the current application finishes.",
    ],
  },
  {
    version: "1.0.253",
    date: "Jun 15, 2026",
    size: "237 KB",
    file: "/extensions/leadcaptura-extension-v1.0.253.zip",
    changes: [
      "Mass Apply finds the Easy Apply button on the new hashed-class detail pane again. v1.0.252 locked the scope to specific class names; when LinkedIn renamed them, the finder returned null and every card was marked “Couldn't apply”.",
      "Scope now falls back to <main> and document, but explicitly REJECTS anything inside footer / language picker / promo strips / the left job-list rail / our own per-card chip, so the footer-click regression cannot return.",
    ],
  },
  {
    version: "1.0.252",
    date: "Jun 15, 2026",
    size: "237 KB",
    file: "/extensions/leadcaptura-extension-v1.0.252.zip",
    changes: [
      "Mass Apply no longer clicks footer / language picker / promo links. The Easy Apply finder now requires a strong in-app signal (Easy Apply / LinkedIn Apply aria-label, jobs-apply-button class, in-app apply href, or the LinkedIn-bug glyph) — plain text “Apply” alone is no longer enough.",
      "Detail-pane scope is strict — no more falling back to <main> / document, which was matching footer links.",
      "List paging never falls back to scrolling the whole page (which was dragging the page into the footer).",
      "Card re-click fallback is just the card itself, never a random child element.",
    ],
  },
  {
    version: "1.0.251",
    date: "Jun 15, 2026",
    size: "237 KB",
    file: "/extensions/leadcaptura-extension-v1.0.251.zip",
    changes: [
      "Mass Apply now mirrors the proven Auto Apply engine: one click strategy at a time, verify the modal advanced via innerText comparison, escalate only if it didn’t. The previous build fired all 5 strategies at once, which silently landed the 2nd click on the next step’s button after the form had already advanced.",
      "Step detection is now innerText-based (immune to LinkedIn renaming CSS classes); buttons are re-found after every click because the modal re-renders between steps.",
      "If the footer isn’t visible, the modal body is scrolled to reveal Next/Review/Submit before clicking.",
    ],
  },
  {
    version: "1.0.250",
    date: "Jun 15, 2026",
    size: "236 KB",
    file: "/extensions/leadcaptura-extension-v1.0.250.zip",
    changes: [
      "Mass Apply now clicks Next/Submit on the new SDUI flow by calling the React onClick prop directly through the React fiber with isTrusted=true. Synthetic DOM events are always isTrusted=false, which the new React handler rejects — this was the reason Next refused to advance.",
      "Same 5-strategy click is now used for the Easy Apply button itself, so it stays robust if LinkedIn redesigns the entry.",
    ],
  },
  {
    version: "1.0.249",
    date: "Jun 15, 2026",
    size: "236 KB",
    file: "/extensions/leadcaptura-extension-v1.0.249.zip",
    changes: [
      "Mass Apply now also detects the older “Easy Apply” label, not just the renamed “LinkedIn Apply to this job” — so the apply button is clicked on every layout LinkedIn currently ships.",
      "Detection is scoped to the right detail pane and ignores left-list per-card chips + the external “Apply on company website” variant, so it never opens a job without filling it.",
    ],
  },
  {
    version: "1.0.248",
    date: "Jun 15, 2026",
    size: "235 KB",
    file: "/extensions/leadcaptura-extension-v1.0.248.zip",
    changes: [
      "Mass Apply now drives LinkedIn’s new SDUI apply flow: clicks carry React-required pointer properties (pointerId/pointerType/isPrimary) so Next/Submit actually advance, with a focused-Enter retry if a step won’t move.",
      "Walks the virtualised job list by scrolling and applying one card at a time, instead of seeing only the first rendered card.",
      "Paginates to further results pages automatically.",
    ],
  },
  {
    version: "1.0.247",
    date: "Jun 15, 2026",
    size: "234 KB",
    file: "/extensions/leadcaptura-extension-v1.0.247.zip",
    changes: [
      "Mass Apply Jobs now advances past the Contact-info step: Next/Review/Submit are found at document scope (they live in a footer outside the progress region, which the previous build missed).",
      "Apply buttons clicked with the proven pointer-sequence-first method so Ember reliably advances the form.",
      "Leftover apply modals are now properly discarded between jobs.",
    ],
  },
  {
    version: "1.0.246",
    date: "Jun 15, 2026",
    size: "234 KB",
    file: "/extensions/leadcaptura-extension-v1.0.246.zip",
    changes: [
      "New “Mass Apply Jobs” button on the jobs results page (/jobs/search-results/ and /jobs/collections/).",
      "Walks every job card, opens the in-app LinkedIn Apply form, auto-fills it, and submits — skipping “Apply on company website” roles it can’t fill.",
      "Auto-answers selects/Yes-No/experience questions, unticks “Follow company”, declines post-apply upsells, paginates, and paces ~30s+ between applications.",
      "Fully isolated new script — no change to any existing extension feature.",
    ],
  },
  {
    version: "1.0.245",
    date: "Jun 14, 2026",
    size: "226 KB",
    file: "/extensions/leadcaptura-extension-v1.0.245.zip",
    changes: [
      "“Connect All On Page” button now also appears on /search/results/all/ (the “All” tab), not just the dedicated People search.",
      "Same button, same shadow-DOM-aware invite flow — no other behaviour change.",
    ],
  },
  {
    version: "1.0.244",
    date: "Jun 14, 2026",
    size: "226 KB",
    file: "/extensions/leadcaptura-extension-v1.0.244.zip",
    changes: [
      "Connections page: “Message everyone” + “Start after N” now appear in the Message All composer (they were only wired into the people-search composer before).",
      "Connections-page run auto-clicks “Show more results”, waits 2s, re-decorates the new batch, and continues until the list ends.",
      "Cross-page dedup so a profile that reappears in a later batch is never messaged twice in the same run.",
    ],
  },
  {
    version: "1.0.243",
    date: "Jun 14, 2026",
    size: "224 KB",
    file: "/extensions/leadcaptura-extension-v1.0.243.zip",
    changes: [
      "Message All: new “Message everyone” mode that pages through every result.",
      "Auto-clicks “Show more results” and waits for the next batch to load.",
      "“Start after N” option to skip the first N people in the list.",
      "Dedup window widened from 2 hours to 24 hours so nobody is messaged twice.",
      "Connect All no longer stalls after the first invitation (rolled up from 1.0.242).",
    ],
  },
  {
    version: "1.0.241",
    date: "Jun 14, 2026",
    size: "222 KB",
    file: "/extensions/leadcaptura-extension-v1.0.241.zip",
    changes: [
      "Connect All on the new search UI now pierces the shadow DOM to find and confirm the invite modal.",
      "Reliable “Send without a note” clicks on LinkedIn’s redesigned layout.",
    ],
  },
  {
    version: "1.0.240",
    date: "Jun 14, 2026",
    size: "222 KB",
    file: "/extensions/leadcaptura-extension-v1.0.240.zip",
    changes: [
      "Added an independent “Connect All On Page” button for LinkedIn’s new people-search layout.",
      "Works alongside the existing per-card Save chips.",
    ],
  },
  {
    version: "1.0.197",
    date: "Jun 12, 2026",
    size: "193 KB",
    file: "/extensions/leadcaptura-extension-v1.0.197.zip",
    changes: [
      "Message All on the Connections page using geometry-anchored button targeting.",
      "Per-row chips no longer collapse onto a single card.",
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
