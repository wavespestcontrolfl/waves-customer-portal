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

// Any wording that states how many stops come before the customer's visit, or that the visit is next.
// Deliberately broad: a stop count the facts did not give is refused at draft and at send.
const STOP_COUNT_WORDING_RE = /\b(?:next\s+stop|stops?\s+(?:before|ahead\s+of|until|left\s+before)\s+(?:yours|you|your)|(?:\d+|one|two|three|four|five|six|a\s+few|a\s+couple(?:\s+of)?|several|some)\s+(?:more\s+)?stops?\b|stops?\s+(?:away|out|ahead|left|to\s+go)|(?:the\s+)?stop\s+(?:before|ahead\s+of)\s+(?:yours|you))/i;

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

// The current sentence for one visit. THROWS when the route cannot be read (send time holds the send as
// retryable); null when no sentence applies.
async function currentRouteStatusSentence(dbh, scheduledServiceId) {
  const { peekStopsAhead } = require('./stops-ahead');
  const result = await peekStopsAhead(dbh, scheduledServiceId);
  return routeStatusSentence(result);
}

// Drafting side: fail soft. Any read failure is no sentence (logged with the visit id only).
async function routeStatusFactFor(dbh, scheduledServiceId) {
  try {
    return await currentRouteStatusSentence(dbh, scheduledServiceId);
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
  return STOP_COUNT_WORDING_RE.test(String(text || ''));
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

// Snapshot entries usable at send time: [{ scheduledServiceId, sentence }].
function usableRouteStatusEntries(routeStatus) {
  return Array.isArray(routeStatus)
    ? routeStatus.filter((e) => e && e.scheduledServiceId != null && typeof e.sentence === 'string' && e.sentence.trim())
    : [];
}

// Send-time reasons. 'route_status_recheck_failed' is infrastructure (retryable); the others are verdicts.
const ROUTE_STATUS_RECHECK_FAILED = 'route_status_recheck_failed';

// null when the outgoing body may go out as far as the route status goes, else a reason string.
//   - the body copies a snapshot sentence: re-derive that visit's sentence now; a different (or no)
//     sentence = 'route_status_changed'; a read failure = 'route_status_recheck_failed'.
//   - stop wording that is not a copied snapshot sentence, on a decision whose snapshot carried one:
//     'route_status_unbound'. A decision with no route snapshot keeps today's behavior.
async function routeStatusBlockReason({ liveEtaSnapshot, outgoingBody, dbh }) {
  const entries = usableRouteStatusEntries(liveEtaSnapshot?.routeStatus);
  if (!entries.length) return null;
  const body = fold(outgoingBody);
  const quoted = entries.filter((e) => body.includes(fold(e.sentence)));
  const rest = withoutSentences(outgoingBody, quoted.map((e) => e.sentence));
  if (mentionsStopCount(rest)) return 'route_status_unbound';
  for (const entry of quoted) {
    let now;
    try {
      now = await currentRouteStatusSentence(dbh, entry.scheduledServiceId);
    } catch (err) {
      logger.warn(`[sms-route-status] send-time route status read failed for scheduled_service ${entry.scheduledServiceId}: ${err.message}; holding the send (retryable)`);
      return ROUTE_STATUS_RECHECK_FAILED;
    }
    if (now == null || fold(now) !== fold(entry.sentence)) return 'route_status_changed';
  }
  return null;
}

module.exports = {
  STOP_COUNT_WORDING_RE,
  ROUTE_STATUS_RECHECK_FAILED,
  routeStatusSentence,
  currentRouteStatusSentence,
  routeStatusFactFor,
  routeStatusDraftViolation,
  routeStatusSentencesInFacts,
  routeStatusBlockReason,
  mentionsStopCount,
};
