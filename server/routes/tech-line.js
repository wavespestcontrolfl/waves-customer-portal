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
const { placeBridgeCall } = require('../services/call-bridge');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { isRealProviderSend } = require('../services/sms-auto-send');
const { reserveHumanReply, settleHumanReply } = require('../services/sms-suggest-mode');
const { alertTwilioFailure } = require('../services/twilio-failure-alerts');
const { isEnabled } = require('../config/feature-gates');
const TWILIO_NUMBERS = require('../config/twilio-numbers');
const { toE164, isLikelyE164 } = require('../utils/phone');

router.use(adminAuthenticate, requireTechOrAdmin);

const MAX_TEXT_CHARS = 600;
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

router.get('/', async (req, res, next) => {
  try {
    const ctx = await techLineContext(req.technicianId);
    if (!ctx) return res.json({ line: null });
    res.json({ line: publicLine(ctx), canCall: Boolean(ctx.cell) });
  } catch (err) { next(err); }
});

router.post('/sms', async (req, res, next) => {
  try {
    const body = String(req.body?.body || '').trim();
    if (!body) return res.status(400).json({ error: 'Message is required' });
    if (body.length > MAX_TEXT_CHARS) return res.status(400).json({ error: `Message must be ${MAX_TEXT_CHARS} characters or fewer` });
    const ctx = await techLineContext(req.technicianId);
    if (!ctx) return res.status(409).json({ error: 'You have no tech line assigned', code: 'NO_TECH_LINE' });
    const target = await visitCustomer(req, req.body?.scheduledServiceId);
    if (target.error) return res.status(target.status).json({ error: target.error });

    // The same human-reply lifecycle the admin composer runs: park the
    // thread's pending suggestions (and back off an autonomous reply mid-
    // send) before Twilio, settle after — so the tech's text counts as the
    // human answer every guard looks for (message_type manual).
    const reply = await reserveHumanReply({
      to: target.to, customerId: target.customer.id, fromNumber: ctx.line.number, body, adminUserId: req.technicianId,
    });
    if (reply.autoSendInFlight) {
      return res.status(409).json({ error: 'An automatic reply to this customer is being sent right now — try again in a moment', code: 'AUTO_REPLY_IN_FLIGHT' });
    }
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
      await settleHumanReply({ ...reply, sent: false, reviewedBy: req.technicianId }).catch(() => {});
      return next(sanitized(err, 'text'));
    }
    // A suppression / gate-off sentinel comes back sent:true with no real
    // provider id — the tech must not see "Sent." for a text that never left.
    const delivered = result.sent && isRealProviderSend(result);
    await settleHumanReply({ ...reply, sent: delivered, reviewedBy: req.technicianId }).catch(() => {});
    if (!delivered) {
      const code = result.code || (result.sent ? 'SMS_GATE_OFF' : 'NOT_SENT');
      logger.info(`[tech-line] text from ${ctx.line.number} not sent for visit ${target.visit.id}: ${code}`);
      return res.status(409).json({
        error: result.reason || (result.sent ? 'Texting is switched off right now' : 'Message was not sent'),
        code,
        deferred: Boolean(result.deferred),
      });
    }
    res.json({ success: true, from: publicLine(ctx) });
  } catch (err) { next(sanitized(err, 'text')); }
});

router.post('/call', async (req, res, next) => {
  try {
    if (!isEnabled('twilioVoice')) return res.status(409).json({ error: 'Voice calling is disabled', code: 'VOICE_GATE_OFF' });
    const ctx = await techLineContext(req.technicianId);
    if (!ctx) return res.status(409).json({ error: 'You have no tech line assigned', code: 'NO_TECH_LINE' });
    if (!ctx.cell) return res.status(409).json({ error: 'Your staff profile needs your cell number before calls can bridge to you', code: 'NO_CELL' });
    const target = await visitCustomer(req, req.body?.scheduledServiceId);
    if (target.error) return res.status(target.status).json({ error: target.error });

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
      if (err.code === 'TWILIO_NOT_CONFIGURED') return res.status(500).json({ error: 'Twilio not configured' });
      // Same deduplicated operator bell the admin bridge raises: a rejected
      // create never produces a status callback, so this is the only signal.
      void alertTwilioFailure({
        channel: 'voice', direction: 'outbound', phase: 'send_api', status: 'failed',
        errorMessage: err.message, from: ctx.line.number, to: ctx.cell, link: '/admin/communications',
      }).catch((alertErr) => logger.error(`[twilio-alerts] async notification failed: ${alertErr.message}`));
      return next(sanitized(err, 'call'));
    }
    res.json({ success: true, callSid: bridged.callSid, callLogId: bridged.callLogId, from: publicLine(ctx) });
  } catch (err) { next(sanitized(err, 'call')); }
});

module.exports = router;
