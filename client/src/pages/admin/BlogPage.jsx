import React, { useState, useEffect, lazy, Suspense } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import useRenderedTabBeacon from "../../hooks/useRenderedTabBeacon";
import {
  Bot,
  CalendarDays,
  Database,
  FileCheck2,
  FileText,
  Newspaper,
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
// Tier 2 token pass: preserve the existing inline-style architecture while
// folding every non-alert accent into the shared zinc palette.
const D = {
  bg: "#F4F4F5",
  card: "#FFFFFF",
  border: "rgba(9, 9, 11, 0.06)",
  teal: "#09090B",
  green: "#52525B",
  amber: "#52525B",
  red: "#A32D2D",
  orange: "#52525B",
  text: "#52525B",
  muted: "#71717A",
  white: "#FFFFFF",
  purple: "#09090B",
  heading: "#09090B",
  inputBorder: "rgba(9, 9, 11, 0.1)",
};
const MONO = "'JetBrains Mono', monospace";
const HUB_BLOG_TARGET_SITES = ["wavespestcontrol.com"];
const BLOG_TOKEN_STYLES = `
  .admin-blog-token-scope button {
    text-transform: uppercase;
    letter-spacing: 0.06em !important;
    font-weight: 500;
    font-size: 14px;
  }
  .admin-blog-token-scope .admin-blog-generate:disabled {
    border-color: ${D.border} !important;
    background: ${D.bg} !important;
    color: ${D.text} !important;
  }
  @media (max-width: 639px) {
    .admin-blog-token-scope button,
    .admin-blog-token-scope input,
    .admin-blog-token-scope select {
      min-height: 44px;
    }
  }
`;
const TOKEN_SCOPED_TABS = new Set(["posts", "generate", "audit"]);

function blogTokenScopeClass(tab) {
  return TOKEN_SCOPED_TABS.has(tab) ? "admin-blog-token-scope" : undefined;
}

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

// blog_posts.publish_date is a pg DATE: knex hydrates it as a JS Date and the
// API serializes a full ISO string ("2026-07-15T00:00:00.000Z"), while seeded
// or legacy rows can carry a bare "YYYY-MM-DD". Appending "T12:00:00" to the
// ISO form made every dated row render "Invalid Date" — take the stored date
// part for either shape (same defense as ContentCalendar's calendarDateKey).
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
function publishDateLabel(value) {
  if (!value) return "";
  const text = String(value);
  const dateOnly = DATE_ONLY.test(text) ? text : text.slice(0, 10);
  const parsed = new Date(dateOnly + "T12:00:00");
  return Number.isNaN(parsed.getTime())
    ? ""
    : parsed.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      });
}

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
  return score < 50 ? D.red : D.text;
}

