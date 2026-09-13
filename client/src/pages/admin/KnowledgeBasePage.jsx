import { useCallback, useEffect, useRef, useState } from "react";
import { useOutletContext, useSearchParams } from "react-router-dom";
import { BookOpen, Brain, Gauge, Plus, ShieldCheck, Sprout } from "lucide-react";
import AdminCommandHeader from "../../components/admin/AdminCommandHeader";
import { ActionFeedback, UiSurface } from "../../components/ui";
import useRenderedTabBeacon from "../../hooks/useRenderedTabBeacon";
import { getAdminUser } from "../../lib/adminAuth";
import { adminFetch } from "../../utils/admin-fetch";
import AuditTab from "./knowledge-base/AuditTab";
import BrowseTab from "./knowledge-base/BrowseTab";
import CreateTab from "./knowledge-base/CreateTab";
import FieldIntelligenceTab from "./knowledge-base/FieldIntelligenceTab";
import KnowledgeBaseStats from "./knowledge-base/KnowledgeBaseStats";
import TokensTab from "./knowledge-base/TokensTab";

const KB_TAB_KEYS = new Set(["browse", "create", "field", "audit", "tokens"]);

function knowledgeBaseTabs(isMobile, isAdminRole) {
  const tabs = [
    {
      key: "browse",
      label: isMobile ? "Browse" : "Browse & search",
      Icon: BookOpen,
    },
    { key: "create", label: isMobile ? "New" : "New entry", Icon: Plus },
    {
      key: "field",
      label: isMobile ? "Field intel" : "Field intelligence",
      Icon: Sprout,
    },
  ];
  if (isAdminRole) {
    tabs.push(
      { key: "audit", label: "AI audit", Icon: ShieldCheck },
      { key: "tokens", label: isMobile ? "Tokens" : "Token health", Icon: Gauge },
    );
  }
  return tabs;
}

function staffRole() {
  return getAdminUser()?.role || null;
}

function useIsMobile(breakpoint = 768) {
  const [isMobile, setIsMobile] = useState(
    typeof window !== "undefined" && window.innerWidth < breakpoint,
  );

  useEffect(() => {
    const media = window.matchMedia(`(max-width: ${breakpoint - 1}px)`);
    const handleChange = (event) => setIsMobile(event.matches);
    media.addEventListener("change", handleChange);
    return () => media.removeEventListener("change", handleChange);
  }, [breakpoint]);

  return isMobile;
}

export default function KnowledgeBasePage({ embedded = false }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const outletContext = useOutletContext();
  const isAdminRole = outletContext?.user?.role === "admin";
  const isMobile = useIsMobile();
  const queryKey = embedded ? "kbTab" : "tab";
  const requestedTab = searchParams.get(queryKey);
  const allowedTab = KB_TAB_KEYS.has(requestedTab)
    && (isAdminRole || !["audit", "tokens"].includes(requestedTab));
  const tab = allowedTab ? requestedTab : "browse";

  useRenderedTabBeacon("/admin/knowledge", embedded ? tab : null, [searchParams]);

  const [stats, setStats] = useState(null);
  const [statsLoading, setStatsLoading] = useState(true);
  const [statsError, setStatsError] = useState("");
  const [feedback, setFeedback] = useState(null);
  const feedbackTimer = useRef(null);

  const setTab = (nextTab) => {
    const next = new URLSearchParams(searchParams);
    if (nextTab === "browse") next.delete(queryKey);
    else next.set(queryKey, nextTab);
    setSearchParams(next, { replace: true });
  };

  const loadStats = useCallback(async () => {
    setStatsLoading(true);
    setStatsError("");
    try {
      setStats(await adminFetch("/admin/kb/stats"));
    } catch {
      setStats(null);
      setStatsError("Knowledge base totals could not be loaded.");
    } finally {
      setStatsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadStats();
  }, [loadStats]);

  useEffect(() => () => clearTimeout(feedbackTimer.current), []);

  const showFeedback = useCallback((message, error = false) => {
    clearTimeout(feedbackTimer.current);
    setFeedback({ message, error });
    feedbackTimer.current = setTimeout(() => setFeedback(null), 3500);
  }, []);

  const tabs = knowledgeBaseTabs(isMobile, isAdminRole);

  return (
    <UiSurface
      density="comfortable"
      className="mx-auto max-w-[1300px] text-ui-body text-ink-primary"
    >
      <AdminCommandHeader
        title="Knowledge base"
        icon={Brain}
        sections={tabs}
        activeKey={tab}
        onSectionChange={setTab}
        headingLevel={embedded ? 2 : 1}
        sticky={!embedded}
        variant="workspace"
        navGridClassName="grid-cols-2 md:grid-cols-5"
      />

      {feedback && (
        // Fixed like the pre-migration toast: actions fire well below the
        // header on long entry/detail views, and the page does not scroll on
        // completion, so in-flow feedback above the stats can go unseen.
        <div className="pointer-events-none fixed bottom-5 right-5 z-[300] max-w-sm rounded-md border-hairline border-zinc-200 bg-white px-4 py-3 shadow-lg">
          <ActionFeedback error={feedback.error}>{feedback.message}</ActionFeedback>
        </div>
      )}

      <KnowledgeBaseStats
        stats={stats}
        loading={statsLoading}
        error={statsError}
        onRetry={loadStats}
      />

      {tab === "browse" && (
        <BrowseTab
          showFeedback={showFeedback}
          onRefresh={loadStats}
          isMobile={isMobile}
        />
      )}
      {tab === "create" && (
        <CreateTab
          showFeedback={showFeedback}
          onCreated={() => {
            loadStats();
            setTab("browse");
          }}
          isMobile={isMobile}
        />
      )}
      {tab === "field" && (
        <FieldIntelligenceTab
          showFeedback={showFeedback}
          isMobile={isMobile}
          canRegenerate={staffRole() === "admin"}
          canReviewQueue={isAdminRole}
        />
      )}
      {tab === "audit" && (
        <AuditTab showFeedback={showFeedback} onRefresh={loadStats} />
      )}
      {tab === "tokens" && (
        <TokensTab showFeedback={showFeedback} />
      )}
    </UiSurface>
  );
}
