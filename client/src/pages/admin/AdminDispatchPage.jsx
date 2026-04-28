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
 *
 * Tier 1 V2 styling: uses the components/ui Tabs primitive + zinc
 * surfaces, no inline D palette.
 */
import React, { Suspense, useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import DispatchBoardPage from './DispatchBoardPage';

const DispatchPageV2 = React.lazy(() => import('./DispatchPageV2'));

const TAB_KEY = 'tab';
const TABS = { BOARD: 'board', SCHEDULE: 'schedule' };
const TAB_LIST = [
  { key: TABS.BOARD, label: 'Board' },
  { key: TABS.SCHEDULE, label: 'Schedule' },
];

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

  return (
    <div className="flex flex-col bg-surface-page min-h-[calc(100vh-64px)]">
      {/* Centered Pipeline-page tab strip — mirrors the
          Leads/Estimates/Create/Pricing pill (EstimatesPageV2) so
          the dispatcher's two top-level views read consistently with
          the rest of the admin shell. */}
      <div style={{ display: 'flex', justifyContent: 'center', padding: '12px 16px' }}>
        <div
          style={{
            display: 'inline-flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            gap: 4,
            background: '#F4F4F5',
            borderRadius: 10,
            padding: 4,
            border: '1px solid #E4E4E7',
          }}
        >
          {TAB_LIST.map((t) => {
            const active = tab === t.key;
            return (
              <button
                key={t.key}
                type="button"
                onClick={() => setTab(t.key)}
                style={{
                  padding: '10px 24px',
                  borderRadius: 8,
                  border: 'none',
                  cursor: 'pointer',
                  background: active ? '#18181B' : 'transparent',
                  color: active ? '#FFFFFF' : '#A1A1AA',
                  fontSize: 14,
                  fontWeight: 700,
                  transition: 'all 0.2s',
                  fontFamily: "'DM Sans', sans-serif",
                }}
              >
                {t.label}
              </button>
            );
          })}
        </div>
      </div>
      <div className="flex-1 min-h-0 flex flex-col">
        {tab === TABS.BOARD ? (
          <DispatchBoardPage />
        ) : (
          <Suspense
            fallback={
              <div className="text-14 text-ink-tertiary p-10 text-center">
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
