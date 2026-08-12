'use strict';

/**
 * Unified customer-facing Property Score.
 *
 * Aggregates the EXISTING per-domain engines — nothing here computes a new
 * judgment about a property:
 *   - Lawn: latest tech-confirmed `lawn_assessments` row via the same
 *     `lawnOverall()` math the Lawn Health surface displays.
 *   - Pest: the pest-pressure engine's stored score (0–5, lower is better),
 *     shown in its native scale; for the composite it is linearly rescaled
 *     (0→100, 5→0) — a unit change, not a new score. All customer-visibility
 *     gates of `buildPestPressureCustomerView` are honored.
 *   - Termite / Mosquito: protection PRESENCE only (bond, stations, program)
 *     — never folded into the composite number as an invented value.
 *   - Trees & Shrubs: latest tech-confirmed `tree_shrub_assessments`
 *     overall (already 0–100).
 *   - Irrigation: latest `lawn_water_intake_snapshots` status — surfaced as
 *     a status chip with the snapshot's own interpretation, never a number.
 *
 * The composite `overall` is the plain mean of the CONDITION components that
 * actually have a score (lawn, pest, tree & shrub) — equal weights, no
 * invented weighting. `delta` compares only components that have BOTH a
 * current and a previous value, so movement always reflects real data.
 *
 * Every reader fails soft: a broken domain query degrades that component to
 * `not_monitored`/`pending` rather than breaking the endpoint.
 */

const db = require('../models/db');
const { lawnOverall } = require('./lawn-health-shared');
const {
  loadActiveConfig,
  loadHistoryForCustomer,
  loadScoreForServiceRecord,
} = require('./pest-pressure/store');
const { buildPestPressureCustomerView } = require('./pest-pressure/customer-view');
const { isOneTimePressureExcludedRecord } = require('./pest-pressure/one-time-exclusion');
const { loadOwnedRecurringServiceKeys } = require('./waveguard-existing-services');
// Best-effort: the tree/shrub module also carries vision plumbing — a load
// failure degrades that component to raw overall_score, never the endpoint.
let formatAssessmentScores = null;
try { ({ formatAssessmentScores } = require('./tree-shrub-assessment')); } catch { formatAssessmentScores = null; }
const { getAreaRainfall } = require('./lawn-water-area');
const { dateOnlyString } = require('../utils/date-only');
// ET calendar discipline: elapsed-millisecond day math drifts across DST
// seams, so windows come from the shared ET helpers.
const { etDateString, addETDays } = require('../utils/datetime-et');

function roundOrNull(value) {
  return value == null || !Number.isFinite(Number(value)) ? null : Math.round(Number(value));
}

// Pest pressure (0–5, lower is better) → 0–100 health orientation for the
// composite. Pure linear rescale of the engine's own output.
function pressureToHealth(pressure) {
  if (pressure == null || !Number.isFinite(Number(pressure))) return null;
  const clamped = Math.max(0, Math.min(5, Number(pressure)));
  return Math.round(((5 - clamped) / 5) * 100);
}

function movementReason(delta) {
  if (delta == null) return null;
  if (delta > 0) return `Up ${delta} point${delta === 1 ? '' : 's'} since your last assessment.`;
  if (delta < 0) return `Down ${Math.abs(delta)} point${delta === -1 ? '' : 's'} since your last assessment.`;
  return 'Holding steady since your last assessment.';
}

// Active recurring coverage — the canonical OWNERSHIP mechanism end to
// end: loadOwnedRecurringServiceKeys applies the WaveGuard lane's full
// lifecycle evidence (past phantoms, callbacks, one-time booking sources
// excluded; live in-progress rows honored) and catalog-authoritative
// family classification. Loaded ONCE per request in buildPropertyScore
// and shared across every component check. A throw (catalog join failure
// fails closed there) degrades to "no programs claimed".
const OWNERSHIP_KEY_TO_LINE = {
  pest_control: 'pest',
  lawn_care: 'lawn',
  tree_shrub: 'tree_shrub',
  mosquito: 'mosquito',
  termite_bait: 'termite',
  // foam_recurring rows classify as termite_foam in the ownership
  // vocabulary (distinct from termite_bait so foam never suppresses a
  // bait-station quote) — for the score card both mean termite protection.
  termite_foam: 'termite',
};
async function loadActiveLineSet(customerId, knex) {
  const keys = await loadOwnedRecurringServiceKeys(knex, customerId).catch(() => []);
  const lines = new Set();
  for (const key of keys) {
    const line = OWNERSHIP_KEY_TO_LINE[key];
    if (line) lines.add(line);
  }
  return lines;
}

