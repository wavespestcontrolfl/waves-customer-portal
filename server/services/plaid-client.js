/**
 * Minimal Plaid REST client — the five endpoints the bank sync uses, over
 * fetch (no SDK dependency). Read-only Transactions product only: nothing
 * here can move money.
 *
 * Env: PLAID_CLIENT_ID, PLAID_SECRET, PLAID_ENV ('sandbox' | 'production',
 * default sandbox), optional PLAID_REDIRECT_URI (only needed for OAuth
 * banks on mobile; desktop Link opens the bank's OAuth in a popup). It must
 * be the Tax page itself (…/admin/tax), registered in the Plaid dashboard:
 * the page reopens Bank Import on ?oauth_state_id and resumes Link there.
 *
 * Errors carry Plaid's error_type/error_code (e.g. ITEM_LOGIN_REQUIRED) and
 * NEVER the request body — it holds the client secret and access token.
 */

const HOSTS = {
  sandbox: 'https://sandbox.plaid.com',
  production: 'https://production.plaid.com',
};

const REQUEST_TIMEOUT_MS = 30000;

function plaidEnv() {
  const env = String(process.env.PLAID_ENV || 'sandbox').trim().toLowerCase();
  return HOSTS[env] ? env : null;
}

function isConfigured() {
  return !!(process.env.PLAID_CLIENT_ID && process.env.PLAID_SECRET && plaidEnv());
}

class PlaidError extends Error {
  constructor(message, { status, errorType, errorCode, requestId } = {}) {
    super(message);
    this.name = 'PlaidError';
    this.status = status;
    this.errorType = errorType || null;
    this.errorCode = errorCode || null;
    this.requestId = requestId || null;
  }
}

async function call(endpoint, body) {
  if (!isConfigured()) throw new PlaidError('Plaid is not configured (PLAID_CLIENT_ID / PLAID_SECRET / PLAID_ENV)');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  // The timer spans headers AND body: fetch resolves at headers, and a
  // stalled body would otherwise hold the request (and the sequential
  // hourly sync behind it) indefinitely.
  let res;
  let json = null;
  try {
    res = await fetch(`${HOSTS[plaidEnv()]}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: process.env.PLAID_CLIENT_ID,
        secret: process.env.PLAID_SECRET,
        ...body,
      }),
      signal: controller.signal,
    });
    try { json = await res.json(); } catch (err) {
      if (err.name === 'AbortError') throw err;
      json = null; // non-JSON body — judged by the status below
    }
  } catch (err) {
    throw new PlaidError(`Plaid ${endpoint} request failed: ${err.name === 'AbortError' ? 'timeout' : 'network error'}`);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const code = json && json.error_code;
    const msg = (json && (json.display_message || json.error_message)) || `HTTP ${res.status}`;
    throw new PlaidError(`Plaid ${endpoint}: ${code ? `${code} — ` : ''}${String(msg).slice(0, 300)}`, {
      status: res.status,
      errorType: json && json.error_type,
      errorCode: code,
      requestId: json && json.request_id,
    });
  }
  if (!json) throw new PlaidError(`Plaid ${endpoint}: unreadable response`, { status: res.status });
  return json;
}

// New connection: products=['transactions'] with the longest history Plaid
// offers (the P&L is per tax year). Update mode (re-auth after
// ITEM_LOGIN_REQUIRED): pass the item's access token and NO products.
async function createLinkToken({ clientUserId, accessToken } = {}) {
  const body = {
    client_name: 'Waves Pest Control',
    language: 'en',
    country_codes: ['US'],
    user: { client_user_id: String(clientUserId || 'waves-admin') },
  };
  if (accessToken) {
    body.access_token = accessToken;
  } else {
    body.products = ['transactions'];
    body.transactions = { days_requested: 730 };
  }
  if (process.env.PLAID_REDIRECT_URI) body.redirect_uri = process.env.PLAID_REDIRECT_URI;
  const json = await call('/link/token/create', body);
  return { linkToken: json.link_token, expiration: json.expiration };
}

async function exchangePublicToken(publicToken) {
  const json = await call('/item/public_token/exchange', { public_token: publicToken });
  return { accessToken: json.access_token, itemId: json.item_id };
}

async function getAccounts(accessToken) {
  const json = await call('/accounts/get', { access_token: accessToken });
  return {
    accounts: json.accounts || [],
    institutionId: (json.item && json.item.institution_id) || null,
  };
}

async function transactionsSync(accessToken, cursor, count = 500) {
  const body = { access_token: accessToken, count };
  if (cursor) body.cursor = cursor;
  return call('/transactions/sync', body);
}

async function removeItem(accessToken) {
  return call('/item/remove', { access_token: accessToken });
}

module.exports = {
  isConfigured,
  plaidEnv,
  PlaidError,
  createLinkToken,
  exchangePublicToken,
  getAccounts,
  transactionsSync,
  removeItem,
};
