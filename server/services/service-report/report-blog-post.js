/**
 * A Waves blog post on the service report (GATE_REPORT_BLOG_POST, owner "ok
 * go" 2026-10-01): the technician (Fast Complete) or the office (Complete
 * Service) searches the Waves blog like Quick Links, picks one post, and the
 * customer's report shows it at the bottom as "From the Waves blog".
 *
 * One rule decides what a report may link (reportBlogLink): a published row
 * that is live on the hub (content/blog-share-gate.js, the one share policy:
 * astro_status 'live'), with its live URL on the marketing site's own host
 * (link-library.js isSiteUrl). The URL is used verbatim, never rebuilt from
 * the slug: legacy rows keep a planned-era slug that never became a path.
 * The pick is frozen at completion (id, title, URL) so the report shows what
 * the customer was sent to on the day; the read side checks the frozen value
 * against the same host rule before it renders.
 */

const { blogPostShareability } = require('../content/blog-share-gate');
const { isSiteUrl, SITE_HOST } = require('../link-library');
const { detectServiceLine } = require('./service-line-configs');

const MAX_RESULTS = 8;
const MAX_TERMS = 4;
const MAX_TITLE_CHARS = 200;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COLUMNS = ['id', 'title', 'status', 'astro_status', 'astro_live_url'];

// Which visits a post may ride (owner ruling 2026-10-02: every service but
// WDO, termite pre-treat, lawn and tree, shrub & palm). The search route and
// the completion judge it the same way, from the visit's label and its
// completion profile: never a WDO inspection or a termite pre-treat (by
// service key, project type, or the label of a visit with no catalog link),
// never the lawn or tree, shrub & palm lines (another lane owns those
// completions), and never a visit that completes through a project
// (/complete refuses it). Nor a visit whose completion sends the customer no
// report (an internal-only consultation such as the Waves Assessment, or a
// profile whose delivery is internal-only or disabled): the post could
// never be seen. That posture is the completion's own
// (resolveCompletionDeliveryPosture, from the same profile).
const NO_POST_LINES = new Set(['lawn', 'tree_shrub', 'palm']);
const NO_POST_SERVICE_KEYS = new Set(['wdo_inspection', 'termite_pretreatment', 'termite_slab_pretreat']);
const NO_POST_PROJECT_TYPES = new Set(['wdo_inspection', 'pre_treatment_termite_certificate']);
const NO_POST_LABEL_RE = /\bwdo\b|wood[\s-]*destroying|\bpre[\s-]*(?:treat|slab)|new[\s-]*construction/i;
function blogPostAllowedFor({ serviceType, profile }) {
  if (NO_POST_LINES.has(detectServiceLine(serviceType))) return false;
  if (NO_POST_SERVICE_KEYS.has(profile?.serviceKey) || NO_POST_PROJECT_TYPES.has(profile?.projectType)) return false;
  if (profile?.requiresProject || profile?.projectBacked) return false;
  const { resolveCompletionDeliveryPosture } = require('../service-completion-profiles');
  const posture = resolveCompletionDeliveryPosture({
    typedFindingsType: profile?.findingsType || null,
    completionMode: profile?.completionMode,
    profileDeliveryMode: profile?.deliveryMode,
    specialtyDeliveryDisabled: process.env.SPECIALTY_REPORT_DELIVERY_DISABLED === 'true',
    profileCategory: profile?.category,
  });
  if (posture.suppressCustomerComms) return false;
  return !NO_POST_LABEL_RE.test(String(serviceType || ''));
}

// What a report may link, or null.
function reportBlogLink(row) {
  if (!row || row.status !== 'published' || !blogPostShareability(row).ok) return null;
  const url = String(row.astro_live_url || '').trim();
  const title = String(row.title || '').trim();
  if (!title || !isSiteUrl(url)) return null;
  return { id: String(row.id), title: title.slice(0, MAX_TITLE_CHARS), url };
}

// The words a search matches on: each must appear in the title or the
// keyword. LIKE wildcards in what was typed match literally.
function searchTerms(query) {
  return String(query || '')
    .toLowerCase()
    .split(/\s+/)
    .map((term) => term.replace(/[^a-z0-9'-]/g, ''))
    .filter((term) => term.length >= 2)
    .slice(0, MAX_TERMS);
}
const likeArg = (term) => `%${term.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;

/**
 * Live hub posts matching every typed word, newest first, at most eight.
 * No usable words, no results. Only a row whose live URL can be on the
 * site's own host reaches the limit (a superset of reportBlogLink's
 * isSiteUrl, which still decides), so a spoke site's newer matches never
 * crowd the Waves posts out of the eight (GitHub Codex on #5547).
 */
async function searchReportBlogPosts(knex, query) {
  const terms = searchTerms(query);
  if (!terms.length) return [];
  let q = knex('blog_posts')
    .where('status', 'published')
    .where('astro_status', 'live')
    .whereNotNull('astro_live_url')
    .whereRaw('astro_live_url ILIKE ?', [`%${SITE_HOST}%`]);
  for (const term of terms) {
    q = q.where(function eachTerm() {
      this.whereRaw('title ILIKE ?', [likeArg(term)]).orWhereRaw("COALESCE(keyword, '') ILIKE ?", [likeArg(term)]);
    });
  }
  const rows = await q
    .orderByRaw('astro_published_at DESC NULLS LAST')
    .orderBy('publish_date', 'desc')
    .limit(MAX_RESULTS * 2)
    .select(COLUMNS);
  return rows.map(reportBlogLink).filter(Boolean).slice(0, MAX_RESULTS);
}

/**
 * The post a completion picked, checked against the link rule. Returns
 * { post } for a linkable pick, { post: null, rejected: true } for one that
 * is not (unknown, unpublished, not live, off the site, or unreadable), and
 * { post: null, rejected: false } when nothing was picked.
 */
async function resolveReportBlogPostPick(read, blogPostId) {
  if (blogPostId == null || blogPostId === '') return { post: null, rejected: false };
  if (typeof blogPostId !== 'string' || !UUID_RE.test(blogPostId)) return { post: null, rejected: true };
  const row = await read((k) => k('blog_posts').where({ id: blogPostId }).first(COLUMNS));
  const post = reportBlogLink(row);
  return post ? { post } : { post: null, rejected: true };
}

// The frozen pick as the report reads it back: a title and a URL on the
// site's own host, or null.
function frozenBlogPost(value) {
  if (!value || typeof value !== 'object') return null;
  const url = String(value.url || '').trim();
  const title = String(value.title || '').trim();
  if (!title || !isSiteUrl(url)) return null;
  return { title: title.slice(0, MAX_TITLE_CHARS), url };
}

module.exports = {
  blogPostAllowedFor,
  reportBlogLink,
  searchReportBlogPosts,
  resolveReportBlogPostPick,
  frozenBlogPost,
  searchTerms,
};
