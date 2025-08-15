export function Header() {
  return (
    <header className="sticky top-0 z-40 w-full border-b border-gray-200 bg-white/80 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4 sm:px-6 lg:px-8">
        <a href="/" className="font-semibold">BlockBattle.org</a>
        <nav className="hidden gap-6 text-sm sm:flex">
          <a href="#ranking" className="text-gray-600 hover:text-gray-900">Ranking</a>
          <a href="#blocks" className="text-gray-600 hover:text-gray-900">Community Blocks</a>
          <a href="#transparency" className="text-gray-600 hover:text-gray-900">Transparency</a>
        </nav>
      </div>
    </header>
  );
}

