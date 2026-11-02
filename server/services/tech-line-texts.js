/**
 * Texting a visit's customer from the technician's own line: the send path
 * routes/tech-line.js serves (/sms, /set-text) and the "Waves Tech" voice
 * line uses for set texts (services/voice-agent/tech-voice-conversation.js).
 * One path, so both get the same visit scope, line, open-visit check,
 * duplicate claim, human-reply lifecycle and provider-outcome handling.
 *
 * `actor` is { techRole, technicianId }: an authenticated request satisfies
 * it, and the voice line passes a technician actor (never admin scope).
 * Results are the { status, json } the routes answer with.
 */
const db = require('../models/db');
const logger = require('./logger');
const featureGates = require('../config/feature-gates');
const { techLineContext } = require('./tech-line');
const { technicianVisitRowInScope } = require('./technician-visit-scope');
const { sendCustomerMessage } = require('./messaging/send-customer-message');
const { isRealProviderSend, isAmbiguousProviderOutcome } = require('./sms-auto-send');
const { reserveHumanReply, settleHumanReply } = require('./sms-suggest-mode');
const {
  isSetTextKind, renderSetText, setTextClaimKey, openSetTextVisit,
} = require('./tech-set-texts');
const TWILIO_NUMBERS = require('../config/twilio-numbers');
const { toE164, isLikelyE164 } = require('../utils/phone');

// An identical tech-line text that already went out to the customer inside
// this window is a double submit (two open PWAs), not a second message. The
// window matches the provider's own retry horizon for an ambiguous outcome
// (classifyProviderFailure's retryAfterMs, 5 minutes): a claim kept for a
// text Twilio may still hold must outlive every retry that horizon allows
// (codex #4072 r19 P2).
const DUPLICATE_TEXT_WINDOW = '5 minutes';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function publicLine(ctx) {
  return { number: ctx.line.number, formatted: ctx.line.formatted, label: ctx.line.label };
}

// The visit's customer, or a { status, error } rejection. Techs reach only
// visits assigned to them; admins any visit.
async function visitCustomer(actor, scheduledServiceId) {
  if (!UUID_RE.test(String(scheduledServiceId || ''))) return { status: 400, error: 'scheduledServiceId is required' };
  const svc = await db('scheduled_services').where({ id: scheduledServiceId }).first('id', 'customer_id', 'technician_id', 'status', 'scheduled_date');
  if (!svc) return { status: 404, error: 'Visit not found' };
  if (!technicianVisitRowInScope(actor, svc)) return { status: 403, error: 'Not assigned to this visit' };
  const customer = await db('customers').where({ id: svc.customer_id }).whereNull('deleted_at').first();
  if (!customer) return { status: 404, error: 'Customer not found' };
  const to = toE164(customer.phone);
  if (!to || !isLikelyE164(to)) return { status: 409, error: 'This customer has no phone on file' };
  // A Waves line or a staff forward number on the customer row is a data
  // error, never a target: dialing it would re-enter /voice with the tech
  // line as caller ID (codex #4072 r1 P1). The SMS provider blocks the same.
  if (TWILIO_NUMBERS.isInternalNumber(to)) return { status: 409, error: 'This customer\'s phone on file is a Waves number — fix it before contacting them' };
  return { customer, to, visit: svc };
}


// The atomic cross-process gate both send routes use: sms_send_claims (the
// table the public estimate route claims through) — a fresh insert, or a
// takeover of a claim older than the window, in ONE statement on the pool.
// No advisory-lock transaction: holding a pooled connection while the send
// or the bridge takes a second one from the same pool wedges every slot
// under a burst (codex #4072 r15 P2); the unique key is the serialization.
async function claimSend(claimKey, window) {
  const claim = await db.raw(
    `INSERT INTO sms_send_claims (claim_key) VALUES (?)
     ON CONFLICT (claim_key) DO UPDATE SET created_at = NOW()
     WHERE sms_send_claims.created_at < NOW() - interval '${window}'
     RETURNING id`,
    [claimKey],
  );
  return (claim?.rows || []).length > 0;
}
// A send that never left must not stay claimed for the window, or the
// tech's real retry silently 409s.
function releaseClaim(claimKey) {
  return db('sms_send_claims').where({ claim_key: claimKey }).del()
    .catch((err) => logger.warn(`[tech-line] claim release failed (${String(err?.code || err?.name || 'error')})`));
}
// AMBIGUOUS provider outcome — the admin composer's rule (GH Codex #3851 r4
// P1): an explicit uncertain result is not a definitive no-send; the
// provider may hold the text. Claims stay held and parked suggestions stay
// parked. Legacy providers fall back to retryable/deferred classification.
// A tech's real text is a first response to any open lead on this phone —
// the same Speed-to-Lead stamp the admin composer makes after a real
// provider send; no watcher stamps manual rows later (codex #4072 r8 P2).
// Fail-soft: SLA bookkeeping never breaks a send that already left.
async function stampTechFirstResponse({ to, technicianId }) {
  try {
    const { stampFirstResponseByContact } = require('./lead-estimate-link');
    await stampFirstResponseByContact({ phone: to, performedBy: `tech:${technicianId}` });
  } catch (stampErr) {
    logger.warn(`[tech-line] first-response stamp failed: ${stampErr.message}`);
  }
}

