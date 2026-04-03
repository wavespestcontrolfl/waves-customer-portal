const express = require('express');
const router = express.Router();
const config = require('../config');
const { authenticate } = require('../middleware/auth');
const logger = require('../services/logger');

const BOUNCIE_API = config.bouncie.apiBase;
const AUTH_BASE = config.bouncie.authBase;

// In-memory token (refreshes automatically)
let currentToken = config.bouncie.accessToken;
let currentRefresh = config.bouncie.refreshToken;

// Refresh the access token using the refresh token
async function refreshAccessToken() {
  try {
    const res = await fetch(`${AUTH_BASE}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: config.bouncie.clientId,
        client_secret: config.bouncie.clientSecret,
        grant_type: 'refresh_token',
        refresh_token: currentRefresh,
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      logger.error(`Bouncie token refresh failed: ${res.status} ${body}`);
      return false;
    }

    const data = await res.json();
    currentToken = data.access_token;
    if (data.refresh_token) currentRefresh = data.refresh_token;
    logger.info('Bouncie access token refreshed');
    return true;
  } catch (err) {
    logger.error(`Bouncie token refresh error: ${err.message}`);
    return false;
  }
}

// Call Bouncie REST API with auto-retry on 401
async function bouncieRequest(path) {
  const doFetch = () => fetch(`${BOUNCIE_API}${path}`, {
    headers: { 'Authorization': currentToken, 'Content-Type': 'application/json' },
  });

  let res = await doFetch();

  // Auto-refresh on 401
  if (res.status === 401) {
    const refreshed = await refreshAccessToken();
    if (refreshed) {
      res = await doFetch();
    }
  }

  if (!res.ok) {
    const body = await res.text();
    logger.error(`Bouncie API error: ${res.status} ${body}`);
    throw new Error(`Bouncie API returned ${res.status}`);
  }

  return res.json();
}

// =========================================================================
// GET /api/bouncie/vehicles — List all vehicles
// =========================================================================
router.get('/vehicles', authenticate, async (req, res, next) => {
  try {
    const vehicles = await bouncieRequest('/vehicles');
    res.json(vehicles);
  } catch (err) {
    next(err);
  }
});

// =========================================================================
// GET /api/bouncie/location — Get live location for the configured vehicle
// =========================================================================
router.get('/location', authenticate, async (req, res, next) => {
  try {
    const imei = req.query.imei || config.bouncie.vehicleImei;
    if (!imei) return res.status(400).json({ error: 'No vehicle IMEI configured' });

    // The /vehicles endpoint returns location in stats
    const vehicles = await bouncieRequest('/vehicles');
    const vehicle = vehicles.find(v => v.imei === imei);

    if (!vehicle) return res.status(404).json({ error: 'Vehicle not found' });

    const loc = vehicle.stats?.location || {};
    res.json({
      imei,
      vin: vehicle.vin,
      make: vehicle.model?.make,
      model: vehicle.model?.name,
      year: vehicle.model?.year,
      latitude: loc.lat,
      longitude: loc.lon,
      heading: loc.heading,
      speed: vehicle.stats?.speed || 0,
      isRunning: vehicle.stats?.isRunning || false,
      fuelLevel: vehicle.stats?.fuelLevel,
      lastUpdated: vehicle.stats?.lastUpdated,
      address: loc.address,
    });
  } catch (err) {
    next(err);
  }
});

// =========================================================================
// GET /api/bouncie/callback — OAuth callback for token exchange
// =========================================================================
router.get('/callback', async (req, res, next) => {
  try {
    const { code } = req.query;
    if (!code) return res.status(400).json({ error: 'Authorization code required' });

    const tokenRes = await fetch(`${AUTH_BASE}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: config.bouncie.clientId,
        client_secret: config.bouncie.clientSecret,
        grant_type: 'authorization_code',
        code,
        redirect_uri: config.bouncie.redirectUri,
      }),
    });

    if (!tokenRes.ok) {
      const body = await tokenRes.text();
      logger.error(`Bouncie token exchange failed: ${tokenRes.status} ${body}`);
      return res.status(400).json({ error: 'Token exchange failed', details: body });
    }

    const tokenData = await tokenRes.json();
    currentToken = tokenData.access_token;
    if (tokenData.refresh_token) currentRefresh = tokenData.refresh_token;

    logger.info('Bouncie OAuth token exchanged successfully');
    res.json({
      message: 'Token exchanged. Add these to your .env:',
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
