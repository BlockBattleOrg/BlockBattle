// /components/Footer.tsx
import Link from "next/link";

export default function Footer() {
  return (
    <footer className="border-t border-border bg-background/80 backdrop-blur">
      <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-4 py-6 sm:flex-row">
        <p className="text-xs text-muted-foreground">
          © {new Date().getFullYear()} BlockBattle. All rights reserved.
        </p>

        <div className="flex items-center gap-4">
          {/* X (Twitter) link */}
          <Link
            href="https://x.com/BlockBattleOrg"
            aria-label="X (Twitter)"
            rel="me noopener noreferrer"
            target="_blank"
            className="text-muted-foreground hover:text-foreground"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="currentColor"
              aria-hidden="true"
            >
              <path d="M18.244 2H21l-6.54 7.47L22 22h-6.59l-5.16-6.72L3.9 22H1.14l6.98-7.97L2 2h6.59l4.77 6.3L18.24 2Zm-.98 18.4h1.7L7.8 3.56H6.04L17.26 20.4Z" />
            </svg>
          </Link>
        </div>
      </div>
    </footer>
  );
}

