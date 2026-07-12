import type { Metadata, Viewport } from "next";
import "./globals.css";
import { Providers } from "@/components/providers";
import { PWA } from "@/components/pwa";
import { DeferredFonts } from "@/components/deferred-fonts";

export const metadata: Metadata = {
  title: "LeadCaptura — LinkedIn Lead Generation",
  description: "Capture, enrich, and run outreach playbooks on LinkedIn leads.",
  manifest: "/manifest.webmanifest",
  applicationName: "LeadCaptura",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "LeadCaptura",
  },
  icons: {
    icon: [
      { url: "/favicon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180" }],
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  themeColor: "#059669",
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        {/* Preconnect only — the actual font stylesheets are injected after
            first paint by <DeferredFonts /> so they never block rendering.
            (Inter body + Manrope headings + Material Symbols icon ligatures.) */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
      </head>
      <body className="font-sans text-slate-900 antialiased">
        <DeferredFonts />
        <Providers>{children}</Providers>
        <PWA />
      </body>
    </html>
  );
}
