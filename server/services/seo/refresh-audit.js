/**
 * refresh-audit.js — content refresh-priority audit (Pillar 4, "discipline layer").
 *
 * The portal already DETECTS decay (content-decay.js → seo_content_decay_alerts),
 * SCORES helpfulness (content-qa.js → seo_content_qa_scores), and REFRESHES pages
 * (autonomous-runner + refresh-agent, fed by opportunity_queue). What was missing
 * is a single PRIORITIZED view that ranks the ~320 published pages by how badly
 * each needs a refresh, and a one-click way to hand a chosen page to that existing
 * engine. This service is that brain — it reads the existing signals, it does NOT
 * re-implement decay/QA/refresh.
 *
 * Priority (0–100) blends three existing signals:
 *   • Staleness  (0–40) — days since the page was last updated.
 *   • QA gap     (0–35) — how far the latest helpfulness score is below 50/50.
 *   • Decay      (0–25) — an open traffic/impression-drop alert and its severity.
 *
 * "Queue refresh" seeds opportunity_queue exactly like intercept-brief-seeder does
 * (action_type=refresh_existing_page). It is SAFE by default: the autonomous engine
 * ships behind SHADOW_MODE_REFRESH_EXISTING_PAGE (default on → composes + gates but
 * does not publish), so seeding never makes a live change on its own.
 */

const db = require('../../models/db');
const logger = require('../logger');
const { etDateString, addETDays } = require('../../utils/datetime-et');

// Astro/GSC canonical hub origin (used only for DISPLAY + a never-seeded
// fallback — gsc_pages/decay matching below is path-keyed and domain-scoped).
const HUB = 'https://www.wavespestcontrol.com';
const HUB_DOMAIN = 'wavespestcontrol.com';
const GSC_LOOKBACK_DAYS = 90;

