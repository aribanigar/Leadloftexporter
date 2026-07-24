"use client";

// The backend base URL. NEXT_PUBLIC_API_URL is the configured/deployed value;
// the known production hosts below are automatic fallbacks so that a single
// dead or suspended Render service can never take login (or the whole app)
// down. See resolveBase() — we health-probe the candidates in parallel and use
// whichever is actually alive, then pin it for the session.
const CONFIGURED = (process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000").replace(/\/$/, "");

// Ordered candidate list. The configured URL is preferred (so normal deploys
// behave exactly as before); the two known Render hosts are resilience
// fallbacks. Deduped; localhost is dropped once any https backend is present so
// production never accidentally falls back to a dev URL.
const KNOWN_HOSTS = [
  "https://leadloftexporter.onrender.com",
  "https://leadloftexporter-1.onrender.com",
];
function candidateBases(): string[] {
  const raw = [CONFIGURED, ...KNOWN_HOSTS];
  const hasHttps = raw.some((b) => /^https:\/\//.test(b));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of raw) {
    const b = (r || "").replace(/\/$/, "");
    if (!b) continue;
    if (hasHttps && /localhost|127\.0\.0\.1/.test(b)) continue;
    if (seen.has(b)) continue;
    seen.add(b);
    out.push(b);
  }
  return out.length ? out : [CONFIGURED];
}

const HEALTHY_KEY = "lc_api_base";
let _healthyBase: string | null = null;
let _resolving: Promise<string> | null = null;

function cachedBase(): string | null {
  if (_healthyBase) return _healthyBase;
  if (typeof window !== "undefined") {
    try {
      const s = sessionStorage.getItem(HEALTHY_KEY);
      if (s) { _healthyBase = s; return s; }
    } catch { /* sessionStorage blocked */ }
  }
  return null;
}
function pinBase(b: string) {
  _healthyBase = b;
  try { if (typeof window !== "undefined") sessionStorage.setItem(HEALTHY_KEY, b); } catch { /* ignore */ }
}
function unpinBase() {
  _healthyBase = null;
  try { if (typeof window !== "undefined") sessionStorage.removeItem(HEALTHY_KEY); } catch { /* ignore */ }
}

// Probe one backend's /health with a short timeout. Resolves the base on a 2xx,
// rejects otherwise — so Promise.any() below latches onto the FIRST live host
// without waiting on the dead one (its fetch just times out in the background).
async function probeHealth(base: string, timeoutMs: number): Promise<string> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(base + "/health", { signal: ctrl.signal, cache: "no-store" });
    if (!res.ok) throw new Error("unhealthy");
    return base;
  } finally {
    clearTimeout(t);
  }
}

// Resolve a live backend base. Returns the pinned one instantly if we already
// found one; otherwise races every candidate's /health in parallel and pins the
// first that answers. If none answer, returns the configured URL so callers
// still surface a real, honest error instead of hanging on a guess.
async function resolveBase(): Promise<string> {
  const pinned = cachedBase();
  if (pinned) return pinned;
  if (_resolving) return _resolving;
  const bases = candidateBases();
  if (bases.length === 1) { pinBase(bases[0]); return bases[0]; }
  _resolving = (async () => {
    try {
      const winner = await Promise.any(bases.map((b) => probeHealth(b, 7000)));
      pinBase(winner);
      return winner;
    } catch {
      return bases[0]; // nothing healthy — fall back to configured
    } finally {
      _resolving = null;
    }
  })();
  return _resolving;
}

// Best-effort SYNCHRONOUS base for direct fetch()/URL building (CSV export,
// uploads). Returns the pinned healthy base if one was already found (it is,
// after the first api() call — e.g. the auth bootstrap on load), else the
// configured URL.
export function apiBase(): string {
  return cachedBase() || CONFIGURED;
}

// Warm the health race as soon as the client bundle loads, so by the time the
// user submits the login form a live backend is already pinned and the request
// is instant (no cold-start-looking stall against a dead service).
if (typeof window !== "undefined") {
  resolveBase().catch(() => { /* best-effort warm-up */ });
}

export class ApiError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, body: unknown, message?: string) {
    super(message || `API error ${status}`);
    this.status = status;
    this.body = body;
  }
}

interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  raw?: boolean;
}

export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem("lc_token");
}

export function getWorkspaceId(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem("lc_workspace_id");
}

export function setSession(token: string, workspaceId: string | null) {
  if (typeof window === "undefined") return;
  localStorage.setItem("lc_token", token);
  if (workspaceId) localStorage.setItem("lc_workspace_id", workspaceId);
}

export function clearSession() {
  if (typeof window === "undefined") return;
  localStorage.removeItem("lc_token");
  localStorage.removeItem("lc_workspace_id");
}

// Default request timeout — long enough to outlast a Render Free-tier
// cold-start (container spin-up is 30–60s on top of the Neon wake). 25s was
// too aggressive: the abort fired BEFORE the container was even ready, the
// retry then hit the same cold-start, and login appeared to hang forever on
// "Connecting…". Callers can pass their own `signal` to override.
const DEFAULT_TIMEOUT_MS = 90_000;

// A single fetch against `base` with its own timeout. Throws ApiError(0) on
// timeout, or the raw network error otherwise, so the caller can decide whether
// to fail over to another backend.
async function fetchOnce(
  base: string,
  path: string,
  method: string,
  headers: Record<string, string>,
  body: unknown,
  callerSignal?: AbortSignal,
): Promise<Response> {
  let signal = callerSignal;
  let timer: ReturnType<typeof setTimeout> | null = null;
  if (!signal) {
    const ctrl = new AbortController();
    signal = ctrl.signal;
    timer = setTimeout(() => ctrl.abort(), DEFAULT_TIMEOUT_MS);
  }
  try {
    return await fetch(`${base}/api/v1${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal,
    });
  } catch (e) {
    if ((e as Error)?.name === "AbortError") {
      throw new ApiError(0, null, "Request timed out — please try again.");
    }
    throw e;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function api<T = unknown>(path: string, opts: RequestOptions = {}): Promise<T> {
  const token = getToken();
  const workspaceId = getWorkspaceId();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(opts.headers || {}),
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  if (workspaceId) headers["X-Workspace-Id"] = workspaceId;

  const method = opts.method || "GET";
  let base = await resolveBase();

  let res: Response;
  try {
    res = await fetchOnce(base, path, method, headers, opts.body, opts.signal);
  } catch (e) {
    // A hard network failure (backend down / DNS / connection refused) — NOT an
    // HTTP error. The pinned backend may have just died; drop it, re-race for a
    // live one, and retry ONCE if we landed on a different host. HTTP errors
    // (401/4xx/5xx) never reach here — they come back as a Response below.
    if (e instanceof ApiError) throw e; // timeout — don't hammer a second host
    unpinBase();
    const alt = await resolveBase();
    if (alt && alt !== base) {
      base = alt;
      res = await fetchOnce(base, path, method, headers, opts.body, opts.signal);
    } else {
      throw e;
    }
  }

  if (opts.raw) return res as unknown as T;
  const text = await res.text();
  const data = text ? safeParse(text) : null;
  if (!res.ok) {
    let message = `Error ${res.status}`;
    if (data && typeof data === "object" && "detail" in (data as Record<string, unknown>)) {
      const detail = (data as { detail?: unknown }).detail;
      if (typeof detail === "string") message = detail;
    }
    throw new ApiError(res.status, data, message);
  }
  return data as T;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// Backwards-compatible static export. Prefer apiBase() for new code — it returns
// the live/pinned backend, whereas this is fixed to the configured value.
export const API_BASE = CONFIGURED;
