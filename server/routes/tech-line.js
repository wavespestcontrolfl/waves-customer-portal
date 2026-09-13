/**
 * /api/tech/line — the technician's own Twilio line, from the tech portal.
 *
 *   GET  /        → { line: { number, formatted, label }, canCall } or
 *                   { line: null } when the caller holds no line (gate off,
 *                   no assignment, not assignable) — the brief panel then
 *                   keeps its tel:/sms: links from the personal phone.
 *   POST /sms     → { scheduledServiceId, body } — texts the visit's customer
 *                   FROM the tech's line through sendCustomerMessage (every
 *                   guard applies: consent, suppression, quiet hours — an
 *                   operator entry point, so a human's tap is not fenced as
 *                   automation). The office sees the thread on the line.
 *   POST /call    → { scheduledServiceId } — click-to-call through the shared
 *                   bridge (services/call-bridge.js): Twilio rings the tech's
 *                   cell first, they press 1, the customer is dialed with the
 *                   tech line as caller ID. Same press-1 shape the office uses.
 *
 * The customer is always derived from the VISIT (the tech's own route, or
 * any visit for an admin) — the client never supplies a phone number, so a
 * tech cannot reach an arbitrary number from a Waves line.
 */
const express = require('express');
const router = express.Router();
const db = require('../models/db');
const logger = require('../services/logger');
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');
const { techLineContext } = require('../services/tech-line');
const { placeBridgeCall, activeBridgeCall } = require('../services/call-bridge');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const crypto = require('crypto');
const { isRealProviderSend, isAmbiguousProviderOutcome } = require('../services/sms-auto-send');
const { normalizeGsmPunctuation } = require('../services/messaging/gsm-normalize');
const { reserveHumanReply, settleHumanReply } = require('../services/sms-suggest-mode');
const { alertTwilioFailure } = require('../services/twilio-failure-alerts');
const { isEnabled } = require('../config/feature-gates');
const TWILIO_NUMBERS = require('../config/twilio-numbers');
const { toE164, isLikelyE164 } = require('../utils/phone');

router.use(adminAuthenticate, requireTechOrAdmin);

const MAX_TEXT_CHARS = 600;
// An identical tech-line text that already went out to the customer inside
// this window is a double submit (two open PWAs), not a second message. The
// window matches the provider's own retry horizon for an ambiguous outcome
// (classifyProviderFailure's retryAfterMs, 5 minutes): a claim kept for a
// text Twilio may still hold must outlive every retry that horizon allows
// (codex #4072 r19 P2).
const DUPLICATE_TEXT_WINDOW = '5 minutes';
// The claim key hashes the body AS SENT — sendCustomerMessage GSM-normalizes
// a plain customer SMS — so two submits of the same text share one key.
function sentBodyHash(body) {
  return crypto.createHash('sha256').update(normalizeGsmPunctuation(body), 'utf8').digest('hex');
}
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function publicLine(ctx) {
  return { number: ctx.line.number, formatted: ctx.line.formatted, label: ctx.line.label };
}

// A provider / DB error here can carry the customer's phone and the message
// body in its text (a knex message binds them). Log the code only and hand
// the error middleware — which logs err.message verbatim — a clean one.
function sanitized(err, label) {
  const code = String((err && (err.code || err.name)) || 'error');
  logger.error(`[tech-line] ${label} failed (${code})`);
  const safe = new Error(`Tech line ${label} failed`);
  safe.isOperational = true;
  safe.statusCode = 500;
  safe.code = code;
  return safe;
}

// The visit's customer, or a { status, error } rejection. Techs reach only
// visits assigned to them; admins any visit.
async function visitCustomer(req, scheduledServiceId) {
  if (!UUID_RE.test(String(scheduledServiceId || ''))) return { status: 400, error: 'scheduledServiceId is required' };
  const svc = await db('scheduled_services').where({ id: scheduledServiceId }).first('id', 'customer_id', 'technician_id');
  if (!svc) return { status: 404, error: 'Visit not found' };
  if (req.techRole !== 'admin' && svc.technician_id !== req.technicianId) return { status: 403, error: 'Not assigned to this visit' };
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

// Strict lookups: a DB failure must never read as "no line" — the client
// would show the personal-phone links (GET) or the tech would be told they
// hold no line (sends). GET answers 503 so the client keeps its unknown
// state; the send routes fall through to their sanitized 500.
router.get('/', async (req, res) => {
  try {
    const ctx = await techLineContext(req.technicianId, { strict: true });
    if (!ctx) return res.json({ line: null });
    res.json({ line: publicLine(ctx), canCall: Boolean(ctx.cell) });
  } catch (err) {
    logger.error(`[tech-line] line lookup failed (${String(err?.code || err?.name || 'error')})`);
    res.status(503).json({ error: 'Your line could not be checked', code: 'LINE_LOOKUP_FAILED' });
  }
});

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
    const { stampFirstResponseByContact } = require('../services/lead-estimate-link');
    await stampFirstResponseByContact({ phone: to, performedBy: `tech:${technicianId}` });
  } catch (stampErr) {
    logger.warn(`[tech-line] first-response stamp failed: ${stampErr.message}`);
  }
}

