/**
 * brief-driven-tools.js — tool executors for the Writer / Refresh /
 * MetaRewriter agents.
 *
 * Separate from the existing content-agent-tools.js so the
 * legacy waves-content-engine agent and its tools stay untouched.
 * The dispatcher routes tool calls from any of the three new agents
 * here.
 *
 * Tool surface:
 *   get_content_brief        read content_briefs by opportunity_id
 *   get_serp_profile         delegate to serp-profiler
 *   get_gsc_signal           read gsc_queries / gsc_pages
 *   get_customer_questions   read customer_insight_clusters
 *   get_existing_page        read an Astro page via github-client
 *   get_existing_metadata    read only the frontmatter title + meta
 *   search_knowledge_base    delegate to existing wiki-qa (lazy load)
 *   check_existing_content   delegate to existing blog-writer overlap check
 *   emit_draft               capture the draft on the session — does NOT publish
 *   emit_metadata_only       capture the metadata rewrite on the session
 *
 * emit_* tools are SINK calls — they store the agent's final output
 * in the session and return a confirmation. The dispatcher reads the
 * captured output after the session completes. No DB writes here.
 */

const db = require('../../../models/db');
const logger = require('../../logger');
const { etDateString, addETDays } = require('../../../utils/datetime-et');

// Lazy loaders — every dependency is optional. Each loader resolves
// once and caches the result (or null if the module is unavailable on
// this branch in the stack).
function lazy(name, path) {
  let mod;
  return () => {
    if (mod === undefined) {
      try { mod = require(path); }
      catch (err) { logger.warn(`[brief-driven-tools] ${name} unavailable: ${err.message}`); mod = null; }
    }
    return mod;
  };
}
const getSerpProfiler = lazy('serp-profiler', '../../seo/serp-profiler');
const getGithubClient = lazy('github-client', '../../content-astro/github-client');
const getFrontmatter = lazy('frontmatter', '../../content-astro/frontmatter');

// ── tool executor ────────────────────────────────────────────────────

/**
 * Per-session emit_draft / emit_metadata_only capture into a Map. The
 * dispatcher gives each session a unique sessionId and reads from
 * sessionDrafts[sessionId] after the agent completes.
 */
const sessionDrafts = new Map();

function getDraft(sessionId) {
  return sessionDrafts.get(sessionId) || null;
}

function clearDraft(sessionId) {
  sessionDrafts.delete(sessionId);
}

