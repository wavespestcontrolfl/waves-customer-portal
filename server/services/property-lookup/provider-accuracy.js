/**
 * Per-provider accuracy scoring vs tech-verified facts (estimator backlog:
 * per-provider vision/search scoring from verified overrides).
 *
 * For every cached lookup a tech has field-verified
 * (property_lookups.verified_overrides), each provider's ORIGINAL claim for
 * that field still lives in property_record._fieldEvidence[field].evidence —
 * applyVerifiedOverrides deliberately PREPENDS the tech entry and keeps the
 * prior candidates. Comparing those claims against the verified value gives
 * a per-provider, per-field accuracy ledger: which source actually gets
 * squareFootage / stories / pool right, and which to stop trusting. That is
 * the input for any future evidence-weight retune (a deliberate, separate
 * decision — this module only measures).
 *
 * Read-only analytics over a small row set (tech verifications are rare);
 * plain knex select + JS aggregation — no raw SQL. Numeric fields score
 * "correct" within a documented relative tolerance: display analytics, not
 * pricing config.
 */

const db = require('../../models/db');

// Relative tolerance per numeric field; 0 = exact after Number(). County
// sqft vs survey sqft routinely differ a few percent — 10% keeps "right
// ballpark" claims correct while still failing order-of-magnitude misses.
const NUMERIC_FIELD_TOLERANCE = {
  squareFootage: 0.10,
  lotSize: 0.15,
  yearBuilt: 0,
  bedrooms: 0,
  bathrooms: 0,
  stories: 0,
};

// true / false / null (= unscoreable: missing side, non-numeric noise).
function valuesMatch(field, claimed, truth) {
  if (claimed == null || truth == null) return null;
  if (field in NUMERIC_FIELD_TOLERANCE) {
    const c = Number(claimed);
    const t = Number(truth);
    if (!Number.isFinite(c) || !Number.isFinite(t) || t === 0) return null;
    const tolerance = NUMERIC_FIELD_TOLERANCE[field];
    if (tolerance === 0) return c === t;
    return Math.abs(c - t) / Math.abs(t) <= tolerance;
  }
  const cs = String(claimed).trim().toUpperCase();
  const ts = String(truth).trim().toUpperCase();
  if (!cs || !ts) return null;
  return cs === ts;
}

function parseJson(raw) {
  try {
    return typeof raw === 'string' ? JSON.parse(raw) : (raw || null);
  } catch {
    return null;
  }
}

function emptyCell() {
  return { checked: 0, correct: 0, accuracyPct: null };
}

function tally(cell, isCorrect) {
  cell.checked += 1;
  if (isCorrect) cell.correct += 1;
}

function finalize(cell) {
  cell.accuracyPct = cell.checked > 0
    ? Math.round((cell.correct / cell.checked) * 1000) / 10
    : null;
  return cell;
}

async function providerAccuracy() {
  // verified_overrides is NOT NULL DEFAULT '{}' — whereNotNull would match
  // EVERY cached row and pull each property_record JSONB into memory. The
  // empty-object inequality restricts the scan to genuinely verified rows
  // (predicate verified read-only against prod 2026-06-12: 1 of 5 rows).
  const rows = await db('property_lookups')
    .whereRaw("verified_overrides <> '{}'::jsonb")
    .whereNotNull('property_record')
    .select('verified_overrides', 'property_record');

  const providers = new Map(); // provider -> { ...cell, byField: Map }
  let lookupsScored = 0;
  let comparisons = 0;

  for (const row of rows) {
    const overrides = parseJson(row.verified_overrides);
    const record = parseJson(row.property_record);
    if (!overrides || !record) continue;
    let scoredThisRow = false;

    for (const [field, entry] of Object.entries(overrides)) {
      const truth = entry?.value;
      const candidates = record._fieldEvidence?.[field]?.evidence;
      if (truth === undefined || !Array.isArray(candidates)) continue;

      for (const candidate of candidates) {
        const provider = String(candidate?.provider || '').trim();
        // The tech entry IS the truth — never scores itself.
        if (!provider || provider === 'tech' || candidate?.sourceType === 'verified') continue;
        const match = valuesMatch(field, candidate?.value, truth);
        if (match === null) continue;

        if (!providers.has(provider)) {
          providers.set(provider, { ...emptyCell(), byField: new Map() });
        }
        const bucket = providers.get(provider);
        tally(bucket, match);
        if (!bucket.byField.has(field)) bucket.byField.set(field, emptyCell());
        tally(bucket.byField.get(field), match);
        comparisons += 1;
        scoredThisRow = true;
      }
    }
    if (scoredThisRow) lookupsScored += 1;
  }

  const report = [...providers.entries()]
    .map(([provider, bucket]) => ({
      provider,
      checked: bucket.checked,
      correct: bucket.correct,
      accuracyPct: finalize(bucket).accuracyPct,
      byField: [...bucket.byField.entries()]
        .map(([field, cell]) => ({ field, ...finalize(cell) }))
        .sort((a, b) => b.checked - a.checked),
    }))
    .sort((a, b) => b.checked - a.checked);

  return {
    lookupsScored,
    comparisons,
    providers: report,
    tolerances: NUMERIC_FIELD_TOLERANCE,
  };
}

module.exports = {
  providerAccuracy,
  _private: { valuesMatch, NUMERIC_FIELD_TOLERANCE },
};
