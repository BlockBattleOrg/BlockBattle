// /components/ThemeToggle.tsx
"use client";

import { useEffect, useState } from "react";
import { useTheme } from "next-themes";

export default function ThemeToggle() {
  const { theme, setTheme, systemTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const current = theme === "system" ? systemTheme : theme;
  const isDark = current === "dark";

  return (
    <button
      aria-label="Toggle theme"
      className="btn"
      onClick={() => setTheme(isDark ? "light" : "dark")}
      title={isDark ? "Switch to light" : "Switch to dark"}
    >
      {/* Inline SVGs to avoid extra deps */}
      {isDark ? (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M21.64 13a9 9 0 1 1-10.63-10.64 1 1 0 0 1 1.11 1.45 7 7 0 1 0 8.71 8.71A1 1 0 0 1 21.64 13z"/>
        </svg>
      ) : (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M6.76 4.84l-1.8-1.79-1.41 1.41 1.79 1.8 1.42-1.42zM1 13h3v-2H1v2zm10-9h-2v3h2V4zm7.45 2.46l1.79-1.8-1.41-1.41-1.8 1.79 1.42 1.42zM17 11v2h3v-2h-3zm-5 7h2v-3h-2v3zm-6.24.16l1.8 1.79 1.41-1.41-1.79-1.8-1.42 1.42zM20 20l-1.41-1.41-1.79 1.8 1.41 1.41L20 20z"/>
        </svg>
      )}
      <span className="ml-2 hidden sm:inline">{mounted ? (isDark ? "Dark" : "Light") : "Theme"}</span>
    </button>
  );
}