async function executeBriefTool(toolName, input, { sessionId } = {}) {
  switch (toolName) {

    case 'get_content_brief': {
      const { opportunity_id } = input || {};
      if (!opportunity_id) return { error: 'opportunity_id required' };
      try {
        const row = await db('content_briefs')
          .where('opportunity_id', opportunity_id)
          .orderBy('version', 'desc')
          .first();
        if (!row) return { error: `no brief found for opportunity ${opportunity_id}` };
        return parseJsonbColumns(row, [
          'score_breakdown', 'serp_signal', 'gsc_signal',
          'customer_signal', 'conversion_signal',
          'required_sections', 'schema_types', 'internal_links_to_add',
          'voice_constraints',
        ]);
      } catch (err) {
        return { error: `content_briefs read failed: ${err.message}` };
      }
    }

    case 'get_serp_profile': {
      const profiler = getSerpProfiler();
      if (!profiler) return { error: 'serp-profiler unavailable' };
      const { query, city = null } = input || {};
      if (!query) return { error: 'query required' };
      try {
        const profile = await profiler.profile({ query, city, persist: false });
        if (!profile) return { error: 'no SERP data returned (DataForSEO credits / config)' };
        return profile;
      } catch (err) {
        return { error: `serp-profiler failed: ${err.message}` };
      }
    }

    case 'get_gsc_signal': {
      const { query, page_url, days = 28 } = input || {};
      const since = etDateString(addETDays(new Date(), -days));
      try {
        if (query) {
          const rows = await db('gsc_queries')
            .where('date', '>=', since)
            .where('query', query)
            .select('device').sum('clicks as clicks').sum('impressions as impressions')
            .avg('position as avg_position').avg('ctr as ctr')
            .groupBy('device');
          return { query, since, rows };
        }
        if (page_url) {
          const rows = await db('gsc_pages')
            .where('date', '>=', since)
            .where('page_url', page_url)
            .select('device').sum('clicks as clicks').sum('impressions as impressions')
            .avg('position as avg_position').avg('ctr as ctr')
            .groupBy('device');
          return { page_url, since, rows };
        }
        return { error: 'query or page_url required' };
      } catch (err) {
        return { error: `gsc read failed: ${err.message}` };
      }
    }

    case 'get_customer_questions': {
      const { city = null, service = null, limit = 10 } = input || {};
      try {
        let q = db('customer_insight_clusters').orderBy('total_count', 'desc').limit(limit);
        if (city) q = q.where('city', city);
        if (service) q = q.where('service', service);
        const rows = await q.select(
          'topic', 'normalized_question', 'city', 'service',
          'total_count', 'source_counts',
          'funnel_stage', 'urgency', 'example_phrasing_anonymized', 'redaction_confidence'
        );
        return { city, service, clusters: rows.map((r) => parseJsonbColumns(r, ['source_counts'])) };
      } catch (err) {
        return { error: `customer_insight_clusters read failed: ${err.message}` };
      }
    }

    case 'get_existing_page': {
      const gh = getGithubClient();
      const fm = getFrontmatter();
      if (!gh || !fm) return { error: 'github-client / frontmatter parser unavailable' };
      const { page_url } = input || {};
      if (!page_url) return { error: 'page_url required' };
      try {
        const filePath = urlToAstroPath(page_url);
        if (!filePath) return { error: `could not resolve page_url ${page_url} to Astro file` };
        const raw = await gh.getFile(filePath);
        if (!raw) return { error: `Astro file not found: ${filePath}` };
        const parsed = fm.parse(raw);
        return { page_url, file_path: filePath, frontmatter: parsed.data, body: parsed.content };
      } catch (err) {
        return { error: `get_existing_page failed: ${err.message}` };
      }
    }

    case 'get_existing_metadata': {
      const result = await executeBriefTool('get_existing_page', input, { sessionId });
      if (result.error) return result;
      return {
        page_url: result.page_url,
        title: result.frontmatter?.title || null,
        meta_description: result.frontmatter?.meta_description || null,
      };
    }

    case 'search_knowledge_base': {
      let wikiQa;
      try { wikiQa = require('../../knowledge/wiki-qa'); }
      catch (e) { return { error: `wiki-qa unavailable: ${e.message}` }; }
      const { topic } = input || {};
      if (!topic) return { error: 'topic required' };
      try {
        const answer = await wikiQa.ask(topic);
        return { topic, answer };
      } catch (err) {
        return { error: `wiki-qa failed: ${err.message}` };
      }
    }

    case 'check_existing_content': {
      const { keyword, city = null } = input || {};
      if (!keyword) return { error: 'keyword required' };
      try {
        const matches = await db('blog_posts')
          .where('status', 'published')
          .where((qb) => {
            qb.whereRaw('LOWER(keyword) LIKE ?', [`%${keyword.toLowerCase()}%`])
              .orWhereRaw('LOWER(title) LIKE ?', [`%${keyword.toLowerCase()}%`]);
          })
          .modify((qb) => { if (city) qb.where('city', city); })
          .select('id', 'slug', 'title', 'tag', 'city', 'keyword')
          .limit(20);
        return { keyword, city, matches };
      } catch (err) {
        return { error: `blog_posts read failed: ${err.message}` };
      }
    }

    case 'emit_draft': {
      if (!sessionId) return { error: 'session context missing — dispatcher must pass sessionId' };
      const { frontmatter, body, schema, notes_for_reviewer } = input || {};
      if (!frontmatter || !body) return { error: 'frontmatter and body required' };
      sessionDrafts.set(sessionId, {
        type: 'draft',
        frontmatter,
        body,
        schema: schema || null,
        notes_for_reviewer: notes_for_reviewer || null,
        captured_at: new Date(),
      });
      return { ok: true, captured: true, body_chars: body.length };
    }

    case 'emit_metadata_only': {
      if (!sessionId) return { error: 'session context missing — dispatcher must pass sessionId' };
      const { title, meta_description, notes_for_reviewer } = input || {};
      if (!title || !meta_description) return { error: 'title + meta_description required' };
      sessionDrafts.set(sessionId, {
        type: 'metadata',
        title,
        meta_description,
        notes_for_reviewer: notes_for_reviewer || null,
        captured_at: new Date(),
      });
      return { ok: true, captured: true, title_chars: title.length, meta_chars: meta_description.length };
    }

    default:
      return { error: `unknown tool: ${toolName}` };
  }
}

// ── helpers ──────────────────────────────────────────────────────────

function parseJsonbColumns(row, keys) {
  if (!row) return row;
  const out = { ...row };
  for (const k of keys) {
    if (typeof out[k] === 'string') {
      try { out[k] = JSON.parse(out[k]); } catch { /* keep string */ }
    }
  }
  return out;
}

/**
 * Map a public URL ('/pest-control-bradenton-fl/') to an Astro
 * content collection file path. This is a heuristic — the Astro
 * router conventions in wavespestcontrol-astro/src/content/
 * determine the actual mapping.
 */
function urlToAstroPath(url) {
  if (!url) return null;
  const cleaned = String(url).replace(/^https?:\/\/[^/]+/, '').replace(/\?.*$/, '').replace(/^\/+|\/+$/g, '');
  if (!cleaned) return null;
  if (cleaned.startsWith('blog/')) return `src/content/blog/${cleaned.slice(5)}.md`;
  // city-service slugs live in services collection
  if (/-fl$/.test(cleaned)) return `src/content/services/${cleaned}.md`;
  // generic location pages
  return `src/content/locations/${cleaned}.md`;
}

module.exports = {
  executeBriefTool,
  getDraft,
  clearDraft,
  // exposed for tests:
  _internals: { sessionDrafts, urlToAstroPath, parseJsonbColumns },
};
