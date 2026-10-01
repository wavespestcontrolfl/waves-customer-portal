/**
 * Lawn watering text (GATE_LAWN_WATERING_SMS, owner 2026-09-30).
 *
 * A lawn visit that froze a watering instruction (hold / water in / hold then
 * water in) sends the customer ONE separate text carrying that instruction,
 * right after the completion text. It is its own message, never a line inside
 * the completion template (that 2026-08-01 ruling is reversed for this case
 * only; see service-report/delivery.js).
 *
 * The send shares the completion text's ELIGIBILITY (auto-send delivery, not a
 * backfill, not internal-only, a phone on file) but does NOT depend on the
 * completion text going out: a withheld, failed or already-handled completion
 * text still gets its watering text, because the instruction is time-sensitive
 * and stands on its own.
 *
 * Dedupe is at-most-once per visit via structured_notes keys written with
 * mergeRecordNotesKeys (lawnWateringSmsStatus / lawnWateringSmsAt, plus an
 * uncertainty fence written BEFORE the provider call, the same shape as the
 * completion text's completionSmsDeliveryUnverifiedAt). Anything that may have
 * been delivered blocks a resend; only a definite rejection stays retryable.
 *
 * Best-effort end to end: nothing here throws, blocks or fails completion.
 */

const logger = require('../logger');
const { lawnWateringSmsLive, lawnWateringRuleLive } = require('../../config/feature-gates');
const { etDateString } = require('../../utils/datetime-et');

const TEMPLATE_KEY = 'lawn_watering_instruction';
const PURPOSE = 'lawn_watering_instruction';
const SENDABLE_STATES = Object.freeze(['hold', 'water_in', 'hold_then_water_in']);

// Statuses that end the obligation for this visit. 'failed' (a definite
// provider rejection) is deliberately NOT here: it is known not delivered, so a
// resumed completion may try again. 'sending' is covered by the uncertainty
// fence below, which is written in the same claim.
const TERMINAL_STATUSES = Object.freeze(['sent', 'skipped_blocked', 'skipped_quiet_hours']);

function parseNotes(value) {
  if (!value) return {};
  if (typeof value === 'object') return Array.isArray(value) ? {} : value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}

function wateringLinesOf(instruction) {
  if (!instruction || !Array.isArray(instruction.lines)) return [];
  return instruction.lines.filter((line) => typeof line === 'string' && line.trim() !== '');
}

// Has this visit's watering text already been handled (sent, queued, blocked,
// or possibly delivered)? Reads only the structured_notes markers.
function lawnWateringSmsAlreadyHandled(notes) {
  const n = notes || {};
  return TERMINAL_STATUSES.includes(n.lawnWateringSmsStatus)
    || String(n.lawnWateringSmsStatus || '').startsWith('skipped_')
    || !!n.lawnWateringSmsDeliveryUnverifiedAt;
}

// Pure send decision. Returns { send: false, reason } or
// { send: true, vars: { watering_lines } }.
function lawnWateringSmsPlan({
  instruction = null,
  isBackfill = false,
  deliveryMode = null,
  phone = null,
  internalOnly = false,
  alreadySent = false,
  gateOn = false,
  ruleGateOn = false,
  frozenAt = null,
  nowMs = Date.now(),
} = {}) {
  if (!gateOn) return { send: false, reason: 'gate_off' };
  if (!ruleGateOn) return { send: false, reason: 'rule_gate_off' };
  if (isBackfill) return { send: false, reason: 'backfill' };
  if (internalOnly) return { send: false, reason: 'internal_only' };
  if (deliveryMode !== 'auto_send') return { send: false, reason: 'not_auto_send' };
  if (!phone) return { send: false, reason: 'no_phone' };
  if (alreadySent) return { send: false, reason: 'already_sent' };
  if (!instruction || !SENDABLE_STATES.includes(instruction.state)) {
    return { send: false, reason: 'no_instruction' };
  }
  const lines = wateringLinesOf(instruction);
  if (!lines.length) return { send: false, reason: 'no_lines' };
  // Fresh only: the lines say "today" / "tonight" and name clock times on the
  // visit's own day, so a completion resumed on a later ET day, or after the
  // instruction's deadline, never sends them. An unknown freeze time fails closed.
  const frozenMs = frozenAt ? Date.parse(frozenAt) : NaN;
  if (!Number.isFinite(frozenMs)) return { send: false, reason: 'stale' };
  if (etDateString(new Date(nowMs)) !== etDateString(new Date(frozenMs))) return { send: false, reason: 'stale' };
  const expiresMs = instruction.expiresAt ? Date.parse(instruction.expiresAt) : NaN;
  if (Number.isFinite(expiresMs) && nowMs >= expiresMs) return { send: false, reason: 'stale' };
  return { send: true, vars: { watering_lines: lines.join(' ') } };
}

