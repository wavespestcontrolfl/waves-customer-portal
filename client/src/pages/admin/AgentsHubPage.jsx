/**
 * <AgentsHubPage> — unified agent oversight surface at /admin/agents.
 * Tabs rendered as one centered pill:
 *   - "Overview"           — AgentOpsPage (fleet health cards + task queue)
 *   - "Triage & Decisions" — AgentDecisionsPage (shadow decision review)
 *   - "Pending Drafts"     — PendingDraftsTab (owner-approval queue for
 *                            parked message_drafts; approve/revise sends)
 *   - "Shadow Drafts"      — AgentShadowDraftsPage (brand-voice loop:
 *                            silent SMS drafts + nightly judge scores)
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
import { Activity, Bot, LayoutGrid, ListChecks, MessageSquareDashed, MailCheck, DatabaseZap, RefreshCw, Layers } from "lucide-react";
import AdminCommandHeader from "../../components/admin/AdminCommandHeader";
import AgentOpsPage from "./AgentOpsPage";
import AgentDecisionsPage from "./AgentDecisionsPage";
import AgentShadowDraftsPage from "./AgentShadowDraftsPage";
import PendingDraftsTab from "./PendingDraftsTab";
import DataHygienePage from "./DataHygienePage";
import AgentActivityTab from "./AgentActivityTab";
import AgentQueueTab from "./AgentQueueTab";
import { adminFetch } from "../../utils/admin-fetch";
import useRenderedTabBeacon from "../../hooks/useRenderedTabBeacon";

const TAB_KEY = "tab";
const TABS = {
  OVERVIEW: "overview",
  ACTIVITY: "activity",
  DECISIONS: "decisions",
  DRAFTS: "drafts",
  SHADOW: "shadow",
  HYGIENE: "hygiene",
  QUEUE: "queue",
};
const TAB_LIST = [
  { key: TABS.OVERVIEW, label: "Overview", Icon: LayoutGrid },
  // Activity — GATE_AGENT_ACTIVITY; the tab renders a "not enabled" note
  // while the gate is off (the endpoint answers { available: false }).
  { key: TABS.ACTIVITY, label: "Activity", Icon: Activity },
  { key: TABS.DECISIONS, label: "Triage & Decisions", Icon: ListChecks },
  { key: TABS.DRAFTS, label: "Pending Drafts", Icon: MailCheck },
  { key: TABS.SHADOW, label: "Shadow Drafts", Icon: MessageSquareDashed },
  { key: TABS.HYGIENE, label: "Data Hygiene", Icon: DatabaseZap },
];
// GATE_ADMIN_OPS_QUEUE: the Queue tab exists only when the server says the
// gate is on (availability probe), so a dark gate renders nothing new.
const QUEUE_TAB = { key: TABS.QUEUE, label: "Queue", Icon: Layers };

export default function AgentsHubPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [queueAvailable, setQueueAvailable] = useState(false);
  useEffect(() => {
    let disposed = false;
    adminFetch("/admin/agents/queue/availability")
      .then((d) => { if (!disposed) setQueueAvailable(d?.available === true); })
      .catch(() => { if (!disposed) setQueueAvailable(false); });
    return () => { disposed = true; };
  }, []);
  const tabList = queueAvailable ? [...TAB_LIST, QUEUE_TAB] : TAB_LIST;
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

  return (
    <div className="flex flex-col bg-surface-page min-h-[calc(100vh-64px)] max-w-[1300px] mx-auto">
      <AdminCommandHeader
        title="Agents"
        icon={Bot}
        sections={tabList}
        activeKey={tab}
        onSectionChange={setTab}
        ariaLabel="Agents section"
        navGridClassName={queueAvailable ? "grid-cols-2 md:grid-cols-7" : "grid-cols-2 md:grid-cols-6"}
        action={
          tab === TABS.OVERVIEW
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
          <AgentOpsPage embedded setRefreshHandler={setRefreshHandler} />
        ) : tab === TABS.ACTIVITY ? (
          <AgentActivityTab />
        ) : tab === TABS.DECISIONS ? (
          <AgentDecisionsPage embedded />
        ) : tab === TABS.DRAFTS ? (
          <PendingDraftsTab embedded />
        ) : tab === TABS.SHADOW ? (
          <AgentShadowDraftsPage embedded />
        ) : tab === TABS.QUEUE ? (
          <AgentQueueTab embedded />
        ) : (
          <DataHygienePage embedded />
        )}
      </div>
    </div>
  );
}
