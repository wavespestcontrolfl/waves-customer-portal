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
//      must not pass because some OTHER stop is still en route. Codex
//      round-7 P2: for a minutes/status claim (never the tracking-link-only
//      path, which names one visit by its own token), EVERY sibling of a
//      grouped entry must be live (`every()`), not just one (`some()`) — a
//      claim about the group ("your techs are 9 minutes away") implicitly
//      covers every member, so one sibling going terminal (cancelled/
//      skipped/completed) fails the whole entry closed even while another
//      sibling sharing the physical stop is still en route.
//   3a. Codex round-7 P2 (structural default-deny): every earlier round of
//      this PR added one more arrival-trigger-word to the phrase list that
//      decides whether a plain minutes figure is a claim at all ("on the
//      way", written numbers, ranges, "from you", bare "ETA: 20", "20
//      minutes to go") — an open-ended enumeration that keeps missing new
//      phrasings. Once there's a live ETA to check a claim against (a
//      snapshot with entries, or a /track/ link), the trigger-word list is
//      abandoned for a plain "N minute(s)" figure: it is a claim by default
//      UNLESS its own clause is an explicit non-arrival duration (dry time,
//      wait-before-pets/re-entry, "takes about", "lasts") — see
//      findGroundedMinutesFigures in sms-shadow-drafter.js.
//   4. Codex round-4 P2: a reply that shares ONLY the /track/:token link (no
//      minutes figure, no arrival wording at all) used to skip every check
//      above entirely — `outgoingBody` is scanned for a /track/ link
//      independently of the minutes/arrival claim detection, and any link
//      found must belong to THIS draft's own snapshot (via each entry's
//      `trackTokens`) and its visit(s) must still be en route OR on site —
//      a link to a stop that has since gone terminal, or a stray/old link
//      that never belonged to this snapshot at all, fails closed.
//   5. Codex round-5 P2: whenever the outgoing body carries a /track/:token
//      link (link-only, or riding along a minutes/status claim), each such
//      token's OWN track_token_expires_at is re-read and must still be live
//      — a stale row still marked en_route/on_property is not enough if the
//      customer-facing token itself has already expired. A missing expiry
//      also fails closed here (never the public tracking route's own
//      fail-OPEN default for a legacy row) because the schema normally
//      stamps one the moment a token is minted (backfill + INSERT/
//      reschedule triggers, migrations 20260422000009/20260429000002/
//      20260505000001) — a live-ETA-eligible row missing it is unexpected,
//      not trusted. Codex round-6 P2: the token's OWN row must also itself
//      be customer-facing live — a grouped-stop entry's `some()`-across-
//      siblings liveness check (condition 3) must never let a cancelled
//      sibling's own token ride through because another sibling sharing the
//      same physical stop is still en route.
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
// "/track/" itself never appears in ordinary customer copy. Case-INSENSITIVE
// (Codex round-10 P2): the customer-facing React route is not case-sensitive,
// so "portal.example/Track/<token>" is a working link and must be validated
// like "/track/<token>"; the host is never matched at all (path only), and
// the captured token keeps its own case (tokens are case-sensitive).
const TRACK_LINK_TOKEN_RE = /\/track\/([A-Za-z0-9_-]+)/gi;

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

// Codex round-5 P2: deliberately NOT track-token-expiry.js's isTrackTokenLive
// — that helper fails OPEN on a missing expiry (a legacy row with no
// track_token_expires_at at all is treated as still live), which is the
// right default for a customer who already has the link open on the public
// tracking page. This send-time gate decides whether Waves is about to HAND
// OUT a link, so it fails CLOSED instead: any expiry that is missing,
// unparseable, or in the past blocks the send.
function sendTimeTrackTokenLive(expiresAt) {
  if (!expiresAt) return false;
  const expiresMs = new Date(expiresAt).getTime();
  return Number.isFinite(expiresMs) && expiresMs > Date.now();
}

