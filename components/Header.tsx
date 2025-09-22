// /components/Header.tsx
import Link from "next/link";
import ThemeToggle from "@/components/ThemeToggle";

export default function Header() {
  return (
    <header className="sticky top-0 z-30 w-full border-b border-border bg-background/80 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4">
        <Link href="/" className="font-semibold tracking-tight text-foreground">
          BlockBattle.org
        </Link>

        <div className="flex items-center gap-4">
          <nav className="flex items-center gap-6 text-sm text-foreground">
            <Link href="/about" className="hover:underline">
              About
            </Link>
            <Link href="/rules" className="hover:underline">
              Rules
            </Link>
            <a
              href="https://blockbattle.org"
              target="_blank"
              rel="noreferrer"
              className="hover:underline"
            >
              Website
            </a>
          </nav>

          {/* Theme toggle (does not affect existing nav functionality) */}
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}

