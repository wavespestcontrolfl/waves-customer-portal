#!/usr/bin/env node
/**
 * Calibration replay for the lawn progress engine (lawn report rebuild P13).
 *
 * Runs server/services/service-report/lawn-progress.js over every confirmed
 * lawn assessment that has an earlier confirmed assessment at the same customer
 * and property, and prints the distribution of states plus anything odd. W5's
 * sign-off rule: if "behind" is more than about a quarter of the judged items,
 * the calibration needs another look before the engine's words reach a
 * customer. The band sweep shows what each band would have said. Widening is
 * NOT a fix by itself: in gain mode a wider band demands a bigger gain, so it
 * turns more items behind, not fewer (10-02 prod replay: 22% at 8, 71% at 12).
 *
 * Read only. The query runs in a READ ONLY transaction on a connection this
 * script builds itself (never models/db.js), exactly like
 * audit-lawn-expectation-products.js. Output names no customer: assessments
 * are shown by the first 8 characters of their id.
 *
 * Caveat: visits before GATE_LAWN_VISIT_MEMORY have no frozen memory, so the
 * "applied" list of the prior visit is read live from its service_products
 * (the report path refuses that fallback on purpose; the replay needs it to
 * have anything to judge). No visit has a same-spot recheck yet (P19
 * paired-photo read / office review), so checks are not replayed.
 *
 * Usage:
 *   node server/scripts/replay-lawn-progress.js --database-url postgres://...
 *   node server/scripts/replay-lawn-progress.js --since-days 90 --json
 *   node server/scripts/replay-lawn-progress.js --band 10 --overall-band 5
 *   node server/scripts/replay-lawn-progress.js --fixture assessments.json   (no database)
 *   (falls back to DATABASE_URL)
 */

const fs = require('fs');
const {
  buildLawnProgress, deriveAssessmentConfidence, scoresFromAssessmentRow, STATES, CATEGORY_BAND, OVERALL_BAND,
} = require('../services/service-report/lawn-progress');
const { selectPriorVisit } = require('../services/service-report/lawn-visit-memory');
const { createAuditKnex } = require('./audit-lawn-expectation-products');

const BEHIND_WARN_SHARE = 0.25; // W5: re-check calibration above about 25 percent
const BAND_SWEEP = [4, 6, 8, 10, 12];
const SHORT_GAP_DAYS = 5;
const LONG_GAP_DAYS = 120;
const SWING_POINTS = 30;
const TOP_PHOTOS = 5; // the report reads the five best visible photos

const short = (id) => String(id || '').slice(0, 8);
const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : 0);
const bump = (map, key, by = 1) => { map[key] = (map[key] || 0) + by; };

/**
 * Replay rows: one per confirmed assessment, in the shape this script's loader
 * and --fixture share.
 * @typedef {object} ReplayRow
 * @property {string} id
 * @property {string} customerId
 * @property {string|null} [propertyId]
 * @property {string} date  YYYY-MM-DD
 * @property {string|null} [season]
 * @property {boolean} [isBaseline]
 * @property {{turf_density,weed_suppression,color_health,stress_damage,overall}} scores
 * @property {Array<number|string>} [photos]  quality per visible photo
 * @property {Array<{metric:string}>} [divergenceFlags]
 * @property {Array<{name:string,targets?:string[]}>} [applied]
 * @property {string} [order]  tie-break within one day (confirmation time)
 * @property {string|null} [priorId]  canonical prior (lawn-assessment-history), set by the DB loader
 * @property {boolean} [superseded]  a re-done attempt of a visit whose installed row is another assessment
 */

/**
 * Each row's prior. The DB loader resolves it through the report's canonical
 * history (lawn-assessment-history: appointment dates, one installed attempt
 * per visit, baseline resets) and sets priorId / superseded on every row; then
 * superseded attempts are not judged and the prior is exactly that row.
 * Rows with no priorId key (hand-written fixtures) fall back to the latest
 * EARLIER-dated row of the same customer and property.
 */
