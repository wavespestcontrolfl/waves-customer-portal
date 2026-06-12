/**
 * Estimate win/loss slicing by property-lookup fieldVerifyFlags and price
 * band (estimator backlog, final item).
 *
 * The question this answers: do estimates built on UNVERIFIED property
 * facts (the lookup profile's fieldVerifyFlags review nudges) lose more
 * often — and in which price bands does verification matter most? That
 * tells Adam where field-verify effort buys conversion.
 *
 * Resolved-only semantics match the client's PipelineAnalytics exactly:
 * won = accepted, lost = declined or expired; open offers never count.
 * Resolution date uses the same fallback chain as resolutionDate() there.
 *
 * Aggregation is plain JS over a slim knex select: resolved volume in a
 * 7-365 day window is small, estimate_data is jsonb (pg pre-parses), and
 * the profile lives under BOTH historical shapes (engineRequest.profile —
 * admin creates — and flattened engineInputs — public/lead creates), same
 * dual-shape rule estimate-actuals handles. No raw SQL.
 */

const db = require('../models/db');

const RESOLVED_STATUSES = ['accepted', 'declined', 'expired'];

// Fixed, documented ANALYTICS bands — display buckets only, deliberately
// not pricing config. Re-banding is a copy change, not a pricing decision.
const RECURRING_BANDS = [
  { key: 'under_60', label: '<$60/mo', min: 0, max: 60 },
  { key: '60_90', label: '$60–89/mo', min: 60, max: 90 },
  { key: '90_130', label: '$90–129/mo', min: 90, max: 130 },
  { key: '130_plus', label: '$130+/mo', min: 130, max: Infinity },
];
const ONETIME_BANDS = [
  { key: 'under_150', label: '<$150', min: 0, max: 150 },
  { key: '150_300', label: '$150–299', min: 150, max: 300 },
  { key: '300_600', label: '$300–599', min: 300, max: 600 },
  { key: '600_plus', label: '$600+', min: 600, max: Infinity },
];

function parseEstimateData(raw) {
  try {
    return typeof raw === 'string' ? JSON.parse(raw) : (raw || {});
  } catch {
    return {};
  }
}

function profileFromEstimateData(data) {
  // THREE persisted generations: admin creates nest it at
  // engineRequest.profile, legacy public/lead creates flatten it as
  // engineInputs, and quote-wizard estimates store the enriched profile at
  // estimate_data.enriched (public-quote.js writes `enriched: ep`). Missing
  // any of them silently dumps that cohort into noProfile and skews the
  // slices.
  return data?.engineRequest?.profile || data?.engineInputs || data?.enriched || null;
}

function verifyFlagsFrom(profile) {
  const flags = profile?.fieldVerifyFlags;
  if (!Array.isArray(flags)) return [];
  return flags.filter((f) => f && typeof f.field === 'string' && f.field.length);
}

// Mirror of the client's resolutionDate() fallback chain, on snake_case
// row columns. Returns NaN-safe ms or null.
function resolutionDateMs(row) {
  const pick = (...candidates) => {
    for (const value of candidates) {
      if (!value) continue;
      const ts = new Date(value).getTime();
      if (Number.isFinite(ts)) return ts;
    }
    return null;
  };
  if (row.status === 'accepted') return pick(row.accepted_at, row.created_at);
  if (row.status === 'declined') return pick(row.declined_at, row.updated_at, row.created_at);
  if (row.status === 'expired') return pick(row.expires_at, row.updated_at, row.created_at);
  return null;
}

function bandFor(bands, amount) {
  return bands.find((b) => amount >= b.min && amount < b.max) || null;
}

function emptyCell() {
  return { won: 0, lost: 0, total: 0, winRatePct: null };
}

function tally(cell, isWon) {
  cell.total += 1;
  if (isWon) cell.won += 1;
  else cell.lost += 1;
}

function finalize(cell) {
  cell.winRatePct = cell.total > 0
    ? Math.round((cell.won / cell.total) * 1000) / 10
    : null;
  return cell;
}

