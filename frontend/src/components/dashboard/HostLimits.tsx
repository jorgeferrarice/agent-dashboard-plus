import React, { useEffect, useState } from 'react';
import type { ToolUsage, UsageWindow } from '../../api';

/** One account whose limits are shown. */
export interface LimitsEntry {
  /** Tool name, used as the React key. */
  name: string;
  /** Name on the tool's spawn button. */
  label: string;
  usage?: ToolUsage;
}

/** Current time, refreshed every minute, for "5 min ago". */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/** "just now", "5 min ago", "3 h ago". */
function formatAge(seconds: number): string {
  if (seconds < 90) return 'just now';
  if (seconds < 5400) return `${Math.round(seconds / 60)} min ago`;
  return `${Math.round(seconds / 3600)} h ago`;
}

/**
 * Picks the two limits shown as bars: the short window (five
 * hours, which the tools call the "session") and the weekly
 * one. Tools name them differently, so they are matched by
 * word; a tool that shows only one gets one bar.
 */
function mainWindows(windows: UsageWindow[]): {
  short?: UsageWindow;
  week?: UsageWindow;
} {
  return {
    short: windows.find((w) => /session|5 ?h/i.test(w.label)),
    week: windows.find((w) => /week/i.test(w.label)),
  };
}

/** Green with room to spare, amber when close, red at the limit. */
const barColor = (used: number) =>
  used >= 90 ? 'bg-red-500' : used >= 70 ? 'bg-amber-400' : 'bg-green-500';

const Bar: React.FC<{ name: string; window: UsageWindow }> = ({
  name,
  window: w,
}) => (
  <span
    className="flex items-center gap-1"
    title={`${w.label}: ${w.used_percent}% used${w.resets ? ` · resets ${w.resets}` : ''}`}
  >
    <span className="text-slate-500">{name}</span>
    <span
      role="meter"
      aria-label={w.label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={w.used_percent}
      className="block h-1.5 w-12 overflow-hidden rounded-full bg-slate-700"
    >
      <span
        className={`block h-full ${barColor(w.used_percent)}`}
        style={{ width: `${w.used_percent}%` }}
      />
    </span>
    <span className="w-8 tabular-nums text-slate-300">{w.used_percent}%</span>
  </span>
);

/**
 * Plan limits of a host's AI accounts: per account, a bar for
 * the five hour window and one for the week.
 *
 * Click or tap an account to see every limit the tool reports,
 * when each resets, and how old the reading is. A reading that
 * could not be refreshed stays, dimmed, with its age next to
 * it. An account whose limits cannot be read says so.
 */
const HostLimits: React.FC<{ entries: LimitsEntry[] }> = ({ entries }) => {
  const now = useNow();
  if (entries.length === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px]">
      {entries.map(({ name, label, usage }) => {
        const windows = usage?.windows || [];
        if (windows.length === 0) {
          return (
            <span key={name} className="py-1 text-slate-500">
              <span className="font-semibold text-slate-400">{label}</span>{' '}
              limit unavailable
            </span>
          );
        }
        const { short, week } = mainWindows(windows);
        const age = usage?.updated_at
          ? formatAge(now / 1000 - usage.updated_at)
          : null;
        const stale = usage?.ok === false;
        return (
          <details key={name} className={stale ? 'opacity-50' : ''}>
            <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-2 py-1 [&::-webkit-details-marker]:hidden">
              <span className="font-semibold text-slate-400">{label}</span>
              {short && <Bar name="5h" window={short} />}
              {week && <Bar name="week" window={week} />}
              {!short && !week && <Bar name="" window={windows[0]} />}
              {stale && age && <span className="text-slate-400">{age}</span>}
            </summary>
            <ul className="mb-1 space-y-0.5 text-slate-400">
              {windows.map((w) => (
                <li key={w.label}>
                  {w.label}: {w.used_percent}% used
                  {w.resets && ` · resets ${w.resets}`}
                </li>
              ))}
              <li className="text-slate-500">
                {stale ? 'Could not refresh. Last read ' : 'Updated '}
                {age ?? 'at an unknown time'}
              </li>
            </ul>
          </details>
        );
      })}
    </div>
  );
};

export default HostLimits;
