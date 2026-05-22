/* Human-paced timing primitives. The whole point is to look like a person who
 * happens to be on their LinkedIn tab, not a script. Every wait, scroll, and
 * typed character should have natural variance. */
(() => {
  if (globalThis.__lcHuman) return;

  function rand(min, max) {
    return Math.random() * (max - min) + min;
  }
  function randInt(min, max) {
    return Math.floor(rand(min, max + 1));
  }
  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }
  /** Idle delay between consequential LI actions (connect, message). */
  function paceBetweenActions() {
    // 45s - 180s with a long-tail toward 2-3 minutes
    const base = rand(45_000, 180_000);
    const longTail = Math.random() < 0.18 ? rand(60_000, 120_000) : 0;
    return base + longTail;
  }
  /** Small "I'm reading the page" pause. */
  function readingPause() {
    return rand(1_200, 3_500);
  }
  /** Typing pause between characters. */
  function typingPause() {
    return rand(40, 140);
  }
  async function scrollLikeHuman(stepPx = 320) {
    const start = window.scrollY;
    const end = start + stepPx + randInt(-40, 60);
    const dur = randInt(220, 600);
    const startT = performance.now();
    return new Promise((resolve) => {
      function step(t) {
        const p = Math.min(1, (t - startT) / dur);
        const eased = 1 - Math.pow(1 - p, 3);
        window.scrollTo({ top: start + (end - start) * eased });
        if (p < 1) requestAnimationFrame(step);
        else resolve();
      }
      requestAnimationFrame(step);
    });
  }
  /** Whether the tab is currently visible. We refuse to do automated actions
   * when the user has the tab in background — adds a hugely valuable signal of
   * authenticity and avoids tripping idle-detection. */
  function tabIsForeground() {
    return document.visibilityState === "visible";
  }
  async function waitUntilForeground(timeoutMs = 30 * 60_000) {
    if (tabIsForeground()) return true;
    return new Promise((resolve) => {
      const to = setTimeout(() => {
        document.removeEventListener("visibilitychange", onChange);
        resolve(false);
      }, timeoutMs);
      function onChange() {
        if (tabIsForeground()) {
          clearTimeout(to);
          document.removeEventListener("visibilitychange", onChange);
          resolve(true);
        }
      }
      document.addEventListener("visibilitychange", onChange);
    });
  }

  // Track the extension's simulated cursor position. Updated by real user
  // mousemove events AND by simulateCursorMove so consecutive automated moves
  // always start from a coherent "last known" position.
  const _cursorPos = {
    x: typeof window !== "undefined" ? Math.round(window.innerWidth / 2) : 400,
    y: typeof window !== "undefined" ? Math.round(window.innerHeight / 2) : 300,
  };
  if (typeof document !== "undefined") {
    document.addEventListener("mousemove", (e) => {
      _cursorPos.x = e.clientX;
      _cursorPos.y = e.clientY;
    }, { passive: true, capture: false });
  }

  // Simulate the cursor travelling from its last known position to `el` along a
  // slightly curved quadratic Bezier path. Dispatches mousemove events on
  // `document` so bot-detection scripts that listen globally see a plausible
  // trajectory instead of an instant teleport to the click point.
  async function simulateCursorMove(el, { steps = null, durationMs = null } = {}) {
    if (!el) return;
    try {
      const rect = el.getBoundingClientRect();
      if (!rect.width && !rect.height) return;
      // Land on a random point in the inner 40% of the element (not always center)
      const tx = rect.left + rect.width * (0.3 + Math.random() * 0.4);
      const ty = rect.top + rect.height * (0.3 + Math.random() * 0.4);
      const sx = _cursorPos.x;
      const sy = _cursorPos.y;
      const dist = Math.hypot(tx - sx, ty - sy);
      if (dist < 4) return;
      // Steps scale with distance (1 per ~20 px), capped 6–22
      const n = steps ?? Math.min(22, Math.max(6, Math.round(dist / 20)));
      // Duration: ~0.85 px/ms (typical mouse speed), capped 100–560 ms
      const ms = durationMs ?? Math.min(560, Math.max(100, dist / 0.85));
      // Bezier control point: slight random arc perpendicular to the travel line
      const cx = (sx + tx) / 2 + rand(-1, 1) * Math.min(60, dist * 0.25);
      const cy = (sy + ty) / 2 + rand(-1, 1) * Math.min(60, dist * 0.25);
      for (let i = 1; i <= n; i++) {
        // Ease-in-out: accelerate then decelerate near the target
        const t = i / n;
        const ease = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
        const bx = Math.round((1 - ease) ** 2 * sx + 2 * (1 - ease) * ease * cx + ease ** 2 * tx);
        const by = Math.round((1 - ease) ** 2 * sy + 2 * (1 - ease) * ease * cy + ease ** 2 * ty);
        document.dispatchEvent(new MouseEvent("mousemove", {
          bubbles: true, cancelable: false,
          clientX: bx, clientY: by,
          screenX: bx, screenY: by + (window.screenY || 0),
          view: window,
        }));
        _cursorPos.x = bx;
        _cursorPos.y = by;
        // Per-step delay with ±30% jitter so spacing is not perfectly uniform
        await sleep(Math.round((ms / n) * (0.7 + Math.random() * 0.6)));
      }
      _cursorPos.x = Math.round(tx);
      _cursorPos.y = Math.round(ty);
    } catch {
      // Never let cursor simulation break the caller
    }
  }

  globalThis.__lcHuman = {
    rand,
    randInt,
    sleep,
    paceBetweenActions,
    readingPause,
    typingPause,
    scrollLikeHuman,
    tabIsForeground,
    waitUntilForeground,
    simulateCursorMove,
  };
})();
