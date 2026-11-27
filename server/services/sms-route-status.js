'use strict';
// TODAY ROUTE STATUS for the texting AI (gap 4, owner ruling 2026-11-26 "BUILD 1-6"; shadow drafts only).
//
// "Where is the tech?" / "Are you still coming today?" BEFORE the tech is en route. LIVE STATUS / LIVE ETA
// (context-aggregator) start only once the tech taps en route; before that the drafter knew nothing. This
// module turns the customer tracker's own stops-before-you count (stops-ahead.js, GATE_STOPS_AWAY, owner
// rulings 2026-08-14: route order is customer-visible as a bare count only, capped at 3, never another
// customer's information) into ONE finished sentence the model copies word for word:
//   0 stops            -> "Your visit is your technician's next stop today."
//   1 stop, tech there -> "Your technician is working at the stop before yours."
//   1..3 stops         -> "Your technician has N stop(s) before yours today."
// Never minutes, a clock time, the tech's location or another customer's address.
//
// The order is the tracker's (the dispatch day-plan sort, reused through stops-ahead peekStopsAhead: no floor
// write, no {pending}). No sentence when: GATE_STOPS_AWAY is off, no technician, the visit is not
// today, it is already en route / on site (LIVE STATUS owns that), a sibling line is underway, the tech is
// working a LATER stop, more than 3 stops come first, the visit has no arrival window (not placed on the
// route), a live stop ties its route position (order undecided), or any read fails.
//
// Send boundary: the sentence rides the live ETA snapshot (buildLiveEtaSnapshot -> routeStatus) and
// sms-eta-freshness re-derives it right before every send. A changed sentence refuses the send as stale; a
// failed read refuses it as retryable. Wording about stops that is not a verbatim fact sentence refuses too.
const logger = require('./logger');

// ROUTE WORDING, structural (one rule, not a phrase list): a reply states the visit's place on the route when,
// within one short span, it pairs
//   (a) a COUNT or an ORDER word (a digit, a number word, a few / a couple / several / more, next / first /
//       last / second / third) with "stop(s)" — "stop" is route vocabulary on its own; or
//   (b) a COUNT or ORDER word with another ROUTE NOUN (visit, house, home, job, customer, appointment) AND a
//       POSITION link (before / ahead of / in front of / until / then / and then / after that) to you / yours /
//       your visit (appointment, service, house, home, stop) / your turn;
//   (c) any ROUTE NOUN or COUNT followed by "then (it's) you(rs)" / "and then you"; or
//   (d) the customer's own position: "you're next / first / last", "next on the route / list / line".
// Every such reply must carry its claim as a verbatim ROUTE STATUS sentence (draft check and send check).
// Plan counts and scheduling copy carry no position link to "you" ("You have 2 visits left this year", "Your
// next visit is Tuesday") and stay outside it. Matched on folded text (lowercase, ASCII apostrophes).
// No "call": "Please call before your appointment" is a callback instruction, not a stop.
const COUNT = "(?:\\d+(?:st|nd|rd|th)?|one|two|three|four|five|six|seven|eight|nine|ten|a\\s+few|a\\s+couple(?:\\s+of)?|couple(?:\\s+of)?|several|some|more|next|first|last|second|third)";
const ROUTE_NOUN = '(?:visits?|houses?|homes?|jobs?|customers?|appointments?|stops?)';
const GAP = '(?:[\\w\']+[\\s,]+){0,3}?'; // up to three words between, the "short span"
// the position target: you / yours / your <visit|appointment|service|house|home|stop> / your turn
const TO_YOU = "(?:it's\\s+|it\\s+is\\s+|comes?\\s+|will\\s+be\\s+)?(?:you|yours|your\\s+(?:visits?|appointments?|services?|houses?|homes?|stops?|turn))\\b";
const POSITION = `(?:before|ahead\\s+of|in\\s+front\\s+of|until|prior\\s+to|then|and\\s+then|after\\s+that|after\\s+which)\\s+${TO_YOU}`;
const STOP_COUNT_WORDING_RE = new RegExp([
  `${COUNT}[\\s,]+${GAP}stops?\\b`,
  `stops?\\s+(?:away|out|ahead|left|to\\s+go)\\b`,
  // "the stop before yours": a stop placed relative to the customer, with or without a count (the module's own
  // "working at the stop before yours" sentence included)
  `stops?\\s+(?:before|ahead\\s+of|in\\s+front\\s+of|prior\\s+to)\\s+(?:you|yours|your)\\b`,
  `${COUNT}[\\s,]+${GAP}${ROUTE_NOUN}\\b[\\s,]+${GAP}${POSITION}`,
  `${ROUTE_NOUN}\\b[\\s,]+${GAP}(?:then|and\\s+then|after\\s+that)\\s+${TO_YOU}`,
  "(?:you're|you\\s+are|your\\s+(?:visit|home|house|appointment|stop)(?:'s|\\s+is)?)\\s+(?:up\\s+)?(?:next|first|last)\\b(?!\\s+(?:week|month|year|time|monday|tuesday|wednesday|thursday|friday|saturday|sunday|thing))",
  "(?:you're|you\\s+are|your\\s+(?:visit|home|house|appointment|stop)(?:'s|\\s+is)?)\\s+(?:his|her|their|our|the)\\s+(?:next|first|last)\\b",
  '(?:up\\s+)?next\\s+(?:on|in)\\s+(?:the\\s+|his\\s+|her\\s+|their\\s+|our\\s+)?(?:route|list|line|schedule|queue)\\b',
  '(?:first|last|second|third)\\s+on\\s+(?:the|his|her|their|our)\\s+(?:route|list|schedule)\\b',
].map((p) => `\\b(?:${p})`).join('|'), 'i');

