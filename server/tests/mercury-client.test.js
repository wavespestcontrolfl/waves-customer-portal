// The Mercury client for payroll: the one door to the network, what it asks for, how it reads answers, and what it
// can never do (a direct send, a token or body in an error). A fake fetch stands in for Mercury. Synthetic ids only.
const fs = require('fs');
const path = require('path');
const { createClient, readConfig, MercuryError } = require('../services/mercury-client');

const TOKEN = 'secret-token-for-tests-0001';
const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const RECIPIENT = '22222222-2222-4222-8222-222222222222';
const env = { MERCURY_API_TOKEN: TOKEN, MERCURY_ACCOUNT_ID: ACCOUNT };

const answer = (status, body) => ({ status, json: async () => { if (body === undefined) throw new Error('no body'); return body; } });
const fakeFetch = (...answers) => {
  const calls = [];
  const fn = jest.fn(async (url, options) => {
    calls.push({ url: String(url), options });
    const next = answers.length > 1 ? answers.shift() : answers[0];
    if (next instanceof Error) throw next;
    return next;
  });
  fn.calls = calls;
  return fn;
};

describe('config', () => {
  test('needs the token and the account; no default can send', () => {
    expect(readConfig({})).toBeNull();
    expect(readConfig({ MERCURY_API_TOKEN: TOKEN })).toBeNull();
    expect(readConfig({ MERCURY_ACCOUNT_ID: ACCOUNT })).toBeNull();
    expect(readConfig(env)).toMatchObject({ base: 'https://api.mercury.com/api/v1', accountId: ACCOUNT });
  });

  test('the sandbox base works; any other host or plain http is refused so the token goes only to Mercury', () => {
    expect(readConfig({ ...env, MERCURY_API_BASE: 'https://api-sandbox.mercury.com/api/v1/' }).base).toBe('https://api-sandbox.mercury.com/api/v1');
    expect(readConfig({ ...env, MERCURY_API_BASE: 'https://evil.example.com/api/v1' })).toBeNull();
    expect(readConfig({ ...env, MERCURY_API_BASE: 'https://mercury.com.evil.example/api/v1' })).toBeNull();
    expect(readConfig({ ...env, MERCURY_API_BASE: 'http://api.mercury.com/api/v1' })).toBeNull();
  });

  test('an unconfigured client makes no call', async () => {
    const fetchImpl = fakeFetch(answer(200, {}));
    const client = createClient({ fetchImpl, env: {} });
    expect(client.configured).toBe(false);
    await expect(client.getBalance()).rejects.toMatchObject({ kind: 'not_configured' });
    await expect(client.requestSendMoney({ recipientId: RECIPIENT, amountCents: 100, idempotencyKey: 'k', note: 'n', externalMemo: 'm' })).rejects.toMatchObject({ kind: 'not_configured' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('requestSendMoney', () => {
  const body = { requestId: 'req-1', status: 'pendingApproval', amount: 812.4, recipientId: RECIPIENT, accountId: ACCOUNT, createdAt: '2026-11-02T14:00:00Z' };

  test('posts an ACH approval request with the key, note and memo, and returns the request id and status', async () => {
    const fetchImpl = fakeFetch(answer(200, body));
    const client = createClient({ fetchImpl, env });
    const out = await client.requestSendMoney({ recipientId: RECIPIENT, amountCents: 81240, idempotencyKey: 'idem-1', note: 'waves-pay:abc', externalMemo: 'Waves pay' });
    expect(out).toMatchObject({ requestId: 'req-1', status: 'pendingApproval', amountCents: 81240 });
    const [call] = fetchImpl.calls;
    expect(call.url).toBe(`https://api.mercury.com/api/v1/account/${ACCOUNT}/request-send-money`);
    expect(call.options.method).toBe('POST');
    expect(call.options.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(call.options.body)).toEqual({
      recipientId: RECIPIENT, amount: 812.4, paymentMethod: 'ach', idempotencyKey: 'idem-1', note: 'waves-pay:abc', externalMemo: 'Waves pay',
    });
  });

  test('a 2xx without a request id is unknown: it may have been taken', async () => {
    const client = createClient({ fetchImpl: fakeFetch(answer(200, { status: 'pendingApproval' })), env });
    await expect(client.requestSendMoney({ recipientId: RECIPIENT, amountCents: 100, idempotencyKey: 'k', note: 'n', externalMemo: 'm' })).rejects.toMatchObject({ kind: 'unknown' });
  });

  test.each([
    [400, { errors: { errorCode: 'InvalidRecipient', message: 'bad 123456789' } }, 'rejected', 'InvalidRecipient'],
    [422, {}, 'rejected', null],
    [429, {}, 'rejected', null],
    [401, { errors: { message: 'nope' } }, 'auth', null],
    [403, {}, 'auth', null],
    [404, {}, 'not_found', null],
    [408, {}, 'unknown', null],
    [500, { anything: 'x' }, 'unknown', null],
    [503, undefined, 'unknown', null],
  ])('HTTP %i is %s', async (status, body, kind, code) => {
    const client = createClient({ fetchImpl: fakeFetch(answer(status, body)), env });
    const error = await client.requestSendMoney({ recipientId: RECIPIENT, amountCents: 100, idempotencyKey: 'k', note: 'n', externalMemo: 'm' }).catch((e) => e);
    expect(error).toBeInstanceOf(MercuryError);
    expect(error).toMatchObject({ kind, code });
    // Nothing from the answer, the token or the account is in the error.
    expect(error.message + JSON.stringify(error)).not.toMatch(/123456789|nope|secret-token|11111111/);
  });

  test('a network error or a timeout is unknown', async () => {
    const client = createClient({ fetchImpl: fakeFetch(new Error('socket hang up')), env });
    await expect(client.requestSendMoney({ recipientId: RECIPIENT, amountCents: 100, idempotencyKey: 'k', note: 'n', externalMemo: 'm' })).rejects.toMatchObject({ kind: 'unknown' });
    const slow = createClient({ fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => { signal.addEventListener('abort', () => reject(new Error('aborted'))); }), env, timeoutMs: 5 });
    await expect(slow.requestSendMoney({ recipientId: RECIPIENT, amountCents: 100, idempotencyKey: 'k', note: 'n', externalMemo: 'm' })).rejects.toMatchObject({ kind: 'unknown' });
  });

  test('an error code with odd characters is dropped', async () => {
    const client = createClient({ fetchImpl: fakeFetch(answer(400, { errors: { errorCode: 'has spaces and 1234567890 account' } })), env });
    const error = await client.requestSendMoney({ recipientId: RECIPIENT, amountCents: 100, idempotencyKey: 'k', note: 'n', externalMemo: 'm' }).catch((e) => e);
    expect(error.code).toBeNull();
  });
});

describe('reads', () => {
  test('getRequest, listRequests (page cursor), listTransactions (request id filter), getBalance', async () => {
    const fetchImpl = fakeFetch(
      answer(200, { requestId: 'r1', status: 'approved', amount: 10.5, recipientId: RECIPIENT, createdAt: 'c', memo: 'waves-pay:x' }),
      answer(200, { requests: [{ requestId: 'r1', status: 'approved', amount: 1 }], page: { nextPage: 'r1' } }),
      answer(200, { requests: [{ requestId: 'r2', status: 'rejected', amount: 2 }], page: {} }),
      answer(200, { total: 1, transactions: [{ id: 't1', status: 'sent', amount: -812.4, counterpartyId: RECIPIENT, requestId: 'r1', postedAt: '2026-11-04T10:00:00Z', relatedTransactions: [{ relationKind: 'OriginalTransactionToReturn' }] }] }),
      answer(200, { availableBalance: 5000.25, currentBalance: 6000 }),
    );
    const client = createClient({ fetchImpl, env });
    expect(await client.getRequest('r1')).toMatchObject({ requestId: 'r1', status: 'approved', amountCents: 1050, memo: 'waves-pay:x' });
    expect((await client.listRequests()).map((r) => r.requestId)).toEqual(['r1', 'r2']);
    const [tx] = await client.listTransactions({ requestId: 'r1' });
    expect(tx).toMatchObject({ id: 't1', status: 'sent', amountCents: 81240, requestId: 'r1', hasReturn: true });
    expect(await client.getBalance()).toEqual({ availableCents: 500025 });
    expect(fetchImpl.calls.every((c) => c.options.method === 'GET')).toBe(true);
    expect(fetchImpl.calls[2].url).toContain('start_after=r1');
    expect(fetchImpl.calls[3].url).toContain(`/account/${ACCOUNT}/transactions`);
    expect(fetchImpl.calls[3].url).toContain('requestId=r1');
  });

  test('getRecipient returns the name and status only, never numbers', async () => {
    const fetchImpl = fakeFetch(answer(200, {
      id: RECIPIENT, name: 'Sample Employee', status: 'active',
      electronicRoutingInfo: { accountNumber: '000123456789', routingNumber: '021000021' },
    }));
    const out = await createClient({ fetchImpl, env }).getRecipient(RECIPIENT);
    expect(out).toEqual({ name: 'Sample Employee', status: 'active' });
    expect(JSON.stringify(out)).not.toMatch(/0001234|021000021/);
  });
});

describe('no direct send', () => {
  test('the client exposes no way to send money without approval', () => {
    const client = createClient({ fetchImpl: fakeFetch(answer(200, {})), env });
    expect(Object.keys(client).sort()).toEqual([
      'accountId', 'configured', 'getBalance', 'getRecipient', 'getRequest', 'listRequests', 'listTransactions', 'requestSendMoney',
    ]);
  });

  test('no payroll Mercury source file POSTs anywhere but request-send-money', () => {
    const dir = path.join(__dirname, '..', 'services');
    for (const file of ['mercury-client.js', 'payroll-mercury.js', 'payroll-mercury-poller.js', 'payroll-mercury-alerts.js']) {
      // Code only: the header comments name the forbidden call so a reader knows why it is absent.
      const text = fs.readFileSync(path.join(dir, file), 'utf8').split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');
      expect(text).not.toMatch(/createTransaction|sendMoney\b/);
      // Every 'POST' literal sits beside the request-send-money path; the transactions path is only ever read.
      for (const match of text.matchAll(/'POST'[^\n]*/g)) expect(match[0]).toMatch(/request-send-money|SEND_PATH|method !== 'GET'/);
      expect(text).not.toMatch(/POST[^\n]*\/transactions/);
    }
  });
});
