/**
 * <AdminDispatchPage> — top-level dispatcher surface at /admin/dispatch.
 * Two tabs:
 *   - "Board"    (default) — phase 2 v1 dispatch board (this PR)
 *   - "Schedule"           — existing DispatchPageV2 (the schedule list)
 *
 * Per-tab URL state via ?tab=board|schedule so a dispatcher can refresh
 * or share a link to a specific view. Default = board.
 *
 * Why a tab wrapper at /admin/dispatch (not a sibling /admin/dispatch-board
 * route): one canonical URL space for the dispatcher's primary surface.
 * Two top-level routes would cause context-switch friction and ambiguity
 * in every conversation about "the dispatch page."
 *
 * The legacy /admin/schedule route still works (App.jsx redirect) so
 * existing bookmarks and internal links don't break — they land on
 * the Schedule tab here.
 */
import React, { Suspense, useState, useCallback, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import DispatchBoardPage from './DispatchBoardPage';

const DispatchPageV2 = React.lazy(() => import('./DispatchPageV2'));

const TAB_KEY = 'tab';
const TABS = { BOARD: 'board', SCHEDULE: 'schedule' };

const D = {
  bg: '#0f1923', border: '#334155', text: '#e2e8f0', muted: '#94a3b8',
  active: '#0ea5e9',
};

export default function AdminDispatchPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const initial = searchParams.get(TAB_KEY) === TABS.SCHEDULE ? TABS.SCHEDULE : TABS.BOARD;
  const [tab, setTab] = useState(initial);

  // Keep URL in sync without remount-thrashing the inactive tab content
  // (DispatchPageV2 in particular does its own data fetches).
  useEffect(() => {
    const current = searchParams.get(TAB_KEY);
    if (current !== tab) {
      const next = new URLSearchParams(searchParams);
      next.set(TAB_KEY, tab);
      setSearchParams(next, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  const renderTab = useCallback(
    (label, value) => (
      <button
        key={value}
        type="button"
        onClick={() => setTab(value)}
        style={{
          all: 'unset',
          padding: '10px 16px',
          fontSize: 13,
          fontWeight: 600,
          letterSpacing: 0.5,
          textTransform: 'uppercase',
          color: tab === value ? D.text : D.muted,
          borderBottom: `2px solid ${tab === value ? D.active : 'transparent'}`,
          cursor: 'pointer',
          transition: 'color 0.15s, border-color 0.15s',
        }}
      >
        {label}
      </button>
    ),
    [tab]
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', background: D.bg, minHeight: 'calc(100vh - 64px)' }}>
      <div
        style={{
          display: 'flex',
          gap: 4,
          padding: '0 16px',
          background: D.bg,
          borderBottom: `1px solid ${D.border}`,
          flexShrink: 0,
        }}
      >
        {renderTab('Board', TABS.BOARD)}
        {renderTab('Schedule', TABS.SCHEDULE)}
      </div>
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {tab === TABS.BOARD ? (
          <DispatchBoardPage />
        ) : (
          <Suspense
            fallback={
              <div style={{ color: D.muted, padding: 40, textAlign: 'center' }}>
                Loading schedule…
              </div>
            }
          >
            <DispatchPageV2 />
          </Suspense>
        )}
      </div>
    </div>
  );
}