// The reserve → send → settle → stamp sequence for one text, as the
// { status, json, ambiguous } the handler answers with. Throws for the
// sanitized 500 (an ambiguous throw carries err.providerOutcome).
async function textFromLine({ actor, ctx, target, body, metadata }) {
  // The same human-reply lifecycle the admin composer runs: park the
  // thread's pending suggestions (and back off an autonomous reply mid-
  // send) before Twilio, settle after — so the tech's text counts as the
  // human answer every guard looks for (message_type manual).
  const reply = await reserveHumanReply({
    to: target.to, customerId: target.customer.id, fromNumber: ctx.line.number, body, adminUserId: actor.technicianId,
  });
  if (reply.autoSendInFlight) {
    return { status: 409, json: { error: 'An automatic reply to this customer is being sent right now — try again in a moment', code: 'AUTO_REPLY_IN_FLIGHT' } };
  }
  // Ambiguous: retain the reservation and parked suggestions so recovery
  // cannot reopen a reply the customer may already hold. Provider evidence
  // can settle the held decisions later.
  const settleAmbiguous = () => settleHumanReply({ ...reply, parkedDecisionIds: [], sent: false, ambiguous: true, reviewedBy: actor.technicianId }).catch(() => {});
  const providerHandoffReservation = reply.reservationId
    ? require('./messaging/provider-handoff-reservation').borrowProviderHandoffReservation({
      reservationId: reply.reservationId,
      to: target.to,
      fromNumber: ctx.line.number,
      body,
      messageType: 'manual',
      adminUserId: actor.technicianId,
    })
    : null;
  let result;
  try {
    result = await sendCustomerMessage({
      to: target.to,
      body,
      channel: 'sms',
      audience: 'customer',
      purpose: 'conversational',
      customerId: target.customer.id,
      identityTrustLevel: 'phone_matches_customer',
      entryPoint: 'tech_line_text',
      providerHandoffReservation,
      metadata: {
        ...metadata,
        original_message_type: 'manual',
        tech_line: true,
        scheduled_service_id: target.visit.id,
        adminUserId: actor.technicianId,
        fromNumber: ctx.line.number,
        parkedDecisionIds: reply.parkedDecisionIds.length ? reply.parkedDecisionIds : undefined,
      },
    });
  } catch (err) {
    // A throw AFTER Twilio accepted (the audit write failed — the error
    // carries the provider outcome, the composer's convention) means the
    // customer HAS the text: it is answered, and the tech must not be
    // invited to send it again (codex #4072 r2 P1).
    const accepted = err?.providerOutcome?.sent === true && isRealProviderSend(err.providerOutcome);
    if (!accepted && isAmbiguousProviderOutcome(err?.providerOutcome)) await settleAmbiguous();
    else await settleHumanReply({
      ...reply,
      sent: accepted,
      acceptedResult: accepted ? err.providerOutcome : null,
      reviewedBy: actor.technicianId,
    }).catch(() => {});
    if (!accepted) throw err;
    logger.error(`[tech-line] text accepted but its audit write failed (${String(err.code || err.name || 'error')}) for visit ${target.visit.id}`);
    // The customer has the text: it is a first response too (codex r13 P2).
    await stampTechFirstResponse({ to: target.to, technicianId: actor.technicianId });
    return { status: 200, json: { success: true, from: publicLine(ctx) } };
  }
  // A suppression / gate-off sentinel comes back sent:true with no real
  // provider id — the tech must not see "Sent." for a text that never left.
  const delivered = result.sent && isRealProviderSend(result);
  if (!delivered) {
    const ambiguous = isAmbiguousProviderOutcome(result);
    if (ambiguous) await settleAmbiguous();
    else await settleHumanReply({ ...reply, sent: false, reviewedBy: actor.technicianId }).catch(() => {});
    const code = result.code || (result.sent ? 'SMS_GATE_OFF' : 'NOT_SENT');
    logger.info(`[tech-line] text from ${ctx.line.number} not sent for visit ${target.visit.id}: ${code}${ambiguous ? ' (ambiguous)' : ''}`);
    return {
      status: 409,
      ambiguous,
      json: {
        error: ambiguous
          ? 'The carrier did not confirm this text — it may still go out. Check the thread before sending it again.'
          : (result.reason || (result.sent ? 'Texting is switched off right now' : 'Message was not sent')),
        code,
        deferred: Boolean(result.deferred),
        ...(ambiguous ? { mayHaveSent: true } : {}),
      },
    };
  }
  await settleHumanReply({ ...reply, sent: true, acceptedResult: result, reviewedBy: actor.technicianId }).catch(() => {});
  await stampTechFirstResponse({ to: target.to, technicianId: actor.technicianId });
  return { status: 200, json: { success: true, from: publicLine(ctx) } };
}

