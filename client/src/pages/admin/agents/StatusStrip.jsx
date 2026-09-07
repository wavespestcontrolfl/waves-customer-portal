import React from "react";
import { cn } from "../../../components/ui";

// Count chips: All / Active / Needs attention / Idle. The counts come from
// the server for the whole scope (an area or every lane), not from the rows
// currently shown, so a chip never reads 0 because a filter hid its rows.
// The alert variant is reserved for "Needs attention" while it is the active
// chip AND its count is above zero — red nowhere else on this surface.

export const STATUS_CHIPS = [
  { key: "all", label: "All" },
  { key: "active", label: "Active" },
  { key: "attention", label: "Needs attention" },
  { key: "idle", label: "Idle" },
];

// Without counts (a scope still loading, or its read failed) the chips carry
// no number: a zero, or the previous scope's count, would be a claim.
export default function StatusStrip({ value, counts, onChange }) {
  return (
    <div className="flex gap-2 flex-wrap" role="group" aria-label="Lane status">
      {STATUS_CHIPS.map((chip) => {
        const active = value === chip.key;
        const count = counts ? counts[chip.key] ?? 0 : null;
        const alert = chip.key === "attention" && active && count > 0;
        return (
          <button
            key={chip.key}
            type="button"
            onClick={() => onChange(chip.key)}
            aria-pressed={active}
            className={cn(
              "inline-flex items-center gap-1.5 h-8 px-3 rounded-md border-hairline text-13 font-medium transition-colors u-focus-ring",
              alert
                ? "bg-alert-bg text-alert-fg border-alert-fg"
                : active
                  ? "bg-zinc-900 text-white border-zinc-900"
                  : "bg-surface-card text-ink-secondary border-zinc-200 hover:bg-surface-hover"
            )}
          >
            {chip.label}
            <span className={cn("text-11 u-nums", alert ? "text-alert-fg" : active ? "text-zinc-300" : "text-ink-tertiary")}>{count === null ? "" : count}</span>
          </button>
        );
      })}
    </div>
  );
}
