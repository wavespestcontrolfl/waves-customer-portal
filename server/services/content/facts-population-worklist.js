/**
 * facts-population-worklist.js — turns the facts-bank readiness matrix into a
 * GSC-weighted action list. Answers "which missing city/service facts would
 * unlock the highest-value pages?" — not "which files are empty?".
 *
 * For every facts-gated opportunity the miner surfaced that is currently
 * blocked by insufficient facts, the opportunity's value (miner score +
 * impressions) is attributed to the facts file(s) blocking it. A file that is
 * the SOLE blocker of a high-value page ranks above a file that is merely one
 * of several blockers, because populating it produces an immediate unlock.
 *
 * Split into a PURE ranking core (rankGaps — no I/O, fully testable) and a
 * DB-backed wrapper (build — joins auditor.auditAll with opportunity_queue).
 */

const auditor = require('../content-astro/facts-bank-auditor');
const factsSufficiency = require('./facts-sufficiency');
const { REVENUE_PRIORITY } = require('./scoring-config');
const logger = require('../logger');

const FACTS_GATED_ACTIONS = factsSufficiency.FACTS_GATED_ACTIONS;

// Weights for the per-file priority score.
const SOLE_UNLOCK_WEIGHT = 1.0;     // value this file would unlock on its own
const CONTRIBUTING_WEIGHT = 0.3;    // value where this file is one of several blockers
const REVENUE_BUMP = 20;            // max bump for high-revenue service files

// ── pure ranking core ───────────────────────────────────────────────

/**
 * rankGaps(blockedCombos) → rankedFiles[]
 *
 * blockedCombos: [{
 *   city, service, county,           // facts-bank ids
 *   value,                            // opportunity score (number)
 *   impressions,                      // optional GSC impressions (number)
 *   blockers: [{ type, id }]          // which files block this combo
 * }]
 *
 * Returns files sorted by unlock leverage:
 *   [{ file_type, file_id, sole_unlock_value, sole_unlock_impressions,
 *      sole_unlock_count, contributing_value, blocked_count,
 *      example_combos[], priority }]
 */
function rankGaps(blockedCombos = []) {
  const files = new Map(); // key = `${type}:${id}`

  function fileEntry(type, id) {
    const key = `${type}:${id}`;
    if (!files.has(key)) {
      files.set(key, {
        file_type: type,
        file_id: id,
        sole_unlock_value: 0,
        sole_unlock_impressions: 0,
        sole_unlock_count: 0,
        contributing_value: 0,
        blocked_count: 0,
        example_combos: [],
      });
    }
    return files.get(key);
  }

  for (const combo of blockedCombos) {
    const blockers = Array.isArray(combo.blockers) ? combo.blockers : [];
    if (blockers.length === 0) continue;
    const value = Number(combo.value) || 0;
    const impressions = Number(combo.impressions) || 0;
    const sole = blockers.length === 1;

    for (const blocker of blockers) {
      const entry = fileEntry(blocker.type, blocker.id);
      entry.contributing_value += value;
      entry.blocked_count += 1;
      if (entry.example_combos.length < 5) {
        entry.example_combos.push({ city: combo.city, service: combo.service, value, impressions });
      }
      if (sole) {
        entry.sole_unlock_value += value;
        entry.sole_unlock_impressions += impressions;
        entry.sole_unlock_count += 1;
      }
    }
  }

  const ranked = [...files.values()].map((f) => {
    const revenueBump = f.file_type === 'service'
      ? Math.round(REVENUE_BUMP * (REVENUE_PRIORITY[f.file_id] ?? mapServiceRevenue(f.file_id)))
      : 0;
    const priority = Math.round(
      f.sole_unlock_value * SOLE_UNLOCK_WEIGHT
      + f.contributing_value * CONTRIBUTING_WEIGHT
      + revenueBump,
    );
    return { ...f, priority };
  });

  ranked.sort((a, b) =>
    b.sole_unlock_value - a.sole_unlock_value
    || b.priority - a.priority
    || b.contributing_value - a.contributing_value);

  return ranked;
}

