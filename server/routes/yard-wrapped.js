/**
 * GET /api/yard-wrapped: the Home tab's "Yard Wrapped" year-in-review card
 * (owner 2026-10-31 perks round 4). Dark behind GATE_YARD_WRAPPED (read at call
 * time via yardWrappedLive()). Read-only.
 *
 * Gate off, outside Dec 1 - Jan 31 (ET), not an active WaveGuard member, a
 * household-contact login (the member's own card), fewer than 3 performed
 * visits, or any failure: 200 { enabled: false } and the app renders nothing.
 * The customer is always the logged-in one (req.customerId), the visits and
 * lawn readings follow the selected saved property like the Visits tab, and an
 * enabled card carries the resolved propertyScope echo (like /api/misting-system)
 * so Home drops a card served under another house than it shows. No database
 * read happens until the cheap checks pass. See services/yard-wrapped.js.
 */
const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const logger = require('../services/logger');
const { yardWrappedYearFor, buildYardWrapped } = require('../services/yard-wrapped');
const { sessionRecordScope } = require('../services/contact-session-projection');
const { resolvedScopePayload } = require('../services/account-properties');

router.use(authenticate);

const OFF = { enabled: false };

router.get('/', async (req, res) => {
  try {
    const year = req.contactSession ? null : yardWrappedYearFor({ customer: req.customer });
    if (!year) return res.json(OFF);
    const scope = await sessionRecordScope(req);
    const card = await buildYardWrapped({ customerId: req.customerId, year, scope });
    return res.json(card.enabled ? { ...card, propertyScope: resolvedScopePayload(scope) } : card);
  } catch (err) {
    logger.error(`[yard-wrapped] read failed for ${req.customerId}: ${err.message}`);
    return res.json(OFF);
  }
});

module.exports = router;