function pairAssessments(rows) {
  if (rows.some((row) => Object.prototype.hasOwnProperty.call(row, 'priorId'))) {
    const byId = new Map(rows.map((row) => [String(row.id), row]));
    return rows
      .filter((row) => !row.superseded)
      .map((row) => ({ current: row, prior: row.priorId != null ? byId.get(String(row.priorId)) || null : null }))
      .sort((a, b) => String(a.current.date).localeCompare(String(b.current.date)) || String(a.current.id).localeCompare(String(b.current.id)));
  }
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.customerId}|${row.propertyId || ''}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const pairs = [];
  for (const list of groups.values()) {
    list.sort((a, b) => String(a.date).localeCompare(String(b.date))
      || String(a.order || '').localeCompare(String(b.order || '')) || String(a.id).localeCompare(String(b.id)));
    list.forEach((row, i) => {
      let prior = null;
      for (let j = i - 1; j >= 0; j -= 1) {
        if (list[j].date < row.date) { prior = list[j]; break; }
      }
      pairs.push({ current: row, prior });
    });
  }
  return pairs.sort((a, b) => String(a.current.date).localeCompare(String(b.current.date)) || String(a.current.id).localeCompare(String(b.current.id)));
}

function sideOf(row) {
  return {
    date: row.date,
    season: row.season || null,
    isBaseline: Boolean(row.isBaseline),
    scores: row.scores,
    confidence: deriveAssessmentConfidence({
      photos: Array.isArray(row.photos) ? row.photos : null,
      divergenceFlags: row.divergenceFlags,
    }),
  };
}

function progressFor({ current, prior }, { band, overallBand }) {
  const cur = sideOf(current);
  const pri = prior ? sideOf(prior) : null;
  // The report path only has the CURRENT confidence (no extra read for the prior's photos).
  if (pri) delete pri.confidence;
  return buildLawnProgress({
    current: cur,
    prior: pri,
    sinceLast: prior ? { priorDate: prior.date, applied: prior.applied || [], checks: [] } : null,
    band,
    overallBand,
  });
}

function behindStats(results) {
  const states = {};
  for (const { progress } of results) {
    for (const item of progress.items) bump(states, item.state);
  }
  const judged = (states.improving || 0) + (states.on_track || 0) + (states.behind || 0);
  return { states, judged, behind: states.behind || 0, behindShare: judged ? (states.behind || 0) / judged : 0 };
}

/**
 * Pure: replay rows in, the full report out.
 * @param {ReplayRow[]} rows
 * @param {{band?:number, overallBand?:number, since?:string|null}} [opts]
 */
