/**
 * Token Health / Credential Lifecycle Management
 *
 * Checks the health of all third-party API tokens and credentials.
 * Results are persisted to the token_credentials table for dashboard display
 * and daily SMS alerting via the scheduler.
 */

const db = require('../models/db');
const logger = require('./logger');

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
    const res = await fetch(`https://graph.facebook.com/v21.0/me?access_token=${token}`);
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
    const res = await fetch(`https://graph.facebook.com/v21.0/${accountId}?access_token=${token}`);
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

async function checkStripe() {
  const platform = 'stripe';
  const envVarName = 'STRIPE_SECRET_KEY';
  const key = process.env.STRIPE_SECRET_KEY;

  if (!key) {
    const result = { platform, status: 'not_configured', lastError: 'STRIPE_SECRET_KEY not set', expiresAt: null };
    await upsertResult({ ...result, tokenType: 'api_key', envVarName });
    return result;
  }

  try {
    const res = await fetch('https://api.stripe.com/v1/account', {
      headers: { Authorization: `Bearer ${key}` },
    });

    if (res.ok) {
      const result = { platform, status: 'healthy', lastError: null, expiresAt: null };
      await upsertResult({ ...result, tokenType: 'api_key', envVarName });
      return result;
    }

    const status = (res.status === 401 || res.status === 403) ? 'expired' : 'error';
    const data = await res.json().catch(() => ({}));
    const result = { platform, status, lastError: data.error?.message || `HTTP ${res.status}`, expiresAt: null };
    await upsertResult({ ...result, tokenType: 'api_key', envVarName });
    return result;
  } catch (err) {
    const result = { platform, status: 'error', lastError: err.message, expiresAt: null };
    await upsertResult({ ...result, tokenType: 'api_key', envVarName });
    return result;
  }
}

async function checkTwilio() {
  const platform = 'twilio';
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;

  if (!sid || !token) {
    const missing = [];
    if (!sid) missing.push('TWILIO_ACCOUNT_SID');
    if (!token) missing.push('TWILIO_AUTH_TOKEN');
    const result = { platform, status: 'not_configured', lastError: `Missing: ${missing.join(', ')}`, expiresAt: null };
    await upsertResult({ ...result, tokenType: 'api_key', envVarName: 'TWILIO_AUTH_TOKEN' });
    return result;
  }

  try {
    const auth = Buffer.from(`${sid}:${token}`).toString('base64');
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}.json`, {
      headers: { Authorization: `Basic ${auth}` },
    });

    if (res.ok) {
      const result = { platform, status: 'healthy', lastError: null, expiresAt: null };
      await upsertResult({ ...result, tokenType: 'api_key', envVarName: 'TWILIO_AUTH_TOKEN' });
      return result;
    }

    const status = (res.status === 401 || res.status === 403) ? 'expired' : 'error';
    const result = { platform, status, lastError: `HTTP ${res.status}`, expiresAt: null };
    await upsertResult({ ...result, tokenType: 'api_key', envVarName: 'TWILIO_AUTH_TOKEN' });
    return result;
  } catch (err) {
    const result = { platform, status: 'error', lastError: err.message, expiresAt: null };
    await upsertResult({ ...result, tokenType: 'api_key', envVarName: 'TWILIO_AUTH_TOKEN' });
    return result;
  }
}

async function checkAnthropic() {
  const platform = 'anthropic';
  const envVarName = 'ANTHROPIC_API_KEY';
  const key = process.env.ANTHROPIC_API_KEY;

  if (!key) {
    const result = { platform, status: 'not_configured', lastError: 'ANTHROPIC_API_KEY not set', expiresAt: null };
    await upsertResult({ ...result, tokenType: 'api_key', envVarName });
    return result;
  }

  try {
    const res = await fetch('https://api.anthropic.com/v1/models?limit=1', {
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    });

    if (res.ok) {
      const result = { platform, status: 'healthy', lastError: null, expiresAt: null };
      await upsertResult({ ...result, tokenType: 'api_key', envVarName });
      return result;
    }

    const status = (res.status === 401 || res.status === 403) ? 'expired' : 'error';
    const data = await res.json().catch(() => ({}));
    const result = { platform, status, lastError: data.error?.message || `HTTP ${res.status}`, expiresAt: null };
    await upsertResult({ ...result, tokenType: 'api_key', envVarName });
    return result;
  } catch (err) {
    const result = { platform, status: 'error', lastError: err.message, expiresAt: null };
    await upsertResult({ ...result, tokenType: 'api_key', envVarName });
    return result;
  }
}

async function checkGoogle() {
  const platform = 'google';
  const envVarName = 'GOOGLE_API_KEY';
  const key = process.env.GOOGLE_API_KEY;

  if (!key) {
    const result = { platform, status: 'not_configured', lastError: 'GOOGLE_API_KEY not set', expiresAt: null };
    await upsertResult({ ...result, tokenType: 'api_key', envVarName });
    return result;
  }

  try {
    // Geocoding ping — free tier covers this handily.
    const res = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?address=Bradenton,FL&key=${encodeURIComponent(key)}`);
    const data = await res.json().catch(() => ({}));

    if (res.ok && (data.status === 'OK' || data.status === 'ZERO_RESULTS')) {
      const result = { platform, status: 'healthy', lastError: null, expiresAt: null };
      await upsertResult({ ...result, tokenType: 'api_key', envVarName });
      return result;
    }

    const authFailed = data.status === 'REQUEST_DENIED' || data.status === 'INVALID_REQUEST';
    const status = authFailed ? 'expired' : 'error';
    const result = { platform, status, lastError: data.error_message || data.status || `HTTP ${res.status}`, expiresAt: null };
    await upsertResult({ ...result, tokenType: 'api_key', envVarName });
    return result;
  } catch (err) {
    const result = { platform, status: 'error', lastError: err.message, expiresAt: null };
    await upsertResult({ ...result, tokenType: 'api_key', envVarName });
    return result;
  }
}