async function winLossSlices({ days = 90 } = {}) {
  const cutoffMs = Date.now() - days * 86400000;
  // updated_at always moves on the resolving status transition, so this
  // WHERE is a superset of "resolved within the window"; the precise
  // resolution-date filter below trims re-saved older rows.
  const rows = await db('estimates')
    .whereIn('status', RESOLVED_STATUSES)
    .where('updated_at', '>=', new Date(cutoffMs))
    .select(
      'id', 'status', 'accepted_at', 'declined_at', 'expires_at',
      'created_at', 'updated_at', 'monthly_total', 'onetime_total',
      'estimate_data',
    );

  const totals = emptyCell();
  const byFlagPresence = {
    clean: emptyCell(),
    flagged: emptyCell(),
    // Estimates with no lookup profile at all (manual/legacy) — kept out of
    // clean so "clean" genuinely means "looked up and nothing to verify".
    noProfile: emptyCell(),
  };
  const byFlagField = new Map();
  const byFlagPriority = { HIGH: emptyCell(), MEDIUM: emptyCell(), LOW: emptyCell() };
  const byPriceBand = {
    recurring: RECURRING_BANDS.map((b) => ({ key: b.key, label: b.label, ...emptyCell() })),
    oneTime: ONETIME_BANDS.map((b) => ({ key: b.key, label: b.label, ...emptyCell() })),
  };
  // The headline cross-slice: recurring price band × flagged/clean.
  const recurringBandsByFlag = RECURRING_BANDS.map((b) => ({
    key: b.key,
    label: b.label,
    clean: emptyCell(),
    flagged: emptyCell(),
  }));

  for (const row of rows) {
    const resolvedAt = resolutionDateMs(row);
    if (resolvedAt == null || resolvedAt < cutoffMs) continue;
    const isWon = row.status === 'accepted';
    tally(totals, isWon);

    const profile = profileFromEstimateData(parseEstimateData(row.estimate_data));
    const flags = verifyFlagsFrom(profile);
    const presence = !profile ? 'noProfile' : (flags.length ? 'flagged' : 'clean');
    tally(byFlagPresence[presence], isWon);

    for (const flag of flags) {
      if (!byFlagField.has(flag.field)) byFlagField.set(flag.field, emptyCell());
      tally(byFlagField.get(flag.field), isWon);
      const priority = String(flag.priority || '').toUpperCase();
      if (byFlagPriority[priority]) tally(byFlagPriority[priority], isWon);
    }

    const monthly = parseFloat(row.monthly_total || 0);
    const oneTime = parseFloat(row.onetime_total || 0);
    if (monthly > 0) {
      const band = bandFor(RECURRING_BANDS, monthly);
      if (band) {
        tally(byPriceBand.recurring.find((b) => b.key === band.key), isWon);
        if (presence !== 'noProfile') {
          tally(recurringBandsByFlag.find((b) => b.key === band.key)[presence], isWon);
        }
      }
    } else if (oneTime > 0) {
      const band = bandFor(ONETIME_BANDS, oneTime);
      if (band) tally(byPriceBand.oneTime.find((b) => b.key === band.key), isWon);
    }
  }

  finalize(totals);
  Object.values(byFlagPresence).forEach(finalize);
  Object.values(byFlagPriority).forEach(finalize);
  byPriceBand.recurring.forEach(finalize);
  byPriceBand.oneTime.forEach(finalize);
  recurringBandsByFlag.forEach((b) => {
    finalize(b.clean);
    finalize(b.flagged);
  });

  const flagFields = [...byFlagField.entries()]
    .map(([field, cell]) => ({ field, ...finalize(cell) }))
    .sort((a, b) => b.total - a.total);

  return {
    days,
    resolved: totals.total,
    won: totals.won,
    lost: totals.lost,
    winRatePct: totals.winRatePct,
    byFlagPresence,
    byFlagField: flagFields,
    byFlagPriority,
    byPriceBand,
    recurringBandsByFlag,
  };
}

module.exports = {
  winLossSlices,
  _private: {
    bandFor,
    profileFromEstimateData,
    resolutionDateMs,
    verifyFlagsFrom,
    RECURRING_BANDS,
    ONETIME_BANDS,
  },
};
