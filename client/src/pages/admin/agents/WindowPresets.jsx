import React from "react";
import { cn } from "../../../components/ui";
import { WINDOWS } from "./hubParams";

// The Control center's time window: Today (ET midnight → now), 7 days,
// 30 days. Segmented buttons from md up (the dashboard jump-nav idiom), a
// native <select> below so the picker works one-handed on a phone.

const LABELS = { today: { short: "Today", long: "Today (since midnight ET)" }, "7d": { short: "7D", long: "Last 7 days" }, "30d": { short: "30D", long: "Last 30 days" } };

export function windowLabel(key) {
  return LABELS[key]?.long || key;
}

export default function WindowPresets({ value, onChange }) {
  return (
    <div className="flex items-center gap-2">
      <span className="hidden md:inline text-12 text-ink-tertiary whitespace-nowrap">Window</span>
      <div role="group" aria-label="Time window" className="hidden md:inline-flex items-center gap-1">
        {WINDOWS.map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => onChange(key)}
            aria-pressed={value === key}
            title={LABELS[key].long}
            className={cn(
              "inline-flex items-center h-8 px-3 rounded-md border-hairline text-13 font-medium transition-colors u-focus-ring",
              value === key ? "bg-zinc-900 text-white border-zinc-900" : "bg-surface-card text-ink-secondary border-zinc-200 hover:bg-surface-hover"
            )}
          >
            {LABELS[key].short}
          </button>
        ))}
      </div>
      <label className="md:hidden flex items-center gap-2 min-w-0">
        <span className="text-12 text-ink-tertiary whitespace-nowrap">Window</span>
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-label="Time window"
          className="h-11 min-w-[9rem] text-16 border-hairline border-zinc-200 rounded-sm bg-white px-2 text-zinc-900 u-focus-ring"
        >
          {WINDOWS.map((key) => (
            <option key={key} value={key}>
              {LABELS[key].long}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
