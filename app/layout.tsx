// /app/layout.tsx
import type { Metadata } from "next";
import "./globals.css";

import Header from "@/components/Header";
import Footer from "@/components/Footer";
import { ThemeProvider } from "@/components/ui/theme-provider";

// ✅ Enriched SEO metadata (no functional changes)
export const metadata: Metadata = {
  metadataBase: new URL("https://www.blockbattle.org"),
  title: {
    default: "BlockBattle",
    template: "%s · BlockBattle",
  },
  description:
    "Live chain heights and community-backed contributions across 13 major blockchains. No hype, no fake news — just authentic support.",
  keywords: [
    "BlockBattle",
    "crypto challenge",
    "blockchain community",
    "transparent contributions",
    "BTC",
    "ETH",
    "BNB",
    "POL",
    "SOL",
    "AVAX",
    "XRP",
    "LTC",
    "TRX",
    "XLM",
    "ARB",
    "OP",
  ],
  alternates: {
    canonical: "/",
  },
  openGraph: {
    type: "website",
    url: "https://www.blockbattle.org/",
    siteName: "BlockBattle",
    title: "BlockBattle — Real community support across 13 blockchains",
    description:
      "A year-long, transparent crypto community challenge. See authentic support, free from pump-and-dump and fake news.",
    images: [
      {
        url: "/logo_blockbattle.png",
        width: 1200,
        height: 630,
        alt: "BlockBattle",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "BlockBattle — Real community support across 13 blockchains",
    description:
      "Live chain heights and genuine contributions. Transparent, community-driven signal — no hype.",
    images: ["/logo_blockbattle.png"],
    creator: "@BlockBattleOrg", // update if handle differs
  },
  icons: {
    icon: [
      { url: "/favicon.ico" },
      { url: "/favicon_blockbattle.png", type: "image/png" },
      { url: "/favicon_blockbattle.svg", type: "image/svg+xml" },
    ],
  },
  robots: {
    index: true,
    follow: true,
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Favicons (multi-format for best compatibility) */}
        <link rel="icon" href="/favicon.ico" sizes="any" />
        <link rel="icon" href="/favicon_blockbattle.png" type="image/png" />
        <link rel="icon" href="/favicon_blockbattle.svg" type="image/svg+xml" />
        <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
        <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png" />
        <link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png" />
        <meta name="theme-color" content="#0B2D4D" />

        {/* Social preview image (kept explicit; also covered by Metadata API) */}
        <meta property="og:image" content="/logo_blockbattle.png" />
        <meta property="og:image:type" content="image/png" />
        <meta property="og:image:width" content="1200" />
        <meta property="og:image:height" content="630" />
      </head>
      <body className="min-h-dvh bg-background text-foreground antialiased">
        {/* ThemeProvider sets html.class (light/dark) and remembers user preference */}
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
          <Header />
          {children}
          <Footer />
        </ThemeProvider>
      </body>
    </html>
  );
}

