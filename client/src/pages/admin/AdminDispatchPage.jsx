/**
 * <AdminDispatchPage>— top-level dispatcher surface at /admin/dispatch.
 * Dispatch workspaces, rendered as one centered pill:
 *   - "Board"        — phase 2 dispatch board (map + roster)
 *   - "Schedule"     — DispatchPageV2's schedule grid
 *   - "Protocols"    — DispatchPageV2's Protocols panel
 *   - "Tech Match"   — DispatchPageV2's TechMatchPanel
 *   - "CSR Booking"  — DispatchPageV2's CSRPanel
 *   - "Job Scores"   — DispatchPageV2's RevenuePanel
 *   - "Insights"     — DispatchPageV2's InsightsPanel
 * Auto-Dispatch runs in the background; old diagnostic links still redirect.
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
  useRef,
  useEffect,
  useCallback,
} from "react";
import { useSearchParams } from "react-router-dom";
import {
  CalendarDays,
  CalendarPlus,
  ClipboardList,
  Gauge,
  Headphones,
  Lightbulb,
  Map,
  TrendingUp,
} from "lucide-react";
import AdminCommandHeader from "../../components/admin/AdminCommandHeader";
import useRenderedTabBeacon from "../../hooks/useRenderedTabBeacon";
import { getAdminUser } from "../../lib/adminAuth";
import { adminFetch } from "../../lib/adminFetch";
import AdminTabRedirect from "../../components/admin/AdminTabRedirect";
import DispatchBoardPage from "./DispatchBoardPage";
import DayScorecardPanel from "../../components/dispatch/DayScorecardPanel";

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
  SCORECARD: "scorecard",
};
const TAB_LIST = [
  { key: TABS.BOARD, label: "Board", Icon: Map },
  { key: TABS.SCHEDULE, label: "Schedule", Icon: CalendarDays },
  { key: TABS.PROTOCOLS, label: "Protocols", Icon: ClipboardList },
  {
    key: TABS.MATCH,
    label: "Matching",
    Icon: ClipboardList,
  },
  {
    key: TABS.CSR,
    label: "Booking",
    Icon: Headphones,
  },
  {
    key: TABS.REVENUE,
    label: "Scores",
    Icon: TrendingUp,
  },
  {
    key: TABS.INSIGHTS,
    label: "Insights",
    Icon: Lightbulb,
  },
];
// GATE_ROUTE_SCORECARD (admin-only, read-only): appended only once the
// gate's own /status endpoint confirms it's on — never rendered as a dead
// tab for a customer-visible build with the gate off.
const SCORECARD_TAB = { key: TABS.SCORECARD, label: "Scorecard", Icon: Gauge };

// Top-level tab → DispatchPageV2 internal activeTab. The schedule grid
// inside DispatchPageV2 is keyed as 'board' (legacy), while every other
// sub-tab key matches its top-level key 1:1.
const innerActiveTabFor = (topTab) =>
  topTab === TABS.SCHEDULE ? "board" : topTab;

export default function AdminDispatchPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const isAdmin = getAdminUser()?.role === "admin";

  // GATE_ROUTE_SCORECARD: admin-only, so a technician never fires the
  // request. Off (or the request fails) simply keeps the tab absent —
  // byte-identical to this page before the scorecard existed.
  const [scorecardStatus, setScorecardStatus] = useState("pending");
  useEffect(() => {
    if (!isAdmin) return undefined;
    let active = true;
    adminFetch("/admin/route-scorecard/status")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => { if (active) setScorecardStatus(data?.enabled ? "on" : "off"); })
      .catch(() => { if (active) setScorecardStatus("off"); });
    return () => { active = false; };
  }, [isAdmin]);
  const scorecardEnabled = scorecardStatus === "on";
  // A direct ?tab=scorecard load stays unresolved until /status settles
  // (Codex P2): resolving it to Board first would render the wrong
  // workspace and fire an authoritative Board beacon that can flush before
  // the enabled response switches to Scorecard — two page views. Only an
  // admin ever resolves the gate; anyone else falls back as before.
  const scorecardDeepLinkPending = isAdmin && scorecardStatus === "pending"
    && searchParams.get(TAB_KEY) === TABS.SCORECARD;
  const tabList = scorecardEnabled ? [...TAB_LIST, SCORECARD_TAB] : TAB_LIST;
  const navGridClassName = `grid-cols-2 md:grid-cols-4 ${scorecardEnabled ? "xl:grid-cols-8" : "xl:grid-cols-7"}`;

  const validTabKeys = tabList.map((t) => t.key);
  const resolvedTab = validTabKeys.includes(searchParams.get(TAB_KEY))
    ? searchParams.get(TAB_KEY)
    : TABS.BOARD;
  // null while a scorecard deep link is unresolved = nothing rendered yet
  // (no active section, no beacon, a loading placeholder below).
  const tab = scorecardDeepLinkPending ? null : resolvedTab;
  const setTab = (nextTab) => {
    const next = new URLSearchParams(searchParams);
    next.set(TAB_KEY, nextTab);
    setSearchParams(next, { replace: true });
  };

  // Report the tab that actually renders, including a tabless/invalid URL's
  // Board fallback. Tab selection follows the URL on every navigation.
  useRenderedTabBeacon("/admin/dispatch", tab, [searchParams]);

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

  if (isAdmin && searchParams.get(TAB_KEY) === "automation") {
    return <AdminTabRedirect to="/admin/agents" tab="dispatch" />;
  }

  return (
    <div className="flex flex-col bg-surface-page min-h-[calc(100vh-64px)] max-w-[1300px] mx-auto">
      {" "}
      <div>
        {" "}
        <AdminCommandHeader
          title="Schedule"
          icon={CalendarDays}
          sections={tabList}
          activeKey={tab}
          onSectionChange={setTab}
          ariaLabel="Schedule section"
          navGridClassName={navGridClassName}
          actions={[
            ...(tab === TABS.SCHEDULE ? [{
                  label: "Add Appointment",
                  icon: CalendarPlus,
                  onClick: handleAddAppointment,
                  disabled: !createReady,
                }] : []),
          ]}
        />{" "}
      </div>{" "}
      <div
        aria-label="Schedule content"
        className="flex-1 min-h-0 flex flex-col"
      >
        {tab == null ? (
          <div role="status" className="text-14 text-ink-tertiary p-10 text-center">
            Loading schedule…
          </div>
        ) : tab === TABS.BOARD ? (
          <DispatchBoardPage />
        ) : tab === TABS.SCORECARD ? (
          <div className="p-4">
            <DayScorecardPanel />
          </div>
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
