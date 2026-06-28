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
    return [
      { source: "/api/proxy/:path*", destination: `${process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000"}/api/v1/:path*` },
    ];
  },
};
export default nextConfig;
