const express = require('express');
const router = express.Router();
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');
const gbp = require('../services/google-business');
const logger = require('../services/logger');

// =========================================================================
// Google Business Profile OAuth — per-location authorization
// =========================================================================

// GET /api/admin/settings/google/auth?location=sarasota
// Redirects to Google OAuth consent screen for that location's account
router.get('/google/auth', (req, res) => {
  try {
    const locationId = req.query.location;
    if (!locationId) return res.status(400).send('Missing ?location= parameter. Use: lakewood-ranch, parrish, sarasota, or venice');

    const authUrl = gbp.getAuthUrl(locationId);
    res.redirect(authUrl);
  } catch (err) {
    res.status(500).send(`Error: ${err.message}`);
  }
});

// GET /api/admin/settings/google/callback — OAuth callback
// Google redirects here after user authorizes. Returns the refresh token.
router.get('/google/callback', async (req, res) => {
  try {
    const { code, state: locationId } = req.query;
    if (!code) return res.status(400).send('Missing authorization code');

    const tokens = await gbp.handleCallback(code, locationId);

    const LOCATION_ENV_KEYS = {
      'lakewood-ranch': 'LWR', 'parrish': 'PARRISH', 'sarasota': 'SARASOTA', 'venice': 'VENICE',
    };
    const envKey = LOCATION_ENV_KEYS[locationId] || 'UNKNOWN';

    // Display the token for the user to copy into Railway
    res.type('text/html').send(`
      <!DOCTYPE html>
      <html>
      <head><title>GBP OAuth Success</title>
      <style>
        body { font-family: -apple-system, sans-serif; background: #0f1923; color: #e2e8f0; padding: 40px; max-width: 700px; margin: 0 auto; }
        h1 { color: #0ea5e9; } code { background: #1e293b; padding: 8px 14px; border-radius: 8px; display: block; margin: 12px 0; word-break: break-all; font-size: 14px; color: #10b981; border: 1px solid #334155; }
        .label { color: #94a3b8; font-size: 13px; margin-top: 20px; }
        .warn { color: #f59e0b; font-size: 13px; margin-top: 20px; }
      </style>
      </head>
      <body>
        <h1>Google Business Profile — ${locationId || 'Unknown'}</h1>
        <p>Authorization successful! Add this refresh token to Railway:</p>

        <div class="label">Environment variable name:</div>
        <code>GBP_REFRESH_TOKEN_${envKey}</code>

        <div class="label">Refresh token value:</div>
        <code>${tokens.refresh_token || '(no refresh token returned — try again with prompt=consent)'}</code>

        ${tokens.access_token ? `<div class="label">Access token (temporary, for testing):</div><code>${tokens.access_token}</code>` : ''}

        <div class="warn">Copy the refresh token above and add it as <strong>GBP_REFRESH_TOKEN_${envKey}</strong> in your Railway environment variables. Then redeploy.</div>
      </body>
      </html>
    `);
  } catch (err) {
    logger.error(`GBP OAuth callback failed: ${err.message}`);
    res.status(500).send(`OAuth failed: ${err.message}`);
  }
});

module.exports = router;
