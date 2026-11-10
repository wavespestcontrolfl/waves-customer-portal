'use strict';

/**
 * The technician estimate tool, step 4 (GATE_TECH_ESTIMATES, owner 2026-11-09): send his own draft by text from the phone.
 * This is the step that can text a customer, so it only goes through the office's own estimate send
 * (routes/admin-estimates.js sendEstimateNow), after the checks the office's send route makes (see claimForSend), and it
 * adds no wording: the text is the office's own estimate text.
 *
 *  - Decided from the stored row, never from the request: a held estimate (tech_estimates.office_first_reasons not empty)
 *    is the office's to send; an estimate that is not a draft is already sent (or the office's).
 *  - A NEW person (no customer id) needs the technician's confirmation that the person asked for the estimate by text
 *    (`askedForText: true`). The portal stores the time (text_request_confirmed_at) and hands it to the text as its consent
 *    basis (source tech_estimate_on_site_request). A customer on his route needs none.
 *  - The window: the text goes 8 AM to 8 PM ET only (entry point tech_estimate_send is fenced like moving_auto_send), checked
 *    here first so nothing is claimed outside it. A held estimate stays a draft he can send later.
 *  - The claim: draft to sending under a row lock (the office route's own claim predicates, the same SQL fragments), so a
 *    second tap while the first is sending answers 409 already_sent and the provider is called once.
 *  - A text that does not go is never retried from the phone. The estimate is parked as send_failed (the office can send it
 *    from the estimate tool; the phone cannot) and the office bell rings once (tech-estimate-office-bell.js ringSendFailed).
 *  - A sent text stamps sent_by_technician_at, writes one audit event (ids only) and one quiet owner line.
 */

const db = require('../models/db');
const logger = require('./logger');
const Price = require('./tech-estimate-price');
const { isWithinSendWindowET } = require('./messaging/send-window');
const { nanpPhoneProblem } = require('../utils/phone');
const { SERVER_PRICING_AUTHORITY_SQL, GATED_SEND_AUTHORITY_SQL, gatedSendAuthorityPredicateApplies } = require('./pricing-authority-gate');
const {
  ADDRESS_UNVERIFIED_ABSENT_SQL, DELIVERY_CLAIM_NOT_LIVE_SQL, REPRICE_PENDING_ABSENT_SQL,
} = require('../utils/estimate-claim-sql');

const { PriceRefusal } = Price;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// The tests set the clock; production reads the real one.
const clock = { now: () => new Date() };

const refuse = {
  notFound: () => new PriceRefusal(404, 'Estimate not found'),
  officeFirst: () => new PriceRefusal(409, 'The office checks this one first.', { code: 'office_first' }),
  alreadySent: () => new PriceRefusal(409, 'This estimate was already sent.', { code: 'already_sent' }),
  noMobile: () => new PriceRefusal(422, 'This estimate has no mobile number. Ask the office to send it.', { code: 'office_sends' }),
  needsText: () => new PriceRefusal(400, 'Confirm that the person asked for the estimate by text.', { code: 'needs_text_request' }),
  outsideHours: () => new PriceRefusal(409, 'Texts go out between 8 AM and 8 PM. Send it then, or ask the office.', { code: 'outside_hours' }),
  officeSends: (status = 422) => new PriceRefusal(status, 'The text did not go. The office will send it.', { code: 'office_sends' }),
};

const parseData = (row) => Price.parseEstimateData(row) || {};
// An earlier send (the office's, with an attempt key) that started and never recorded a result: its outcome is unknown.
const hasUncertainAttempt = (row) => {
  const attempts = parseData(row).manualSendAttempts;
  return Array.isArray(attempts) && attempts.some((entry) => entry && entry.startedAt && !entry.result);
};

// The first refusal for his stored row, or null. The order is the order of the answers: held, not a draft, no number, no
// confirmation, then the holds the office send also stops on (a group, a price lock, an unfinished earlier send).
function refusalFor(row, body) {
  if (!row || row.archived_at) return refuse.notFound();
  const reasons = Array.isArray(row.tool_reasons) ? row.tool_reasons : [];
  if (reasons.length > 0) return refuse.officeFirst();
  if (row.status === 'send_failed') return refuse.officeSends(409);
  if (row.status !== 'draft') return refuse.alreadySent();
  if (!row.customer_phone || nanpPhoneProblem(row.customer_phone)) return refuse.noMobile();
  if (!row.customer_id && body.askedForText !== true) return refuse.needsText();
  if (row.estimate_group_id || row.price_locked_at || hasUncertainAttempt(row)) return refuse.officeSends();
  return null;
}

