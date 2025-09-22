// /app/layout.tsx
import type { Metadata } from "next";
import "./globals.css";

// ✅ default imports (NE curly braces)
import Header from "@/components/Header";
import Footer from "@/components/Footer";

// ⬇️ NEW: ThemeProvider (next-themes wrapper)
// Make sure you have: /components/ui/theme-provider.tsx
import { ThemeProvider } from "@/components/ui/theme-provider";

export const metadata: Metadata = {
  title: "BlockBattle",
  description: "A year-long, transparent crypto community challenge.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
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

