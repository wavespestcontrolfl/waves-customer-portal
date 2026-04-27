/**
 * <DispatchBoardLayout> — pure layout shell. 3-pane flex row:
 *   [240px roster] [flex map] [320px action queue, reserved]
 *
 * No data, no state. Composes children.
 */
import React from 'react';

const D = { bg: '#0f1923' };

export default function DispatchBoardLayout({ left, center, right }) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'row',
        height: 'calc(100vh - 64px)', // matches the admin shell header height
        background: D.bg,
        overflow: 'hidden',
      }}
    >
      {left}
      {center}
      {right}
    </div>
  );
}
