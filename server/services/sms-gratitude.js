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
const CLOSED_OUTBOUND_RE = /\b(?:your|the)\b[^\n.!?]*\b(?:report|receipt)\b[^\n]*\b(?:https?:\/\/|portal\.)|\b(?:report|receipt):\s*(?:https?:\/\/|portal\.)|\b(?:we(?:'ve| have)? (?:completed|finished)|(?:service|control|treatment) is (?:done|complete))\b|\bpayment received\b/i;
const BANK_ACK_RE = /^Hello [\p{L}\p{M}'’ -]+! We got your bank payment for invoice [\w-]+\. ACH transfers take 3-5 business days to clear, and we'll send a receipt as soon as it does\.$/u;

/**
 * Conservative first release: explicit thanks following a delivered report,
 * receipt, completed service or bank-payment acknowledgement. Ordinary
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
  const invalidClosure = [
    [() => !bankAcknowledgement && (outboundAsksForReply(body) || PENDING_OUTBOUND_RE.test(body)), 'outbound_needs_attention'],
    [() => !bankAcknowledgement && !CLOSED_OUTBOUND_RE.test(body), 'closure_not_established'],
  ].find(([invalid]) => invalid());
  if (invalidClosure) return deny(invalidClosure[1]);
  // A later template cannot erase an earlier unanswered operational message.
  // This deliberately gives up some valid thanks instead of inferring that a
  // report/reminder satisfied a separate request or a promised follow-up.
  if (recent.some(row => row.direction === 'inbound'
      && (row.mediaCount !== 0 || !(isCourtesyOnly(row.body, { awaitingAnswer: false })
        || isGratitudeOnly(row.body))))) return deny('operational_context');
  if (outgoing.slice(0, -1).some(row => {
    const text = withoutOptionalFooter(String(row.body || ''));
    return !BANK_ACK_RE.test(text) && (outboundAsksForReply(text) || PENDING_OUTBOUND_RE.test(text));
  })) return deny('earlier_open_context');
  return { eligible: true, reason: 'gratitude_after_closure', reply: buildGratitudeReply(firstName) };
}

module.exports = {
  GRATITUDE_INTENT, GRATITUDE_POLICY_VERSION, QUIET_WINDOW_MS, MAX_REPLY_AGE_MS,
  CONTEXT_WINDOW_MS, isGratitudeOnly, buildGratitudeReply,
  gratitudeTimingReason, evaluateGratitudeContext,
};
