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
 * been delivered blocks a resend. One try, then stop: a send known NOT
 * delivered is final as well (owner 2026-10-01).
 *
 * Best-effort end to end: nothing here throws, blocks or fails completion.
 */

const logger = require('../logger');
const { lawnWateringSmsLive, lawnWateringRuleLive } = require('../../config/feature-gates');
const { etDateString } = require('../../utils/datetime-et');

const TEMPLATE_KEY = 'lawn_watering_instruction';
const PURPOSE = 'lawn_watering_instruction';
const SENDABLE_STATES = Object.freeze(['hold', 'water_in', 'hold_then_water_in']);

// Statuses that end the obligation for this visit. One try, then stop (owner
// 2026-10-01): a send known NOT delivered ('failed') is final too, never
// retried or requeued; the report banner still carries the instruction. 'sending' is covered by the uncertainty
// fence below, which is written in the same claim.
const STALE_CODE = 'LAWN_WATERING_STALE';
const TERMINAL_STATUSES = Object.freeze(['sent', 'failed', 'skipped_blocked', 'skipped_quiet_hours']);

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
  // Same sentences as the report, with the typographic apostrophe the report
  // uses (U+2019) swapped for ASCII: one curly quote forces the whole text
  // into UCS-2 and roughly doubles its segments.
  return instruction.lines
    .filter((line) => typeof line === 'string' && line.trim() !== '')
    .map((line) => line.replace(/\u2019/g, "'"));
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
// Fresh only: the lines say "today" / "tonight" and name clock times on the
// visit's own day, so a completion resumed on a later ET day, or after the
// instruction's deadline, never sends them. Judged against the completion
// instant the lines were built from (never the freeze time, which a later
// resume can mint); an instruction without it fails closed. Checked at plan
// time and again at the provider handoff.
function wateringInstructionFresh(instruction, completedAt, nowMs) {
  const completedMs = completedAt ? Date.parse(completedAt) : NaN;
  if (!Number.isFinite(completedMs)) return false;
  if (etDateString(new Date(nowMs)) !== etDateString(new Date(completedMs))) return false;
  const expiresMs = instruction?.expiresAt ? Date.parse(instruction.expiresAt) : NaN;
  if (Number.isFinite(expiresMs) && nowMs >= expiresMs) return false;
  // A drying hold leaves expiresAt null while the text still names a water-in
  // deadline ("by 4 PM"): never send it at or after that deadline either.
  const waterInMs = instruction?.waterInBy ? Date.parse(instruction.waterInBy) : NaN;
  if (Number.isFinite(waterInMs) && nowMs >= waterInMs) return false;
  return true;
}

