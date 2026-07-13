"use client";

import { useEffect } from "react";

/**
 * Loads the web fonts WITHOUT blocking first paint.
 *
 * These three Google Fonts stylesheets used to sit as render-blocking
 * <link rel="stylesheet"> in the root <head>, so the browser waited on a
 * round-trip to fonts.googleapis.com (and, for Material Symbols, a large
 * variable font) before painting anything — a real "slow to load" hit that
 * appeared when web fonts were introduced.
 *
 * Injecting them after mount makes them non-blocking: the page paints
 * immediately in the system fallback (Tailwind's `sans` falls back to
 * system-ui / -apple-system, which is visually close to Inter), then the real
 * fonts swap in (`display=swap`). The preconnect hints stay in the server
 * <head> so the fetch is fast when it does happen.
 */
const FONT_STYLESHEETS = [
  "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Manrope:wght@500;600;700;800&display=swap",
  // Only the FILL axis is ever varied in the app (filled vs outlined icons);
  // weight/optical-size/grade are always the defaults (wght 400, opsz 24,
  // GRAD 0). Requesting just FILL@0..1 keeps every icon (and both fill states)
  // working while serving a much smaller variable font than the full 4-axis
  // range that was requested before.
  "https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:FILL@0..1&display=swap",
];

export function DeferredFonts() {
  useEffect(() => {
    for (const href of FONT_STYLESHEETS) {
      if (document.querySelector(`link[data-lc-font="${href}"]`)) continue;
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = href;
      link.setAttribute("data-lc-font", href);
      document.head.appendChild(link);
    }
  }, []);

  return null;
}
