/**
 * procurement/adapters — Sticker Mule reorder API.
 *
 * Sticker Mule contract:
 *   - bindingQuote = the account's latest single-item order of this item at this
 *     exact quantity (vendor total); no match / unreadable shape → null
 *   - no API key → RefusedError no_api_key before any call
 *   - item not on the account / ≠1 address / ≠1 payment → RefusedError, NO POST
 *   - POST failure / missing number → err.ambiguous (never re-POSTed)
 *   - success → order number + the vendor's read-back total (quote fallback)
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const sm = require('../services/procurement/adapters/stickermule');

function fakeFetch(routes) {
  const calls = [];
  const fetchImpl = jest.fn(async (url, init) => {
    const path = new URL(url).pathname;
    calls.push({ method: init.method, path, body: init.body ? JSON.parse(init.body) : null, auth: init.headers.Authorization });
    const r = routes[`${init.method} ${path}`];
    if (typeof r === 'function') return r();
    const status = r?.status || 200;
    return { ok: status < 400, status, text: async () => JSON.stringify(r?.body ?? r ?? {}) };
  });
  return { fetchImpl, calls };
}

const happy = () => ({
  'GET /api/items': { items: [{ id: 4242, name: 'Serviced by Waves 4x5' }] },
  'GET /api/addresses': { addresses: [{ id: 'addr-1' }] },
  'GET /api/payments': { payments: [{ id: 'pay-1' }] },
  'POST /api/orders': { order: { number: 'SM-90001' } },
  'GET /api/orders': { orders: [{ number: 'SM-90001', total: '318.40' }] },
});

beforeEach(() => { process.env.STICKERMULE_API_KEY = 'test-key'; });
afterAll(() => { delete process.env.STICKERMULE_API_KEY; });

test('bindingQuote = the latest identical single-item order on the account, vendor total', async () => {
  const orders = { orders: [
    { number: 'SM-1', total: '318.40', createdAt: '2026-07-01T00:00:00Z', items: [{ id: 4242, quantity: 500 }] },
    { number: 'SM-2', total: '322.10', createdAt: '2026-08-01T00:00:00Z', items: [{ id: 4242, quantity: 500 }] },
    { number: 'SM-3', total: '600.00', createdAt: '2026-08-15T00:00:00Z', items: [{ id: 4242, quantity: 500 }, { id: 9, quantity: 1 }] },
    { number: 'SM-4', total: '520.00', createdAt: '2026-08-20T00:00:00Z', items: [{ id: 4242, quantity: 1000 }] },
  ] };
  const { fetchImpl, calls } = fakeFetch({ 'GET /api/orders': orders });
  expect(await sm.bindingQuote({ vendorSku: '4242', quantity: 500 }, { fetchImpl })).toEqual({ cents: 32210, source: 'order SM-2' });
  expect(await sm.bindingQuote({ vendorSku: '4242', quantity: 1000 }, { fetchImpl })).toEqual({ cents: 52000, source: 'order SM-4' });
  expect(await sm.bindingQuote({ vendorSku: '4242', quantity: 300 }, { fetchImpl })).toBeNull();
  expect(await sm.bindingQuote({ vendorSku: '9999', quantity: 500 }, { fetchImpl })).toBeNull();
  expect(calls.every((c) => c.method === 'GET')).toBe(true);
  expect(await sm.bindingQuote({ vendorSku: '4242', quantity: 500 }, { fetchImpl: fakeFetch({ 'GET /api/orders': { orders: [{ number: 'X', total: '100', lines: [] }] } }).fetchImpl })).toBeNull();
});

test('no API key → refused before any call', async () => {
  delete process.env.STICKERMULE_API_KEY;
  const { fetchImpl } = fakeFetch(happy());
  await expect(sm.place({ vendorSku: '4242', quantity: 500 }, { fetchImpl })).rejects.toMatchObject({ refuse: 'no_api_key' });
  expect(fetchImpl).not.toHaveBeenCalled();
});

test('places a reorder: bearer auth, one item, the single address + payment, vendor total read back', async () => {
  const { fetchImpl, calls } = fakeFetch(happy());
  const r = await sm.place({ vendorSku: '4242', quantity: 500, quoteCents: 31400 }, { fetchImpl });
  expect(r.externalOrderNumber).toBe('SM-90001');
  expect(r.amountCents).toBe(31840);
  expect(r.evidence).toMatchObject({ itemId: 4242, addressId: 'addr-1', paymentId: 'pay-1', totalSource: 'vendor' });
  const post = calls.find((c) => c.method === 'POST');
  expect(post.body).toEqual({ items: [{ id: 4242, quantity: 500 }], addressId: 'addr-1', paymentId: 'pay-1' });
  expect(post.auth).toBe('Bearer test-key');
});

test('item not on the account → refused, no POST', async () => {
  const { fetchImpl, calls } = fakeFetch(happy());
  await expect(sm.place({ vendorSku: '9999', quantity: 500 }, { fetchImpl })).rejects.toMatchObject({ refuse: 'item_not_found' });
  expect(calls.some((c) => c.method === 'POST')).toBe(false);
});

test('two addresses or two payment methods → refused, no POST', async () => {
  const twoAddr = { ...happy(), 'GET /api/addresses': { addresses: [{ id: 'a' }, { id: 'b' }] } };
  await expect(sm.place({ vendorSku: '4242', quantity: 500 }, { fetchImpl: fakeFetch(twoAddr).fetchImpl })).rejects.toMatchObject({ refuse: 'multiple_addresses' });
  const noPay = { ...happy(), 'GET /api/payments': { payments: [] } };
  const f = fakeFetch(noPay);
  await expect(sm.place({ vendorSku: '4242', quantity: 500 }, { fetchImpl: f.fetchImpl })).rejects.toMatchObject({ refuse: 'no_payment' });
  expect(f.calls.some((c) => c.method === 'POST')).toBe(false);
});

test('a failing POST is ambiguous — surfaced, never repeated', async () => {
  const { fetchImpl, calls } = fakeFetch({ ...happy(), 'POST /api/orders': { status: 504, body: { message: 'upstream timeout' } } });
  await expect(sm.place({ vendorSku: '4242', quantity: 500 }, { fetchImpl })).rejects.toMatchObject({ ambiguous: true, status: 504 });
  expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
});

test('a POST that returns no order number is ambiguous', async () => {
  const { fetchImpl } = fakeFetch({ ...happy(), 'POST /api/orders': { ok: true } });
  await expect(sm.place({ vendorSku: '4242', quantity: 500 }, { fetchImpl })).rejects.toMatchObject({ ambiguous: true });
});

test('a failed read-back keeps the order and falls back to the quote', async () => {
  const { fetchImpl } = fakeFetch({ ...happy(), 'GET /api/orders': { status: 500 } });
  const r = await sm.place({ vendorSku: '4242', quantity: 500, quoteCents: 31400 }, { fetchImpl });
  expect(r.externalOrderNumber).toBe('SM-90001');
  expect(r.amountCents).toBe(31400);
  expect(r.evidence.totalSource).toBe('quote');
});
