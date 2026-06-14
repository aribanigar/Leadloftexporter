import type { Metadata, Viewport } from "next";
import "./globals.css";
import { Providers } from "@/components/providers";
import { PWA } from "@/components/pwa";

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
        {/* Material Symbols — without this the icon ligatures (arrow_back,
            more_vert, visibility, ads_click, …) render as raw text. */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200&display=swap"
        />
      </head>
      <body className="font-sans text-slate-900 antialiased">
        <Providers>{children}</Providers>
        <PWA />
      </body>
    </html>
  );
}
