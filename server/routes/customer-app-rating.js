/**
 * Store rating pop-up claim (GATE_APP_RATING_PROMPT) — authenticated customer
 * session, called by the Waves customer app (client/src/native/appRating.js).
 *
 *   POST /api/customer/app-rating/claim  { platform: 'ios' | 'android' }
 *     → 200 { ask: boolean }
 *
 * ask:true means the app may ask the store for its rating card now; the
 * claim is recorded before the answer (services/app-rating-prompt.js). A
 * contact session is refused by the auth layer (not in CONTACT_SESSION_ROUTES)
 * and a cancelled account never gets past authenticate; the app treats any
 * error as "do not ask". Sends nothing.
 */
const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { claimAppRatingAsk } = require('../services/app-rating-prompt');

router.use(authenticate);

router.post('/claim', async (req, res, next) => {
  try {
    res.set('Cache-Control', 'no-store');
    const { platform } = req.body || {};
    if (platform !== 'ios' && platform !== 'android') return res.status(400).json({ error: 'unsupported platform' });
    const { ask } = await claimAppRatingAsk({ customerId: req.customerId, platform });
    return res.json({ ask });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
