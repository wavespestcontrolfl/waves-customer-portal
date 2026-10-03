/**
 * Inbound-SMS shadow for typed decisions (dark behind GATE_TYPED_DECISIONS).
 *
 * After the webhook has acknowledged Twilio, a customer text is also put to
 * TypeSafe Jev as two registered questions (sms_courtesy.v1: is it only a
 * courtesy closer? sms_reschedule.v1: does it ask to move, skip or cancel a
 * visit?) and each answer is recorded next to the rule that actually ran
 * (`rules.courtesyOnly`, `rules.rescheduleAsk`) in decision_reviews.
 *
 * SHADOW ONLY: nothing here replies, suppresses a reply, flags, bells or
 * moves a visit; the webhook ignores the result. Gate off, an ineligible
 * message or a missing customer returns before any provider call or write.
 * The ledger already files every provider call (askPackage).
 *
 * With GATE_TYPED_DECISIONS_CLEF also on, the same questions go to Cloudflare
 * Clef as a second leg, and each provider's row is recorded with the other's
 * answers as `siblingAnswers`, so a case where they differ queues both rows
 * for the reviewer (shadow-recorder.sampleFor). One leg's failure never
 * blocks the other; counts below are per leg.
 */
const { excludeUnresolvedSendReservations } = require('../messaging/review-ask-reservation');
const { typedDecisionsLive, typedDecisionsClefLive } = require('../../config/feature-gates');

// The last Waves text this customer was sent on this line, for the model's
// "what was Waves answering" context. Same filters as the webhook's own
// lastOutboundAskedQuestion (a failed send never reached them; internal
// alerts are not part of the thread; the 24h before the customer's text), read
// here AFTER the Twilio ack so the webhook adds no round trip. The admin review
// route calls this too, with the inbound row's own phones and time, so the
// reviewer sees exactly the context Jev was given.
async function readLastOutboundBody({ conn, customerPhone, ourNumber, before }) {
  const end = before ? new Date(before) : new Date();
  const row = await conn('sms_log')
    .where({ direction: 'outbound', to_phone: customerPhone, from_phone: ourNumber })
    .whereIn('status', ['queued', 'sent', 'delivered'])
    .where(function notInternal() { this.whereNot('message_type', 'internal_alert').orWhereNull('message_type'); })
    .where('created_at', '>', new Date(end.getTime() - 24 * 60 * 60 * 1000))
    .where('created_at', '<', end)
    // An unresolved send reservation (a synthetic 'sending' row) is not a
    // text the customer received.
    .modify(excludeUnresolvedSendReservations)
    .orderBy('created_at', 'desc')
    .first('message_body');
  return row?.message_body || null;
}

const QUESTIONS = [
  { packageId: 'sms_courtesy.v1', question: 'is_courtesy_only', rule: 'courtesyOnly' },
  { packageId: 'sms_reschedule.v1', question: 'wants_visit_change', rule: 'rescheduleAsk' },
];

/**
 * @param {object} p
 * @param {string} p.smsLogId       the inbound sms_log row
 * @param {string} p.customerId     matched customer (no customer = skipped)
 * @param {string} p.body           the customer's text
 * @param {string} [p.lastOutboundBody] the previous Waves text; when undefined
 *   and fromPhone/toPhone are given it is read here, otherwise null
 * @param {{courtesyOnly?: boolean, rescheduleAsk?: boolean}} p.rules the
 *   flags the webhook already computed
 * @param {string} [p.fromPhone] / [p.toPhone] / [p.messageType] / [p.receivedAt]
 *   the inbound row's own fields: used to apply the same exclusions as
 *   sms-operational-actions' eligibleMessage (opt-out, opt-in, reactions,
 *   help, the AI toll-free line, internal test customers) and to bound the
 *   last-outbound read
 * @returns {Promise<{asked:number, recorded:number, failed:number, skipped?:string}>}
 */
async function shadowInboundSms({ smsLogId, customerId, body, lastOutboundBody, rules = {}, fromPhone, toPhone, messageType, receivedAt } = {}) {
  const out = { asked: 0, recorded: 0, failed: 0 };
  if (!typedDecisionsLive()) return { ...out, skipped: 'gate_off' };
  const text = typeof body === 'string' ? body.trim() : '';
  if (!customerId || !smsLogId || !text) return { ...out, skipped: 'no_customer_or_body' };

  // Lazy: the gate-off path must not load these modules.
  const { eligibleMessage } = require('../sms-operational-actions');
  const message = { direction: 'inbound', customer_id: customerId, message_body: text, from_phone: fromPhone, to_phone: toPhone, message_type: messageType };
  if ((fromPhone || toPhone) && !eligibleMessage(message)) return { ...out, skipped: 'ineligible_message' };

  const conn = require('../../models/db');

  let previous = lastOutboundBody;
  if (previous === undefined) {
    previous = fromPhone && toPhone
      ? await readLastOutboundBody({ conn, customerPhone: fromPhone, ourNumber: toPhone, before: receivedAt }).catch(() => null)
      : null;
  }
  const { smsSubjectHash, smsCustomerText } = require('./subject-hash');
  const state = { previous_waves_text: previous || null, customer_text: smsCustomerText(text) };
  const subjectHash = smsSubjectHash({ previous, body: text });

  const providers = typedDecisionsClefLive() ? ['typesafe', 'cloudflare'] : ['typesafe'];
  await Promise.all(QUESTIONS.map(({ packageId, question, rule }) => {
    const flag = typeof rules[rule] === 'boolean' ? rules[rule] : undefined;
    return askAndRecord({ packageId, question, baseline: { rules: flag }, state, smsLogId, subjectHash, providers, out });
  }));
  return out;
}