// The reserve → send → settle → stamp sequence for one text, as the
// { status, json, ambiguous } the handler answers with. Throws for the
// sanitized 500 (an ambiguous throw carries err.providerOutcome).
async function textFromLine({ req, ctx, target, body }) {
  // The same human-reply lifecycle the admin composer runs: park the
  // thread's pending suggestions (and back off an autonomous reply mid-
  // send) before Twilio, settle after — so the tech's text counts as the
  // human answer every guard looks for (message_type manual).
  const reply = await reserveHumanReply({
    to: target.to, customerId: target.customer.id, fromNumber: ctx.line.number, body, adminUserId: req.technicianId,
  });
  if (reply.autoSendInFlight) {
    return { status: 409, json: { error: 'An automatic reply to this customer is being sent right now — try again in a moment', code: 'AUTO_REPLY_IN_FLIGHT' } };
  }
  // Ambiguous: retain the reservation and parked suggestions so recovery
  // cannot reopen a reply the customer may already hold. Provider evidence
  // can settle the held decisions later.
  const settleAmbiguous = () => settleHumanReply({ ...reply, parkedDecisionIds: [], sent: false, ambiguous: true, reviewedBy: req.technicianId }).catch(() => {});
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
      metadata: {
        original_message_type: 'manual',
        tech_line: true,
        scheduled_service_id: target.visit.id,
        adminUserId: req.technicianId,
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
    else await settleHumanReply({ ...reply, sent: accepted, reviewedBy: req.technicianId }).catch(() => {});
    if (!accepted) throw err;
    logger.error(`[tech-line] text accepted but its audit write failed (${String(err.code || err.name || 'error')}) for visit ${target.visit.id}`);
    // The customer has the text: it is a first response too (codex r13 P2).
    await stampTechFirstResponse({ to: target.to, technicianId: req.technicianId });
    return { status: 200, json: { success: true, from: publicLine(ctx) } };
  }
  // A suppression / gate-off sentinel comes back sent:true with no real
  // provider id — the tech must not see "Sent." for a text that never left.
  const delivered = result.sent && isRealProviderSend(result);
  if (!delivered) {
    const ambiguous = isAmbiguousProviderOutcome(result);
    if (ambiguous) await settleAmbiguous();
    else await settleHumanReply({ ...reply, sent: false, reviewedBy: req.technicianId }).catch(() => {});
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
  await settleHumanReply({ ...reply, sent: true, reviewedBy: req.technicianId }).catch(() => {});
  await stampTechFirstResponse({ to: target.to, technicianId: req.technicianId });
  return { status: 200, json: { success: true, from: publicLine(ctx) } };
}

router.post('/sms', async (req, res, next) => {
  try {
    const body = String(req.body?.body || '').trim();
    if (!body) return res.status(400).json({ error: 'Message is required' });
    if (body.length > MAX_TEXT_CHARS) return res.status(400).json({ error: `Message must be ${MAX_TEXT_CHARS} characters or fewer` });
    const ctx = await techLineContext(req.technicianId, { strict: true });
    if (!ctx) return res.status(409).json({ error: 'You have no tech line assigned', code: 'NO_TECH_LINE' });
    const target = await visitCustomer(req, req.body?.scheduledServiceId);
    if (target.error) return res.status(target.status).json({ error: target.error });

    // Two PWA instances submitting the same text near-simultaneously must
    // not both reach Twilio: a DURABLE claim on (customer, sent-body hash)
    // is taken BEFORE the send and committed on its own — the loser 409s at
    // once, and once Twilio has accepted the text the evidence survives
    // whatever happens afterwards (codex #4072 r10 / r11 / r13 P2). The
    // audit row is best-effort by design, so it is never the proof. A send
    // that definitively never left (a refusal, a validator block, a throw
    // before acceptance) releases the claim so a real retry can send; an
    // ambiguous outcome keeps it.
    const claimKey = `tech-line-text:${target.customer.id}:${sentBodyHash(body)}`;
    if (!(await claimSend(claimKey, DUPLICATE_TEXT_WINDOW))) {
      return res.status(409).json({ error: 'This text just went out to the customer', code: 'DUPLICATE_TEXT' });
    }
    let out;
    try {
      out = await textFromLine({ req, ctx, target, body });
    } catch (err) {
      if (!isAmbiguousProviderOutcome(err?.providerOutcome)) await releaseClaim(claimKey);
      throw err;
    }
    if (out.status !== 200 && !out.ambiguous) await releaseClaim(claimKey);
    if (out.status === 200) {
      // One row per delivered text — a daily horizon keeps the table trivial.
      void db('sms_send_claims').where('created_at', '<', db.raw("NOW() - interval '1 day'")).del().catch(() => {});
    }
    res.status(out.status).json(out.json);
  } catch (err) { next(sanitized(err, 'text')); }
});

// A bridge whose call_log row is not yet inserted is invisible to
// activeBridgeCall, so the row check alone is a race between two taps; the
// claim closes it for the insert's window.
const BRIDGE_CLAIM_WINDOW = '1 minute';

router.post('/call', async (req, res, next) => {
  try {
    if (!isEnabled('twilioVoice')) return res.status(409).json({ error: 'Voice calling is disabled', code: 'VOICE_GATE_OFF' });
    const ctx = await techLineContext(req.technicianId, { strict: true });
    if (!ctx) return res.status(409).json({ error: 'You have no tech line assigned', code: 'NO_TECH_LINE' });
    if (!ctx.cell) return res.status(409).json({ error: 'Your staff profile needs your cell number before calls can bridge to you', code: 'NO_CELL' });
    const target = await visitCustomer(req, req.body?.scheduledServiceId);
    if (target.error) return res.status(target.status).json({ error: target.error });

    // One bridge at a time to this customer: the panel's Call lock is a
    // timer, not call state, so a tap after it lapses (or from a reloaded
    // page) must not ring the tech and dial the customer again while the
    // first bridge is still ringing or connected (codex #4072 r8 P2) — the
    // row check covers a live call to this customer OR from this line (two
    // visits from two PWAs would ring the same cell twice, r20 P2); the
    // claim, keyed on the line, covers two taps racing the first row's
    // insert (r9 P2), without pinning a pool connection (r15).
    if (await activeBridgeCall({ source: 'tech-click', customerId: target.customer.id, fromPhone: ctx.line.number })) {
      return res.status(409).json({ error: 'A call from your line is still ringing or connected', code: 'CALL_IN_FLIGHT' });
    }
    const claimKey = `tech-bridge:${ctx.line.number}`;
    if (!(await claimSend(claimKey, BRIDGE_CLAIM_WINDOW))) {
      return res.status(409).json({ error: 'A call to this customer was just started from your line — try again in a minute', code: 'CALL_IN_FLIGHT' });
    }

    let bridged;
    try {
      bridged = await placeBridgeCall({
        to: target.to,
        bridgePhone: ctx.cell,
        from: ctx.line.number,
        customer: target.customer,
        source: 'tech-click',
        adminUserId: req.technicianId,
        metadata: { scheduledServiceId: target.visit.id },
        leadName: [target.customer.first_name, target.customer.last_name].filter(Boolean).join(' ').trim(),
      });
    } catch (err) {
      // A definitive rejection placed no call: the claim goes back so the
      // tech can retry now. An AMBIGUOUS transport failure (the bridge
      // flags it) may have reached Twilio — the call can be ringing — so
      // the claim and the 'initiated' row stay (codex #4072 r16 P2).
      const ambiguous = Boolean(err.bridgeAmbiguous);
      if (!ambiguous) await releaseClaim(claimKey);
      if (err.code === 'TWILIO_NOT_CONFIGURED') return res.status(500).json({ error: 'Twilio not configured' });
      // Same deduplicated operator bell the admin bridge raises: a rejected
      // create never produces a status callback, so this is the only signal.
      void alertTwilioFailure({
        channel: 'voice', direction: 'outbound', phase: 'send_api', status: 'failed',
        errorMessage: err.message, from: ctx.line.number, to: ctx.cell, link: '/admin/communications',
      }).catch((alertErr) => logger.error(`[twilio-alerts] async notification failed: ${alertErr.message}`));
      if (ambiguous) {
        logger.warn(`[tech-line] bridge create ambiguous (${String(err.code || err.status || 'transport')}) for visit ${target.visit.id} — claim and row kept`);
        return res.status(409).json({ error: 'Twilio did not confirm the call — your phone may still ring. Wait a minute before trying again.', code: 'CALL_IN_FLIGHT', mayHaveStarted: true });
      }
      return next(sanitized(err, 'call'));
    }
    res.json({ success: true, callSid: bridged.callSid, callLogId: bridged.callLogId, from: publicLine(ctx) });
  } catch (err) { next(sanitized(err, 'call')); }
});

module.exports = router;
