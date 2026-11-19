/**
 * Public job-offer routes — /api/public/careers/offer/:token (GATE_JOB_OFFERS).
 *
 * The applicant's private link: read the personal terms and the issued Technician Terms, then sign by typing a name,
 * ask for another start date, or decline. A 64-hex bearer token is the only credential.
 *
 * Mounted in server/index.js exactly like the interview family: no-store headers on EVERY response (also the dark
 * 404), `/offer` carved out of the outer GATE_JOB_APPLICATIONS 404 (a sent offer keeps working if intake closes), the
 * jobOffers dark gate AHEAD of the global /api limiter (a dark probe never sees a 429), then this router's own IP
 * limiter. Unknown, malformed and draft tokens all answer the same generic 404.
 */

const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();

const logger = require('../services/logger');
const { isEnabled } = require('../config/feature-gates');
const { ipFallbackKey } = require('../middleware/rate-limit-key');
const { noStore } = require('../middleware/no-store');
const JobOffers = require('../services/job-offers');

// Same dark contract as index.js, repeated so the router is safe on its own.
router.use(noStore, (req, res, next) => {
  if (!isEnabled('jobOffers')) return res.status(404).json({ error: 'Not found' });
  next();
});

// Format gate before any database read.
router.param('token', (req, res, next, token) => {
  if (!JobOffers.TOKEN_RE.test(token)) return res.status(404).json({ error: 'Not found' });
  next();
});

const offerLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 30,
  message: { error: 'Too many requests, please try again shortly.' },
  keyGenerator: (req) => ipFallbackKey(req.ip),
  skip: () => process.env.NODE_ENV !== 'production',
});

// One answer shape for the service's outcomes: unknown = generic 404, bad input = 400, a state that no longer allows
// the action = 409 with the current state, else the body.
function reply(res, result) {
  if (!result || result.notFound) return res.status(404).json({ error: 'Not found' });
  if (result.invalid) return res.status(400).json({ error: result.invalid });
  if (result.refused) return res.status(409).json(result.body);
  return res.json(result.body);
}

function handle(label, work) {
  return async (req, res) => {
    try {
      return reply(res, await work(req));
    } catch (err) {
      logger.error(`[careers-offer] ${label} failed: ${(err && err.name) || 'Error'}${err && err.code ? ` ${err.code}` : ''}`);
      return res.status(500).json({ error: 'Something went wrong.' });
    }
  };
}

router.get('/:token', offerLimiter, handle('view', async (req) => {
  const body = await JobOffers.publicView(req.params.token);
  return body ? { body } : { notFound: true };
}));

router.post('/:token/text-consent', offerLimiter, handle('text consent', (req) => JobOffers.setTextConsent(req.params.token, req.body && req.body.consent, req.body && req.body.version)));

router.post('/:token/accept', offerLimiter, handle('accept', (req) => JobOffers.acceptOffer(req.params.token, {
  signedName: req.body && req.body.signedName,
  ip: req.ip,
  userAgent: req.get('user-agent'),
})));

router.post('/:token/date-request', offerLimiter, handle('date request', (req) => JobOffers.requestDate(req.params.token, {
  requestedStartDate: req.body && req.body.requestedStartDate,
  note: req.body && req.body.note,
})));

router.post('/:token/decline', offerLimiter, handle('decline', (req) => JobOffers.declineOffer(req.params.token, {
  reason: req.body && req.body.reason,
})));

module.exports = router;