async function lawnComponent(customerId, knex, activeLines) {
  const base = { key: 'lawn', label: 'Lawn' };
  // created_at tie-break: same-day confirmed assessments are allowed and
  // UUID ids carry no chronology.
  const rows = await knex('lawn_assessments')
    .where({ customer_id: customerId, confirmed_by_tech: true })
    .orderBy('service_date', 'desc')
    .orderBy('created_at', 'desc')
    .limit(2)
    .catch(() => []);
  if (rows.length) {
    const score = roundOrNull(lawnOverall(rows[0]));
    const previousScore = rows[1] ? roundOrNull(lawnOverall(rows[1])) : null;
    const delta = score != null && previousScore != null ? score - previousScore : null;
    return {
      ...base,
      status: 'scored',
      score,
      previousScore,
      delta,
      reason: movementReason(delta),
      asOf: dateOnlyString(rows[0].service_date),
    };
  }
  // Pending only on ACTIVE recurring lawn coverage — hasCustomerLawnCare
  // treats any waveguard_tier as lawn evidence, which promises pest-only
  // WaveGuard customers a lawn score that will never come.
  const monitored = activeLines.has('lawn');
  if (monitored) {
    return { ...base, status: 'pending', reason: 'Your lawn score appears after the first confirmed lawn assessment.' };
  }
  return { ...base, status: 'not_monitored', reason: 'No lawn care program on this property.' };
}

async function pestComponent(customerId, knex, activeLines) {
  const base = { key: 'pest', label: 'Pest Pressure' };
  const config = await loadActiveConfig(knex).catch(() => null);
  // serviceLine-scoped: mosquito is a separate component — a mosquito visit's
  // score must never stand in for Pest Pressure.
  const history = await loadHistoryForCustomer(knex, customerId, { serviceLine: 'pest', limit: 6 }).catch(() => []);
  // Walk newest → oldest: a newest row the customer must not see (one-time
  // visit, opted-out service line) skips to the next VISIBLE score instead of
  // hiding an older valid one. A visible-but-insufficient view stops the walk
  // — surfacing an older score behind a newer insufficient one would be stale.
  const historyRows = Array.isArray(history) ? history : [];
  // One row → the full customer-visibility path (stored score row, service
  // record, catalog one-time exclusion, buildPestPressureCustomerView).
  // Used for the current AND the previous point, so hidden rows can never
  // leak into either end of the delta.
  const viewFor = async (rowRef) => {
    if (!rowRef || !rowRef.service_record_id) return null;
    const fullRow = await loadScoreForServiceRecord(knex, rowRef.service_record_id).catch(() => null);
    const serviceRecord = await knex('service_records')
      .where({ id: rowRef.service_record_id })
      .first()
      .catch(() => null);
    // Catalog-resolved one-time exclusion — the view's label heuristic misses
    // one-time services whose names carry no cadence word (Fire Ant, Tick
    // Control…); the report paths pass this too. Fail toward showing nothing.
    const oneTimeExcluded = serviceRecord
      ? await isOneTimePressureExcludedRecord(serviceRecord, knex).catch(() => true)
      : false;
    return buildPestPressureCustomerView({
      config,
      scoreRow: fullRow || rowRef,
      serviceRecord,
      historyRows: history,
      oneTimeExcluded,
    });
  };
  for (let i = 0; i < historyRows.length; i += 1) {
    const view = await viewFor(historyRows[i]);
    if (!view) continue;
    if (view.score != null) {
      const score = pressureToHealth(view.score);
      // Previous point: the next OLDER row that passes the same visibility
      // path and carries a displayed score — the same basis as the current
      // value. (trend_delta reconstruction breaks after a manual override;
      // raw displayed_score would leak rows the customer can't see.)
      let previousScore = null;
      for (let j = i + 1; j < historyRows.length; j += 1) {
        const olderView = await viewFor(historyRows[j]).catch(() => null);
        if (olderView && olderView.score != null) {
          previousScore = pressureToHealth(olderView.score);
          break;
        }
      }
      return {
        ...base,
        status: 'scored',
        pressure: view.score,
        maxPressure: view.maxScore,
        pressureLabel: view.label,
        score,
        previousScore,
        delta: score != null && previousScore != null ? score - previousScore : null,
        reason: view.summary || null,
        asOf: view.date,
      };
    }
    return { ...base, status: 'pending', reason: view.summary || 'Pest Pressure will appear once enough service data is available.' };
  }

  const monitored = activeLines.has('pest');
  if (monitored) {
    return { ...base, status: 'active', reason: 'Your pest protection program is active.' };
  }
  return { ...base, status: 'not_monitored', reason: 'No pest protection program on this property.' };
}

