/**
 * The Mercury API client for payroll (owner plan A, 2026-10-30). Used only by payroll-mercury.js and
 * payroll-mercury-poller.js, behind GATE_PAYROLL_MERCURY_STATUS and GATE_PAYROLL_MERCURY_PAY.
 *
 * What it can do: ask Mercury for an APPROVAL REQUEST to send money (POST request-send-money; money leaves only
 * when a different Mercury user approves it in the Mercury app) and read: requests, one account's transactions,
 * one recipient's name, the account balance.
 *
 * What it can never do: Mercury's direct send (POST /account/{id}/transactions) pays without approval. That call
 * does not exist here, and the one request gate below refuses any POST except request-send-money. A request is
 * never sent twice by this file: callers decide, and payroll-mercury.js never re-POSTs on its own.
 *
 * Secrets: the token, the account id and every response body stay inside this file. Errors carry a kind, an HTTP
 * status and at most a short error code, never a body, a header or a URL with ids. Recipient and account reads
 * return full account and routing numbers, so those two reads return only a name, a status and a balance.
 *
 * Env (no defaults that can send): MERCURY_API_TOKEN (a custom token: read scopes plus "Send Money with Approval"),
 * MERCURY_ACCOUNT_ID (the account money leaves), MERCURY_API_BASE (default https://api.mercury.com/api/v1;
 * the sandbox is https://api-sandbox.mercury.com/api/v1). Read at call time.
 */
const DEFAULT_BASE = 'https://api.mercury.com/api/v1';
const REQUEST_TIMEOUT_MS = 15000;
const PAGE_LIMIT = 1000;
const MAX_PAGES = 5;

// kind: 'auth' (401/403: the key is gone or read-only), 'rejected' (a definite 4xx: Mercury did not take the
// request), 'not_found' (404), 'unknown' (timeout, network error, 5xx or an answer we cannot read: the request may
// or may not have been taken), 'not_configured'.
class MercuryError extends Error {
  constructor(kind, { status = null, code = null } = {}) {
    super(`Mercury ${kind}${status ? ` (HTTP ${status})` : ''}${code ? ` ${code}` : ''}`);
    this.name = 'MercuryError';
    this.kind = kind;
    this.status = status;
    this.code = code;
  }
}

const SAFE_CODE = /^[A-Za-z0-9_.-]{1,40}$/;
const CENTS = (dollars) => Math.round(Number(dollars) * 100);
const SEND_PATH = /^\/account\/[^/]+\/request-send-money$/;

function readConfig(env = process.env) {
  const token = String(env.MERCURY_API_TOKEN || '').trim();
  const accountId = String(env.MERCURY_ACCOUNT_ID || '').trim();
  const base = String(env.MERCURY_API_BASE || DEFAULT_BASE).trim().replace(/\/+$/, '');
  if (!token || !accountId) return null;
  let url;
  try { url = new URL(base); } catch { return null; }
  // The token only ever goes to Mercury's own host over https.
  if (url.protocol !== 'https:' || !/(^|\.)mercury\.com$/.test(url.hostname)) return null;
  return { token, accountId, base };
}

// Only a short error code Mercury names, if any. Never a message, never the body.
function safeCodeOf(body) {
  const candidates = [body && body.errors && body.errors.errorCode, body && body.errorCode, body && body.code];
  const hit = candidates.find((value) => typeof value === 'string' && SAFE_CODE.test(value));
  return hit || null;
}

// A non-2xx answer as the error kind it means. Only the status and a short error code are kept.
function errorFor(status, parsed) {
  const code = safeCodeOf(parsed);
  if (status === 401 || status === 403) return new MercuryError('auth', { status, code });
  if (status === 404) return new MercuryError('not_found', { status: 404, code });
  if (status === 408 || status >= 500) return new MercuryError('unknown', { status });
  return new MercuryError('rejected', { status, code });
}

// One HTTP exchange with a timeout that stays on until the body is read: fetch resolves at the headers, and a stalled
// body must not hang a batch. A network error, a timeout or an unreadable body is `unknown` for a 2xx (the request may
// have been taken); an error answer with no readable body keeps its status.
async function exchange(fetchImpl, url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { ...options, signal: controller.signal });
    let parsed = null;
    try { parsed = await response.json(); } catch { parsed = null; }
    return { status: response.status, parsed };
  } catch {
    throw new MercuryError('unknown');
  } finally {
    clearTimeout(timer);
  }
}

