import TetrisBlocks, { BlockRow } from "@/components/TetrisBlocks";

async function fetchBlocks(limit = 200): Promise<BlockRow[]> {
  // Server-side fetch to our public API (middleware already handles CORS/RL)
  const res = await fetch(`${process.env.NEXT_PUBLIC_BASE_URL ?? ""}/api/public/blocks/recent?limit=${limit}`, {
    // Use dynamic for always-fresh data; switch to revalidate:X if you want caching
    cache: "no-store",
  });

  if (!res.ok) {
    console.error("blocks fetch failed:", res.status);
    return [];
  }

  const data = await res.json();
  const rows: BlockRow[] = data?.rows ?? [];
  return rows;
}

export default async function BlocksPage() {
  const rows = await fetchBlocks(200);

  return (
    <main className="mx-auto max-w-6xl p-6">
      <header className="mb-6">
        <h1 className="text-2xl font-bold">Community Blocks</h1>
        <p className="text-sm text-gray-600">
          Each block represents a contribution. Bigger amount → bigger block. More contributions → more blocks.
        </p>
      </header>

      <section>
        <TetrisBlocks rows={rows} columns={10} />
      </section>
    </main>
  );
}

