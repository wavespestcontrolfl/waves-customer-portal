/**
 * <AgentsHubPage> — unified agent oversight surface at /admin/agents.
 * Tabs rendered as one centered pill:
 *   - "Overview"           — AgentOpsPage (fleet health cards + task queue),
 *                            or the Control center once features.ledger is enabled
 *   - "Dispatch"           — Auto-Dispatch run history and visit decisions
 *   - "Triage & Decisions" — AgentDecisionsPage (shadow decision review)
 *   - "Pending Drafts"     — PendingDraftsTab (owner-approval queue for
 *                            parked message_drafts; approve/revise sends)
 *   - "Shadow Drafts"      — AgentShadowDraftsPage (brand-voice loop:
 *                            silent SMS drafts + nightly judge scores)
 *   - "Models"             — AgentModelsTab (model registry per AI lane +
 *                            Railway env change composer)
 *
 * Per-tab URL state via ?tab=<key>; the URL is the single source of
 * truth (tab derives from useSearchParams on every render), so in-app
 * links that change only the query — e.g. the Overview task queue's
 * "Open Agent Review" actionUrl → ?tab=decisions — switch tabs while
 * the component stays mounted. Default = overview. The legacy
 * /admin/agent-decisions route redirects to ?tab=decisions (App.jsx)
 * so existing bookmarks and server actionUrls keep working.
 *
 * Both pages are imported statically: the hub itself is code-split via
 * App.jsx's lazyWithRetry (which handles stale-chunk reloads after a
 * deploy), so a nested React.lazy here would bypass that retry path
 * for no real chunk-size win — the pages are small.
 *
 * Why a tab wrapper at /admin/agents (not sibling routes): one canonical
 * URL space for agent supervision — upcoming surfaces (shadow SMS drafts,
 * judge scores, agent config) land here as additional tabs rather than
 * scattering across nav sections again.
 *
 * Tier 1 V2 styling for the shell; the embedded pages keep their own
 * Tier 2 styles.
 */
