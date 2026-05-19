"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { useAuth } from "@/lib/auth";

export default function HomePage() {
  const router = useRouter();
  const { user, loading } = useAuth();
  useEffect(() => {
    if (loading) return;
    router.replace(user ? "/prospecting" : "/login");
  }, [user, loading, router]);
  return (
    <div className="flex h-screen items-center justify-center text-slate-400 text-sm">Loading…</div>
  );
}