// The send-time decision is three phases (Codex round-10 P2, PR #5334 —
// split from one 43-branch function; each phase is its own function so a
// future safety change touches exactly one of them):
//   1. classifyEtaBody      — what does the outgoing body CLAIM?
//   2. bindEtaClaim         — which snapshot entry (or entries) does that
//                             claim bind to, and is the draft fresh enough?
//   3. checkEntriesStillLive — are those visits (and each /track/ token)
//                             still live right now? (below)

// Phase 1. Every structural default-deny / backstop rule from the header
// comment lives here and only here. Lazy require: avoids a require cycle at
// module load.
//   claims             minutes figures (trigger-based, unioned with the
//                      structural default-deny once there's a snapshot or a
//                      /track/ link to check them against — Codex round-7)
//   timedArrivalClaim  a vague/unread timed phrase ("half an hour",
//                      "shortly", an arrival digit the parser couldn't read,
//                      an hour word normalization couldn't convert) — fails
//                      closed as unbound; ages out like a stated number
//   unparsedStatusClaim pure status copy ("on the way") — rechecked against
//                      the CURRENT tracker state only, no freshness window
function classifyEtaBody({ outgoingBody, snapshotHasEntries }) {
  const drafter = require('./sms-shadow-drafter');
  const trackTokens = extractTrackTokens(outgoingBody);
  const hasTrackLink = trackTokens.length > 0;
  const liveContext = snapshotHasEntries || hasTrackLink;
  const claims = liveContext
    ? [...drafter.findEtaMinutesClaims(outgoingBody), ...drafter.findGroundedMinutesFigures(outgoingBody)]
    : drafter.findEtaMinutesClaims(outgoingBody);
  const unreadTimed = drafter.bodyHasTimedArrivalPhrase(outgoingBody) || drafter.bodyHasUnclassifiedArrivalDigit(outgoingBody);
  // Codex round-9 P2: an hour word normalization could NOT turn into minutes
  // is a timed claim even beside a real minutes figure, once a live ETA
  // context exists to hold the body to.
  const unreadHours = liveContext && drafter.bodyHasTimedArrivalPhrase(outgoingBody, { unnormalizedHoursOnly: true });
  // Codex round-11 P2: a number word that could not be converted to digits
  // ("a thousand minutes") is a timed claim on every path.
  const unreadNumbers = drafter.bodyHasTimedArrivalPhrase(outgoingBody, { unconvertedNumbersOnly: true });
  const timedArrivalClaim = (!claims.length && unreadTimed) || unreadHours || unreadNumbers;
  // Backstop (audit P1, round 4): a body that talks about the tech arriving
  // is checked whenever the draft carried a LIVE ETA, or whenever it
  // mentions minutes at all.
  const mentionsMinutes = snapshotHasEntries || /\b(?:min(?:ute)?s?)\b/i.test(String(outgoingBody || ''));
  const unparsedStatusClaim = !claims.length && !timedArrivalClaim && drafter.bodyMentionsArrival(outgoingBody) && mentionsMinutes;
  return {
    claims, trackTokens, hasTrackLink, timedArrivalClaim, unparsedStatusClaim,
    hasClaim: claims.length > 0 || timedArrivalClaim || unparsedStatusClaim,
  };
}

// Only the current grouped shape is accepted — { entries: [{ minutes,
// scheduledServiceIds, trackTokens }] }. A missing/malformed snapshot, or the
// old flat shape (no `entries`), yields no entries and fails closed.
function usableSnapshotEntries(liveEtaSnapshot) {
  return Array.isArray(liveEtaSnapshot?.entries)
    ? liveEtaSnapshot.entries.filter((e) => e && Number.isFinite(e.minutes) && Array.isArray(e.scheduledServiceIds) && e.scheduledServiceIds.length)
    : [];
}

// The entries whose own /track/ token(s) appear in the outgoing body.
function entriesForTokens(entries, tokens) {
  return entries.filter((e) => Array.isArray(e.trackTokens) && e.trackTokens.some((t) => tokens.includes(t)));
}