// =========================================================================
// POST LIST COMPONENT (shared between Published, Drafts, Calendar, Ideas)
// =========================================================================
function PostList({ status, onSelectPost }) {
  const [posts, setPosts] = useState([]);
  const [counts, setCounts] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [filterTag, setFilterTag] = useState("");
  const [filterCity, setFilterCity] = useState("");
  const [search, setSearch] = useState("");
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    let url = `/admin/content/blog?status=${status}`;
    if (filterTag) url += `&tag=${encodeURIComponent(filterTag)}`;
    if (filterCity) url += `&city=${encodeURIComponent(filterCity)}`;
    if (search) url += `&search=${encodeURIComponent(search)}`;
    if (status === "published") url += "&sort=seo_score&order=asc";
    adminFetch(url)
      .then((d) => {
        if (!active) return;
        setPosts(d.posts || []);
        setCounts(d.counts || {});
        setLoading(false);
      })
      .catch((requestError) => {
        if (!active) return;
        setError(requestError.message || "Request failed");
        setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [status, filterTag, filterCity, search, retry]);

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
            fontSize: 14,
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
            fontSize: 14,
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
            fontSize: 14,
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
        <span style={{ fontSize: 14, color: D.muted, marginLeft: "auto" }}>
          {error ? "Posts unavailable" : `${posts.length} posts`}
        </span>{" "}
      </div>
      {/* Post Cards */}
      {error ? (
        <div role="alert" style={{ color: D.red, padding: 16, fontSize: 14 }}>
          <p>Couldn't load posts — {error}</p>
          <button
            type="button"
            onClick={() => setRetry((value) => value + 1)}
            style={{
              minHeight: 44,
              padding: "8px 16px",
              border: `1px solid ${D.border}`,
              borderRadius: 4,
              background: D.card,
              color: D.text,
              fontSize: 14,
            }}
          >
            Try again
          </button>
        </div>
      ) : posts.length === 0 ? (
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
                    fontWeight: 500,
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
                      fontSize: 14,
                      color: D.red,
                      fontWeight: 500,
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
                    fontSize: 14,
                    color: D.muted,
                    flexWrap: "wrap",
                  }}
                >
                  {p.tag && <span>{p.tag}</span>}
                  {p.city && <span>{p.city}</span>}
                  {p.keyword && <span>{p.keyword}</span>}
                  {publishDateLabel(p.publish_date) && (
                    <span>{publishDateLabel(p.publish_date)}</span>
                  )}
                  {p.word_count > 0 && <span>{p.word_count} words</span>}
                </div>{" "}
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
  const handleShareSocial = async (force = false) => {
    setSharing(true);
    try {
      const result = await adminPost(
        `/admin/content/blog/${post.id}/share-social`,
        force ? { force: true } : {},
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
      // Posts auto-share when they go live now — a plain click on an
      // already-shared post 409s; confirm before deliberately re-posting.
      if (!force && /already went out|alreadyShared/i.test(err.message || "")) {
        setSharing(false);
        if (
          window.confirm(
            "This post was already shared to social. Share it again anyway?",
          )
        ) {
          await handleShareSocial(true);
        }
        return;
      }
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
          fontSize: 14,
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
                fontSize: 14,
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
                fontWeight: 500,
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
                  fontSize: 14,
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
                  fontSize: 14,
                }}
              />{" "}
            </div>{" "}
            <div>
              {" "}
              <label
                style={{
                  fontSize: 14,
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
                  fontSize: 14,
                }}
              />{" "}
            </div>{" "}
            <div>
              {" "}
              <label
                style={{
                  fontSize: 14,
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
                  fontSize: 14,
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
                  fontSize: 14,
                  color: D.muted,
                  display: "block",
                  marginBottom: 4,
                }}
              >
                Status
              </label>{" "}
              <div
                style={{
                  padding: "6px 10px",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  fontSize: 14,
                  color: D.text,
                  textTransform: "uppercase",
                  letterSpacing: "0.06em",
                }}
              >
                <span
                  aria-hidden="true"
                  data-qa="blog-status-dot"
                  style={{
                    width: 5,
                    height: 5,
                    boxSizing: "border-box",
                    borderRadius: "50%",
                    border: `1px solid ${D.text}`,
                  }}
                />
                {editing.status}
              </div>{" "}
            </div>{" "}
          </div>{" "}
          <div>
            {" "}
            <label
              style={{
                fontSize: 14,
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
                fontSize: 14,
              }}
            />{" "}
            <div
              style={{
                fontSize: 14,
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
            fontSize: 14,
            fontWeight: 500,
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
                fontSize: 14,
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
                fontSize: 14,
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
                fontSize: 14,
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
                fontSize: 14,
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
                fontSize: 14,
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
                fontSize: 14,
              }}
            />{" "}
          </div>{" "}
          <div>
            {" "}
            <label
              style={{
                fontSize: 14,
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
                fontSize: 14,
              }}
            />{" "}
          </div>{" "}
          <div>
            {" "}
            <label
              style={{
                fontSize: 14,
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
                fontSize: 14,
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
                fontSize: 14,
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
                fontSize: 14,
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
                fontSize: 14,
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
                fontSize: 14,
              }}
            />{" "}
          </div>{" "}
        </div>{" "}
        <div style={{ marginTop: 14 }}>
          {" "}
          <label
            style={{
              fontSize: 14,
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
                    borderRadius: 4,
                    fontSize: 14,
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
              fontSize: 14,
              color: D.muted,
              display: "block",
              marginBottom: 6,
            }}
          >
            Publish target
          </label>
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: 8,
              alignItems: "center",
            }}
          >
            <span
              style={{
                padding: "4px 10px",
                borderRadius: 3,
                fontSize: 14,
                border: `1px solid ${D.green}`,
                background: D.green,
                color: D.white,
                whiteSpace: "nowrap",
              }}
            >
              Hub — wavespestcontrol.com
            </span>
            <span style={{ color: D.muted, fontSize: 14 }}>
              Blog posts publish only on the Waves hub. Use service/location
              pages for spoke domains.
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
          <div style={{ fontSize: 15, fontWeight: 500, color: D.heading }}>
            Content
          </div>{" "}
          <div style={{ display: "flex", gap: 8 }}>
            {editing.content && (
              <>
                {" "}
                <button
                  onClick={handleOptimize}
                  disabled={optimizing}
                  style={{
                    padding: "6px 14px",
                    borderRadius: 6,
                    border: `1px solid ${D.amber}`,
                    background: "transparent",
                    color: D.amber,
                    fontSize: 14,
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
            <label style={{ fontSize: 14, color: D.muted }}>
              Featured Image (AI-generated)
            </label>{" "}
            <button
              type="button"
              onClick={handleRegenerateImage}
              disabled={regeneratingImage}
              style={{
                padding: "4px 10px",
                borderRadius: 6,
                fontSize: 14,
                fontWeight: 500,
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
                fontSize: 14,
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
                    fontSize: 14,
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
              fontSize: 14,
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
            No content yet. New posts come from Autopilot; this one has no body
            to edit or publish.
          </div>
        )}
        {editing.content && (
          <div
            style={{
              display: "flex",
              gap: 16,
              marginTop: 8,
              fontSize: 14,
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
              fontWeight: 500,
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
              <div style={{ fontSize: 14, color: D.muted }}>
                Suggested Title
              </div>{" "}
              <div style={{ fontSize: 14, color: D.heading }}>
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
              <div style={{ fontSize: 14, color: D.muted }}>
                Suggested Meta
              </div>{" "}
              <div style={{ fontSize: 14, color: D.text }}>
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
              <div style={{ fontSize: 14, color: D.muted }}>
                Suggested Keyword
              </div>{" "}
              <div style={{ fontSize: 14, color: D.teal }}>
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
              <div style={{ fontSize: 14, color: D.muted, marginBottom: 4 }}>
                SEO Improvements
              </div>
              {optimization.seo_improvements.map((s, i) => (
                <div
                  key={i}
                  style={{ fontSize: 14, color: D.text, marginBottom: 2 }}
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
              <div style={{ fontSize: 14, color: D.muted, marginBottom: 4 }}>
                Add Internal Links
              </div>
              {optimization.missing_internal_links.map((l, i) => (
                <div
                  key={i}
                  style={{ fontSize: 14, color: D.text, marginBottom: 2 }}
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
                fontSize: 14,
                color: D.green,
                marginTop: 8,
                fontWeight: 500,
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
              background: D.heading,
              color: D.white,
              fontSize: 14,
              fontWeight: 500,
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
            fontSize: 14,
            fontWeight: 500,
            cursor: "pointer",
          }}
        >
          Save Draft
        </button>
        {/* Share only for LIVE posts — the server enforces the same gate
            (409 otherwise): sharing a draft/pending post publishes a dead
            404 link to every enabled platform. */}
        {editing.astro_status === "live" && (
          <button
            onClick={() => handleShareSocial()}
            disabled={sharing}
            style={{
              padding: "10px 20px",
              borderRadius: 8,
              border: `1px solid ${D.purple}`,
              background: "transparent",
              color: D.purple,
              fontSize: 14,
              fontWeight: 500,
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
            fontSize: 14,
            fontWeight: 500,
            color: pill.fg,
            textTransform: "uppercase",
            letterSpacing: "0.06em",
          }}
        >
          {" "}
          <span
            data-qa="blog-status-dot"
            style={{
              width: 5,
              height: 5,
              boxSizing: "border-box",
              borderRadius: 999,
              background: pill.filled ? pill.dot : "transparent",
              border: pill.filled ? "none" : `1px solid ${pill.dot}`,
              display: "inline-block",
            }}
          />
          {pill.label}
        </div>
        {post.astro_pr_number && (
          <div style={{ fontSize: 14, color: D.muted }}>
            PR #{post.astro_pr_number}
          </div>
        )}
        {post.astro_branch_name && (
          <div style={{ fontSize: 14, color: D.muted, fontFamily: MONO }}>
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
              fontSize: 14,
              fontWeight: 500,
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
                  fontSize: 14,
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
                fontSize: 14,
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
                  fontSize: 14,
                  fontWeight: 500,
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
                  fontSize: 14,
                  fontWeight: 500,
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
            <div style={{ fontSize: 14, color: D.muted }}>
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
                  fontSize: 14,
                  textDecoration: "none",
                  fontWeight: 500,
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
                fontSize: 14,
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
                border: `1px solid ${D.border}`,
                background: D.card,
                color: D.red,
                fontSize: 14,
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
                  fontSize: 14,
                  textDecoration: "none",
                  fontWeight: 500,
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
                border: `1px solid ${D.border}`,
                background: D.card,
                color: D.red,
                fontSize: 14,
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
                fontSize: 14,
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
                background: D.red,
                color: D.white,
                fontSize: 14,
                fontWeight: 500,
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
              fontSize: 14,
              fontWeight: 500,
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
              background: "#FCEBEB",
              color: D.red,
              fontSize: 14,
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
  draft: { label: "DRAFT", fg: D.muted, dot: D.muted, filled: false },
  pr_open: {
    label: "PREVIEW OPEN",
    fg: D.heading,
    dot: D.heading,
    filled: true,
  },
  build_failed: {
    label: "BUILD FAILED",
    fg: D.red,
    dot: D.red,
    filled: true,
  },
  merged: { label: "MERGED", fg: D.muted, dot: D.muted, filled: false },
  live: { label: "LIVE", fg: D.muted, dot: D.muted, filled: false },
  publish_failed: {
    label: "PUBLISH FAILED",
    fg: D.red,
    dot: D.red,
    filled: true,
  },
  unpublish_pending: {
    label: "UNPUBLISH PENDING",
    fg: D.text,
    dot: D.text,
    filled: false,
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
            fontWeight: 500,
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
                  fontSize: 14,
                  color: prioColor,
                  fontWeight: 500,
                  marginBottom: 2,
                }}
              >
                {prioLabel}
              </div>{" "}
              <div style={{ fontSize: 14, fontWeight: 500, color: D.heading }}>
                {rec.title}
              </div>{" "}
              <div style={{ fontSize: 14, color: D.muted }}>
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
            fontWeight: 500,
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
                    fontSize: 14,
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
                    fontSize: 14,
                    color: D.muted,
                    fontFamily: MONO,
                  }}
                >
                  {count}
                </div>
                {isLow && (
                  <span
                    style={{ fontSize: 14, color: D.amber, fontWeight: 500 }}
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
                fontSize: 14,
                fontWeight: 500,
                color: D.amber,
                marginBottom: 6,
              }}
            >
              Content Gaps
            </div>
            {audit.topicDistribution.gaps.map((g, i) => (
              <div
                key={i}
                style={{ fontSize: 14, color: D.text, marginBottom: 2 }}
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
            fontWeight: 500,
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
                    fontSize: 14,
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
                    fontSize: 14,
                    color: D.muted,
                    fontFamily: MONO,
                  }}
                >
                  {count}
                </div>
                {isHigh && (
                  <span
                    style={{ fontSize: 14, color: D.amber, fontWeight: 500 }}
                  >
                    overweight
                  </span>
                )}
                {isLow && (
                  <span style={{ fontSize: 14, color: D.red, fontWeight: 500 }}>
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
              fontWeight: 500,
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
                fontSize: 14,
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
              <div style={{ color: D.amber, fontSize: 14 }}>
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
              fontWeight: 500,
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
                  fontSize: 14,
                  fontFamily: MONO,
                  color: D.green,
                  width: 50,
                }}
              >
                {p.score}/100
              </span>{" "}
              <span style={{ fontSize: 14, color: D.text }}>
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
// MAIN PAGE
// =========================================================================
const ContentCalendar = lazy(() => import("./ContentCalendar"));
const TABS = [
  { key: "posts", label: "Posts", Icon: FileText },
  { key: "calendar", label: "Calendar", Icon: CalendarDays },
  { key: "audit", label: "Audit", Icon: FileCheck2 },
  { key: "autopilot", label: "Autopilot", Icon: Bot },
  { key: "registry", label: "Registry", Icon: Database },
];

// Post lifecycle statuses are a sub-filter inside the Posts tab (was four
// separate top-level tabs: Published/Drafts/Queued/Ideas). Keys are the
// actual blog_posts.status values; counts come from
// /admin/content/blog/analytics (byStatus). Queued and Ideas only held
// manual-create rows, retired 2026-10-30 (new posts come from Autopilot).
const POST_STATUSES = [
  { key: "published", label: "Published" },
  { key: "draft", label: "Drafts" },
];

// Old links to the retired Queued / Ideas lists open Drafts.
const RETIRED_POST_STATUS = { queued: "draft", idea: "draft" };

// Legacy ?tab= keys (the pre-collapse top-level status tabs) → Posts sub-filter
// status. Lets old deep links / history entries resolve to the right list.
const LEGACY_POST_TAB = {
  published: "published",
  drafts: "draft",
  queued: "draft",
  ideas: "draft",
};

export default function BlogPage() {
  // Tab lives in the URL (?tab=) so the retired /admin/content-engine and
  // /admin/content-registry routes can redirect straight to the right tab
  // and individual surfaces stay deep-linkable.
  const [searchParams, setSearchParams] = useSearchParams();
  const paramTab = searchParams.get("tab");
  // Back-compat: the old per-status top-level tabs are now sub-filters inside
  // Posts, so legacy deep links (?tab=drafts|queued|ideas|published) resolve to
  // the Posts tab with the matching status instead of silently opening Published.
  const legacyPostStatus = LEGACY_POST_TAB[paramTab];
  const tab = legacyPostStatus
    ? "posts"
    : TABS.some((t) => t.key === paramTab)
      ? paramTab
      : "posts";

  // Posts sub-filter (Published/Drafts) is URL-backed via ?status=
  // so it survives refresh / bookmark / share. Legacy ?tab=drafts|queued|ideas|
  // published links still resolve (via legacyPostStatus) and stay stable on
  // reload — no normalization needed, since postStatus is derived, not stored.
  const VALID_POST_STATUSES = POST_STATUSES.map((s) => s.key);
  const paramStatus = searchParams.get("status");
  const postStatus = VALID_POST_STATUSES.includes(paramStatus)
    ? paramStatus
    : RETIRED_POST_STATUS[paramStatus] || legacyPostStatus || "published";
  const postId = searchParams.get("post");

  // Usage beacon for the leaf that actually RENDERS — legacy status deep
  // links (?tab=drafts) and unknown values resolve to Posts without
  // rewriting the URL (Codex #2961 r17). While Posts is active, the
  // resolved ?status= sub-filter IS the rendered leaf (Published / Drafts /
  // Queued / Ideas are distinct recurring workflows; reporting the constant
  // 'posts' deduped them all into one row — Codex #2961 r20), matching the
  // deepest-leaf convention of the other nested reporters. No
  // active-re-click guard on setTab: clicking Posts while on a legacy
  // status URL must still rewrite ?tab=, which a same-resolved-key guard
  // would suppress.
  useRenderedTabBeacon(
    "/admin/blog",
    postId ? "editor" : tab === "posts" ? postStatus : tab,
    [searchParams],
  );

  const setTab = (next) =>
    setSearchParams(
      (current) => {
        const params = new URLSearchParams(current);
        params.set("tab", next);
        return params;
      },
      { replace: true },
    );
  const location = useLocation();
  const navigate = useNavigate();
  const [selectedPost, setSelectedPost] = useState(null);
  const [postError, setPostError] = useState("");
  const [postRetry, setPostRetry] = useState(0);
  const openPost = (post) => {
    const params = new URLSearchParams(searchParams);
    if (post) {
      params.set("post", String(post.id));
      navigate(
        {
          pathname: location.pathname,
          search: params.toString(),
          hash: location.hash,
        },
        {
          state: { ...location.state, blogEditorOrigin: "list" },
        },
      );
      return;
    }
    if (location.state?.blogEditorOrigin === "list") {
      navigate(-1);
      return;
    }
    params.delete("post");
    navigate(
      {
        pathname: location.pathname,
        search: params.toString(),
        hash: location.hash,
      },
      { replace: true },
    );
  };
  useEffect(() => {
    let active = true;
    setSelectedPost(null);
    setPostError("");
    if (postId) {
      adminFetch(`/admin/content/blog/${encodeURIComponent(postId)}`)
        .then((data) => {
          if (!active) return;
          if (!data.post) throw new Error("Post not found");
          setSelectedPost(data.post);
        })
        .catch((error) => {
          if (active) setPostError(error.message || "Request failed");
        });
    }
    return () => {
      active = false;
    };
  }, [postId, postRetry]);
  const [counts, setCounts] = useState({});
  const setPostStatus = (status) =>
    setSearchParams(
      (current) => {
        const params = new URLSearchParams(current);
        params.set("tab", "posts");
        params.set("status", status);
        return params;
      },
      { replace: true },
    );

  useEffect(() => {
    adminFetch("/admin/content/blog/analytics")
      .then((d) => setCounts(d.byStatus || {}))
      .catch(() => {});
  }, [tab]);

  if (postId) {
    return (
      <div className="admin-blog-token-scope">
        <style>{BLOG_TOKEN_STYLES}</style>
        <AdminCommandHeader title="Content editor" icon={Newspaper} />
        {postError ? (
          <div role="alert" style={{ padding: 20, fontSize: 14, color: D.red }}>
            <p>Couldn't load this post — {postError}</p>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              <button
                type="button"
                onClick={() => setPostRetry((value) => value + 1)}
                style={{ minHeight: 44, padding: "8px 16px" }}
              >
                Try again
              </button>
              <button
                type="button"
                onClick={() => openPost(null)}
                style={{ minHeight: 44, padding: "8px 16px" }}
              >
                Back to list
              </button>
            </div>
          </div>
        ) : selectedPost &&
          String(selectedPost.id).toLowerCase() === postId.toLowerCase() ? (
          <PostEditor
            key={postId}
            post={selectedPost}
            onBack={() => openPost(null)}
            onUpdate={() => openPost(null)}
          />
        ) : (
          <p
            role="status"
            style={{ padding: 20, fontSize: 14, color: D.muted }}
          >
            Loading post…
          </p>
        )}
      </div>
    );
  }

  return (
    <div className={blogTokenScopeClass(tab)}>
      <style>{BLOG_TOKEN_STYLES}</style>{" "}
      <AdminCommandHeader
        title="Blog"
        icon={Newspaper}
        sections={TABS}
        activeKey={tab}
        onSectionChange={setTab}
        ariaLabel="Blog section"
        navGridClassName="grid-cols-2 md:grid-cols-3 xl:grid-cols-5"
      />
      {tab === "audit" ? (
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
                    fontSize: 14,
                    fontWeight: 500,
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
            onSelectPost={openPost}
          />
        </>
      )}
    </div>
  );
}
