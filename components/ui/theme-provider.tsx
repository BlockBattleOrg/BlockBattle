// /components/ui/theme-provider.tsx
"use client";

import * as React from "react";
import { ThemeProvider as NextThemesProvider } from "next-themes";

// Type the wrapper from the underlying component to support all props
type Props = React.ComponentProps<typeof NextThemesProvider>;

export function ThemeProvider(props: Props) {
  return <NextThemesProvider {...props} />;
}