import React, { useState, useRef, useCallback, useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { Activity, Bot, Cpu, LayoutGrid, ListChecks, MessageSquareDashed, MailCheck, DatabaseZap, RefreshCw, Layers } from "lucide-react";
import AdminCommandHeader from "../../components/admin/AdminCommandHeader";
import AgentOpsPage from "./AgentOpsPage";
import AgentDecisionsPage from "./AgentDecisionsPage";
import AgentShadowDraftsPage from "./AgentShadowDraftsPage";
import PendingDraftsTab from "./PendingDraftsTab";
import DataHygienePage from "./DataHygienePage";
import AgentActivityTab from "./AgentActivityTab";
import AgentModelsTab from "./AgentModelsTab";
import AgentControlCenterTab from "./agents/AgentControlCenterTab";
import AgentQueueTab from "./AgentQueueTab";
import AutoDispatchPage from "./AutoDispatchPage";
import { getAdminUser } from "../../lib/adminAuth";
import { adminFetch } from "../../utils/admin-fetch";
import useRenderedTabBeacon from "../../hooks/useRenderedTabBeacon";
import { useHubParams } from "./agents/hubParams";

const TAB_KEY = "tab";
const TABS = {
  OVERVIEW: "overview",
  ACTIVITY: "activity",
  DISPATCH: "dispatch",
  DECISIONS: "decisions",
  DRAFTS: "drafts",
  SHADOW: "shadow",
  HYGIENE: "hygiene",
  MODELS: "models",
  QUEUE: "queue",
};
const TAB_LIST = [
  { key: TABS.OVERVIEW, label: "Overview", Icon: LayoutGrid },
  // Runs (URL key stays "activity" so links and the beacon suite keep
  // working) — GATE_AGENT_ACTIVITY; the tab renders a "not enabled" note
  // while the gate is off (the endpoint answers { available: false }).
  { key: TABS.ACTIVITY, label: "Runs", Icon: Activity },
  { key: TABS.DISPATCH, label: "Dispatch", Icon: Bot, adminOnly: true },
  { key: TABS.DECISIONS, label: "Triage & Decisions", Icon: ListChecks },
  { key: TABS.DRAFTS, label: "Pending Drafts", Icon: MailCheck },
  { key: TABS.SHADOW, label: "Shadow Drafts", Icon: MessageSquareDashed },
  { key: TABS.HYGIENE, label: "Data Hygiene", Icon: DatabaseZap },
  // Models — which model every AI lane runs on today, and the Railway env
  // change that moves it (server/services/model-switchboard.js).
  { key: TABS.MODELS, label: "Models", Icon: Cpu },
];
// GATE_ADMIN_OPS_QUEUE: the Queue tab exists only when the server says the
// gate is on (hub probe), so a dark gate renders nothing new.
const QUEUE_TAB = { key: TABS.QUEUE, label: "Queue", Icon: Layers };
// Tabs that read ?area= get the product-area strip under the tab row
// (AdminCommandHeader's secondary row). Overview joins while it renders the
// Control center (the old Overview does not read the area).
const AREA_TABS = new Set([TABS.MODELS]);
const ALL_AREAS = "all";
function readsArea(tab, controlCenter) {
  return AREA_TABS.has(tab) || (controlCenter && tab === TABS.OVERVIEW);
}

// Overview is the Control center once the ledger phase exists, else the
// fleet-health page it has always been.
function OverviewTab({ controlCenter, areas, setRefreshHandler }) {
  return controlCenter ? <AgentControlCenterTab areas={areas} setRefreshHandler={setRefreshHandler} /> : <AgentOpsPage embedded setRefreshHandler={setRefreshHandler} />;
}

export default function AgentsHubPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const { area, set: setHubParams } = useHubParams();
  // One probe: which gated surfaces exist + the product areas the strip
  // filters by (GET /admin/agents/control/hub). Fails closed to no extras.
  const [hub, setHub] = useState({ features: {}, areas: [] });
  useEffect(() => {
    let disposed = false;
    adminFetch("/admin/agents/control/hub")
      .then((d) => { if (!disposed) setHub({ features: d?.features || {}, areas: Array.isArray(d?.areas) ? d.areas : [] }); })
      .catch(() => { if (!disposed) setHub({ features: {}, areas: [] }); });
    return () => { disposed = true; };
  }, []);
  const queueAvailable = hub.features.queue === true;
  // Keep the gated Control center and admin-only Dispatch oversight together.
  const controlCenter = hub.features.ledger === true;
  const tabList = (queueAvailable ? [...TAB_LIST, QUEUE_TAB] : TAB_LIST)
    .filter(({ adminOnly }) => !adminOnly || getAdminUser()?.role === "admin");
  const validTabs = tabList.map((t) => t.key);
  const paramTab = searchParams.get(TAB_KEY);
  const tab = validTabs.includes(paramTab) ? paramTab : TABS.OVERVIEW;
  const setTab = useCallback(
    (next) => {
      // Re-clicking the active section renders nothing new — skip the URL
      // churn (and the usage beacon it would re-fire).
      if (next === tab) return;
      setSearchParams(
        (current) => {
          const params = new URLSearchParams(current);
          params.set(TAB_KEY, next);
          return params;
        },
        { replace: true }
      );
    },
    [setSearchParams, tab]
  );

  // Usage beacon for the tab that actually RENDERS: an invalid deep link
  // (?tab=typo) falls back to Overview without rewriting the URL, so the
  // layout's raw-query beacon would record a tab that never rendered
  // (Codex #2961 r15).
  useRenderedTabBeacon("/admin/agents", tab, [searchParams]);

  // AgentOpsPage owns its data fetch; expose a handle here so the lifted
  // Refresh pill in this header can trigger it without lifting the state
  // (same pattern as AdminDispatchPage's setOpenCreateHandler). The page
  // re-registers on each loading transition so the pill can show busy
  // state, and clears the handler on unmount.
  const refreshRef = useRef(null);
  const [refreshState, setRefreshState] = useState({
    ready: false,
    busy: false,
  });
  const setRefreshHandler = useCallback((handler, busy = false) => {
    refreshRef.current = handler || null;
    setRefreshState({ ready: typeof handler === "function", busy });
  }, []);
  const handleRefresh = () => refreshRef.current?.();

  const showAreas = readsArea(tab, controlCenter) && hub.areas.length > 0;
  const areaSections = showAreas ? [{ key: ALL_AREAS, label: "All areas" }, ...hub.areas.map((a) => ({ key: a.key, label: a.label }))] : [];
  const activeArea = hub.areas.some((a) => a.key === area) ? area : ALL_AREAS;

  return (
    <div className="flex flex-col bg-surface-page min-h-[calc(100vh-64px)] max-w-[1300px] mx-auto">
      <AdminCommandHeader
        title="Agents"
        icon={Bot}
        sections={tabList}
        activeKey={tab}
        onSectionChange={setTab}
        ariaLabel="Agents section"
        navGridClassName={queueAvailable ? "grid-cols-2 md:grid-cols-4 xl:grid-cols-9" : "grid-cols-2 md:grid-cols-4 xl:grid-cols-8"}
        secondarySections={areaSections}
        secondaryActiveKey={activeArea}
        onSecondaryChange={(key) => setHubParams({ area: key === ALL_AREAS ? null : key })}
        secondaryAriaLabel="Product area"
        secondaryNavGridClassName="grid-cols-2 md:grid-cols-4 lg:grid-cols-7"
        action={
          tab === TABS.OVERVIEW || tab === TABS.MODELS
            ? {
                label: refreshState.busy ? "Refreshing" : "Refresh",
                icon: RefreshCw,
                onClick: handleRefresh,
                disabled: !refreshState.ready || refreshState.busy,
              }
            : null
        }
      />
      <div aria-label="Agents content" className="flex-1 min-h-0 flex flex-col">
        {tab === TABS.OVERVIEW ? (
          <OverviewTab controlCenter={controlCenter} areas={hub.areas} setRefreshHandler={setRefreshHandler} />
        ) : tab === TABS.ACTIVITY ? (
          <AgentActivityTab />
        ) : tab === TABS.DISPATCH ? (
          <AutoDispatchPage embedded />
        ) : tab === TABS.DECISIONS ? (
          <AgentDecisionsPage embedded />
        ) : tab === TABS.DRAFTS ? (
          <PendingDraftsTab embedded />
        ) : tab === TABS.SHADOW ? (
          <AgentShadowDraftsPage embedded />
        ) : tab === TABS.MODELS ? (
          <AgentModelsTab setRefreshHandler={setRefreshHandler} />
        ) : tab === TABS.QUEUE ? (
          <AgentQueueTab embedded />
        ) : (
          <DataHygienePage embedded />
        )}
      </div>
    </div>
  );
}