// gsc_pages is synced for the WHOLE network (hub + city spokes share paths like
// /pest-control-sarasota-fl/), so impressions must be scoped to the target's
// registrable domain — else a spoke's traffic satisfies a hub page's gate.
function registrableDomain(url) {
  if (!url) return null;
  const host = String(url).replace(/^[a-z]+:\/\//i, '').split('/')[0].split(':')[0];
  return host.replace(/^www\./i, '').toLowerCase() || null;
}
// SQL: registrable domain of a gsc_pages.domain value (drops a leading www.).
const REGISTRABLE_DOMAIN_SQL = "regexp_replace(lower(domain), '^www[.]', '')";
// SQL: registrable host extracted from a full-URL column (no literal '?' — that
// collides with knex bind placeholders; '/' and '//' are safe). `col` is internal.
function hostRegistrableSql(col) {
  return `regexp_replace(regexp_replace(split_part(split_part(lower(${col}), '//', 2), '/', 1), '^www[.]', ''), ':.*$', '')`;
}
// Host-agnostic path of a url column, trailing slash trimmed: GSC may report
// www vs non-www and ?utm tracking variants, so we match on path only. The
// column differs per table (gsc_pages.page_url vs seo_content_decay_alerts.url),
// so it's parameterized. chr(63) is '?' — a literal '?' in knex raw collides with
// bind placeholders (same trick as gsc-opportunity-miner). `col` is an internal
// literal, never user input.
function canonPathSql(col) {
  return `regexp_replace(regexp_replace(split_part(${col}, chr(63), 1), '^[a-z]+://[^/]+', ''), '/+$', '')`;
}

function slugPath(slug) {
  return `/${String(slug || '').replace(/^\/+|\/+$/g, '')}`;
}
function urlToPath(u) {
  if (!u) return null;
  return (
    String(u)
      .split('#')[0]
      .split('?')[0]
      .replace(/^[a-z]+:\/\/[^/]+/i, '')
      .replace(/\/+$/, '') || '/'
  );
}
// The path GSC/decay actually key on: prefer the live URL's path (it's
// authoritative and may diverge from slug for imports or an edited slug).
function pathFor(post) {
  if (post.astro_live_url) return urlToPath(post.astro_live_url);
  return post.slug ? slugPath(post.slug) : null;
}

// Staleness ramp: nothing below FRESH_DAYS, full weight at/above STALE_FULL_DAYS.
const FRESH_DAYS = 90;
const STALE_FULL_DAYS = 540;
const STALE_WEIGHT = 40;
const QA_WEIGHT = 35;
const QA_UNSCORED = 14; // moderate priority so unscored pages surface for scoring
const DECAY_MAX = 25;
// opportunity_queue floor: the runner claims rows with score >= minScoreToAct
// (default 75). An operator who clicks "Queue refresh" is explicitly saying "run
// this", so a seeded row always clears the floor while still ordering by priority.
const ENQUEUE_FLOOR = 78;

// blog_posts.tag → autonomous engine `service` MINER CATEGORY (best-effort; null
// is fine, the brief builder drives off page_url for a refresh). Values must be
// the miner categories facts-sufficiency.js maps (pest/termite/rodent/mosquito/
// lawn/tree-shrub) — a wrong id fails a city-scoped refresh as facts_unmappable.
// Keys are lowercased blog_posts.tag values → autonomous-engine miner category.
// Covers both the blog-seo-contract.js CATEGORY labels ('Pest Control', 'Lawn
// Care', 'Termites', 'Mosquito Control', 'Tree & Shrub Care') AND the granular
// tag dropdown in BlogPage.jsx ('Ants', 'Cockroaches', 'Mosquitoes', …). The
// pest sub-topics roll up to the 'pest' category (→ pest-control facts); null is
// still safe (facts gate is skipped) — we just map what we can confidently.
const TAG_TO_SERVICE = {
  // categories / umbrella
  'pest control': 'pest',
  insects: 'pest',
  'flying insects': 'pest',
  // pest sub-topics
  ants: 'pest',
  'bed bugs': 'pest',
  cockroaches: 'pest',
  roaches: 'pest',
  fleas: 'pest',
  ticks: 'pest',
  spiders: 'pest',
  // lawn
  'lawn care': 'lawn',
  lawn: 'lawn',
  'lawn pests': 'lawn',
  // dedicated services
  'mosquito control': 'mosquito',
  mosquito: 'mosquito',
  mosquitoes: 'mosquito',
  termites: 'termite',
  termite: 'termite',
  rodents: 'rodent',
  rodent: 'rodent',
  'tree & shrub care': 'tree-shrub',
  'tree and shrub care': 'tree-shrub',
  'tree & shrub': 'tree-shrub',
  'tree and shrub': 'tree-shrub',
};

function pageUrlFor(post) {
  if (post.astro_live_url) return post.astro_live_url;
  return post.slug ? `${HUB}/${post.slug}/` : null;
}

function serviceFor(post) {
  const tag = (post.tag || '').trim().toLowerCase();
  return TAG_TO_SERVICE[tag] || null;
}

function ageDaysFrom(post, now) {
  const touched = post.updated_at || post.publish_date;
  if (!touched) return null;
  const ms = now - new Date(touched).getTime();
  return ms >= 0 ? Math.floor(ms / 86400000) : 0;
}

/** Blend the three signals into a 0–100 priority + human-readable reasons. */
function scorePriority({ ageDays, qa, decay }) {
  let priority = 0;
  const reasons = [];

  if (ageDays != null && ageDays > FRESH_DAYS) {
    const ramp = Math.min(1, (ageDays - FRESH_DAYS) / (STALE_FULL_DAYS - FRESH_DAYS));
    priority += ramp * STALE_WEIGHT;
    if (ageDays >= 180) reasons.push(`${ageDays}d since update`);
  }

  if (qa && qa.total_score != null) {
    priority += ((50 - qa.total_score) / 50) * QA_WEIGHT;
    if (qa.total_score < 38) reasons.push(`QA ${qa.grade} (${qa.total_score}/50)`);
  } else {
    priority += QA_UNSCORED;
    reasons.push('not yet QA-scored');
  }

  if (decay) {
    const base = decay.alert_type === 'traffic_drop' ? 15 : 10;
    const sev = Math.min(10, Math.abs(Number(decay.change_pct) || 0) / 10);
    priority += Math.min(DECAY_MAX, base + sev);
    reasons.push(`${decay.alert_type === 'impression_drop' ? 'impressions' : 'traffic'} ${Math.round(Number(decay.change_pct) || 0)}%`);
  }

  return { priority: Math.min(100, Math.round(priority)), reasons };
}

/** Most-severe open decay alert per page (by abs change_pct), keyed by
 *  blog_post_id and by "registrable-domain|path" (the network shares paths across
 *  hub + spokes, so a path-only key could attach a spoke's alert to a hub page). */
function indexDecay(rows) {
  const byPost = new Map();
  const byDomainPath = new Map();
  const keep = (map, key, row) => {
    if (key == null) return;
    const cur = map.get(key);
    if (!cur || Math.abs(Number(row.change_pct) || 0) > Math.abs(Number(cur.change_pct) || 0)) map.set(key, row);
  };
  for (const r of rows) {
    if (r.blog_post_id) keep(byPost, r.blog_post_id, r);
    const dom = registrableDomain(r.url);
    const p = urlToPath(r.url);
    if (dom && p) keep(byDomainPath, `${dom}|${p}`, r);
  }
  return { byPost, byDomainPath };
}

class RefreshAudit {
  /**
   * Ranked refresh audit of published pages. Read-only — joins existing tables.
   * @returns {{ summary, candidates }} candidates sorted by priority desc.
   */
  async getAudit({ limit = 100 } = {}) {
    const posts = await db('blog_posts')
      .where('status', 'published')
      .select('id', 'slug', 'title', 'tag', 'city', 'keyword', 'publish_date', 'updated_at', 'astro_live_url', 'word_count');

    // Latest QA score per blog_post_id (rows are append/update; newest wins).
    const qaRows = await db('seo_content_qa_scores').orderBy('created_at', 'desc').orderBy('id', 'desc');
    const qaByPost = new Map();
    for (const r of qaRows) {
      if (r.blog_post_id && !qaByPost.has(r.blog_post_id)) qaByPost.set(r.blog_post_id, r);
    }

    const decayRows = await db('seo_content_decay_alerts').where('status', 'open');
    const { byPost: decayByPost, byDomainPath: decayByDomainPath } = indexDecay(decayRows);

    const now = Date.now();
    const candidates = posts.map((p) => {
      const url = pageUrlFor(p);
      const domain = registrableDomain(p.astro_live_url) || HUB_DOMAIN;
      const qa = qaByPost.get(p.id) || null;
      // The blog_post_id link is slug-derived by the producer, so validate its URL
      // is on this post's domain before trusting it; else match by domain|path.
      const dPost = decayByPost.get(p.id);
      const decay =
        (dPost && registrableDomain(dPost.url) === domain ? dPost : null) ||
        decayByDomainPath.get(`${domain}|${pathFor(p)}`) ||
        null;
      const ageDays = ageDaysFrom(p, now);
      const { priority, reasons } = scorePriority({ ageDays, qa, decay });
      return {
        blogPostId: p.id,
        url,
        slug: p.slug,
        title: p.title,
        tag: p.tag,
        city: p.city,
        ageDays,
        publishDate: p.publish_date,
        qaScore: qa ? qa.total_score : null,
        qaGrade: qa ? qa.grade : null,
        decayPct: decay ? Math.round(Number(decay.change_pct) || 0) : null,
        decayType: decay ? decay.alert_type : null,
        priority,
        reasons,
      };
    });

    candidates.sort((a, b) => b.priority - a.priority);

    const summary = {
      totalPublished: posts.length,
      unscored: candidates.filter((c) => c.qaScore == null).length,
      lowQa: candidates.filter((c) => c.qaScore != null && c.qaScore < 38).length,
      withDecay: candidates.filter((c) => c.decayType != null).length,
      stale: candidates.filter((c) => c.ageDays != null && c.ageDays >= 180).length,
      highPriority: candidates.filter((c) => c.priority >= 60).length,
    };

    return { summary, candidates: candidates.slice(0, limit) };
  }

  /**
   * Hand a chosen published page to the existing autonomous refresh engine by
   * seeding opportunity_queue (action_type=refresh_existing_page). Idempotent via
   * dedupe_key; never resets a row the runner already claimed/finished. Safe by
   * default (shadow mode).
   *
   * Keyed by { blogPostId } ONLY — the audit always carries blogPostId, and a
   * raw-URL lookup is unsafe on this hub/spoke network (paths are shared across
   * domains, so a URL could resolve to the wrong domain's post). blogPostId is
   * unambiguous and pins the exact page + its domain (via astro_live_url).
   */
  async enqueueRefresh({ blogPostId = null } = {}) {
    if (!blogPostId) {
      const err = new Error('blogPostId is required');
      err.code = 'BAD_REQUEST';
      throw err;
    }
    const post = await db('blog_posts').where({ id: blogPostId }).first();
    if (!post) {
      const err = new Error('page not found for refresh enqueue');
      err.code = 'NOT_FOUND';
      throw err;
    }
    // The audit is a PUBLISHED-page contract — getAudit only ranks published
    // posts. Don't let a direct API caller seed refresh work for a draft/scheduled
    // post (it would point the autonomous runner at unpublished content).
    if (post.status !== 'published') {
      const err = new Error(`page is not published (status: ${post.status})`);
      err.code = 'NOT_PUBLISHED';
      throw err;
    }
    if (!post.slug && !post.astro_live_url) {
      const err = new Error('page has no resolvable URL (missing slug)');
      err.code = 'NO_URL';
      throw err;
    }
    // Fail closed on a city-scoped page whose tag can't map to a service: the
    // autonomous runner's facts-sufficiency / claims-ledger grounding only applies
    // when BOTH city and service are present, so queuing city-without-service would
    // refresh the page WITHOUT facts-bank grounding — exactly what the gate exists
    // to prevent. (A page with no city is fine: it's not a facts-gated city×service.)
    const service = serviceFor(post);
    if (post.city && !service) {
      const err = new Error(`could not map this page's tag (${post.tag ? `"${post.tag}"` : 'none'}) to a service, which is required to ground a city-scoped refresh`);
      err.code = 'NO_SERVICE';
      throw err;
    }

    const path = pathFor(post);
    // Registrable domain of the target (blog posts live on the hub unless
    // astro_live_url says otherwise) — scopes GSC + dedupe to THIS domain.
    const targetDomain = registrableDomain(post.astro_live_url) || HUB_DOMAIN;

    // Don't double-queue: an in-flight refresh for this page may already exist
    // under ANOTHER bucket's dedupe_key (e.g. the GSC miner's decay_refresh), and
    // our refresh-audit key won't collide with it. claimNext only acts on one
    // pending row, so a second pending refresh for the same target is wasted work.
    const inflight = await db('opportunity_queue')
      .where('action_type', 'refresh_existing_page')
      .whereIn('status', ['pending', 'claimed', 'pending_review'])
      .whereRaw(`${canonPathSql('page_url')} = ?`, [path])
      .whereRaw(`${hostRegistrableSql('page_url')} = ?`, [targetDomain])
      .first();
    if (inflight) {
      return { queued: false, status: inflight.status, url: inflight.page_url, dedupeKey: inflight.dedupe_key };
    }

    const qa = await db('seo_content_qa_scores')
      .where({ blog_post_id: post.id })
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .first();
    const decay = await db('seo_content_decay_alerts')
      .where({ status: 'open' })
      // Domain is a REQUIRED outer condition — content-decay links blog_post_id by
      // slug only, so a same-path spoke alert can carry a hub post's id. Scoping
      // the whole match to the target domain validates the blog_post_id shortcut
      // too (the network shares paths across hub + spokes).
      .whereRaw(`${hostRegistrableSql('url')} = ?`, [targetDomain])
      .andWhere(function () {
        this.where({ blog_post_id: post.id }).orWhereRaw(`${canonPathSql('url')} = ?`, [path]);
      })
      .orderByRaw('abs(change_pct) desc')
      .first();

    // The autonomous refresh path is GSC-evidence-gated: content-brief-builder
    // maps signal_metadata.{impressions,avg_position,ctr,decay_pct} → brief.gsc_signal,
    // and content-quality-gate hard-fails a non-operator refresh when
    // gsc_signal.impressions is missing (and `impressions || null` makes 0 → null).
    // So a queued refresh MUST carry the page's real Search Console signal — same
    // contract as a gsc-opportunity-miner decay_refresh row. Match gsc_pages by
    // canonical PATH (GSC reports www vs non-www and ?utm variants) SCOPED to the
    // target's registrable domain (the network shares paths across hub + spokes),
    // and recover the real GSC-reported URL to seed as the target. A page with no
    // GSC impressions can't be meaningfully refreshed by this engine; fail fast
    // with a clear reason instead of seeding a run doomed to no_gsc_signal.
    const since = etDateString(addETDays(new Date(), -GSC_LOOKBACK_DAYS));
    const gsc = await db('gsc_pages')
      .where('date', '>=', since)
      .whereRaw(`${REGISTRABLE_DOMAIN_SQL} = ?`, [targetDomain])
      .whereRaw(`${canonPathSql('page_url')} = ?`, [path])
      .select(db.raw('min(split_part(page_url, chr(63), 1)) as gsc_url'))
      .sum('clicks as clicks')
      .sum('impressions as impressions')
      .avg('position as avg_position')
      .first();
    const impressions = gsc && gsc.impressions != null ? Math.round(Number(gsc.impressions)) : 0;
    if (!impressions) {
      const err = new Error(`no Search Console impressions for ${path} in the last ${GSC_LOOKBACK_DAYS} days — the refresh engine needs GSC signal to refresh against`);
      err.code = 'NO_GSC_SIGNAL';
      throw err;
    }
    const clicks = gsc && gsc.clicks != null ? Math.round(Number(gsc.clicks)) : 0;
    const avgPosition = gsc && gsc.avg_position != null ? Number(Number(gsc.avg_position).toFixed(1)) : null;
    const ctr = Number((clicks / impressions).toFixed(4));
    // Match the gsc-opportunity-miner decay_refresh contract: decay_pct is a
    // POSITIVE FRACTION of the click drop (e.g. 0.52 for a -52% change), not a
    // signed percentage — downstream consumers read it on that scale.
    const decayPct = decay ? Number((Math.abs(Number(decay.change_pct) || 0) / 100).toFixed(4)) : null;

    // Target URL the runner/publisher will load: the authoritative live URL if
    // known, else the real GSC-reported host (not a guessed origin), else the
    // canonical hub fallback. The gsc_signal above is path-derived, so impressions
    // are correct regardless of which host string we seed here.
    const pageUrl = post.astro_live_url || gsc.gsc_url || pageUrlFor(post);

    const ageDays = ageDaysFrom(post, Date.now());
    const { priority, reasons } = scorePriority({ ageDays, qa: qa || null, decay: decay || null });
    const score = Math.max(ENQUEUE_FLOOR, priority);
    // Domain in the key: hub + spoke pages can share a slug/path, and a
    // domain-less key would conflate them under ON CONFLICT.
    const dedupeKey = `refresh-audit:${targetDomain}:${post.slug || post.id}`.slice(0, 200);
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    // Mirror intercept-brief-seeder's upsert: never reset a claimed/done/in-review
    // row; revive skipped/expired ones (an operator re-queue is an explicit "run it").
    const result = await db.raw(
      `INSERT INTO opportunity_queue
         (bucket, action_type, query, page_url, service, city,
          score, score_breakdown, signal_metadata, status,
          mined_at, expires_at, available_at, dedupe_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?::jsonb, ?, now(), ?, null, ?, now(), now())
       ON CONFLICT (dedupe_key) DO UPDATE
         SET score = EXCLUDED.score,
             score_breakdown = EXCLUDED.score_breakdown,
             signal_metadata = EXCLUDED.signal_metadata,
             page_url = EXCLUDED.page_url,
             service = EXCLUDED.service,
             city = EXCLUDED.city,
             expires_at = EXCLUDED.expires_at,
             mined_at = now(),
             status = CASE WHEN opportunity_queue.status IN ('claimed', 'done', 'pending_review')
                           THEN opportunity_queue.status
                           ELSE 'pending'
                      END,
             updated_at = now()
       RETURNING id, status`,
      [
        'content_refresh_audit',
        'refresh_existing_page',
        null,
        pageUrl,
        service,
        post.city || null,
        score,
        JSON.stringify({ source: 'refresh_audit', priority, reasons }),
        // signal_metadata: snake_case GSC fields the brief-builder reads into
        // gsc_signal (impressions/avg_position/ctr/decay_pct), plus audit context.
        JSON.stringify({
          impressions,
          avg_position: avgPosition,
          ctr,
          decay_pct: decayPct,
          clicks,
          source: 'refresh_audit',
          qa_score: qa ? qa.total_score : null,
          age_days: ageDays,
          priority,
        }),
        'pending',
        expiresAt,
        dedupeKey,
      ]
    );

    const row = result.rows && result.rows[0];
    const status = row ? row.status : 'pending';
    // The upsert preserves an existing claimed/done/pending_review row (it does
    // NOT reset it to pending), and the runner's claimNext only picks 'pending'.
    // So only a 'pending' result is actually (re)queued — report the real state so
    // the UI doesn't show "Queued" for a no-op on an already-handled page.
    const queued = status === 'pending';
    logger.info(`[refresh-audit] enqueue refresh ${pageUrl} (score ${score}) → status ${status}, queued=${queued}`);
    return { queued, status, url: pageUrl, score, dedupeKey };
  }
}

module.exports = new RefreshAudit();
