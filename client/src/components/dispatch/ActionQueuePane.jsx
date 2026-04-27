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
 *
 * Tier 1 V2 styling.
 */
import React from 'react';

export default function ActionQueuePane() {
  return (
    <aside className="w-80 flex-shrink-0 bg-white border-l border-hairline border-zinc-200 p-4 flex flex-col gap-2">
      <h2 className="text-12 uppercase tracking-label font-medium text-ink-secondary">
        Action Queue
      </h2>
      <div className="text-12 text-ink-tertiary">
        Reserved for dispatch:alert cards — separate PR.
      </div>
    </aside>
  );
}
