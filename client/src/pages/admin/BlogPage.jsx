import { useState, useEffect, lazy, Suspense } from "react";
import { useSearchParams } from "react-router-dom";
import {
  Bot,
  CalendarDays,
  Database,
  FileCheck2,
  FileText,
  Newspaper,
  Plus,
  Wand2,
} from "lucide-react";
import AdminCommandHeader from "../../components/admin/AdminCommandHeader";

// Content Engine + Registry are folded into this page as tabs (Autopilot /
// Registry) rather than living as their own Marketing nav items; both are
// rendered `embedded` so their own AdminCommandHeader is suppressed and this
// page's header is the single header. Lazy-loaded to match the ContentCalendar
// tab — heavy optional surfaces stay out of the base blog chunk.
const AutonomousContentReviewPage = lazy(
  () => import("./AutonomousContentReviewPage"),
);
const ContentRegistryPage = lazy(() => import("./ContentRegistryPage"));

const API_BASE = import.meta.env.VITE_API_URL || "/api";
// V2 token pass: `teal` folded to zinc-900, `purple`/`orange` fold too.
// Semantic green/amber/red preserved for SEO score / status accents.
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
const HUB_BLOG_TARGET_SITES = ["wavespestcontrol.com"];

async function parseAdminResponse(response) {
  const text = await response.text();
  let data = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: text };
    }
  }
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

