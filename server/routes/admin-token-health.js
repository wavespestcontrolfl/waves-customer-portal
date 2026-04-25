const express = require('express');
const router = express.Router();
const { adminAuthenticate } = require('../middleware/admin-auth');
const tokenHealth = require('../services/token-health');

router.use(adminAuthenticate);

// Known integration env var names. Presence only — values are never returned.
// Kept in sync with client/src/pages/admin/SettingsPage.jsx INTEGRATION_GROUPS.
const INTEGRATION_ENV_KEYS = [
  // Communication
  'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN',
  'SENDGRID_API_KEY', 'SENDGRID_FROM_EMAIL', 'SENDGRID_FROM_NAME',
  'SENDGRID_ASM_GROUP_NEWSLETTER', 'SENDGRID_ASM_GROUP_SERVICE',
  'BEEHIIV_API_KEY', 'BEEHIIV_PUB_ID',
  // Payments
  'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'STRIPE_PUBLISHABLE_KEY',
  // AI
  'ANTHROPIC_API_KEY',
  // Data & Research
  'GOOGLE_API_KEY',
  'DATAFORSEO_LOGIN', 'DATAFORSEO_PASSWORD',
  'RENTCAST_API_KEY',
  // Social & Listings
  'FACEBOOK_ACCESS_TOKEN',
  'INSTAGRAM_ACCOUNT_ID',
  'LINKEDIN_ACCESS_TOKEN',
  'GBP_CLIENT_ID_LWR', 'GBP_CLIENT_SECRET_LWR', 'GBP_REFRESH_TOKEN_LWR',
  'GBP_CLIENT_ID_PARRISH', 'GBP_CLIENT_SECRET_PARRISH', 'GBP_REFRESH_TOKEN_PARRISH',
  'GBP_CLIENT_ID_SARASOTA', 'GBP_CLIENT_SECRET_SARASOTA', 'GBP_REFRESH_TOKEN_SARASOTA',
  'GBP_CLIENT_ID_VENICE', 'GBP_CLIENT_SECRET_VENICE', 'GBP_REFRESH_TOKEN_VENICE',
  // Fleet
  'BOUNCIE_ACCESS_TOKEN',
];

// GET /env-presence — report which known integration env keys are set.
// Returns presence only (boolean); values are never exposed.
router.get('/env-presence', (req, res) => {
  const present = {};
  for (const key of INTEGRATION_ENV_KEYS) {
    present[key] = !!(process.env[key] && String(process.env[key]).trim());
  }
  res.json({ present });
});

// GET / — return all credential statuses from DB
router.get('/', async (req, res, next) => {
  try {
    const credentials = await tokenHealth.getAll();
    res.json({ credentials });
  } catch (err) { next(err); }
});

// POST /check — trigger full health check across all platforms
router.post('/check', async (req, res, next) => {
  try {
    const results = await tokenHealth.checkAll();
    res.json({ results });
  } catch (err) { next(err); }
});

// POST /check/:platform — check a single platform
router.post('/check/:platform', async (req, res, next) => {
  try {
    const result = await tokenHealth.checkSingle(req.params.platform);
    res.json({ result });
  } catch (err) { next(err); }
});

module.exports = router;
