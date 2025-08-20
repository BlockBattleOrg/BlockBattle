// components/TreemapPlaceholder.tsx
export default function TreemapPlaceholder() {
  return (
    <div className="grid h-64 grid-cols-4 gap-1 rounded-2xl border p-1">
      {/* Visual placeholder; replaced with Recharts Treemap in Phase 3 */}
      {Array.from({ length: 16 }).map((_, i) => (
        <div key={i} className="rounded bg-gray-100" />
      ))}
    </div>
  );
}

