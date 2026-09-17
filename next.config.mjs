/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  images: { remotePatterns: [{ protocol: "https", hostname: "**" }] },
  experimental: {
    // Tree-shake lucide-react: only bundle the icons actually imported rather
    // than the full 1000+ icon barrel, cutting page JS meaningfully.
    optimizePackageImports: ["lucide-react"],
  },
  async rewrites() {
    const apiBase = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";
    return [
      { source: "/api/proxy/:path*", destination: `${apiBase}/api/v1/:path*` },
      // Campaign email open-/click-tracking links (api/app/api/v1/tracking.py)
      // are built on this stable domain (config.py: tracking_base_url) instead
      // of a raw backend alias, because a Render alias has already gone stale
      // more than once and every campaign email ever sent has these links
      // baked into its body permanently — a dead alias there can never be
      // fixed retroactively. This rewrite is what actually resolves them:
      // it forwards to whatever backend NEXT_PUBLIC_API_URL currently points
      // at, so a future backend move only needs this env var updated (same
      // redeploy the app itself already needs) and every link, old and new,
      // keeps working — no separate fix, no code change here.
      { source: "/api/v1/track/:path*", destination: `${apiBase}/api/v1/track/:path*` },
    ];
  },
};
export default nextConfig;