async function checkSendGrid() {
  const platform = 'sendgrid';
  const envVarName = 'SENDGRID_API_KEY';
  const key = process.env.SENDGRID_API_KEY;

  if (!key) {
    const result = { platform, status: 'not_configured', lastError: 'SENDGRID_API_KEY not set', expiresAt: null };
    await upsertResult({ ...result, tokenType: 'api_key', envVarName });
    return result;
  }

  try {
    const res = await fetch('https://api.sendgrid.com/v3/user/account', {
      headers: { Authorization: `Bearer ${key}` },
    });

    if (res.ok) {
      const result = { platform, status: 'healthy', lastError: null, expiresAt: null };
      await upsertResult({ ...result, tokenType: 'api_key', envVarName });
      return result;
    }

    const status = (res.status === 401 || res.status === 403) ? 'expired' : 'error';
    const result = { platform, status, lastError: `HTTP ${res.status}`, expiresAt: null };
    await upsertResult({ ...result, tokenType: 'api_key', envVarName });
    return result;
  } catch (err) {
    const result = { platform, status: 'error', lastError: err.message, expiresAt: null };
    await upsertResult({ ...result, tokenType: 'api_key', envVarName });
    return result;
  }
}

async function checkElevenLabs() {
  const platform = 'elevenlabs';
  const envVarName = 'ELEVENLABS_API_KEY';
  const key = process.env.ELEVENLABS_API_KEY;

  if (!key) {
    const result = { platform, status: 'not_configured', lastError: 'ELEVENLABS_API_KEY not set', expiresAt: null };
    await upsertResult({ ...result, tokenType: 'api_key', envVarName });
    return result;
  }

  try {
    const res = await fetch('https://api.elevenlabs.io/v1/user', {
      headers: { 'xi-api-key': key },
    });

    if (res.ok) {
      const result = { platform, status: 'healthy', lastError: null, expiresAt: null };
      await upsertResult({ ...result, tokenType: 'api_key', envVarName });
      return result;
    }

    const status = (res.status === 401 || res.status === 403) ? 'expired' : 'error';
    const result = { platform, status, lastError: `HTTP ${res.status}`, expiresAt: null };
    await upsertResult({ ...result, tokenType: 'api_key', envVarName });
    return result;
  } catch (err) {
    const result = { platform, status: 'error', lastError: err.message, expiresAt: null };
    await upsertResult({ ...result, tokenType: 'api_key', envVarName });
    return result;
  }
}