const NEXT_STOP_SENTENCE = "Your visit is your technician's next stop today.";
const AT_STOP_BEFORE_SENTENCE = 'Your technician is working at the stop before yours.';

// The one sentence for a peekStopsAhead result, or null.
function routeStatusSentence(result) {
  const n = result?.stopsAhead;
  if (!Number.isInteger(n) || n < 0) return null;
  if (n === 0) return NEXT_STOP_SENTENCE;
  if (n === 1 && result.atStop === true) return AT_STOP_BEFORE_SENTENCE;
  return `Your technician has ${n} ${n === 1 ? 'stop' : 'stops'} before yours today.`;
}

// The current route status of one visit, from ONE read (peekStopsAhead's count statement also returns the
// stop identity, its open member lines and the customer's open stops that day): { sentence, stop, memberIds },
// or null when no sentence applies. Only a customer with exactly ONE open physical stop that day gets one:
// with two (a pest and a lawn visit), a reply cannot be bound to the stop a sentence is about. THROWS when
// the route cannot be read (send time holds the send as retryable).
async function currentRouteStatus(dbh, scheduledServiceId) {
  const { peekStopsAhead } = require('./stops-ahead');
  const result = await peekStopsAhead(dbh, scheduledServiceId);
  const sentence = routeStatusSentence(result);
  if (!sentence || result.openStopsToday !== 1 || !result.stop?.technicianId) return null;
  return { sentence, stop: result.stop, memberIds: result.memberIds || [] };
}

// Drafting side: fail soft. Any read failure is no sentence (logged with the visit id only).
async function routeStatusFactFor(dbh, scheduledServiceId) {
  try {
    return await currentRouteStatus(dbh, scheduledServiceId);
  } catch (err) {
    logger.warn(`[sms-route-status] route status read failed for scheduled_service ${scheduledServiceId}: ${err.message}`);
    return null;
  }
}

// Comparison form: GSM punctuation (smart apostrophes), case and spacing folded.
function fold(text) {
  const { normalizeGsmPunctuation } = require('./messaging/gsm-normalize');
  return normalizeGsmPunctuation(String(text || '')).toLowerCase().replace(/\s+/g, ' ').trim();
}

// The body with every listed sentence removed (folded form), so leftover stop wording can be found.
function withoutSentences(body, sentences) {
  let rest = fold(body);
  for (const s of sentences) {
    const f = fold(s);
    if (f) rest = rest.split(f).join(' ');
  }
  return rest;
}

function mentionsStopCount(text) {
  return STOP_COUNT_WORDING_RE.test(fold(text));
}

