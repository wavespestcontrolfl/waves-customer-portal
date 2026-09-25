'use strict';

// Pure policy shared by the live sender and the offline historical replay.
// No database, provider, environment reads or side effects in this module.
const { isCourtesyOnly, isSmsReaction, outboundAsksForReply } = require('./sms-intent');

const GRATITUDE_INTENT = 'gratitude_reply';
const GRATITUDE_POLICY_VERSION = 'gratitude_v1';
const QUIET_WINDOW_MS = 2 * 60 * 1000;
const MAX_REPLY_AGE_MS = 10 * 60 * 1000;
const CONTEXT_WINDOW_MS = 24 * 60 * 60 * 1000;

function isGratitudeOnly(body) {
  if (typeof body !== 'string' || isSmsReaction(body)) return false;
  // Only known spelling variants; never fuzzy-match away operational words.
  const normalized = body.trim()
    .replace(/\bthankyou\b/gi, 'thank you')
    .replace(/\b(?:thanx|thnx|thnxs|tks)\b/gi, 'thanks')
    .replace(/\bthankl\s+you\b/gi, 'thank you')
    .replace(/^many\s+thanks\b/i, 'thanks');
  return /\b(?:thanks?|thank\s+(?:you|u)|thx|ty|tysm|appreciat\w*)\b/i.test(normalized)
    && isCourtesyOnly(normalized, { awaitingAnswer: false });
}