/**
 * Send the watering text for one completed visit, at most once.
 *
 * @param {object} args
 * @param {object} args.record        service_records row (id, structured_notes)
 * @param {object} args.svc           scheduled_services row (id, customer_id, cust_phone)
 * @param {object} args.notes         the completion's parsed recordStructuredNotes; MUTATED in place with the markers written
 * @param {boolean} args.isBackfill
 * @param {string} args.deliveryMode  typedDeliveryMode
 * @param {boolean} args.internalOnly
 * @param {object} deps               { db, sendCustomerMessage, getTemplate, mergeNotes, throwIfDeliveryUnverified }
 * @returns {Promise<{ status: string }>} never throws
 */
async function sendLawnWateringSms(args, deps) {
  try {
    // Gate first and cheap: gate off = no reads, no writes, no throw path.
    const gateOn = lawnWateringSmsLive();
    const ruleGateOn = lawnWateringRuleLive();
    if (!gateOn || !ruleGateOn) return { status: 'gate_off' };

    const { record, svc, notes } = args;
    const plan = lawnWateringSmsPlan({
      instruction: notes?.lawnWateringFreeze?.wateringInstruction || null,
      isBackfill: args.isBackfill === true,
      deliveryMode: args.deliveryMode,
      phone: svc?.cust_phone,
      internalOnly: args.internalOnly === true,
      alreadySent: lawnWateringSmsAlreadyHandled(notes),
      gateOn,
      ruleGateOn,
      frozenAt: notes?.lawnWateringFreeze?.frozenAt || null,
      nowMs: Date.now(),
    });
    if (!plan.send) return { status: `skip_${plan.reason}` };

    // Fail closed on a missing/inactive template row: no body, no send. No
    // marker either, so a later retry after the row is fixed can still send.
    const body = await deps.getTemplate(
      TEMPLATE_KEY,
      plan.vars,
      { service_record_id: record.id, entry_point: 'lawn_watering_sms' },
      { requiredVars: ['watering_lines'] },
    );
    if (!body) {
      logger.warn(`[lawn-watering-sms] template ${TEMPLATE_KEY} missing, inactive or unrenderable; no text sent for service_record ${record.id}`);
      return { status: 'skip_no_template' };
    }

    const stamp = async (delta) => {
      await deps.mergeNotes(record.id, delta);
      Object.assign(notes, delta);
      record.structured_notes = { ...parseNotes(record.structured_notes), ...delta };
    };

    // CLAIM before the provider call. If this write fails nothing was sent and
    // nothing can be deduped, so do not send.
    const attemptedAt = new Date().toISOString();
    try {
      await stamp({
        lawnWateringSmsStatus: 'sending',
        lawnWateringSmsDeliveryUnverifiedAt: attemptedAt,
        lawnWateringSmsAttemptedAt: attemptedAt,
      });
    } catch (claimErr) {
      logger.warn(`[lawn-watering-sms] claim write failed for service_record ${record.id}; not sending: ${claimErr.message}`);
      return { status: 'skip_claim_failed' };
    }

    const sendInput = {
      to: svc.cust_phone,
      body,
      channel: 'sms',
      audience: 'customer',
      purpose: PURPOSE,
      customerId: svc.customer_id,
      appointmentId: svc.id,
      identityTrustLevel: 'phone_matches_customer',
      metadata: {
        original_message_type: TEMPLATE_KEY,
        service_record_id: record.id,
        notificationEventKey: `scheduled-service:${svc.id}:lawn-watering`,
        useCustomerChannel: true,
        templateKey: TEMPLATE_KEY,
      },
    };

    let result;
    try {
      result = deps.throwIfDeliveryUnverified(await deps.sendCustomerMessage(sendInput));
    } catch (sendErr) {
      // Past this point the text MAY have been delivered (the messaging layer
      // throws after provider acceptance when its own audit write fails), so
      // the uncertainty fence stays and blocks any resend.
      const accepted = sendErr?.providerOutcome?.sent === true;
      try {
        await stamp(accepted
          ? { lawnWateringSmsStatus: 'sent', lawnWateringSmsAt: new Date().toISOString(), lawnWateringSmsDeliveryUnverifiedAt: null }
          : { lawnWateringSmsStatus: 'failed', lawnWateringSmsError: String(sendErr?.code || sendErr?.name || 'exception').slice(0, 64), lawnWateringSmsFailedAt: new Date().toISOString() });
      } catch (stampErr) {
        logger.warn(`[lawn-watering-sms] post-send status write failed for service_record ${record.id}: ${stampErr.message}`);
      }
      logger.warn(`[lawn-watering-sms] send raised for service_record ${record.id} (${sendErr?.code || sendErr?.name || 'exception'}); resend fenced`);
      return { status: accepted ? 'sent' : 'unverified' };
    }

    if (result && result.sent === true) {
      await stamp({
        lawnWateringSmsStatus: 'sent',
        lawnWateringSmsAt: new Date().toISOString(),
        lawnWateringSmsDeliveryUnverifiedAt: null,
      }).catch((e) => logger.warn(`[lawn-watering-sms] sent-status write failed for service_record ${record.id}: ${e.message}`));
      return { status: 'sent' };
    }

    // Quiet-hours hold: never requeued. The instruction's clock times are
    // anchored to the visit's own day ("until 9 PM tonight", "water in by 8 PM
    // tonight"), so a text held to the next morning would read wrong or past
    // its deadline. Final skip; the report banner still carries the instruction.
    if (result && result.code === 'QUIET_HOURS_HOLD') {
      await stamp({
        lawnWateringSmsStatus: 'skipped_quiet_hours',
        lawnWateringSmsDeliveryUnverifiedAt: null,
      }).catch((e) => logger.warn(`[lawn-watering-sms] quiet-hours status write failed for service_record ${record.id}: ${e.message}`));
      return { status: 'skipped_quiet_hours' };
    }

    // Policy block (consent, STOP, suppression): intentional and final.
    if (result && result.blocked) {
      await stamp({
        lawnWateringSmsStatus: 'skipped_blocked',
        lawnWateringSmsBlockCode: String(result.code || 'blocked').slice(0, 64),
        lawnWateringSmsDeliveryUnverifiedAt: null,
      }).catch((e) => logger.warn(`[lawn-watering-sms] blocked-status write failed for service_record ${record.id}: ${e.message}`));
      logger.info(`[lawn-watering-sms] blocked by messaging policy for service_record ${record.id}: ${result.code || 'unknown'}`);
      return { status: 'skipped_blocked' };
    }

    // Definite provider rejection: known not delivered, so the fence is lifted
    // and the status stays retryable on a resumed completion.
    await stamp({
      lawnWateringSmsStatus: 'failed',
      lawnWateringSmsError: String((result && (result.code || result.reason)) || 'send_failed').slice(0, 64),
      lawnWateringSmsFailedAt: new Date().toISOString(),
      lawnWateringSmsDeliveryUnverifiedAt: null,
    }).catch((e) => logger.warn(`[lawn-watering-sms] failed-status write failed for service_record ${record.id}: ${e.message}`));
    logger.warn(`[lawn-watering-sms] send failed for service_record ${record.id}: ${(result && (result.code || result.reason)) || 'unknown'}`);
    return { status: 'failed' };
  } catch (err) {
    logger.warn(`[lawn-watering-sms] unexpected error (completion unaffected): ${err.message}`);
    return { status: 'error' };
  }
}

module.exports = {
  TEMPLATE_KEY,
  PURPOSE,
  SENDABLE_STATES,
  lawnWateringSmsPlan,
  lawnWateringSmsAlreadyHandled,
  sendLawnWateringSms,
};
