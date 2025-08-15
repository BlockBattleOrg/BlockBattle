export function Footer() {
  return (
    <footer className="mt-12 border-t border-gray-200">
      <div className="mx-auto max-w-6xl px-4 py-8 text-sm text-gray-600 sm:px-6 lg:px-8">
        <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
          <p>© {new Date().getFullYear()} BlockBattle.org • Transparent, community-driven participation</p>
          <div className="flex items-center gap-4">
            <a className="hover:text-gray-900" href="https://github.com/BlockBattleOrg/BlockBattle" target="_blank" rel="noreferrer">GitHub</a>
            <a className="hover:text-gray-900" href="/SECURITY.md">Security</a>
            <a className="hover:text-gray-900" href="#transparency">Transparency</a>
          </div>
        </div>
      </div>
    </footer>
  );
}