function buildGratitudeReply(firstName) {
  const name = typeof firstName === 'string' ? firstName.trim() : '';
  const usable = name.length <= 32 && /^[\p{L}][\p{L}\p{M}'’ -]*$/u.test(name)
    && !/^(?:unknown|customer|test|none|null|n\/a)$/i.test(name);
  return usable ? `Our pleasure, ${name}!` : 'Our pleasure!';
}

function timestamp(value) {
  if (value === null || value === undefined || value === '') return NaN;
  return new Date(value).getTime();
}

function gratitudeTimingReason({ inboundCreatedAt, now, activatedAt } = {}) {
  const received = timestamp(inboundCreatedAt);
  const current = timestamp(now);
  const activation = timestamp(activatedAt);
  if (![received, current, activation].every(Number.isFinite)) return 'invalid_timing';
  if (activation > current || received <= activation) return 'before_activation';
  if (received > current) return 'future_inbound';
  if (current - received < QUIET_WINDOW_MS) return 'quiet_window';
  if (current - received > MAX_REPLY_AGE_MS) return 'stale_inbound';
  return null;
}

function withoutOptionalFooter(body) {
  // Exact standalone template lines only: never strip a real question just
  // because it happens to contain "reply" or "let me know".
  return body.split('\n').filter(line => !/^(?:Questions(?: or (?:requests|need to reschedule))?\? Reply (?:here|to this message)\.|If you have any questions or need assistance, simply reply to this message\.|Please reply to this message if you need any assistance\.|Reply STOP to opt out\.)$/i.test(line.trim())).join('\n').trim();
}

const PENDING_OUTBOUND_RE = /\b(?:will|we'll|i'll|we’ll|i’ll|going to|need to|have to|working on|momentarily|shortly|soon|tentativ\w*|pencil\w*)\b|\b(?:sorry|apologi\w*|cancel\w*|refund\w*|disput\w*|complaint|late|delay\w*|unpaid|overdue|outstanding|past due)\b/i;
// Owner decision 2026-09-24: thanks in reply to our own automated
// appointment/estimate/review templates is a closure too. Keyed on the
// persisted message type, never on body text. The needs-attention and
// earlier-open-context guards still apply to these messages. Billing and
// payment reminders are deliberately absent: thanks after a payment request
// is not a closure.
const AUTOMATED_CLOSURE_TYPES = new Set([
  'reminder_72h', 'reminder_24h', 'appointment_reminder', 'appointment_confirmation',
  'tech_en_route', 'tech_arrived', 'estimate_sent', 'review_request',
]);
// Owner decision 2026-09-24 (follow-up): thanks in reply to a hand-typed staff
// text is a closure too, as long as that text made no promise and asked no
// question (the needs-attention guard still runs first). A typed reply is also
// the answer to whatever the customer asked earlier, so the operational-context
// guard is skipped for it; the earlier-open-context guard still applies.
const MANUAL_MESSAGE_TYPE = 'manual';
// Time promises phrased the way hand-typed texts phrase them: "give me a
// minute", "in 15 minutes", "leaving now", "on my way", "swinging by", "be
// there by 3". The visit or estimate is still ahead, so thanks in reply is not
// a closure. Manual texts only: our en-route template says "on the way" and is
// a closure by type.
const MANUAL_DURATION_NUMBER = String.raw`(?:(?:about|around|roughly|approximately|maybe|like|just|another|at least|up to|only|say|probably|possibly|hopefully|max|a good) )*(?:\d+(?:-\d+)?(?: or \d+)?|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|twenty-five|thirty|forty|forty-five|fifty|sixty|ninety|a few|a couple(?: of)?|couple|several|a bit|half an?)`;
const MANUAL_DURATION_UNIT = String.raw`(?:minutes?|mins?|hours?|hrs?|sec(?:ond)?s?|moments?)`;
const MANUAL_PROMISE_RE = new RegExp(String.raw`\b(?:give (?:me |us )?(?:${MANUAL_DURATION_NUMBER} )?(?:more )?${MANUAL_DURATION_UNIT}|(?:in|within|for|another|need|needs|take|takes|about|around|roughly) (?:${MANUAL_DURATION_NUMBER} )?(?:more )?${MANUAL_DURATION_UNIT}|in a (?:bit|little (?:bit|while)|while|jiffy)|one (?:moment|minute|min|sec(?:ond)?)|just a (?:moment|minute|min|sec(?:ond)?)|hold on|hang on|bear with (?:me|us)|let me (?:check|look|see|find out|confirm|ask|get back)|checking (?:now|on (?:it|that))|looking into (?:it|that)|get back to you|circle back|follow(?:ing)? up|later (?:today|tonight|this week)|(?:this|by) (?:afternoon|evening|morning|weekend|week)|tonight|tomorrow|next (?:week|month|visit)|(?:mon|tues|wednes|thurs|fri|satur|sun)day|(?:should|will|would|gonna|going to) (?:arrive|be there|be out|be delivered|come|show up|get to you)|expect (?:it|them|me|us)|(?:until|till|by|before) (?:end of (?:the )?(?:day|week|month)|eod|eow|eom|noon|midday|close of business|cob|tonight|tomorrow|next week|\d{1,2}(?::\d{2})? ?(?:am|pm|o'clock)?)|leaving now|on (?:the|my|our) way|swinging by|heading (?:over|out|your way)|be (?:right )?(?:there|over)(?: (?:by|at|around|after|in) \S+)?|there in \d+)\b`, 'i');
// Hand-typed questions often drop the question mark ("Can you send a
// picture", "Which day works"). Any sentence that opens with an
// interrogative, or asks to be told something, still needs an answer.
const MANUAL_QUESTION_RE = /(?:^|[.!,;:\n—-]\s*|\b(?:just|please|also|and|so|then|or|but)\s+)(?:can|could|would|will|do|does|did|is|are|was|were|should|shall|have|has|what|which|when|where|who|whom|how|why|any chance)\b|\b(?:can|could|would|will|do|does|did|is|are|should|shall|have|has|may|might) (?:you|u|ya|we|i|that|this|it|there|anyone|someone|somebody|friday|monday|tuesday|wednesday|thursday|saturday|sunday|tomorrow|today|morning|afternoon)\b|\b(?:wonder(?:ing|ed)?|whether|see if|know if|check(?:ing)? if|curious|want(?:ed)? to (?:see|know|check|ask|confirm)|(?:send|email|text|tell|shoot|forward|upload|attach|snap|show|give|get|share|confirm|remind|advise|update|call|drop|pick|choose|select|reply|respond|fill|sign|complete|return|provide|supply|submit|bring|leave|describe|specify|verify) (?:me|us|it|them|this|that|a|an|the|your|which|what|when|where|how|over|back|with|to|by)\b|let (?:me|us) know|lmk|feel free to (?:reply|text|call|let)|please (?:send|confirm|reply|let|advise|text|call|share)|what(?:'s| is| are| time| day)|which (?:day|time|one)|work(?:s)? for you|good for you|ok(?:ay)? for you)\b/i;
// A hand-typed courtesy ("Thanks, Dana!", "Anytime!", "Happy to help") is
// not an answer to close on; another thanks after it is the loop the
// courtesy guard exists to stop.
const MANUAL_COURTESY_RE = /^(?:thanks?(?: you)?|thank you|ty|tysm|anytime|any time|happy to help|glad to help|glad (?:i|we) could help|of course|absolutely|sure thing|you got it|you bet|my pleasure|our pleasure|you(?:'re| are|re) (?:very )?welcome|no worries|no problem|not a problem|no prob|np|welcome)(?:[ ,]+[\p{L}\p{M}'’ -]+)?[!.\s]*$/iu;
// A hand-typed payment request is not a closure either, matching the
// billing exclusion in AUTOMATED_CLOSURE_TYPES: thanks after "here is your
// payment link" acknowledges nothing paid.
const MANUAL_PAYMENT_RE = /\b(?:pay(?:ment)?(?: link| here| online| now| by| via| with)?|invoice|balance(?: due)?|amount due|due today|card on file|autopay|auto-pay|checkout|zelle|venmo|cash ?app|square link|stripe)\b/i;
// A hand-typed text closes the exchange unless it asks for money.
const manualCourtesy = (text, manualReply) => manualReply
  && (MANUAL_COURTESY_RE.test(text) || isCourtesyOnly(text, { awaitingAnswer: false }));
const manualClosure = (text, manualReply) => manualReply && !MANUAL_PAYMENT_RE.test(text);
const outboundPending = (text, row) => outboundAsksForReply(text) || PENDING_OUTBOUND_RE.test(text)
  || (row.messageType === MANUAL_MESSAGE_TYPE && (MANUAL_PROMISE_RE.test(text) || MANUAL_QUESTION_RE.test(text)));
const CLOSED_OUTBOUND_RE = /\b(?:your|the)\b[^\n.!?]*\b(?:report|receipt)\b[^\n]*\b(?:https?:\/\/|portal\.)|\b(?:report|receipt):\s*(?:https?:\/\/|portal\.)|\b(?:we(?:'ve| have)? (?:completed|finished)|(?:service|control|treatment) is (?:done|complete))\b|\bpayment received\b/i;
const BANK_ACK_RE = /^Hello [\p{L}\p{M}'’ -]+! We got your bank payment for invoice [\w-]+\. ACH transfers take 3-5 business days to clear, and we'll send a receipt as soon as it does\.$/u;

/**
 * Conservative first release: explicit thanks following a delivered report,
 * receipt, completed service, bank-payment acknowledgement, or one of our
 * automated appointment/estimate/review templates (AUTOMATED_CLOSURE_TYPES). Ordinary
 * conversational answers without positive closure evidence abstain. The
 * existing agent still handles those normally. Caller supplies the complete
 * recent SAME-ENDPOINT thread and authoritative first name; no name mining.
 */
function evaluateGratitudeContext({ inbound, history, firstName, contextComplete, pendingWork = false } = {}) {
  const deny = reason => ({ eligible: false, reason, reply: '' });
  if (!inbound?.id || inbound.direction !== 'inbound' || !isGratitudeOnly(inbound.body)) return deny('not_gratitude');
  const invalidContext = [
    [() => inbound.mediaCount !== 0, 'media_or_unknown'],
    [() => !contextComplete || !Array.isArray(history), 'context_unavailable'],
    [() => pendingWork !== false, 'pending_work'],
    [() => !Number.isFinite(timestamp(inbound.createdAt)), 'invalid_context_time'],
  ].find(([invalid]) => invalid());
  if (invalidContext) return deny(invalidContext[1]);
  const received = timestamp(inbound.createdAt);
  const rows = history.filter(row => row.id !== inbound.id);
  if (rows.some(row => !Number.isFinite(timestamp(row.createdAt)) || !['inbound', 'outbound'].includes(row.direction))) return deny('invalid_context');
  if (rows.some(row => timestamp(row.createdAt) >= received)) return deny('thread_advanced');
  const recent = rows.filter(row => timestamp(row.createdAt) >= received - CONTEXT_WINDOW_MS)
    .sort((a, b) => timestamp(a.createdAt) - timestamp(b.createdAt));
  const outgoing = recent.filter(row => row.direction === 'outbound');
  const previous = outgoing.at(-1);
  if (!previous) return deny('no_recent_outbound');
  // A courtesy reply never starts another courtesy exchange. Conservatively
  // keep the loop guard for the entire context window, across draft retries.
  if (outgoing.some(row => row.messageType === 'ai_gratitude'
      || /^(?:(?:our|my) pleasure|you['’]?re (?:very )?welcome|no problem)(?:[ ,]+[\p{L}\p{M}'’ -]+)?[!.\s]*$/iu.test(row.body || ''))) return deny('courtesy_already_sent');
  const body = withoutOptionalFooter(String(previous.body || ''));
  const bankAcknowledgement = BANK_ACK_RE.test(body);
  const manualReply = previous.messageType === MANUAL_MESSAGE_TYPE;
  if (manualCourtesy(body, manualReply)) return deny('courtesy_already_sent');
  const invalidClosure = [
    [() => !bankAcknowledgement && outboundPending(body, previous), 'outbound_needs_attention'],
    [() => !bankAcknowledgement && !manualClosure(body, manualReply) && !AUTOMATED_CLOSURE_TYPES.has(previous.messageType)
      && !CLOSED_OUTBOUND_RE.test(body), 'closure_not_established'],
  ].find(([invalid]) => invalid());
  if (invalidClosure) return deny(invalidClosure[1]);
  // A later template cannot erase an earlier unanswered operational message.
  // This deliberately gives up some valid thanks instead of inferring that a
  // report/reminder satisfied a separate request or a promised follow-up. A
  // hand-typed staff reply IS that answer for the customer texts BEFORE it;
  // anything the customer sent after it is still unanswered.
  const answeredByManualReply = row => manualReply && timestamp(row.createdAt) <= timestamp(previous.createdAt);
  if (recent.some(row => row.direction === 'inbound' && !answeredByManualReply(row)
      && (row.mediaCount !== 0 || !(isCourtesyOnly(row.body, { awaitingAnswer: false })
        || isGratitudeOnly(row.body))))) return deny('operational_context');
  if (outgoing.slice(0, -1).some(row => {
    const text = withoutOptionalFooter(String(row.body || ''));
    return !BANK_ACK_RE.test(text) && outboundPending(text, row);
  })) return deny('earlier_open_context');
  return { eligible: true, reason: 'gratitude_after_closure', reply: buildGratitudeReply(firstName) };
}

module.exports = {
  GRATITUDE_INTENT, GRATITUDE_POLICY_VERSION, QUIET_WINDOW_MS, MAX_REPLY_AGE_MS,
  CONTEXT_WINDOW_MS, isGratitudeOnly, buildGratitudeReply,
  gratitudeTimingReason, evaluateGratitudeContext,
};
