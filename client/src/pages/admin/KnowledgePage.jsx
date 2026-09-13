import { useState, useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import useRenderedTabBeacon from "../../hooks/useRenderedTabBeacon";
import {
  Activity,
  ArrowLeft,
  BookOpen,
  Database,
  MessageSquare,
  Search,
} from "lucide-react";
import AdminCommandHeader from "../../components/admin/AdminCommandHeader";
import { UiSurface } from "../../components/ui";
import { adminFetch } from "../../utils/admin-fetch";
import KnowledgeArticleDirectory from "./knowledge/KnowledgeArticleDirectory";
import KnowledgeQuestionDialog from "./knowledge/KnowledgeQuestionDialog";
import KnowledgeRecentQueries from "./knowledge/KnowledgeRecentQueries";
import { ArticleViewer, HealthCheck } from "./knowledge/KnowledgeReader";
import KnowledgeSources from "./knowledge/KnowledgeSources";

const TABS = [
  { key: "articles", label: "Articles", Icon: BookOpen },
  { key: "sources", label: "Sources", Icon: Database },
  { key: "health", label: "Health", Icon: Activity },
  { key: "queries", label: "Recent queries", Icon: Search },
];

// The health endpoint is admin-only server-side (requireAdmin); showing the
// tab to technicians would render a blank panel off its 403.
function staffRole() {
  try {
    return JSON.parse(localStorage.getItem("waves_admin_user") || "null")?.role || null;
  } catch {
    return null;
  }
}

export default function KnowledgePage({ embedded = false }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const availableTabs = staffRole() === "admin"
    ? TABS
    : TABS.filter((item) => item.key !== "health");
  const requestedTab = searchParams.get(embedded ? "wikiTab" : "tab");
  const tab = availableTabs.some(({ key }) => key === requestedTab)
    ? requestedTab
    : "articles";

  // Usage beacon for the leaf that actually RENDERS: this resolution is
  // role-aware (health is admin-only) and falls back to Articles without
  // rewriting the URL. The Knowledge HUB deliberately emits nothing — the
  // mounted child owns the deepest leaf (Codex #2961 r17). Embedded-only:
  // this component has no standalone route.
  useRenderedTabBeacon("/admin/knowledge", embedded ? tab : null, [searchParams]);
  const setTab = (nextTab) => {
    const queryKey = embedded ? "wikiTab" : "tab";
    const next = new URLSearchParams(searchParams);
    if (nextTab === "articles") next.delete(queryKey);
    else next.set(queryKey, nextTab);
    setSearchParams(next, { replace: true });
  };
  const [articles, setArticles] = useState([]);
  const [categoryCounts, setCategoryCounts] = useState({});
  const [articlesLoading, setArticlesLoading] = useState(true);
  const [articlesError, setArticlesError] = useState("");
  const [articlesAttempt, setArticlesAttempt] = useState(0);
  const [search, setSearch] = useState("");
  const [filterCategory, setFilterCategory] = useState("");
  const [selectedArticle, setSelectedArticle] = useState(null);
  const [showQA, setShowQA] = useState(false);
  const [recentQueries, setRecentQueries] = useState([]);
  const [queriesLoading, setQueriesLoading] = useState(true);
  const [queriesError, setQueriesError] = useState("");
  const [queriesAttempt, setQueriesAttempt] = useState(0);

  useEffect(() => {
    if (tab !== "articles") return undefined;

    let active = true;
    let url = "/admin/knowledge?";
    if (search) url += `search=${encodeURIComponent(search)}&`;
    if (filterCategory) url += `category=${filterCategory}&`;

    setArticlesLoading(true);
    setArticlesError("");
    adminFetch(url)
      .then((data) => {
        if (!active) return;
        setArticles(data.articles || []);
        setCategoryCounts(data.categoryCounts || {});
      })
      .catch((requestError) => {
        // A swallowed read left the directory showing "No articles yet", which
        // reads as an empty wiki rather than a failed request.
        if (active) setArticlesError(requestError?.message || "Could not load articles.");
      })
      .finally(() => {
        if (active) setArticlesLoading(false);
      });

    return () => {
      active = false;
    };
  }, [tab, search, filterCategory, articlesAttempt]);

  useEffect(() => {
    if (tab !== "queries") {
      // Arm the loading state for the next visit so the panel cannot paint the
      // empty state, or the previous visit's results, before the read starts.
      setQueriesLoading(true);
      return undefined;
    }

    let active = true;
    setQueriesLoading(true);
    setQueriesError("");
    adminFetch("/admin/knowledge/queries")
      .then((data) => {
        if (active) setRecentQueries(data.queries || []);
      })
      .catch((requestError) => {
        if (active) {
          setQueriesError(requestError?.message || "Could not load recent queries.");
        }
      })
      .finally(() => {
        if (active) setQueriesLoading(false);
      });

    return () => {
      active = false;
    };
  }, [tab, queriesAttempt]);

  const openQuestion = (event) => {
    event.currentTarget.focus({ preventScroll: true });
    setShowQA(true);
  };

  if (selectedArticle) {
    return (
      <UiSurface density="comfortable">
        {" "}
        <AdminCommandHeader
          title="Wiki"
          icon={BookOpen}
          headingLevel={embedded ? 2 : 1}
          sticky={!embedded}
          variant="workspace"
          action={{
            label: "All articles",
            icon: ArrowLeft,
            variant: "secondary",
            onClick: () => setSelectedArticle(null),
          }}
        />{" "}
        <ArticleViewer articleId={selectedArticle} />{" "}
      </UiSurface>
    );
  }

  return (
    <UiSurface density="comfortable">
      {showQA && (
        <KnowledgeQuestionDialog
          open
          onClose={() => setShowQA(false)}
        />
      )}

      <AdminCommandHeader
        title="Wiki"
        icon={BookOpen}
        sections={availableTabs}
        activeKey={tab}
        onSectionChange={setTab}
        headingLevel={embedded ? 2 : 1}
        sticky={!embedded}
        variant="workspace"
        action={{
          label: "Ask a question",
          icon: MessageSquare,
          onClick: openQuestion,
        }}
        navGridClassName="grid-cols-2 md:grid-cols-4"
      />
      {tab === "articles" && (
        <KnowledgeArticleDirectory
          articles={articles}
          categoryCounts={categoryCounts}
          filterCategory={filterCategory}
          loading={articlesLoading}
          error={articlesError}
          onCategoryChange={setFilterCategory}
          onArticleOpen={setSelectedArticle}
          onRetry={() => setArticlesAttempt((value) => value + 1)}
          search={search}
          onSearchChange={setSearch}
        />
      )}

      {/* SOURCES TAB */}
      {tab === "sources" && <KnowledgeSources />}

      {/* HEALTH TAB */}
      {tab === "health" && <HealthCheck />}

      {/* QUERIES TAB */}
      {tab === "queries" && (
        <KnowledgeRecentQueries
          queries={recentQueries}
          loading={queriesLoading}
          error={queriesError}
          onRetry={() => setQueriesAttempt((value) => value + 1)}
        />
      )}
    </UiSurface>
  );
}
