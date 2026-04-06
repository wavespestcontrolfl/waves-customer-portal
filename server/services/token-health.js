/**
 * Token Health / Credential Lifecycle Management
 *
 * Checks the health of all third-party API tokens and credentials.
 * Results are persisted to the token_credentials table for dashboard display
 * and daily SMS alerting via the scheduler.
 */

const db = require('../models/db');
const logger = require('./logger');
const config = require('../config');

const GBP_LOCATION_KEYS = ['LWR', 'PARRISH', 'SARASOTA', 'VENICE'];

// ── Helper: upsert result into token_credentials ──
async function upsertResult({ platform, tokenType, status, lastError, expiresAt, envVarName }) {
  try {
    const existing = await db('token_credentials').where({ platform }).first();
    const data = {
      platform,
      token_type: tokenType || null,
      status,
      last_verified_at: new Date(),
      last_error: lastError || null,
      expires_at: expiresAt || null,
      env_var_name: envVarName || null,
      updated_at: new Date(),
    };

    if (existing) {
      await db('token_credentials').where({ id: existing.id }).update(data);
    } else {
      await db('token_credentials').insert(data);
    }
  } catch (err) {
    logger.error(`[token-health] DB upsert failed for ${platform}: ${err.message}`);
  }
}

// ── Individual platform checks ──

async function checkFacebook() {
  const platform = 'facebook';
  const envVarName = 'FACEBOOK_ACCESS_TOKEN';
  const token = process.env.FACEBOOK_ACCESS_TOKEN;

  if (!token) {
    const result = { platform, status: 'not_configured', lastError: 'FACEBOOK_ACCESS_TOKEN not set', expiresAt: null };
    await upsertResult({ ...result, tokenType: 'oauth', envVarName });
    return result;
  }

  try {
    const res = await fetch(`https://graph.facebook.com/v19.0/me?access_token=${token}`);
    const data = await res.json();

    if (res.ok && !data.error) {
      const result = { platform, status: 'healthy', lastError: null, expiresAt: null };
      await upsertResult({ ...result, tokenType: 'oauth', envVarName });
      return result;
    }

    const errorCode = data.error?.code;
    const status = (errorCode === 190 || errorCode === 463) ? 'expired' : 'error';
    const result = { platform, status, lastError: data.error?.message || `HTTP ${res.status}`, expiresAt: null };
    await upsertResult({ ...result, tokenType: 'oauth', envVarName });
    return result;
  } catch (err) {
    const result = { platform, status: 'error', lastError: err.message, expiresAt: null };
    await upsertResult({ ...result, tokenType: 'oauth', envVarName });
    return result;
  }
}

async function checkInstagram() {
  const platform = 'instagram';
  const token = process.env.FACEBOOK_ACCESS_TOKEN;
  const accountId = process.env.INSTAGRAM_ACCOUNT_ID;

  if (!token || !accountId) {
    const missing = [];
    if (!token) missing.push('FACEBOOK_ACCESS_TOKEN');
    if (!accountId) missing.push('INSTAGRAM_ACCOUNT_ID');
    const result = { platform, status: 'not_configured', lastError: `Missing: ${missing.join(', ')}`, expiresAt: null };
    await upsertResult({ ...result, tokenType: 'oauth', envVarName: 'INSTAGRAM_ACCOUNT_ID' });
    return result;
  }

  try {
    const res = await fetch(`https://graph.facebook.com/v19.0/${accountId}?access_token=${token}`);
    const data = await res.json();

    if (res.ok && !data.error) {
      const result = { platform, status: 'healthy', lastError: null, expiresAt: null };
      await upsertResult({ ...result, tokenType: 'oauth', envVarName: 'INSTAGRAM_ACCOUNT_ID' });
      return result;
    }

    const errorCode = data.error?.code;
    const status = (errorCode === 190 || errorCode === 463) ? 'expired' : 'error';
    const result = { platform, status, lastError: data.error?.message || `HTTP ${res.status}`, expiresAt: null };
    await upsertResult({ ...result, tokenType: 'oauth', envVarName: 'INSTAGRAM_ACCOUNT_ID' });
    return result;
  } catch (err) {
    const result = { platform, status: 'error', lastError: err.message, expiresAt: null };
    await upsertResult({ ...result, tokenType: 'oauth', envVarName: 'INSTAGRAM_ACCOUNT_ID' });
    return result;
  }
}

