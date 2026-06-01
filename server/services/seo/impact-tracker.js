/**
 * impact-tracker.js — measures whether an autonomous optimization actually
 * helped, using difference-in-differences against unoptimized control pages.
 *
 *   estimated_lift = optimized_page_delta - median(control_page_deltas)
 *
 * Subtracting the control delta removes site-wide / seasonal / algorithm
 * movement, so a "win" is movement the optimization caused, not a rising tide.
 *
 * Lifecycle (per published optimization):
 *   1. snapshotBaseline — when the page goes live: record the trailing-28d GSC
 *      metrics, pick 2-3 control pages, set measurement_start = deploy + 3d
 *      (GSC lag; deploy != recrawl).
 *   2. checkPending (daily) — at 14d and 21d past measurement_start, compute
 *      the page + control deltas and a control-adjusted verdict.
 *   3. pausedBuckets — a bucket with 3+ confirmed (21-day) regressions is
 *      surfaced so the runner can stop drafting that action type until reviewed.
 *
 * computeVerdict is a pure function (fully testable, no I/O). Everything else
 * reads gsc_pages / autonomous_runs and writes content_optimization_impact.
 */

const db = require('../../models/db');
const logger = require('../logger');
const GitHubClient = require('../content-astro/github-client');
const { etDateString, addETDays, parseETDateTime } = require('../../utils/datetime-et');

// Parse a stored date (a 'YYYY-MM-DD' string or a pg Date at UTC midnight) as
// an ET calendar day anchored at noon. Without this, `new Date('2026-05-28')`
// is UTC midnight = the prior ET evening, so addETDays/etDateString slip the
// 14d/21d windows a day early. AGENTS.md requires ET helpers, not naive Date math.
function etDayAnchor(value) {
  const ymd = value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
  return parseETDateTime(`${ymd}T12:00:00`);
}

const BASELINE_DAYS = 28;
const DEPLOY_LAG_DAYS = 3;
const MIN_IMPRESSIONS = 30;        // below this → insufficient_data
const MIN_CONFIDENCE = 0.70;       // below this → neutral even if lift is large
const LIFT_POSITION_IMPROVED = 2;  // moved up >=2 spots vs control
const LIFT_CLICKS_IMPROVED_PCT = 20;
const LIFT_POSITION_REGRESSED = -3;
const LIFT_CLICKS_REGRESSED_PCT = -25;
const REGRESSION_PAUSE_THRESHOLD = 3;

// AEO visibility feedback loop (aeo_gap rows only).
const AEO_REPROBE_DAYS = 21;        // wait this many days post-deploy before judging
const AEO_MIN_OBSERVATIONS = 5;     // distinct post-deploy probe-days needed for a verdict

// ── pure verdict core ───────────────────────────────────────────────

// Pure: did Waves start getting cited after the page went live?
function aeoVerdict({ observedDays, wavesHitDays, minObservations = AEO_MIN_OBSERVATIONS }) {
  if (observedDays < minObservations) return { verdict: 'insufficient_data', nowCited: null };
  const nowCited = wavesHitDays > 0;
  return { verdict: nowCited ? 'now_cited' : 'still_absent', nowCited };
}

