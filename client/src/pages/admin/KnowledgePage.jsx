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
import KnowledgeQuestionDialog from "./knowledge/KnowledgeQuestionDialog";
import { ArticleViewer, HealthCheck } from "./knowledge/KnowledgeReader";
import KnowledgeSources from "./knowledge/KnowledgeSources";

const API_BASE = import.meta.env.VITE_API_URL || "/api";
// V2 token pass: teal/purple/orange fold to zinc-900. Semantic green/amber/red preserved.
const D = {
  bg: "#F4F4F5",
  card: "#FFFFFF",
  border: "#E4E4E7",
  teal: "#18181B",
  green: "#15803D",
  amber: "#A16207",
  red: "#991B1B",
  orange: "#18181B",
  text: "#27272A",
  muted: "#71717A",
  white: "#FFFFFF",
  purple: "#18181B",
  heading: "#09090B",
  inputBorder: "#D4D4D8",
};
const MONO = "'JetBrains Mono', monospace";

function adminFetch(path) {
  return fetch(`${API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${localStorage.getItem("waves_admin_token")}`,
      "Content-Type": "application/json",
    },
  }).then((r) => r.json());
}
function Card({ children, style }) {
  return (
    <div
      style={{
        background: D.card,
        border: `1px solid ${D.border}`,
        borderRadius: 12,
        padding: 24,
        ...style,
      }}
    >
      {children}
    </div>
  );
}


