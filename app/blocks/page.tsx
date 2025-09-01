import BlocksContainer from "@/components/BlocksContainer";

export default async function BlocksPage() {
  return (
    <main className="mx-auto max-w-6xl p-6">
      <header className="mb-6">
        <h1 className="text-2xl font-bold">Community Blocks</h1>
        <p className="text-sm text-gray-600">
          Each square represents a contribution. Bigger amount → bigger block. More contributions → more blocks.
        </p>
      </header>

      {/* Client-side container handles fetching, filtering, and auto-refresh */}
      <BlocksContainer limit={200} refreshMs={60000} />
    </main>
  );
}

