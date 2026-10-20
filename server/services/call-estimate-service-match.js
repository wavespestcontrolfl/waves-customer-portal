// Service-line match between what a call ASKED to have quoted and what an
// estimate PRICED, for the send_estimate promise's ASSOCIATION proofs.
//
// Audit 2026-10-19 (calls 5f7d3fc9, 8d1e8e2c): a caller asked for a LAWN
// quote; a Pest Control estimate reached the same customer days later and the
// tracker closed the promise as "estimate_sent_to_same_customer_within_N_days".
// The lawn quote was still owed and no follow-up alert fired. An association
// proof is "some estimate reached this customer" — it must at least be for the
// service line the caller asked about. (The DIRECT proofs — estimator stamp,
// lead mirror — are exact and never come through here.)
//
// FAIL-SAFE: only a CLEAR conflict (both sides classified, no line in common)
// rejects an estimate. Either side unknown / unclassifiable keeps today's
// behavior, so noise never reopens a promise the tracker already closed.
//
// No second taxonomy: the estimate side is estimate-service-lines.js
// (inferEstimateServiceLines: structured estimate_data lines first, then the
// service_interest text), the call side maps the V2 extraction's
// service_request.primary_service_category enum (schema
// call-extraction.model-output) and falls back to specific_service_name read
// through the same estimate-service-lines text patterns. Pure
// module: no DB, no I/O.

const { inferEstimateServiceLines, serviceKeysFromText, parseEstimateData, oneTimeServicesFromData } = require('./estimate-service-lines');

// Coarse service LINES. commercial_* collapse to their residential line;
// palm injection is part of the tree & shrub line.
const LINE_BY_KEY = {
  pest: 'pest', commercial_pest: 'pest',
  lawn: 'lawn', commercial_lawn: 'lawn',
  mosquito: 'mosquito', commercial_mosquito: 'mosquito',
  tree_shrub: 'tree_shrub', commercial_tree_shrub: 'tree_shrub', palm_injection: 'tree_shrub',
  rodent: 'rodent', commercial_rodent_bait: 'rodent',
  termite: 'termite', commercial_termite_bait: 'termite',
};

// V2 primary_service_category / secondary_categories enum -> line. Absent
// (bundled_waveguard, inspection_only, other, unknown values) = no
// claim about a line: a bundle spans lines, the others name none.
const LINE_BY_V2_CATEGORY = {
  pest_general: 'pest', stinging_insect: 'pest', bed_bug: 'pest',
  lawn_care: 'lawn',
  mosquito: 'mosquito',
  palm_injection: 'tree_shrub',
  rodent: 'rodent', exclusion: 'rodent',
  termite: 'termite', wdo: 'termite',
};

const linesOfKeys = (keys) => keys.map((k) => LINE_BY_KEY[k]).filter(Boolean);

// The line the CALL asked about, as a one-element array (or [] = unknown, so
// nothing to compare). It is the line of the PRIMARY category ONLY: a caller who
// asked for lawn first and got only a pest estimate is still owed the lawn
// quote, so a secondary category never widens the ask (call audit
// 2026-10-19, call 5f7d3fc9: primary lawn_care, secondary pest_general). Keeping
// a promise open is the safe direction: it stays in the Owed list. When the
// primary names no line (bundled_waveguard, inspection_only, other, unknown,
// missing) the catalog name (specific_service_name) decides, but only if it
// reads as exactly ONE line; anything else is unknown (old behavior).
function askedServiceLines(stored) {
  // call_log.ai_extraction_enriched is a jsonb object or a JSON string.
  let v2 = stored;
  if (typeof v2 === 'string') { try { v2 = JSON.parse(v2); } catch { return []; } }
  const sr = v2 && typeof v2 === 'object' ? v2.service_request : null;
  if (!sr || typeof sr !== 'object') return [];
  const primary = LINE_BY_V2_CATEGORY[String(sr.primary_service_category || '').toLowerCase()];
  if (primary) return [primary];
  if (typeof sr.specific_service_name === 'string' && sr.specific_service_name.trim()) {
    const named = [...new Set(linesOfKeys(serviceKeysFromText(sr.specific_service_name)))];
    if (named.length === 1) return named;
  }
  return [];
}

// The lines an ESTIMATE row priced ("Pest + Lawn" -> both). Empty array =
// unknown: any line the classifier could not place makes the whole estimate
// unclassifiable (we cannot prove it left the asked line out). Never throws.
function estimateServiceLines(row) {
  try {
    // A plan with one-time rows beside it is read as UNKNOWN (old behavior):
    // classifying one-time rows from display text misreads add-on families and
    // stale engine containers (Codex #6344 r1/r2), and a wrongful rejection
    // would hide a real follow-up. Keeping it open is never the cost here;
    // closing a promise wrongly is the old behavior, not a new one.
    const data = parseEstimateData(row?.estimate_data);
    if (data && oneTimeServicesFromData(data).length) return [];
    const keys = inferEstimateServiceLines({ estimate_data: row?.estimate_data, service_interest: row?.service_interest, pricing_authority: row?.pricing_authority })
      .map((l) => l && l.key);
    if (!keys.length || keys.some((k) => !LINE_BY_KEY[k])) return [];
    return [...new Set(linesOfKeys(keys))];
  } catch {
    return [];
  }
}

// True only on a CLEAR conflict: both sides classified and the estimate's lines
// do not INCLUDE the asked line (a multi-line estimate matches any of its lines).
function serviceLinesConflict(askedLines, estimateLines) {
  if (!askedLines?.length || !estimateLines?.length) return false;
  return !askedLines.some((l) => estimateLines.includes(l));
}

// The asked line for ONE promise, read only from the extraction that filed it:
// a valid V2 result on the same processing generation the promise row carries
// (a schema_failed / normalization_failed candidate is kept for audit only, and
// a later reprocess rewrites the call row but never a staff-confirmed or edited
// promise; Codex #6344 r1). `callRow` = { ai_extraction_enriched,
// v2_extraction_status, processing_generation }. [] = unknown.
function askedLinesForPromise(commitment, callRow) {
  const sameFiling = commitment?.processing_generation != null && callRow?.processing_generation != null
    && String(commitment.processing_generation) === String(callRow.processing_generation);
  return callRow?.v2_extraction_status === 'valid' && sameFiling ? askedServiceLines(callRow.ai_extraction_enriched) : [];
}

// Does this estimate row count toward a promise whose ask is `asked`? Unknown
// on either side keeps it (old behavior); only a clear conflict rejects.
const estimateMatchesAsk = (asked, row) => !serviceLinesConflict(asked, estimateServiceLines(row));

// The call_log columns askedLinesForPromise reads.
const ASK_CALL_COLUMNS = ['id', 'ai_extraction_enriched', 'v2_extraction_status', 'processing_generation'];

module.exports = { askedServiceLines, estimateServiceLines, serviceLinesConflict, askedLinesForPromise, estimateMatchesAsk, ASK_CALL_COLUMNS };
