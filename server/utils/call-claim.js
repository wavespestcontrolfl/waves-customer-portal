'use strict';

// The call-processing claim predicates, shared by the processor (reclaim of a stalled claim) and
// by routes that must know whether a pass is working a call right now. Moved here unchanged from
// call-recording-processor.js so a route needn't load the whole processor.

const LEGACY_CLAIM_QUIET_MINUTES = 10;
// What a human forcing a reprocess waits for a claim that IS beating.
const FORCE_CLAIM_QUIET_MINUTES = 3;
// COALESCE, not a bare comparison: with a NULL processing_started_at the
// comparison yields NULL, NOT(NULL) is NULL, and the row would match NEITHER
// branch — permanently unreclaimable, the worst possible bug in a lock.
const CURRENT_BEAT = 'processing_heartbeat_at IS NOT NULL'
  + ' AND processing_heartbeat_at >= COALESCE(processing_started_at, processing_heartbeat_at)';
const reclaimableClaim = (quietMinutes) => "("
  + `(${CURRENT_BEAT} AND processing_heartbeat_at < NOW() - INTERVAL '${quietMinutes} minutes')`
  + ` OR (NOT (${CURRENT_BEAT}) AND`
  + ` COALESCE(processing_started_at, updated_at) < NOW() - INTERVAL '${LEGACY_CLAIM_QUIET_MINUTES} minutes')`
  + ")";

// A pass is working this call RIGHT NOW: it holds the processing claim and the claim has not gone
// quiet long enough to be reclaimed (a crashed pass stops beating and falls out of this after the
// same legacy window the reclaim itself uses, so it never blocks anyone forever). The operator
// link route refuses a call in this state ('already_processing'); the household card's Resolve /
// Dismiss refuse it too, judged under the per-call triage lock the card filer also holds.
const ACTIVE_CLAIM_SQL = `processing_status = 'processing' AND processing_token IS NOT NULL AND NOT ${reclaimableClaim(LEGACY_CLAIM_QUIET_MINUTES)}`;

module.exports = { LEGACY_CLAIM_QUIET_MINUTES, FORCE_CLAIM_QUIET_MINUTES, CURRENT_BEAT, reclaimableClaim, ACTIVE_CLAIM_SQL };