// The office route's own sendability check (assertEstimateSendable: archive, re-price hold, address check, legacy price,
// engine review, palm count). It runs again inside the shared sender; running it here first means a refusal claims nothing.
function sendabilityRefusal(row) {
  try {
    require('../routes/admin-estimates')._internals.assertEstimateSendable(row);
    return null;
  } catch (err) {
    logger.info(`[tech-estimates] estimate ${row.id} not sendable from the phone (${String(err.code || err.statusCode || 'refused').slice(0, 40)})`);
    return refuse.officeSends();
  }
}

// The row a send may claim, the office route's claim predicates plus the server-price and no-hold rules the app's own send
// (moving-auto-send.js) uses.
const claimable = (trx, id) => trx('estimates')
  .where({ id, status: 'draft' })
  .whereNull('archived_at')
  .whereNull('price_locked_at')
  .whereNull('estimate_group_id')
  .whereRaw(SERVER_PRICING_AUTHORITY_SQL)
  .whereRaw("estimate_data->'proposal' IS NULL")
  .whereRaw(ADDRESS_UNVERIFIED_ABSENT_SQL)
  .whereRaw(REPRICE_PENDING_ABSENT_SQL)
  .whereRaw(DELIVERY_CLAIM_NOT_LIVE_SQL)
  .modify((q) => { if (gatedSendAuthorityPredicateApplies()) q.whereRaw(GATED_SEND_AUTHORITY_SQL); });

// One transaction: lock his tool row and the estimate, run every refusal against the stored row, then claim the draft for
// the send (draft to sending) and, for a new person, store the confirmation time with the claim. `ctx.row` is set as soon
// as the row is read, so the caller can tell the office about a refusal.
async function claimForSend(req, id, body, ctx) {
  if (typeof id !== 'string' || !UUID_RE.test(id)) throw refuse.notFound();
  return db.transaction(async (trx) => {
    const row = await trx('tech_estimates as t')
      .join('estimates as e', 'e.id', 't.estimate_id')
      .where({ 't.estimate_id': id, 't.technician_id': req.technicianId })
      .forUpdate()
      .first('e.*', 't.office_first_reasons as tool_reasons');
    ctx.row = row || null;
    const refusal = refusalFor(row, body);
    if (refusal) throw refusal;
    const unsendable = sendabilityRefusal(row);
    if (unsendable) throw unsendable;
    if (!isWithinSendWindowET(clock.now())) throw refuse.outsideHours();
    const [claimed] = await claimable(trx, id).update({ status: 'sending', send_method: 'sms', updated_at: clock.now() }).returning('*');
    if (!claimed) throw refuse.alreadySent();
    const consentAt = row.customer_id ? null : clock.now();
    if (consentAt) await trx('tech_estimates').where({ estimate_id: id }).update({ text_request_confirmed_at: consentAt });
    return { claimed, consentAt };
  });
}

const smsHeld = (result) => result?.channels?.sms?.code === 'QUIET_HOURS_HOLD';
const wasUncertain = (result, error) => (error
  ? !(Number(error.statusCode) >= 400 && Number(error.statusCode) < 500)
  : result?.uncertain === true || Object.values(result?.channels || {}).some((ch) => ch && ch.uncertain));

// The shared sender, on the claimed row. A throw comes back as { error }; nothing here retries.
async function deliver(claimed, consentAt) {
  const sender = require('../routes/admin-estimates').sendEstimateNow;
  try {
    return {
      result: await sender({ ...claimed, status: 'sending' }, 'sms', {
        now: clock.now,
        techEstimateSend: consentAt ? { consentCapturedAt: consentAt.toISOString() } : {},
      }),
    };
  } catch (error) {
    return { error };
  }
}

// The window held the text at its edge: the draft goes back, still his to send.
async function releaseHeld(id) {
  await db('estimates').where({ id, status: 'sending' }).update({ status: 'draft', send_method: null, updated_at: clock.now() });
}

// Nothing (or nothing certain) went. The draft is parked as send_failed, which the office can send and the phone cannot.
// A send that already moved the row on (it parked itself, or the customer accepted) keeps its state.
async function parkForOffice(id, code) {
  await db('estimates').where({ id, status: 'sending' })
    .update({ status: 'send_failed', send_method: null, last_send_error: code, updated_at: clock.now() });
}

