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
 *   POST /set-text → { scheduledServiceId, kind } — one of the fixed set texts
 *                   (services/tech-set-texts.js) to the visit's customer, the
 *                   same send path as /sms. Today's open visits only; one
 *                   duplicate check per visit and kind. GATE_TECH_SET_TEXTS.
 *   GET  /replies?scheduledServiceIds=a,b → the customer's answer to the
 *                   newest set text for that stop (all its visits), when it
 *                   clearly belongs to it.
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
const crypto = require('crypto');
const { normalizeGsmPunctuation } = require('../services/messaging/gsm-normalize');
const { alertTwilioFailure } = require('../services/twilio-failure-alerts');
const featureGates = require('../config/feature-gates');
const { isEnabled } = featureGates;
const { setTextOptions, setTextReply } = require('../services/tech-set-texts');
const {
  publicLine, visitCustomer, claimSend, releaseClaim, sendClaimedText, sendSetText,
} = require('../services/tech-line-texts');

router.use(adminAuthenticate, requireTechOrAdmin);

const MAX_TEXT_CHARS = 600;
// The claim key hashes the body AS SENT — sendCustomerMessage GSM-normalizes
// a plain customer SMS — so two submits of the same text share one key.
function sentBodyHash(body) {
  return crypto.createHash('sha256').update(normalizeGsmPunctuation(body), 'utf8').digest('hex');
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

// Strict lookups: a DB failure must never read as "no line" — the client
// would show the personal-phone links (GET) or the tech would be told they
// hold no line (sends). GET answers 503 so the client keeps its unknown
// state; the send routes fall through to their sanitized 500.
router.get('/', async (req, res) => {
  try {
    const ctx = await techLineContext(req.technicianId, { strict: true });
    if (!ctx) return res.json({ line: null });
    res.json({
      line: publicLine(ctx),
      canCall: Boolean(ctx.cell),
      ...(featureGates.techSetTextsLive() ? { setTexts: setTextOptions() } : {}),
    });
  } catch (err) {
    logger.error(`[tech-line] line lookup failed (${String(err?.code || err?.name || 'error')})`);
    res.status(503).json({ error: 'Your line could not be checked', code: 'LINE_LOOKUP_FAILED' });
  }
});

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
    const out = await sendClaimedText({ actor: req, ctx, target, body, claimKey });
    res.status(out.status).json(out.json);
  } catch (err) { next(sanitized(err, 'text')); }
});

// A set text (services/tech-line-texts.js sendSetText): fixed wording, one
// duplicate claim per visit and kind.
router.post('/set-text', async (req, res, next) => {
  try {
    const out = await sendSetText({ actor: req, scheduledServiceId: req.body?.scheduledServiceId, kind: String(req.body?.kind || '') });
    res.status(out.status).json(out.json);
  } catch (err) { next(sanitized(err, 'set text')); }
});

// The Visit Brief's Last reply card. Read-only; the tech's own line only.
// A grouped stop sends all its visit ids: the member the panel leads with
// changes as members finish, and a set text sent for any of them is the
// stop's. Every id must be in the caller's scope and the same customer's.
const MAX_STOP_VISITS = 6;
router.get('/replies', async (req, res, next) => {
  try {
    if (!featureGates.techSetTextsLive()) return res.status(404).json({ error: 'Not found' });
    const ids = [...new Set(String(req.query?.scheduledServiceIds || '').split(',').map((id) => id.trim()).filter(Boolean))];
    if (!ids.length || ids.length > MAX_STOP_VISITS) return res.status(400).json({ error: 'scheduledServiceIds is required' });
    const ctx = await techLineContext(req.technicianId, { strict: true });
    if (!ctx) return res.status(409).json({ error: 'You have no tech line assigned', code: 'NO_TECH_LINE' });
    const targets = [];
    for (const id of ids) {
      const target = await visitCustomer(req, id);
      if (target.error) return res.status(target.status).json({ error: target.error });
      targets.push(target);
    }
    if (targets.some((t) => t.customer.id !== targets[0].customer.id)) {
      return res.status(400).json({ error: 'Those visits are not one customer\'s stop' });
    }
    const out = await setTextReply(db, {
      customerId: targets[0].customer.id, customerPhone: targets[0].to, lineNumber: ctx.line.number, visitIds: ids,
    });
    res.json(out);
  } catch (err) { next(sanitized(err, 'reply lookup')); }
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
