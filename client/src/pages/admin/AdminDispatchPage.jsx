/**
 * <AdminDispatchPage>— top-level dispatcher surface at /admin/dispatch.
 * Eight tabs, all rendered as one centered pill:
 *   - "Board"        — phase 2 dispatch board (map + roster)
 *   - "Schedule"     — DispatchPageV2's schedule grid (default)
 *   - "Protocols"    — DispatchPageV2's Protocols panel
 *   - "Tech Match"   — DispatchPageV2's TechMatchPanel
 *   - "CSR Booking"  — DispatchPageV2's CSRPanel
 *   - "Job Scores"   — DispatchPageV2's RevenuePanel
 *   - "Insights"     — DispatchPageV2's InsightsPanel
 *   - "Automation"   — Auto-Dispatch runs and decision audit
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
import React, {
  Suspense,
  useState,
  useEffect,
  useRef,
  useCallback,
} from "react";
import { useSearchParams } from "react-router-dom";
import {
  CalendarDays,
  CalendarPlus,
  Bot,
  ClipboardList,
  Headphones,
  Lightbulb,
  Map,
  TrendingUp,
} from "lucide-react";
import AdminCommandHeader from "../../components/admin/AdminCommandHeader";
import { getAdminUser } from "../../lib/adminAuth";
import AutoDispatchPage from "./AutoDispatchPage";
import DispatchBoardPage from "./DispatchBoardPage";

const DispatchPageV2 = React.lazy(() => import("./DispatchPageV2"));

const TAB_KEY = "tab";
const TABS = {
  BOARD: "board",
  SCHEDULE: "schedule",
  PROTOCOLS: "protocols",
  MATCH: "match",
  CSR: "csr",
  REVENUE: "revenue",
  INSIGHTS: "insights",
  AUTOMATION: "automation",
};
const TAB_LIST = [
  { key: TABS.BOARD, label: "Board", Icon: Map },
  { key: TABS.SCHEDULE, label: "Schedule", Icon: CalendarDays },
  { key: TABS.PROTOCOLS, label: "Protocols", Icon: ClipboardList },
  {
    key: TABS.MATCH,
    label: "Tech Match",
    Icon: ClipboardList,
    className: "hidden md:inline-flex",
  },
  {
    key: TABS.CSR,
    label: "CSR Booking",
    Icon: Headphones,
    className: "hidden md:inline-flex",
  },
  {
    key: TABS.REVENUE,
    label: "Job Scores",
    Icon: TrendingUp,
    className: "hidden md:inline-flex",
  },
  {
    key: TABS.INSIGHTS,
    label: "Insights",
    Icon: Lightbulb,
    className: "hidden md:inline-flex",
  },
  // Auto-Dispatch is an owner/admin tool — every /api/admin/auto-dispatch
  // endpoint is requireAdmin, so the tab is filtered by role below.
  { key: TABS.AUTOMATION, label: "Automation", Icon: Bot, adminOnly: true },
];

// Top-level tab → DispatchPageV2 internal activeTab. The schedule grid
// inside DispatchPageV2 is keyed as 'board' (legacy), while every other
// sub-tab key matches its top-level key 1:1.
const innerActiveTabFor = (topTab) =>
  topTab === TABS.SCHEDULE ? "board" : topTab;

export default function AdminDispatchPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const isAdmin = getAdminUser()?.role === "admin";
  const visibleTabs = TAB_LIST.filter(({ adminOnly }) => !adminOnly || isAdmin);
  const validTabKeys = visibleTabs.map((t) => t.key);
  const initial = validTabKeys.includes(searchParams.get(TAB_KEY))
    ? searchParams.get(TAB_KEY)
    : TABS.BOARD;
  const [tab, setTab] = useState(initial);

  // DispatchPageV2 owns the "create appointment" state + modal; expose a
  // handle here so the lifted "+ Add Appointment" pill in this header can
  // open it without lifting the state. DispatchPageV2 calls
  // setOpenCreateHandler on mount with its own (() =>setShowNewAppt(true))
  // and clears it on unmount.
  //
  // `createReady` mirrors the ref into render state so the button can
  // disable itself until the lazy-loaded DispatchPageV2 chunk finishes
  // mounting. Without this, a direct load of /admin/dispatch?tab=schedule
  // shows an immediately-clickable button whose clicks silently no-op
  // until the chunk resolves.
  const openCreateRef = useRef(null);
  const [createReady, setCreateReady] = useState(false);
  const setOpenCreateHandler = useCallback((handler) => {
    openCreateRef.current = handler || null;
    setCreateReady(typeof handler === "function");
  }, []);
  const handleAddAppointment = () => openCreateRef.current?.();

  // Keep URL in sync without remount-thrashing the inactive tab content
  // (DispatchPageV2 in particular does its own data fetches).
  useEffect(() => {
    const current = searchParams.get(TAB_KEY);
    if (current !== tab) {
      const next = new URLSearchParams(searchParams);
      next.set(TAB_KEY, tab);
      setSearchParams(next, { replace: true });
    }
  }, [tab]);

  return (
    <div className="flex flex-col bg-surface-page min-h-[calc(100vh-64px)] max-w-[1300px] mx-auto">
      {" "}
      <div>
        {" "}
        <AdminCommandHeader
          title="Schedule"
          icon={CalendarDays}
          sections={visibleTabs}
          activeKey={tab}
          onSectionChange={setTab}
          ariaLabel="Schedule section"
          navGridClassName={
            isAdmin
              ? "grid-cols-2 md:grid-cols-4 xl:grid-cols-8"
              : "grid-cols-2 md:grid-cols-4 xl:grid-cols-7"
          }
          action={
            tab === TABS.SCHEDULE
              ? {
                  label: "Add Appointment",
                  icon: CalendarPlus,
                  onClick: handleAddAppointment,
                  disabled: !createReady,
                }
              : null
          }
        />{" "}
      </div>{" "}
      <div
        aria-label="Schedule content"
        className="flex-1 min-h-0 flex flex-col"
      >
        {tab === TABS.BOARD ? (
          <DispatchBoardPage />
        ) : tab === TABS.AUTOMATION && isAdmin ? (
          <AutoDispatchPage embedded />
        ) : (
          <Suspense
            fallback={
              <div className="text-14 text-ink-tertiary p-10 text-center">
                Loading schedule…
              </div>
            }
          >
            {" "}
            <DispatchPageV2
              activeTab={innerActiveTabFor(tab)}
              setOpenCreateHandler={setOpenCreateHandler}
            />{" "}
          </Suspense>
        )}
      </div>{" "}
    </div>
  );
}
