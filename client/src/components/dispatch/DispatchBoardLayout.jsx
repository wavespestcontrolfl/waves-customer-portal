/**
 * <DispatchBoardLayout> — pane shell for the dispatch board.
 *
 * Desktop (md+): 3-pane flex row, [240px roster] [flex map]
 *                [320px action queue]. Each child sets its own width.
 *
 * Mobile (< md): flex column with a top-of-content pane switcher
 *                (Roster | Map | Alerts). Only the selected pane is
 *                visible at a time; the other two are display:none
 *                so React state + open Sheets/Drawers persist across
 *                pane switches.
 *
 * The pane components (TechRosterPane / ActionQueuePane) use
 * `w-full md:w-60` (or md:w-80) so they fill the mobile viewport
 * width but keep their fixed desktop widths. <DispatchMap> is
 * `flex-1` already and works in both flex directions.
 *
 * Tier 1 V2 styling.
 */
import React, { useState } from 'react';
import { cn } from '../ui';

const PANES = [
  { key: 'roster', label: 'Roster' },
  { key: 'map', label: 'Map' },
  { key: 'alerts', label: 'Alerts' },
];

export default function DispatchBoardLayout({ left, center, right }) {
  // Mobile-only state. Desktop ignores it (all three panes always
  // render). Default to 'map' because the map is the central
  // coordination surface — most dispatchers want it first.
  const [activePane, setActivePane] = useState('map');

  function paneVisibility(key) {
    // Mobile: visible iff active (flex-1 to grab the rest of the
    // viewport below the switcher); hidden otherwise.
    // Desktop (md+): wrapper becomes display:contents — transparent,
    // the inner pane (TechRosterPane / DispatchMap / ActionQueuePane)
    // lays out directly inside the parent flex row using its own
    // width classes (md:w-60 / flex-1 / md:w-80). The two wrapper
    // states never conflict because they're at different breakpoints.
    return activePane === key
      ? 'flex flex-1 min-h-0 md:contents'
      : 'hidden md:contents';
  }

  return (
    <div className="flex flex-col md:flex-row h-[calc(100vh-64px)] bg-surface-page overflow-hidden">
      {/* Mobile pane switcher. Hidden on md+ where all three panes
          fit side-by-side. */}
      <div
        role="tablist"
        aria-label="Dispatch board panes"
        className="flex md:hidden border-b border-hairline border-zinc-200 bg-white flex-shrink-0"
      >
        {PANES.map((p) => (
          <button
            key={p.key}
            type="button"
            role="tab"
            aria-selected={activePane === p.key}
            onClick={() => setActivePane(p.key)}
            className={cn(
              'flex-1 py-2.5 text-12 uppercase tracking-label font-medium',
              'border-b-2 -mb-px transition-colors u-focus-ring',
              activePane === p.key
                ? 'border-zinc-900 text-ink-primary'
                : 'border-transparent text-ink-tertiary hover:text-ink-secondary'
            )}
          >
            {p.label}
          </button>
        ))}
      </div>

      <div className={paneVisibility('roster')}>{left}</div>
      <div className={paneVisibility('map')}>{center}</div>
      <div className={paneVisibility('alerts')}>{right}</div>
    </div>
  );
}
