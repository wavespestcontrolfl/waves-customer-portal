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
 *   3. pausedBuckets — a bucket with 3+ regressions is surfaced so the runner
 *      can stop drafting that action type until reviewed.
 *
 * computeVerdict is a pure function (fully testable, no I/O). Everything else
 * reads gsc_pages / autonomous_runs and writes content_optimization_impact.
 */

const db = require('../../models/db');
const logger = require('../logger');
const { etDateString, addETDays } = require('../../utils/datetime-et');

const BASELINE_DAYS = 28;
const DEPLOY_LAG_DAYS = 3;
const MIN_IMPRESSIONS = 30;        // below this → insufficient_data
const MIN_CONFIDENCE = 0.70;       // below this → neutral even if lift is large
const LIFT_POSITION_IMPROVED = 2;  // moved up >=2 spots vs control
const LIFT_CLICKS_IMPROVED_PCT = 20;
const LIFT_POSITION_REGRESSED = -3;
const LIFT_CLICKS_REGRESSED_PCT = -25;
const REGRESSION_PAUSE_THRESHOLD = 3;

// ── pure verdict core ───────────────────────────────────────────────

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

  const bucket = runId ? await bucketForRun(database, runId) : null;

  const [row] = await database('content_optimization_impact')
    .insert({
      run_id: runId || null,
      page_url: pageUrl,
      bucket,
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

async function bucketForRun(database, runId) {
  try {
    const row = await database('autonomous_runs as r')
      .leftJoin('opportunity_queue as q', 'r.opportunity_id', 'q.id')
      .where('r.id', runId)
      .first('q.bucket as bucket');
    return row?.bucket || null;
  } catch { return null; }
}

// Find live runs with no impact row yet and snapshot their baseline.
async function sweepNewlyLive({ db: database = db, now = new Date() } = {}) {
  let created = 0;
  let rows = [];
  try {
    rows = await database('autonomous_runs as r')
      .leftJoin('content_optimization_impact as i', 'r.id', 'i.run_id')
      .whereNotNull('r.published_url')
      .whereNull('i.id')
      .select('r.id as run_id', 'r.published_url as page_url', 'r.completed_at');
  } catch (err) {
    logger.warn(`[impact-tracker] sweepNewlyLive query failed: ${err.message}`);
    return { created: 0, error: err.message };
  }
  for (const r of rows) {
    try {
      await snapshotBaseline({ db: database, runId: r.run_id, pageUrl: r.page_url, deployedAt: r.completed_at || now, now });
      created += 1;
    } catch (err) {
      logger.warn(`[impact-tracker] baseline snapshot failed for ${r.page_url}: ${err.message}`);
    }
  }
  return { created, scanned: rows.length };
}

// ── measurement sweep ───────────────────────────────────────────────

async function measureWindow(database, impactRow, days) {
  const start = impactRow.measurement_start;
  const end = etDateString(addETDays(new Date(impactRow.measurement_start), days));
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
    const day14 = etDateString(addETDays(new Date(row.measurement_start), 14));
    const day21 = etDateString(addETDays(new Date(row.measurement_start), 21));
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
    const rows = await database('content_optimization_impact')
      .where('verdict', 'regressed')
      .whereNotNull('bucket')
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

module.exports = {
  computeVerdict,
  snapshotBaseline,
  sweepNewlyLive,
  checkPending,
  pausedBuckets,
  // exposed for tests / reuse
  aggregatePageMetrics,
  selectControlPages,
  _internals: { median, clicksPct, positionDelta, confidenceScore },
  THRESHOLDS: {
    BASELINE_DAYS, DEPLOY_LAG_DAYS, MIN_IMPRESSIONS, MIN_CONFIDENCE,
    LIFT_POSITION_IMPROVED, LIFT_CLICKS_IMPROVED_PCT,
    LIFT_POSITION_REGRESSED, LIFT_CLICKS_REGRESSED_PCT, REGRESSION_PAUSE_THRESHOLD,
  },
};
