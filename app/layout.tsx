// /app/layout.tsx
import type { Metadata } from "next";
import "./globals.css";

// ✅ default imports (NE curly braces)
import Header from "@/components/Header";
import Footer from "@/components/Footer";

// ⬇️ ThemeProvider (next-themes wrapper) – već postoji
import { ThemeProvider } from "@/components/ui/theme-provider";

export const metadata: Metadata = {
  title: "BlockBattle",
  description: "A year-long, transparent crypto community challenge.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Favicons (multi-format for best compatibility) */}
        <link rel="icon" href="/favicon.ico" sizes="any" />
        <link rel="icon" href="/favicon_blockbattle.png" type="image/png" />
        <link rel="icon" href="/favicon_blockbattle.svg" type="image/svg+xml" />

        {/* Social preview image */}
        <meta property="og:image" content="/logo_blockbattle.png" />
        <meta property="og:image:type" content="image/png" />
        <meta property="og:image:width" content="1200" />
        <meta property="og:image:height" content="630" />
      </head>
      {/* We keep body minimal; colors now come from CSS variables (globals.css) */}
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

