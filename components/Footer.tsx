// components/Footer.tsx
export default function Footer() {
  return (
    <footer className="mt-12 border-t">
      <div className="mx-auto max-w-6xl px-4 py-8 text-sm text-gray-600">
        <p className="mb-1">© {new Date().getFullYear()} BlockBattle.org · MIT</p>
        <p className="text-xs">All data and addresses will be public and verifiable.</p>
      </div>
    </footer>
  );
}