async function checkLinkedIn() {
  const platform = 'linkedin';
  const envVarName = 'LINKEDIN_ACCESS_TOKEN';
  const token = process.env.LINKEDIN_ACCESS_TOKEN;

  if (!token) {
    const result = { platform, status: 'not_configured', lastError: 'LINKEDIN_ACCESS_TOKEN not set', expiresAt: null };
    await upsertResult({ ...result, tokenType: 'oauth', envVarName });
    return result;
  }

  try {
    const res = await fetch('https://api.linkedin.com/v2/me', {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (res.ok) {
      const result = { platform, status: 'healthy', lastError: null, expiresAt: null };
      await upsertResult({ ...result, tokenType: 'oauth', envVarName });
      return result;
    }

    const status = res.status === 401 ? 'expired' : 'error';
    const result = { platform, status, lastError: `HTTP ${res.status}`, expiresAt: null };
    await upsertResult({ ...result, tokenType: 'oauth', envVarName });
    return result;
  } catch (err) {
    const result = { platform, status: 'error', lastError: err.message, expiresAt: null };
    await upsertResult({ ...result, tokenType: 'oauth', envVarName });
    return result;
  }
}

async function checkGBP(locationKey) {
  const platform = `gbp_${locationKey.toLowerCase()}`;
  const clientId = process.env[`GBP_CLIENT_ID_${locationKey}`];
  const clientSecret = process.env[`GBP_CLIENT_SECRET_${locationKey}`];
  const refreshToken = process.env[`GBP_REFRESH_TOKEN_${locationKey}`];
  const envVarName = `GBP_REFRESH_TOKEN_${locationKey}`;

  if (!clientId || !clientSecret || !refreshToken) {
    const missing = [];
    if (!clientId) missing.push(`GBP_CLIENT_ID_${locationKey}`);
    if (!clientSecret) missing.push(`GBP_CLIENT_SECRET_${locationKey}`);
    if (!refreshToken) missing.push(`GBP_REFRESH_TOKEN_${locationKey}`);
    const result = { platform, status: 'not_configured', lastError: `Missing: ${missing.join(', ')}`, expiresAt: null };
    await upsertResult({ ...result, tokenType: 'refresh_token', envVarName });
    return result;
  }

  try {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }),
    });

    const data = await res.json();

    if (res.ok && data.access_token) {
      const expiresAt = data.expires_in ? new Date(Date.now() + data.expires_in * 1000) : null;
      const result = { platform, status: 'healthy', lastError: null, expiresAt };
      await upsertResult({ ...result, tokenType: 'refresh_token', envVarName });
      return result;
    }

    const status = (res.status === 401 || res.status === 403) ? 'expired' : 'error';
    const result = { platform, status, lastError: data.error_description || data.error || `HTTP ${res.status}`, expiresAt: null };
    await upsertResult({ ...result, tokenType: 'refresh_token', envVarName });
    return result;
  } catch (err) {
    const result = { platform, status: 'error', lastError: err.message, expiresAt: null };
    await upsertResult({ ...result, tokenType: 'refresh_token', envVarName });
    return result;
  }
}

async function checkSquare() {
  const platform = 'square';
  const envVarName = 'SQUARE_ACCESS_TOKEN';

  if (!config.square.accessToken) {
    const result = { platform, status: 'not_configured', lastError: 'SQUARE_ACCESS_TOKEN not set', expiresAt: null };
    await upsertResult({ ...result, tokenType: 'api_key', envVarName });
    return result;
  }

  try {
    const { Client, Environment } = require('square');
    const client = new Client({
      accessToken: config.square.accessToken,
      environment: config.square.environment === 'production' ? Environment.Production : Environment.Sandbox,
    });
    await client.customersApi.listCustomers(undefined, 1);
    const result = { platform, status: 'healthy', lastError: null, expiresAt: null };
    await upsertResult({ ...result, tokenType: 'api_key', envVarName });
    return result;
  } catch (err) {
    const statusCode = err.statusCode || err.status;
    const status = (statusCode === 401 || statusCode === 403) ? 'expired' : 'error';
    const result = { platform, status, lastError: err.message || String(err), expiresAt: null };
    await upsertResult({ ...result, tokenType: 'api_key', envVarName });
    return result;
  }
}