async function ringOffice(req, estimate) {
  try {
    await require('./tech-estimate-office-bell').ringSendFailed({ estimate, technician: req.technician });
  } catch (err) {
    logger.warn(`[tech-estimates] office bell not raised for estimate ${estimate.id} (technician ${req.technicianId}): ${String(err?.code || err?.name || 'error').slice(0, 40)}`);
  }
}

// The text went: the stamp and the audit event together, then the quiet owner line. None of it can unsend the text, so a
// failure here is logged (ids only) and never fails the answer.
async function recordSent(req, claimed) {
  try {
    await db.transaction(async (trx) => {
      await trx('tech_estimates').where({ estimate_id: claimed.id }).update({ sent_by_technician_at: clock.now() });
      await require('./audit-log').recordAuditEvent({
        actor_type: 'technician',
        actor_id: req.technicianId,
        action: 'tech_estimate.sent',
        resource_type: 'estimates',
        resource_id: claimed.id,
        metadata: { estimate_id: claimed.id, technician_id: req.technicianId, customer_id: claimed.customer_id || null, new_person: !claimed.customer_id },
        critical: true,
        trx,
      });
    });
  } catch (err) {
    logger.error(`[tech-estimates] send bookkeeping failed for estimate ${claimed.id}: ${String(err?.code || err?.name || 'error').slice(0, 40)}`);
  }
  await ownerLine(req, claimed);
}

// A quiet Activity line (owner-alerts kind tech-estimate-sent): who sent, to whom by name. No phone, no price.
async function ownerLine(req, claimed) {
  try {
    const { fitAction } = require('./admin-alert-names');
    const Bell = require('./tech-estimate-office-bell');
    const who = await Bell.whoFor(claimed);
    const tech = Bell.techFirstName(req.technician);
    await require('./owner-alerts').recordOwnerAlert('tech-estimate-sent', {
      action: fitAction('Estimates', who, [(name) => `look over ${tech}'s estimate to ${name}`, (name) => `look over the estimate to ${name}`]),
      why: `${tech} texted this estimate from the route.`,
      link: `/admin/estimates?estimateId=${encodeURIComponent(claimed.id)}`,
      subject: { type: 'estimate', id: String(claimed.id) },
      dedupeKey: `owner-alert:tech-estimate-sent:${claimed.id}`,
      itemKeys: [String(claimed.id)],
      ...(claimed.customer_id ? { metadata: { customerId: claimed.customer_id } } : {}),
    });
  } catch (err) {
    logger.error(`[tech-estimates] owner line failed for estimate ${claimed.id}: ${String(err?.code || err?.name || 'error').slice(0, 40)}`);
  }
}

// What the shared sender did, as the phone's answer. Sent: the stamp, the audit event and the owner line. Held by the
// window: back to a draft. Anything else: parked for the office, and the office bell rings.
async function settle(req, claimed, { result, error }) {
  if (result && result.sent) {
    await recordSent(req, claimed);
    const fresh = await db('estimates').where({ id: claimed.id }).first('status', 'sent_at');
    return { id: claimed.id, status: fresh?.status || 'sent', sentAt: fresh?.sent_at || null };
  }
  if (!error && smsHeld(result)) {
    await releaseHeld(claimed.id);
    throw refuse.outsideHours();
  }
  const uncertain = wasUncertain(result, error);
  await parkForOffice(claimed.id, uncertain ? 'tech_send_uncertain' : 'tech_send_not_sent');
  if (error) logger.error(`[tech-estimates] send for estimate ${claimed.id} failed (${String(error.code || error.name || 'error').slice(0, 40)})`);
  await ringOffice(req, claimed);
  throw refuse.officeSends(uncertain ? 502 : 422);
}

/** POST /:id/send. Answers { id, status, sentAt }, or throws a PriceRefusal the route shapes. */
async function sendOwn(req, id, rawBody) {
  const body = { askedForText: rawBody && rawBody.askedForText === true };
  const ctx = { row: null };
  let claim;
  try {
    claim = await claimForSend(req, id, body, ctx);
  } catch (err) {
    // The office hears of every refusal that hands the estimate to it (not of a held window or a duplicate tap).
    if (err instanceof PriceRefusal && err.extra.code === 'office_sends' && ctx.row) await ringOffice(req, ctx.row);
    throw err;
  }
  return settle(req, claim.claimed, await deliver(claim.claimed, claim.consentAt));
}

module.exports = { sendOwn, _private: { clock, refusalFor, wasUncertain } };
