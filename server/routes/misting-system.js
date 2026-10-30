/**
 * GET /api/misting-system — the customer app's Home-tab misting system card.
 * Dark behind GATE_MOSQUITO_MISTING (read at call time via mosquitoMistingLive()).
 *
 * Gate off, or a household-contact login (v1 shows the card to the account
 * holder only): `{ system: null }` with NO database read. Otherwise the
 * selected house's system (or null) plus the resolved propertyScope echo, so
 * Home can drop a card served under another house than it shows. The payload
 * holds no ids, no product or chemistry data, no prices and no staff names.
 */
const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const logger = require('../services/logger');
const { mosquitoMistingLive } = require('../config/feature-gates');
const { sessionRecordScope } = require('../services/contact-session-projection');
const { resolvedScopePayload } = require('../services/account-properties');
const { getPortalMistingSystem } = require('../services/misting-portal');

router.use(authenticate);

router.get('/', async (req, res, next) => {
  try {
    if (!mosquitoMistingLive()) return res.json({ system: null });
    if (req.contactSession) return res.json({ system: null });
    const scope = await sessionRecordScope(req);
    const system = await getPortalMistingSystem({ customerId: req.customerId, scope });
    res.json({ propertyScope: resolvedScopePayload(scope), system });
  } catch (err) {
    logger.error(`[misting-system] read failed for ${req.customerId}: ${err.message}`);
    next(err);
  }
});

module.exports = router;
