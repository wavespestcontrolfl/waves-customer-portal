/**
 * <AgentsHubPage> — unified agent oversight surface at /admin/agents.
 * Three tabs rendered as one centered pill:
 *   - "Overview"           — AgentOpsPage (fleet health cards + task queue)
 *   - "Triage & Decisions" — AgentDecisionsPage (shadow decision review)
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
import React, { useState, useRef, useCallback } from "react";
import { useSearchParams } from "react-router-dom";
import { Bot, LayoutGrid, ListChecks, MessageSquareDashed, DatabaseZap, RefreshCw } from "lucide-react";
import AdminCommandHeader from "../../components/admin/AdminCommandHeader";
import AgentOpsPage from "./AgentOpsPage";
import AgentDecisionsPage from "./AgentDecisionsPage";
import AgentShadowDraftsPage from "./AgentShadowDraftsPage";
import DataHygienePage from "./DataHygienePage";

const TAB_KEY = "tab";
const TABS = {
  OVERVIEW: "overview",
  DECISIONS: "decisions",
  SHADOW: "shadow",
  HYGIENE: "hygiene",
};
const TAB_LIST = [
  { key: TABS.OVERVIEW, label: "Overview", Icon: LayoutGrid },
  { key: TABS.DECISIONS, label: "Triage & Decisions", Icon: ListChecks },
  { key: TABS.SHADOW, label: "Shadow Drafts", Icon: MessageSquareDashed },
  { key: TABS.HYGIENE, label: "Data Hygiene", Icon: DatabaseZap },
];
const VALID_TABS = TAB_LIST.map((t) => t.key);

export default function AgentsHubPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const paramTab = searchParams.get(TAB_KEY);
  const tab = VALID_TABS.includes(paramTab) ? paramTab : TABS.OVERVIEW;
  const setTab = useCallback(
    (next) => {
      setSearchParams(
        (current) => {
          const params = new URLSearchParams(current);
          params.set(TAB_KEY, next);
          return params;
        },
        { replace: true }
      );
    },
    [setSearchParams]
  );

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
        sections={TAB_LIST}
        activeKey={tab}
        onSectionChange={setTab}
        ariaLabel="Agents section"
        navGridClassName="grid-cols-4"
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
        ) : tab === TABS.DECISIONS ? (
          <AgentDecisionsPage embedded />
        ) : tab === TABS.SHADOW ? (
          <AgentShadowDraftsPage embedded />
        ) : (
          <DataHygienePage embedded />
        )}
      </div>
    </div>
  );
}
