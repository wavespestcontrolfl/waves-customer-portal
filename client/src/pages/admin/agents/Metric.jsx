import React from "react";
import { cn } from "../../../components/ui";

// One cell of a lane card's metric grid. A metric that cannot be shown
// renders MetricDash: an em dash plus the server- or phase-authored reason,
// never a zero that could be mistaken for a measurement and never a
// composite score.

export function Metric({ label, value, sub, className }) {
  return (
    <div className={cn("min-w-0", className)}>
      <div className="text-11 uppercase tracking-label text-ink-tertiary">{label}</div>
      <div className="text-16 leading-tight text-zinc-900 u-nums truncate">{value}</div>
      {sub ? <div className="text-12 text-ink-secondary truncate">{sub}</div> : null}
    </div>
  );
}

export function MetricDash({ label, reason, className }) {
  return (
    <div className={cn("min-w-0", className)}>
      <div className="text-11 uppercase tracking-label text-ink-tertiary">{label}</div>
      <div className="text-16 leading-tight text-ink-tertiary" aria-label={`${label}: not available`}>
        —
      </div>
      <div className="text-12 text-ink-tertiary truncate" title={reason}>
        {reason}
      </div>
    </div>
  );
}

export const nf = new Intl.NumberFormat("en-US");

export function pct(rate) {
  return rate == null ? null : `${Math.round(rate * 100)}%`;
}

export function ms(value) {
  if (value == null) return null;
  if (value >= 60_000) return `${(value / 60_000).toFixed(1)} min`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)} s`;
  return `${nf.format(value)} ms`;
}

// "Aug 29", "Sep 4 · 17:30" — a compact ET-local stamp for "last active".
export function shortWhen(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
