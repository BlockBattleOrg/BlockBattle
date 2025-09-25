// /components/Header.tsx
import Link from "next/link";
import Image from "next/image";
import ThemeToggle from "@/components/ThemeToggle";

export default function Header() {
  return (
    <header className="sticky top-0 z-30 w-full border-b border-border bg-background/80 backdrop-blur">
      {/* ↑ povećali smo visinu headera da primi logo bez rezanja */}
      <div className="mx-auto flex h-16 sm:h-20 max-w-6xl items-center justify-between px-4">
        <Link href="/" className="flex items-center">
          {/* Intrinsic dimenzije veće radi kvalitete, a stvarnu visinu kontroliramo klasama */}
          <Image
            src="/logo_blockbattle.png"
            alt="BlockBattle logo"
            width={320}
            height={120}
            priority
            className="h-10 w-auto sm:h-12"
            sizes="(max-width: 640px) 120px, 160px"
          />
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

