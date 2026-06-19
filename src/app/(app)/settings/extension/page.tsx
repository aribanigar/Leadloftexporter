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
    version: "1.0.277",
    date: "Jun 19, 2026",
    size: "245 KB",
    file: "/extensions/leadcaptura-extension-v1.0.277.zip",
    latest: true,
    changes: [
      "Autopilot enrichment back to v1.0.267 timing. v1.0.276 introduced a visibility-aware retry (5×700ms in background tabs) that pushed the per-tab end-to-end too close to the maybeRunEnrichmentTrigger 18s safety timer — the autopilot tab was being force-closed before Api.syncProfile finished, so profiles opened in the background but never reached the CRM. Reverted to 3×350ms unconditionally (byte-for-byte v1.0.267 background-tab budget) so the safety timer always has comfortable headroom.",
      "Backend CRM overwrite for location/avatar/company kept (v1.0.276) so re-saves still reflect the canonical /in/ scrape.",
    ],
  },
  {
    version: "1.0.276",
    date: "Jun 19, 2026",
    size: "245 KB",
    file: "/extensions/leadcaptura-extension-v1.0.276.zip",
    changes: [
      "(superseded by v1.0.277 — visibility-aware retry was over-budgeting the autopilot enrichment tab and tripping its safety timer)",
    ],
  },
  {
    version: "1.0.275",
    date: "Jun 19, 2026",
    size: "245 KB",
    file: "/extensions/leadcaptura-extension-v1.0.275.zip",
    changes: [
      "Reading profile now always re-scrapes name + title + company name from the canonical /in/<handle> page DOM and OVERRIDES whatever the side-panel had captured (often a partial card-level scrape that missed those three). Email/phone/location/website behaviour unchanged. One-block change to saveCurrentProfile Step 1; everything else remains v1.0.267-baseline + v1.0.274's retry-loop fix.",
    ],
  },
  {
    version: "1.0.274",
    date: "Jun 19, 2026",
    size: "245 KB",
    file: "/extensions/leadcaptura-extension-v1.0.274.zip",
    changes: [
      "Reverted to v1.0.267 behaviour (the good autopilot baseline) and applied a single-line fix for the rare skipping of email/phone/website/location. Root cause was one early-exit inside scrapeContactInfo's retry loop: 'if (data.email || data.phone) break;' was firing the moment EITHER field appeared, before LinkedIn had a chance to render website + address in its next React tick. Removed that line so the loop now always runs all 3 retries unless every field is already populated. No other behavioural changes — autopilot, the avatar filter, headline scraping, the modal close timing all match v1.0.267 exactly.",
    ],
  },
  {
    version: "1.0.273",
    date: "Jun 19, 2026",
    size: "247 KB",
    file: "/extensions/leadcaptura-extension-v1.0.273.zip",
    changes: [
      "(superseded by v1.0.274 — reverted to v1.0.267 baseline)",
    ],
  },
  {
    version: "1.0.272",
    date: "Jun 19, 2026",
    size: "247 KB",
    file: "/extensions/leadcaptura-extension-v1.0.272.zip",
    changes: [
      "Message All — conversation bubbles now reliably close after each send instead of stacking up. Root cause: _closeMsgOverlay targeted specific class names (.msg-overlay-conversation-bubble) that LinkedIn rotates every few quarters. When the class name changed, the close button query returned zero matches, the bubble stayed open, and the next iteration opened a SECOND bubble alongside it.",
      "Replaced the class-based selector with a semantic aria-label match ('Close your conversation with <Name>') plus a broad structural fallback (any container near the viewport's bottom-right whose class contains 'msg-overlay' / 'conversation-bubble' / 'messaging-bubble'). This survives LinkedIn renaming the bubble container.",
      "Added _closeMsgOverlayAndVerify: re-calls the close every 400ms until the bubbles are actually gone from the DOM (cap 3.5s). Wired into both the post-send teardown AND the pre-next-iteration setup, so stacking is impossible.",
    ],
  },
  {
    version: "1.0.271",
    date: "Jun 19, 2026",
    size: "246 KB",
    file: "/extensions/leadcaptura-extension-v1.0.271.zip",
    changes: [
      "Save Lead now reliably captures title/position + company name (in addition to email/phone/location/website that v1.0.269 fixed). Root cause: Step 1 only filled MISSING fields — if the side panel had pre-populated stale values from before LinkedIn finished hydrating the top card, the fresh scrape never overrode them. Also, no re-scrape was ever done AFTER the contact modal closed, so late-hydrated headlines stayed lost.",
      "Step 1 now waits for the h1 to stabilise (≤1.5s) before scraping, and always prefers the canonical /in/ page values for name/headline/title/company.",
      "Added a second-pass profile re-scrape after the contact modal closes and the URL is restored — catches headlines that LinkedIn streamed in late.",
      "Snapshot now also pins headline/title/company across the modal pushState so a /overlay/contact-info detour can never wipe them.",
      "Added LinkedIn-2026 headline selectors (.text-body-medium.break-words, data-anonymize='headline', etc.) so the scraper finds the headline even when it's NOT a direct sibling of <h1>.",
    ],
  },
  {
    version: "1.0.270",
    date: "Jun 19, 2026",
    size: "246 KB",
    file: "/extensions/leadcaptura-extension-v1.0.270.zip",
    changes: [
      "Per-card Save background-enrichment tab now stays open ~1.5–2.2s after the data has been captured + synced (was 80–200ms). Previous timing felt like a glitch — the tab flashed open and closed before the user could see the profile had loaded. Safety cap is still 18s.",
    ],
  },
  {
    version: "1.0.269",
    date: "Jun 19, 2026",
    size: "245 KB",
    file: "/extensions/leadcaptura-extension-v1.0.269.zip",
    changes: [
      "Save Lead now reliably captures email, phone, website and location. Root cause: the contact-info modal retry loop bailed the moment email OR phone appeared, but LinkedIn renders website + address blocks in a separate React tick 0.5–3s later, so those fields were dropped most of the time.",
      "Fixed by replacing the early-exit with a stability check (keep re-reading until two consecutive polls return no new fields, or all four fields are captured), and increasing the timing budget: modal-find 3s → 5s, initial settle 400ms → 700ms, retry sleep 350ms → 500ms, retry attempts 3 → 6.",
      "Added a 300ms settle before the modal closes so it no longer visually slams shut and the user briefly sees what was captured.",
      "New coral/pink LC icon (was blue/purple LL) so it stops visually clashing with the JobsAutoApply extension in the Chrome toolbar.",
    ],
  },
  {
    version: "1.0.267",
    date: "Jun 16, 2026",
    size: "247 KB",
    file: "/extensions/leadcaptura-extension-v1.0.267.zip",
    changes: [
      "Sales Nav spotlights now use a brand-new, fully isolated spotlight (own IDs, own state, own teardown) so nothing in the LinkedIn spotlight pipeline can interfere with it. Banner + ring + bouncing arrow at top z-index, visible for 2 seconds with a centred top banner that ALWAYS appears (even if the target rect resolves to 0×0).",
      "Both Connect (step 3) and Send Invitation (step 5) now use the new spotlight. Wait extended to 1300ms so you have time to see it before the click lands.",
      "Regular LinkedIn invitation flow is byte-identical — uses the original _showButtonSpotlight / _showSendSpotlight / _removeSpotlight pipeline unchanged.",
    ],
  },
  {
    version: "1.0.266",
    date: "Jun 16, 2026",
    size: "247 KB",
    file: "/extensions/leadcaptura-extension-v1.0.266.zip",
    changes: [
      "Sales Navigator Connect All — spotlights now reliably fall on the Send Invitation button. Step 5 now finds the Send Invitation button INSIDE the SN modal (exact text match, then Artdeco primary fallback), and spotlights it with the same direct-anchor variant that worked on the Connect dropdown item. The previous _showSendSpotlight depended on _findSendWithoutNoteButton, which could miss the SN button and leave the spotlight invisible.",
      "Same click sequence (dispatchHumanClick → _forceClick → main-world) — no behaviour change for the regular LinkedIn invitation flow, which still uses _findSendWithoutNoteButton + _showSendSpotlight as before.",
    ],
  },
  {
    version: "1.0.265",
    date: "Jun 16, 2026",
    size: "247 KB",
    file: "/extensions/leadcaptura-extension-v1.0.265.zip",
    changes: [
      "Sales Navigator Connect All fixed. The run was showing “Connect All: 0 invited, 0 skipped, 14 failed (14)” because the invitation-modal detector matched only regular LinkedIn phrasing (“add a note to your invitation”, “send without a note”, “personalize your invitation”) — none of which appear in the Sales Nav modal, which says “Send invitation” + “Include a personal message”.",
      "Added a Sales-Nav-only structural branch to the modal detector (requires BOTH “include a personal message” AND “send invitation”), so the regular LinkedIn path is byte-for-byte unchanged. The existing spotlight + “…” → Connect → Send Invitation sequence now completes end-to-end.",
    ],
  },
  {
    version: "1.0.258",
    date: "Jun 15, 2026",
    size: "242 KB",
    file: "/extensions/leadcaptura-extension-v1.0.258.zip",
    changes: [
      "ROOT CAUSE FIX. The background popup-killer was closing the Easy Apply modal itself on every step past page 1 — because it kept the modal alive only when its text matched “Contact info / next step / review / submit”, but steps 2-6 say “Home address”, “Resume”, “Additional questions”, “Education”, etc. So at step 2 the modal got dismissed; my code skipped; the click bled to the On-site chip.",
      "Easy Apply detection is now STRUCTURAL: dialog has aria-labelledby=\"jobs-apply-header\", or data-test-modal-id=\"easy-apply-modal\", or contains a data-easy-apply-* button, or its heading starts with “Apply to ”, or it contains the progress region. None of those depend on step content.",
      "Next / Review / Submit finders now fall back to text/aria matching scoped to the Easy Apply dialog if LinkedIn changes data-attributes.",
      "applyFormPresent() uses the same structural check so it stays true on every step.",
    ],
  },
  {
    version: "1.0.257",
    date: "Jun 15, 2026",
    size: "241 KB",
    file: "/extensions/leadcaptura-extension-v1.0.257.zip",
    changes: [
      "Mass Apply now hides the per-card Auto Apply chips while it's running, so no stray chip floats next to the LinkedIn modals.",
      "A background watcher dismisses the Preferences-match / feedback / premium upsell popups every 250ms — they can't linger anymore.",
      "Stray-popup dismissal uses the heavy 5-strategy click (React fiber included), so the X actually fires on React-driven LinkedIn dialogs.",
    ],
  },
  {
    version: "1.0.256",
    date: "Jun 15, 2026",
    size: "240 KB",
    file: "/extensions/leadcaptura-extension-v1.0.256.zip",
    changes: [
      "Mass Apply now visibly SPOTLIGHTS the button it's about to click — Easy Apply, Next, Review, Submit — with a pulsing blue outline + glow so you can see exactly what the engine is targeting.",
      "No more timer between jobs. Mass Apply runs continuously: finishes one application, sweeps stray popups, immediately starts the next.",
      "Stray LinkedIn popups (Preferences match, feedback, premium upsell) are dismissed at the start of every step, while waiting for the form to mount, and before every advance click — they can't deflect Next anymore.",
      "Removed the card re-click fallback. If Easy Apply isn't in the right pane after the poll, the job is skipped cleanly — preventing accidental clicks on On-site / Full-time chips or other detail-pane controls.",
    ],
  },
  {
    version: "1.0.255",
    date: "Jun 15, 2026",
    size: "239 KB",
    file: "/extensions/leadcaptura-extension-v1.0.255.zip",
    changes: [
      "Mass Apply skips “No longer accepting applications” jobs immediately, before LinkedIn can swap the apply form for the Preferences-match modal.",
      "Stray LinkedIn popups (Preferences match / feedback / premium upsell) are dismissed continuously — at the start of each job, while waiting for the apply form to mount, and again between jobs.",
      "Smarter autofill: a built-in Apply Profile maps question labels (years of experience, notice period, expected/current salary, willingness to relocate, work authorisation, sponsorship, LinkedIn/portfolio URLs, etc.) to sensible answers. Customise by storing chrome.storage.local[\"lc_apply_profile\"] = { ... }.",
      "Select dropdowns now match Apply Profile answers when the label fits, before falling back to the generic Yes default.",
    ],
  },
  {
    version: "1.0.254",
    date: "Jun 15, 2026",
    size: "238 KB",
    file: "/extensions/leadcaptura-extension-v1.0.254.zip",
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
