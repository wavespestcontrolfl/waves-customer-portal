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

// Location ids used by google-business.js for OAuth token storage in
// system_settings (`gbp.oauth_tokens.{locationId}`). Must stay in sync with
// LOCATION_ENV_KEYS in services/google-business.js.
const GBP_LOCATION_IDS = { LWR: 'bradenton', PARRISH: 'parrish', SARASOTA: 'sarasota', VENICE: 'venice' };

// OAuth tokens are written to system_settings by the admin connect flow;
// the GBP_REFRESH_TOKEN_* env vars are a legacy bootstrap fallback only.
async function getStoredGbpRefreshToken(locationKey) {
  const locationId = GBP_LOCATION_IDS[locationKey];
  if (!locationId) return null;
  try {
    const row = await db('system_settings').where({ key: `gbp.oauth_tokens.${locationId}` }).first();
    if (!row?.value) return null;
    const parsed = typeof row.value === 'string' ? JSON.parse(row.value) : row.value;
    return parsed?.refresh_token || null;
  } catch (err) {
    logger.warn(`[token-health] GBP stored token lookup failed for ${locationKey}: ${err.message}`);
    return null;
  }
}

async function fetchGraph(path, token) {
  const separator = path.includes('?') ? '&' : '?';
  const res = await fetch(`https://graph.facebook.com/v25.0${path}${separator}access_token=${encodeURIComponent(token)}`);
  const data = await res.json();
  return { res, data };
}

function graphErrorStatus(errorCode) {
  return (errorCode === 190 || errorCode === 463) ? 'expired' : 'error';
}