function adminFetch(path) {
  return fetch(`${API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${localStorage.getItem("waves_admin_token")}`,
      "Content-Type": "application/json",
    },
  }).then(parseAdminResponse);
}
function adminPost(path, body) {
  return fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${localStorage.getItem("waves_admin_token")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  }).then(parseAdminResponse);
}
function adminPut(path, body) {
  return fetch(`${API_BASE}${path}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${localStorage.getItem("waves_admin_token")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  }).then(parseAdminResponse);
}

const BLOG_CATEGORIES = [
  { value: "pest-control", label: "Pest Control" },
  { value: "lawn-care", label: "Lawn Care" },
  { value: "termite", label: "Termite" },
  { value: "mosquito", label: "Mosquito" },
  { value: "tree-shrub", label: "Tree & Shrub" },
  { value: "seasonal", label: "Seasonal" },
];

const BLOG_POST_TYPES = [
  { value: "location", label: "Location" },
  { value: "diagnostic", label: "Diagnostic" },
  { value: "seasonal", label: "Seasonal" },
  { value: "by-grass-type", label: "By Grass Type" },
  { value: "protocol", label: "Protocol" },
  { value: "cost", label: "Cost" },
  { value: "comparison", label: "Comparison" },
  { value: "case-study", label: "Case Study" },
  { value: "decision", label: "Decision" },
];

const isMobile = typeof window !== "undefined" && window.innerWidth < 640;

function Card({ children, style }) {
  return (
    <div
      style={{
        background: D.card,
        border: `1px solid ${D.border}`,
        borderRadius: 12,
        padding: isMobile ? 14 : 24,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

function seoColor(score) {
  if (!score) return D.muted;
  if (score >= 70) return D.green;
  if (score >= 50) return D.amber;
  return D.red;
}

// =========================================================================
// POST LIST COMPONENT (shared between Published, Drafts, Calendar, Ideas)
// =========================================================================
function PostList({ status, onSelectPost }) {
  const [posts, setPosts] = useState([]);
  const [counts, setCounts] = useState({});
  const [loading, setLoading] = useState(true);
  const [filterTag, setFilterTag] = useState("");
  const [filterCity, setFilterCity] = useState("");
  const [search, setSearch] = useState("");
  const load = () => {
    setLoading(true);
    let url = `/admin/content/blog?status=${status}`;
    if (filterTag) url += `&tag=${encodeURIComponent(filterTag)}`;
    if (filterCity) url += `&city=${encodeURIComponent(filterCity)}`;
    if (search) url += `&search=${encodeURIComponent(search)}`;
    if (status === "published") url += "&sort=seo_score&order=asc";
    adminFetch(url)
      .then((d) => {
        setPosts(d.posts || []);
        setCounts(d.counts || {});
        setLoading(false);
      })
      .catch(() => setLoading(false));
  };

  useEffect(load, [status, filterTag, filterCity, search]);

  const tags = [...new Set(posts.map((p) => p.tag).filter(Boolean))].sort();
  const cities = [...new Set(posts.map((p) => p.city).filter(Boolean))].sort();

  if (loading)
    return (
      <div style={{ color: D.muted, padding: 40, textAlign: "center" }}>
        Loading posts...
      </div>
    );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* Filters */}
      <div
        style={{
          display: "flex",
          gap: 8,
          flexWrap: "wrap",
          alignItems: "center",
        }}
      >
        {" "}
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search..."
          style={{
            padding: "6px 12px",
            borderRadius: 6,
            border: `1px solid ${D.border}`,
            background: D.bg,
            color: D.text,
            fontSize: 12,
            width: 180,
          }}
        />{" "}
        <select
          value={filterTag}
          onChange={(e) => setFilterTag(e.target.value)}
          style={{
            padding: "6px 10px",
            borderRadius: 6,
            border: `1px solid ${D.border}`,
            background: D.bg,
            color: D.text,
            fontSize: 12,
          }}
        >
          {" "}
          <option value="">All Topics</option>
          {tags.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>{" "}
        <select
          value={filterCity}
          onChange={(e) => setFilterCity(e.target.value)}
          style={{
            padding: "6px 10px",
            borderRadius: 6,
            border: `1px solid ${D.border}`,
            background: D.bg,
            color: D.text,
            fontSize: 12,
          }}
        >
          {" "}
          <option value="">All Cities</option>
          {cities.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>{" "}
        <span style={{ fontSize: 12, color: D.muted, marginLeft: "auto" }}>
          {posts.length} posts
        </span>{" "}
      </div>
      {/* Post Cards */}
      {posts.length === 0 ? (
        <Card style={{ textAlign: "center", padding: 40 }}>
          {" "}
          <div style={{ color: D.muted }}>No posts found</div>{" "}
        </Card>
      ) : (
        posts.map((p) => (
          <div
            key={p.id}
            onClick={() => onSelectPost(p)}
            style={{
              background: D.card,
              border: `1px solid ${D.border}`,
              borderRadius: 10,
              padding: "14px 18px",
              cursor: "pointer",
              transition: "border-color 0.15s",
              borderLeft: `3px solid ${p.seo_score ? seoColor(p.seo_score) : D.border}`,
            }}
          >
            {" "}
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "flex-start",
                gap: 12,
              }}
            >
              {" "}
              <div style={{ flex: 1 }}>
                {" "}
                <div
                  style={{
                    fontSize: 14,
                    fontWeight: 600,
                    color: D.heading,
                    marginBottom: 4,
                  }}
                >
                  {p.seo_score != null && (
                    <span
                      style={{ marginRight: 6, color: seoColor(p.seo_score) }}
                    >
                      {p.seo_score}/100
                    </span>
                  )}
                  {p.title}
                </div>
                {p.seo_score != null && p.seo_score < 50 && (
                  <div
                    style={{
                      fontSize: 11,
                      color: D.red,
                      fontWeight: 600,
                      marginBottom: 4,
                    }}
                  >
                    CRITICAL — needs optimization
                  </div>
                )}
                <div
                  style={{
                    display: "flex",
                    gap: 12,
                    fontSize: 11,
                    color: D.muted,
                    flexWrap: "wrap",
                  }}
                >
                  {p.tag && <span>{p.tag}</span>}
                  {p.city && <span>{p.city}</span>}
                  {p.keyword && <span>{p.keyword}</span>}
                  {p.publish_date && (
                    <span>
                      {new Date(
                        p.publish_date + "T12:00:00",
                      ).toLocaleDateString("en-US", {
                        month: "short",
                        day: "numeric",
                        year: "numeric",
                      })}
                    </span>
                  )}
                  {p.word_count > 0 && <span>{p.word_count} words</span>}
                </div>{" "}
              </div>{" "}
              <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                {status === "queued" && !p.content && (
                  <span
                    style={{
                      fontSize: 10,
                      padding: "3px 8px",
                      borderRadius: 4,
                      background: D.teal + "22",
                      color: D.teal,
                    }}
                  >
                    Needs Content
                  </span>
                )}
                {status === "queued" && p.content && (
                  <span
                    style={{
                      fontSize: 10,
                      padding: "3px 8px",
                      borderRadius: 4,
                      background: D.green + "22",
                      color: D.green,
                    }}
                  >
                    Content Ready
                  </span>
                )}
              </div>{" "}
            </div>{" "}
          </div>
        ))
      )}
    </div>
  );
}

// =========================================================================
// POST EDITOR / DETAIL VIEW
// =========================================================================
function PostEditor({ post, onBack, onUpdate }) {
  const [editing, setEditing] = useState(post);
  const [generating, setGenerating] = useState(false);
  const [optimizing, setOptimizing] = useState(false);
  const [astroPublishing, setAstroPublishing] = useState(false);
  const [astroMerging, setAstroMerging] = useState(false);
  const [astroRefreshing, setAstroRefreshing] = useState(false);
  const [astroUnpublishing, setAstroUnpublishing] = useState(false);
  const [regeneratingImage, setRegeneratingImage] = useState(false);
  const [imageError, setImageError] = useState(null);
  const [authors, setAuthors] = useState([]);
  const [serviceAreas, setServiceAreas] = useState([]);
  const [optimization, setOptimization] = useState(
    post.optimization_suggestions
      ? typeof post.optimization_suggestions === "string"
        ? JSON.parse(post.optimization_suggestions)
        : post.optimization_suggestions
      : null,
  );

  useEffect(() => {
    adminFetch("/admin/content/authors")
      .then((d) => setAuthors(d.authors || []))
      .catch(() => setAuthors([]));
    fetch(`${API_BASE}/public/service-areas`)
      .then((r) => r.json())
      .then((d) => setServiceAreas(d.serviceAreas || []))
      .catch(() => setServiceAreas([]));
  }, []);

  const toArray = (v) => {
    if (Array.isArray(v)) return v;
    if (!v) return [];
    if (typeof v === "string") {
      try {
        const p = JSON.parse(v);
        return Array.isArray(p) ? p : [];
      } catch {
        return [];
      }
    }
    return [];
  };
  const serviceAreaTags = toArray(editing.service_areas_tag);
  const relatedServices = toArray(editing.related_services);
  const dateInputValue = (v) => {
    if (!v) return "";
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
  };

  const toggleServiceArea = (city) => {
    const next = serviceAreaTags.includes(city)
      ? serviceAreaTags.filter((c) => c !== city)
      : [...serviceAreaTags, city];
    setEditing((prev) => ({ ...prev, service_areas_tag: next }));
  };

  const handleRegenerateImage = async () => {
    if (regeneratingImage) return;
    setRegeneratingImage(true);
    setImageError(null);
    try {
      const r = await fetch(
        `${API_BASE}/admin/content/blog/${post.id}/regenerate-image`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${localStorage.getItem("waves_admin_token")}`,
            "Content-Type": "application/json",
          },
        },
      );
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      if (d.post) setEditing((prev) => ({ ...prev, ...d.post }));
    } catch (err) {
      setImageError(err.message || "Image generation failed");
    }
    setRegeneratingImage(false);
  };

  const handleGenerate = async () => {
    setGenerating(true);
    try {
      const result = await adminPost(
        `/admin/content/blog/${post.id}/generate`,
        {},
      );
      if (result.content) {
        setEditing((prev) => ({
          ...prev,
          content: result.content,
          word_count: result.wordCount,
          status: "draft",
        }));
      } else if (result.error) {
        alert(`Generate failed: ${result.error}`);
      }
    } catch (err) {
      alert(`Generate failed: ${err.message}`);
    }
    setGenerating(false);
  };

  const handleOptimize = async () => {
    setOptimizing(true);
    try {
      const result = await adminPost(
        `/admin/content/blog/${post.id}/optimize`,
        {},
      );
      setOptimization(result.optimization);
    } catch (err) {
      alert(`Optimize failed: ${err.message}`);
    }
    setOptimizing(false);
  };

  const handleSave = async ({ notify = true } = {}) => {
    try {
      const updated = await adminPut(`/admin/content/blog/${post.id}`, {
        title: editing.title,
        content: editing.content,
        meta_description: editing.meta_description,
        keyword: editing.keyword,
        tag: editing.tag,
        status: editing.status,
        author_slug: editing.author_slug || null,
        reviewer_slug: editing.reviewer_slug || null,
        technically_reviewed_at: editing.technically_reviewed_at || null,
        fact_checked_at: editing.fact_checked_at || null,
        category: editing.category || null,
        post_type: editing.post_type || null,
        service_areas_tag: serviceAreaTags,
        related_services: relatedServices,
        target_sites: HUB_BLOG_TARGET_SITES,
        hero_image_alt: editing.hero_image_alt || null,
      });
      if (!updated.post)
        throw new Error("Save response did not include a post");
      if (notify && onUpdate) onUpdate(updated.post);
      setEditing((prev) => ({ ...prev, ...updated.post }));
      return updated;
    } catch (err) {
      alert(`Save failed: ${err.message}`);
      if (notify) return null;
      throw err;
    }
  };

  const applyOptimization = () => {
    if (!optimization) return;
    setEditing((prev) => ({
      ...prev,
      meta_description:
        optimization.suggested_meta ||
        optimization.suggestedMeta ||
        prev.meta_description,
      keyword:
        optimization.suggested_keyword ||
        optimization.suggestedKeyword ||
        prev.keyword,
    }));
    alert(
      "Applied suggested meta + keyword. Review the SEO improvements and apply them to the content manually.",
    );
  };

  const handlePublishAstro = async () => {
    try {
      await handleSave({ notify: false });
    } catch {
      return;
    }
    setAstroPublishing(true);
    try {
      const result = await adminPost(
        `/admin/content/blog/${post.id}/publish-astro`,
        {},
      );
      setEditing((prev) => ({
        ...prev,
        astro_status: "pr_open",
        astro_pr_number: result.pr_number,
        astro_branch_name: result.branch,
        astro_preview_url: result.preview_url,
        astro_publish_error: null,
      }));
    } catch (err) {
      alert("Astro publish failed: " + err.message);
    }
    setAstroPublishing(false);
  };

  const handleMergeAstro = async () => {
    if (!window.confirm("Merge this PR and go live on wavespestcontrol.com?"))
      return;
    setAstroMerging(true);
    try {
      const result = await adminPost(
        `/admin/content/blog/${post.id}/merge-astro`,
        {},
      );
      if (result.error) {
        alert(`Merge failed: ${result.error}`);
      } else {
        setEditing((prev) => ({
          ...prev,
          astro_status: "merged",
          status: "published",
          astro_live_url: result.live_url || prev.astro_live_url,
        }));
      }
    } catch (err) {
      alert("Merge failed: " + err.message);
    }
    setAstroMerging(false);
  };

  const handleRefreshAstro = async () => {
    setAstroRefreshing(true);
    try {
      const result = await adminPost(
        `/admin/content/blog/${post.id}/refresh-astro`,
        {},
      );
      if (result.post) setEditing((prev) => ({ ...prev, ...result.post }));
    } catch (err) {
      // Silent — refresh is best-effort
    }
    setAstroRefreshing(false);
  };

  const handleUnpublishAstro = async () => {
    if (
      !window.confirm(
        "Open a revert PR to take this post offline? After the PR merges, the post returns to draft and disappears from the live site.",
      )
    )
      return;
    setAstroUnpublishing(true);
    try {
      const result = await adminPost(
        `/admin/content/blog/${post.id}/unpublish-astro`,
        {},
      );
      if (result.error) {
        alert(`Unpublish failed: ${result.error}`);
      } else {
        setEditing((prev) => ({
          ...prev,
          astro_status: "unpublish_pending",
          astro_pr_number: result.pr_number,
          astro_branch_name: result.branch,
          astro_preview_url: null,
        }));
      }
    } catch (err) {
      alert("Unpublish failed: " + err.message);
    }
    setAstroUnpublishing(false);
  };

  const [sharing, setSharing] = useState(false);
  const handleShareSocial = async () => {
    setSharing(true);
    try {
      const result = await adminPost(
        `/admin/content/blog/${post.id}/share-social`,
        {},
      );
      const platforms = result.platforms || [];
      const successes = platforms
        .filter((p) => p.success)
        .map((p) => p.platform)
        .join(", ");
      const failures = platforms
        .filter((p) => p.error)
        .map((p) => `${p.platform}: ${p.error}`)
        .join("\n");
      alert(
        `Shared to: ${successes || "none"}${failures ? "\n\nFailed:\n" + failures : ""}`,
      );
    } catch (err) {
      alert("Social share failed: " + err.message);
    }
    setSharing(false);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {" "}
      <button
        onClick={onBack}
        style={{
          alignSelf: "flex-start",
          padding: "6px 14px",
          borderRadius: 6,
          border: `1px solid ${D.border}`,
          background: "transparent",
          color: D.muted,
          fontSize: 12,
          cursor: "pointer",
        }}
      >
        {"←"} Back to list
      </button>
      {/* Header */}
      <Card>
        {" "}
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {" "}
          <div>
            {" "}
            <label
              style={{
                fontSize: 11,
                color: D.muted,
                display: "block",
                marginBottom: 4,
              }}
            >
              Title
            </label>{" "}
            <input
              value={editing.title || ""}
              onChange={(e) =>
                setEditing((prev) => ({ ...prev, title: e.target.value }))
              }
              style={{
                width: "100%",
                padding: "10px 12px",
                borderRadius: 8,
                border: `1px solid ${D.border}`,
                background: D.bg,
                color: D.heading,
                fontSize: 15,
                fontWeight: 600,
              }}
            />{" "}
          </div>{" "}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: isMobile
                ? "repeat(2, 1fr)"
                : "1fr 1fr 1fr 1fr",
              gap: 10,
            }}
          >
            {" "}
            <div>
              {" "}
              <label
                style={{
                  fontSize: 11,
                  color: D.muted,
                  display: "block",
                  marginBottom: 4,
                }}
              >
                Keyword
              </label>{" "}
              <input
                value={editing.keyword || ""}
                onChange={(e) =>
                  setEditing((prev) => ({ ...prev, keyword: e.target.value }))
                }
                style={{
                  width: "100%",
                  padding: "6px 10px",
                  borderRadius: 6,
                  border: `1px solid ${D.border}`,
                  background: D.bg,
                  color: D.text,
                  fontSize: 12,
                }}
              />{" "}
            </div>{" "}
            <div>
              {" "}
              <label
                style={{
                  fontSize: 11,
                  color: D.muted,
                  display: "block",
                  marginBottom: 4,
                }}
              >
                City
              </label>{" "}
              <input
                value={editing.city || ""}
                readOnly
                style={{
                  width: "100%",
                  padding: "6px 10px",
                  borderRadius: 6,
                  border: `1px solid ${D.border}`,
                  background: D.bg,
                  color: D.muted,
                  fontSize: 12,
                }}
              />{" "}
            </div>{" "}
            <div>
              {" "}
              <label
                style={{
                  fontSize: 11,
                  color: D.muted,
                  display: "block",
                  marginBottom: 4,
                }}
              >
                Tag
              </label>{" "}
              <select
                value={editing.tag || ""}
                onChange={(e) =>
                  setEditing((prev) => ({ ...prev, tag: e.target.value }))
                }
                style={{
                  width: "100%",
                  padding: "6px 10px",
                  borderRadius: 6,
                  border: `1px solid ${D.border}`,
                  background: D.bg,
                  color: D.text,
                  fontSize: 12,
                  cursor: "pointer",
                }}
              >
                {" "}
                <option value="">Select tag...</option>
                {[
                  "Ants",
                  "Bed Bugs",
                  "Cockroaches",
                  "Fleas",
                  "Flying Insects",
                  "Insects",
                  "Lawn Care",
                  "Lawn Pests",
                  "Mosquitoes",
                  "Pest Control",
                  "Rodents",
                  "Spiders",
                  "Termites",
                ].map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>{" "}
            </div>{" "}
            <div>
              {" "}
              <label
                style={{
                  fontSize: 11,
                  color: D.muted,
                  display: "block",
                  marginBottom: 4,
                }}
              >
                Status
              </label>{" "}
              <div style={{ padding: "6px 10px", fontSize: 12, color: D.teal }}>
                {editing.status}
              </div>{" "}
            </div>{" "}
          </div>{" "}
          <div>
            {" "}
            <label
              style={{
                fontSize: 11,
                color: D.muted,
                display: "block",
                marginBottom: 4,
              }}
            >
              Meta Description
            </label>{" "}
            <input
              value={editing.meta_description || ""}
              onChange={(e) =>
                setEditing((prev) => ({
                  ...prev,
                  meta_description: e.target.value,
                }))
              }
              style={{
                width: "100%",
                padding: "6px 10px",
                borderRadius: 6,
                border: `1px solid ${D.border}`,
                background: D.bg,
                color: D.text,
                fontSize: 12,
              }}
            />{" "}
            <div
              style={{
                fontSize: 10,
                color:
                  (editing.meta_description || "").length > 0 &&
                  ((editing.meta_description || "").length < 115 ||
                    (editing.meta_description || "").length > 160)
                    ? D.red
                    : D.muted,
                marginTop: 2,
              }}
            >
              {(editing.meta_description || "").length}/115-160 chars
            </div>{" "}
          </div>{" "}
        </div>{" "}
      </Card>
      {/* v2 Byline + Taxonomy — drives the Astro frontmatter */}
      <Card>
        {" "}
        <div
          style={{
            fontSize: 13,
            fontWeight: 600,
            color: D.heading,
            marginBottom: 10,
          }}
        >
          Byline & Taxonomy
        </div>{" "}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: isMobile ? "1fr 1fr" : "repeat(3, 1fr)",
            gap: 10,
          }}
        >
          {" "}
          <div>
            {" "}
            <label
              style={{
                fontSize: 11,
                color: D.muted,
                display: "block",
                marginBottom: 4,
              }}
            >
              Author
            </label>{" "}
            <select
              value={editing.author_slug || ""}
              onChange={(e) =>
                setEditing((prev) => ({ ...prev, author_slug: e.target.value }))
              }
              style={{
                width: "100%",
                padding: "6px 10px",
                borderRadius: 6,
                border: `1px solid ${D.border}`,
                background: D.bg,
                color: D.text,
                fontSize: 12,
                cursor: "pointer",
              }}
            >
              {" "}
              <option value="">Select author...</option>
              {authors.map((a) => (
                <option key={a.slug} value={a.slug}>
                  {a.name}
                  {a.fdacs_license ? ` (${a.fdacs_license})` : ""}
                </option>
              ))}
            </select>{" "}
          </div>{" "}
          <div>
            {" "}
            <label
              style={{
                fontSize: 11,
                color: D.muted,
                display: "block",
                marginBottom: 4,
              }}
            >
              Technical Reviewer
            </label>{" "}
            <select
              value={editing.reviewer_slug || ""}
              onChange={(e) =>
                setEditing((prev) => ({
                  ...prev,
                  reviewer_slug: e.target.value,
                }))
              }
              style={{
                width: "100%",
                padding: "6px 10px",
                borderRadius: 6,
                border: `1px solid ${D.border}`,
                background: D.bg,
                color: D.text,
                fontSize: 12,
                cursor: "pointer",
              }}
            >
              {" "}
              <option value="">None</option>
              {authors
                .filter((a) => a.fdacs_license)
                .map((a) => (
                  <option key={a.slug} value={a.slug}>
                    {a.name}
                  </option>
                ))}
            </select>{" "}
          </div>{" "}
          <div>
            {" "}
            <label
              style={{
                fontSize: 11,
                color: D.muted,
                display: "block",
                marginBottom: 4,
              }}
            >
              Technical Review Date
            </label>{" "}
            <input
              type="date"
              value={dateInputValue(editing.technically_reviewed_at)}
              onChange={(e) =>
                setEditing((prev) => ({
                  ...prev,
                  technically_reviewed_at: e.target.value || null,
                }))
              }
              style={{
                width: "100%",
                padding: "6px 10px",
                borderRadius: 6,
                border: `1px solid ${D.border}`,
                background: D.bg,
                color: D.text,
                fontSize: 12,
              }}
            />{" "}
          </div>{" "}
          <div>
            {" "}
            <label
              style={{
                fontSize: 11,
                color: D.muted,
                display: "block",
                marginBottom: 4,
              }}
            >
              Fact-Check Date
            </label>{" "}
            <input
              type="date"
              value={dateInputValue(editing.fact_checked_at)}
              onChange={(e) =>
                setEditing((prev) => ({
                  ...prev,
                  fact_checked_at: e.target.value || null,
                }))
              }
              style={{
                width: "100%",
                padding: "6px 10px",
                borderRadius: 6,
                border: `1px solid ${D.border}`,
                background: D.bg,
                color: D.text,
                fontSize: 12,
              }}
            />{" "}
          </div>{" "}
          <div>
            {" "}
            <label
              style={{
                fontSize: 11,
                color: D.muted,
                display: "block",
                marginBottom: 4,
              }}
            >
              Category
            </label>{" "}
            <select
              value={editing.category || ""}
              onChange={(e) =>
                setEditing((prev) => ({ ...prev, category: e.target.value }))
              }
              style={{
                width: "100%",
                padding: "6px 10px",
                borderRadius: 6,
                border: `1px solid ${D.border}`,
                background: D.bg,
                color: D.text,
                fontSize: 12,
                cursor: "pointer",
              }}
            >
              {" "}
              <option value="">Select...</option>
              {BLOG_CATEGORIES.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>{" "}
          </div>{" "}
          <div>
            {" "}
            <label
              style={{
                fontSize: 11,
                color: D.muted,
                display: "block",
                marginBottom: 4,
              }}
            >
              Post Type
            </label>{" "}
            <select
              value={editing.post_type || ""}
              onChange={(e) =>
                setEditing((prev) => ({ ...prev, post_type: e.target.value }))
              }
              style={{
                width: "100%",
                padding: "6px 10px",
                borderRadius: 6,
                border: `1px solid ${D.border}`,
                background: D.bg,
                color: D.text,
                fontSize: 12,
                cursor: "pointer",
              }}
            >
              {" "}
              <option value="">Select...</option>
              {BLOG_POST_TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>{" "}
          </div>{" "}
          <div>
            {" "}
            <label
              style={{
                fontSize: 11,
                color: D.muted,
                display: "block",
                marginBottom: 4,
              }}
            >
              Hero Image Alt
            </label>{" "}
            <input
              value={editing.hero_image_alt || ""}
              onChange={(e) =>
                setEditing((prev) => ({
                  ...prev,
                  hero_image_alt: e.target.value,
                }))
              }
              style={{
                width: "100%",
                padding: "6px 10px",
                borderRadius: 6,
                border: `1px solid ${D.border}`,
                background: D.bg,
                color: D.text,
                fontSize: 12,
              }}
            />{" "}
          </div>{" "}
        </div>{" "}
        <div style={{ marginTop: 14 }}>
          {" "}
          <label
            style={{
              fontSize: 11,
              color: D.muted,
              display: "block",
              marginBottom: 6,
            }}
          >
            Service Areas (tags)
          </label>{" "}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {serviceAreas.map((sa) => {
              const active = serviceAreaTags.includes(sa.city);
              return (
                <button
                  key={sa.slug}
                  type="button"
                  onClick={() => toggleServiceArea(sa.city)}
                  style={{
                    padding: "4px 10px",
                    borderRadius: 999,
                    fontSize: 11,
                    cursor: "pointer",
                    border: `1px solid ${active ? D.teal : D.border}`,
                    background: active ? D.teal : "transparent",
                    color: active ? D.white : D.muted,
                  }}
                >
                  {sa.city}
                </button>
              );
            })}
          </div>{" "}
        </div>
        <div style={{ marginTop: 14 }}>
          {" "}
          <label
            style={{
              fontSize: 11,
              color: D.muted,
              display: "block",
              marginBottom: 6,
            }}
          >
            Publish target
          </label>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
            <span
              style={{
                padding: "4px 10px",
                borderRadius: 999,
                fontSize: 11,
                border: `1px solid ${D.green}`,
                background: D.green,
                color: D.white,
                whiteSpace: "nowrap",
              }}
            >
              Hub — wavespestcontrol.com
            </span>
            <span style={{ color: D.muted, fontSize: 12 }}>
              Blog posts publish only on the Waves hub. Use service/location pages for spoke domains.
            </span>
          </div>
        </div>{" "}
      </Card>
      {/* Content */}
      <Card>
        {" "}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 12,
          }}
        >
          {" "}
          <div style={{ fontSize: 15, fontWeight: 600, color: D.heading }}>
            Content
          </div>{" "}
          <div style={{ display: "flex", gap: 8 }}>
            {!editing.content && (
              <button
                onClick={handleGenerate}
                disabled={generating}
                style={{
                  padding: "6px 14px",
                  borderRadius: 6,
                  border: "none",
                  background: D.teal,
                  color: D.heading,
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: "pointer",
                  opacity: generating ? 0.5 : 1,
                }}
              >
                {generating ? "Generating..." : "Generate Content"}
              </button>
            )}
            {editing.content && (
              <>
                {" "}
                <button
                  onClick={handleGenerate}
                  disabled={generating}
                  style={{
                    padding: "6px 14px",
                    borderRadius: 6,
                    border: `1px solid ${D.border}`,
                    background: "transparent",
                    color: D.muted,
                    fontSize: 12,
                    cursor: "pointer",
                    opacity: generating ? 0.5 : 1,
                  }}
                >
                  {generating ? "Regenerating..." : "Regenerate"}
                </button>{" "}
                <button
                  onClick={handleOptimize}
                  disabled={optimizing}
                  style={{
                    padding: "6px 14px",
                    borderRadius: 6,
                    border: `1px solid ${D.amber}`,
                    background: "transparent",
                    color: D.amber,
                    fontSize: 12,
                    cursor: "pointer",
                    opacity: optimizing ? 0.5 : 1,
                  }}
                >
                  {optimizing ? "Optimizing..." : "Optimize"}
                </button>{" "}
              </>
            )}
          </div>{" "}
        </div>
        {/* Featured Image */}
        <div style={{ marginBottom: 12 }}>
          {" "}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: 6,
            }}
          >
            {" "}
            <label style={{ fontSize: 11, color: D.muted }}>
              Featured Image (AI-generated)
            </label>{" "}
            <button
              type="button"
              onClick={handleRegenerateImage}
              disabled={regeneratingImage}
              style={{
                padding: "4px 10px",
                borderRadius: 6,
                fontSize: 11,
                fontWeight: 600,
                border: `1px solid ${D.teal}`,
                background: "transparent",
                color: D.teal,
                cursor: "pointer",
                opacity: regeneratingImage ? 0.5 : 1,
              }}
            >
              {regeneratingImage
                ? "Generating…"
                : editing.featured_image_url
                  ? "Regenerate image"
                  : "Generate image"}
            </button>{" "}
          </div>
          {editing.featured_image_url ? (
            <img
              src={editing.featured_image_url}
              alt="Featured"
              style={{
                width: "100%",
                maxHeight: 300,
                objectFit: "cover",
                borderRadius: 10,
                border: `1px solid ${D.border}`,
              }}
            />
          ) : (
            <div
              style={{
                padding: "16px 14px",
                borderRadius: 8,
                background: `${D.amber}15`,
                border: `1px solid ${D.amber}66`,
                color: D.amber,
                fontSize: 12,
                lineHeight: 1.5,
              }}
            >
              No hero image yet. Generate one before publishing to Astro.
              {imageError && (
                <div
                  style={{
                    marginTop: 6,
                    color: D.red,
                    fontFamily: MONO,
                    fontSize: 11,
                  }}
                >
                  Last attempt: {imageError}
                </div>
              )}
            </div>
          )}
        </div>
        {editing.content ? (
          <textarea
            value={editing.content}
            onChange={(e) =>
              setEditing((prev) => ({ ...prev, content: e.target.value }))
            }
            style={{
              width: "100%",
              minHeight: 400,
              padding: 16,
              borderRadius: 8,
              border: `1px solid ${D.border}`,
              background: D.bg,
              color: D.text,
              fontSize: 13,
              lineHeight: 1.7,
              fontFamily: "'Roboto', Arial, sans-serif",
              resize: "vertical",
            }}
          />
        ) : (
          <div
            style={{
              padding: 40,
              textAlign: "center",
              color: D.muted,
              fontSize: 14,
            }}
          >
            No content yet. Click "Generate Content" to create the blog post
            with AI.
          </div>
        )}
        {editing.content && (
          <div
            style={{
              display: "flex",
              gap: 16,
              marginTop: 8,
              fontSize: 12,
              color: D.muted,
            }}
          >
            {" "}
            <span>
              {(editing.content || "").split(/\s+/).filter(Boolean).length}{" "}
              words
            </span>{" "}
            <span>
              {Math.ceil(
                (editing.content || "").split(/\s+/).filter(Boolean).length /
                  250,
              )}{" "}
              min read
            </span>
            {editing.seo_score != null && (
              <span style={{ color: seoColor(editing.seo_score) }}>
                SEO: {editing.seo_score}/100
              </span>
            )}
          </div>
        )}
      </Card>
      {/* Optimization Suggestions */}
      {optimization && !optimization.parse_error && (
        <Card>
          {" "}
          <div
            style={{
              fontSize: 15,
              fontWeight: 600,
              color: D.amber,
              marginBottom: 12,
            }}
          >
            Optimization Suggestions
          </div>
          {optimization.suggested_title && (
            <div
              style={{
                padding: "8px 12px",
                background: D.bg,
                borderRadius: 6,
                marginBottom: 8,
              }}
            >
              {" "}
              <div style={{ fontSize: 11, color: D.muted }}>
                Suggested Title
              </div>{" "}
              <div style={{ fontSize: 13, color: D.heading }}>
                {optimization.suggested_title}
              </div>{" "}
            </div>
          )}
          {optimization.suggested_meta && (
            <div
              style={{
                padding: "8px 12px",
                background: D.bg,
                borderRadius: 6,
                marginBottom: 8,
              }}
            >
              {" "}
              <div style={{ fontSize: 11, color: D.muted }}>
                Suggested Meta
              </div>{" "}
              <div style={{ fontSize: 13, color: D.text }}>
                {optimization.suggested_meta}
              </div>{" "}
            </div>
          )}
          {optimization.suggested_keyword && (
            <div
              style={{
                padding: "8px 12px",
                background: D.bg,
                borderRadius: 6,
                marginBottom: 8,
              }}
            >
              {" "}
              <div style={{ fontSize: 11, color: D.muted }}>
                Suggested Keyword
              </div>{" "}
              <div style={{ fontSize: 13, color: D.teal }}>
                {optimization.suggested_keyword}
              </div>{" "}
            </div>
          )}
          {(optimization.seo_improvements || []).length > 0 && (
            <div
              style={{
                padding: "8px 12px",
                background: D.bg,
                borderRadius: 6,
                marginBottom: 8,
              }}
            >
              {" "}
              <div style={{ fontSize: 11, color: D.muted, marginBottom: 4 }}>
                SEO Improvements
              </div>
              {optimization.seo_improvements.map((s, i) => (
                <div
                  key={i}
                  style={{ fontSize: 12, color: D.text, marginBottom: 2 }}
                >
                  {"•"} {s}
                </div>
              ))}
            </div>
          )}
          {(optimization.missing_internal_links || []).length > 0 && (
            <div
              style={{
                padding: "8px 12px",
                background: D.bg,
                borderRadius: 6,
                marginBottom: 8,
              }}
            >
              {" "}
              <div style={{ fontSize: 11, color: D.muted, marginBottom: 4 }}>
                Add Internal Links
              </div>
              {optimization.missing_internal_links.map((l, i) => (
                <div
                  key={i}
                  style={{ fontSize: 12, color: D.text, marginBottom: 2 }}
                >
                  "<span style={{ color: D.teal }}>{l.anchor_text}</span>" →{" "}
                  {l.url}
                </div>
              ))}
            </div>
          )}
          {optimization.estimated_new_score && (
            <div
              style={{
                fontSize: 13,
                color: D.green,
                marginTop: 8,
                fontWeight: 600,
              }}
            >
              Estimated new SEO score: {optimization.estimated_new_score}/100
            </div>
          )}
          <button
            onClick={applyOptimization}
            style={{
              padding: "8px 16px",
              borderRadius: 6,
              border: "none",
              background: D.amber,
              color: D.bg,
              fontSize: 12,
              fontWeight: 600,
              cursor: "pointer",
              marginTop: 12,
            }}
          >
            Apply Meta + Keyword to Draft
          </button>{" "}
        </Card>
      )}
      {/* Astro publish state + actions */}
      {editing.content && (
        <AstroPublishPanel
          post={editing}
          onPublish={handlePublishAstro}
          onMerge={handleMergeAstro}
          onRefresh={handleRefreshAstro}
          onUnpublish={handleUnpublishAstro}
          publishing={astroPublishing}
          merging={astroMerging}
          refreshing={astroRefreshing}
          unpublishing={astroUnpublishing}
        />
      )}
      {/* Actions */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {" "}
        <button
          onClick={handleSave}
          style={{
            padding: "10px 20px",
            borderRadius: 8,
            border: "none",
            background: D.teal,
            color: D.white,
            fontSize: 13,
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          Save Draft
        </button>
        {(editing.status === "published" || editing.content) && (
          <button
            onClick={handleShareSocial}
            disabled={sharing}
            style={{
              padding: "10px 20px",
              borderRadius: 8,
              border: `1px solid ${D.purple}`,
              background: "transparent",
              color: D.purple,
              fontSize: 13,
              fontWeight: 600,
              cursor: "pointer",
              opacity: sharing ? 0.5 : 1,
            }}
          >
            {sharing ? "Sharing..." : "Share to Social Media"}
          </button>
        )}
      </div>{" "}
    </div>
  );
}

// ─── Astro publish panel ───────────────────────────────────────────
// Visual state machine for the blog → GitHub PR → Cloudflare preview →
// merge → live pipeline. Reads `astro_status` on the post and surfaces
// the next actionable step only.
function AstroPublishPanel({
  post,
  onPublish,
  onMerge,
  onRefresh,
  onUnpublish,
  publishing,
  merging,
  refreshing,
  unpublishing,
}) {
  const status = post.astro_status || "draft";
  const pill = ASTRO_PILLS[status] || ASTRO_PILLS.draft;

  return (
    <Card>
      {" "}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        {" "}
        <div
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            padding: "4px 10px",
            borderRadius: 999,
            fontSize: 11,
            fontWeight: 600,
            background: pill.bg,
            color: pill.fg,
            border: `1px solid ${pill.border}`,
          }}
        >
          {" "}
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: 999,
              background: pill.fg,
              display: "inline-block",
            }}
          />
          {pill.label}
        </div>
        {post.astro_pr_number && (
          <div style={{ fontSize: 11, color: D.muted }}>
            PR #{post.astro_pr_number}
          </div>
        )}
        {post.astro_branch_name && (
          <div style={{ fontSize: 11, color: D.muted, fontFamily: MONO }}>
            {post.astro_branch_name}
          </div>
        )}
        <div style={{ flex: 1 }} />
        {status === "draft" && (
          <button
            onClick={onPublish}
            disabled={publishing}
            style={{
              padding: "10px 18px",
              borderRadius: 8,
              border: "none",
              background: D.green,
              color: D.white,
              fontSize: 13,
              fontWeight: 600,
              cursor: "pointer",
              opacity: publishing ? 0.5 : 1,
            }}
          >
            {publishing ? "Opening PR…" : "Publish to Astro (preview)"}
          </button>
        )}
        {(status === "pr_open" || status === "build_failed") && (
          <>
            {post.astro_preview_url && (
              <a
                href={post.astro_preview_url}
                target="_blank"
                rel="noreferrer"
                style={{
                  padding: "8px 14px",
                  borderRadius: 8,
                  border: `1px solid ${D.border}`,
                  color: D.text,
                  fontSize: 12,
                  textDecoration: "none",
                }}
              >
                Open Preview
              </a>
            )}
            <button
              onClick={onRefresh}
              disabled={refreshing}
              style={{
                padding: "8px 14px",
                borderRadius: 8,
                border: `1px solid ${D.border}`,
                background: "transparent",
                color: D.muted,
                fontSize: 12,
                cursor: "pointer",
                opacity: refreshing ? 0.5 : 1,
              }}
            >
              {refreshing ? "Checking…" : "Refresh status"}
            </button>
            {status === "pr_open" && (
              <button
                onClick={onMerge}
                disabled={merging}
                style={{
                  padding: "10px 18px",
                  borderRadius: 8,
                  border: "none",
                  background: D.green,
                  color: D.white,
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: "pointer",
                  opacity: merging ? 0.5 : 1,
                }}
              >
                {merging ? "Merging…" : "Approve & Go Live"}
              </button>
            )}
            {status === "build_failed" && (
              <button
                onClick={onPublish}
                disabled={publishing}
                style={{
                  padding: "10px 18px",
                  borderRadius: 8,
                  border: `1px solid ${D.red}`,
                  background: "transparent",
                  color: D.red,
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: "pointer",
                  opacity: publishing ? 0.5 : 1,
                }}
              >
                {publishing ? "Retrying…" : "Retry publish"}
              </button>
            )}
          </>
        )}
        {status === "merged" && (
          <>
            {" "}
            <div style={{ fontSize: 12, color: D.muted }}>
              Merged. Live build in progress.
            </div>
            {post.astro_live_url && (
              <a
                href={post.astro_live_url}
                target="_blank"
                rel="noreferrer"
                style={{
                  padding: "8px 14px",
                  borderRadius: 8,
                  border: `1px solid ${D.green}`,
                  color: D.green,
                  fontSize: 12,
                  textDecoration: "none",
                  fontWeight: 600,
                }}
              >
                Expected Live URL
              </a>
            )}
            <button
              onClick={onRefresh}
              disabled={refreshing}
              style={{
                padding: "8px 14px",
                borderRadius: 8,
                border: `1px solid ${D.border}`,
                background: "transparent",
                color: D.muted,
                fontSize: 12,
                cursor: "pointer",
                opacity: refreshing ? 0.5 : 1,
              }}
            >
              Refresh
            </button>{" "}
            <button
              onClick={onUnpublish}
              disabled={unpublishing}
              style={{
                padding: "8px 14px",
                borderRadius: 8,
                border: "1px solid #d6d3d1",
                background: "#fafaf9",
                color: "#991B1B",
                fontSize: 12,
                fontWeight: 500,
                cursor: "pointer",
                opacity: unpublishing ? 0.5 : 1,
              }}
            >
              {unpublishing ? "Opening revert PR…" : "Unpublish"}
            </button>{" "}
          </>
        )}
        {status === "live" && (
          <>
            {post.astro_live_url && (
              <a
                href={post.astro_live_url}
                target="_blank"
                rel="noreferrer"
                style={{
                  padding: "8px 14px",
                  borderRadius: 8,
                  border: `1px solid ${D.green}`,
                  color: D.green,
                  fontSize: 12,
                  textDecoration: "none",
                  fontWeight: 600,
                }}
              >
                View Live
              </a>
            )}
            <button
              onClick={onUnpublish}
              disabled={unpublishing}
              style={{
                padding: "8px 14px",
                borderRadius: 8,
                border: "1px solid #d6d3d1",
                background: "#fafaf9",
                color: "#991B1B",
                fontSize: 12,
                fontWeight: 500,
                cursor: "pointer",
                opacity: unpublishing ? 0.5 : 1,
              }}
            >
              {unpublishing ? "Opening revert PR…" : "Unpublish"}
            </button>{" "}
          </>
        )}
        {status === "unpublish_pending" && (
          <>
            {" "}
            <button
              onClick={onRefresh}
              disabled={refreshing}
              style={{
                padding: "8px 14px",
                borderRadius: 8,
                border: `1px solid ${D.border}`,
                background: "transparent",
                color: D.muted,
                fontSize: 12,
                cursor: "pointer",
                opacity: refreshing ? 0.5 : 1,
              }}
            >
              {refreshing ? "Checking…" : "Refresh status"}
            </button>{" "}
            <button
              onClick={onMerge}
              disabled={merging}
              style={{
                padding: "10px 18px",
                borderRadius: 8,
                border: "none",
                background: "#991B1B",
                color: D.white,
                fontSize: 13,
                fontWeight: 600,
                cursor: "pointer",
                opacity: merging ? 0.5 : 1,
              }}
            >
              {merging ? "Removing…" : "Approve & Remove"}
            </button>{" "}
          </>
        )}
        {status === "publish_failed" && (
          <button
            onClick={onPublish}
            disabled={publishing}
            style={{
              padding: "10px 18px",
              borderRadius: 8,
              border: "none",
              background: D.red,
              color: D.white,
              fontSize: 13,
              fontWeight: 600,
              cursor: "pointer",
              opacity: publishing ? 0.5 : 1,
            }}
          >
            {publishing ? "Retrying…" : "Retry publish"}
          </button>
        )}
      </div>
      {post.astro_publish_error &&
        (status === "publish_failed" || status === "build_failed") && (
          <div
            style={{
              marginTop: 10,
              padding: 10,
              borderRadius: 6,
              background: "#FEF2F2",
              color: D.red,
              fontSize: 11,
              fontFamily: MONO,
            }}
          >
            {post.astro_publish_error}
          </div>
        )}
    </Card>
  );
}

