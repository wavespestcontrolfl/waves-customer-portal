/**
 * Admin portal inbox (GATE_PORTAL_INBOX, owner 2026-10-31, option A).
 *
 * Communications -> Portal tab: what customers asked for inside the customer
 * portal (chat hand-offs, service requests) and nobody answered. Owner-only,
 * like the Email / Calls / Triage tabs. Dark gate: every endpoint answers
 * `{ enabled: false }` (summary) or 404 `{ enabled: false }` (the rest).
 *
 * Marking one item handled uses the existing routes
 * (PUT /api/ai/admin/escalations/:id, PATCH /api/admin/requests/:id).
 * "Close all older" closes the items older than 14 days and sends NOTHING to
 * a customer.
 */

const express = require('express');
const router = express.Router();
const Joi = require('joi');
const { adminAuthenticate, requireAdmin } = require('../middleware/admin-auth');
const featureGates = require('../config/feature-gates');

const { portalInboxLive } = featureGates;
// GATE_PORTAL_MESSAGES, read at call time; a test that mocks feature-gates without the reader reads off.
const portalMessagesLive = () => Boolean(featureGates.portalMessagesLive?.());
const portalInbox = require('../services/portal-inbox');
const PortalMessages = require('../services/portal-messages');

router.use(adminAuthenticate, requireAdmin);

function requireLive(req, res, next) {
  if (!portalInboxLive()) {
    return res.status(404).json({ enabled: false });
  }
  return next();
}

// GET /api/admin/portal-inbox/summary -> { enabled, count } (open items, last 14 days)
router.get('/summary', async (req, res, next) => {
  try {
    if (!portalInboxLive()) return res.json({ enabled: false });
    res.set('Cache-Control', 'private, no-store');
    res.json({ enabled: true, replies: portalMessagesLive(), ...(await portalInbox.summary()) });
  } catch (err) { next(err); }
});

// GET /api/admin/portal-inbox -> { enabled, cutoff, items, olderItems, total, older: { chats, requests } }
// `items` = open, last 14 days; `olderItems` = open at or before the cutoff, listed one by one;
// `older` = their true totals.
router.get('/', requireLive, async (req, res, next) => {
  try {
    res.set('Cache-Control', 'private, no-store');
    res.json({ enabled: true, replies: portalMessagesLive(), ...(await portalInbox.list()) });
  } catch (err) { next(err); }
});

// POST /api/admin/portal-inbox/close-older  { cutoff } -> { closed: { chats, requests } }
// One transaction. No email, no text. Alerts for the closed items are marked Done.
router.post('/close-older', requireLive, async (req, res, next) => {
  try {
    const parsed = portalInbox.parseCloseCutoff((req.body || {}).cutoff);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const closed = await portalInbox.closeOlder(parsed.cutoff, {
      technicianId: req.technicianId,
      role: req.techRole,
    });
    res.json({ closed });
  } catch (err) { next(err); }
});

// GATE_PORTAL_MESSAGES: POST /api/admin/portal-inbox/reply  { kind, id, body, requestId? }
//   -> { message, closed, notice } . Answers one item inside the customer's portal: the answer is saved in
// their portal thread, the item and its bells close, and the customer gets one notice (app push, else email).
// `requestId` makes a retried click return the first answer instead of sending a second one.
const replySchema = Joi.object({
  kind: Joi.string().valid('chat', 'request', 'message').required(),
  id: Joi.string().uuid().required(),
  body: Joi.string().allow('').max(PortalMessages.BODY_MAX * 2).required(),
  requestId: Joi.string().uuid().optional(),
});

router.post('/reply', requireLive, async (req, res, next) => {
  if (!portalMessagesLive()) return res.status(404).json({ enabled: false });
  const { value, error } = replySchema.validate(req.body || {});
  if (error) return res.status(400).json({ error: error.details[0].message });
  try {
    const result = await PortalMessages.staffReply({
      kind: value.kind,
      id: value.id,
      body: value.body,
      clientRequestId: value.requestId || null,
      actor: { technicianId: req.technicianId, role: req.techRole },
    });
    res.json(result);
  } catch (err) {
    if (err instanceof PortalMessages.PortalMessageError) return res.status(err.status).json({ error: err.message, code: err.code });
    next(err);
  }
});

// GATE_PORTAL_MESSAGES: POST /api/admin/portal-inbox/messages/:id/handled { throughId } -> { handled, open }
// Mark handled on a customer's portal message item, through the newest customer message the screen showed (the
// item's throughId): the thread is stamped handled through it and its bells close when nothing is left open.
// Sends nothing. handled:false = an answer or another Mark handled got there first; open:true = the customer
// wrote again after throughId, so the item stays.
const handledSchema = Joi.object({ throughId: Joi.string().uuid().required() });
router.post('/messages/:id/handled', requireLive, async (req, res, next) => {
  if (!portalMessagesLive()) return res.status(404).json({ enabled: false });
  if (Joi.string().uuid().validate(req.params.id).error) return res.status(400).json({ error: 'id must be a UUID' });
  const { error, value } = handledSchema.validate(req.body || {});
  if (error) return res.status(400).json({ error: error.message });
  try {
    const result = await portalInbox.markMessageHandled(req.params.id, value.throughId, { technicianId: req.technicianId, role: req.techRole });
    if (!result) return res.status(404).json({ error: 'This message is gone.' });
    res.json(result);
  } catch (err) { next(err); }
});

module.exports = router;