// One text under its durable claim: the claim is taken BEFORE the send and
// released only when the text definitively never left (a refusal, a validator
// block, a throw before acceptance); an ambiguous outcome keeps it. Shared by
// /sms (claim on customer + body) and /set-text (claim on visit + kind).
async function sendClaimedText({ actor, ctx, target, body, claimKey, metadata = null }) {
  if (!(await claimSend(claimKey, DUPLICATE_TEXT_WINDOW))) {
    return { status: 409, json: { error: 'This text just went out to the customer', code: 'DUPLICATE_TEXT' } };
  }
  let out;
  try {
    out = await textFromLine({ actor, ctx, target, body, metadata });
  } catch (err) {
    if (!isAmbiguousProviderOutcome(err?.providerOutcome)) await releaseClaim(claimKey);
    throw err;
  }
  if (out.status !== 200 && !out.ambiguous) await releaseClaim(claimKey);
  if (out.status === 200) {
    // One row per delivered text — a daily horizon keeps the table trivial
    // (weekly claims such as the BI briefing's are kept: sms-send-claims.js).
    void require('./sms-send-claims').pruneSmsSendClaims().catch(() => {});
  }
  return out;
}

// Everything a set text needs before it goes out, or the refusal the routes
// answer with: the gate, a known kind, the caller's line, the visit in the
// caller's scope with a usable customer phone, and a visit that is today's
// and not finished. The voice line reads the wording back from this before
// the technician says yes; the send re-checks all of it.
async function prepareSetText({ actor, scheduledServiceId, kind }) {
  const refuse = (status, json) => ({ ok: false, status, json });
  if (!featureGates.techSetTextsLive()) return refuse(404, { error: 'Not found' });
  if (!isSetTextKind(kind)) return refuse(400, { error: 'Unknown set text', code: 'UNKNOWN_SET_TEXT' });
  const ctx = await techLineContext(actor.technicianId, { strict: true });
  if (!ctx) return refuse(409, { error: 'You have no tech line assigned', code: 'NO_TECH_LINE' });
  const target = await visitCustomer(actor, scheduledServiceId);
  if (target.error) return refuse(target.status, { error: target.error });
  if (!(await openSetTextVisit(db, target.visit.id))) {
    return refuse(409, { error: 'Set texts are for today\'s visits that are not finished', code: 'VISIT_NOT_OPEN' });
  }
  return { ok: true, ctx, target, kind, body: renderSetText(kind, target.customer) };
}

// A set text: fixed wording rendered here, never client text. The claim is on
// (visit, kind), so a second tap — or the voice line asking for the same text
// on the same visit — inside the window is a duplicate even though the body
// is identical for two visits of one customer.
async function sendSetText({ actor, scheduledServiceId, kind }) {
  const prepared = await prepareSetText({ actor, scheduledServiceId, kind });
  if (!prepared.ok) return { status: prepared.status, json: prepared.json };
  const { ctx, target, body } = prepared;
  const out = await sendClaimedText({
    actor, ctx, target, body, claimKey: setTextClaimKey(target.visit.id, kind), metadata: { set_text_kind: kind },
  });
  return out.status === 200 ? { ...out, json: { ...out.json, kind, body } } : out;
}

module.exports = {
  UUID_RE,
  publicLine,
  visitCustomer,
  claimSend,
  releaseClaim,
  sendClaimedText,
  prepareSetText,
  sendSetText,
};