function replayLawnProgress(rows, { band = CATEGORY_BAND, overallBand = OVERALL_BAND, since = null } = {}) {
  // `since` (YYYY-MM-DD) limits which visits are judged; earlier rows still serve as priors.
  const pairs = pairAssessments(Array.isArray(rows) ? rows : []).filter((p) => !since || p.current.date >= since);
  const results = pairs.map((pair) => ({ ...pair, progress: progressFor(pair, { band, overallBand }) }));

  const eligible = results.filter((r) => r.progress.eligible);
  const summary = {
    band,
    overallBand,
    assessments: results.length,
    noPrior: results.filter((r) => r.progress.reason === 'no_prior').length,
    baseline: results.filter((r) => r.progress.reason === 'baseline').length,
    pairs: eligible.length,
    confidence: {},
    overall: {},
    itemStates: Object.fromEntries(STATES.map((s) => [s, 0])),
    byRowMetric: {},
    gates: {},
    judgedItems: 0,
    behindShare: 0,
    behindPairs: 0,
    pairsWithItems: 0,
    behindAboveLine: false,
  };

  for (const r of eligible) {
    bump(summary.confidence, r.progress.confidence.level);
    bump(summary.overall, r.progress.overall.direction);
    if (r.progress.items.length) summary.pairsWithItems += 1;
    if (r.progress.items.some((i) => i.state === 'behind')) summary.behindPairs += 1;
    for (const item of r.progress.items) {
      summary.itemStates[item.state] += 1;
      const key = item.kind === 'applied' ? `${item.rowId}:${item.metric}` : `check:${item.key}`;
      summary.byRowMetric[key] = summary.byRowMetric[key] || Object.fromEntries(STATES.map((s) => [s, 0]));
      summary.byRowMetric[key][item.state] += 1;
      if (item.gate) bump(summary.gates, item.gate);
    }
  }
  const stats = behindStats(eligible);
  summary.judgedItems = stats.judged;
  summary.behindShare = Math.round(stats.behindShare * 1000) / 1000;
  summary.behindAboveLine = stats.behindShare > BEHIND_WARN_SHARE;

  const bandSweep = BAND_SWEEP.map((b) => {
    const swept = pairs.map((pair) => ({ ...pair, progress: progressFor(pair, { band: b, overallBand }) })).filter((r) => r.progress.eligible);
    const s = behindStats(swept);
    return { band: b, judgedItems: s.judged, behind: s.behind, behindShare: Math.round(s.behindShare * 1000) / 1000 };
  });

  // ── Oddities: things a person should look at before sign-off ──────────────
  const oddities = {
    invariantViolations: [],
    shortGap: [],
    longGap: [],
    confidenceUnknown: [],
    scoreSwing: [],
    mixedSignals: [],
    noMappedProducts: [],
    unmappedProducts: {},
  };
  for (const r of eligible) {
    const p = r.progress;
    const ref = { assessment: short(r.current.id), prior: short(r.prior.id), date: r.current.date, days: p.daysSincePrior };
    for (const item of p.items) {
      const lowConfidence = !p.confidence.comparable || (item.kind === 'applied' && p.confidence.divergentMetrics.includes(item.metric));
      if (item.kind === 'applied' && lowConfidence && item.state !== 'unclear') {
        oddities.invariantViolations.push({ ...ref, rule: 'low_confidence_not_unclear', item: `${item.rowId}:${item.metric}`, state: item.state });
      }
      if (item.kind === 'applied' && item.metric === 'color_health' && p.season.seasonChange && !['unclear', 'seasonal'].includes(item.state)) {
        oddities.invariantViolations.push({ ...ref, rule: 'cross_season_color_not_seasonal', item: item.rowId, state: item.state });
      }
      if (item.state === 'behind' && item.rawVerdict !== 'behind' && item.kind === 'applied') {
        oddities.invariantViolations.push({ ...ref, rule: 'behind_without_verdict', item: `${item.rowId}:${item.metric}`, state: item.state });
      }
    }
    if (p.daysSincePrior < SHORT_GAP_DAYS) oddities.shortGap.push(ref);
    if (p.daysSincePrior > LONG_GAP_DAYS) oddities.longGap.push(ref);
    if (p.confidence.level === 'unknown') oddities.confidenceUnknown.push(ref);
    const swings = Object.entries(p.deltas).filter(([m, d]) => m !== 'overall' && d != null && Math.abs(d) >= SWING_POINTS);
    if (swings.length) oddities.scoreSwing.push({ ...ref, metrics: Object.fromEntries(swings) });
    if (p.overall.direction === 'up' && p.items.some((i) => i.state === 'behind')) oddities.mixedSignals.push({ ...ref, note: 'overall up, an item behind' });
    if (p.overall.direction === 'down' && p.items.some((i) => i.state === 'improving')) oddities.mixedSignals.push({ ...ref, note: 'overall down, an item improving' });
    if (!p.items.length) oddities.noMappedProducts.push(ref);
    for (const name of p.unmapped) bump(oddities.unmappedProducts, name);
  }

  return {
    summary,
    bandSweep,
    oddities,
    pairs: eligible.map((r) => ({
      assessment: short(r.current.id),
      prior: short(r.prior.id),
      date: r.current.date,
      days: r.progress.daysSincePrior,
      confidence: r.progress.confidence.level,
      overall: r.progress.overall.direction,
      items: r.progress.items.map((i) => (i.kind === 'applied'
        ? { item: `${i.rowId}:${i.metric}`, state: i.state, delta: i.basis.scoreDelta }
        : { item: `check:${i.key}`, state: i.state })),
    })),
  };
}