async function checkBouncie() {
  const platform = 'bouncie';
  const envVarName = 'BOUNCIE_ACCESS_TOKEN';
  const token = process.env.BOUNCIE_ACCESS_TOKEN;

  if (!token) {
    const result = { platform, status: 'not_configured', lastError: 'BOUNCIE_ACCESS_TOKEN not set', expiresAt: null };
    await upsertResult({ ...result, tokenType: 'oauth', envVarName });
    return result;
  }

  try {
    const res = await fetch('https://api.bouncie.dev/v1/user', {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (res.ok) {
      const result = { platform, status: 'healthy', lastError: null, expiresAt: null };
      await upsertResult({ ...result, tokenType: 'oauth', envVarName });
      return result;
    }

    const status = (res.status === 401 || res.status === 403) ? 'expired' : 'error';
    const result = { platform, status, lastError: `HTTP ${res.status}`, expiresAt: null };
    await upsertResult({ ...result, tokenType: 'oauth', envVarName });
    return result;
  } catch (err) {
    const result = { platform, status: 'error', lastError: err.message, expiresAt: null };
    await upsertResult({ ...result, tokenType: 'oauth', envVarName });
    return result;
  }
}

async function checkBeehiiv() {
  const platform = 'beehiiv';
  const pubId = process.env.BEEHIIV_PUB_ID;
  const apiKey = process.env.BEEHIIV_API_KEY;

  if (!pubId || !apiKey) {
    const missing = [];
    if (!pubId) missing.push('BEEHIIV_PUB_ID');
    if (!apiKey) missing.push('BEEHIIV_API_KEY');
    const result = { platform, status: 'not_configured', lastError: `Missing: ${missing.join(', ')}`, expiresAt: null };
    await upsertResult({ ...result, tokenType: 'api_key', envVarName: 'BEEHIIV_API_KEY' });
    return result;
  }

  try {
    const res = await fetch(`https://api.beehiiv.com/v2/publications/${pubId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    if (res.ok) {
      const result = { platform, status: 'healthy', lastError: null, expiresAt: null };
      await upsertResult({ ...result, tokenType: 'api_key', envVarName: 'BEEHIIV_API_KEY' });
      return result;
    }

    const status = (res.status === 401 || res.status === 403) ? 'expired' : 'error';
    const result = { platform, status, lastError: `HTTP ${res.status}`, expiresAt: null };
    await upsertResult({ ...result, tokenType: 'api_key', envVarName: 'BEEHIIV_API_KEY' });
    return result;
  } catch (err) {
    const result = { platform, status: 'error', lastError: err.message, expiresAt: null };
    await upsertResult({ ...result, tokenType: 'api_key', envVarName: 'BEEHIIV_API_KEY' });
    return result;
  }
}

async function checkDataForSEO() {
  const platform = 'dataforseo';
  const login = process.env.DATAFORSEO_LOGIN;
  const password = process.env.DATAFORSEO_PASSWORD;

  if (!login || !password) {
    const missing = [];
    if (!login) missing.push('DATAFORSEO_LOGIN');
    if (!password) missing.push('DATAFORSEO_PASSWORD');
    const result = { platform, status: 'not_configured', lastError: `Missing: ${missing.join(', ')}`, expiresAt: null };
    await upsertResult({ ...result, tokenType: 'api_key', envVarName: 'DATAFORSEO_LOGIN' });
    return result;
  }

  try {
    const auth = Buffer.from(`${login}:${password}`).toString('base64');
    const res = await fetch('https://api.dataforseo.com/v3/appendix/user_data', {
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
    });

    if (res.ok) {
      const result = { platform, status: 'healthy', lastError: null, expiresAt: null };
      await upsertResult({ ...result, tokenType: 'api_key', envVarName: 'DATAFORSEO_LOGIN' });
      return result;
    }

    const status = (res.status === 401 || res.status === 403) ? 'expired' : 'error';
    const result = { platform, status, lastError: `HTTP ${res.status}`, expiresAt: null };
    await upsertResult({ ...result, tokenType: 'api_key', envVarName: 'DATAFORSEO_LOGIN' });
    return result;
  } catch (err) {
    const result = { platform, status: 'error', lastError: err.message, expiresAt: null };
    await upsertResult({ ...result, tokenType: 'api_key', envVarName: 'DATAFORSEO_LOGIN' });
    return result;
  }
}

// ── Public API ──

const TokenHealthService = {
  /**
   * Check a single platform by name.
   */
  async checkSingle(platform) {
    switch (platform) {
      case 'facebook': return checkFacebook();
      case 'instagram': return checkInstagram();
      case 'linkedin': return checkLinkedIn();
      case 'gbp_lwr': return checkGBP('LWR');
      case 'gbp_parrish': return checkGBP('PARRISH');
      case 'gbp_sarasota': return checkGBP('SARASOTA');
      case 'gbp_venice': return checkGBP('VENICE');
      case 'square': return checkSquare();
      case 'bouncie': return checkBouncie();
      case 'beehiiv': return checkBeehiiv();
      case 'dataforseo': return checkDataForSEO();
      default:
        return { platform, status: 'error', lastError: `Unknown platform: ${platform}`, expiresAt: null };
    }
  },

  /**
   * Run all checks. Returns array of results and upserts into DB.
   */
  async checkAll() {
    logger.info('[token-health] Running credential health checks...');
    const results = [];

    // Run checks sequentially to avoid overwhelming APIs
    results.push(await checkFacebook());
    results.push(await checkInstagram());
    results.push(await checkLinkedIn());

    for (const key of GBP_LOCATION_KEYS) {
      results.push(await checkGBP(key));
    }

    results.push(await checkSquare());
    results.push(await checkBouncie());
    results.push(await checkBeehiiv());
    results.push(await checkDataForSEO());

    const healthy = results.filter(r => r.status === 'healthy').length;
    const issues = results.filter(r => r.status === 'expired' || r.status === 'error').length;
    logger.info(`[token-health] Check complete: ${healthy} healthy, ${issues} issues, ${results.length} total`);

    return results;
  },

  /**
   * Get all credential statuses from the database (no live checks).
   */
  async getAll() {
    try {
      return await db('token_credentials').orderBy('platform');
    } catch {
      return [];
    }
  },
};

module.exports = TokenHealthService;
