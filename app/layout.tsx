// app/layout.tsx
import type { Metadata } from "next";
import "./globals.css";

// ✅ default imports (NE curly braces)
import Header from "@/components/Header";
import Footer from "@/components/Footer";

export const metadata: Metadata = {
  title: "BlockBattle",
  description: "A year-long, transparent crypto community challenge.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-dvh bg-white text-gray-900">
        <Header />
        {children}
        <Footer />
      </body>
    </html>
  );
}