const ASTRO_PILLS = {
  draft: { label: "DRAFT", bg: "#f5f5f4", fg: "#57534e", border: "#e7e5e4" },
  pr_open: {
    label: "PREVIEW OPEN",
    bg: "#EFF6FF",
    fg: "#1D4ED8",
    border: "#BFDBFE",
  },
  build_failed: {
    label: "BUILD FAILED",
    bg: "#FEF2F2",
    fg: "#991B1B",
    border: "#FECACA",
  },
  merged: { label: "MERGED", bg: "#ECFDF5", fg: "#065F46", border: "#A7F3D0" },
  live: { label: "LIVE", bg: "#ECFDF5", fg: "#15803D", border: "#86EFAC" },
  publish_failed: {
    label: "PUBLISH FAILED",
    bg: "#FEF2F2",
    fg: "#991B1B",
    border: "#FECACA",
  },
  unpublish_pending: {
    label: "UNPUBLISH PENDING",
    bg: "#fafaf9",
    fg: "#991B1B",
    border: "#e7e5e4",
  },
};

// =========================================================================
// AUDIT TAB
// =========================================================================
function AuditTab() {
  const [audit, setAudit] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    adminFetch("/admin/content/blog/audit")
      .then((d) => {
        setAudit(d.audit);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  if (loading)
    return (
      <div style={{ color: D.muted, padding: 40, textAlign: "center" }}>
        Running blog audit...
      </div>
    );
  if (!audit)
    return (
      <Card style={{ padding: 40, textAlign: "center" }}>
        <div style={{ color: D.muted }}>Unable to load audit</div>
      </Card>
    );

  const barStyle = (count, max, color) => ({
    height: 14,
    borderRadius: 3,
    background: color,
    width: `${Math.min((count / Math.max(max, 1)) * 100, 100)}%`,
    minWidth: count > 0 ? 4 : 0,
  });

  const maxTag = Math.max(
    ...Object.values(audit.topicDistribution?.counts || { x: 1 }),
  );
  const maxCity = Math.max(
    ...Object.values(audit.cityDistribution?.counts || { x: 1 }),
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {/* Summary */}
      <Card>
        {" "}
        <div
          style={{
            fontSize: 16,
            fontWeight: 700,
            color: D.heading,
            marginBottom: 12,
          }}
        >
          Content Health Scorecard
        </div>{" "}
        <div style={{ fontSize: 14, color: D.text, marginBottom: 16 }}>
          Total posts:{" "}
          <span style={{ fontFamily: MONO, color: D.teal }}>{audit.total}</span>{" "}
          ({audit.published} published + {audit.drafts} drafts + {audit.queued}{" "}
          queued + {audit.ideas} ideas)
        </div>
        {/* Recommendations */}
        {(audit.recommendations || []).map((rec, i) => {
          const prioColor =
            rec.priority === "critical"
              ? D.red
              : rec.priority === "high"
                ? D.orange
                : D.amber;
          const prioLabel =
            rec.priority === "critical"
              ? "CRITICAL"
              : rec.priority === "high"
                ? "HIGH"
                : "MEDIUM";
          return (
            <div
              key={i}
              style={{
                padding: "12px 16px",
                background: D.bg,
                borderRadius: 8,
                marginBottom: 8,
                borderLeft: `3px solid ${prioColor}`,
              }}
            >
              {" "}
              <div
                style={{
                  fontSize: 11,
                  color: prioColor,
                  fontWeight: 700,
                  marginBottom: 2,
                }}
              >
                {prioLabel}
              </div>{" "}
              <div style={{ fontSize: 13, fontWeight: 600, color: D.heading }}>
                {rec.title}
              </div>{" "}
              <div style={{ fontSize: 12, color: D.muted }}>
                {rec.action}
              </div>{" "}
            </div>
          );
        })}
      </Card>
      {/* Topic Distribution */}
      <Card>
        {" "}
        <div
          style={{
            fontSize: 15,
            fontWeight: 600,
            color: D.heading,
            marginBottom: 16,
          }}
        >
          By Topic
        </div>
        {Object.entries(audit.topicDistribution?.counts || {})
          .sort((a, b) => b[1] - a[1])
          .map(([tag, count]) => {
            const isLow = count < 5;
            return (
              <div
                key={tag}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  marginBottom: 6,
                }}
              >
                {" "}
                <div
                  style={{
                    width: 120,
                    fontSize: 12,
                    color: isLow ? D.amber : D.text,
                    textAlign: "right",
                  }}
                >
                  {tag}
                </div>{" "}
                <div
                  style={{
                    flex: 1,
                    height: 14,
                    background: D.bg,
                    borderRadius: 3,
                  }}
                >
                  {" "}
                  <div
                    style={barStyle(count, maxTag, isLow ? D.amber : D.teal)}
                  />{" "}
                </div>{" "}
                <div
                  style={{
                    width: 30,
                    fontSize: 12,
                    color: D.muted,
                    fontFamily: MONO,
                  }}
                >
                  {count}
                </div>
                {isLow && (
                  <span
                    style={{ fontSize: 10, color: D.amber, fontWeight: 600 }}
                  >
                    LOW
                  </span>
                )}
              </div>
            );
          })}
        {(audit.topicDistribution?.gaps || []).length > 0 && (
          <div
            style={{
              marginTop: 12,
              padding: 12,
              background: D.bg,
              borderRadius: 8,
            }}
          >
            {" "}
            <div
              style={{
                fontSize: 12,
                fontWeight: 600,
                color: D.amber,
                marginBottom: 6,
              }}
            >
              Content Gaps
            </div>
            {audit.topicDistribution.gaps.map((g, i) => (
              <div
                key={i}
                style={{ fontSize: 12, color: D.text, marginBottom: 2 }}
              >
                {"•"} {g}
              </div>
            ))}
          </div>
        )}
      </Card>
      {/* City Distribution */}
      <Card>
        {" "}
        <div
          style={{
            fontSize: 15,
            fontWeight: 600,
            color: D.heading,
            marginBottom: 16,
          }}
        >
          By City
        </div>
        {Object.entries(audit.cityDistribution?.counts || {})
          .sort((a, b) => b[1] - a[1])
          .map(([city, count]) => {
            const isHigh = audit.cityDistribution.overrepresented?.some(
              (o) => o.city === city,
            );
            const isLow = count === 0;
            return (
              <div
                key={city}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  marginBottom: 6,
                }}
              >
                {" "}
                <div
                  style={{
                    width: 130,
                    fontSize: 12,
                    color: isHigh ? D.amber : D.text,
                    textAlign: "right",
                  }}
                >
                  {city}
                </div>{" "}
                <div
                  style={{
                    flex: 1,
                    height: 14,
                    background: D.bg,
                    borderRadius: 3,
                  }}
                >
                  {" "}
                  <div
                    style={barStyle(count, maxCity, isHigh ? D.amber : D.green)}
                  />{" "}
                </div>{" "}
                <div
                  style={{
                    width: 30,
                    fontSize: 12,
                    color: D.muted,
                    fontFamily: MONO,
                  }}
                >
                  {count}
                </div>
                {isHigh && (
                  <span
                    style={{ fontSize: 10, color: D.amber, fontWeight: 600 }}
                  >
                    overweight
                  </span>
                )}
                {isLow && (
                  <span style={{ fontSize: 10, color: D.red, fontWeight: 600 }}>
                    LOW
                  </span>
                )}
              </div>
            );
          })}
      </Card>
      {/* Duplicates */}
      {(audit.duplicates || []).length > 0 && (
        <Card>
          {" "}
          <div
            style={{
              fontSize: 15,
              fontWeight: 600,
              color: D.red,
              marginBottom: 12,
            }}
          >
            Duplicates Found ({audit.duplicates.length})
          </div>
          {audit.duplicates.map((d, i) => (
            <div
              key={i}
              style={{
                padding: "8px 12px",
                background: D.bg,
                borderRadius: 6,
                marginBottom: 6,
                fontSize: 12,
              }}
            >
              {" "}
              <div style={{ color: D.text }}>
                1. "{d.post1.title}"{" "}
                <span style={{ color: D.muted }}>({d.post1.status})</span>
              </div>{" "}
              <div style={{ color: D.text }}>
                2. "{d.post2.title}"{" "}
                <span style={{ color: D.muted }}>({d.post2.status})</span>
              </div>{" "}
              <div style={{ color: D.amber, fontSize: 11 }}>
                Match: {d.matchType}
              </div>{" "}
            </div>
          ))}
        </Card>
      )}

      {/* Top Performers */}
      {(audit.topPerformers || []).length > 0 && (
        <Card>
          {" "}
          <div
            style={{
              fontSize: 15,
              fontWeight: 600,
              color: D.green,
              marginBottom: 12,
            }}
          >
            Top Performing Posts
          </div>
          {audit.topPerformers.map((p, i) => (
            <div
              key={i}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "6px 0",
                borderBottom:
                  i < audit.topPerformers.length - 1
                    ? `1px solid ${D.border}`
                    : "none",
              }}
            >
              {" "}
              <span
                style={{
                  fontSize: 12,
                  fontFamily: MONO,
                  color: D.green,
                  width: 50,
                }}
              >
                {p.score}/100
              </span>{" "}
              <span style={{ fontSize: 12, color: D.text }}>
                {p.title}
              </span>{" "}
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}

// =========================================================================
// GENERATE TAB
// =========================================================================

const CONTENT_TYPES = [
  {
    id: "blog_post",
    label: "Blog Post",
    desc: "800–1200 words, entity-complete, FAQ schema from SERP consensus",
  },
  {
    id: "page_refresh",
    label: "Page Refresh",
    desc: "Update existing page: add missing entities, expand FAQs, fix schema",
  },
  {
    id: "pest_pressure",
    label: "Pest Pressure Report",
    desc: "Weekly SWFL conditions + actionable advice",
  },
  {
    id: "gbp_post",
    label: "GBP Post",
    desc: "150–300 words, Google Business Profile",
  },
  {
    id: "service_page",
    label: "Service Page",
    desc: "1500–2000 words, full entity coverage, semantic depth",
  },
];

const CITIES = [
  "Lakewood Ranch",
  "Parrish",
  "Bradenton",
  "Sarasota",
  "Venice",
  "North Port",
  "Port Charlotte",
];

const SUGGESTIONS = {
  blog_post: [
    "Termite swarm season — what Lakewood Ranch homeowners need to know",
    "Chinch bug damage vs drought stress — how to tell the difference",
    "Why mosquito season starts earlier every year in Southwest Florida",
    "German roach infestation — what it actually takes to eliminate them",
    "Fertilizer blackout rules in Sarasota County — complete guide",
    "Roof rats in SWFL — entry points, signs, and exclusion",
  ],
  page_refresh: [
    "Refresh pest-control-bradenton-fl — add missing entities from SERP competitors",
    "Expand lawn-care-sarasota-fl FAQs based on People Also Ask",
    "Update termite-control-bradenton-fl schema to match SERP consensus",
    "Add seasonal freshness signals to mosquito-control pages",
    "Fill entity gaps on rodent-control-venice-fl vs top 5 competitors",
  ],
  pest_pressure: [
    "This week in SWFL pest pressure — April conditions and what to watch",
    "Rainy season pest surge — what is moving indoors right now",
    "Post-storm pest activity — what homeowners should check",
  ],
  gbp_post: [
    "Spring lawn tip: why your irrigation schedule needs to change now",
    "Seeing winged insects near windows? Here is what they might be",
    "Rodent season is ramping up — 3 signs to check today",
  ],
  service_page: [
    "Quarterly pest control in Bradenton — what is included and what to expect",
    "Rodent exclusion services — how we seal your home permanently",
    "Mosquito control program — monthly treatment for SWFL yards",
  ],
};

const ARTICLE_CHECKLIST = [
  { label: "All entities competitors cover — no gaps" },
  { label: "FAQ section from SERP consensus (People Also Ask)" },
  { label: "Schema markup (FAQ, HowTo, LocalBusiness)" },
  { label: "FAWN weather data (timestamped, station-specific)" },
  { label: "UF/IFAS citation with EDIS publication ID" },
  { label: "Specific neighborhood reference for target city" },
  { label: "Real field observation from tech data" },
  { label: "WaveGuard CTA tied to the specific problem" },
];

function GenerateTab({ onGenerated }) {
  const [contentType, setContentType] = useState("blog_post");
  const [topic, setTopic] = useState("");
  const [city, setCity] = useState("Lakewood Ranch");
  const [generating, setGenerating] = useState(false);
  const [weather, setWeather] = useState(null);
  const [signals, setSignals] = useState([]);

  useEffect(() => {
    adminFetch("/admin/content/weather")
      .then((d) => {
        setWeather(d.weather || d);
        setSignals(d.signals || []);
      })
      .catch(() => {});
  }, []);

  const handleGenerate = async () => {
    if (!topic.trim()) return;
    setGenerating(true);
    try {
      const result = await adminPost("/admin/content/generate", {
        topic: topic.trim(),
        contentType,
        targetCity: city,
      });
      setGenerating(false);
      if (result.post || result.id) {
        onGenerated();
      }
    } catch (err) {
      alert(`Generate failed: ${err.message}`);
      setGenerating(false);
    }
  };

  const suggestions = SUGGESTIONS[contentType] || SUGGESTIONS.blog_post;

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: isMobile ? "1fr" : "1fr 340px",
        gap: 20,
        alignItems: "start",
      }}
    >
      {/* Left — main form */}
      <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
        {/* A) Content type selector */}
        <Card>
          {" "}
          <div
            style={{
              fontSize: 14,
              fontWeight: 600,
              color: D.heading,
              marginBottom: 12,
            }}
          >
            Content Type
          </div>{" "}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: isMobile ? "1fr" : "repeat(2, 1fr)",
              gap: 10,
            }}
          >
            {CONTENT_TYPES.map((ct) => (
              <div
                key={ct.id}
                onClick={() => setContentType(ct.id)}
                style={{
                  padding: "14px 16px",
                  borderRadius: 10,
                  cursor: "pointer",
                  transition: "all 0.15s",
                  background: contentType === ct.id ? D.teal + "18" : D.bg,
                  border: `1px solid ${contentType === ct.id ? D.teal : D.border}`,
                }}
              >
                {" "}
                <div
                  style={{
                    fontSize: 13,
                    fontWeight: 600,
                    color: contentType === ct.id ? D.teal : D.heading,
                  }}
                >
                  {ct.label}
                </div>{" "}
                <div style={{ fontSize: 11, color: D.muted, marginTop: 2 }}>
                  {ct.desc}
                </div>{" "}
              </div>
            ))}
          </div>{" "}
        </Card>
        {/* B) Topic input + suggestions */}
        <Card>
          {" "}
          <div
            style={{
              fontSize: 14,
              fontWeight: 600,
              color: D.heading,
              marginBottom: 8,
            }}
          >
            Topic
          </div>{" "}
          <textarea
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            placeholder="Describe the topic or paste a working title..."
            rows={3}
            style={{
              width: "100%",
              padding: "10px 12px",
              borderRadius: 8,
              border: `1px solid ${D.border}`,
              background: D.bg,
              color: D.heading,
              fontSize: 14,
              lineHeight: 1.5,
              fontFamily: "'Roboto', Arial, sans-serif",
              resize: "vertical",
              boxSizing: "border-box",
            }}
          />{" "}
          <div
            style={{
              fontSize: 11,
              color: D.muted,
              marginTop: 8,
              marginBottom: 6,
            }}
          >
            Suggestions — click to use
          </div>{" "}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {suggestions.map((s, i) => (
              <button
                key={i}
                onClick={() => setTopic(s)}
                style={{
                  padding: "5px 10px",
                  borderRadius: 6,
                  border: `1px solid ${D.border}`,
                  background: topic === s ? D.teal + "22" : "transparent",
                  color: topic === s ? D.teal : D.muted,
                  fontSize: 11,
                  cursor: "pointer",
                  textAlign: "left",
                  lineHeight: 1.3,
                }}
              >
                {s}
              </button>
            ))}
          </div>{" "}
        </Card>
        {/* C) City selector */}
        <Card>
          {" "}
          <div
            style={{
              fontSize: 14,
              fontWeight: 600,
              color: D.heading,
              marginBottom: 10,
            }}
          >
            Target City
          </div>{" "}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {CITIES.map((c) => (
              <button
                key={c}
                onClick={() => setCity(c)}
                style={{
                  padding: "6px 14px",
                  borderRadius: 20,
                  border: "none",
                  cursor: "pointer",
                  fontSize: 12,
                  fontWeight: 500,
                  background: city === c ? D.teal : D.bg,
                  color: city === c ? D.white : D.muted,
                  transition: "all 0.15s",
                }}
              >
                {c}
              </button>
            ))}
          </div>{" "}
        </Card>
        {/* E) Generate button */}
        <button
          onClick={handleGenerate}
          disabled={generating || !topic.trim()}
          style={{
            padding: "14px 24px",
            borderRadius: 10,
            border: "none",
            background: generating ? D.border : D.teal,
            color: D.heading,
            fontSize: 15,
            fontWeight: 700,
            cursor: generating ? "default" : "pointer",
            opacity: !topic.trim() ? 0.4 : 1,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 10,
          }}
        >
          {generating ? (
            <>
              {" "}
              <span
                style={{
                  display: "inline-block",
                  width: 16,
                  height: 16,
                  border: `2px solid ${D.white}44`,
                  borderTopColor: D.white,
                  borderRadius: "50%",
                  animation: "spin 0.8s linear infinite",
                }}
              />
              Generating — pulling FAWN data, building prompt...
            </>
          ) : (
            <>
              Generate {CONTENT_TYPES.find((c) => c.id === contentType)?.label}
            </>
          )}
        </button>{" "}
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>{" "}
      </div>
      {/* D) Right — info panel */}
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {/* Weather snapshot */}
        <Card style={{ padding: 16 }}>
          {" "}
          <div
            style={{
              fontSize: 13,
              fontWeight: 600,
              color: D.heading,
              marginBottom: 10,
            }}
          >
            FAWN Weather
          </div>
          {weather ? (
            <div style={{ fontSize: 12, color: D.text, lineHeight: 1.7 }}>
              {weather.temp && (
                <div>
                  Temp:{" "}
                  <span style={{ color: D.teal, fontFamily: MONO }}>
                    {weather.temp}F
                  </span>
                </div>
              )}
              {weather.humidity && (
                <div>
                  Humidity:{" "}
                  <span style={{ fontFamily: MONO }}>{weather.humidity}%</span>
                </div>
              )}
              {weather.rainfall && (
                <div>
                  Rainfall (7d):{" "}
                  <span style={{ fontFamily: MONO }}>{weather.rainfall}"</span>
                </div>
              )}
              {weather.soilTemp && (
                <div>
                  Soil temp:{" "}
                  <span style={{ fontFamily: MONO }}>{weather.soilTemp}F</span>
                </div>
              )}
              {weather.station && (
                <div style={{ fontSize: 10, color: D.muted, marginTop: 4 }}>
                  Station: {weather.station}
                </div>
              )}
              {!weather.temp && (
                <div style={{ color: D.muted }}>
                  Weather data will be fetched at generation time
                </div>
              )}
            </div>
          ) : (
            <div style={{ fontSize: 12, color: D.muted }}>
              Weather data loads when API is connected
            </div>
          )}
        </Card>
        {/* Active signals */}
        {signals.length > 0 && (
          <Card style={{ padding: 16 }}>
            {" "}
            <div
              style={{
                fontSize: 13,
                fontWeight: 600,
                color: D.amber,
                marginBottom: 8,
              }}
            >
              Active Signals
            </div>
            {signals.map((s, i) => (
              <div
                key={i}
                style={{
                  fontSize: 12,
                  color: D.text,
                  marginBottom: 4,
                  paddingLeft: 8,
                  borderLeft: `2px solid ${D.amber}`,
                }}
              >
                {s}
              </div>
            ))}
          </Card>
        )}
        {/* Article checklist */}
        <Card style={{ padding: 16 }}>
          {" "}
          <div
            style={{
              fontSize: 13,
              fontWeight: 600,
              color: D.heading,
              marginBottom: 10,
            }}
          >
            Every article includes
          </div>
          {ARTICLE_CHECKLIST.map((item, i) => (
            <div
              key={i}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                marginBottom: 6,
              }}
            >
              {" "}
              <span style={{ fontSize: 11, color: D.green, fontWeight: 600 }}>
                </span>{" "}
              <span style={{ fontSize: 11, color: D.text }}>
                {item.label}
              </span>{" "}
            </div>
          ))}
        </Card>{" "}
      </div>{" "}
    </div>
  );
}