async function termiteComponent(customerId, knex, activeLines) {
  const base = { key: 'termite', label: 'Termite' };
  const bond = await knex('termite_bonds')
    .where({ customer_id: customerId, status: 'active' })
    .orderBy('renews_at', 'desc')
    .first('renews_at')
    .catch(() => null);
  if (bond) {
    const renews = dateOnlyString(bond.renews_at);
    return {
      ...base,
      status: 'active',
      reason: renews ? `Termite bond active — renews ${renews}.` : 'Termite bond active.',
    };
  }
  // program-scoped: termite_stations also carries rodent/trapping stations,
  // which must not activate the Termite component.
  const stationRow = await knex('termite_stations')
    .where({ customer_id: customerId, is_active: true, program: 'termite' })
    .count('id as count')
    .first()
    .catch(() => null);
  const stations = Number(stationRow?.count || 0);
  if (stations > 0) {
    return {
      ...base,
      status: 'active',
      reason: `${stations} monitoring station${stations === 1 ? '' : 's'} active on your property.`,
    };
  }
  // Recurring-only termite coverage (e.g. foam_recurring) carries no bond
  // row and may predate any station rows — still protection.
  const recurring = activeLines.has('termite');
  if (recurring) {
    return { ...base, status: 'active', reason: 'Recurring termite protection active.' };
  }
  return { ...base, status: 'not_monitored', reason: 'No termite protection on file.' };
}

async function treeShrubComponent(customerId, knex, activeLines) {
  const base = { key: 'tree_shrub', label: 'Trees & Shrubs' };
  // service_date first — a late-entered older visit must not become the
  // current assessment (created_at is only the tie-breaker, matching the
  // established tree/shrub trend ordering).
  const rows = await knex('tree_shrub_assessments')
    .where({ customer_id: customerId, confirmed_by_tech: true })
    .orderBy('service_date', 'desc')
    .orderBy('created_at', 'desc')
    .limit(2)
    .catch(() => []);
  // formatAssessmentScores computes the category-fallback overall for legacy
  // rows whose overall_score is null — the same formatter the tree/shrub
  // report surface uses.
  const overallOf = (r) => (formatAssessmentScores
    ? formatAssessmentScores(r)?.overallScore
    : (r?.overall_score ?? null));
  const scored = rows
    .map((r) => ({ row: r, overall: overallOf(r) }))
    .filter((x) => x.overall != null);
  if (scored.length) {
    const score = roundOrNull(scored[0].overall);
    const previousScore = scored[1] ? roundOrNull(scored[1].overall) : null;
    const delta = score != null && previousScore != null ? score - previousScore : null;
    return {
      ...base,
      status: 'scored',
      score,
      previousScore,
      delta,
      reason: movementReason(delta),
      asOf: dateOnlyString(scored[0].row.service_date),
    };
  }
  const monitored = activeLines.has('tree_shrub');
  if (monitored) {
    return { ...base, status: 'pending', reason: 'Your tree & shrub score appears after the first confirmed assessment.' };
  }
  return { ...base, status: 'not_monitored', reason: 'No tree & shrub program on this property.' };
}

async function mosquitoComponent(customerId, knex, activeLines) {
  const base = { key: 'mosquito', label: 'Mosquito' };
  const monitored = activeLines.has('mosquito');
  if (monitored) {
    return { ...base, status: 'active', reason: 'Your mosquito program is active.' };
  }
  return { ...base, status: 'not_monitored', reason: 'No mosquito program on this property.' };
}

// Plain-language mapping of the snapshot's own interpretation enum — the
// judgment is the snapshot engine's, this is display copy only.
const IRRIGATION_COPY = {
  water_deficit_likely: 'Your lawn is likely getting less water than it needs.',
  water_balance_ok: 'Watering and rainfall look on track.',
  wet_condition_watch: 'Your lawn may be getting more water than it needs.',
  coverage_issue_possible: 'Watering coverage may be uneven.',
};

async function irrigationComponent(customerId, knex) {
  const base = { key: 'irrigation', label: 'Irrigation' };
  // service_date first — opening an old report can self-heal a missing
  // snapshot later, and that backfill must not read as the current picture.
  const snap = await knex('lawn_water_intake_snapshots')
    .where({ customer_id: customerId })
    .orderBy('service_date', 'desc')
    .orderBy('created_at', 'desc')
    .first('status', 'interpretation', 'water_gap_inches', 'service_date')
    .catch(() => null);
  if (snap && snap.status && snap.status !== 'unknown') {
    return {
      ...base,
      status: 'status',
      waterStatus: snap.status, // low | balanced | high
      reason: IRRIGATION_COPY[snap.interpretation] || null,
      asOf: dateOnlyString(snap.service_date),
    };
  }
  if (snap) {
    // A snapshot exists but resolved 'unknown' (rain/irrigation/target data
    // unavailable) — the customer IS serviced; say the data is still
    // building, never "tracking starts with your first service".
    return {
      ...base,
      status: 'pending',
      reason: 'Watering data for your lawn is still being collected.',
      asOf: dateOnlyString(snap.service_date),
    };
  }
  return { ...base, status: 'not_monitored', reason: 'Irrigation tracking starts with your first lawn service.' };
}

