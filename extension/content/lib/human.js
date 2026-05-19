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
  };
})();