// A stated timeframe ages out: the draft's facts must be within the
// freshness window AND (Codex round-11 P2) the GPS fix behind the entry's
// figure must still be fresh to the public tracker — the snapshot entry's
// `fixExpiresAtMs` (fix time + the tracker's staleness window). An entry
// without the field (an older snapshot) keeps the draft-window-only rule.
// null when fresh.
function draftFreshnessReason(factsGeneratedAt, now, entry = null) {
  const draftedAt = parseDraftedAt(factsGeneratedAt);
  if (!draftedAt) return 'eta_claim_no_facts_time';
  if (now.getTime() - draftedAt.getTime() > ETA_FRESHNESS_WINDOW_MS) return 'eta_claim_stale_facts';
  return Number.isFinite(entry?.fixExpiresAtMs) && now.getTime() > entry.fixExpiresAtMs ? 'eta_claim_stale_facts' : null;
}

// Phase 2a — status-only claim ("the tech is on the way"): no minutes figure
// to go stale, so no freshness window. With one live entry it binds to it;
// with several, the /track/ token in the body selects the entry it names
// (Codex round-10 P2) — only an unselectable status claim is ambiguous.
function bindStatusClaim(claim, entries) {
  if (entries.length === 1) return { entries: [...entries] };
  const linked = entriesForTokens(entries, claim.trackTokens);
  return linked.length ? { entries: linked } : { reason: 'eta_claim_ambiguous' };
}

// Phase 2b — every distinct minutes figure claimed must equal the ONE live
// entry's minutes; a vague/unread timed claim has no exact number to bind, so
// it fails closed as unbound after passing the same freshness window.
function bindTimedOrMinutesClaim(claim, entries, { factsGeneratedAt, now }) {
  const [entry] = entries;
  const staleReason = draftFreshnessReason(factsGeneratedAt, now, entry);
  if (staleReason) return { reason: staleReason };
  if (claim.timedArrivalClaim) return { reason: 'eta_claim_unbound' };
  return claim.claims.every((c) => c.minutes === entry.minutes) ? { entries: [entry] } : { reason: 'eta_claim_unbound' };
}

// Phase 2. Returns { entries } (the bound entries) or { reason }.
function bindEtaClaim(claim, entries, freshness) {
  if (claim.unparsedStatusClaim) return bindStatusClaim(claim, entries);
  // Two distinct live ETAs (Codex r3): a minutes/timed claim can't be tied
  // to the right visit deterministically, so even the right number fails
  // closed.
  if (entries.length > 1) return { reason: 'eta_claim_ambiguous' };
  return bindTimedOrMinutesClaim(claim, entries, freshness);
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
  const claim = classifyEtaBody({ outgoingBody, snapshotHasEntries: Array.isArray(liveEtaSnapshot?.entries) && liveEtaSnapshot.entries.length > 0 });
  if (!claim.hasClaim && !claim.hasTrackLink) return null;
  const entries = usableSnapshotEntries(liveEtaSnapshot);
  if (!entries.length) return 'eta_claim_no_snapshot';

  // Tracking-link-only path (Codex round-4 P2): no minutes figure, no
  // arrival wording — bound directly by token (a link genuinely names ONE
  // visit), so more than one live ETA is not disqualifying here. A token
  // this draft's snapshot never minted fails closed.
  if (!claim.hasClaim) {
    const linkedEntries = entriesForTokens(entries, claim.trackTokens);
    if (!linkedEntries.length) return 'eta_claim_untracked_link';
    return checkEntriesStillLive({ boundEntries: linkedEntries, allowOnSite: true, dbh, trackTokensToVerify: claim.trackTokens });
  }

  const bound = bindEtaClaim(claim, entries, { factsGeneratedAt, now });
  if (bound.reason) return bound.reason;
  // A minutes/arrival claim that ALSO carries a track link must have that
  // link belong to the SAME bound visit(s) — never let a mismatched or stale
  // link ride along on an otherwise-valid claim.
  if (claim.hasTrackLink && !entriesForTokens(bound.entries, claim.trackTokens).length) return 'eta_claim_untracked_link';
  return checkEntriesStillLive({ boundEntries: bound.entries, allowOnSite: false, dbh, trackTokensToVerify: claim.hasTrackLink ? claim.trackTokens : [] });
}