function createClient({ fetchImpl = globalThis.fetch, env = process.env, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const config = readConfig(env);

  // The one door to the network. GET anywhere; POST only to request-send-money.
  async function send(method, path, { query = null, body = null } = {}) {
    if (!config) throw new MercuryError('not_configured');
    if (method !== 'GET' && !(method === 'POST' && SEND_PATH.test(path))) {
      throw new MercuryError('rejected', { code: 'method_not_allowed' });
    }
    const url = new URL(`${config.base}${path}`);
    for (const [key, value] of Object.entries(query || {})) if (value != null) url.searchParams.set(key, String(value));
    const { status, parsed } = await exchange(fetchImpl, url.toString(), {
      method,
      headers: {
        Authorization: `Bearer ${config.token}`,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }, timeoutMs);
    if (status < 200 || status >= 300) throw errorFor(status, parsed);
    if (parsed === null || typeof parsed !== 'object') throw new MercuryError('unknown', { status });
    return parsed;
  }

  const requestOf = (r) => ({
    requestId: String(r.requestId || ''),
    status: String(r.status || ''),
    amountCents: CENTS(r.amount),
    recipientId: r.recipientId == null ? null : String(r.recipientId),
    createdAt: r.createdAt || null,
    memo: typeof r.memo === 'string' ? r.memo : null,
  });
  const transactionOf = (t) => ({
    id: String(t.id || ''),
    status: String(t.status || ''),
    amountCents: Math.abs(CENTS(t.amount)),
    counterpartyId: t.counterpartyId == null ? null : String(t.counterpartyId),
    createdAt: t.createdAt || null,
    postedAt: t.postedAt || null,
    failedAt: t.failedAt || null,
    note: typeof t.note === 'string' ? t.note : null,
    externalMemo: typeof t.externalMemo === 'string' ? t.externalMemo : null,
    requestId: t.requestId == null ? null : String(t.requestId),
    // A refund, return or reversal tied to this transaction (Mercury's relation kinds name it).
    hasReturn: Array.isArray(t.relatedTransactions)
      && t.relatedTransactions.some((rel) => /return|refundtofailed|failedpaymenttopaymentrefund/i.test(String(rel && rel.relationKind))),
  });

  return {
    configured: Boolean(config),
    accountId: config ? config.accountId : null,

    // An approval request for an ACH payment. Mercury sends nothing until another user approves it.
    async requestSendMoney({ recipientId, amountCents, idempotencyKey, note, externalMemo }) {
      if (!config) throw new MercuryError('not_configured');
      const answer = await send('POST', `/account/${encodeURIComponent(config.accountId)}/request-send-money`, {
        body: {
          recipientId,
          amount: Number((amountCents / 100).toFixed(2)),
          paymentMethod: 'ach',
          idempotencyKey,
          note,
          externalMemo,
        },
      });
      if (!answer.requestId) throw new MercuryError('unknown', { status: 200 });
      return requestOf(answer);
    },

    async getRequest(requestId) {
      return requestOf(await send('GET', `/request-send-money/${encodeURIComponent(requestId)}`));
    },

    // Every request on the account (all statuses, or one), following Mercury's page cursor. A list that cannot be read in
    // full is an error, never a short list: callers use it to decide a payment does not exist.
    async listRequests({ status = null } = {}) {
      if (!config) throw new MercuryError('not_configured');
      const out = [];
      let startAfter = null;
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const answer = await send('GET', '/request-send-money', {
          query: { accountId: config.accountId, status, start_after: startAfter, limit: PAGE_LIMIT },
        });
        if (!Array.isArray(answer.requests)) throw new MercuryError('unknown', { status: 200 });
        out.push(...answer.requests.map(requestOf));
        startAfter = answer.page && answer.page.nextPage ? String(answer.page.nextPage) : null;
        if (!startAfter) return out;
      }
      throw new MercuryError('unknown', { status: 200, code: 'incomplete' });
    },

    // Transactions of the account, every page (offset), or an error when they cannot all be read. `requestId` asks
    // Mercury for the one an approval request made; `start` bounds the window (Mercury defaults to the last 30 days).
    async listTransactions({ requestId = null, start = null, end = null } = {}) {
      if (!config) throw new MercuryError('not_configured');
      const out = [];
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const answer = await send('GET', `/account/${encodeURIComponent(config.accountId)}/transactions`, {
          query: { requestId, start, end, limit: PAGE_LIMIT, offset: out.length, order: 'desc' },
        });
        if (!Array.isArray(answer.transactions)) throw new MercuryError('unknown', { status: 200 });
        out.push(...answer.transactions.map(transactionOf));
        const total = Number(answer.total);
        const more = Number.isFinite(total) ? out.length < total : answer.transactions.length >= PAGE_LIMIT;
        if (!more) return out;
        // An empty page before the advertised total is a short list, not the end.
        if (answer.transactions.length === 0) break;
      }
      throw new MercuryError('unknown', { status: 200, code: 'incomplete' });
    },

    // The payee's name and status only. The full answer holds account and routing numbers: dropped here.
    async getRecipient(recipientId) {
      const answer = await send('GET', `/recipient/${encodeURIComponent(recipientId)}`);
      return { name: typeof answer.name === 'string' ? answer.name : '', status: String(answer.status || '') };
    },

    // The available balance only.
    async getBalance() {
      if (!config) throw new MercuryError('not_configured');
      const answer = await send('GET', `/account/${encodeURIComponent(config.accountId)}`);
      const cents = CENTS(answer.availableBalance);
      if (!Number.isFinite(cents)) throw new MercuryError('unknown', { status: 200 });
      return { availableCents: cents };
    },
  };
}

module.exports = { createClient, readConfig, MercuryError, DEFAULT_BASE };