// One question to every live provider, then one row per provider that
// answered, each handed the others' answers. Counts into `out` per leg.
async function askAndRecord({ packageId, question, baseline, state, smsLogId, subjectHash, providers, out }) {
  const { askPackage } = require('./jev');
  const { recordDecisions } = require('./shadow-recorder');
  const { packageFor } = require('./packages');
  // Ask every provider first, so each row can be recorded with the others'
  // answers; a leg that fails (ok:false or a throw) is counted and skipped.
  const legs = await Promise.all(providers.map(async (provider) => {
    out.asked += 1;
    try {
      const result = provider === 'typesafe' ? await askPackage(packageId, state) : await askPackage(packageId, state, { provider });
      if (!result || !result.ok) { out.failed += 1; return null; }
      return { provider, result };
    } catch (err) {
      out.failed += 1;
      require('../logger').warn(`[typed-decisions] sms shadow ${packageId} (${provider}) failed: ${err.message}`);
      return null;
    }
  }));
  const answered = legs.filter(Boolean);
  await Promise.all(answered.map(async ({ provider, result }) => {
    try {
      const siblings = answered.filter((leg) => leg.provider !== provider).map((leg) => leg.result.answers);
      const recorded = await recordDecisions({
        capability: packageFor(packageId).capability,
        pkg: packageFor(packageId),
        provider,
        subjectType: 'sms_log',
        subjectId: smsLogId,
        result,
        baselines: { [question]: baseline },
        siblingAnswers: siblings.length ? { [question]: siblings.map((answers) => answers[question]).filter(Boolean) } : {},
        subjectHash,
      });
      if (recorded.recorded > 0) out.recorded += 1; else out.failed += 1;
    } catch (err) {
      out.failed += 1;
      require('../logger').warn(`[typed-decisions] sms shadow ${packageId} (${provider}) record failed: ${err.message}`);
    }
  }));
}

/**
 * Unknown-sender shadow (sms_solicitation.v1): evidence for
 * GATE_SMS_SPAM_CLASSIFIER before it is ever flipped. The webhook calls this
 * for exactly the texts that gate's screen would see (no known relationship
 * or outbound history, no media, not a reaction, not the AI line), whatever
 * the gate's own mode, so the numbers exist before the flip. Baselines: the
 * screen's regex marker (`rules`, isSolicitationPitch) always, and the
 * classifier's own verdict (`production`) only when its model read this text
 * (the gate in shadow or true mode). Help and opt keyword texts are skipped,
 * as the screen skips them. SHADOW ONLY: nothing is silenced or changed.
 *
 * @param {object} p
 * @param {string} p.smsLogId  the inbound sms_log row
 * @param {string} p.body      the text
 * @param {object|null} [p.verdict] the screen's result (screenInboundSms), if it ran
 * @param {string} [p.fromPhone] / [p.toPhone] / [p.receivedAt] bound the previous-text read
 * @returns {Promise<{asked:number, recorded:number, failed:number, skipped?:string}>}
 */
async function shadowUnknownSenderSms({ smsLogId, body, verdict = null, fromPhone, toPhone, receivedAt } = {}) {
  const out = { asked: 0, recorded: 0, failed: 0 };
  if (!typedDecisionsLive()) return { ...out, skipped: 'gate_off' };
  const text = typeof body === 'string' ? body.replace(/\s+/g, ' ').trim() : '';
  if (!smsLogId || !text) return { ...out, skipped: 'no_body' };
  const { detectSmsOptCommand, detectHelp } = require('../messaging/opt-out-detector');
  if (detectHelp(text).help) return { ...out, skipped: 'help' };
  const command = detectSmsOptCommand(text);
  if (command.action && /keyword$/.test(command.detectionMethod)) return { ...out, skipped: 'opt_keyword' };

  const conn = require('../../models/db');
  const previous = fromPhone && toPhone
    ? await readLastOutboundBody({ conn, customerPhone: fromPhone, ourNumber: toPhone, before: receivedAt }).catch(() => null)
    : null;
  const { smsSubjectHash, smsCustomerText } = require('./subject-hash');
  const { isSolicitationPitch } = require('../sms-solicitation-detector');
  const raw = typeof body === 'string' ? body.trim() : '';
  const state = { previous_waves_text: previous || null, customer_text: smsCustomerText(raw) };
  const baseline = { rules: isSolicitationPitch(text) };
  if (verdict && verdict.method === 'model' && typeof verdict.solicitation === 'boolean') baseline.production = verdict.solicitation;
  const providers = typedDecisionsClefLive() ? ['typesafe', 'cloudflare'] : ['typesafe'];
  await askAndRecord({
    packageId: 'sms_solicitation.v1', question: 'is_solicitation', baseline, state, smsLogId,
    subjectHash: smsSubjectHash({ previous, body: raw }), providers, out,
  });
  return out;
}

module.exports = { shadowInboundSms, shadowUnknownSenderSms, readLastOutboundBody };
