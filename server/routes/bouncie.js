const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const config = require('../config');
const { authenticate } = require('../middleware/auth');
const { adminAuthenticate, requireAdmin } = require('../middleware/admin-auth');
const logger = require('../services/logger');
const tokenStore = require('../services/bouncie-token-store');

const BOUNCIE_API = config.bouncie.apiBase;
const AUTH_BASE = config.bouncie.authBase;

// In-memory token (refreshes automatically)
let currentToken = config.bouncie.accessToken;
let currentRefresh = config.bouncie.refreshToken;
let hydratedTokens = false;

async function hydrateTokens(force = false) {
  if (hydratedTokens && !force) return;
  const stored = await tokenStore.loadTokens();
  if (stored?.accessToken) currentToken = stored.accessToken;
  if (stored?.refreshToken) currentRefresh = stored.refreshToken;
  hydratedTokens = true;
}

// Refresh the access token using the refresh token
async function refreshAccessToken() {
  try {
    await hydrateTokens();
    if (!currentRefresh) {
      logger.error('Bouncie token refresh failed: no refresh token configured');
      return false;
    }

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
    await tokenStore.saveTokens({
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresIn: data.expires_in,
    });
    logger.info('Bouncie access token refreshed');
    return true;
  } catch (err) {
    logger.error(`Bouncie token refresh error: ${err.message}`);
    return false;
  }
}

// Call Bouncie REST API with auto-retry on 401
async function bouncieRequest(path) {
  await hydrateTokens();
  if (!currentToken) {
    const refreshed = await refreshAccessToken();
    if (!refreshed) throw new Error('Bouncie access token is not configured');
  }

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
// GET /api/bouncie/auth — Admin-only OAuth start with signed state
// =========================================================================
router.get('/auth', adminAuthenticate, requireAdmin, (req, res) => {
  const redirectUri = config.bouncie.redirectUri || 'https://portal.wavespestcontrol.com/api/bouncie/callback';
  const state = jwt.sign(
    {
      type: 'bouncie_oauth',
      technicianId: req.technicianId,
    },
    config.jwt.secret,
    { expiresIn: '15m' }
  );
  const params = new URLSearchParams({
    client_id: config.bouncie.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    state,
  });
  res.redirect(`${AUTH_BASE}/dialog/authorize?${params.toString()}`);
});

// =========================================================================
// GET /api/bouncie/callback — OAuth callback for token exchange
// =========================================================================
router.get('/callback', async (req, res, next) => {
  try {
    const { code, state } = req.query;
    if (!code) return res.status(400).send('<h2>Error: No authorization code received</h2>');
    if (!state) {
      return res.status(400).send('<h2>Error: Missing OAuth state</h2><p>Start the connection from /api/bouncie/auth.</p>');
    }

    const staticState = process.env.BOUNCIE_OAUTH_STATE;
    try {
      if (staticState && String(state) === String(staticState)) {
        logger.warn('[bouncie] OAuth callback accepted static BOUNCIE_OAUTH_STATE');
      } else {
        const decoded = jwt.verify(state, config.jwt.secret);
        if (decoded?.type !== 'bouncie_oauth') throw new Error('invalid state type');
      }
    } catch {
      return res.status(400).send('<h2>Error: Invalid or expired OAuth state</h2><p>Start the connection again from /api/bouncie/auth.</p>');
    }

    const clientId = config.bouncie.clientId;
    const clientSecret = config.bouncie.clientSecret;
    const redirectUri = config.bouncie.redirectUri || 'https://portal.wavespestcontrol.com/api/bouncie/callback';

    logger.info(`[bouncie] Token exchange started for redirect_uri=${redirectUri}`);

    // Exchange code for tokens (JSON body per Bouncie docs)
    let tokenRes = await fetch(`${AUTH_BASE}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
      }),
    });

    // Fallback to form-encoded
    if (!tokenRes.ok) {
      const errBody = await tokenRes.text();
      logger.warn(`[bouncie] JSON failed (${tokenRes.status}): ${errBody} — trying form-encoded...`);
      tokenRes = await fetch(`${AUTH_BASE}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: 'authorization_code', code, redirect_uri: redirectUri }).toString(),
      });
    }

    if (!tokenRes.ok) {
      const body = await tokenRes.text();
      logger.error(`[bouncie] Token exchange failed: ${tokenRes.status} ${body}`);
      return res.status(400).send(`<h2>Token exchange failed</h2><pre>${body}</pre>`);
    }

    const tokenData = await tokenRes.json();
    currentToken = tokenData.access_token;
    if (tokenData.refresh_token) currentRefresh = tokenData.refresh_token;
    hydratedTokens = true;
    await tokenStore.saveTokens({
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token,
      expiresIn: tokenData.expires_in,
    });

    // Update the bouncie.js service's in-memory tokens too
    try {
      const bouncieService = require('../services/bouncie');
      if (bouncieService.updateTokens) {
        await bouncieService.updateTokens(tokenData.access_token, tokenData.refresh_token, {
          persist: false,
          expiresIn: tokenData.expires_in,
        });
      }
    } catch (e) { /* service may not expose this yet */ }

    logger.info('[bouncie] OAuth token exchanged and persisted');

    // Show success page with instructions
    const masked = (t) => t ? t.substring(0, 8) + '...' + t.substring(t.length - 4) : 'N/A';
    res.send(`<!DOCTYPE html><html><head><title>Bouncie Connected</title>
<style>body{font-family:'DM Sans',sans-serif;background:#0f1923;color:#e2e8f0;display:flex;justify-content:center;padding:40px}
.card{background:#1e293b;border:1px solid #334155;border-radius:12px;padding:32px;max-width:600px;width:100%}
h2{color:#10b981;margin:0 0 16px}.ok{color:#10b981;font-size:24px;margin-right:8px}
.field{margin:12px 0;font-size:14px;padding:10px;background:#0f172a;border-radius:8px;font-family:'JetBrains Mono',monospace;word-break:break-all}
.label{color:#94a3b8;font-size:12px;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px}
.warn{color:#f59e0b;font-size:13px;margin-top:16px;padding:12px;background:#f59e0b11;border:1px solid #f59e0b33;border-radius:8px}
a{color:#0ea5e9;text-decoration:none}</style></head><body><div class="card">
	<h2><span class="ok">&#10003;</span> Bouncie Connected</h2>
	<p>Tokens exchanged, persisted, and loaded in-memory. Mileage tracking is active.</p>
	<div><div class="label">Access Token</div><div class="field">${masked(tokenData.access_token)}</div></div>
	<div><div class="label">Refresh Token</div><div class="field">${masked(tokenData.refresh_token)}</div></div>
	<div class="warn"><strong>Stored in the application database.</strong><br>
	The callback no longer logs full token values. Keep Railway env vars as a fallback only.</div>
<p style="margin-top:20px"><a href="/admin/mileage">&#8592; Back to Mileage Dashboard</a></p>
</div></body></html>`);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
