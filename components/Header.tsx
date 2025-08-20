// components/Header.tsx
import Link from "next/link";

export default function Header() {
  return (
    <header className="sticky top-0 z-30 w-full border-b bg-white/70 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4">
        <Link href="/" className="font-semibold tracking-tight">
          BlockBattle.org
        </Link>
        <nav className="flex items-center gap-6 text-sm">
          <Link href="/about" className="hover:underline">About</Link>
          <Link href="/rules" className="hover:underline">Rules</Link>
          <a href="https://blockbattle.org" target="_blank" className="hover:underline" rel="noreferrer">Website</a>
        </nav>
      </div>
    </header>
  );
}

