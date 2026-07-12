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
  "https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200&display=swap",
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