// =========================================================================
// MAIN PAGE
// =========================================================================
const ContentCalendar = lazy(() => import("./ContentCalendar"));
const TABS = [
  { key: "posts", label: "Posts", Icon: FileText },
  { key: "generate", label: "Generate", Icon: Wand2 },
  { key: "calendar", label: "Calendar", Icon: CalendarDays },
  { key: "audit", label: "Audit", Icon: FileCheck2 },
  { key: "autopilot", label: "Autopilot", Icon: Bot },
  { key: "registry", label: "Registry", Icon: Database },
];

// Post lifecycle statuses are a sub-filter inside the Posts tab (was four
// separate top-level tabs: Published/Drafts/Queued/Ideas). Keys are the
// actual blog_posts.status values; counts come from
// /admin/content/blog/analytics (byStatus).
const POST_STATUSES = [
  { key: "published", label: "Published" },
  { key: "draft", label: "Drafts" },
  { key: "queued", label: "Queued" },
  { key: "idea", label: "Ideas" },
];

export default function BlogPage() {
  // Tab lives in the URL (?tab=) so the retired /admin/content-engine and
  // /admin/content-registry routes can redirect straight to the right tab
  // and individual surfaces stay deep-linkable.
  const [searchParams, setSearchParams] = useSearchParams();
  const paramTab = searchParams.get("tab");
  const tab = TABS.some((t) => t.key === paramTab) ? paramTab : "posts";
  const setTab = (next) =>
    setSearchParams(
      (current) => {
        const params = new URLSearchParams(current);
        params.set("tab", next);
        return params;
      },
      { replace: true },
    );
  const [selectedPost, setSelectedPost] = useState(null);
  const [counts, setCounts] = useState({});
  const [generatingIdeas, setGeneratingIdeas] = useState(false);
  // Posts tab sub-filter (Published/Drafts/Queued/Ideas).
  const [postStatus, setPostStatus] = useState("published");
  const goToPosts = (status) => {
    setPostStatus(status);
    setTab("posts");
  };

  useEffect(() => {
    adminFetch("/admin/content/blog/analytics")
      .then((d) => setCounts(d.byStatus || {}))
      .catch(() => {});
  }, [tab]);

  const handleGenerateIdeas = async () => {
    setGeneratingIdeas(true);
    try {
      await adminPost("/admin/content/blog/ideas", { count: 20 });
      goToPosts("idea");
    } catch (err) {
      alert(`Idea generation failed: ${err.message}`);
    }
    setGeneratingIdeas(false);
  };

  if (selectedPost) {
    return (
      <div>
        {" "}
        <AdminCommandHeader title="Content Editor" icon={Newspaper} />{" "}
        <PostEditor
          post={selectedPost}
          onBack={() => setSelectedPost(null)}
          onUpdate={(p) => {
            setSelectedPost(null);
          }}
        />{" "}
      </div>
    );
  }

  return (
    <div>
      {" "}
      <AdminCommandHeader
        title="Blog"
        icon={Newspaper}
        sections={TABS}
        activeKey={tab}
        onSectionChange={setTab}
        ariaLabel="Blog section"
        navGridClassName="grid-cols-2 md:grid-cols-3 xl:grid-cols-6"
        action={
          tab === "autopilot" || tab === "registry"
            ? null
            : {
                label: generatingIdeas ? "Generating..." : "Create Blog",
                icon: Plus,
                onClick: handleGenerateIdeas,
                disabled: generatingIdeas,
              }
        }
      />
      {tab === "generate" ? (
        <GenerateTab onGenerated={() => goToPosts("draft")} />
      ) : tab === "audit" ? (
        <AuditTab />
      ) : tab === "calendar" ? (
        <Suspense
          fallback={
            <div style={{ color: D.muted, padding: 40, textAlign: "center" }}>
              Loading calendar...
            </div>
          }
        >
          <ContentCalendar />
        </Suspense>
      ) : tab === "autopilot" ? (
        <Suspense
          fallback={
            <div style={{ color: D.muted, padding: 40, textAlign: "center" }}>
              Loading autopilot...
            </div>
          }
        >
          <AutonomousContentReviewPage embedded />
        </Suspense>
      ) : tab === "registry" ? (
        <Suspense
          fallback={
            <div style={{ color: D.muted, padding: 40, textAlign: "center" }}>
              Loading registry...
            </div>
          }
        >
          <ContentRegistryPage embedded />
        </Suspense>
      ) : (
        <>
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: 8,
              marginBottom: 16,
            }}
          >
            {POST_STATUSES.map((s) => {
              const active = postStatus === s.key;
              return (
                <button
                  key={s.key}
                  type="button"
                  onClick={() => setPostStatus(s.key)}
                  style={{
                    height: 36,
                    padding: "0 14px",
                    borderRadius: 6,
                    fontSize: 12,
                    fontWeight: 700,
                    textTransform: "uppercase",
                    letterSpacing: "0.04em",
                    cursor: "pointer",
                    border: `1px solid ${active ? D.heading : D.border}`,
                    background: active ? D.heading : D.card,
                    color: active ? "#fff" : D.text,
                  }}
                >
                  {s.label}
                  {counts[s.key] != null ? ` (${counts[s.key]})` : ""}
                </button>
              );
            })}
          </div>
          <PostList
            key={postStatus}
            status={postStatus}
            onSelectPost={setSelectedPost}
          />
        </>
      )}
    </div>
  );
}
