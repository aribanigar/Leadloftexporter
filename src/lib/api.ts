"use client";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

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

export async function api<T = unknown>(path: string, opts: RequestOptions = {}): Promise<T> {
  const token = getToken();
  const workspaceId = getWorkspaceId();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(opts.headers || {}),
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  if (workspaceId) headers["X-Workspace-Id"] = workspaceId;

  // Fall back to our own AbortController if the caller didn't supply a signal,
  // so the request always has a hard ceiling.
  let signal = opts.signal;
  let timer: ReturnType<typeof setTimeout> | null = null;
  if (!signal) {
    const ctrl = new AbortController();
    signal = ctrl.signal;
    timer = setTimeout(() => ctrl.abort(), DEFAULT_TIMEOUT_MS);
  }

  let res: Response;
  try {
    res = await fetch(`${API_URL}/api/v1${path}`, {
      method: opts.method || "GET",
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
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

export const API_BASE = API_URL;
