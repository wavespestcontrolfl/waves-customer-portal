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
import React, { Suspense, useState, useCallback, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Tabs, TabList, Tab } from '../../components/ui';
import DispatchBoardPage from './DispatchBoardPage';

const DispatchPageV2 = React.lazy(() => import('./DispatchPageV2'));

const TAB_KEY = 'tab';
const TABS = { BOARD: 'board', SCHEDULE: 'schedule' };

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

  const onValueChange = useCallback((v) => setTab(v), []);

  return (
    <div className="flex flex-col bg-surface-page min-h-[calc(100vh-64px)]">
      <Tabs value={tab} onValueChange={onValueChange}>
        <TabList className="px-4 bg-white">
          <Tab value={TABS.BOARD}>Board</Tab>
          <Tab value={TABS.SCHEDULE}>Schedule</Tab>
        </TabList>
      </Tabs>
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