// =========================================================================
// MAIN PAGE
// =========================================================================
const TABS = [
  { key: "articles", label: "Articles", Icon: BookOpen },
  { key: "sources", label: "Sources", Icon: Database },
  { key: "health", label: "Health", Icon: Activity },
  { key: "queries", label: "Recent Queries", Icon: Search },
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
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [filterCat, setFilterCat] = useState("");
  const [selectedArticle, setSelectedArticle] = useState(null);
  const [showQA, setShowQA] = useState(false);
  const [recentQueries, setRecentQueries] = useState([]);

  useEffect(() => {
    if (tab === "articles") {
      setLoading(true);
      let url = "/admin/knowledge?";
      if (search) url += `search=${encodeURIComponent(search)}&`;
      if (filterCat) url += `category=${filterCat}&`;
      adminFetch(url)
        .then((d) => {
          setArticles(d.articles || []);
          setCategoryCounts(d.categoryCounts || {});
          setLoading(false);
        })
        .catch(() => setLoading(false));
    }
    if (tab === "queries") {
      adminFetch("/admin/knowledge/queries").then((d) =>
        setRecentQueries(d.queries || []),
      );
    }
  }, [tab, search, filterCat]);

  const openQuestion = (event) => {
    event.currentTarget.focus({ preventScroll: true });
    setShowQA(true);
  };

  if (selectedArticle) {
    return (
      <div>
        {" "}
        <AdminCommandHeader
          title="Wiki"
          icon={BookOpen}
          headingLevel={embedded ? 2 : 1}
          sticky={!embedded}
          action={{
            label: "All Articles",
            icon: ArrowLeft,
            variant: "secondary",
            onClick: () => setSelectedArticle(null),
          }}
        />{" "}
        <ArticleViewer articleId={selectedArticle} />{" "}
      </div>
    );
  }

  return (
    <div>
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
        action={{
          label: "Ask a Question",
          icon: MessageSquare,
          onClick: openQuestion,
        }}
        navGridClassName="grid-cols-2 md:grid-cols-4"
      />
      {/* ARTICLES TAB */}
      {tab === "articles" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {/* Category Grid */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))",
              gap: 10,
            }}
          >
            {Object.entries(categoryCounts)
              .sort((a, b) => b[1] - a[1])
              .map(([cat, count]) => (
                <div
                  key={cat}
                  onClick={() => setFilterCat(filterCat === cat ? "" : cat)}
                  style={{
                    padding: "12px 14px",
                    background: filterCat === cat ? D.teal + "22" : D.card,
                    border: `1px solid ${filterCat === cat ? D.teal : D.border}`,
                    borderRadius: 10,
                    cursor: "pointer",
                    textAlign: "center",
                    transition: "all 0.15s",
                  }}
                >
                  {" "}
                  <div
                    style={{
                      fontSize: 12,
                      fontWeight: 500,
                      color: D.heading,
                      textTransform: "capitalize",
                    }}
                  >
                    {cat}
                  </div>{" "}
                  <div
                    style={{
                      fontSize: 18,
                      fontWeight: 700,
                      color: D.teal,
                      fontFamily: MONO,
                    }}
                  >
                    {count}
                  </div>{" "}
                </div>
              ))}
          </div>
          {/* Search */}
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search articles..."
            style={{
              padding: "10px 14px",
              borderRadius: 8,
              border: `1px solid ${D.border}`,
              background: D.bg,
              color: D.heading,
              fontSize: 14,
              width: "100%",
            }}
          />
          {/* Article List */}
          {loading ? (
            <div style={{ color: D.muted, padding: 40, textAlign: "center" }}>
              Loading articles...
            </div>
          ) : articles.length === 0 ? (
            <Card style={{ textAlign: "center", padding: 60 }}>
              {" "}
              <div
                style={{
                  fontSize: 18,
                  fontWeight: 500,
                  color: D.heading,
                  marginBottom: 8,
                }}
              >
                No Articles Yet
              </div>{" "}
              <div style={{ fontSize: 14, color: D.muted }}>
                Add source documents and compile them to build your knowledge
                base.
              </div>{" "}
            </Card>
          ) : (
            articles.map((a) => {
              const tags =
                typeof a.tags === "string" ? JSON.parse(a.tags) : a.tags || [];
              return (
                <div
                  key={a.id}
                  onClick={() => setSelectedArticle(a.id)}
                  style={{
                    padding: "12px 16px",
                    background: D.card,
                    border: `1px solid ${D.border}`,
                    borderRadius: 8,
                    cursor: "pointer",
                    transition: "border-color 0.15s",
                  }}
                >
                  {" "}
                  <div
                    style={{ display: "flex", alignItems: "center", gap: 8 }}
                  >
                    {" "}
                    <div style={{ flex: 1 }}>
                      {" "}
                      <div
                        style={{
                          fontSize: 14,
                          fontWeight: 500,
                          color: D.heading,
                        }}
                      >
                        {a.title}
                      </div>{" "}
                      <div style={{ fontSize: 12, color: D.muted }}>
                        {a.summary || a.path}
                      </div>{" "}
                    </div>{" "}
                    <div
                      style={{ fontSize: 11, color: D.muted, fontFamily: MONO }}
                    >
                      {a.word_count}w
                    </div>{" "}
                  </div>
                  {tags.length > 0 && (
                    <div style={{ display: "flex", gap: 4, marginTop: 6 }}>
                      {tags.slice(0, 5).map((t, i) => (
                        <span
                          key={i}
                          style={{
                            padding: "1px 6px",
                            borderRadius: 3,
                            background: D.bg,
                            color: D.muted,
                            fontSize: 10,
                          }}
                        >
                          {t}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      )}

      {/* SOURCES TAB */}
      {tab === "sources" && <KnowledgeSources />}

      {/* HEALTH TAB */}
      {tab === "health" && <HealthCheck />}

      {/* QUERIES TAB */}
      {tab === "queries" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {recentQueries.length === 0 ? (
            <Card style={{ textAlign: "center", padding: 40 }}>
              <div style={{ color: D.muted }}>
                No queries yet. Click "Ask a Question" to start.
              </div>
            </Card>
          ) : (
            recentQueries.map((q) => (
              <Card key={q.id} style={{ padding: 16 }}>
                {" "}
                <div
                  style={{
                    fontSize: 14,
                    fontWeight: 500,
                    color: D.teal,
                    marginBottom: 6,
                  }}
                >
                  Q: {q.query}
                </div>{" "}
                <div
                  style={{
                    fontSize: 13,
                    color: D.text,
                    lineHeight: 1.6,
                    maxHeight: 120,
                    overflow: "hidden",
                  }}
                >
                  {q.answer}
                </div>{" "}
                <div
                  style={{
                    display: "flex",
                    gap: 12,
                    marginTop: 8,
                    fontSize: 11,
                    color: D.muted,
                  }}
                >
                  {" "}
                  <span>{q.asked_by}</span>{" "}
                  <span>{new Date(q.created_at).toLocaleString()}</span>
                  {q.response_quality && <span>{q.response_quality}/5</span>}
                  {q.filed_back && (
                    <span style={{ color: D.green }}>Filed back</span>
                  )}
                </div>{" "}
              </Card>
            ))
          )}
        </div>
      )}
    </div>
  );
}
