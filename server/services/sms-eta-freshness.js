'use strict';
// LIVE ETA send-time freshness (independent review + Codex round-1 finding,
// PR #5334): a LIVE ETA fact is a draft-time GPS snapshot, but an Agent
// Review suggestion card can sit in the composer up to 48h and a scheduled
// reply can fire later still, so an outgoing body that still makes a
// minutes-away/ETA claim must be revalidated right before it goes out. Two
// conditions, BOTH required, checked by the one function below and shared
// by every send seam (the immediate /sms send + /schedule-sms queue-time
// verification in agent-decision-send-checks.js, the scheduler's own
// queued-send path, and the auto-send executor's pre-send check):
//   1. the SAME visit(s) the draft's LIVE ETA fact was drawn from are still
//      customer-facing en_route (a cheap status/track_state read — no fresh
//      GPS/Distance Matrix call of its own: re-resolving the number here
//      would just repeat the redundant lookup finding #4 calls out in
//      sms-amount-recheck.js).
//   2. the draft itself is still fresh — within ETA_FRESHNESS_WINDOW_MS of
//      input_snapshot.facts_generated_at.
// Missing evidence fails CLOSED: no live_eta_snapshot, or no
// facts_generated_at, plus a minutes claim in the outgoing body, blocks the
// send — exactly like every other guard in this family (amounts, open
// times, the follow-up SLA phrase).

const db = require('../models/db');
const logger = require('./logger');

// 15 minutes: long enough that an ordinary reviewer accept/edit cycle (a
// human reading a composer card and clicking Send) never gets blocked by
// its own just-drafted reply, short enough that the GPS position + traffic
// conditions behind the number — themselves re-checked on every poll of the
// customer's own tracking page — haven't gone stale. A queued/scheduled
// send that sits past this window re-blocks rather than repeat a number
// that may no longer be true, the same way the follow-up SLA phrase
// re-blocks past its own deadline (sms-followup-sla.js).
const ETA_FRESHNESS_WINDOW_MS = 15 * 60 * 1000;

function parseDraftedAt(factsGeneratedAt) {
  if (factsGeneratedAt instanceof Date) return factsGeneratedAt;
  if (typeof factsGeneratedAt === 'string' && factsGeneratedAt) {
    const parsed = new Date(factsGeneratedAt);
    if (Number.isFinite(parsed.getTime())) return parsed;
  }
  return null;
}

/**
 * null when the outgoing body may go out, else a short reason string the
 * caller logs before blocking/superseding. `liveEtaSnapshot` and
 * `factsGeneratedAt` are the two fields sms-shadow-drafter persists on
 * input_snapshot (live_eta_snapshot / facts_generated_at) — callers that
 * already hold a parsed decision snapshot pass those fields straight
 * through; the auto-send executor passes its in-memory claim copies
 * instead of round-tripping through JSON.
 */
async function etaClaimBlockReason({ liveEtaSnapshot = null, factsGeneratedAt = null, outgoingBody, now = new Date(), dbh = db }) {
  const { replyClaimsEtaMinutes } = require('./sms-shadow-drafter'); // lazy: avoids a require cycle at module load
  if (!replyClaimsEtaMinutes(outgoingBody)) return null;

  const ids = Array.isArray(liveEtaSnapshot?.scheduledServiceIds)
    ? liveEtaSnapshot.scheduledServiceIds.filter((id) => id != null)
    : [];
  if (!ids.length) return 'eta_claim_no_snapshot';

  const draftedAt = parseDraftedAt(factsGeneratedAt);
  if (!draftedAt) return 'eta_claim_no_facts_time';
  if (now.getTime() - draftedAt.getTime() > ETA_FRESHNESS_WINDOW_MS) return 'eta_claim_stale_facts';

  try {
    const { customerTrackState } = require('./track-transitions');
    const rows = await dbh('scheduled_services').whereIn('id', ids).select('status', 'track_state');
    const stillLive = rows.some((row) => customerTrackState(row) === 'en_route');
    if (!stillLive) return 'eta_claim_no_longer_en_route';
  } catch (err) {
    logger.warn(`[sms-eta-freshness] en_route recheck failed: ${err.message}; blocking send`);
    return 'eta_claim_recheck_failed';
  }

  return null;
}

module.exports = { etaClaimBlockReason, ETA_FRESHNESS_WINDOW_MS };
