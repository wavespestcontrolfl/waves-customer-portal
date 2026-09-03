import React from "react";

/**
 * Intelligence Bar activity list — what the bar checked or did on this
 * exchange, one line per tool call (GATE_IB_TOOL_ACTIVITY). Rendered above
 * the answer so a confirmation card is read next to the steps that produced
 * it. Labels and outcomes only: never tool inputs, results, or reasoning.
 *
 * Dual-styled like PendingActionsCard: `variant="dark"` matches the desktop
 * palette's inline palette, `variant="light"` the mobile sheet.
 */

const STATUS = {
  done: { glyph: "✓", label: "done" },
  // Past tense: the card below owns the live state (confirmed / cancelled /
  // expired); this line is the historical record of what the bar did.
  proposed: { glyph: "→", label: "proposed on the card below" },
  error: { glyph: "!", label: "could not complete" },
};

export function formatDuration(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return "";
  if (n < 1000) return `${Math.round(n)} ms`;
  return `${(n / 1000).toFixed(n < 10000 ? 1 : 0)} s`;
}

export default function ToolActivityList({ items, variant = "dark" }) {
  const list = Array.isArray(items) ? items.filter((i) => i && i.label) : [];
  if (!list.length) return null;
  const dark = variant === "dark";
  const muted = dark ? "#64748B" : "#71717A";
  const text = dark ? "#334155" : "#27272A";
  const border = dark ? "#E2E8F0" : "#E4E4E7";

  return (
    <div
      role="list"
      aria-label="What the bar checked"
      style={{
        margin: dark ? "0 0 12px" : "0 0 14px",
        padding: "8px 10px",
        border: `1px solid ${border}`,
        borderRadius: 8,
        fontFamily: "Roboto, Arial, sans-serif",
        fontSize: dark ? 13 : 14,
        lineHeight: 1.5,
        color: text,
      }}
    >
      <div
        style={{
          fontSize: 13,
          letterSpacing: "0.04em",
          textTransform: "uppercase",
          color: muted,
          marginBottom: 4,
        }}
      >
        Checked
      </div>
      {list.map((item, i) => {
        const status = STATUS[item.status] || STATUS.done;
        const duration = formatDuration(item.durationMs);
        return (
          <div
            key={`${item.tool || item.label}-${i}`}
            role="listitem"
            data-status={item.status || "done"}
            style={{ display: "flex", gap: 8, alignItems: "baseline" }}
          >
            <span
              aria-hidden
              style={{ width: 14, textAlign: "center", color: muted, flexShrink: 0 }}
            >
              {status.glyph}
            </span>
            <span style={{ flex: 1 }}>
              {item.label}
              <span style={{ color: muted }}>
                {" "}
                · {status.label}
              </span>
            </span>
            {duration ? (
              <span
                style={{
                  color: muted,
                  fontVariantNumeric: "tabular-nums",
                  flexShrink: 0,
                  fontSize: 13,
                }}
              >
                {duration}
              </span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
