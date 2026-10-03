/**
 * A Waves blog post on the service report (GATE_REPORT_BLOG_POST, owner "ok
 * go" 2026-10-01): the technician (Fast Complete) or the office (Complete
 * Service) searches the Waves blog like Quick Links, picks one post, and the
 * customer's report shows it at the bottom as "From the Waves blog".
 *
 * What a report may link: a post live on the hub at its live URL on the
 * marketing site's own host (link-library.js isSiteUrl). The site's live
 * posts are the content registry's rows whose route the daily live sweep
 * verified on the hub (content/related-posts.js registryRowLivePath and
 * registryRowLiveKeys, the proof the writer's related-post links stand on;
 * registryLink), and a portal post the deploy poller stamped live since
 * (content/blog-share-gate.js, astro_status 'live'; reportBlogLink). The
 * portal's own table alone marks only the posts it published itself, which
 * left the search all but empty (owner 2026-10-02: "does not work, or is
 * limited"). The URL is used verbatim, never rebuilt from the slug: legacy
 * rows keep a planned-era slug that never became a path.
 * The pick is frozen at completion (id, title, URL) so the report shows what
 * the customer was sent to on the day; the read side checks the frozen value
 * against the same host rule before it renders.
 */

const { blogPostShareability } = require('../content/blog-share-gate');
const { isSiteUrl, SITE_HOST } = require('../link-library');
const { detectServiceLine } = require('./service-line-configs');

const MAX_RESULTS = 8;
// The most rows a search reads per source (the site has a few hundred posts;
// this only bounds a runaway read).
const MAX_CANDIDATES = 500;
const MAX_TERMS = 4;
const MAX_TITLE_CHARS = 200;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COLUMNS = ['id', 'title', 'status', 'astro_status', 'astro_live_url'];
const REGISTRY_COLUMNS = [
  'id', 'title', 'h1', 'meta_description', 'target_keyword', 'live_url', 'canonical_url', 'canonical_url_normalized',
  'content_type', 'workflow_status', 'astro_status', 'live_status', 'noindex_detected', 'metadata', 'published_at',
];
// The text a search reads, per source: the title, the headline, the summary
// under it and the keyword the post targets (the article itself lives in the
// site's repository, not here).
const REGISTRY_TEXT = ['title', 'h1', 'meta_description', 'target_keyword'];
const PORTAL_TEXT = ['title', 'meta_description', 'keyword'];

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

// A post the content registry verified live on the hub, as a report links
// it, or null: its route checked live and indexable by the daily sweep, the
// hub among the sites it renders on, and its live URL on the site's own host.
function registryLink(row) {
  if (!row) return null;
  const { registryRowLivePath, registryRowLiveKeys } = require('../content/related-posts');
  const { registryLiveTargetUrl } = require('../content/content-registry');
  const { HUB_SITE_KEYS } = require('../content-astro/spoke-sites');
  if (!registryRowLivePath(row)) return null;
  if (!registryRowLiveKeys(row).some((key) => HUB_SITE_KEYS.includes(key.split('|')[0]))) return null;
  const url = registryLiveTargetUrl(row);
  const title = String(row.title || row.h1 || '').trim();
  if (!title || !isSiteUrl(url)) return null;
  return { id: String(row.id), title: title.slice(0, MAX_TITLE_CHARS), url };
}

// Words a search drops: short words that name no topic ("how to get rid
// of"). A search box's filler list, not a judgment of what was meant.
const FILLER_WORDS = new Set([
  'the', 'and', 'for', 'how', 'with', 'your', 'you', 'get', 'rid', 'what', 'why', 'when', 'are', 'can', 'does',
  'from', 'about', 'this', 'that', 'our', 'out', 'into', 'its', 'any', 'all', 'not',
]);
// A word's singular ("roaches" -> roach, "flies" -> fly, "mosquitoes" ->
// mosquito, "ants" -> ant), and the forms a post may use for it.
function singularOf(word) {
  if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.length > 4 && /(?:ch|sh|x|z|ss|o)es$/.test(word)) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}
const pluralOf = (word) => (/(?:ch|sh|x|z|s|o)$/.test(word) ? `${word}es` : /[^aeiou]y$/.test(word) ? `${word.slice(0, -1)}ies` : `${word}s`);
function formsOf(word) {
  const one = singularOf(word);
  // The plural of the word as typed too: a singular that ends in s ("virus",
  // "mantis") keeps its own plural (GitHub Codex P2 on #5652).
  return [...new Set([word, one, pluralOf(word), pluralOf(one), `${one}s`])];
}