// Shared "is the bound entry's visit still customer-facing live" recheck —
// en_route only for a minutes/status claim (an ETA number or "on the way"
// stops being true once the tech has arrived), en_route OR on_site for a
// tracking-link-only share (the link itself never claims a number or
// "still coming", so arrival doesn't make sharing it stale — only the visit
// going fully terminal, or never having belonged to this snapshot, does).
// `trackTokensToVerify` (Codex round-5 P2): the exact /track/:token(s) found
// in the outgoing body, if any — each one's OWN track_token_expires_at is
// checked too, never inferred from the visit's status/track_state alone, so
// an expired (or unexpectedly missing) token blocks the send even while its
// row still reads en_route/on_property.
async function checkEntriesStillLive({ boundEntries, allowOnSite, dbh, trackTokensToVerify = [] }) {
  try {
    const { customerTrackState } = require('./track-transitions');
    const allIds = [...new Set(boundEntries.flatMap((e) => e.scheduledServiceIds))];
    const rows = await dbh('scheduled_services').whereIn('id', allIds).select('id', 'status', 'track_state', 'track_view_token', 'track_token_expires_at');
    const liveStates = allowOnSite ? new Set(['en_route', 'on_property']) : new Set(['en_route']);
    const liveById = new Map(rows.map((row) => [row.id, liveStates.has(customerTrackState(row))]));
    // Codex round-7 P2: a minutes/status claim about a grouped entry
    // implicitly covers EVERY sibling in it ("your techs are 9 minutes
    // away" means both the pest and lawn stop, not just whichever one is
    // still moving) — so EVERY sibling of a bound entry must still be
    // customer-facing live (`every()`), not just one of them (`some()`): a
    // cancelled/skipped/completed sibling fails the whole entry closed, even
    // while another sibling sharing the physical stop is still en route.
    // The tracking-link-only path is deliberately NOT changed here — sharing
    // a link names ONE visit (the token's own owning row, verified below by
    // trackTokensToVerify), never a claim about the whole group, so it keeps
    // its existing `some()` semantics.
    const allBoundEntriesLive = allowOnSite
      ? boundEntries.every((entry) => entry.scheduledServiceIds.some((id) => liveById.get(id)))
      : boundEntries.every((entry) => entry.scheduledServiceIds.every((id) => liveById.get(id)));
    if (!allBoundEntriesLive) return 'eta_claim_no_longer_en_route';

    if (trackTokensToVerify.length) {
      const rowByToken = new Map(rows.filter((row) => row.track_view_token).map((row) => [row.track_view_token, row]));
      for (const token of trackTokensToVerify) {
        const row = rowByToken.get(token);
        // A token with no matching row here would already have failed the
        // untracked-link check above — guarded again defensively rather than
        // assumed live.
        if (!row) return 'eta_claim_link_expired';
        // Codex round-6 P2: allBoundEntriesLive above uses `some()` across a
        // grouped entry's sibling ids — a cancelled/terminal sibling's own
        // token must never ride through just because ANOTHER sibling sharing
        // the same physical stop is still live. The row that OWNS this exact
        // token must itself be customer-facing live.
        if (!liveById.get(row.id)) return 'eta_claim_link_expired';
        if (!sendTimeTrackTokenLive(row.track_token_expires_at)) return 'eta_claim_link_expired';
      }
    }
  } catch (err) {
    logger.warn(`[sms-eta-freshness] en_route recheck failed: ${err.message}; blocking send`);
    return 'eta_claim_recheck_failed';
  }

  return null;
}

module.exports = { etaClaimBlockReason, ETA_FRESHNESS_WINDOW_MS };
