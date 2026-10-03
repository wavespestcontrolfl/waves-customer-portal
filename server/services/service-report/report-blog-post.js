/**
 * A Waves blog post on the service report (GATE_REPORT_BLOG_POST, owner "ok
 * go" 2026-10-01): the technician (Fast Complete) or the office (Complete
 * Service) searches the Waves blog like Quick Links, picks one post, and the
 * customer's report shows it at the bottom as "From the Waves blog".
 *
 * What a report may link: a post live on the hub at its live URL on the
 * marketing site's own host (link-library.js isSiteUrl). The site's live
 * posts are the content registry's rows whose route the daily live sweep
 * (or, until it next looks, the post-publish check) verified on the hub
 * (content/related-posts.js registryRowLivePath and registryRowLiveKeys, the
 * proof the writer's related-post links stand on; registryLink), and a
 * portal post the deploy poller stamped live that the registry keeps no row
 * for yet (content/blog-share-gate.js, astro_status 'live'; portalLink). The
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
const logger = require('../logger');

const MAX_RESULTS = 8;
// The most rows a search reads per source. The site has a few hundred posts,
// so every row that holds a word is read and ranked here; this only stops a
// runaway read (reaching it is logged, and the rows read first hold the most
// words, newest first).
const MAX_READ = 5000;
const MAX_TERMS = 4;
const MAX_TITLE_CHARS = 200;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COLUMNS = ['id', 'title', 'status', 'astro_status', 'astro_live_url', 'astro_published_at'];
const REGISTRY_COLUMNS = [
  'id', 'title', 'h1', 'meta_description', 'target_keyword', 'live_url', 'canonical_url', 'canonical_url_normalized',
  'content_type', 'workflow_status', 'astro_status', 'live_status', 'reconciliation_status', 'noindex_detected',
  'metadata', 'published_at',
];
// The registry's word for a live post: the daily sweep's 'live', and the
// post-publish check's 'live_visible' (the page live, indexable and clean
// when the post went up, until the sweep next checks it), so a new post is
// found the day it goes live (GitHub Codex P2 on 7568aea485).
const REGISTRY_LIVE_STATUSES = ['live', 'live_visible'];
// The registry's reconciliation states whose row is one page's: never a
// 'conflict' (duplicate canonicals or slugs, where the row's text may be
// another source's than the checked page's; GitHub Codex P2 on 8c57183332),
// nor any state the registry adds later.
const REGISTRY_ATTRIBUTABLE_STATES = ['matched', 'astro_only', 'astro_changed_since_sync', 'db_changed_since_sync'];
// The text a search reads, per source, by where it sits: the title (and the
// headline), the keyword the post targets, and the summary under it (the
// article itself lives in the site's repository, not here).
const REGISTRY_FIELDS = { title: ['title', 'h1'], keyword: ['target_keyword'], summary: ['meta_description'] };
const PORTAL_FIELDS = { title: ['title'], keyword: ['keyword'], summary: ['meta_description'] };
// An absolute URL, and one on the hub host, as Postgres patterns.
const ABSOLUTE_URL_RE = '^https?://';
const HUB_URL_RE = `^https?://(www\\.)?${SITE_HOST.replace(/\./g, '\\.')}(/|$)`;

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
// it, or null: its route checked live and indexable (by the daily sweep, or
// by the post-publish check until the sweep next looks), the row one page's,
// the hub among the sites it renders on, and its live URL on the site's own
// host.
function registryLink(row) {
  if (!row || !REGISTRY_LIVE_STATUSES.includes(row.live_status)) return null;
  if (!REGISTRY_ATTRIBUTABLE_STATES.includes(row.reconciliation_status)) return null;
  const { registryRowLivePath, registryRowLiveKeys } = require('../content/related-posts');
  const { registryLiveTargetUrl } = require('../content/content-registry');
  const { HUB_SITE_KEYS } = require('../content-astro/spoke-sites');
  // The shared rule reads the sweep's word for live.
  const judged = { ...row, live_status: 'live' };
  if (!registryRowLivePath(judged)) return null;
  if (!registryRowLiveKeys(judged).some((key) => HUB_SITE_KEYS.includes(key.split('|')[0]))) return null;
  const url = registryLiveTargetUrl(judged);
  const title = String(row.title || row.h1 || '').trim();
  if (!title || !isSiteUrl(url)) return null;
  return { id: String(row.id), title: title.slice(0, MAX_TITLE_CHARS), url };
}

// A portal post as a report may link it, given the registry's rows for the
// post (db_blog_id). Once the registry keeps a row for the post, the registry
// alone decides: a row it links, or nothing, never the portal's stamp (GitHub
// Codex P1 r5 on #5652; P1s on 8c57183332: a page the post-publish check
// failed, or a post moved to a spoke). The portal's own rule decides only a
// post the registry keeps no row for. A row synced before its post went live
// catches up at the nightly sync (content-registry maintenance, 1:20 AM).
function portalLink(row, matched = []) {
  if (!matched.length) return reportBlogLink(row);
  return matched.map(registryLink).find(Boolean) || null;
}

// The registry rows the sweep keeps for these portal posts, by post id.
async function registryRowsForPortal(knex, ids) {
  const byPost = new Map();
  if (!ids.length) return byPost;
  const rows = await knex('content_registry').whereIn('db_blog_id', ids).select([...REGISTRY_COLUMNS, 'db_blog_id']);
  for (const row of rows || []) {
    const key = String(row.db_blog_id);
    byPost.set(key, [...(byPost.get(key) || []), row]);
  }
  return byPost;
}

// Words a search drops: short words that name no topic ("how to get rid
// of"). A search box's filler list, not a judgment of what was meant.
const FILLER_WORDS = new Set([
  'the', 'and', 'for', 'how', 'with', 'your', 'you', 'get', 'rid', 'what', 'why', 'when', 'are', 'can', 'does',
  'from', 'about', 'this', 'that', 'our', 'out', 'into', 'its', 'any', 'all', 'not',
]);
// Plurals no suffix rule makes, as [singular, plural] (GitHub Codex P2 r2 on
// #5652: "mice" never found a "mouse" post; r5: mosquito "larvae").
const IRREGULAR_FORMS = new Map([['mouse', 'mice'], ['louse', 'lice'], ['goose', 'geese'], ['larva', 'larvae'], ['pupa', 'pupae']]
  .flatMap((pair) => [[pair[0], pair], [pair[1], pair]]));
// A word's singular ("roaches" -> roach, "flies" -> fly, "mosquitoes" ->
// mosquito, "ants" -> ant, "mice" -> mouse), and the forms a post may use for
// it.
function singularOf(word) {
  if (IRREGULAR_FORMS.has(word)) return IRREGULAR_FORMS.get(word)[0];
  if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.length > 4 && /(?:ch|sh|x|z|ss|o)es$/.test(word)) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}
const pluralOf = (word) => (/(?:ch|sh|x|z|s|o)$/.test(word) ? `${word}es` : /[^aeiou]y$/.test(word) ? `${word.slice(0, -1)}ies` : `${word}s`);
function formsOf(word) {
  if (IRREGULAR_FORMS.has(word)) return [...IRREGULAR_FORMS.get(word)];
  const one = singularOf(word);
  // The plural of the word as typed too: a singular that ends in s ("virus",
  // "mantis") keeps its own plural (GitHub Codex P2 on #5652), and a plural
  // in -ses its s-ending singular ("viruses" -> virus; r3).
  const sesSingular = word.length > 4 && word.endsWith('ses') ? [word.slice(0, -2)] : [];
  return [...new Set([word, one, ...sesSingular, pluralOf(word), pluralOf(one), `${one}s`])];
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
  const terms = [];
  for (const word of words) {
    const forms = formsOf(word);
    // Two words that share a form are one word ("roach roaches", "virus
    // viruses").
    if (terms.some((term) => term.forms.some((form) => forms.includes(form)))) continue;
    terms.push({ word: singularOf(word), forms });
  }
  return terms.slice(0, MAX_TERMS);
}
// The whole-word pattern for a term: Postgres (\m \M) and JavaScript (\b).
const sqlPattern = (term) => `\\m(?:${term.forms.join('|')})\\M`;
const jsPattern = (term) => new RegExp(`\\b(?:${term.forms.join('|')})\\b`, 'i');

// Rows of a source whose text holds any of the terms, at most MAX_READ:
// those holding the most terms first, newest first among them, id last (a
// total order), so a read that ever reached its guard keeps the best covered.
function anyTermIn(query, fields, terms, newestColumn) {
  const columns = [...fields.title, ...fields.keyword, ...fields.summary];
  const holds = `(${columns.map((column) => `COALESCE(${column}, '') ~* ?`).join(' OR ')})`;
  const holdsBindings = (term) => columns.map(() => sqlPattern(term));
  return query
    .where(function anyTerm() {
      for (const term of terms) {
        for (const column of columns) this.orWhereRaw(`COALESCE(${column}, '') ~* ?`, [sqlPattern(term)]);
      }
    })
    .orderByRaw(
      `(${terms.map(() => `CASE WHEN ${holds} THEN 1 ELSE 0 END`).join(' + ')}) DESC, ${newestColumn} DESC NULLS LAST, id`,
      terms.flatMap(holdsBindings),
    )
    .limit(MAX_READ);
}

// The registry's rows a search may find (registryLink judges each in full):
// live, indexable, published blog posts, each one page's, with a URL that can
// be on the hub. Of the metadata, only the frontmatter the link rule reads
// (the sites a post renders on). (Every pattern is a binding: knex reads a
// bare ? in the SQL as one.)
function registryMatches(knex, terms) {
  return anyTermIn(knex('content_registry')
    .where({ content_type: 'blog', workflow_status: 'published', astro_status: 'present' })
    .whereIn('live_status', REGISTRY_LIVE_STATUSES)
    .whereIn('reconciliation_status', REGISTRY_ATTRIBUTABLE_STATES)
    .whereRaw('COALESCE(noindex_detected, false) = false')
    .whereRaw(
      "(live_url ~* ? OR (COALESCE(live_url, '') !~* ? AND (COALESCE(canonical_url, '') !~* ? OR canonical_url ~* ?)))",
      [HUB_URL_RE, ABSOLUTE_URL_RE, ABSOLUTE_URL_RE, HUB_URL_RE],
    ), REGISTRY_FIELDS, terms, 'published_at')
    .select([
      ...REGISTRY_COLUMNS.filter((column) => column !== 'metadata'),
      knex.raw("jsonb_build_object('frontmatter', metadata -> 'frontmatter', 'astro', jsonb_build_object('frontmatter', metadata -> 'astro' -> 'frontmatter')) AS metadata"),
    ]);
}
// The portal's posts stamped live on the site that hold any of the terms.
function portalMatches(knex, terms) {
  return anyTermIn(knex('blog_posts')
    .where('status', 'published')
    .where('astro_status', 'live')
    .whereNotNull('astro_live_url')
    .whereRaw('astro_live_url ILIKE ?', [`%${SITE_HOST}%`]), PORTAL_FIELDS, terms, 'astro_published_at')
    .select([...COLUMNS, 'meta_description', 'keyword']);
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
  const [registryFound, portalFound] = await Promise.all([registryMatches(knex, terms), portalMatches(knex, terms)]);
  for (const [source, rows] of [['registry', registryFound], ['portal', portalFound]]) {
    if (rows.length >= MAX_READ) logger.warn(`[report-blog-post] the ${source} search read reached ${MAX_READ} rows; rows past it were not ranked`);
  }
  const found = new Map();
  const add = (post, texts, when) => {
    if (!post) return;
    const key = pathKey(post.url);
    if (found.has(key)) return;
    found.set(key, { post, ...matchOf(texts, terms), when: when ? new Date(when).getTime() || 0 : 0 });
  };
  for (const row of registryFound) {
    add(registryLink(row), { title: `${row.title || ''} ${row.h1 || ''}`, keyword: row.target_keyword, summary: row.meta_description }, row.published_at);
  }
  // A portal post the registry keeps a row for is the registry's alone
  // (portalLink): found above by its current text, or not at all (GitHub
  // Codex P2 on 8117bdc9dc: a retitled post must not match on the portal's
  // stale title). The portal adds the posts the registry has no row for.
  const registryByPost = await registryRowsForPortal(knex, portalFound.map((row) => row.id).filter(Boolean));
  for (const row of portalFound) {
    if (registryByPost.has(String(row.id))) continue;
    add(reportBlogLink(row), { title: row.title, keyword: row.keyword, summary: row.meta_description }, row.astro_published_at);
  }
  const entries = [...found.values()].filter((entry) => entry.held.some(Boolean));
  // A word few posts hold says more than one many hold ("tick" over
  // "control"), so a post that holds some of the words ranks by the rarest:
  // counted over the posts a report may link, every one read (GitHub Codex
  // P2 on 8c57183332: never over rows the link rule refuses).
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
  if (!row) return { post: null, rejected: true };
  // A portal pick the sweep has a row for stands on the sweep's verdict. A
  // failed read (the completion's fail-soft reader answers null) refuses the
  // pick, never falls back to the portal's stamp (pre-push P1).
  const matched = await read((k) => k('content_registry').where({ db_blog_id: blogPostId }).select(REGISTRY_COLUMNS));
  if (!Array.isArray(matched)) return { post: null, rejected: true };
  const post = portalLink(row, matched);
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
