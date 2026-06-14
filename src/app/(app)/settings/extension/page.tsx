"use client";

import { Download, Chrome, Puzzle, RefreshCw, CheckCircle2 } from "lucide-react";

// Bump this in lockstep with extension/manifest.json whenever a new zip is
// committed to public/leadcaptura-extension.zip.
const EXTENSION_VERSION = "1.0.243";
const DOWNLOAD_URL = "/leadcaptura-extension.zip";

const STEPS = [
  {
    icon: Download,
    title: "Download the extension",
    body: "Click the button above to download leadcaptura-extension.zip, then unzip it to a folder you'll keep (don't delete it — Chrome loads the extension from this folder).",
  },
  {
    icon: Chrome,
    title: "Open Chrome extensions",
    body: "Go to chrome://extensions in your address bar and turn on \"Developer mode\" using the toggle in the top-right corner.",
  },
  {
    icon: Puzzle,
    title: "Load unpacked",
    body: "Click \"Load unpacked\" and select the unzipped extension folder. LeadCaptura will appear in your extensions list and toolbar.",
  },
  {
    icon: RefreshCw,
    title: "Reload your LinkedIn tab",
    body: "If you already had LinkedIn open, hard-reload it (Ctrl/Cmd + R). Chrome only injects the extension on a fresh page load.",
  },
  {
    icon: CheckCircle2,
    title: "Confirm it's live",
    body: `Open any LinkedIn page and check the bottom toolbar shows the badge "LeadCaptura v${EXTENSION_VERSION}". If it shows an older version, reload the tab again.`,
  },
];

export default function ExtensionPage() {
  return (
    <div className="max-w-3xl space-y-6">
      {/* Hero / download card */}
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
            <div className="text-sm font-medium text-slate-800">Latest version</div>
            <div className="font-mono text-sm text-slate-500">v{EXTENSION_VERSION}</div>
          </div>
          <a href={DOWNLOAD_URL} download className="btn-primary px-5 py-2.5 text-sm">
            <Download className="h-4 w-4" />
            Download extension (.zip)
          </a>
        </div>
      </div>

      {/* Install instructions */}
      <div className="card p-6">
        <h3 className="mb-1 text-base font-semibold">How to install</h3>
        <p className="mb-5 text-sm text-slate-500">
          The extension isn&apos;t on the Chrome Web Store — install it manually in under a minute.
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

      {/* Updating note */}
      <div className="card p-6">
        <h3 className="mb-1 text-base font-semibold">Updating to a new version</h3>
        <p className="text-sm text-slate-600">
          When a newer version is released, download the zip again, replace your old extension folder
          with the new one, then go to <span className="font-mono text-xs">chrome://extensions</span> and
          click the refresh icon on the LeadCaptura card. Finally, hard-reload any open LinkedIn tab so
          the new code is injected.
        </p>
      </div>
    </div>
  );
}