function graphErrorMessage(data, fallbackStatus) {
  return data?.error?.message || `HTTP ${fallbackStatus}`;
}

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
  const pageId = process.env.FACEBOOK_PAGE_ID;

  if (!token || !pageId) {
    const missing = [];
    if (!token) missing.push('FACEBOOK_ACCESS_TOKEN');
    if (!pageId) missing.push('FACEBOOK_PAGE_ID');
    const result = { platform, status: 'not_configured', lastError: `Missing: ${missing.join(', ')}`, expiresAt: null };
    await upsertResult({ ...result, tokenType: 'oauth', envVarName });
    return result;
  }

  try {
    const { res, data } = await fetchGraph(`/${pageId}?fields=id,name,instagram_business_account{id,username}`, token);

    if (res.ok && !data.error && data.id === pageId) {
      const linkedIgId = data.instagram_business_account?.id || null;
      const configuredIg = process.env.INSTAGRAM_ACCOUNT_ID;
      // If an IG account is configured, the Page must actually link to THAT
      // account — otherwise FB and IG posts would target different assets while
      // the UI still reads "healthy".
      if (configuredIg && linkedIgId !== configuredIg) {
        const result = {
          platform,
          status: 'error',
          lastError: linkedIgId
            ? `Page's linked Instagram (${linkedIgId}) does not match INSTAGRAM_ACCOUNT_ID (${configuredIg})`
            : `Page has no linked Instagram account, but INSTAGRAM_ACCOUNT_ID is set (${configuredIg})`,
          expiresAt: null,
          details: {
            pageId: data.id,
            pageName: data.name || null,
            linkedInstagramAccountId: linkedIgId,
            linkedInstagramUsername: data.instagram_business_account?.username || null,
            checks: { pageResolved: true, pageMatchesConfig: true, instagramLinkMatches: false },
          },
        };
        await upsertResult({ ...result, tokenType: 'oauth', envVarName });
        return result;
      }
      // A token can READ the Page yet lack publish rights, in which case every
      // postToFacebook (/photos, /feed) fails while the strip shows green.
      //
      // We previously probed this via the Page node's `tasks` field, but `tasks`
      // is NOT a valid field on a Page node — it only exists on the
      // `/me/accounts` edge. Requesting it made the ENTIRE Page call fail with
      // `(#100) Tried accessing nonexisting field (tasks) on node type (Page)`,
      // which tripped the error branch below and false-flagged a working token.
      //
      // Instead introspect the token's granted scopes via debug_token (the same
      // token-introspects-itself pattern used in knowledge-base.js) and require
      // `pages_manage_posts`. Only treat an EXPLICIT absence as an error — if
      // the scopes can't be read, leave the capability unknown rather than
      // re-introducing a false alarm.
      let canCreateContent = null;
      try {
        const { data: dbg } = await fetchGraph(`/debug_token?input_token=${encodeURIComponent(token)}`, token);
        const scopes = Array.isArray(dbg?.data?.scopes) ? dbg.data.scopes : [];
        const granular = Array.isArray(dbg?.data?.granular_scopes) ? dbg.data.granular_scopes : [];
        // FB expresses a granted permission in `scopes` (flat) and/or
        // `granular_scopes` (per-resource). When a granular entry exists for
        // pages_manage_posts its `target_ids` are authoritative: the permission
        // applies only to those Pages (no target_ids = all Pages). A flat-only
        // grant with no granular entry is a broad grant. Only render a verdict
        // when introspection actually returned scope data — otherwise leave the
        // capability unknown rather than false-flagging.
        const granularPublish = granular.find((g) => g && g.scope === 'pages_manage_posts');
        if (granularPublish) {
          const targets = Array.isArray(granularPublish.target_ids) ? granularPublish.target_ids.map(String) : null;
          canCreateContent = !targets || targets.includes(String(pageId));
        } else if (scopes.length || granular.length) {
          canCreateContent = scopes.includes('pages_manage_posts');
        }
      } catch {
        // network/parse failure — leave capability unknown, never false-flag
      }
      if (canCreateContent === false) {
        const result = {
          platform,
          status: 'error',
          lastError: 'Facebook token can read the Page but lacks publish rights (no pages_manage_posts scope) — Page posts will fail',
          expiresAt: null,
          details: {
            pageId: data.id,
            pageName: data.name || null,
            linkedInstagramAccountId: linkedIgId,
            linkedInstagramUsername: data.instagram_business_account?.username || null,
            checks: { pageResolved: true, pageMatchesConfig: true, instagramLinkMatches: configuredIg ? true : null, canCreateContent: false },
          },
        };
        await upsertResult({ ...result, tokenType: 'oauth', envVarName });
        return result;
      }
      const result = {
        platform,
        status: 'healthy',
        lastError: null,
        expiresAt: null,
        details: {
          pageId: data.id,
          pageName: data.name || null,
          linkedInstagramAccountId: linkedIgId,
          linkedInstagramUsername: data.instagram_business_account?.username || null,
          checks: {
            pageResolved: true,
            pageMatchesConfig: true,
            instagramLinkMatches: configuredIg ? true : null,
            canCreateContent,
          },
        },
      };
      await upsertResult({ ...result, tokenType: 'oauth', envVarName });
      return result;
    }

    const errorCode = data.error?.code;
    const status = graphErrorStatus(errorCode);
    const lastError = data.id && data.id !== pageId
      ? `FACEBOOK_ACCESS_TOKEN resolved page ${data.id}, expected ${pageId}`
      : graphErrorMessage(data, res.status);
    const result = { platform, status, lastError, expiresAt: null };
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
    const account = await fetchGraph(`/${accountId}?fields=id,username,name`, token);
    if (!account.res.ok || account.data.error) {
      const errorCode = account.data.error?.code;
      const status = graphErrorStatus(errorCode);
      const result = { platform, status, lastError: graphErrorMessage(account.data, account.res.status), expiresAt: null };
      await upsertResult({ ...result, tokenType: 'oauth', envVarName: 'INSTAGRAM_ACCOUNT_ID' });
      return result;
    }

    const limit = await fetchGraph(`/${accountId}/content_publishing_limit`, token);
    if (!limit.res.ok || limit.data.error) {
      const errorCode = limit.data.error?.code;
      const status = graphErrorStatus(errorCode);
      const result = { platform, status, lastError: graphErrorMessage(limit.data, limit.res.status), expiresAt: null };
      await upsertResult({ ...result, tokenType: 'oauth', envVarName: 'INSTAGRAM_ACCOUNT_ID' });
      return result;
    }

    const quotaUsage = Array.isArray(limit.data.data) ? limit.data.data[0]?.quota_usage : null;
    const result = {
      platform,
      status: 'healthy',
      lastError: null,
      expiresAt: null,
      details: {
        accountId: account.data.id,
        username: account.data.username || null,
        name: account.data.name || null,
        quotaUsage: quotaUsage ?? null,
        checks: {
          accountResolved: true,
          contentPublishingAllowed: true,
        },
      },
    };
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
  const refreshToken = (await getStoredGbpRefreshToken(locationKey)) || process.env[`GBP_REFRESH_TOKEN_${locationKey}`];
  const envVarName = `GBP_REFRESH_TOKEN_${locationKey}`;

  if (!clientId || !clientSecret || !refreshToken) {
    const missing = [];
    if (!clientId) missing.push(`GBP_CLIENT_ID_${locationKey}`);
    if (!clientSecret) missing.push(`GBP_CLIENT_SECRET_${locationKey}`);
    const lastError = missing.length
      ? `Missing: ${missing.join(', ')}`
      : 'Not connected — authorize via Admin Settings → Integrations';
    const result = { platform, status: 'not_configured', lastError, expiresAt: null };
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

    // Google's OAuth endpoint reports dead refresh tokens as HTTP 400 with
    // error=invalid_grant (revoked/expired) or error=unauthorized_client
    // (token minted by a different OAuth client), so classify from the error
    // body rather than only from the HTTP status.
    const tokenRejected = res.status === 401 || res.status === 403
      || data.error === 'invalid_grant' || data.error === 'unauthorized_client';
    const status = tokenRejected ? 'expired' : 'error';
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
  const envVarName = 'BOUNCIE_REFRESH_TOKEN';
  let accessToken = String(process.env.BOUNCIE_ACCESS_TOKEN || '').trim();
  let refreshToken = String(process.env.BOUNCIE_REFRESH_TOKEN || '').trim();
  try {
    const tokenStore = require('./bouncie-token-store');
    const stored = await tokenStore.loadTokens();
    accessToken = String(stored?.accessToken || accessToken || '').trim();
    refreshToken = String(stored?.refreshToken || refreshToken || '').trim();
  } catch (_) {
    // fall back to env bootstrap token
  }

  if (!accessToken && !refreshToken) {
    const result = { platform, status: 'not_configured', lastError: 'No Bouncie OAuth token in DB or env', expiresAt: null };
    await upsertResult({ ...result, tokenType: 'oauth', envVarName });
    return result;
  }

  try {
    const bouncie = require('./bouncie');
    await bouncie.checkAuth();
    const result = { platform, status: 'healthy', lastError: null, expiresAt: null };
    await upsertResult({ ...result, tokenType: 'oauth', envVarName });
    return result;
  } catch (err) {
    const status = /\b(401|403)\b/.test(String(err.message)) ? 'expired' : 'error';
    const result = { platform, status, lastError: err.message, expiresAt: null };
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

async function checkOpenAI() {
  const platform = 'openai';
  const envVarName = 'OPENAI_API_KEY';
  const key = process.env.OPENAI_API_KEY;

  if (!key) {
    const result = { platform, status: 'not_configured', lastError: 'OPENAI_API_KEY not set', expiresAt: null };
    await upsertResult({ ...result, tokenType: 'api_key', envVarName });
    return result;
  }

  try {
    const res = await fetch('https://api.openai.com/v1/models', {
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

async function checkGemini() {
  const platform = 'gemini';
  const envVarName = 'GEMINI_API_KEY';
  const key = process.env.GEMINI_API_KEY;

  if (!key) {
    const result = { platform, status: 'not_configured', lastError: 'GEMINI_API_KEY not set', expiresAt: null };
    await upsertResult({ ...result, tokenType: 'api_key', envVarName });
    return result;
  }

  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`);

    if (res.ok) {
      const result = { platform, status: 'healthy', lastError: null, expiresAt: null };
      await upsertResult({ ...result, tokenType: 'api_key', envVarName });
      return result;
    }

    const status = (res.status === 400 || res.status === 401 || res.status === 403) ? 'expired' : 'error';
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
  const envVarName = process.env.GOOGLE_MAPS_API_KEY ? 'GOOGLE_MAPS_API_KEY' : 'GOOGLE_API_KEY';
  const key = process.env.GOOGLE_MAPS_API_KEY || process.env.GOOGLE_API_KEY;

  if (!key) {
    const result = { platform, status: 'not_configured', lastError: 'GOOGLE_MAPS_API_KEY or GOOGLE_API_KEY not set', expiresAt: null };
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
      case 'openai': return checkOpenAI();
      case 'gemini': return checkGemini();
      case 'google': return checkGoogle();
      case 'sendgrid': return checkSendGrid();
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
    results.push(await checkOpenAI());
    results.push(await checkGemini());
    results.push(await checkGoogle());
    results.push(await checkSendGrid());
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
        'stripe', 'twilio', 'anthropic', 'openai', 'gemini', 'google',
        'sendgrid',
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
