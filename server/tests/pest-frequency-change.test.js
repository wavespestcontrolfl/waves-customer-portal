// One-touch pest frequency change: the pure pieces and the route contract. What a change BOOKS is
// proved on real PostgreSQL (pest-frequency-change-postgres.test.js); this suite needs no database.
jest.mock('../models/db', () => ({}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const { PRICE_SERVICE_SERVICE_KEYS, PRICE_SERVICE_PRICE_KEYS } = require('../services/recurring-template-overrides');
const { _private } = require('../services/pest-frequency-change');

describe('pricing a choice', () => {
  // Owner 2026-11-12, answer A: the customer's own per-visit price along the estimate frequency curve.
  test.each([
    ['quarterly', 117, 'bimonthly', { visitsPerYear: 6, perVisit: 102.96, perYear: 617.76 }],
    ['quarterly', 117, 'monthly', { visitsPerYear: 12, perVisit: 91.26, perYear: 1095.12 }],
    // From every two months, the two factors' ratio: the same quarterly base gives the same monthly price.
    ['bimonthly', 102.96, 'monthly', { visitsPerYear: 12, perVisit: 91.26, perYear: 1095.12 }],
    ['quarterly', 89.5, 'monthly', { visitsPerYear: 12, perVisit: 69.81, perYear: 837.72 }],
    // A half cent rounds up: 6710 x 78 / 88 = 5947.5 cents. In floating-point dollars the same sum is 59.47.
    ['bimonthly', 67.1, 'monthly', { visitsPerYear: 12, perVisit: 59.48, perYear: 713.76 }],
    // 4525 x 88 / 100 = 3982 cents exactly, and a year of it has no float tail.
    ['quarterly', 45.25, 'bimonthly', { visitsPerYear: 6, perVisit: 39.82, perYear: 238.92 }],
  ])('%s at $%s to %s', (frequency, perVisit, to, expected) => {
    expect(_private.pricedOption({ frequency, perVisit }, to)).toEqual({ frequency: to, ...expected });
  });
});

describe('the plan template of a choice', () => {
  const option = { perVisit: 91.26, service: { id: 'svc-monthly', name: 'Monthly Pest Control Service', service_key: 'pest_general_monthly', category: 'pest_control' } };

  // The template overlay replaces only the keys it is given (recurring-template-overrides.js), and a plan's
  // first visit may carry a structured price or a discount. A key the stamp leaves out keeps the old plan's value.
  test('sets every service key and every price key the series template can carry', () => {
    const fields = _private.templateFields(option);
    expect(Object.keys(fields).sort()).toEqual([...PRICE_SERVICE_SERVICE_KEYS, ...PRICE_SERVICE_PRICE_KEYS].sort());
    expect(fields).toMatchObject({ service_id: 'svc-monthly', service_type: 'Monthly Pest Control Service', service_key_snapshot: 'pest_general_monthly',
      service_category_snapshot: 'pest_control', is_callback: false, estimated_price: 91.26, primary_line_price: 91.26 });
    const discounts = Object.entries(fields).filter(([key]) => /discount/.test(key));
    expect(discounts.every(([, value]) => value === null)).toBe(true);
  });
});

describe('the version of an outcome', () => {
  const plan = { root: { id: 'root-1' }, frequency: 'quarterly', perVisit: 117, perYear: 468, visitsPerYear: 4 };
  const option = { frequency: 'monthly', perVisit: 91.26, perYear: 1095.12, visitsPerYear: 12, service: { id: 'svc-monthly' } };
  const change = (over = {}) => ({
    kept: null,
    cancelled: [{ id: 'v1', date: '2027-01-20' }],
    spawnedVisits: [{ scheduledServiceId: 'n2', scheduledDate: '2026-12-20' }, { scheduledServiceId: 'n1', scheduledDate: '2026-11-20' }],
    ...over,
  });

  test('names the dates, not the new rows: a preview and the confirm that repeats it agree', () => {
    const shown = _private.outcomeOf(plan, option, change());
    const repeated = _private.outcomeOf(plan, option, change({
      spawnedVisits: [{ scheduledServiceId: 'other-1', scheduledDate: '2026-11-20' }, { scheduledServiceId: 'other-2', scheduledDate: '2026-12-20' }],
    }));
    expect(shown.newVisits).toEqual(['2026-11-20', '2026-12-20']);
    expect(repeated.version).toBe(shown.version);
  });

  test.each([
    ['a new visit on another date', (c) => ({ ...c, spawnedVisits: [{ scheduledServiceId: 'n1', scheduledDate: '2026-11-21' }, c.spawnedVisits[0]] })],
    ['another visit replaced', (c) => ({ ...c, cancelled: [{ id: 'v2', date: '2027-01-20' }] })],
    ['a visit kept', (c) => ({ ...c, kept: { id: 'v1', date: '2027-01-20' }, cancelled: [] })],
  ])('changes with %s', (_name, alter) => {
    expect(_private.outcomeOf(plan, option, alter(change())).version).not.toBe(_private.outcomeOf(plan, option, change()).version);
  });

  test('changes with the price the customer was shown', () => {
    const other = _private.outcomeOf(plan, { ...option, perVisit: 95 }, change());
    expect(other.version).not.toBe(_private.outcomeOf(plan, option, change()).version);
  });
});

describe('the first production test', () => {
  const pestFrequency = require('../services/pest-frequency-change');
  const TEST_CUSTOMER = '11111111-2222-4333-8444-555555555555';
  afterEach(() => { delete process.env.PEST_FREQUENCY_CHANGE_CUSTOMER_ALLOWLIST; });

  // The allowlist only narrows the gate: a customer it leaves out is answered before any read (the db here
  // is an empty mock, so a read would throw).
  test.each([
    ['another customer on the list', '99999999-2222-4333-8444-555555555555'],
    ['a list with no valid id', 'not-a-customer-id'],
  ])('%s: this customer is not offered the change', async (_name, list) => {
    process.env.PEST_FREQUENCY_CHANGE_CUSTOMER_ALLOWLIST = list;
    await expect(pestFrequency.status(TEST_CUSTOMER)).resolves.toEqual({ available: false });
    await expect(pestFrequency.preview(TEST_CUSTOMER, 'monthly')).rejects.toMatchObject({ status: 409, code: 'FREQUENCY_CHANGE_UNAVAILABLE', reason: 'allowlist' });
    await expect(pestFrequency.confirm(TEST_CUSTOMER, 'monthly', { version: 'v' })).rejects.toMatchObject({ status: 409, reason: 'allowlist' });
  });

  test('a customer on the list is read like any other (the list offers nothing by itself)', async () => {
    process.env.PEST_FREQUENCY_CHANGE_CUSTOMER_ALLOWLIST = TEST_CUSTOMER.toUpperCase();
    await expect(pestFrequency.status(TEST_CUSTOMER)).rejects.toThrow();
  });
});

describe('route contracts', () => {
  const express = require('express');

  let server = null;
  const listen = (app) => new Promise((resolve) => {
    server = app.listen(0, () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
  const serviceMock = { status: jest.fn(), preview: jest.fn(), confirm: jest.fn() };

  function appWithGate(gateOn) {
    jest.resetModules();
    jest.doMock('../middleware/auth', () => ({
      authenticate: (req, _res, nextFn) => { req.customerId = 'cust-1'; nextFn(); },
    }));
    jest.doMock('../services/pest-frequency-change', () => serviceMock);
    let router;
    jest.isolateModules(() => {
      router = require('../routes/pest-frequency');
    });
    const app = express();
    app.use(express.json());
    // The gate reads the env at REQUEST time, so set it per request.
    app.use((req, _res, nextFn) => {
      process.env.GATE_PEST_FREQUENCY_CHANGE = gateOn ? 'true' : '';
      nextFn();
    });
    app.use('/api/pest-frequency', router);
    app.use((err, _req, res, _next) => res.status(500).json({ error: 'server error' }));
    return app;
  }
  const post = (base, path, body) => fetch(`${base}/api/pest-frequency/${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'jest-agent' }, body: JSON.stringify(body),
  });

  afterEach(async () => {
    delete process.env.GATE_PEST_FREQUENCY_CHANGE;
    jest.dontMock('../middleware/auth');
    jest.dontMock('../services/pest-frequency-change');
    Object.values(serviceMock).forEach((fn) => fn.mockReset());
    if (server) { await new Promise((resolve) => server.close(resolve)); server = null; }
  });

  test('gate off: the card read answers not available, both writes answer 404, and the service is never asked', async () => {
    const base = await listen(appWithGate(false));
    const card = await fetch(`${base}/api/pest-frequency`);
    expect([card.status, await card.json()]).toEqual([200, { available: false }]);
    for (const path of ['preview', 'confirm']) {
      const res = await post(base, path, { frequency: 'monthly', version: 'v' });
      expect([res.status, await res.json()]).toEqual([404, { error: 'Not available' }]);
    }
    Object.values(serviceMock).forEach((fn) => expect(fn).not.toHaveBeenCalled());
  });

  test('gate on: the card, a preview and a confirm reach the service as the signed-in customer', async () => {
    const base = await listen(appWithGate(true));
    serviceMock.status.mockResolvedValue({ available: true, options: [] });
    serviceMock.preview.mockResolvedValue({ frequency: 'monthly', version: 'v1' });
    serviceMock.confirm.mockResolvedValue({ success: true, version: 'v1' });

    expect(await (await fetch(`${base}/api/pest-frequency`)).json()).toEqual({ available: true, options: [] });
    expect(serviceMock.status).toHaveBeenCalledWith('cust-1');
    expect(await (await post(base, 'preview', { frequency: 'monthly' })).json()).toEqual({ frequency: 'monthly', version: 'v1' });
    expect(serviceMock.preview).toHaveBeenCalledWith('cust-1', 'monthly');
    expect(await (await post(base, 'confirm', { frequency: 'monthly', version: 'v1' })).json()).toEqual({ success: true, version: 'v1' });
    expect(serviceMock.confirm).toHaveBeenCalledWith('cust-1', 'monthly', expect.objectContaining({ version: 'v1', userAgent: 'jest-agent' }));
  });

  // Fewer visits is never a one-touch choice (owner 2026-11-12, answer A): quarterly is not a frequency to post.
  test.each([['quarterly'], ['weekly'], [undefined]])('a frequency of %s is refused before the service', async (frequency) => {
    const base = await listen(appWithGate(true));
    for (const path of ['preview', 'confirm']) {
      const res = await post(base, path, { frequency, version: 'v' });
      expect([res.status, await res.json()]).toEqual([400, { error: 'frequency required' }]);
    }
    expect(serviceMock.preview).not.toHaveBeenCalled();
    expect(serviceMock.confirm).not.toHaveBeenCalled();
  });

  test('a refusal answers its status, message and code; any other failure is a server error', async () => {
    const base = await listen(appWithGate(true));
    serviceMock.preview.mockRejectedValue(Object.assign(new Error('This change is not available online for this plan.'), { status: 409, code: 'FREQUENCY_CHANGE_UNAVAILABLE', reason: 'annual_prepay' }));
    const refused = await post(base, 'preview', { frequency: 'monthly' });
    expect([refused.status, await refused.json()]).toEqual([409, { error: 'This change is not available online for this plan.', code: 'FREQUENCY_CHANGE_UNAVAILABLE' }]);
    serviceMock.confirm.mockRejectedValue(new Error('connection lost'));
    const broken = await post(base, 'confirm', { frequency: 'monthly', version: 'v' });
    expect([broken.status, await broken.json()]).toEqual([500, { error: 'server error' }]);
  });
});
