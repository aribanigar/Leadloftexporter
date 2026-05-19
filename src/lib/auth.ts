"use client";

import { create } from "zustand";
import { api, clearSession, setSession } from "./api";
import type { AuthResponse, User, WorkspaceContext } from "./types";

interface AuthState {
  user: User | null;
  workspace: WorkspaceContext | null;
  workspaces: WorkspaceContext[];
  loading: boolean;
  bootstrap: () => Promise<void>;
  login: (email: string, password: string) => Promise<void>;
  register: (input: { email: string; password: string; first_name?: string; last_name?: string; workspace_name?: string }) => Promise<void>;
  logout: () => void;
  switchWorkspace: (id: string) => void;
}

export const useAuth = create<AuthState>((set, get) => ({
  user: null,
  workspace: null,
  workspaces: [],
  loading: true,
  bootstrap: async () => {
    if (typeof window === "undefined") return;
    if (!localStorage.getItem("lc_token")) {
      set({ loading: false });
      return;
    }
    try {
      const me = await api<AuthResponse>("/auth/me");
      const wsId = localStorage.getItem("lc_workspace_id") || me.current_workspace_id || me.workspaces[0]?.id || null;
      const ws = me.workspaces.find((w) => w.id === wsId) || me.workspaces[0] || null;
      if (ws) localStorage.setItem("lc_workspace_id", ws.id);
      set({ user: me.user, workspaces: me.workspaces, workspace: ws, loading: false });
    } catch {
      clearSession();
      set({ loading: false });
    }
  },
  login: async (email, password) => {
    const res = await api<AuthResponse>("/auth/login", { method: "POST", body: { email, password } });
    setSession(res.access_token, res.current_workspace_id);
    const ws = res.workspaces.find((w) => w.id === res.current_workspace_id) || res.workspaces[0] || null;
    set({ user: res.user, workspace: ws, workspaces: res.workspaces });
  },
  register: async (input) => {
    const res = await api<AuthResponse>("/auth/register", { method: "POST", body: input });
    setSession(res.access_token, res.current_workspace_id);
    const ws = res.workspaces.find((w) => w.id === res.current_workspace_id) || res.workspaces[0] || null;
    set({ user: res.user, workspace: ws, workspaces: res.workspaces });
  },
  logout: () => {
    clearSession();
    set({ user: null, workspace: null, workspaces: [] });
  },
  switchWorkspace: (id) => {
    if (typeof window === "undefined") return;
    localStorage.setItem("lc_workspace_id", id);
    const ws = get().workspaces.find((w) => w.id === id) || null;
    set({ workspace: ws });
  },
}));
