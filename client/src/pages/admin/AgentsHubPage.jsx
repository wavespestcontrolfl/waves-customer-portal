/**
 * <AgentsHubPage> — unified agent oversight surface at /admin/agents.
 * Two tabs rendered as one centered pill:
 *   - "Overview"           — AgentOpsPage (fleet health cards + task queue)
 *   - "Triage & Decisions" — AgentDecisionsPage (shadow decision review)
 *
 * Per-tab URL state via ?tab=<key>. Default = overview. The legacy
 * /admin/agent-decisions route redirects to ?tab=decisions (App.jsx)
 * so existing bookmarks and server actionUrls keep working.
 *
 * Why a tab wrapper at /admin/agents (not sibling routes): one canonical
 * URL space for agent supervision — upcoming surfaces (shadow SMS drafts,
 * judge scores, agent config) land here as additional tabs rather than
 * scattering across nav sections again.
 *
 * Tier 1 V2 styling for the shell; the embedded pages keep their own
 * Tier 2 styles.
 */
import React, {
  Suspense,
  useState,
  useEffect,
  useRef,
  useCallback,
} from "react";
import { useSearchParams } from "react-router-dom";
import { Bot, LayoutGrid, ListChecks, RefreshCw } from "lucide-react";
import AdminCommandHeader from "../../components/admin/AdminCommandHeader";

const AgentOpsPage = React.lazy(() => import("./AgentOpsPage"));
const AgentDecisionsPage = React.lazy(() => import("./AgentDecisionsPage"));

const TAB_KEY = "tab";
const TABS = {
  OVERVIEW: "overview",
  DECISIONS: "decisions",
};
const TAB_LIST = [
  { key: TABS.OVERVIEW, label: "Overview", Icon: LayoutGrid },
  { key: TABS.DECISIONS, label: "Triage & Decisions", Icon: ListChecks },
];
const VALID_TABS = TAB_LIST.map((t) => t.key);

export default function AgentsHubPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const initial = VALID_TABS.includes(searchParams.get(TAB_KEY))
    ? searchParams.get(TAB_KEY)
    : TABS.OVERVIEW;
  const [tab, setTab] = useState(initial);

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

  // Keep URL in sync without remount-thrashing the active tab content
  // (both embedded pages do their own data fetches).
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
    <div className="flex flex-col bg-surface-page min-h-[calc(100vh-64px)] max-w-[1300px] mx-auto">
      <AdminCommandHeader
        title="Agents"
        icon={Bot}
        sections={TAB_LIST}
        activeKey={tab}
        onSectionChange={setTab}
        ariaLabel="Agents section"
        navGridClassName="grid-cols-2"
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
        <Suspense
          fallback={
            <div className="text-14 text-ink-tertiary p-10 text-center">
              Loading agents…
            </div>
          }
        >
          {tab === TABS.OVERVIEW ? (
            <AgentOpsPage embedded setRefreshHandler={setRefreshHandler} />
          ) : (
            <AgentDecisionsPage embedded />
          )}
        </Suspense>
      </div>
    </div>
  );
}
