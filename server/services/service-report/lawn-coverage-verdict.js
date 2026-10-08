/**
 * GATE_LAWN_COVERAGE_HIDE_DEFAULT_ZONES — the frozen coverage verdict.
 *
 * Whether a lawn visit's coverage zones are only the schematic defaults (no
 * technician-marked zone) is decided ONCE, at completion, and frozen onto the
 * service record: structured_notes.lawnCoverageVerdict = { v: 1, defaultsOnly,
 * frozenAt }, first writer wins. A render and the PDF cache key only READ that
 * value; nothing reads property_zones / property_geometries live to decide it,
 * so a later zone write, a re-geocode or a failed read cannot flip a report.
 *
 * No frozen verdict (an older visit, a freeze made while the gate was off, a
 * failed read at completion) = the section shows exactly as with the gate off.
 */

const logger = require('../logger');

function parseJsonObject(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try { return JSON.parse(value) || {}; } catch { return {}; }
}

// The frozen verdict on a record's structured_notes, or null when none (or an
// unknown shape/version). Only a boolean defaultsOnly counts.
function readFrozenCoverageVerdict(structuredNotes) {
  const verdict = parseJsonObject(structuredNotes).lawnCoverageVerdict;
  if (!verdict || typeof verdict !== 'object') return null;
  if (verdict.v !== 1 || typeof verdict.defaultsOnly !== 'boolean') return null;
  return verdict;
}

// True only for a frozen verdict that says the zones were defaults only.
function frozenCoverageDefaultsOnly(structuredNotes) {
  const verdict = readFrozenCoverageVerdict(structuredNotes);
  return !!verdict && verdict.defaultsOnly === true;
}

// The PDF cache-key component: ':covhide=1' only for a frozen defaultsOnly
// verdict, otherwise ''. The caller reads the record's own structured_notes so a
// partial cache-lookup row and a full render row stamp the same.
function coverageVerdictStamp(structuredNotes) {
  return frozenCoverageDefaultsOnly(structuredNotes) ? ':covhide=1' : '';
}

// Freeze the verdict, first writer wins. The guarded UPDATE takes the row lock,
// so of two racing writers the second re-checks the guard after the first
// commits and writes nothing; a replay changes nothing either. Never throws:
// returns { frozen: boolean } (true only when THIS call wrote it).
async function freezeCoverageVerdict({ knex, serviceRecordId, defaultsOnly, now = new Date() }) {
  if (!knex || !serviceRecordId || typeof defaultsOnly !== 'boolean') return { frozen: false };
  try {
    const verdict = { v: 1, defaultsOnly, frozenAt: now.toISOString() };
    const written = await knex('service_records')
      .where({ id: serviceRecordId })
      .whereRaw("(structured_notes::jsonb -> 'lawnCoverageVerdict') IS NULL")
      .update({
        structured_notes: knex.raw(
          "COALESCE(structured_notes::jsonb, '{}'::jsonb) || ?::jsonb",
          [JSON.stringify({ lawnCoverageVerdict: verdict })],
        ),
      });
    return { frozen: Number(written) > 0 };
  } catch (err) {
    logger.warn(`[lawn-coverage-verdict] freeze failed for service_record ${serviceRecordId}: ${err.message}`);
    return { frozen: false };
  }
}

module.exports = {
  readFrozenCoverageVerdict,
  frozenCoverageDefaultsOnly,
  coverageVerdictStamp,
  freezeCoverageVerdict,
};
