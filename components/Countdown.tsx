// components/Countdown.tsx
"use client";
import { useEffect, useState } from "react";

type Remaining = { d: number; h: number; m: number; s: number };

export default function Countdown({ endsAt }: { endsAt: string }) {
  const [rem, setRem] = useState<Remaining>({ d: 0, h: 0, m: 0, s: 0 });

  useEffect(() => {
    const end = new Date(endsAt).getTime();
    const tick = () => {
      const diff = Math.max(0, end - Date.now());
      const d = Math.floor(diff / (1000 * 60 * 60 * 24));
      const h = Math.floor((diff / (1000 * 60 * 60)) % 24);
      const m = Math.floor((diff / (1000 * 60)) % 60);
      const s = Math.floor((diff / 1000) % 60);
      setRem({ d, h, m, s });
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [endsAt]);

  return (
    <div className="grid grid-flow-col gap-4 text-center text-sm">
      <TimeBox label="days" value={rem.d} />
      <TimeBox label="hours" value={rem.h} />
      <TimeBox label="mins" value={rem.m} />
      <TimeBox label="secs" value={rem.s} />
    </div>
  );
}

function TimeBox({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border px-4 py-2">
      <div className="text-2xl font-semibold tabular-nums">{value}</div>
      <div className="text-xs uppercase tracking-wide text-gray-500">{label}</div>
    </div>
  );
}

