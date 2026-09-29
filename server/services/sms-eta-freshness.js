'use strict';
// LIVE ETA send-time freshness (independent review + Codex round-1 finding,
// PR #5334; bound-per-claim — pre-push audit P1, round 2): a LIVE ETA fact
// is a draft-time GPS snapshot, but an Agent Review suggestion card can sit
// in the composer up to 48h and a scheduled reply can fire later still, so
// an outgoing body that still makes a minutes-away/ETA claim must be
// revalidated right before it goes out. Conditions checked by the one
// function below and shared by every send seam (the immediate /sms send +
// /schedule-sms queue-time verification in agent-decision-send-checks.js,
// the scheduler's own queued-send path, and the auto-send executor's
// pre-send check):
//   1. the draft itself is still fresh — within ETA_FRESHNESS_WINDOW_MS of
//      input_snapshot.facts_generated_at. Codex round-4 P2: this applies
//      ONLY to a claim that states an actual MINUTES figure — a status-only
//      claim ("the tech is on the way", no number) carries nothing that can
//      go stale, and is instead rechecked against the CURRENT tracker state
//      alone (below), same as the tracking-link-only path.
//   2. the snapshot is the current, grouped shape — { entries: [{ minutes,
//      scheduledServiceIds, trackTokens }] }, one entry per distinct LIVE
//      ETA the draft carried (grouped-stop siblings share one entry). Every
//      minutes figure the outgoing body actually claims is bound to the ONE
//      entry whose `minutes` matches it; a claim that matches no entry, or
//      matches more than one (ambiguous — two distinct stops that happen to
//      share the same minutes figure), fails closed rather than guess which
//      stop it meant.
//   3. the visit(s) behind EACH bound entry are still customer-facing
//      en_route (a cheap status/track_state read — no fresh GPS/Distance
//      Matrix call of its own: re-resolving the number here would just
//      repeat the redundant lookup finding #4 calls out in
//      sms-amount-recheck.js) — never any OTHER entry's visits: with two
//      distinct stops/techs, a reply quoting the completed visit's number
//      must not pass because some OTHER stop is still en route.
//   4. Codex round-4 P2: a reply that shares ONLY the /track/:token link (no
//      minutes figure, no arrival wording at all) used to skip every check
//      above entirely — `outgoingBody` is scanned for a /track/ link
//      independently of the minutes/arrival claim detection, and any link
//      found must belong to THIS draft's own snapshot (via each entry's
//      `trackTokens`) and its visit(s) must still be en route OR on site —
//      a link to a stop that has since gone terminal, or a stray/old link
//      that never belonged to this snapshot at all, fails closed.
// Missing evidence fails CLOSED: no live_eta_snapshot, a snapshot in the old
// flat shape (no `entries` — that shape never shipped to prod, this branch
// isn't merged), no facts_generated_at, or a claim that can't be bound to
// exactly one entry, plus a minutes claim in the outgoing body, all block
// the send — exactly like every other guard in this family (amounts, open
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
// re-blocks past its own deadline (sms-followup-sla.js). Applies only to a
// claim carrying a stated minutes figure — see the status-only and
// tracking-link-only paths below, which recheck the CURRENT tracker state
// instead of this draft-time window.
const ETA_FRESHNESS_WINDOW_MS = 15 * 60 * 1000;

// A /track/:token link anywhere in the outgoing body (Codex round-4 P2) —
// matched on the bare path, never a full URL parse, since the send path
// (and comms-lint) can strip the https:// scheme before or after this runs;
// "/track/" itself never appears in ordinary customer copy.
const TRACK_LINK_TOKEN_RE = /\/track\/([A-Za-z0-9_-]+)/g;

