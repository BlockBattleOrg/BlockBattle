export default function Page() {
  return (
    <div className="py-10">
      {/* Hero */}
      <section className="mb-12" aria-labelledby="hero-title">
        <h1 id="hero-title" className="text-3xl font-bold tracking-tight">BlockBattle.org</h1>
        <p className="mt-3 max-w-2xl text-gray-700">
          A transparent, year-long challenge that highlights the collective support of crypto communities.
          Participate by contributing to public addresses. Rankings update over time.
        </p>
        <div className="mt-6 flex gap-3">
          <a href="#ranking" className="rounded-xl bg-black px-4 py-2 text-white hover:bg-gray-800">
            View Ranking
          </a>
          <a href="#blocks" className="rounded-xl border border-gray-300 px-4 py-2 hover:bg-gray-50">
            Community Blocks
          </a>
        </div>
      </section>

      {/* Countdown placeholder */}
      <section className="mb-12 grid gap-4 rounded-2xl border border-gray-200 p-6" aria-labelledby="countdown-title">
        <h2 id="countdown-title" className="text-xl font-semibold">Countdown</h2>
        <p className="text-gray-700">Time remaining until the end of the participation cycle will appear here.</p>
      </section>

      {/* Ranking placeholder */}
      <section id="ranking" className="mb-12 rounded-2xl border border-gray-200 p-6" aria-labelledby="ranking-title">
        <h2 id="ranking-title" className="text-xl font-semibold">Top 15 Ranking</h2>
        <p className="mt-2 text-gray-700">Live table with symbol, name, total contributed (USD), and transaction count.</p>
        <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="rounded-xl border border-gray-200 bg-white p-4">
              <div className="flex items-center justify-between">
                <span className="font-medium">Symbol #{i + 1}</span>
                <span className="text-xs text-gray-500">Tx: —</span>
              </div>
              <div className="mt-2 text-sm text-gray-700">USD Total: —</div>
              <button className="mt-3 w-full rounded-lg border border-gray-300 py-1.5 text-sm hover:bg-gray-50">
                Participate
              </button>
            </div>
          ))}
        </div>
      </section>

      {/* Community Blocks placeholder */}
      <section id="blocks" className="mb-12 rounded-2xl border border-gray-200 p-6" aria-labelledby="blocks-title">
        <h2 id="blocks-title" className="text-xl font-semibold">Community Blocks</h2>
        <p className="mt-2 text-gray-700">
          Treemap visualization (Top 15) will render here. Block size is proportional to the total contributions per currency.
        </p>
        <div className="mt-4 h-64 w-full rounded-xl border border-dashed border-gray-300 bg-gray-50" />
      </section>

      {/* Transparency placeholder */}
      <section id="transparency" className="mb-16 rounded-2xl border border-gray-200 p-6" aria-labelledby="transparency-title">
        <h2 id="transparency-title" className="text-xl font-semibold">Transparency</h2>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-gray-700">
          <li>All participation addresses are public and dedicated to this project.</li>
          <li>Code and aggregation logic are open for community audit.</li>
          <li>No personal data is collected; participation is voluntary and anonymous.</li>
        </ul>
      </section>
    </div>
  );
}

