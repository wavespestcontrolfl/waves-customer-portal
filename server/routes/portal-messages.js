/**
 * The customer's Messages page (GATE_PORTAL_MESSAGES, owner 2026-11-04): their portal thread with the
 * Waves office. Signed-in account holders only (a contact session is refused by the auth middleware, which
 * lists the routes a contact may reach). Gate off: every route answers 404 { enabled: false }.
 *
 *   GET  /api/portal-messages               -> { messages, hasMore, unread }   (?before=<ISO time> pages back)
 *   GET  /api/portal-messages/unread-count  -> { count }
 *   POST /api/portal-messages               { body, requestId? } -> { message }
 *   POST /api/portal-messages/read          { throughId } -> { unread }
 *
 * The thread is always the signed-in customer's own row (req.customerId); no route takes a customer id.
 */

const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const Joi = require('joi');
const { authenticate } = require('../middleware/auth');
const featureGates = require('../config/feature-gates');
const PortalMessages = require('../services/portal-messages');

router.use(authenticate);
router.use((req, res, next) => (featureGates.portalMessagesLive?.() ? next() : res.status(404).json({ enabled: false })));

// A signed-in customer can write a lot; the office reads every word. Each message also rings a bell
// (one per thread, rewritten) and the phone page has its own per-customer cap (portal-ask-push.js).
const postLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.customer && req.customer.id) || req.ip,
  message: { error: 'Too many messages in a short time. Please wait a little, or call or text our office.' },
});

const listSchema = Joi.object({ before: Joi.date().iso().optional() });
const postSchema = Joi.object({
  body: Joi.string().allow('').max(PortalMessages.BODY_MAX * 2).required(),
  requestId: Joi.string().uuid().optional(),
});
const readSchema = Joi.object({ throughId: Joi.string().uuid().required() });

function sendError(res, next, err) {
  if (err instanceof PortalMessages.PortalMessageError) return res.status(err.status).json({ error: err.message, code: err.code });
  return next(err);
}

router.get('/', async (req, res, next) => {
  const { value, error } = listSchema.validate(req.query, { stripUnknown: true });
  if (error) return res.status(400).json({ error: error.details[0].message });
  try {
    res.set('Cache-Control', 'private, no-store');
    res.json(await PortalMessages.customerThread(req.customerId, { before: value.before ? value.before.toISOString() : null }));
  } catch (err) { sendError(res, next, err); }
});

router.get('/unread-count', async (req, res, next) => {
  try {
    res.set('Cache-Control', 'private, no-store');
    res.json({ count: await PortalMessages.customerUnread(req.customerId) });
  } catch (err) { sendError(res, next, err); }
});

router.post('/', postLimiter, async (req, res, next) => {
  const { value, error } = postSchema.validate(req.body || {});
  if (error) return res.status(400).json({ error: error.details[0].message });
  try {
    const message = await PortalMessages.customerPost({ customer: req.customer, body: value.body, clientRequestId: value.requestId || null });
    res.status(201).json({ message });
  } catch (err) { sendError(res, next, err); }
});

router.post('/read', async (req, res, next) => {
  const { value, error } = readSchema.validate(req.body || {});
  if (error) return res.status(400).json({ error: error.details[0].message });
  try {
    res.json(await PortalMessages.markRead(req.customerId, value.throughId));
  } catch (err) { sendError(res, next, err); }
});

module.exports = router;