async function checkDeepgram() {
  const platform = 'deepgram';
  const envVarName = 'DEEPGRAM_API_KEY';
  const key = process.env.DEEPGRAM_API_KEY;

  if (!key) {
    const result = { platform, status: 'not_configured', lastError: 'DEEPGRAM_API_KEY not set', expiresAt: null };
    await upsertResult({ ...result, tokenType: 'api_key', envVarName });
    return result;
  }

  try {
    const res = await fetch('https://api.deepgram.com/v1/projects', {
      headers: { Authorization: `Token ${key}` },
    });

    if (res.ok) {
      const result = { platform, status: 'healthy', lastError: null, expiresAt: null };
      await upsertResult({ ...result, tokenType: 'api_key', envVarName });
      return result;
    }

    const status = (res.status === 401 || res.status === 403) ? 'expired' : 'error';
    const result = { platform, status, lastError: `HTTP ${res.status}`, expiresAt: null };
    await upsertResult({ ...result, tokenType: 'api_key', envVarName });
    return result;
  } catch (err) {
    const result = { platform, status: 'error', lastError: err.message, expiresAt: null };
    await upsertResult({ ...result, tokenType: 'api_key', envVarName });
    return result;
  }
}

async function checkGitHub() {
  const platform = 'github';
  const envVarName = 'GITHUB_TOKEN';
  const token = process.env.GITHUB_TOKEN;
  const owner = process.env.GITHUB_OWNER || 'wavespestcontrolfl';
  const repo = process.env.GITHUB_ASTRO_REPO || 'wavespestcontrol-astro';

  if (!token) {
    const result = { platform, status: 'not_configured', lastError: 'GITHUB_TOKEN not set', expiresAt: null };
    await upsertResult({ ...result, tokenType: 'pat', envVarName });
    return result;
  }

  try {
    // /repos/:owner/:repo is auth-gated for fine-grained PATs scoped to
    // specific repos — it's the right probe for "can this token write
    // content?" without burning rate limit on larger endpoints.
    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'User-Agent': 'waves-portal-token-health',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });

    // Fine-grained PATs carry their expiration in a response header —
    // captured when present so the Tool Health Dashboard can surface the
    // amber <14-day / red <3-day countdown the user asked for.
    const expiresHeader = res.headers.get('github-authentication-token-expiration');
    const expiresAt = expiresHeader ? new Date(expiresHeader) : null;

    if (res.ok) {
      const result = { platform, status: 'healthy', lastError: null, expiresAt };
      await upsertResult({ ...result, tokenType: 'pat', envVarName });
      return result;
    }

    const status = (res.status === 401 || res.status === 403 || res.status === 404) ? 'expired' : 'error';
    const data = await res.json().catch(() => ({}));
    const result = { platform, status, lastError: data.message || `HTTP ${res.status}`, expiresAt };
    await upsertResult({ ...result, tokenType: 'pat', envVarName });
    return result;
  } catch (err) {
    const result = { platform, status: 'error', lastError: err.message, expiresAt: null };
    await upsertResult({ ...result, tokenType: 'pat', envVarName });
    return result;
  }
}

