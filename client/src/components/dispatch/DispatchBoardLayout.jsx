/**
 * <DispatchBoardLayout> — pure layout shell. 3-pane flex row:
 *   [240px roster] [flex map] [320px action queue, reserved]
 *
 * No data, no state. Composes children.
 *
 * Tier 1 V2 styling.
 */
import React from 'react';

export default function DispatchBoardLayout({ left, center, right }) {
  return (
    <div className="flex flex-row h-[calc(100vh-64px)] bg-surface-page overflow-hidden">
      {left}
      {center}
      {right}
    </div>
  );
}
