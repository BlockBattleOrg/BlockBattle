// /components/ui/theme-provider.tsx
"use client";

import * as React from "react";
import {
  ThemeProvider as NextThemesProvider,
  type ThemeProviderProps as NextThemeProviderProps,
} from "next-themes";

// Extend the original props to ensure all valid props (including disableTransitionOnChange) are accepted.
type Props = NextThemeProviderProps & {
  children: React.ReactNode;
};

export function ThemeProvider(props: Props) {
  // Simply forward all props to NextThemesProvider to avoid missing-fields TS errors.
  return <NextThemesProvider {...props} />;
}