function median(nums) {
  const xs = nums.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (!xs.length) return 0;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

function clicksPct(baseClicks, windowClicks) {
  return ((windowClicks - baseClicks) / Math.max(baseClicks, 1)) * 100;
}

// Position: lower is better, so delta = baseline - window (positive = improved).
function positionDelta(basePos, windowPos) {
  return (Number(basePos) || 0) - (Number(windowPos) || 0);
}

function confidenceScore({ baselineImpressions, windowImpressions, controlCount }) {
  const volume = Math.min(1, (Number(baselineImpressions) || 0) / 200);
  const window = Math.min(1, (Number(windowImpressions) || 0) / 100);
  const controls = Math.min(1, (Number(controlCount) || 0) / 2);
  // Weakest-link-leaning blend: a thin control set or thin volume should pull
  // confidence down hard.
  const score = 0.4 * volume + 0.3 * window + 0.3 * controls;
  return Math.round(score * 100) / 100;
}

/**
 * computeVerdict({ baseline, window, controlDeltas }) → {
 *   verdict, confidence, estimated_lift_position, estimated_lift_clicks_pct
 * }
 *
 * baseline / window: { position, clicks, impressions }
 * controlDeltas: [{ position_delta, clicks_pct }] for each control page.
 */
function computeVerdict({ baseline, window, controlDeltas = [] }) {
  const baselineImpr = Number(baseline?.impressions) || 0;
  const windowImpr = Number(window?.impressions) || 0;
  const controlCount = controlDeltas.length;

  const pagePosDelta = positionDelta(baseline?.position, window?.position);
  const pageClicksPct = clicksPct(Number(baseline?.clicks) || 0, Number(window?.clicks) || 0);
  const ctrlPosDelta = median(controlDeltas.map((c) => c.position_delta));
  const ctrlClicksPct = median(controlDeltas.map((c) => c.clicks_pct));

  const liftPos = Math.round((pagePosDelta - ctrlPosDelta) * 100) / 100;
  const liftClicksPct = Math.round((pageClicksPct - ctrlClicksPct) * 100) / 100;
  const confidence = confidenceScore({ baselineImpressions: baselineImpr, windowImpressions: windowImpr, controlCount });

  let verdict;
  if (baselineImpr < MIN_IMPRESSIONS || windowImpr < MIN_IMPRESSIONS || controlCount < 1) {
    verdict = 'insufficient_data';
  } else if ((liftPos >= LIFT_POSITION_IMPROVED || liftClicksPct >= LIFT_CLICKS_IMPROVED_PCT) && confidence >= MIN_CONFIDENCE) {
    verdict = 'improved';
  } else if ((liftPos <= LIFT_POSITION_REGRESSED || liftClicksPct <= LIFT_CLICKS_REGRESSED_PCT) && confidence >= MIN_CONFIDENCE) {
    verdict = 'regressed';
  } else {
    verdict = 'neutral';
  }

  return { verdict, confidence, estimated_lift_position: liftPos, estimated_lift_clicks_pct: liftClicksPct };
}

// ── GSC aggregation ─────────────────────────────────────────────────

async function aggregatePageMetrics(database, pageUrl, startDate, endDate) {
  const row = await database('gsc_pages')
    .where('page_url', pageUrl)
    .andWhere('date', '>=', startDate)
    .andWhere('date', '<=', endDate)
    .first(
      database.raw('COALESCE(SUM(clicks),0)::int as clicks'),
      database.raw('COALESCE(SUM(impressions),0)::int as impressions'),
      database.raw('CASE WHEN SUM(impressions) > 0 THEN SUM(position*impressions)/SUM(impressions) ELSE NULL END as position'),
    );
  const clicks = Number(row?.clicks) || 0;
  const impressions = Number(row?.impressions) || 0;
  const position = row?.position == null ? null : Number(row.position);
  const ctr = impressions > 0 ? clicks / impressions : 0;
  return { clicks, impressions, position, ctr };
}

// ── control-page selection ──────────────────────────────────────────

/**
 * Pick up to 3 control pages: same service_category, different page_url, with
 * baseline impressions within 0.4x–2.5x of the optimized page, excluding pages
 * that already have an impact row (i.e. were themselves optimized).
 */
async function selectControlPages(database, { pageUrl, serviceCategory, cityTarget, baselineImpressions, startDate, endDate }) {
  let q = database('gsc_pages')
    .where('date', '>=', startDate)
    .andWhere('date', '<=', endDate)
    .andWhereNot('page_url', pageUrl)
    .groupBy('page_url')
    .select('page_url')
    .sum({ impressions: 'impressions' });
  if (serviceCategory) q = q.andWhere('service_category', serviceCategory);

  const rows = await q;
  const lo = baselineImpressions * 0.4;
  const hi = baselineImpressions * 2.5;

  const optimizedUrls = new Set(
    (await database('content_optimization_impact').select('page_url')).map((r) => r.page_url),
  );

  const candidates = rows
    .map((r) => ({ page_url: r.page_url, impressions: Number(r.impressions) || 0 }))
    .filter((r) => !optimizedUrls.has(r.page_url) && r.impressions >= lo && r.impressions <= hi)
    .sort((a, b) => Math.abs(a.impressions - baselineImpressions) - Math.abs(b.impressions - baselineImpressions))
    .slice(0, 3);

  return candidates.map((c) => c.page_url);
}

// ── baseline snapshot ───────────────────────────────────────────────

async function snapshotBaseline({ db: database = db, runId, pageUrl, deployedAt = new Date(), queryCohort = [], now = new Date() } = {}) {
  if (!pageUrl) throw new Error('impact-tracker.snapshotBaseline: pageUrl required');
  const endDate = etDateString(deployedAt);
  const startDate = etDateString(addETDays(deployedAt, -BASELINE_DAYS));
  const baseline = await aggregatePageMetrics(database, pageUrl, startDate, endDate);

  // Classify the page for control matching.
  const classRow = await database('gsc_pages').where('page_url', pageUrl).orderBy('date', 'desc')
    .first('service_category', 'city_target').catch(() => null);

  const controlUrls = await selectControlPages(database, {
    pageUrl,
    serviceCategory: classRow?.service_category || null,
    cityTarget: classRow?.city_target || null,
    baselineImpressions: baseline.impressions,
    startDate,
    endDate,
  }).catch((err) => { logger.warn(`[impact-tracker] control selection failed: ${err.message}`); return []; });

  const measurementStart = etDateString(addETDays(deployedAt, DEPLOY_LAG_DAYS));

  const ctx = runId ? await aeoContextForRun(database, runId) : { bucket: null, city: null, service: null };
  const bucket = ctx.bucket;
  // For aeo_gap rows, capture which managed mention queries to watch after the
  // deploy so the daily feedback check can tell if Waves started getting cited.
  const aeoQueryIds = bucket === 'aeo_gap'
    ? await aeoQueryIdsForCityService(database, ctx.city, ctx.service).catch(() => [])
    : null;

  const [row] = await database('content_optimization_impact')
    .insert({
      run_id: runId || null,
      page_url: pageUrl,
      bucket,
      aeo_query_ids: aeoQueryIds ? JSON.stringify(aeoQueryIds) : null,
      deployed_at: deployedAt,
      measurement_start: measurementStart,
      baseline_start_date: startDate,
      baseline_end_date: endDate,
      baseline_impressions: baseline.impressions,
      baseline_clicks: baseline.clicks,
      baseline_position: baseline.position,
      baseline_ctr: baseline.ctr,
      query_cohort: JSON.stringify(queryCohort || []),
      control_page_urls: controlUrls,
      control_selection_reason: JSON.stringify({ service_category: classRow?.service_category || null, count: controlUrls.length }),
      updated_at: now,
    })
    .onConflict('run_id').ignore()
    .returning('*');
  return row;
}

async function aeoContextForRun(database, runId) {
  try {
    const row = await database('autonomous_runs as r')
      .leftJoin('opportunity_queue as q', 'r.opportunity_id', 'q.id')
      .where('r.id', runId)
      .first('q.bucket as bucket', 'q.city as city', 'q.service as service');
    return { bucket: row?.bucket || null, city: row?.city || null, service: row?.service || null };
  } catch { return { bucket: null, city: null, service: null }; }
}

// Managed mention-query ids for an opportunity's city×service. The miner stores
// the normalized service ('pest'); the managed query stores the human label
// ('pest control'), so match by prefix (pest→'pest control', lawn→'lawn care',
// termite/mosquito/rodent are identical). City is already normalized on both.
async function aeoQueryIdsForCityService(database, city, service) {
  if (!city || !service) return [];
  const rows = await database('seo_llm_mention_queries')
    .where('active', true)
    .whereRaw('lower(city) = ?', [String(city).toLowerCase()])
    .whereRaw('lower(service) like ?', [`${String(service).toLowerCase()}%`])
    .select('id');
  return rows.map((r) => r.id);
}

// Find live runs with no impact row yet and snapshot their baseline.
async function sweepNewlyLive({ db: database = db, now = new Date() } = {}) {
  let created = 0;
  let rows = [];
  try {
    rows = await database('autonomous_runs as r')
      .leftJoin('content_optimization_impact as i', 'r.id', 'i.run_id')
      .leftJoin('content_briefs as b', 'r.brief_id', 'b.id')
      .leftJoin('opportunity_queue as q', 'r.opportunity_id', 'q.id')
      .whereNull('i.id')
      .where((builder) => {
        builder.whereNotNull('r.published_url').orWhereNotNull('r.astro_pr_url');
      })
      .select(
        'r.id as run_id',
        'r.published_url',
        'r.astro_pr_url',
        'r.completed_at',
        'b.target_url as brief_target_url',
        'q.page_url as opportunity_page_url',
        'r.draft_payload',
      );
  } catch (err) {
    logger.warn(`[impact-tracker] sweepNewlyLive query failed: ${err.message}`);
    return { created: 0, error: err.message };
  }
  for (const r of rows) {
    const prInfo = r.published_url ? null : await mergedPrInfo(r.astro_pr_url);
    if (!r.published_url && !prInfo?.merged) continue;
    const pageUrl = resolveRunPageUrl(r);
    if (!pageUrl) {
      logger.warn(`[impact-tracker] baseline snapshot skipped for run ${r.run_id}: page URL unresolved`);
      continue;
    }
    try {
      if (!r.published_url && prInfo?.merged) {
        await database('autonomous_runs')
          .where('id', r.run_id)
          .whereNull('published_url')
          .update({ published_url: pageUrl, completed_at: prInfo.merged_at || r.completed_at || now });
      }
      await snapshotBaseline({
        db: database,
        runId: r.run_id,
        pageUrl,
        deployedAt: prInfo?.merged_at || r.completed_at || now,
        now,
      });
      created += 1;
    } catch (err) {
      logger.warn(`[impact-tracker] baseline snapshot failed for ${pageUrl}: ${err.message}`);
    }
  }
  return { created, scanned: rows.length };
}

function parseAstroPrNumber(value) {
  const match = String(value || '').match(/\/pull\/(\d+)(?:\D|$)/);
  return match ? Number(match[1]) : null;
}

async function mergedPrInfo(astroPrUrl) {
  const prNumber = parseAstroPrNumber(astroPrUrl);
  if (!prNumber) return null;
  try {
    const pr = await GitHubClient.getPr(prNumber);
    if (!pr?.merged) return { merged: false };
    return {
      merged: true,
      merged_at: pr.merged_at ? new Date(pr.merged_at) : new Date(),
      merge_commit_sha: pr.merge_commit_sha || null,
    };
  } catch (err) {
    logger.warn(`[impact-tracker] Astro PR lookup failed for ${astroPrUrl}: ${err.message}`);
    return null;
  }
}

function resolveRunPageUrl(row = {}) {
  return row.published_url
    || row.brief_target_url
    || row.opportunity_page_url
    || draftPayloadUrl(row.draft_payload)
    || null;
}

function draftPayloadUrl(value) {
  if (!value) return null;
  try {
    const draft = typeof value === 'string' ? JSON.parse(value) : value;
    return draft?.url || draft?.page_url || draft?.canonical || null;
  } catch {
    return null;
  }
}

// ── measurement sweep ───────────────────────────────────────────────

async function measureWindow(database, impactRow, days) {
  const start = impactRow.measurement_start;
  const end = etDateString(addETDays(etDayAnchor(impactRow.measurement_start), days));
  const page = await aggregatePageMetrics(database, impactRow.page_url, start, end);

  const controlUrls = impactRow.control_page_urls || [];
  const baseStart = impactRow.baseline_start_date;
  const baseEnd = impactRow.baseline_end_date;
  const controlDeltas = [];
  for (const url of controlUrls) {
    const cBase = await aggregatePageMetrics(database, url, baseStart, baseEnd);
    const cWin = await aggregatePageMetrics(database, url, start, end);
    if (cBase.impressions < MIN_IMPRESSIONS) continue; // skip controls with no baseline
    controlDeltas.push({
      position_delta: positionDelta(cBase.position, cWin.position),
      clicks_pct: clicksPct(cBase.clicks, cWin.clicks),
    });
  }

  const baseline = {
    position: impactRow.baseline_position,
    clicks: impactRow.baseline_clicks,
    impressions: impactRow.baseline_impressions,
  };
  const verdict = computeVerdict({ baseline, window: page, controlDeltas });
  return { page, controlDeltas, verdict };
}

/**
 * checkPending — daily sweep. For each impact row whose measurement_start has
 * elapsed by 14d / 21d and not yet recorded, compute the window + verdict.
 * The 21d check confirms the 14d verdict (and is the final one persisted).
 */
async function checkPending({ db: database = db, now = new Date() } = {}) {
  const today = etDateString(now);
  let rows = [];
  try {
    rows = await database('content_optimization_impact')
      .whereNotNull('measurement_start')
      .where((b) => b.whereNull('checked_21d_at').orWhereNull('checked_14d_at'))
      .select('*');
  } catch (err) {
    logger.warn(`[impact-tracker] checkPending query failed: ${err.message}`);
    return { checked: 0, error: err.message };
  }

  let checked = 0;
  for (const row of rows) {
    const day14 = etDateString(addETDays(etDayAnchor(row.measurement_start), 14));
    const day21 = etDateString(addETDays(etDayAnchor(row.measurement_start), 21));
    const patch = { updated_at: now };

    if (!row.checked_14d_at && today >= day14) {
      const r = await measureWindow(database, row, 14);
      patch.metrics_14d = JSON.stringify(r.page);
      patch.control_delta_14d = JSON.stringify({ deltas: r.controlDeltas });
      patch.checked_14d_at = now;
      // 14d sets a provisional verdict.
      patch.verdict = r.verdict.verdict;
      patch.verdict_confidence = r.verdict.confidence;
      patch.estimated_lift_position = r.verdict.estimated_lift_position;
      patch.estimated_lift_clicks_pct = r.verdict.estimated_lift_clicks_pct;
    }
    if (!row.checked_21d_at && today >= day21) {
      const r = await measureWindow(database, row, 21);
      patch.metrics_21d = JSON.stringify(r.page);
      patch.control_delta_21d = JSON.stringify({ deltas: r.controlDeltas });
      patch.checked_21d_at = now;
      // 21d is the confirmed verdict.
      patch.verdict = r.verdict.verdict;
      patch.verdict_confidence = r.verdict.confidence;
      patch.estimated_lift_position = r.verdict.estimated_lift_position;
      patch.estimated_lift_clicks_pct = r.verdict.estimated_lift_clicks_pct;
    }

    if (Object.keys(patch).length > 1) {
      await database('content_optimization_impact').where('id', row.id).update(patch);
      checked += 1;
    }
  }

  const paused = await pausedBuckets({ db: database });
  if (paused.length) logger.warn(`[impact-tracker] buckets at/over regression threshold: ${paused.map((p) => `${p.bucket}(${p.regressions})`).join(', ')}`);
  return { checked, scanned: rows.length, paused_buckets: paused };
}

/**
 * Buckets with >= REGRESSION_PAUSE_THRESHOLD confirmed regressions. The runner
 * consults this to stop drafting an action type that keeps losing.
 */
async function pausedBuckets({ db: database = db } = {}) {
  try {
    // Only 21-day-confirmed regressions count toward the pause threshold.
    // checkPending() writes verdict='regressed' at the 14-day provisional
    // check too; counting those would let three unconfirmed 14-day dips pause
    // a bucket before the 21-day window has run (a provisional dip can recover
    // by day 21). Gate on checked_21d_at so the pause reflects confirmed loss.
    const rows = await database('content_optimization_impact')
      .where('verdict', 'regressed')
      .whereNotNull('bucket')
      .whereNotNull('checked_21d_at')
      .groupBy('bucket')
      .select('bucket')
      .count({ regressions: '*' });
    return rows
      .map((r) => ({ bucket: r.bucket, regressions: Number(r.regressions) || 0 }))
      .filter((r) => r.regressions >= REGRESSION_PAUSE_THRESHOLD);
  } catch (err) {
    logger.warn(`[impact-tracker] pausedBuckets failed: ${err.message}`);
    return [];
  }
}

/**
 * AEO visibility feedback loop. For aeo_gap rows that deployed ≥ AEO_REPROBE_DAYS
 * ago and haven't been checked, look at the answer-engine observations the daily
 * prober has recorded for the watched queries SINCE the deploy, and record
 * whether Waves started getting cited. Reuses existing seo_llm_mentions data —
 * fires no new probes.
 */
async function checkAeoVisibility({ db: database = db, now = new Date() } = {}) {
  let checked = 0;
  let pending = [];
  try {
    pending = await database('content_optimization_impact')
      .where('bucket', 'aeo_gap')
      .whereNull('aeo_checked_at')
      .where('deployed_at', '<=', addETDays(now, -AEO_REPROBE_DAYS))
      .select('id', 'aeo_query_ids', 'deployed_at');
  } catch (err) {
    logger.warn(`[impact-tracker] checkAeoVisibility query failed: ${err.message}`);
    return { checked: 0 };
  }

  for (const row of pending) {
    try {
      let ids = [];
      try { ids = Array.isArray(row.aeo_query_ids) ? row.aeo_query_ids : JSON.parse(row.aeo_query_ids || '[]'); } catch { ids = []; }

      let observedDays = 0;
      let wavesHitDays = 0;
      if (ids.length) {
        const obs = await database('seo_llm_mentions')
          .whereIn('query_id', ids)
          .where('check_date', '>=', etDateString(row.deployed_at))
          .select('check_date', 'waves_mentioned');
        const days = new Map(); // date → any waves hit that day
        for (const o of obs) {
          const d = String(o.check_date).slice(0, 10);
          days.set(d, (days.get(d) || false) || !!o.waves_mentioned);
        }
        observedDays = days.size;
        wavesHitDays = Array.from(days.values()).filter(Boolean).length;
      }

      const { verdict, nowCited } = aeoVerdict({ observedDays, wavesHitDays });
      await database('content_optimization_impact')
        .where('id', row.id)
        .update({ aeo_checked_at: now, aeo_now_cited: nowCited, aeo_verdict: verdict, updated_at: now });
      checked++;
    } catch (err) {
      logger.warn(`[impact-tracker] checkAeoVisibility row ${row.id} failed: ${err.message}`);
    }
  }
  if (checked) logger.info(`[impact-tracker] AEO visibility: checked ${checked} aeo_gap row(s)`);
  return { checked };
}

module.exports = {
  computeVerdict,
  snapshotBaseline,
  checkAeoVisibility,
  sweepNewlyLive,
  checkPending,
  pausedBuckets,
  // exposed for tests / reuse
  aggregatePageMetrics,
  selectControlPages,
  _internals: { median, clicksPct, positionDelta, confidenceScore, etDayAnchor, parseAstroPrNumber, resolveRunPageUrl, aeoVerdict },
  THRESHOLDS: {
    BASELINE_DAYS, DEPLOY_LAG_DAYS, MIN_IMPRESSIONS, MIN_CONFIDENCE,
    LIFT_POSITION_IMPROVED, LIFT_CLICKS_IMPROVED_PCT,
    LIFT_POSITION_REGRESSED, LIFT_CLICKS_REGRESSED_PCT, REGRESSION_PAUSE_THRESHOLD,
  },
};
