/**
 * <ActionQueuePane> — right pane, reserved.
 *
 * Empty placeholder for the future dispatch:alert action queue. The
 * channel + storage + emit point all shipped in PR #293; this pane
 * will subscribe to dispatch:alert events and render alert cards
 * (tech_late, missed_photo, moa_violation, etc.) in a separate PR.
 *
 * Reserved at 320px so the layout doesn't reflow when that PR lands.
 * If you find yourself adding any data-fetching or socket subscribing
 * to this component before that PR — stop. The action queue gets its
 * own scoped review pass.
 */
import React from 'react';

const D = {
  bg: '#0f1923', border: '#334155', muted: '#64748b', heading: '#94a3b8',
};

export default function ActionQueuePane() {
  return (
    <aside
      style={{
        width: 320,
        flexShrink: 0,
        background: D.bg,
        borderLeft: `1px solid ${D.border}`,
        padding: 16,
        boxSizing: 'border-box',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      <h2
        style={{
          color: D.heading,
          fontSize: 12,
          fontWeight: 600,
          letterSpacing: 1.5,
          textTransform: 'uppercase',
          margin: 0,
        }}
      >
        Action Queue
      </h2>
      <div style={{ color: D.muted, fontSize: 12 }}>
        Reserved for dispatch:alert cards — separate PR.
      </div>
    </aside>
  );
}