// Service facts-bank ids don't all match REVENUE_PRIORITY keys (which use
// coarse categories). Map the full id back to a category for the revenue bump.
function mapServiceRevenue(serviceId) {
  const id = String(serviceId || '');
  if (id.startsWith('termite')) return REVENUE_PRIORITY.termite;
  if (id.startsWith('rodent')) return REVENUE_PRIORITY.rodent;
  if (id.startsWith('mosquito')) return REVENUE_PRIORITY.mosquito;
  if (id.startsWith('pest')) return REVENUE_PRIORITY.pest;
  if (id.startsWith('lawn') || id.startsWith('commercial-lawn')) return REVENUE_PRIORITY.lawn;
  if (id.startsWith('tree-shrub')) return REVENUE_PRIORITY['tree-shrub'];
  return REVENUE_PRIORITY.specialty ?? 0.4;
}

// Derive the blocking files for a matrix combo from its gap_codes + ids.
function blockersFromMatrix(entry) {
  const blockers = [];
  const codes = entry.gap_codes || [];
  if (codes.some((c) => c.startsWith('city:')) && entry.city) blockers.push({ type: 'city', id: entry.city });
  if (codes.some((c) => c.startsWith('service:')) && entry.service) blockers.push({ type: 'service', id: entry.service });
  if (codes.some((c) => c.startsWith('county:')) && entry.county) blockers.push({ type: 'county', id: entry.county });
  return blockers;
}

// ── DB-backed wrapper ───────────────────────────────────────────────

/**
 * build({ db, minValue, opts }) → { worklist[], summary, generated_at }
 *
 * Joins the facts-bank readiness matrix with opportunity_queue: for each
 * facts-gated opportunity blocked by insufficient facts, attributes its score
 * + impressions to the blocking files, then ranks.
 */
async function build({ db, opts = {} } = {}) {
  if (!db) throw new Error('facts-population-worklist.build: db required');

  // 1. Readiness matrix → lookup by `${city}|${service}`.
  const audit = await auditor.auditAll(opts);
  const matrixByCombo = new Map();
  for (const entry of audit.matrix) {
    matrixByCombo.set(`${entry.city}|${entry.service}`, entry);
  }

  // 2. Facts-gated opportunities from the queue.
  let rows = [];
  try {
    rows = await db('opportunity_queue')
      .whereIn('action_type', [...FACTS_GATED_ACTIONS])
      .whereIn('status', ['pending', 'claimed', 'pending_review'])
      .select('city', 'service', 'action_type', 'score', 'page_url', 'signal_metadata', 'status');
  } catch (err) {
    logger.warn(`[facts-population-worklist] queue read failed: ${err.message}`);
    return { worklist: [], summary: { error: err.message }, generated_at: new Date().toISOString() };
  }

  // 3. Normalize + join + collect blocked combos.
  const blockedCombos = [];
  let matchedRows = 0;
  for (const row of rows) {
    const cityId = factsSufficiency.normalizeCityId(row.city);
    const serviceId = factsSufficiency.normalizeServiceId(row.service);
    if (!cityId || !serviceId) continue;
    const entry = matrixByCombo.get(`${cityId}|${serviceId}`);
    if (!entry || entry.sufficient) continue; // only blocked combos
    matchedRows += 1;
    const meta = parseMeta(row.signal_metadata);
    blockedCombos.push({
      city: cityId,
      service: serviceId,
      county: entry.county,
      value: Number(row.score) || 0,
      impressions: Number(meta.impressions || meta.impressions_28d || 0) || 0,
      blockers: blockersFromMatrix(entry),
    });
  }

  const worklist = rankGaps(blockedCombos);

  return {
    generated_at: new Date().toISOString(),
    worklist,
    summary: {
      opportunities_scanned: rows.length,
      blocked_facts_gated: matchedRows,
      files_in_worklist: worklist.length,
      combinations_sufficient: audit.summary.combinations_sufficient,
      combinations_total: audit.summary.combinations_total,
    },
  };
}

function parseMeta(v) {
  if (!v) return {};
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch { return {}; }
}

module.exports = {
  build,
  rankGaps,
  blockersFromMatrix,
  mapServiceRevenue,
};
