import { useState, useEffect, lazy, Suspense } from "react";
import { useSearchParams } from "react-router-dom";
import useRenderedTabBeacon from "../../hooks/useRenderedTabBeacon";
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
import {
  ActionFeedback,
  Badge,
  Button,
  Card,
  CardBody,
  CardFooter,
  CardHeader,
  CardTitle,
  Field,
  Input,
  Select,
  Textarea,
  UiSurface,
  buttonStyles,
} from "../../components/ui";

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

function seoTone(score) {
  if (!score) return "neutral";
  if (score >= 70) return "strong";
  return score < 50 ? "alert" : "neutral";
}

// =========================================================================
// POST LIST COMPONENT (shared between Published, Drafts, Calendar, Ideas)
// =========================================================================
function PostList({ status, onSelectPost }) {
  const [posts, setPosts] = useState([]);
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
        setLoading(false);
      })
      .catch(() => setLoading(false));
  };

  useEffect(load, [status, filterTag, filterCity, search]);

  const tags = [...new Set(posts.map((p) => p.tag).filter(Boolean))].sort();
  const cities = [...new Set(posts.map((p) => p.city).filter(Boolean))].sort();

  if (loading)
    return (
      <ActionFeedback loading>Loading posts...</ActionFeedback>
    );

  return (
    <div className="space-y-4">
      {/* Filters */}
      <Card>
        <CardBody className="flex flex-wrap items-center gap-2">
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search posts"
            aria-label="Search posts"
            className="sm:max-w-64"
          />
          <Select
            value={filterTag}
            onChange={(e) => setFilterTag(e.target.value)}
            aria-label="Filter by topic"
            className="sm:!w-auto"
          >
            <option value="">All topics</option>
            {tags.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </Select>
          <Select
            value={filterCity}
            onChange={(e) => setFilterCity(e.target.value)}
            aria-label="Filter by city"
            className="sm:!w-auto"
          >
            <option value="">All cities</option>
            {cities.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </Select>
          <span className="ml-auto text-ui-body text-ink-secondary">
            {posts.length} posts
          </span>
        </CardBody>
      </Card>
      {/* Post Cards */}
      {posts.length === 0 ? (
        <Card>
          <CardBody className="py-10 text-center text-ui-body text-ink-secondary">No posts found</CardBody>
        </Card>
      ) : (
        posts.map((p) => (
          <button
            type="button"
            key={p.id}
            onClick={() => onSelectPost(p)}
            className="w-full rounded-md border-hairline border-zinc-200 bg-white p-4 text-left text-ui-body transition-colors hover:border-zinc-400 u-focus-ring"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="mb-1 text-ui-body font-medium text-ink-primary">
                  {p.seo_score != null && (
                    <Badge tone={seoTone(p.seo_score)} className="mr-2">
                      {p.seo_score}/100
                    </Badge>
                  )}
                  {p.title}
                </div>
                {p.seo_score != null && p.seo_score < 50 && (
                  <div className="mb-1 text-ui-body font-medium text-alert-fg">
                    Critical — needs optimization
                  </div>
                )}
                <div className="flex flex-wrap gap-x-3 gap-y-1 text-ui-body text-ink-secondary">
                  {p.tag && <span>{p.tag}</span>}
                  {p.city && <span>{p.city}</span>}
                  {p.keyword && <span>{p.keyword}</span>}
                  {publishDateLabel(p.publish_date) && (
                    <span>{publishDateLabel(p.publish_date)}</span>
                  )}
                  {p.word_count > 0 && <span>{p.word_count} words</span>}
                </div>
              </div>
              <div className="flex shrink-0 gap-2">
                {status === "queued" && !p.content && (
                  <Badge>Needs content</Badge>
                )}
                {status === "queued" && p.content && (
                  <Badge tone="strong">Content ready</Badge>
                )}
              </div>
            </div>
          </button>
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
    } catch {
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
    <div className="space-y-4">
      <Button variant="secondary" onClick={onBack}>
        ← Back to list
      </Button>

      <Card>
        <CardHeader><CardTitle>Post details</CardTitle></CardHeader>
        <CardBody className="space-y-4">
          <Field label="Title">
            <Input
              value={editing.title || ""}
              onChange={(e) => setEditing((prev) => ({ ...prev, title: e.target.value }))}
            />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Keyword">
              <Input value={editing.keyword || ""} onChange={(e) => setEditing((prev) => ({ ...prev, keyword: e.target.value }))} />
            </Field>
            <Field label="City">
              <Input value={editing.city || ""} readOnly />
            </Field>
            <Field label="Tag">
              <Select value={editing.tag || ""} onChange={(e) => setEditing((prev) => ({ ...prev, tag: e.target.value }))}>
                <option value="">Select tag</option>
                {["Ants", "Bed Bugs", "Cockroaches", "Fleas", "Flying Insects", "Insects", "Lawn Care", "Lawn Pests", "Mosquitoes", "Pest Control", "Rodents", "Spiders", "Termites"].map((tag) => (
                  <option key={tag} value={tag}>{tag}</option>
                ))}
              </Select>
            </Field>
            <Field label="Status">
              <Input value={editing.status || ""} readOnly />
            </Field>
          </div>
          <Field
            label="Meta description"
            help={`${(editing.meta_description || "").length}/115–160 characters`}
            error={(editing.meta_description || "").length > 0 && ((editing.meta_description || "").length < 115 || (editing.meta_description || "").length > 160) ? "Keep the meta description between 115 and 160 characters." : undefined}
          >
            <Input value={editing.meta_description || ""} onChange={(e) => setEditing((prev) => ({ ...prev, meta_description: e.target.value }))} />
          </Field>
        </CardBody>
      </Card>

      <Card>
        <CardHeader><CardTitle>Byline and taxonomy</CardTitle></CardHeader>
        <CardBody className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Field label="Author">
              <Select value={editing.author_slug || ""} onChange={(e) => setEditing((prev) => ({ ...prev, author_slug: e.target.value }))}>
                <option value="">Select author</option>
                {authors.map((author) => <option key={author.slug} value={author.slug}>{author.name}{author.fdacs_license ? ` (${author.fdacs_license})` : ""}</option>)}
              </Select>
            </Field>
            <Field label="Technical reviewer">
              <Select value={editing.reviewer_slug || ""} onChange={(e) => setEditing((prev) => ({ ...prev, reviewer_slug: e.target.value }))}>
                <option value="">None</option>
                {authors.filter((author) => author.fdacs_license).map((author) => <option key={author.slug} value={author.slug}>{author.name}</option>)}
              </Select>
            </Field>
            <Field label="Technical review date">
              <Input type="date" value={dateInputValue(editing.technically_reviewed_at)} onChange={(e) => setEditing((prev) => ({ ...prev, technically_reviewed_at: e.target.value || null }))} />
            </Field>
            <Field label="Fact-check date">
              <Input type="date" value={dateInputValue(editing.fact_checked_at)} onChange={(e) => setEditing((prev) => ({ ...prev, fact_checked_at: e.target.value || null }))} />
            </Field>
            <Field label="Category">
              <Select value={editing.category || ""} onChange={(e) => setEditing((prev) => ({ ...prev, category: e.target.value }))}>
                <option value="">Select category</option>
                {BLOG_CATEGORIES.map((category) => <option key={category.value} value={category.value}>{category.label}</option>)}
              </Select>
            </Field>
            <Field label="Post type">
              <Select value={editing.post_type || ""} onChange={(e) => setEditing((prev) => ({ ...prev, post_type: e.target.value }))}>
                <option value="">Select post type</option>
                {BLOG_POST_TYPES.map((type) => <option key={type.value} value={type.value}>{type.label}</option>)}
              </Select>
            </Field>
            <Field label="Hero image alt text" className="sm:col-span-2 lg:col-span-3">
              <Input value={editing.hero_image_alt || ""} onChange={(e) => setEditing((prev) => ({ ...prev, hero_image_alt: e.target.value }))} />
            </Field>
          </div>
          <div>
            <div className="ui-label mb-2">Service areas</div>
            <div className="flex flex-wrap gap-2">
              {serviceAreas.map((area) => {
                const active = serviceAreaTags.includes(area.city);
                return <Button key={area.slug} variant={active ? "primary" : "secondary"} onClick={() => toggleServiceArea(area.city)}>{area.city}</Button>;
              })}
            </div>
          </div>
          <div>
            <div className="ui-label mb-2">Publish target</div>
            <div className="flex flex-wrap items-center gap-2 text-ui-body text-ink-secondary">
              <Badge tone="strong">Hub — wavespestcontrol.com</Badge>
              <span>Blog posts publish only on the Waves hub. Use service/location pages for spoke domains.</span>
            </div>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>Content</CardTitle>
          <div className="flex flex-wrap gap-2">
            {!editing.content ? (
              <Button onClick={handleGenerate} loading={generating}>{generating ? "Generating…" : "Generate content"}</Button>
            ) : (
              <>
                <Button variant="secondary" onClick={handleGenerate} loading={generating}>{generating ? "Regenerating…" : "Regenerate"}</Button>
                <Button variant="secondary" onClick={handleOptimize} loading={optimizing}>{optimizing ? "Optimizing…" : "Optimize"}</Button>
              </>
            )}
          </div>
        </CardHeader>
        <CardBody className="space-y-4">
          <div>
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <div className="ui-label">Featured image</div>
              <Button variant="secondary" onClick={handleRegenerateImage} loading={regeneratingImage}>
                {regeneratingImage ? "Generating…" : editing.featured_image_url ? "Regenerate image" : "Generate image"}
              </Button>
            </div>
            {editing.featured_image_url ? (
              <img src={editing.featured_image_url} alt={editing.hero_image_alt || "Featured blog image"} className="max-h-80 w-full rounded-md border-hairline border-zinc-200 object-cover" />
            ) : (
              <ActionFeedback error={Boolean(imageError)}>
                {imageError ? `Image generation failed: ${imageError}` : "No hero image yet. Generate one before publishing to Astro."}
              </ActionFeedback>
            )}
          </div>
          {editing.content ? (
            <Field label="Post content">
              <Textarea className="min-h-[400px] leading-relaxed" value={editing.content} onChange={(e) => setEditing((prev) => ({ ...prev, content: e.target.value }))} />
            </Field>
          ) : (
            <ActionFeedback>No content yet. Generate content to create the blog post with AI.</ActionFeedback>
          )}
          {editing.content && (
            <div className="flex flex-wrap gap-4 text-ui-body text-ink-secondary">
              <span>{(editing.content || "").split(/\s+/).filter(Boolean).length} words</span>
              <span>{Math.ceil((editing.content || "").split(/\s+/).filter(Boolean).length / 250)} min read</span>
              {editing.seo_score != null && <Badge tone={seoTone(editing.seo_score)}>SEO: {editing.seo_score}/100</Badge>}
            </div>
          )}
        </CardBody>
      </Card>

      {optimization && !optimization.parse_error && (
        <Card>
          <CardHeader><CardTitle>Optimization suggestions</CardTitle></CardHeader>
          <CardBody className="space-y-3">
            {optimization.suggested_title && <Suggestion label="Suggested title">{optimization.suggested_title}</Suggestion>}
            {optimization.suggested_meta && <Suggestion label="Suggested meta description">{optimization.suggested_meta}</Suggestion>}
            {optimization.suggested_keyword && <Suggestion label="Suggested keyword">{optimization.suggested_keyword}</Suggestion>}
            {(optimization.seo_improvements || []).length > 0 && (
              <Suggestion label="SEO improvements">
                <ul className="list-disc space-y-1 pl-5">{optimization.seo_improvements.map((item, index) => <li key={index}>{item}</li>)}</ul>
              </Suggestion>
            )}
            {(optimization.missing_internal_links || []).length > 0 && (
              <Suggestion label="Add internal links">
                <ul className="space-y-1">{optimization.missing_internal_links.map((link, index) => <li key={index}><span className="font-medium text-ink-primary">“{link.anchor_text}”</span> → {link.url}</li>)}</ul>
              </Suggestion>
            )}
            {optimization.estimated_new_score && <Badge tone="strong">Estimated SEO score: {optimization.estimated_new_score}/100</Badge>}
          </CardBody>
          <CardFooter><Button onClick={applyOptimization}>Apply meta and keyword to draft</Button></CardFooter>
        </Card>
      )}

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

      <div className="flex flex-wrap gap-2">
        <Button onClick={handleSave}>Save draft</Button>
        {editing.astro_status === "live" && (
          <Button variant="secondary" onClick={() => handleShareSocial()} loading={sharing}>{sharing ? "Sharing…" : "Share to social media"}</Button>
        )}
      </div>
    </div>
  );
}

function Suggestion({ label, children }) {
  return (
    <div className="rounded-md bg-zinc-50 p-3 text-ui-body text-ink-secondary">
      <div className="mb-1 font-medium text-ink-primary">{label}</div>
      {children}
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
  const previewable = status === "pr_open" || status === "build_failed";

  return (
    <Card>
      <CardHeader className="flex flex-wrap items-center gap-3">
        <CardTitle>Publishing</CardTitle>
        <Badge tone={pill.tone}>{pill.label}</Badge>
        {post.astro_pr_number && <span className="text-ui-body text-ink-secondary">PR #{post.astro_pr_number}</span>}
        {post.astro_branch_name && <span className="break-all text-ui-body text-ink-secondary">{post.astro_branch_name}</span>}
      </CardHeader>
      <CardBody className="flex flex-wrap items-center gap-2">
        {status === "draft" && <Button onClick={onPublish} loading={publishing}>{publishing ? "Opening PR…" : "Publish to Astro preview"}</Button>}
        {previewable && (
          <>
            {post.astro_preview_url && <a href={post.astro_preview_url} target="_blank" rel="noreferrer" className={buttonStyles({ variant: "secondary", density: "comfortable" })}>Open preview</a>}
            <Button variant="secondary" onClick={onRefresh} loading={refreshing}>{refreshing ? "Checking…" : "Refresh status"}</Button>
            {status === "pr_open" && <Button onClick={onMerge} loading={merging}>{merging ? "Merging…" : "Approve and go live"}</Button>}
            {status === "build_failed" && <Button variant="danger" onClick={onPublish} loading={publishing}>{publishing ? "Retrying…" : "Retry publish"}</Button>}
          </>
        )}
        {status === "merged" && (
          <>
            <span className="text-ui-body text-ink-secondary">Merged. Live build in progress.</span>
            {post.astro_live_url && <a href={post.astro_live_url} target="_blank" rel="noreferrer" className={buttonStyles({ variant: "secondary", density: "comfortable" })}>Expected live URL</a>}
            <Button variant="secondary" onClick={onRefresh} loading={refreshing}>Refresh</Button>
            <Button variant="danger" onClick={onUnpublish} loading={unpublishing}>{unpublishing ? "Opening revert PR…" : "Unpublish"}</Button>
          </>
        )}
        {status === "live" && (
          <>
            {post.astro_live_url && <a href={post.astro_live_url} target="_blank" rel="noreferrer" className={buttonStyles({ variant: "secondary", density: "comfortable" })}>View live</a>}
            <Button variant="danger" onClick={onUnpublish} loading={unpublishing}>{unpublishing ? "Opening revert PR…" : "Unpublish"}</Button>
          </>
        )}
        {status === "unpublish_pending" && (
          <>
            <Button variant="secondary" onClick={onRefresh} loading={refreshing}>{refreshing ? "Checking…" : "Refresh status"}</Button>
            <Button variant="danger" onClick={onMerge} loading={merging}>{merging ? "Removing…" : "Approve and remove"}</Button>
          </>
        )}
        {status === "publish_failed" && <Button variant="danger" onClick={onPublish} loading={publishing}>{publishing ? "Retrying…" : "Retry publish"}</Button>}
      </CardBody>
      {post.astro_publish_error && (status === "publish_failed" || status === "build_failed") && (
        <CardFooter><ActionFeedback error>{post.astro_publish_error}</ActionFeedback></CardFooter>
      )}
    </Card>
  );
}

const ASTRO_PILLS = {
  draft: { label: "Draft", tone: "neutral" },
  pr_open: { label: "Preview open", tone: "strong" },
  build_failed: { label: "Build failed", tone: "alert" },
  merged: { label: "Merged", tone: "strong" },
  live: { label: "Live", tone: "strong" },
  publish_failed: { label: "Publish failed", tone: "alert" },
  unpublish_pending: { label: "Unpublish pending", tone: "alert" },
};

// =========================================================================
// AUDIT TAB
// =========================================================================
function AuditTab() {
  const [audit, setAudit] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    adminFetch("/admin/content/blog/audit")
      .then((data) => { setAudit(data.audit); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  if (loading) return <ActionFeedback loading>Running blog audit...</ActionFeedback>;
  if (!audit) return <ActionFeedback error>Unable to load audit.</ActionFeedback>;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader><CardTitle>Content health scorecard</CardTitle></CardHeader>
        <CardBody className="space-y-3">
          <p className="text-ui-body text-ink-secondary">
            Total posts: <span className="font-medium text-ink-primary">{audit.total}</span> ({audit.published} published, {audit.drafts} drafts, {audit.queued} queued, and {audit.ideas} ideas)
          </p>
          {(audit.recommendations || []).map((recommendation, index) => (
            <div key={index} className="rounded-md border-hairline border-zinc-200 bg-zinc-50 p-3">
              <Badge tone={recommendation.priority === "critical" ? "alert" : recommendation.priority === "high" ? "strong" : "neutral"}>{recommendation.priority}</Badge>
              <div className="mt-2 text-ui-body font-medium text-ink-primary">{recommendation.title}</div>
              <div className="mt-1 text-ui-body text-ink-secondary">{recommendation.action}</div>
            </div>
          ))}
        </CardBody>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <DistributionCard title="By topic" entries={audit.topicDistribution?.counts || {}} flagged={(name, count) => count < 5 ? "Low" : ""} />
        <DistributionCard
          title="By city"
          entries={audit.cityDistribution?.counts || {}}
          flagged={(name, count) => audit.cityDistribution?.overrepresented?.some((item) => item.city === name) ? "Overrepresented" : count === 0 ? "Low" : ""}
        />
      </div>

      {(audit.topicDistribution?.gaps || []).length > 0 && (
        <Card>
          <CardHeader><CardTitle>Content gaps</CardTitle></CardHeader>
          <CardBody><ul className="list-disc space-y-1 pl-5 text-ui-body text-ink-secondary">{audit.topicDistribution.gaps.map((gap, index) => <li key={index}>{gap}</li>)}</ul></CardBody>
        </Card>
      )}

      {(audit.duplicates || []).length > 0 && (
        <Card>
          <CardHeader><CardTitle>Duplicates found ({audit.duplicates.length})</CardTitle></CardHeader>
          <CardBody className="space-y-2">
            {audit.duplicates.map((duplicate, index) => (
              <div key={index} className="rounded-md bg-zinc-50 p-3 text-ui-body text-ink-secondary">
                <div>1. “{duplicate.post1.title}” ({duplicate.post1.status})</div>
                <div>2. “{duplicate.post2.title}” ({duplicate.post2.status})</div>
                <Badge className="mt-2">Match: {duplicate.matchType}</Badge>
              </div>
            ))}
          </CardBody>
        </Card>
      )}

      {(audit.topPerformers || []).length > 0 && (
        <Card>
          <CardHeader><CardTitle>Top performing posts</CardTitle></CardHeader>
          <CardBody className="divide-y divide-zinc-200 p-0">
            {audit.topPerformers.map((post, index) => (
              <div key={index} className="flex items-center gap-3 px-4 py-3 text-ui-body">
                <Badge tone="strong">{post.score}/100</Badge>
                <span className="text-ink-primary">{post.title}</span>
              </div>
            ))}
          </CardBody>
        </Card>
      )}
    </div>
  );
}

function DistributionCard({ title, entries, flagged }) {
  return (
    <Card>
      <CardHeader><CardTitle>{title}</CardTitle></CardHeader>
      <CardBody className="divide-y divide-zinc-200 p-0">
        {Object.entries(entries).sort((a, b) => b[1] - a[1]).map(([name, count]) => {
          const warning = flagged(name, count);
          return (
            <div key={name} className="flex min-h-11 items-center gap-3 px-4 py-2 text-ui-body">
              <span className="min-w-0 flex-1 text-ink-primary">{name}</span>
              {warning && <Badge tone="alert">{warning}</Badge>}
              <span className="tabular-nums text-ink-secondary">{count}</span>
            </div>
          );
        })}
      </CardBody>
    </Card>
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
    <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
      {/* Left — main form */}
      <div className="space-y-4">
        {/* A) Content type selector */}
        <Card>
          <CardHeader>
            <CardTitle>Content type</CardTitle>
          </CardHeader>
          <CardBody className="grid gap-2 sm:grid-cols-2">
            {CONTENT_TYPES.map((content) => {
              const active = contentType === content.id;
              return (
                <button
                  key={content.id}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setContentType(content.id)}
                  className={`min-h-16 rounded-md border-hairline p-3 text-left text-ui-body transition-colors u-focus-ring ${
                    active
                      ? "border-zinc-900 bg-zinc-100"
                      : "border-zinc-200 bg-white hover:bg-zinc-50"
                  }`}
                >
                  <span className="block text-ui-body font-medium text-ink-primary">
                    {content.label}
                  </span>
                  <span className="mt-1 block text-ui-body text-ink-secondary">
                    {content.desc}
                  </span>
                </button>
              );
            })}
          </CardBody>
        </Card>
        {/* B) Topic input + suggestions */}
        <Card>
          <CardHeader>
            <CardTitle>Topic</CardTitle>
          </CardHeader>
          <CardBody className="space-y-3">
            <Textarea
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              placeholder="Describe the topic or paste a working title..."
              rows={3}
            />
            <div>
              <div className="ui-label mb-2">Suggestions — click to use</div>
              <div className="flex flex-wrap gap-2">
                {suggestions.map((suggestion) => (
                  <Button
                    key={suggestion}
                    variant={topic === suggestion ? "primary" : "secondary"}
                    onClick={() => setTopic(suggestion)}
                    className="h-auto min-h-11 whitespace-normal py-2 text-left sm:h-auto sm:min-h-9"
                  >
                    {suggestion}
                  </Button>
                ))}
              </div>
            </div>
          </CardBody>
        </Card>
        {/* C) City selector */}
        <Card>
          <CardHeader>
            <CardTitle>Target city</CardTitle>
          </CardHeader>
          <CardBody className="flex flex-wrap gap-2">
            {CITIES.map((targetCity) => (
              <Button
                key={targetCity}
                variant={city === targetCity ? "primary" : "secondary"}
                onClick={() => setCity(targetCity)}
              >
                {targetCity}
              </Button>
            ))}
          </CardBody>
        </Card>
        {/* E) Generate button */}
        <Button
          onClick={handleGenerate}
          disabled={generating || !topic.trim()}
          loading={generating}
          className="w-full"
        >
          {generating
            ? "Generating — pulling FAWN data, building prompt..."
            : `Generate ${CONTENT_TYPES.find((content) => content.id === contentType)?.label}`}
        </Button>
      </div>
      {/* D) Right — info panel */}
      <div className="space-y-4">
        {/* Weather snapshot */}
        <Card>
          <CardHeader>
            <CardTitle>FAWN weather</CardTitle>
          </CardHeader>
          <CardBody>
            {weather ? (
              <dl className="space-y-2 text-ui-body text-ink-secondary">
                {weather.temp && (
                  <div className="flex justify-between gap-3">
                    <dt>Temp</dt>
                    <dd className="tabular-nums text-ink-primary">
                      {weather.temp}F
                    </dd>
                  </div>
                )}
                {weather.humidity && (
                  <div className="flex justify-between gap-3">
                    <dt>Humidity</dt>
                    <dd className="tabular-nums text-ink-primary">
                      {weather.humidity}%
                    </dd>
                  </div>
                )}
                {weather.rainfall && (
                  <div className="flex justify-between gap-3">
                    <dt>Rainfall (7d)</dt>
                    <dd className="tabular-nums text-ink-primary">
                      {weather.rainfall}&quot;
                    </dd>
                  </div>
                )}
                {weather.soilTemp && (
                  <div className="flex justify-between gap-3">
                    <dt>Soil temp</dt>
                    <dd className="tabular-nums text-ink-primary">
                      {weather.soilTemp}F
                    </dd>
                  </div>
                )}
                {weather.station && (
                  <div className="border-t border-hairline border-zinc-200 pt-2">
                    <dt className="inline">Station: </dt>
                    <dd className="inline text-ink-primary">
                      {weather.station}
                    </dd>
                  </div>
                )}
                {!weather.temp && (
                  <div>Weather data will be fetched at generation time</div>
                )}
              </dl>
            ) : (
              <ActionFeedback>
                Weather data loads when API is connected
              </ActionFeedback>
            )}
          </CardBody>
        </Card>
        {/* Active signals */}
        {signals.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle>Active signals</CardTitle>
            </CardHeader>
            <CardBody className="space-y-2">
              {signals.map((signal, index) => (
                <div
                  key={index}
                  className="border-l-2 border-zinc-400 pl-3 text-ui-body text-ink-secondary"
                >
                  {signal}
                </div>
              ))}
            </CardBody>
          </Card>
        )}
        {/* Article checklist */}
        <Card>
          <CardHeader>
            <CardTitle>Every article includes</CardTitle>
          </CardHeader>
          <CardBody>
            <ul className="list-disc space-y-2 pl-5 text-ui-body text-ink-secondary">
              {ARTICLE_CHECKLIST.map((item) => (
                <li key={item.label}>{item.label}</li>
              ))}
            </ul>
          </CardBody>
        </Card>
      </div>
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

// Legacy ?tab= keys (the pre-collapse top-level status tabs) → Posts sub-filter
// status. Lets old deep links / history entries resolve to the right list.
const LEGACY_POST_TAB = {
  published: "published",
  drafts: "draft",
  queued: "queued",
  ideas: "idea",
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

  // Posts sub-filter (Published/Drafts/Queued/Ideas) is URL-backed via ?status=
  // so it survives refresh / bookmark / share. Legacy ?tab=drafts|queued|ideas|
  // published links still resolve (via legacyPostStatus) and stay stable on
  // reload — no normalization needed, since postStatus is derived, not stored.
  const VALID_POST_STATUSES = POST_STATUSES.map((s) => s.key);
  const paramStatus = searchParams.get("status");
  const postStatus = VALID_POST_STATUSES.includes(paramStatus)
    ? paramStatus
    : legacyPostStatus || "published";

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
    tab === "posts" ? postStatus : tab,
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
  const [selectedPost, setSelectedPost] = useState(null);
  const [counts, setCounts] = useState({});
  const [generatingIdeas, setGeneratingIdeas] = useState(false);
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
  const goToPosts = (status) => setPostStatus(status);

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
      <UiSurface density="comfortable">
        <AdminCommandHeader
          variant="workspace"
          title="Content editor"
          icon={Newspaper}
        />
        <PostEditor
          post={selectedPost}
          onBack={() => setSelectedPost(null)}
          onUpdate={() => {
            setSelectedPost(null);
          }}
        />
      </UiSurface>
    );
  }

  return (
    <UiSurface density="comfortable">
      <AdminCommandHeader
        variant="workspace"
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
                label: generatingIdeas ? "Generating..." : "Create blog",
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
            <ActionFeedback loading>Loading calendar...</ActionFeedback>
          }
        >
          <ContentCalendar />
        </Suspense>
      ) : tab === "autopilot" ? (
        <Suspense
          fallback={
            <ActionFeedback loading>Loading autopilot...</ActionFeedback>
          }
        >
          <AutonomousContentReviewPage embedded />
        </Suspense>
      ) : tab === "registry" ? (
        <Suspense
          fallback={
            <ActionFeedback loading>Loading registry...</ActionFeedback>
          }
        >
          <ContentRegistryPage embedded />
        </Suspense>
      ) : (
        <>
          <div className="mb-4 flex flex-wrap gap-2" aria-label="Post status">
            {POST_STATUSES.map((s) => {
              const active = postStatus === s.key;
              return (
                <Button
                  key={s.key}
                  onClick={() => setPostStatus(s.key)}
                  variant={active ? "primary" : "secondary"}
                  aria-pressed={active}
                >
                  {s.label}
                  {counts[s.key] != null ? ` (${counts[s.key]})` : ""}
                </Button>
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
    </UiSurface>
  );
}