async function rainSummary(customerId, knex) {
  const customer = await knex('customers')
    .where({ id: customerId })
    .first('lawn_water_area_id')
    .catch(() => null);
  const areaId = customer?.lawn_water_area_id;
  if (!areaId) return null;
  // getAreaRainfall returns null on a partial window (undercount guard).
  // Window ends YESTERDAY: the daily sync writes today's row from a
  // forecast_days=1 request, so today's total includes rain that hasn't
  // fallen yet — forecast must never read as observed rainfall.
  const raw = await getAreaRainfall(areaId, etDateString(addETDays(new Date(), -7)), etDateString(addETDays(new Date(), -1)), knex);
  if (raw == null) return null;
  // Same calibration the lawn-water engine applies before presenting the
  // property's water picture (adjusted_rain_7day_inches) — the card must
  // agree with the irrigation snapshot and reports.
  const area = await knex('lawn_water_areas')
    .where({ id: areaId })
    .first('rain_adjustment_factor')
    .catch(() => null);
  const factor = Number(area?.rain_adjustment_factor || 1) || 1;
  const inches = Math.round(raw * factor * 100) / 100;
  return {
    inches7d: inches,
    windowDays: 7,
    note: `${inches}" of rain in your service area in the last 7 days.`,
  };
}

function composeOverall(components) {
  const scoredNow = components.filter((c) => c.status === 'scored' && c.score != null);
  if (!scoredNow.length) return { score: null, delta: null, componentCount: 0 };
  const mean = (vals) => vals.reduce((a, b) => a + b, 0) / vals.length;
  const score = Math.round(mean(scoredNow.map((c) => c.score)));
  // Honest movement only: the delta must describe the SAME cohort as the
  // displayed score. If any scored component lacks a previous value (a
  // newly appearing component), showing a delta would attribute one
  // component's movement to the whole composite — suppress it instead.
  const paired = scoredNow.filter((c) => c.previousScore != null);
  // Symmetric signed rounding: Math.round(-0.5) is -0 (serializes as 0),
  // which would erase a half-point decline while +0.5 reports +1.
  const roundSigned = (v) => Math.sign(v) * Math.round(Math.abs(v));
  const delta = paired.length && paired.length === scoredNow.length
    ? roundSigned(mean(paired.map((c) => c.score)) - mean(paired.map((c) => c.previousScore)))
    : null;
  return { score, delta, componentCount: scoredNow.length };
}

async function buildPropertyScore(customerId, knex = db) {
  const settle = (promise, fallback) => promise.catch(() => fallback);
  const activeLines = await loadActiveLineSet(customerId, knex);
  const [lawn, pest, termite, treeShrub, mosquito, irrigation, rain] = await Promise.all([
    settle(lawnComponent(customerId, knex, activeLines), { key: 'lawn', label: 'Lawn', status: 'not_monitored', reason: null }),
    settle(pestComponent(customerId, knex, activeLines), { key: 'pest', label: 'Pest Pressure', status: 'not_monitored', reason: null }),
    settle(termiteComponent(customerId, knex, activeLines), { key: 'termite', label: 'Termite', status: 'not_monitored', reason: null }),
    settle(treeShrubComponent(customerId, knex, activeLines), { key: 'tree_shrub', label: 'Trees & Shrubs', status: 'not_monitored', reason: null }),
    settle(mosquitoComponent(customerId, knex, activeLines), { key: 'mosquito', label: 'Mosquito', status: 'not_monitored', reason: null }),
    settle(irrigationComponent(customerId, knex), { key: 'irrigation', label: 'Irrigation', status: 'not_monitored', reason: null }),
    settle(rainSummary(customerId, knex), null),
  ]);

  const components = [lawn, pest, termite, treeShrub, mosquito, irrigation];
  return {
    overall: composeOverall(components),
    components,
    rain,
    generatedAt: new Date().toISOString(),
  };
}

module.exports = {
  buildPropertyScore,
  // exported for tests
  _test: { composeOverall, pressureToHealth, movementReason, loadActiveLineSet },
};
