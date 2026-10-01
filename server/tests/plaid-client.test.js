/**
 * plaid-client — request shape and the secret-safe error surface.
 */
const plaid = require('../services/plaid-client');

const ENV_KEYS = ['PLAID_CLIENT_ID', 'PLAID_SECRET', 'PLAID_ENV', 'PLAID_REDIRECT_URI'];
let saved;
beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
  process.env.PLAID_CLIENT_ID = 'client-id';
  process.env.PLAID_SECRET = 'super-secret';
  process.env.PLAID_ENV = 'sandbox';
  delete process.env.PLAID_REDIRECT_URI;
  global.fetch = jest.fn();
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  }
});

const ok = (json) => ({ ok: true, status: 200, json: async () => json });

test('unconfigured or unknown env refuses before any request', async () => {
  process.env.PLAID_ENV = 'development';
  expect(plaid.isConfigured()).toBe(false);
  await expect(plaid.getAccounts('tok')).rejects.toThrow(/not configured/);
  expect(fetch).not.toHaveBeenCalled();
});

test('new-connection link token asks for transactions with two years of history', async () => {
  fetch.mockResolvedValueOnce(ok({ link_token: 'link-1', expiration: 'x' }));
  expect(await plaid.createLinkToken({ clientUserId: 'tech-1' })).toEqual({ linkToken: 'link-1', expiration: 'x' });
  const [url, init] = fetch.mock.calls[0];
  expect(url).toBe('https://sandbox.plaid.com/link/token/create');
  const body = JSON.parse(init.body);
  expect(body).toMatchObject({
    client_id: 'client-id', secret: 'super-secret', products: ['transactions'],
    transactions: { days_requested: 730 }, user: { client_user_id: 'tech-1' }, country_codes: ['US'],
  });
  expect(body.access_token).toBeUndefined();
});

test('update-mode link token passes the access token and no products', async () => {
  process.env.PLAID_ENV = 'production';
  fetch.mockResolvedValueOnce(ok({ link_token: 'link-2' }));
  await plaid.createLinkToken({ clientUserId: 'tech-1', accessToken: 'access-1' });
  const [url, init] = fetch.mock.calls[0];
  expect(url).toBe('https://production.plaid.com/link/token/create');
  const body = JSON.parse(init.body);
  expect(body.access_token).toBe('access-1');
  expect(body.products).toBeUndefined();
});

test('errors carry the Plaid code and never the secret or token', async () => {
  fetch.mockResolvedValueOnce({
    ok: false, status: 400,
    json: async () => ({ error_type: 'ITEM_ERROR', error_code: 'ITEM_LOGIN_REQUIRED', error_message: 'login required', request_id: 'r1' }),
  });
  const err = await plaid.transactionsSync('access-secret-token', 'cur').catch(e => e);
  expect(err).toBeInstanceOf(plaid.PlaidError);
  expect(err).toMatchObject({ errorCode: 'ITEM_LOGIN_REQUIRED', errorType: 'ITEM_ERROR', requestId: 'r1', status: 400 });
  expect(err.message).not.toMatch(/super-secret|access-secret-token/);

  fetch.mockRejectedValueOnce(new Error('connect ECONNREFUSED super-secret'));
  const netErr = await plaid.removeItem('access-secret-token').catch(e => e);
  expect(netErr.message).toBe('Plaid /item/remove request failed: network error');
});

test('the timeout covers a stalled response BODY, not just the headers', async () => {
  jest.useFakeTimers();
  try {
    fetch.mockImplementationOnce(async (_url, init) => ({
      ok: true,
      status: 200,
      json: () => new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      }),
    }));
    const pending = plaid.transactionsSync('tok', null).catch(e => e);
    await jest.advanceTimersByTimeAsync(30000);
    const err = await pending;
    expect(err).toBeInstanceOf(plaid.PlaidError);
    expect(err.message).toBe('Plaid /transactions/sync request failed: timeout');
  } finally {
    jest.useRealTimers();
  }
});

test('a 200 with an unreadable body is an error, never a null result', async () => {
  fetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad json'); } });
  await expect(plaid.getAccounts('tok')).rejects.toThrow('Plaid /accounts/get: unreadable response');
});
