// components/Ticker.tsx
"use client";
import { useEffect, useRef } from "react";

export default function Ticker({ messages }: { messages: string[] }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    let x = ref.current.scrollWidth;
    const step = () => {
      if (!ref.current) return;
      x -= 1;
      if (x < -ref.current.scrollWidth) x = ref.current.clientWidth;
      ref.current.style.transform = `translateX(${x}px)`;
      requestAnimationFrame(step);
    };
    const id = requestAnimationFrame(step);
    return () => cancelAnimationFrame(id);
  }, []);
  return (
    <div className="relative w-full overflow-hidden border-y bg-gray-50">
      <div className="absolute left-0 top-0 h-full w-24 bg-gradient-to-r from-gray-50 to-transparent" />
      <div className="absolute right-0 top-0 h-full w-24 bg-gradient-to-l from-gray-50 to-transparent" />
      <div className="whitespace-nowrap py-2 will-change-transform" ref={ref}>
        {messages.map((m, i) => (
          <span key={i} className="mx-6 text-sm text-gray-700">{m}</span>
        ))}
      </div>
    </div>
  );
}

