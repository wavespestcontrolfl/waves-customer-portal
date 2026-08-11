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
const { lawnOverall, hasCustomerLawnCare } = require('./lawn-health-shared');
const {
  loadActiveConfig,
  loadHistoryForCustomer,
  loadScoreForServiceRecord,
} = require('./pest-pressure/store');
const { buildPestPressureCustomerView } = require('./pest-pressure/customer-view');
const { getAreaRainfall } = require('./lawn-water-area');
const { dateOnlyString } = require('../utils/date-only');

// ET calendar date (YYYY-MM-DD) `daysBack` days before today. en-CA gives the
// ISO date form; the timeZone pin keeps the window on the business calendar
// regardless of host TZ (Railway runs UTC).
function etDate(daysBack = 0) {
  return new Date(Date.now() - daysBack * 86400000)
    .toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

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

// Any scheduled service whose type matches one of the LIKE patterns —
// the same catalog-inference idiom applyLawnServiceFilter uses.
async function hasServiceLike(customerId, patterns, knex) {
  const row = await knex('scheduled_services as ss')
    .where('ss.customer_id', customerId)
    .where(function () {
      patterns.forEach((p, i) => {
        if (i === 0) this.whereRaw('LOWER(ss.service_type) LIKE ?', [p]);
        else this.orWhereRaw('LOWER(ss.service_type) LIKE ?', [p]);
      });
    })
    .first('ss.id')
    .catch(() => null);
  return Boolean(row);
}

async function lawnComponent(customerId, knex) {
  const base = { key: 'lawn', label: 'Lawn' };
  const rows = await knex('lawn_assessments')
    .where({ customer_id: customerId, confirmed_by_tech: true })
    .orderBy('service_date', 'desc')
    .orderBy('id', 'desc')
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
  const monitored = await hasCustomerLawnCare(customerId, knex).catch(() => false);
  if (monitored) {
    return { ...base, status: 'pending', reason: 'Your lawn score appears after the first confirmed lawn assessment.' };
  }
  return { ...base, status: 'not_monitored', reason: 'No lawn care program on this property.' };
}

async function pestComponent(customerId, knex) {
  const base = { key: 'pest', label: 'Pest Pressure' };
  const config = await loadActiveConfig(knex).catch(() => null);
  const history = await loadHistoryForCustomer(knex, customerId, { limit: 6 }).catch(() => []);
  const latest = Array.isArray(history) && history.length ? history[0] : null;

  if (latest && latest.service_record_id) {
    const fullRow = await loadScoreForServiceRecord(knex, latest.service_record_id).catch(() => null);
    const serviceRecord = await knex('service_records')
      .where({ id: latest.service_record_id })
      .first()
      .catch(() => null);
    const view = buildPestPressureCustomerView({
      config,
      scoreRow: fullRow || latest,
      serviceRecord,
      historyRows: history,
    });
    if (view && view.score != null) {
      const score = pressureToHealth(view.score);
      // trendDelta is current-minus-previous in the engine's 0–5 scale.
      const previousScore = view.trendDelta != null
        ? pressureToHealth(view.score - view.trendDelta)
        : null;
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
    if (view) {
      return { ...base, status: 'pending', reason: view.summary || 'Pest Pressure will appear once enough service data is available.' };
    }
  }

  const monitored = await hasServiceLike(customerId, ['%pest%'], knex);
  if (monitored) {
    return { ...base, status: 'active', reason: 'Your pest protection program is active.' };
  }
  return { ...base, status: 'not_monitored', reason: 'No pest protection program on this property.' };
}

async function termiteComponent(customerId, knex) {
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
  const stationRow = await knex('termite_stations')
    .where({ customer_id: customerId, is_active: true })
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
  return { ...base, status: 'not_monitored', reason: 'No termite protection on file.' };
}

async function treeShrubComponent(customerId, knex) {
  const base = { key: 'tree_shrub', label: 'Trees & Shrubs' };
  const rows = await knex('tree_shrub_assessments')
    .where({ customer_id: customerId, confirmed_by_tech: true })
    .orderBy('created_at', 'desc')
    .limit(2)
    .catch(() => []);
  const scored = rows.filter((r) => r && r.overall_score != null);
  if (scored.length) {
    const score = roundOrNull(scored[0].overall_score);
    const previousScore = scored[1] ? roundOrNull(scored[1].overall_score) : null;
    const delta = score != null && previousScore != null ? score - previousScore : null;
    return {
      ...base,
      status: 'scored',
      score,
      previousScore,
      delta,
      reason: movementReason(delta),
      asOf: dateOnlyString(scored[0].created_at),
    };
  }
  const monitored = await hasServiceLike(customerId, ['%tree%', '%shrub%'], knex);
  if (monitored) {
    return { ...base, status: 'pending', reason: 'Your tree & shrub score appears after the first confirmed assessment.' };
  }
  return { ...base, status: 'not_monitored', reason: 'No tree & shrub program on this property.' };
}

async function mosquitoComponent(customerId, knex) {
  const base = { key: 'mosquito', label: 'Mosquito' };
  const monitored = await hasServiceLike(customerId, ['%mosquito%'], knex);
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
  const snap = await knex('lawn_water_intake_snapshots')
    .where({ customer_id: customerId })
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
  return { ...base, status: 'not_monitored', reason: 'Irrigation tracking starts with your first lawn service.' };
}

async function rainSummary(customerId, knex) {
  const customer = await knex('customers')
    .where({ id: customerId })
    .first('lawn_water_area_id')
    .catch(() => null);
  const areaId = customer?.lawn_water_area_id;
  if (!areaId) return null;
  const inches = await getAreaRainfall(areaId, etDate(6), etDate(0), knex);
  if (inches == null) return null;
  return {
    inches7d: inches,
    windowDays: 7,
    note: `${inches}" of rain at your property in the last 7 days.`,
  };
}

function composeOverall(components) {
  const scoredNow = components.filter((c) => c.status === 'scored' && c.score != null);
  if (!scoredNow.length) return { score: null, delta: null, componentCount: 0 };
  const mean = (vals) => vals.reduce((a, b) => a + b, 0) / vals.length;
  const score = Math.round(mean(scoredNow.map((c) => c.score)));
  const paired = scoredNow.filter((c) => c.previousScore != null);
  const delta = paired.length
    ? Math.round(mean(paired.map((c) => c.score)) - mean(paired.map((c) => c.previousScore)))
    : null;
  return { score, delta, componentCount: scoredNow.length };
}

async function buildPropertyScore(customerId, knex = db) {
  const settle = (promise, fallback) => promise.catch(() => fallback);
  const [lawn, pest, termite, treeShrub, mosquito, irrigation, rain] = await Promise.all([
    settle(lawnComponent(customerId, knex), { key: 'lawn', label: 'Lawn', status: 'not_monitored', reason: null }),
    settle(pestComponent(customerId, knex), { key: 'pest', label: 'Pest Pressure', status: 'not_monitored', reason: null }),
    settle(termiteComponent(customerId, knex), { key: 'termite', label: 'Termite', status: 'not_monitored', reason: null }),
    settle(treeShrubComponent(customerId, knex), { key: 'tree_shrub', label: 'Trees & Shrubs', status: 'not_monitored', reason: null }),
    settle(mosquitoComponent(customerId, knex), { key: 'mosquito', label: 'Mosquito', status: 'not_monitored', reason: null }),
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
  _test: { composeOverall, pressureToHealth, movementReason, etDate },
};