// Draft-time guard: stop wording only as a word-for-word copy of a ROUTE STATUS sentence the facts carry.
const ROUTE_STATUS_FACT_RE = /ROUTE STATUS \(copy word for word\): "([^"\n]+)"/g;
function routeStatusSentencesInFacts(factsBlock) {
  return [...String(factsBlock || '').matchAll(ROUTE_STATUS_FACT_RE)].map((m) => m[1]);
}
function routeStatusDraftViolation(reply, factsBlock) {
  const rest = withoutSentences(reply, routeStatusSentencesInFacts(factsBlock));
  if (!mentionsStopCount(rest)) return null;
  return "the reply says how many stops come before the customer's visit without copying TODAY's ROUTE STATUS sentence word for word — copy that exact sentence, or say nothing about stops";
}

// Snapshot entries usable at send time: [{ scheduledServiceId, scheduledServiceIds, sentence, stop }].
function usableRouteStatusEntries(routeStatus) {
  return Array.isArray(routeStatus)
    ? routeStatus.filter((e) => e && e.scheduledServiceId != null && typeof e.sentence === 'string' && e.sentence.trim())
    : [];
}

// Send-time reasons. 'route_status_recheck_failed' is infrastructure (retryable); the others are verdicts.
const ROUTE_STATUS_RECHECK_FAILED = 'route_status_recheck_failed';

// Same stop as drafted: the identity read with the count equals the persisted one (so a stop that moved whole,
// or a one-line stop, is caught), and every line the snapshot listed is still an open member of it.
const IDENTITY_KEYS = ['technicianId', 'customerId', 'date', 'windowStart'];
function sameStopAsDrafted(entry, now) {
  if (!entry.stop || !now) return false;
  if (!IDENTITY_KEYS.every((k) => String(entry.stop[k] ?? '') === String(now.stop[k] ?? ''))) return false;
  const members = new Set(now.memberIds.map(String));
  const listed = [entry.scheduledServiceId, ...(Array.isArray(entry.scheduledServiceIds) ? entry.scheduledServiceIds : [])].filter((id) => id != null);
  return listed.every((id) => members.has(String(id)));
}

// null when the outgoing body may go out as far as the route status goes, else a reason string.
//   - the body copies a snapshot sentence: one read re-derives the sentence, the stop identity, its member
//     lines and the single-stop rule; any difference = 'route_status_changed'. A read failure =
//     'route_status_recheck_failed'.
//   - route wording that is not a copied snapshot sentence: 'route_status_unbound'. This holds for every
//     decision drafted with the route status opted in, which persists routeStatus as an array (empty when
//     no sentence was given or the read failed). Only a decision with no routeStatus array at all (drafted
//     before this check existed, or by a caller that never opted in) keeps today's behavior.
async function routeStatusBlockReason({ liveEtaSnapshot, outgoingBody, dbh }) {
  if (!Array.isArray(liveEtaSnapshot?.routeStatus)) return null;
  const entries = usableRouteStatusEntries(liveEtaSnapshot.routeStatus);
  const body = fold(outgoingBody);
  const quoted = entries.filter((e) => body.includes(fold(e.sentence)));
  const rest = withoutSentences(outgoingBody, quoted.map((e) => e.sentence));
  if (mentionsStopCount(rest)) return 'route_status_unbound';
  for (const entry of quoted) {
    let now;
    try {
      now = await currentRouteStatus(dbh, entry.scheduledServiceId);
    } catch (err) {
      logger.warn(`[sms-route-status] send-time route status read failed for scheduled_service ${entry.scheduledServiceId}: ${err.message}; holding the send (retryable)`);
      return ROUTE_STATUS_RECHECK_FAILED;
    }
    if (!sameStopAsDrafted(entry, now) || fold(now.sentence) !== fold(entry.sentence)) return 'route_status_changed';
  }
  return null;
}

module.exports = {
  STOP_COUNT_WORDING_RE,
  ROUTE_STATUS_RECHECK_FAILED,
  routeStatusSentence,
  currentRouteStatus,
  routeStatusFactFor,
  routeStatusDraftViolation,
  routeStatusSentencesInFacts,
  routeStatusBlockReason,
  mentionsStopCount,
};