function formatReport(result) {
  const { summary: s, bandSweep, oddities: o } = result;
  const lines = [];
  lines.push(`Lawn progress replay (band ${s.band} per category, ${s.overallBand} overall)`);
  lines.push(`Assessments ${s.assessments}: first visits ${s.noPrior}, baseline ${s.baseline}, compared pairs ${s.pairs} (${s.pairsWithItems} with a judged item)`);
  lines.push(`Confidence: ${Object.entries(s.confidence).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}`);
  lines.push(`Overall direction: ${Object.entries(s.overall).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}`);
  const total = Object.values(s.itemStates).reduce((a, b) => a + b, 0);
  lines.push(`Item states (${total} items):`);
  for (const state of STATES) lines.push(`  ${state.padEnd(15)} ${String(s.itemStates[state]).padStart(4)}  ${pct(s.itemStates[state], total)}%`);
  lines.push(`Behind: ${(s.behindShare * 100).toFixed(1)}% of ${s.judgedItems} judged items (improving + on_track + behind); ${s.behindPairs} pairs have a behind item`);
  if (s.behindAboveLine) lines.push(`WARNING: behind is above ${BEHIND_WARN_SHARE * 100}% of judged items. Review the band sweep and the per-row counts before sign-off; a wider band makes gain-mode rows MORE likely to be behind.`);
  lines.push('Gates that fired: ' + (Object.entries(s.gates).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'));
  lines.push('By row and metric:');
  for (const [key, counts] of Object.entries(s.byRowMetric)) {
    lines.push(`  ${key.padEnd(40)} ${STATES.filter((st) => counts[st]).map((st) => `${st} ${counts[st]}`).join(', ')}`);
  }
  lines.push('Band sweep (behind share of judged items):');
  for (const b of bandSweep) lines.push(`  band ${String(b.band).padStart(2)}  behind ${String(b.behind).padStart(3)} of ${String(b.judgedItems).padStart(3)}  ${(b.behindShare * 100).toFixed(1)}%`);
  lines.push('Oddities:');
  lines.push(`  invariant violations ${o.invariantViolations.length}${o.invariantViolations.length ? ' (BUG, fix before anything else)' : ''}`);
  for (const v of o.invariantViolations) lines.push(`    ${v.assessment} ${v.rule} ${v.item} ${v.state}`);
  lines.push(`  confidence unknown (no photo evidence) ${o.confidenceUnknown.length}`);
  lines.push(`  gap under ${SHORT_GAP_DAYS} days ${o.shortGap.length}, over ${LONG_GAP_DAYS} days ${o.longGap.length}`);
  lines.push(`  category swing of ${SWING_POINTS}+ points ${o.scoreSwing.length}`);
  for (const v of o.scoreSwing) lines.push(`    ${v.assessment} ${v.date} ${JSON.stringify(v.metrics)}`);
  lines.push(`  mixed signals ${o.mixedSignals.length}`);
  for (const v of o.mixedSignals) lines.push(`    ${v.assessment} ${v.date} ${v.note}`);
  lines.push(`  pairs with no mapped product to judge ${o.noMappedProducts.length}`);
  const unmapped = Object.entries(o.unmappedProducts);
  lines.push(`  unmapped product names ${unmapped.length}${unmapped.length ? ': ' + unmapped.map(([n, c]) => `${n} (${c})`).join('; ') : ''}`);
  return lines.join('\n');
}

// ── Database loader (read only) ───────────────────────────────────────────
/**
 * Every confirmed lawn assessment with the inputs the engine reads. One READ
 * ONLY transaction. The window is applied by replayLawnProgress, so a visit
 * inside it still finds its prior from before it.
 * @returns {Promise<ReplayRow[]>}
 */
async function loadReplayRows(db) {
  return db.transaction(async (trx) => {
    await trx.raw('SET TRANSACTION READ ONLY');
    const { rows: assessments } = await trx.raw(
      `SELECT la.id, la.customer_id, la.property_id, to_char(la.service_date, 'YYYY-MM-DD') AS date,
              la.season, la.is_baseline, la.service_record_id, la.divergence_flags,
              la.turf_density, la.weed_suppression, la.color_health, la.fungus_control,
              la.thatch_level, la.stress_damage, la.overall_score,
              to_char(la.confirmed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') AS confirmed_order
         FROM lawn_assessments la
        WHERE la.confirmed_by_tech = true
        ORDER BY la.customer_id, la.service_date, la.confirmed_at, la.id`,
    );
    const ids = assessments.map((a) => a.id);
    const recordIds = assessments.map((a) => a.service_record_id).filter(Boolean);

    const photoRows = ids.length ? (await trx.raw(
      `SELECT assessment_id, quality_score
         FROM lawn_assessment_photos
        WHERE assessment_id = ANY(?::uuid[]) AND customer_visible IS NOT FALSE
        ORDER BY assessment_id, is_best_photo DESC NULLS LAST, quality_score DESC NULLS LAST, photo_order ASC NULLS LAST`,
      [ids],
    )).rows : [];
    const productRows = recordIds.length ? (await trx.raw(
      `SELECT service_record_id, product_name, targets
         FROM service_products
        WHERE service_record_id = ANY(?::uuid[]) AND NULLIF(TRIM(product_name), '') IS NOT NULL
        ORDER BY service_record_id, created_at`,
      [recordIds],
    )).rows : [];

    const photosBy = new Map();
    for (const p of photoRows) {
      const list = photosBy.get(p.assessment_id) || [];
      if (list.length < TOP_PHOTOS) list.push(p.quality_score == null ? null : Number(p.quality_score));
      photosBy.set(p.assessment_id, list);
    }
    const productsBy = new Map();
    for (const p of productRows) {
      const list = productsBy.get(p.service_record_id) || [];
      list.push({ name: p.product_name, targets: Array.isArray(p.targets) ? p.targets : [] });
      productsBy.set(p.service_record_id, list);
    }

    // Canonical history, the same resolver the report uses, through THIS
    // read-only transaction (required lazily so loading the script never
    // loads models/db.js; every call passes knex: trx, so it is never queried).
     
    const { historyForAssessment } = require('../services/lawn-assessment-history');
    const canonicalBy = new Map();
    for (const a of assessments) {
      const h = await historyForAssessment({ id: a.id, customer_id: a.customer_id }, { knex: trx });
      const installed = h.current && String(h.current.id) === String(a.id);
      // The prior exactly as the report picks it: history rows dated by their
      // visit (report-data resolveLawnAssessmentAndHistory), then
      // selectPriorVisit (strictly earlier day, has a service record).
      const historyRows = (h.rows || []).map((row) => ({ ...row, service_date: row.visit_date }));
      const priorVisit = installed ? selectPriorVisit(historyRows, a.id) : null;
      canonicalBy.set(a.id, {
        superseded: !installed,
        priorId: priorVisit ? priorVisit.assessmentId : null,
        isBaseline: installed ? h.isBaseline : false,
        date: installed && h.current.visit_date ? h.current.visit_date : a.date,
      });
    }

    return assessments
      .map((a) => {
        const canonical = canonicalBy.get(a.id);
        let flags = a.divergence_flags;
        if (typeof flags === 'string') { try { flags = JSON.parse(flags); } catch { flags = []; } }
        return {
          id: a.id,
          customerId: a.customer_id,
          propertyId: a.property_id || null,
          date: canonical.date,
          season: a.season || null,
          isBaseline: canonical.isBaseline,
          priorId: canonical.priorId,
          superseded: canonical.superseded,
          scores: scoresFromAssessmentRow(a),
          photos: photosBy.get(a.id) || [],
          divergenceFlags: Array.isArray(flags) ? flags : [],
          applied: a.service_record_id ? (productsBy.get(a.service_record_id) || []) : [],
          order: a.confirmed_order || '',
        };
      });
  }, { readOnly: true });
}

function argValue(argv, flag) {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : null;
}

function numberArg(argv, flag, fallback) {
  const n = Number(argValue(argv, flag));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

async function main(argv = process.argv.slice(2), env = process.env) {
  const json = argv.includes('--json');
  const fixture = argValue(argv, '--fixture');
  const sinceDays = numberArg(argv, '--since-days', null);
  const band = numberArg(argv, '--band', CATEGORY_BAND);
  const overallBand = numberArg(argv, '--overall-band', OVERALL_BAND);
  const databaseUrl = argValue(argv, '--database-url') || env.DATABASE_URL;

  let db = null;
  try {
    let rows;
    if (fixture) {
      const parsed = JSON.parse(fs.readFileSync(fixture, 'utf8'));
      rows = Array.isArray(parsed) ? parsed : parsed.assessments || [];
    } else {
      db = createAuditKnex(databaseUrl);
      rows = await loadReplayRows(db);
    }
    // The cutoff is a calendar day, so it takes the clock only here at the edge.
    const since = sinceDays ? new Date(Date.now() - sinceDays * 86400000).toISOString().slice(0, 10) : null;
    const result = replayLawnProgress(rows, { band, overallBand, since });
    console.log(json ? JSON.stringify(result, null, 2) : formatReport(result));
    if (result.oddities.invariantViolations.length) process.exitCode = 1;
  } finally {
    if (db) await db.destroy();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exitCode = 1;
  });
}

module.exports = {
  pairAssessments,
  replayLawnProgress,
  formatReport,
  loadReplayRows,
  main,
  BEHIND_WARN_SHARE,
};
