/**
 * <AdminDispatchPage> — top-level dispatcher surface at /admin/dispatch.
 * Seven tabs, all rendered as one centered pill:
 *   - "Board"        — phase 2 dispatch board (map + roster)
 *   - "Schedule"     — DispatchPageV2's schedule grid (default)
 *   - "Protocols"    — DispatchPageV2's Protocols panel
 *   - "Tech Match"   — DispatchPageV2's TechMatchPanel
 *   - "CSR Booking"  — DispatchPageV2's CSRPanel
 *   - "Job Scores"   — DispatchPageV2's RevenuePanel
 *   - "Insights"     — DispatchPageV2's InsightsPanel
 *
 * Per-tab URL state via ?tab=<key>. Default = board. Tabs that route into
 * DispatchPageV2 pass `activeTab` so its internal tab strip can stay
 * hidden (the top-level pill replaces it).
 *
 * Why a tab wrapper at /admin/dispatch (not sibling routes): one canonical
 * URL space for the dispatcher's primary surface — two top-level routes
 * would cause context-switch friction.
 *
 * The legacy /admin/schedule route still works (App.jsx redirect) so
 * existing bookmarks land on the Schedule tab.
 *
 * Tier 1 V2 styling.
 */
import React, { Suspense, useState, useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import DispatchBoardPage from './DispatchBoardPage';

const DispatchPageV2 = React.lazy(() => import('./DispatchPageV2'));

const TAB_KEY = 'tab';
const TABS = {
  BOARD: 'board',
  SCHEDULE: 'schedule',
  PROTOCOLS: 'protocols',
  MATCH: 'match',
  CSR: 'csr',
  REVENUE: 'revenue',
  INSIGHTS: 'insights',
};
const TAB_LIST = [
  { key: TABS.BOARD, label: 'Board' },
  { key: TABS.SCHEDULE, label: 'Schedule' },
  { key: TABS.PROTOCOLS, label: 'Protocols' },
  { key: TABS.MATCH, label: 'Tech Match' },
  { key: TABS.CSR, label: 'CSR Booking' },
  { key: TABS.REVENUE, label: 'Job Scores' },
  { key: TABS.INSIGHTS, label: 'Insights' },
];
const VALID_TABS = TAB_LIST.map((t) => t.key);

// Top-level tab → DispatchPageV2 internal activeTab. The schedule grid
// inside DispatchPageV2 is keyed as 'board' (legacy), while every other
// sub-tab key matches its top-level key 1:1.
const innerActiveTabFor = (topTab) => (topTab === TABS.SCHEDULE ? 'board' : topTab);

export default function AdminDispatchPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const initial = VALID_TABS.includes(searchParams.get(TAB_KEY)) ? searchParams.get(TAB_KEY) : TABS.BOARD;
  const [tab, setTab] = useState(initial);
  const tabRefs = useRef({});

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

  // Roving-tabindex arrow-key navigation. With tabIndex={active ? 0 : -1}
  // the inactive tab is out of the document tab order, so keyboard users
  // need ←/→/Home/End to switch between tabs (per the WAI-ARIA tabs
  // pattern). Activates the new tab on focus so the panel updates too.
  const onTabKeyDown = (e) => {
    const idx = TAB_LIST.findIndex((t) => t.key === tab);
    if (idx < 0) return;
    let nextIdx = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      nextIdx = (idx + 1) % TAB_LIST.length;
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      nextIdx = (idx - 1 + TAB_LIST.length) % TAB_LIST.length;
    } else if (e.key === 'Home') {
      nextIdx = 0;
    } else if (e.key === 'End') {
      nextIdx = TAB_LIST.length - 1;
    }
    if (nextIdx == null) return;
    e.preventDefault();
    const nextKey = TAB_LIST[nextIdx].key;
    setTab(nextKey);
    tabRefs.current[nextKey]?.focus();
  };

  // Shared tab pill — mirrors the Leads/Estimates/Create/Pricing pattern
  // (EstimatesPageV2). ARIA roles + aria-selected are set directly here
  // since we're not using the components/ui Tabs primitive.
  const tabPill = (
    <div
      role="tablist"
      aria-label="Dispatch view"
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
            id={`dispatch-tab-${t.key}`}
            ref={(el) => { tabRefs.current[t.key] = el; }}
            type="button"
            role="tab"
            aria-selected={active}
            aria-controls={`dispatch-tabpanel-${t.key}`}
            tabIndex={active ? 0 : -1}
            onClick={() => setTab(t.key)}
            onKeyDown={onTabKeyDown}
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
  );

  return (
    <div className="flex flex-col bg-surface-page min-h-[calc(100vh-64px)]">
      {/* Page heading + tab pill — the "Schedule" h1 used to live inside
          DispatchPageV2's header, which made it impossible to put the pill
          below it without swapping DOM parents (and unmounting the pill on
          tab switches). Lifting the heading here keeps the pill in one
          stable parent on both tabs while still rendering the heading
          immediately above it on Schedule. */}
      {/* Centered tab pill — page-level navigation. The "Schedule" h1 lives
          inside DispatchPageV2's header (alongside the "+ Add Appointment"
          pill on the right) per the standard admin h1 + action-button
          pattern; AdminDispatchPage owns only the pill. */}
      <div className="px-4 md:px-6 pt-4 md:pt-6 pb-2 flex justify-center">
        {tabPill}
      </div>
      <div
        role="tabpanel"
        id={`dispatch-tabpanel-${tab}`}
        aria-labelledby={`dispatch-tab-${tab}`}
        className="flex-1 min-h-0 flex flex-col"
      >
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
            <DispatchPageV2 activeTab={innerActiveTabFor(tab)} />
          </Suspense>
        )}
      </div>
    </div>
  );
}
