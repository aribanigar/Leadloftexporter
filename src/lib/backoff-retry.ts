// Shared network-retry helper for auth flows (login/register) that can hit a
// cold-starting Render backend. Only retries errors that LOOK like a
// transport failure (timeout, fetch rejected, connection refused) — a 4xx
// business error (wrong password, invalid license key, email already in
// use) throws immediately so the caller can show it and stop.
export const RETRY_DELAYS_MS = [1000, 2000, 4000, 6000, 8000, 10000, 12000];
export const RETRY_MAX = RETRY_DELAYS_MS.length; // total attempts = RETRY_MAX + 1, ~43s of backoff

export function isNetworkErrorMessage(message: string): boolean {
  return /Failed to fetch|NetworkError|TypeError|Request timed out|fetch failed|networkerror/i.test(message);
}

export async function withNetworkRetry<T>(
  fn: () => Promise<T>,
  onAttempt?: (attempt: number, max: number) => void,
): Promise<T> {
  let attempt = 0;
  for (;;) {
    onAttempt?.(attempt, RETRY_MAX);
    try {
      return await fn();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (!isNetworkErrorMessage(message) || attempt >= RETRY_MAX) throw e;
      const wait = RETRY_DELAYS_MS[attempt] ?? 10000;
      await new Promise((r) => setTimeout(r, wait));
      attempt += 1;
    }
  }
}