function lawnWateringSmsPlan({
  instruction = null,
  isBackfill = false,
  deliveryMode = null,
  phone = null,
  internalOnly = false,
  alreadySent = false,
  gateOn = false,
  ruleGateOn = false,
  completedAt = null,
  completionTextRequested = true,
  nowMs = Date.now(),
} = {}) {
  if (!gateOn) return { send: false, reason: 'gate_off' };
  if (!ruleGateOn) return { send: false, reason: 'rule_gate_off' };
  if (isBackfill) return { send: false, reason: 'backfill' };
  if (internalOnly) return { send: false, reason: 'internal_only' };
  if (deliveryMode !== 'auto_send') return { send: false, reason: 'not_auto_send' };
  if (!phone) return { send: false, reason: 'no_phone' };
  // A flow that deliberately sends no completion text (operator toggle,
  // Fast Complete, a grouped stop whose combined summary owns the customer
  // message) gets no watering text either. Only an attempted completion text
  // that failed or was withheld still gets it (owner 2026-09-30).
  if (!completionTextRequested) return { send: false, reason: 'completion_text_not_requested' };
  if (alreadySent) return { send: false, reason: 'already_sent' };
  if (!instruction || !SENDABLE_STATES.includes(instruction.state)) {
    return { send: false, reason: 'no_instruction' };
  }
  const lines = wateringLinesOf(instruction);
  if (!lines.length) return { send: false, reason: 'no_lines' };
  if (!wateringInstructionFresh(instruction, completedAt, nowMs)) return { send: false, reason: 'stale' };
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
    const instruction = notes?.lawnWateringFreeze?.wateringInstruction || null;
    const completedAt = instruction?.completedAt || null;
    const plan = lawnWateringSmsPlan({
      instruction,
      isBackfill: args.isBackfill === true,
      deliveryMode: args.deliveryMode,
      phone: svc?.cust_phone,
      internalOnly: args.internalOnly === true,
      alreadySent: lawnWateringSmsAlreadyHandled(notes),
      gateOn,
      ruleGateOn,
      completedAt,
      completionTextRequested: args.completionTextRequested === true,
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

    // One claim + send; every outcome is final ('failed' = known not delivered).
    const attemptSend = async () => {
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
        // The template read, claim write and policy lookups can cross ET
        // midnight or the instruction's deadline: recheck at the handoff.
        preSendCheck: async () => (wateringInstructionFresh(instruction, completedAt, Date.now())
          ? { ok: true }
          : { ok: false, code: STALE_CODE, reason: 'watering instruction went stale before handoff', retryable: false }),
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
        // A throw that carries a definite provider rejection (deliveryOutcome
        // 'not_sent', e.g. the audit write failed after Twilio refused) is known
        // not delivered: record it as 'failed' (final; one try, then stop).
        const notSent = !accepted && sendErr?.providerOutcome?.deliveryOutcome === 'not_sent';
        try {
          await stamp(accepted
            ? { lawnWateringSmsStatus: 'sent', lawnWateringSmsAt: new Date().toISOString(), lawnWateringSmsDeliveryUnverifiedAt: null }
            : {
              lawnWateringSmsStatus: 'failed',
              lawnWateringSmsError: String(sendErr?.code || sendErr?.name || 'exception').slice(0, 64),
              lawnWateringSmsFailedAt: new Date().toISOString(),
              ...(notSent ? { lawnWateringSmsDeliveryUnverifiedAt: null } : {}),
            });
        } catch (stampErr) {
          logger.warn(`[lawn-watering-sms] post-send status write failed for service_record ${record.id}: ${stampErr.message}`);
        }
        logger.warn(`[lawn-watering-sms] send raised for service_record ${record.id} (${sendErr?.code || sendErr?.name || 'exception'}); resend fenced`);
        return { status: accepted ? 'sent' : (notSent ? 'failed' : 'unverified') };
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

      // Went stale between the plan and the handoff: final, never resent.
      if (result && result.code === STALE_CODE) {
        await stamp({
          lawnWateringSmsStatus: 'skipped_stale',
          lawnWateringSmsDeliveryUnverifiedAt: null,
        }).catch((e) => logger.warn(`[lawn-watering-sms] stale-status write failed for service_record ${record.id}: ${e.message}`));
        return { status: 'skipped_stale' };
      }

      // A retryable block (consent / suppression lookup failed, a liftable
      // hold) is known not sent but not an opt-out: record it as 'failed'
      // with its code, final like any known-unsent send (one try, then stop).
      if (result && result.blocked && result.retryable === true) {
        await stamp({
          lawnWateringSmsStatus: 'failed',
          lawnWateringSmsError: String(result.code || 'blocked_retryable').slice(0, 64),
          lawnWateringSmsFailedAt: new Date().toISOString(),
          lawnWateringSmsDeliveryUnverifiedAt: null,
        }).catch((e) => logger.warn(`[lawn-watering-sms] retryable-block status write failed for service_record ${record.id}: ${e.message}`));
        logger.warn(`[lawn-watering-sms] retryable messaging block for service_record ${record.id}: ${result.code || 'unknown'}`);
        return { status: 'failed' };
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

      // Definite provider rejection: known not delivered; final (one try, then stop).
      await stamp({
        lawnWateringSmsStatus: 'failed',
        lawnWateringSmsError: String((result && (result.code || result.reason)) || 'send_failed').slice(0, 64),
        lawnWateringSmsFailedAt: new Date().toISOString(),
        lawnWateringSmsDeliveryUnverifiedAt: null,
      }).catch((e) => logger.warn(`[lawn-watering-sms] failed-status write failed for service_record ${record.id}: ${e.message}`));
      logger.warn(`[lawn-watering-sms] send failed for service_record ${record.id}: ${(result && (result.code || result.reason)) || 'unknown'}`);
      return { status: 'failed' };
    };

    return attemptSend();
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