// RentCast has no cheap no-cost ping endpoint and every property call
// burns a credit. We report 'healthy' when the API key is set, since
// that's all the check can guarantee without spending credits.
async function checkRentCast() {
  const platform = 'rentcast';
  const envVarName = 'RENTCAST_API_KEY';
  const key = process.env.RENTCAST_API_KEY;

  if (!key) {
    const result = { platform, status: 'not_configured', lastError: 'RENTCAST_API_KEY not set', expiresAt: null };
    await upsertResult({ ...result, tokenType: 'api_key', envVarName });
    return result;
  }

  const result = { platform, status: 'healthy', lastError: null, expiresAt: null };
  await upsertResult({ ...result, tokenType: 'api_key', envVarName });
  return result;
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
      case 'bouncie': return checkBouncie();
      case 'beehiiv': return checkBeehiiv();
      case 'dataforseo': return checkDataForSEO();
      case 'stripe': return checkStripe();
      case 'twilio': return checkTwilio();
      case 'anthropic': return checkAnthropic();
      case 'google': return checkGoogle();
      case 'sendgrid': return checkSendGrid();
      case 'elevenlabs': return checkElevenLabs();
      case 'deepgram': return checkDeepgram();
      case 'rentcast': return checkRentCast();
      case 'github': return checkGitHub();
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

    results.push(await checkBouncie());
    results.push(await checkBeehiiv());
    results.push(await checkDataForSEO());
    results.push(await checkStripe());
    results.push(await checkTwilio());
    results.push(await checkAnthropic());
    results.push(await checkGoogle());
    results.push(await checkSendGrid());
    results.push(await checkElevenLabs());
    results.push(await checkDeepgram());
    results.push(await checkRentCast());
    results.push(await checkGitHub());

    const healthy = results.filter(r => r.status === 'healthy').length;
    const failures = results.filter(r => r.status === 'expired' || r.status === 'error');
    logger.info(`[token-health] Check complete: ${healthy} healthy, ${failures.length} issues, ${results.length} total`);

    // In-app notifications for credential failures
    if (failures.length > 0) {
      try {
        const NotificationService = require('./notification-service');
        for (const f of failures) {
          await NotificationService.notifyAdmin('token_alert', `${f.platform} credential ${f.status}`, f.lastError || 'Check token health dashboard', { icon: '\u{1F511}', link: '/admin/social-media' });
        }
      } catch (e) { logger.error(`[notifications] Token alert notification failed: ${e.message}`); }
    }

    return results;
  },

  /**
   * Get all credential statuses from the database (no live checks).
   * Purges any deprecated platforms not in KNOWN, and dedupes duplicate
   * rows per platform before returning.
   */
  async getAll() {
    try {
      const KNOWN = new Set([
        'facebook', 'instagram', 'linkedin',
        'gbp_lwr', 'gbp_parrish', 'gbp_sarasota', 'gbp_venice',
        'bouncie', 'beehiiv', 'dataforseo',
        'stripe', 'twilio', 'anthropic', 'google',
        'sendgrid', 'elevenlabs', 'deepgram', 'rentcast',
        'github',
      ]);

      await db('token_credentials').whereNotIn('platform', [...KNOWN]).del();

      const rows = await db('token_credentials').orderBy('platform');
      const byPlatform = new Map();
      for (const r of rows) {
        const prev = byPlatform.get(r.platform);
        const ts = (r.last_verified_at && new Date(r.last_verified_at).getTime()) || 0;
        const prevTs = prev ? (prev.last_verified_at && new Date(prev.last_verified_at).getTime()) || 0 : -1;
        if (!prev || ts >= prevTs) byPlatform.set(r.platform, r);
      }
      const duplicateIds = rows
        .filter(r => byPlatform.get(r.platform)?.id !== r.id)
        .map(r => r.id);
      if (duplicateIds.length) {
        await db('token_credentials').whereIn('id', duplicateIds).del();
      }

      return [...byPlatform.values()].sort((a, b) => a.platform.localeCompare(b.platform));
    } catch {
      return [];
    }
  },
};

module.exports = TokenHealthService;
