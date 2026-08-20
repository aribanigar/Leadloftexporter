"use client";

import { Download, Chrome, Puzzle, RefreshCw, CheckCircle2, Sparkles, History, KeyRound } from "lucide-react";

/**
 * Extension release catalogue — newest first. To publish a new build:
 *   1. run  npm run build:extension  (produces the PROTECTED extension-dist/)
 *   2. zip extension-dist as  public/extensions/leadcaptura-extension-v<ver>.zip
 *      (top folder "extension") and refresh  public/leadcaptura-extension.zip
 *   3. prepend a new entry here (set `latest: true`, clear it on the old one)
 *
 * The published zip is ALWAYS the protected build (minified + comment-stripped +
 * local-name-mangled) so the extension can be handed out at scale without
 * shipping copyable source. The readable source lives only in `extension/` in
 * the repo — the admin's open copy, never published.
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
    version: "1.0.383",
    date: "Aug 20, 2026",
    size: "148 KB",
    file: "/extensions/leadcaptura-extension-v1.0.383.zip",
    latest: true,
    changes: [
      "Removed the baked-in default API key. Every fresh install used to fall back to one specific account's key until you pasted your own, which meant it silently captured into THAT account's workspace instead of yours — with no visible sign anything was wrong. There's no shared default anymore: installs still on the old key are automatically reset to \"not connected\" on this update, and everyone now gets their own API key + license key from their admin (Settings → License Keys → \"Invite a new user\" or \"Grant access\").",
    ],
  },
  {
    version: "1.0.382",
    date: "Aug 20, 2026",
    size: "148 KB",
    file: "/extensions/leadcaptura-extension-v1.0.382.zip",
    changes: [
      "Fixed a phone-number bug: profiles located in Russia, Ukraine, Austria, Australia, or Mauritius could get the wrong country dial code silently prepended (e.g. a Moscow number tagged +1 instead of +7), because the short \"us\"/\"uk\" abbreviations matched as substrings of those country names before the real country entry got a chance to.",
      "Fixed conversations opened later in an already-open LinkedIn Messaging tab not syncing to the CRM — only conversations open at page load were being captured before.",
    ],
  },
  {
    version: "1.0.381",
    date: "Aug 20, 2026",
    size: "145 KB",
    file: "/extensions/leadcaptura-extension-v1.0.381.zip",
    changes: [
      "Moved the default backend off leadloftexporter-1.onrender.com (suspended by its owner on Render, which is why sends/captures could silently stop working) to leadloftexporter.onrender.com. Existing installs migrate automatically on update — nothing to do unless you'd manually set a custom Backend URL in Options.",
    ],
  },
  {
    version: "1.0.380",
    date: "Aug 14, 2026",
    size: "145 KB",
    file: "/extensions/leadcaptura-extension-v1.0.380.zip",
    changes: [
      "Added license-key activation. The extension now needs a license key — issued by your admin in Settings → License Keys — in addition to your personal API key before it will connect. Open the extension's Options and paste both in; the Download/Options screen tells you exactly which one is missing or invalid if either is wrong, revoked, or expired.",
      "Admins: generate, label, assign, expire, revoke, reset, or delete license keys per person from the new Settings → License Keys page — a person's captured leads still save to their own account via their own API key exactly as before; the license key is just the on/off switch you control.",
    ],
  },
  {
    version: "1.0.379",
    date: "Aug 12, 2026",
    size: "145 KB",
    file: "/extensions/leadcaptura-extension-v1.0.379.zip",
    changes: [
      "Fixed background-enrichment tabs silently losing their anti-throttle shim on LinkedIn — LinkedIn tightened its Content-Security-Policy to block the inline script this used, so it stopped running (visible as a CSP error in chrome://extensions) and Contact Info fields could come back blank. It now runs natively in the page's own JS context via Chrome's MAIN-world content script support, which the page's script policy can't block, so background enrichment works reliably again.",
    ],
  },
  {
    version: "1.0.378",
    date: "Aug 12, 2026",
    size: "145 KB",
    file: "/extensions/leadcaptura-extension-v1.0.378.zip",
    changes: [
      "Fixed the in-popup “Download update” button sometimes opening a broken link. The popup checks for updates twice — an instant offline check from a cached result, then a live check against the server — and a stale cached result from before the newest release was published could permanently lock the Download button to an older zip that's no longer published, so clicking it 404'd. The button now always reflects the freshest check.",
      "Older versions in the list below are no longer individually downloadable — only the single most recent build is kept published, so grab the latest one above when updating.",
    ],
  },
  {
    version: "1.0.377",
    date: "Aug 12, 2026",
    size: "145 KB",
    file: "/extensions/leadcaptura-extension-v1.0.377.zip",
    changes: [
      "Fixed the remaining cause of Mass Apply Jobs skipping the Submit application click — the newer single-page “review” style apply forms (Resume + Additional Questions already answered, one Submit button at the bottom, no separate Next/Review steps). When Submit sat below the fold, the click was computed before the button actually scrolled into view, so it could land in the wrong place. The engine now scrolls Next, Review and Submit into view before every click, so it lands exactly where it should and the run moves from job to job smoothly, like a proper SaaS tool should.",
    ],
  },
  {
    version: "1.0.376",
    date: "Jul 31, 2026",
    size: "145 KB",
    file: "/extensions/leadcaptura-extension-v1.0.376.zip",
    changes: [
      "Fixed Mass Apply Jobs sometimes skipping the real submit on the final step and moving straight to the next job. The last-step Submit click was judged the same way as Next/Review clicks (“did the text on screen change?”) — but a validation error on that final step also changes the text, so a failed submission could be mistaken for a successful one. It now only counts a job as applied once the Easy Apply form is genuinely gone; if something on the last step still needs you, it buzzes and waits, like it already does mid-form, instead of quietly moving on.",
      "This makes the whole run more trustworthy end-to-end: what the extension reports as “applied” now matches what actually went out on LinkedIn.",
    ],
  },
  {
    version: "1.0.375",
    date: "Jul 30, 2026",
    size: "145 KB",
    file: "/extensions/leadcaptura-extension-v1.0.375.zip",
    changes: [
      "Smarter memory, shared across BOTH apply buttons. “Mass Apply Jobs” now also answers RE-WORDED but equivalent questions from memory — e.g. it recalls your answer to “Notice period” when a job asks “What’s your notice period?” — without asking again, while carefully never borrowing an answer from a genuinely different question (so “years of experience in sales” won’t reuse your “…in marketing” answer).",
      "“Apply All” now reads the same shared saved-profile mapping + learned memory + fuzzy recall that “Mass Apply Jobs” uses, so both buttons fill and answer identically. Everything you save in Options — name (first/last), email, phone, nationality, city, country, job title, years, education, notice/availability, languages, salary, work authorization, sponsorship, relocation, visa status, driving licence, work mode, gender, links — auto-fills the matching questions.",
      "Anything the profile can’t answer is learned the first time you answer it and reused next time. “Reset learned answers” + a live count live in Options. Protected package.",
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
    icon: KeyRound,
    title: "Activate",
    body: "Click the LeadCaptura icon → Options, then paste your personal API key (Settings → API Keys, below) and the license key your admin gave you (Settings → License Keys — admins only). The extension won't connect until both are in.",
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
                {r.latest ? (
                  <a
                    href={r.file}
                    download
                    className="btn-primary shrink-0 self-start px-4 py-2 text-sm"
                  >
                    <Download className="h-4 w-4" />
                    Download
                  </a>
                ) : (
                  <span
                    className="shrink-0 self-start px-1 text-xs text-slate-400"
                    title="Older builds aren't kept published — grab the latest version above instead."
                  >
                    Superseded
                  </span>
                )}
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
