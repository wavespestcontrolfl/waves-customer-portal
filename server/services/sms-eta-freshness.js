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
const { publicPortalUrl } = require('../utils/portal-url');
const { stripTrackLinks, sendTimeTrackTokenLive } = require('./sms-track-links');

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

// Every /track/:token link in the outgoing body, scanned as a URL (Codex
// round-4 P2; host + exact path — round-13 P2, PR #5334). The send path (and
// comms-lint) can strip the https:// scheme before or after this runs, so a
// scheme is optional, but a link is only TRUSTED when
//   - its host is the canonical portal origin's host (utils/portal-url's
//     publicPortalUrl — the SAME base the tracking-link builder uses),
//     compared case-insensitively — a valid snapshot token on another host
//     would hand the real token-scoped tracking page to that host;
//   - the path is EXACTLY /track/<token> (case-insensitive, Codex round-10:
//     the React route isn't case-sensitive) with nothing but sentence
//     punctuation after it — no extra path segments, query, or fragment;
//   - it HAS a host (a bare "/track/<token>" names no origin at all); the
//     comparison is host[:port] (single-label hosts like localhost:5173
//     included — round-14 P2).
// The captured token keeps its own case (tokens are case-sensitive). Any
// untrusted /track/ link is a `violation`, refused outright.
// Host forms: dotted names (with optional scheme/port) — and, so a
// CLIENT_URL=http://localhost:5173 style configured origin is recognized
// (Codex round-14 P2), a SINGLE-label host when a scheme or a :port makes it
// unambiguous ("http://localhost", "localhost:5173"). A bare word before
// "/track/" with neither is not a host. host[:port] is compared to the
// configured origin's, so a different port is a different host.
const TRACK_PATH_RE = /^\/track\/([A-Za-z0-9_-]+)$/i;
const LINK_LEADING_RE = /^[(<"'[]+/;
const LINK_TRAILING_RE = /[.,;:!?)\]"'>\u2014\u2013]+$/;
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

function canonicalProtocol() {
  try {
    return new URL(publicPortalUrl()).protocol;
  } catch {
    return 'https:';
  }
}

function canonicalPortalHost() {
  try {
    return new URL(publicPortalUrl()).host.toLowerCase();
  } catch {
    return '';
  }
}

// Whitespace-delimited tokens carrying "/track/" anywhere (Codex round-17 P2):
// each is PARSED as a URL (https:// prepended when schemeless) and trusted only
// when host[:port] equals the canonical portal's, the pathname is EXACTLY
// /track/<token>, and there is no query, fragment or userinfo. A token that
// mentions /track/ but fails any of that — "evil.example/?next=<portal>/track/x",
// "#/track/x", "portal@evil.example/track/x" — is untrusted, as is a hostless
// "/track/x". Sentence punctuation around the link is stripped first.
function parseTrackLink(rawToken, canonicalHost) {
  const token = rawToken.replace(LINK_LEADING_RE, '').replace(LINK_TRAILING_RE, '');
  if (token.startsWith('/')) return null;
  let url;
  try {
    url = new URL(SCHEME_RE.test(token) ? token : `https://${token}`);
  } catch {
    return null;
  }
  const match = TRACK_PATH_RE.exec(url.pathname);
  const clean = !url.search && !url.hash && !url.username && !url.password;
  // An EXPLICIT scheme must equal the canonical portal's (Codex round-19 P2:
  // http:// or ftp:// portal links are refused); schemeless stays allowed.
  const schemeOk = !SCHEME_RE.test(token) || url.protocol === canonicalProtocol();
  return match && clean && schemeOk && url.host.toLowerCase() === canonicalHost ? match[1] : null;
}

function trackLinkTokens(text) {
  return String(text || '').split(/\s+/).filter((t) => t.toLowerCase().includes('/track/'));
}

function scanTrackLinks(text) {
  const tokens = new Set();
  let violation = false;
  const canonicalHost = canonicalPortalHost();
  for (const raw of trackLinkTokens(text)) {
    const trackToken = parseTrackLink(raw, canonicalHost);
    if (trackToken) tokens.add(trackToken);
    else violation = true;
  }
  return { tokens: [...tokens], violation };
}

function extractTrackTokens(text) {
  return scanTrackLinks(text).tokens;
}

function parseDraftedAt(factsGeneratedAt) {
  if (factsGeneratedAt instanceof Date) return factsGeneratedAt;
  if (typeof factsGeneratedAt === 'string' && factsGeneratedAt) {
    const parsed = new Date(factsGeneratedAt);
    if (Number.isFinite(parsed.getTime())) return parsed;
  }
  return null;
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
// Timed claims that carry no parseable exact figure, or one the parser could
// not convert (round 5/6/9/11/13): fail closed as unbound.
function unreadTimedClaim(drafter, outgoingBody, { claims, liveContext }) {
  const unreadTimed = drafter.bodyHasTimedArrivalPhrase(outgoingBody) || drafter.bodyHasUnclassifiedArrivalDigit(outgoingBody);
  // Codex round-9 P2: an hour/day/week word normalization could NOT turn
  // into minutes is a timed claim even beside a real minutes figure, once a
  // live ETA context exists to hold the body to.
  // Round-17 P2: on EVERY path (counted days/weeks/months, like hours) — with no
  // snapshot the timed claim then fails closed as eta_claim_no_snapshot.
  const unreadHours = drafter.bodyHasTimedArrivalPhrase(outgoingBody, { unnormalizedHoursOnly: true });
  // Codex round-11 P2: a number word that could not be converted to digits
  // ("a thousand minutes") is a timed claim on every path.
  const unreadNumbers = drafter.bodyHasTimedArrivalPhrase(outgoingBody, { unconvertedNumbersOnly: true });
  return (!claims.length && unreadTimed) || unreadHours || unreadNumbers;
}

function classifyEtaBody({ outgoingBody: fullBody, snapshotHasEntries }) {
  const drafter = require('./sms-shadow-drafter');
  const trackTokens = extractTrackTokens(fullBody);
  // The link itself is not prose: a token like "a-12-b" must never read as a
  // "12" minutes figure, so claim analysis runs on the body without its
  // /track/ URLs.
  const outgoingBody = stripTrackLinks(fullBody);
  const hasTrackLink = trackTokens.length > 0;
  const liveContext = snapshotHasEntries || hasTrackLink;
  const claims = liveContext
    ? [...drafter.findEtaMinutesClaims(outgoingBody), ...drafter.findGroundedMinutesFigures(outgoingBody)]
    : drafter.findEtaMinutesClaims(outgoingBody);
  const timedArrivalClaim = unreadTimedClaim(drafter, outgoingBody, { claims, liveContext });
  // Codex round-13 P2: "has arrived" / "is here" / "pulled up" states the
  // tech IS on site — a different fact from "on the way" status copy, so it
  // requires the on-site tracker state at send. Only meaningful (and only
  // checked) where a live snapshot/link says which visit it is about.
  const arrivedClaim = liveContext && drafter.bodyHasTimedArrivalPhrase(outgoingBody, { completedArrivalOnly: true });
  // Backstop (audit P1, round 4): a body that talks about the tech arriving
  // is checked whenever the draft carried a LIVE ETA, or whenever it
  // mentions minutes at all.
  const mentionsMinutes = snapshotHasEntries || /\b(?:min(?:ute)?s?)\b/i.test(String(outgoingBody || ''));
  const unparsedStatusClaim = !claims.length && !timedArrivalClaim && !arrivedClaim && drafter.bodyMentionsArrival(outgoingBody) && mentionsMinutes;
  // Round-20: broad default-deny — any visit-status vocabulary at all (see
  // bodyMentionsVisitStatus), whether or not a narrower classifier read it.
  const visitStatusMention = liveContext && drafter.bodyMentionsVisitStatus(outgoingBody);
  const classified = claims.length > 0 || timedArrivalClaim || unparsedStatusClaim || arrivedClaim;
  // Round-16 structural backstop: nothing above read a claim, yet a number sits
  // beside a time unit / arrival word — hold it to the status-claim checks.
  const unclassifiedClaim = liveContext && !classified && drafter.bodyHasTimedArrivalPhrase(outgoingBody, { unclassifiedSignalOnly: true });
  return {
    claims, trackTokens, hasTrackLink, timedArrivalClaim, unparsedStatusClaim, arrivedClaim, unclassifiedClaim, visitStatusMention,
    hasClaim: classified || unclassifiedClaim,
  };
}

// Only the current grouped shape is accepted — { entries: [{ minutes,
// scheduledServiceIds, trackTokens }] }. A missing/malformed snapshot, or the
// old flat shape (no `entries`), yields no entries and fails closed.
function usableSnapshotEntries(liveEtaSnapshot) {
  return Array.isArray(liveEtaSnapshot?.entries)
    ? liveEtaSnapshot.entries.filter((e) => e && (Number.isFinite(e.minutes) || e.minutes === null) && Array.isArray(e.scheduledServiceIds) && e.scheduledServiceIds.length)
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
  // A completed-arrival claim ("has arrived") beside a minutes/timed claim
  // contradicts itself (en route vs on site) — fail closed.
  if (claim.arrivedClaim && (claim.claims.length || claim.timedArrivalClaim)) return { reason: 'eta_claim_unbound' };
  if (claim.unparsedStatusClaim || claim.arrivedClaim) return bindStatusClaim(claim, entries);
  // Two distinct live ETAs (Codex r3): a minutes/timed claim can't be tied
  // to the right visit deterministically, so even the right number fails
  // closed.
  // Only EN-ROUTE stops can be the subject of an ETA figure — an on_property
  // (on-site) group can't — so ambiguity is counted over those alone.
  const enRouteEntries = entries.filter((e) => e.state !== 'on_property');
  if (enRouteEntries.length > 1) return { reason: 'eta_claim_ambiguous' };
  if (!enRouteEntries.length) return { reason: 'eta_claim_unbound' };
  return bindTimedOrMinutesClaim(claim, enRouteEntries, freshness);
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
  // Codex round-13 P2: any /track/ link that is not the canonical origin's exact
  // token path is refused outright, claim or not.
  if (scanTrackLinks(outgoingBody).violation) return 'eta_claim_link_untrusted';
  const claim = classifyEtaBody({ outgoingBody, snapshotHasEntries: Array.isArray(liveEtaSnapshot?.entries) && liveEtaSnapshot.entries.length > 0 });
  const entries = usableSnapshotEntries(liveEtaSnapshot);
  // Round-20 structural rule: wording classification decides WHICH claim to
  // verify, never WHETHER to recheck. A draft that carries a live-ETA/on-site
  // snapshot and whose body touches visit status in ANY form (the broad
  // bodyMentionsVisitStatus vocabulary gate, not a phrase list of claims) is
  // held to the visit-state recheck at send time even when no narrower
  // classifier recognized the wording ("The technician arrived.", "en-route"):
  // each snapshot entry's visits must still be in the state the draft recorded
  // (en route / on site), with the same technician and destination. Body copy
  // with no status vocabulary at all ("Thanks, 5 stars!") is unaffected, as are
  // accurate corrections ("hasn't arrived") and scheduling windows.
  if (!claim.hasClaim && !claim.hasTrackLink) {
    if (!entries.length || !claim.visitStatusMention) return null;
    return checkEntriesStillLive({ boundEntries: entries, allowOnSite: false, recordedState: true, dbh });
  }
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

  // Round-16/17 structural backstop: a NUMERIC signal no parser could read (a
  // number beside a time unit / arrival word) never passes on freshness and
  // liveness alone — it could be any figure, so it must parse and bind exactly,
  // and it did not. (The detector is number-based, so every unclassified
  // signal is numeric.)
  if (claim.unclassifiedClaim) return 'eta_claim_unclassified';
  const bound = bindEtaClaim(claim, entries, { factsGeneratedAt, now });
  if (bound.reason) return bound.reason;
  // A minutes/arrival claim that ALSO carries a track link must have that
  // link belong to the SAME bound visit(s) — never let a mismatched or stale
  // link ride along on an otherwise-valid claim.
  if (claim.hasTrackLink && !entriesForTokens(bound.entries, claim.trackTokens).length) return 'eta_claim_untracked_link';
  return checkEntriesStillLive({ boundEntries: bound.entries, allowOnSite: false, requireOnSite: claim.arrivedClaim, checkFix: claim.claims.length > 0 || claim.timedArrivalClaim, dbh, trackTokensToVerify: claim.hasTrackLink ? claim.trackTokens : [] });
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
const foldStr = (v) => (v == null ? '' : String(v).trim().toLowerCase());
const sameNum = (a, b) => (a == null || b == null ? a == null && b == null : Number(a) === Number(b));
function stampedDestinationMatches(recorded, row) {
  return Boolean(row)
    && String(recorded.propertyId ?? '') === String(row.property_id ?? '')
    && sameNum(recorded.lat, row.lat) && sameNum(recorded.lng, row.lng)
    && foldStr(recorded.line1) === foldStr(row.service_address_line1)
    && foldStr(recorded.zip) === foldStr(row.service_address_zip)
    // Older destinations without a city keep the previous comparison.
    && (recorded.city === undefined || foldStr(recorded.city) === foldStr(row.service_address_city));
}
// Round-21 P2: the figure may have been computed for the CUSTOMER's coordinates
// (a visit with no pin falls back to them), so a re-geocoded customer address
// moves the destination without touching the visit row. Re-derive the SAME
// resolution (live-eta-destination.js) from current rows and require the same
// source and coordinates. A customer row that cannot be read blocks.
async function resolvedDestinationMatches(recorded, row, dbh) {
  const rec = recorded.resolved;
  if (!rec || typeof rec !== 'object') return true; // older snapshot: stamped-field comparison only
  let customer = null;
  if (rec.source === 'customer') {
    if (recorded.customerId == null) return false;
    customer = await dbh('customers').where({ id: recorded.customerId }).first('latitude', 'longitude', 'address_line1', 'zip', 'city');
    if (!customer) return false;
  }
  const { resolveLiveEtaDestination } = require('./live-eta-destination');
  const now = resolveLiveEtaDestination({
    service_lat: row.lat, service_lng: row.lng, service_address_line1: row.service_address_line1, service_address_zip: row.service_address_zip, service_address_city: row.service_address_city,
  }, customer);
  return now.source === (rec.source ?? null) && sameNum(now.lat, rec.lat) && sameNum(now.lng, rec.lng);
}
// An entry that recorded destinations (every entry the aggregator builds does)
// must find EACH of its recorded visits at the same destination; a missing
// row/field pair is a mismatch. Entries from older snapshots without the field
// keep the previous behavior.
async function destinationChanged(boundEntries, rows, dbh) {
  const rowById = new Map(rows.map((row) => [row.id, row]));
  for (const entry of boundEntries) {
    if (!Array.isArray(entry.destinations)) continue;
    for (const d of entry.destinations) {
      const row = d ? rowById.get(d.id) : null;
      if (!row || !stampedDestinationMatches(d, row) || !(await resolvedDestinationMatches(d, row, dbh))) return true;
    }
  }
  return false;
}
// ONE per-entry identity comparison (round-22 P2): WHO is coming (technician),
// in WHICH vehicle (tracker device fingerprint), and WHERE (destination). Each
// bound entry recorded these at draft time; any change — or an unreadable
// current value — makes the figure/status about something else. `checkPerson`
// is off for a link-only share, which names no technician or vehicle (the
// destination still applies: the link routes to the visit's current address).
// Returns the block reason or null.
// The ETA for one snapshot entry recomputed NOW: same resolution as the
// drafter (context-aggregator.resolveLiveEtaMinutesUncached -> fresh position of
// the technician's configured device -> bounded route-provider ETA, google
// results only) for the destination the entry recorded (already verified
// unchanged by destinationChanged). null when anything is unavailable.
// A moving truck's ETA drifts between draft and send, so a newer fix is
// accepted when the recomputed figure is still close to the claimed one:
// within max(2 min, 20% of the claim). Unavailable recompute => no match.
const RECOMPUTE_TOLERANCE_MIN = 2;
const RECOMPUTE_TOLERANCE_PCT = 0.2;
function recomputedStillMatches(claimed, recomputed) {
  if (!Number.isFinite(claimed) || !Number.isFinite(recomputed)) return false;
  const tolerance = Math.max(RECOMPUTE_TOLERANCE_MIN, Math.round(claimed * RECOMPUTE_TOLERANCE_PCT));
  return Math.abs(recomputed - claimed) <= tolerance;
}
async function recomputedLiveEtaMinutes(entry, dbh) {
  try {
    const dest = (entry.destinations || []).map((d) => d?.resolved).find((r) => r && Number.isFinite(Number(r.lat)) && Number.isFinite(Number(r.lng)) && r.lat != null && r.lng != null);
    if (!dest) return null;
    const tech = await dbh('technicians').where({ id: entry.technicianId }).first('bouncie_imei', 'updated_at');
    if (!tech) return null;
    const fact = await require('./context-aggregator').resolveLiveEtaMinutesUncached(
      { technician_id: entry.technicianId, tech_bouncie_imei: tech.bouncie_imei, tech_updated_at: tech.updated_at },
      { lat: Number(dest.lat), lng: Number(dest.lng) },
    );
    return fact && Number.isFinite(fact.minutes) ? fact.minutes : null;
  } catch (err) {
    logger.warn(`[sms-eta-freshness] live ETA recompute failed: ${err.message}; blocking send`);
    return null;
  }
}
async function entryIdentityReason(boundEntries, rows, dbh, { checkPerson, checkFix = false }) {
  if (checkPerson) {
    const techById = new Map(rows.map((row) => [row.id, row.technician_id]));
    // Round-18: only entries that recorded a technicianId are checked.
    if (boundEntries.some((entry) => entry.technicianId != null
      && entry.scheduledServiceIds.some((id) => String(techById.get(id) ?? '') !== String(entry.technicianId)))) return 'eta_claim_tech_changed';
    // Round-22: an entry that recorded the ETA's tracker device must still map
    // its technician to that same device (admin-geofence can re-point it).
    for (const entry of boundEntries) {
      if (!entry.deviceImei) continue;
      const tech = await dbh('technicians').where({ id: entry.technicianId }).first('bouncie_imei');
      const { deviceFingerprint } = require('./live-eta-destination');
      if (!tech || deviceFingerprint(tech.bouncie_imei) !== entry.deviceImei) return 'eta_claim_device_changed';
    }
  }
  if (await destinationChanged(boundEntries, rows, dbh)) return 'eta_claim_destination_changed';
  // Round-24: a MINUTES figure is about one GPS fix. If the tracker has since
  // stored a NEWER fix (tech_status.location_updated_at), the public tracker has
  // recomputed from different coordinates — but pings arrive every few seconds
  // while driving, so refusing on any newer ping would make a reviewed/scheduled
  // ETA reply almost never sendable. Instead the ETA is RECOMPUTED right now
  // with the aggregator's own resolution (same technician, configured device,
  // recorded destination, real route-provider result only) and the send proceeds
  // only if the fresh figure still EQUALS the claimed one (the same exact-match
  // rule the draft-time guard and the entry binding use). No newer ping -> no
  // recompute. An unreadable tech_status row or a recompute that fails/is
  // unavailable -> block. 1 s tolerance absorbs timestamp precision differences.
  if (checkFix) {
    for (const entry of boundEntries) {
      if (!Number.isFinite(entry.fixAtMs) || entry.technicianId == null) continue;
      const status = await dbh('tech_status').where({ tech_id: entry.technicianId }).first('location_updated_at');
      const latest = status && status.location_updated_at ? new Date(status.location_updated_at).getTime() : NaN;
      if (!Number.isFinite(latest)) return 'eta_claim_superseded_fix';
      if (latest > entry.fixAtMs + 1000 && !recomputedStillMatches(entry.minutes, await recomputedLiveEtaMinutes(entry, dbh))) return 'eta_claim_superseded_fix';
    }
  }
  return null;
}
async function checkEntriesStillLive({ boundEntries, allowOnSite, requireOnSite = false, recordedState = false, checkFix = false, dbh, trackTokensToVerify = [] }) {
  try {
    const { customerTrackState } = require('./track-transitions');
    const allIds = [...new Set(boundEntries.flatMap((e) => e.scheduledServiceIds))];
    const rows = await dbh('scheduled_services').whereIn('id', allIds).select('id', 'status', 'track_state', 'track_view_token', 'track_token_expires_at', 'technician_id', 'property_id', 'lat', 'lng', 'service_address_line1', 'service_address_zip', 'service_address_city');
    // requireOnSite (Codex round-13 P2): a completed-arrival claim ("has
    // arrived") holds only once the tracker says the tech is on the property.
    const liveStates = new Set(requireOnSite ? ['on_property'] : ((allowOnSite || recordedState) ? ['en_route', 'on_property'] : ['en_route']));
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
    // Round-18/20/22: technician, tracker device and destination identity, in
    // one comparison (see entryIdentityReason). A link-only share names no
    // technician or vehicle, so only the destination applies there.
    const identityReason = await entryIdentityReason(boundEntries, rows, dbh, { checkPerson: !allowOnSite, checkFix });
    if (identityReason) return identityReason;
    // Recorded-state recheck (no classified claim): each entry's visits must
    // still be in the exact state the draft carried — on site stays on site,
    // en route stays en route.
    if (recordedState) {
      const rowById = new Map(rows.map((row) => [row.id, row]));
      const stillRecorded = boundEntries.every((entry) => entry.scheduledServiceIds.every((id) => (
        customerTrackState(rowById.get(id)) === (entry.state === 'on_property' ? 'on_property' : 'en_route'))));
      if (!stillRecorded) return 'eta_claim_no_longer_en_route';
    }

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
