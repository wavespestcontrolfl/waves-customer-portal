'use strict';

/**
 * call_log.invalid_reason: ONE answer to "why was this inbound call not a real
 * prospect?", so bad calls can be counted per lead source (owner 2026-11-26).
 *
 * Before this, the same fact sat in four places that disagree: the AI
 * extraction's is_spam, its call_type (spam / wrong_number), the layered spam
 * classifier's verdict (disposition spam_discarded), and a lead_quality of
 * spam. This module reads those existing signals and writes nothing to them.
 * It changes no routing, no disposition and nothing a caller or customer
 * hears or receives.
 *
 * Allowed values: spam, wrong_number, solicitor, out_of_area,
 * service_not_offered, silent. (The migration's CHECK holds the same list.)
 * service_not_offered has no producer in the pipeline today: the resolver
 * honors a `service_not_offered` triage flag when one is ever raised.
 *
 * Precedence, first match wins (the first three follow decideDisposition's own
 * order, so the reason never contradicts the disposition the call received):
 *   1. spam          layered classifier verdict spam, disposition
 *                    spam_discarded, or v2 call_nature robocall
 *   2. wrong_number  v2 call_nature wrong_number, call_type wrong_number,
 *                    disposition wrong_number_closed
 *   3. solicitor     v2 call_nature spam_solicitation
 *   4. spam          the legacy-only signals: is_spam, call_type spam,
 *                    lead_quality spam (extraction or row), processing_status
 *                    spam (a v2 vendor_or_partner is not spam on the folded
 *                    call_type alone)
 *   5. out_of_area   triage flag out_of_service_area, or the address check's
 *                    out_of_service_area status
 *   6. service_not_offered   triage flag service_not_offered
 *   7. silent        v2 call_nature silent_or_noise
 * Otherwise null.
 *
 * resolveInvalidReason is pure. stampInvalidReason is the one writer: the latest pass
 * wins (null included), and it never throws (a stamp problem
 * must not fail call processing).
 */

const logger = require('./logger');

const INVALID_REASONS = Object.freeze(['spam', 'wrong_number', 'solicitor', 'out_of_area', 'service_not_offered', 'silent']);

const lower = (v) => String(v == null ? '' : v).trim().toLowerCase();
const truthy = (v) => v === true || v === 'true';

// The signals, lower-cased and flattened.
function factsOf({ legacy, v2, v2Result, spamVerdict, disposition, triageFlags, addressStatus, outOfAreaHold }) {
  // A v2 extraction counts only when it validated.
  const extraction = v2 || (v2Result?.status === 'valid' ? v2Result.extraction : null);
  const flags = [...(Array.isArray(extraction?.triage_flags) ? extraction.triage_flags : []), ...(Array.isArray(triageFlags) ? triageFlags : []),
    ...(outOfAreaHold ? ['out_of_service_area'] : [])];
  return {
    nature: lower(extraction?.call_nature),
    callType: lower(legacy?.call_type),
    disposition: lower(disposition),
    verdict: lower(spamVerdict?.verdict),
    addressStatus: lower(addressStatus),
    flags: new Set(flags.map(lower)),
  };
}

// The legacy-only spam signals. extraction-compat folds vendor_or_partner into call_type spam, so a
// partner is not spam by that alone.
function legacySpam(f, { legacy, processingStatus, leadQuality }) {
  return truthy(legacy?.is_spam) || (f.callType === 'spam' && f.nature !== 'vendor_or_partner')
    || [legacy?.lead_quality, leadQuality, processingStatus].some((v) => lower(v) === 'spam');
}

// Ordered rules: the first that holds wins (see the precedence list above).
const RULES = [
  ['spam', (f) => f.verdict === 'spam' || f.disposition === 'spam_discarded' || f.nature === 'robocall'],
  ['wrong_number', (f) => f.nature === 'wrong_number' || f.callType === 'wrong_number' || f.disposition === 'wrong_number_closed'],
  ['solicitor', (f) => f.nature === 'spam_solicitation'],
  ['spam', (f, raw) => legacySpam(f, raw)],
  ['out_of_area', (f) => f.flags.has('out_of_service_area') || f.addressStatus === 'out_of_service_area'],
  ['service_not_offered', (f) => f.flags.has('service_not_offered')],
  ['silent', (f) => f.nature === 'silent_or_noise'],
];

/**
 * @param {object} signals all optional
 * @param {object} [signals.legacy]       the call's ai_extraction (flat legacy shape): is_spam, call_type, lead_quality
 * @param {object} [signals.v2]           the validated v2 extraction: call_nature, triage_flags
 * @param {object} [signals.v2Result]     the processor's v2 result ({ status, extraction }); used when v2 is not given
 * @param {boolean} [signals.outOfAreaHold] the pipeline held the call as out of the service area
 * @param {object} [signals.spamVerdict]  the layered classifier result: { verdict }
 * @param {string} [signals.disposition]  call_log.disposition
 * @param {string} [signals.processingStatus] call_log.processing_status
 * @param {string} [signals.leadQuality]  call_log.lead_quality
 * @param {string[]} [signals.triageFlags] extra triage flags (merged with v2.triage_flags)
 * @param {string} [signals.addressStatus] call_log.enrichment_status / address_status
 * @returns {string|null} one of INVALID_REASONS, or null
 */
function resolveInvalidReason(signals = {}) {
  const f = factsOf(signals);
  const hit = RULES.find(([, holds]) => holds(f, signals));
  return hit ? hit[0] : null;
}

/**
 * Resolve from a stored call_log row (read time, for rows older than the
 * column). A stored invalid_reason wins; otherwise the row's own signals decide.
 * The row's ai_extraction and ai_extraction_enriched may be objects or JSON strings.
 */
function parseJson(value) {
  if (typeof value !== 'string') return value || null;
  try { return JSON.parse(value); } catch { return null; }
}

function resolveInvalidReasonFromRow(row) {
  if (!row) return null;
  if (row.invalid_reason) return row.invalid_reason;
  // A validated v2 extraction (ai_extraction_enriched) counts too, as in the live processor.
  const v2 = row.v2_extraction_status === 'valid' ? parseJson(row.ai_extraction_enriched) : null;
  return resolveInvalidReason({
    legacy: parseJson(row.ai_extraction),
    v2,
    disposition: row.disposition,
    processingStatus: row.processing_status,
    leadQuality: row.lead_quality,
    addressStatus: row.enrichment_status || row.address_status,
  });
}

/**
 * Stamp call_log.invalid_reason for one call after a processing pass. The
 * latest pass wins, null included: a reprocess that turns a bad call into a
 * real lead clears the old reason. Fail soft: returns the written reason, or
 * null, and never throws (a failed write leaves the stored value as it was).
 */
async function stampInvalidReason(database, callId, signals) {
  try {
    if (!callId) return null;
    const reason = resolveInvalidReason(signals);
    await database('call_log').where({ id: callId }).update({ invalid_reason: reason });
    return reason;
  } catch (err) {
    logger.warn(`[call-invalid-reason] stamp failed for call ${callId}: ${err.message}`);
    return null;
  }
}

module.exports = { INVALID_REASONS, resolveInvalidReason, resolveInvalidReasonFromRow, stampInvalidReason };