function extractTrackTokens(text) {
  const tokens = new Set();
  const re = new RegExp(TRACK_LINK_TOKEN_RE.source, TRACK_LINK_TOKEN_RE.flags);
  let m;
  while ((m = re.exec(String(text || '')))) tokens.add(m[1]);
  return [...tokens];
}

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
  const { findEtaMinutesClaims, bodyMentionsArrival } = require('./sms-shadow-drafter'); // lazy: avoids a require cycle at module load
  const claims = findEtaMinutesClaims(outgoingBody);
  // Backstop (audit P1, round 4): the claim parser can't read every way a
  // person or model writes an ETA. A body that talks about the tech arriving
  // is checked whenever the draft carried a LIVE ETA, or whenever it mentions
  // minutes at all — every snapshot entry must then still be live and fresh.
  const snapshotHasEntries = Array.isArray(liveEtaSnapshot?.entries) && liveEtaSnapshot.entries.length > 0;
  const unparsedArrivalClaim = !claims.length && bodyMentionsArrival(outgoingBody)
    && (snapshotHasEntries || /\b(?:min(?:ute)?s?)\b/i.test(String(outgoingBody || '')));
  const trackTokens = extractTrackTokens(outgoingBody);
  const hasTrackLink = trackTokens.length > 0;
  if (!claims.length && !unparsedArrivalClaim && !hasTrackLink) return null;

  // Only the current grouped shape is accepted — { entries: [{ minutes,
  // scheduledServiceIds, trackTokens }] }. A missing/malformed snapshot, or
  // the old flat shape (no `entries`), fails closed exactly like no snapshot
  // at all.
  const entries = Array.isArray(liveEtaSnapshot?.entries)
    ? liveEtaSnapshot.entries.filter((e) => e && Number.isFinite(e.minutes) && Array.isArray(e.scheduledServiceIds) && e.scheduledServiceIds.length)
    : [];
  if (!entries.length) return 'eta_claim_no_snapshot';

  // Tracking-link-only path (Codex round-4 P2): no minutes figure, no
  // arrival wording — a reply that shares ONLY the link. Bind it directly by
  // token (never by "the one live entry", since a link genuinely names ONE
  // visit) so more than one live ETA in the snapshot is not itself
  // disqualifying here the way it is for an unbound minutes/arrival claim
  // below. A token this draft's snapshot never minted fails closed.
  if (!claims.length && !unparsedArrivalClaim) {
    const linkedEntries = entries.filter((e) => Array.isArray(e.trackTokens) && e.trackTokens.some((t) => trackTokens.includes(t)));
    if (!linkedEntries.length) return 'eta_claim_untracked_link';
    return checkEntriesStillLive({ boundEntries: linkedEntries, allowOnSite: true, dbh });
  }

  if (entries.length > 1) return 'eta_claim_ambiguous';

  let boundEntries;
  if (unparsedArrivalClaim) {
    // Status-only claim (Codex round-4 P2): "the tech is on the way" carries
    // no minutes figure to go stale — recheck ONLY whether the tracker still
    // says en route right now. The 15-minute freshness window below is about
    // a STATED NUMBER outliving the moment it was true; a bare status claim
    // never carries one, so the window never applies to it.
    boundEntries = [...entries];
  } else {
    const draftedAt = parseDraftedAt(factsGeneratedAt);
    if (!draftedAt) return 'eta_claim_no_facts_time';
    if (now.getTime() - draftedAt.getTime() > ETA_FRESHNESS_WINDOW_MS) return 'eta_claim_stale_facts';

    // Bind each DISTINCT claimed minutes figure to exactly one snapshot entry
    // — never to the snapshot's ids as a whole, which is exactly the bug this
    // round fixes (a claim about a completed stop must not pass on some other
    // stop's still-en_route status).
    const claimedMinutes = [...new Set(claims.map((c) => c.minutes))];
    boundEntries = [];
    for (const minutes of claimedMinutes) {
      const matches = entries.filter((e) => e.minutes === minutes);
      if (matches.length === 0) return 'eta_claim_unbound';
      if (matches.length > 1) return 'eta_claim_ambiguous';
      boundEntries.push(matches[0]);
    }
  }

  // A minutes/arrival claim that ALSO carries a track link must have that
  // link genuinely belong to the SAME bound visit(s) — never let a
  // mismatched or stale link ride along on an otherwise-valid claim.
  if (hasTrackLink) {
    const linkedOk = boundEntries.some((e) => Array.isArray(e.trackTokens) && e.trackTokens.some((t) => trackTokens.includes(t)));
    if (!linkedOk) return 'eta_claim_untracked_link';
  }

  return checkEntriesStillLive({ boundEntries, allowOnSite: false, dbh });
}

// Shared "is the bound entry's visit still customer-facing live" recheck —
// en_route only for a minutes/status claim (an ETA number or "on the way"
// stops being true once the tech has arrived), en_route OR on_site for a
// tracking-link-only share (the link itself never claims a number or
// "still coming", so arrival doesn't make sharing it stale — only the visit
// going fully terminal, or never having belonged to this snapshot, does).
async function checkEntriesStillLive({ boundEntries, allowOnSite, dbh }) {
  try {
    const { customerTrackState } = require('./track-transitions');
    const allIds = [...new Set(boundEntries.flatMap((e) => e.scheduledServiceIds))];
    const rows = await dbh('scheduled_services').whereIn('id', allIds).select('id', 'status', 'track_state');
    const liveStates = allowOnSite ? new Set(['en_route', 'on_property']) : new Set(['en_route']);
    const liveById = new Map(rows.map((row) => [row.id, liveStates.has(customerTrackState(row))]));
    // EACH bound entry must have at least one of ITS OWN visits still live —
    // a different entry's live visit never covers this one.
    const allBoundEntriesLive = boundEntries.every((entry) => entry.scheduledServiceIds.some((id) => liveById.get(id)));
    if (!allBoundEntriesLive) return 'eta_claim_no_longer_en_route';
  } catch (err) {
    logger.warn(`[sms-eta-freshness] en_route recheck failed: ${err.message}; blocking send`);
    return 'eta_claim_recheck_failed';
  }

  return null;
}

module.exports = { etaClaimBlockReason, ETA_FRESHNESS_WINDOW_MS };
