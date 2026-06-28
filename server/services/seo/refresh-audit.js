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
// fallback — all gsc_pages/decay matching below is host-agnostic by path).
const HUB = 'https://www.wavespestcontrol.com';
const GSC_LOOKBACK_DAYS = 90;
// Host-agnostic path of a gsc_pages/decay url, trailing slash trimmed: GSC may
// report www vs non-www and ?utm tracking variants, so we match on path only.
// SQL mirror (CANON_PATH_SQL) uses chr(63) for '?' — a literal '?' in knex raw
// collides with bind placeholders (same trick as gsc-opportunity-miner).
const CANON_PATH_SQL = "regexp_replace(regexp_replace(split_part(page_url, chr(63), 1), '^[a-z]+://[^/]+', ''), '/+$', '')";

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

// blog_posts.tag → autonomous engine `service` hint (best-effort; null is fine,
// the brief builder drives off page_url for a refresh).
const TAG_TO_SERVICE = {
  'pest control': 'pest',
  rodents: 'rodent',
  rodent: 'rodent',
  mosquito: 'mosquito',
  'mosquito control': 'mosquito',
  termite: 'termite',
  termites: 'termite',
  'lawn care': 'lawn',
  lawn: 'lawn',
  'tree and shrub': 'tree_shrub',
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
 *  blog_post_id and by host-agnostic path. */
function indexDecay(rows) {
  const byPost = new Map();
  const byPath = new Map();
  const keep = (map, key, row) => {
    if (key == null) return;
    const cur = map.get(key);
    if (!cur || Math.abs(Number(row.change_pct) || 0) > Math.abs(Number(cur.change_pct) || 0)) map.set(key, row);
  };
  for (const r of rows) {
    if (r.blog_post_id) keep(byPost, r.blog_post_id, r);
    keep(byPath, urlToPath(r.url), r);
  }
  return { byPost, byPath };
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
    const { byPost: decayByPost, byPath: decayByPath } = indexDecay(decayRows);

    const now = Date.now();
    const candidates = posts.map((p) => {
      const url = pageUrlFor(p);
      const qa = qaByPost.get(p.id) || null;
      const decay = decayByPost.get(p.id) || decayByPath.get(slugPath(p.slug)) || null;
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
   * default (shadow mode). Accepts { blogPostId } or { url }.
   */
  async enqueueRefresh({ blogPostId = null, url = null } = {}) {
    let post = null;
    if (blogPostId) {
      post = await db('blog_posts').where({ id: blogPostId }).first();
    } else if (url) {
      const slug = String(url).replace(/^[a-z]+:\/\/[^/]+/i, '').replace(/^\/|\/$/g, '');
      post = await db('blog_posts').where({ slug }).first();
    }
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

    const path = post.slug ? slugPath(post.slug) : urlToPath(post.astro_live_url);

    const qa = await db('seo_content_qa_scores')
      .where({ blog_post_id: post.id })
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .first();
    const decay = await db('seo_content_decay_alerts')
      .where({ status: 'open' })
      .andWhere(function () {
        this.where({ blog_post_id: post.id }).orWhereRaw(`${CANON_PATH_SQL} = ?`, [path]);
      })
      .orderByRaw('abs(change_pct) desc')
      .first();

    // The autonomous refresh path is GSC-evidence-gated: content-brief-builder
    // maps signal_metadata.{impressions,avg_position,ctr,decay_pct} → brief.gsc_signal,
    // and content-quality-gate hard-fails a non-operator refresh when
    // gsc_signal.impressions is missing (and `impressions || null` makes 0 → null).
    // So a queued refresh MUST carry the page's real Search Console signal — same
    // contract as a gsc-opportunity-miner decay_refresh row. Match gsc_pages by
    // host-agnostic PATH (GSC may report www vs non-www and ?utm variants), and
    // also recover the real GSC-reported URL to seed as the target. A page with no
    // GSC impressions can't be meaningfully refreshed by this engine; fail fast
    // with a clear reason instead of seeding a run doomed to no_gsc_signal.
    const since = etDateString(addETDays(new Date(), -GSC_LOOKBACK_DAYS));
    const gsc = await db('gsc_pages')
      .where('date', '>=', since)
      .whereRaw(`${CANON_PATH_SQL} = ?`, [path])
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
    const decayPct = decay ? Math.round(Number(decay.change_pct) || 0) : null;

    // Target URL the runner/publisher will load: the authoritative live URL if
    // known, else the real GSC-reported host (not a guessed origin), else the
    // canonical hub fallback. The gsc_signal above is path-derived, so impressions
    // are correct regardless of which host string we seed here.
    const pageUrl = post.astro_live_url || gsc.gsc_url || pageUrlFor(post);

    const ageDays = ageDaysFrom(post, Date.now());
    const { priority, reasons } = scorePriority({ ageDays, qa: qa || null, decay: decay || null });
    const score = Math.max(ENQUEUE_FLOOR, priority);
    const dedupeKey = `refresh-audit:${post.slug || post.id}`.slice(0, 200);
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
        serviceFor(post),
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

    const queued = result.rows && result.rows[0];
    logger.info(`[refresh-audit] queued refresh ${pageUrl} (score ${score}, status ${queued ? queued.status : 'pending'})`);
    return { queued: true, url: pageUrl, score, status: queued ? queued.status : 'pending', dedupeKey };
  }
}

module.exports = new RefreshAudit();