// The words a search matches on: each word of three characters or more
// (punctuation dropped, filler words left out), each with the forms a post
// may use for it, at most four. A word matches only as a whole word: "rat"
// never finds "rates".
function searchTerms(query) {
  const words = String(query || '')
    .toLowerCase()
    .split(/\s+/)
    .map((word) => word.replace(/[^a-z0-9'-]/g, '').replace(/^['-]+|['-]+$/g, ''))
    .filter((word) => word.length >= 3 && !FILLER_WORDS.has(word));
  const seen = new Set();
  const terms = [];
  for (const word of words) {
    const one = singularOf(word);
    if (seen.has(one)) continue;
    seen.add(one);
    terms.push({ word: one, forms: formsOf(word) });
  }
  return terms.slice(0, MAX_TERMS);
}
// The whole-word pattern for a term: Postgres (\m \M) and JavaScript (\b).
const sqlPattern = (term) => `\\m(?:${term.forms.join('|')})\\M`;
const jsPattern = (term) => new RegExp(`\\b(?:${term.forms.join('|')})\\b`, 'i');

// Rows of a table whose text holds any of the terms, those holding the most
// terms first, newest first among them, at most MAX_CANDIDATES: the cap never
// drops a post that holds every word for a newer one that holds fewer
// (GitHub Codex P2 on #5652). The ranking below then judges how well.
function anyTermIn(query, columns, terms, newestColumn) {
  // Whether the row holds a term, in any of its text columns (one binding a
  // column).
  const holds = `(${columns.map((column) => `COALESCE(${column}, '') ~* ?`).join(' OR ')})`;
  const holdsBindings = (term) => columns.map(() => sqlPattern(term));
  return query
    .where(function anyTerm() {
      for (const term of terms) {
        for (const column of columns) this.orWhereRaw(`COALESCE(${column}, '') ~* ?`, [sqlPattern(term)]);
      }
    })
    .orderByRaw(
      `(${terms.map(() => `CASE WHEN ${holds} THEN 1 ELSE 0 END`).join(' + ')}) DESC, ${newestColumn} DESC NULLS LAST`,
      terms.flatMap(holdsBindings),
    )
    .limit(MAX_CANDIDATES);
}

// Which terms a post's text holds, and where (a title or headline over the
// keyword over the summary).
function matchOf(texts, terms) {
  let placed = 0;
  const held = terms.map((term) => {
    const pattern = jsPattern(term);
    const where = [[texts.title, 3], [texts.keyword, 2], [texts.summary, 1]].find(([text]) => pattern.test(String(text || '')));
    if (where) placed += where[1];
    return !!where;
  });
  return { held, placed };
}
const pathKey = (url) => {
  try {
    return new URL(url).pathname.replace(/\/+$/, '').toLowerCase();
  } catch {
    return String(url || '').toLowerCase();
  }
};

/**
 * The site's live hub posts that answer a search, best first, at most eight:
 * those holding every word first, then those holding the rarest of the
 * words, a word in the title or headline before one only in the keyword or
 * summary, newest first among equals. No usable words, no results. Read from the content
 * registry's verified-live posts and the portal posts stamped live since its
 * last sweep (each URL once).
 */
async function searchReportBlogPosts(knex, query) {
  const terms = searchTerms(query);
  if (!terms.length) return [];
  const [registryRows, portalRows] = await Promise.all([
    anyTermIn(knex('content_registry')
      .where({ content_type: 'blog', workflow_status: 'published', astro_status: 'present', live_status: 'live' })
      .whereRaw('COALESCE(noindex_detected, false) = false'), REGISTRY_TEXT, terms, 'published_at')
      .select(REGISTRY_COLUMNS),
    anyTermIn(knex('blog_posts')
      .where('status', 'published')
      .where('astro_status', 'live')
      .whereNotNull('astro_live_url')
      .whereRaw('astro_live_url ILIKE ?', [`%${SITE_HOST}%`]), PORTAL_TEXT, terms, 'astro_published_at')
      .select([...COLUMNS, 'meta_description', 'keyword', 'astro_published_at']),
  ]);
  const found = new Map();
  const add = (post, texts, when) => {
    if (!post) return;
    const key = pathKey(post.url);
    if (found.has(key)) return;
    found.set(key, { post, ...matchOf(texts, terms), when: when ? new Date(when).getTime() || 0 : 0 });
  };
  for (const row of registryRows) {
    add(registryLink(row), { title: `${row.title || ''} ${row.h1 || ''}`, keyword: row.target_keyword, summary: row.meta_description }, row.published_at);
  }
  for (const row of portalRows) {
    add(reportBlogLink(row), { title: row.title, keyword: row.keyword, summary: row.meta_description }, row.astro_published_at);
  }
  const entries = [...found.values()].filter((entry) => entry.held.some(Boolean));
  // A word few posts hold says more than one many hold ("tick" over
  // "control"), so a post that holds some of the words ranks by the rarest.
  const holders = terms.map((_, i) => entries.filter((entry) => entry.held[i]).length);
  const specific = (entry) => entry.held.reduce((sum, held, i) => sum + (held ? 1 / holders[i] : 0), 0);
  const every = (entry) => entry.held.every(Boolean);
  return entries
    .sort((a, b) => Number(every(b)) - Number(every(a)) || specific(b) - specific(a) || b.placed - a.placed || b.when - a.when)
    .slice(0, MAX_RESULTS)
    .map((entry) => entry.post);
}

/**
 * The post a completion picked, checked against the link rule, from the
 * source the search found it in (a registry row, else a portal post).
 * Returns { post } for a linkable pick, { post: null, rejected: true } for
 * one that is not (unknown, unpublished, not live, off the site, or
 * unreadable), and { post: null, rejected: false } when nothing was picked.
 */
async function resolveReportBlogPostPick(read, blogPostId) {
  if (blogPostId == null || blogPostId === '') return { post: null, rejected: false };
  if (typeof blogPostId !== 'string' || !UUID_RE.test(blogPostId)) return { post: null, rejected: true };
  const registryRow = await read((k) => k('content_registry').where({ id: blogPostId }).first(REGISTRY_COLUMNS));
  const fromRegistry = registryLink(registryRow);
  if (fromRegistry) return { post: fromRegistry };
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
  registryLink,
};
