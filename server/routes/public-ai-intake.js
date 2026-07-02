/**
 * Ask Waves — public conversational intake endpoints for the marketing site.
 *
 * Two endpoints, both anonymous:
 *   GET  /api/public/ai-intake/status   — feature-gate check for the client
 *   POST /api/public/ai-intake/message  — one chat turn (services/ask-waves-intake)
 *
 * There is deliberately NO pricing endpoint here. The chat's "Show my price"
 * step posts to the existing POST /api/public/quote/calculate, which already
 * enforces the contact gate server-side (first/last/email/phone/address → 400)
 * and owns lead minting, dedup, and attribution. This surface never re-opens
 * a money path (see PR #2250 lesson).
 *
 * Gated behind GATE_ASK_WAVES (fails closed in prod until Adam flips it).
 */

const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const { isEnabled } = require('../config/feature-gates');
const { rateLimitKey } = require('../middleware/rate-limit-key');
const { processIntakeMessage, _internals } = require('../services/ask-waves-intake');

// Chat needs more headroom than the wizard's 10/hr quoteLimiter (a quote
// conversation is several turns), but stays tight enough that a scraper
// burning LLM calls gets cut off fast. Keyed by the shared rateLimitKey
// (/64-collapsed IPv6) so one client can't rotate subnet addresses past the
// throttle straight into the daily paid-LLM cap.
const intakeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many messages — please call (941) 297-5749 and we will help right away.' },
  keyGenerator: rateLimitKey,
});

router.get('/status', (req, res) => {
  res.json({ enabled: isEnabled('askWaves') });
});

router.post('/message', intakeLimiter, async (req, res, next) => {
  try {
    if (!isEnabled('askWaves')) {
      return res.status(503).json({ error: 'Ask Waves is not available right now.' });
    }
    const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
    if (!message) return res.status(400).json({ error: 'Message required' });
    if (message.length > _internals.MESSAGE_MAX_LEN) {
      return res.status(400).json({ error: 'Message too long' });
    }
    const result = await processIntakeMessage({
      message,
      history: req.body?.history,
      sessionId: req.body?.sessionId,
    });
    res.json(result);
  } catch (err) { next(err); }
});

module.exports = router;
