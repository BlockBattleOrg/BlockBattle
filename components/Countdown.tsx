"use client";

import * as React from "react";

type Props = {
  /** ISO end datetime, e.g. "2026-01-01T00:00:00Z" */
  endIso?: string;
  /** Optional label to show above the timer */
  label?: string;
  /** Optional start ISO to compute progress (0..100%). If omitted, progress bar is hidden. */
  startIso?: string;
  /** Update interval in ms */
  tickMs?: number;
};

function clamp(n: number, min = 0, max = 100) {
  return Math.max(min, Math.min(max, n));
}

export default function Countdown({
  endIso = process.env.NEXT_PUBLIC_CAMPAIGN_END || "",
  label = "Time remaining",
  startIso,
  tickMs = 1000,
}: Props) {
  const [now, setNow] = React.useState<Date>(() => new Date());
  const end = React.useMemo(() => (endIso ? new Date(endIso) : null), [endIso]);
  const start = React.useMemo(() => (startIso ? new Date(startIso) : null), [startIso]);

  React.useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), tickMs);
    return () => window.clearInterval(id);
  }, [tickMs]);

  const remainingMs = React.useMemo(() => {
    if (!end) return 0;
    return Math.max(0, end.getTime() - now.getTime());
  }, [end, now]);

  const totalMs = React.useMemo(() => {
    if (!start || !end) return null;
    return Math.max(0, end.getTime() - start.getTime());
  }, [start, end]);

  const progressPct = React.useMemo(() => {
    if (!totalMs || totalMs <= 0 || !end) return null;
    const elapsed = totalMs - remainingMs;
    return clamp((elapsed / totalMs) * 100);
  }, [totalMs, remainingMs, end]);

  const { d, h, m, s } = toDHMS(remainingMs);

  // Fallback UI when env is missing
  if (!end) {
    return (
      <div className="rounded-xl border p-4">
        <p className="text-sm text-gray-600">
          {label}
        </p>
        <p className="font-semibold">
          Configure <code>NEXT_PUBLIC_CAMPAIGN_END</code> to enable the countdown.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border p-4">
      <p className="text-sm text-gray-600">{label}</p>
      <div className="mt-1 text-3xl font-bold tabular-nums">
        {d}d : {pad(h)}h : {pad(m)}m : {pad(s)}s
      </div>

      {progressPct != null && (
        <div className="mt-3">
          <div className="mb-1 flex items-center justify-between text-xs text-gray-600">
            <span>Progress</span>
            <span>{progressPct.toFixed(1)}%</span>
          </div>
          <div className="h-2 w-full rounded-full bg-gray-200">
            <div
              className="h-2 rounded-full bg-gray-900 transition-[width]"
              style={{ width: `${progressPct}%` }}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function toDHMS(ms: number) {
  const sec = Math.floor(ms / 1000);
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return { d, h, m, s };
}
function pad(n: number) {
  return String(n).padStart(2, "0");
}

