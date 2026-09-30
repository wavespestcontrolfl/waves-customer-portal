/**
 * Lawn prep & service guide on one-time lawn lines: the service-details routes
 * (GET /:token/service-details/:serviceKey/pdf and POST .../send) used to
 * require a RECURRING service of the requested key. An estimate whose only
 * lawn work is a one-time lawn line (one_time_lawn, plugging, dethatching,
 * top_dressing) can now fetch/send the lawn_care guide — and nothing else the
 * estimate does not carry.
 */

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('express-rate-limit', () => () => (req, res, next) => next());
jest.mock('../services/twilio', () => ({ sendSMS: jest.fn() }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../services/email-template-library', () => ({ sendTemplate: jest.fn() }));
// The renderers are exercised in estimate-service-details.test.js; here they
// only need to prove the route let the request through.
jest.mock('../services/estimate-service-details', () => ({
  ...jest.requireActual('../services/estimate-service-details'),
  buildServiceDetailsContent: jest.fn(async (serviceKey) => ({ serviceKey })),
}));
jest.mock('../services/pdf/service-details-pdf', () => ({
  renderServiceDetailsPdf: jest.fn(async () => Buffer.from('%PDF-1.4 test')),
}));

const express = require('express');

const TOKEN = 'one-time-lawn-token-abc123';

function estimateRow(estimateData) {
  return {
    id: 'est-one-time-lawn-1', token: TOKEN, status: 'sent', archived_at: null, expires_at: null,
    customer_id: null, property_id: null, estimate_group_id: null,
    customer_name: 'Sam Customer', customer_phone: '+19415550188', customer_email: 'sam-otl@example.test',
    address: '123 Test Ave, Bradenton, FL',
    notes: null, monthly_total: 0, annual_total: 0, onetime_total: 450,
    show_one_time_option: false, bill_by_invoice: false, waveguard_tier: null,
    service_interest: null, category: null, source: null,
    estimate_data: estimateData,
  };
}

const oneTime = (items) => ({ result: { oneTime: { items } } });
const LAWN_ROW = (service, label) => ({ service, label, price: 450 });

let server;
let base;

// jest.mock (hoisted) rather than doMock: the router is also required at
// describe-collection time below, so the db double must already be in place.
jest.mock('../models/db', () => {
  const holder = { row: null };
  const db = jest.fn((table) => {
    if (table === 'estimates') {
      const builder = {};
      builder.where = jest.fn(() => builder);
      builder.forUpdate = jest.fn(() => builder);
      builder.first = jest.fn(async () => ({ ...holder.row }));
      return builder;
    }
    throw new Error(`one-time-lawn guide test: unexpected table ${table}`);
  });
  db.raw = jest.fn(() => ({ rows: [] }));
  db.fn = { now: () => new Date('2026-01-01T12:00:00.000Z') };
  db.__holder = holder;
  return db;
});

beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/api/estimates', require('../routes/estimate-public'));
  app.use((err, req, res, next) => {
    res.status(err.status || err.statusCode || 500).json({ error: err.message });
  });
  server = app.listen(0, () => {
    base = `http://127.0.0.1:${server.address().port}`;
    done();
  });
});

afterAll((done) => { server.close(done); });

beforeEach(() => {
  jest.clearAllMocks();
  require('../services/email-template-library').sendTemplate.mockReset();
});

const getPdf = (serviceKey) => fetch(`${base}/api/estimates/${TOKEN}/service-details/${serviceKey}/pdf`);
const postSend = (service, channel = 'email') => fetch(`${base}/api/estimates/${TOKEN}/service-details/send`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ service, channel }),
});

describe('estimateRecurringKeysForDetails', () => {
  const { estimateRecurringKeysForDetails } = require('../routes/estimate-public');

  test.each([
    ['one_time_lawn'], ['plugging'], ['dethatching'], ['top_dressing'],
  ])('a one-time %s line unlocks lawn_care and nothing else', (service) => {
    const keys = estimateRecurringKeysForDetails(estimateRow(oneTime([LAWN_ROW(service, 'Lawn work')])));
    expect([...keys]).toEqual(['lawn_care']);
  });

  test('one-time work that is not a lawn line unlocks nothing', () => {
    const keys = estimateRecurringKeysForDetails(estimateRow(oneTime([
      { service: 'one_time_pest', label: 'One-time pest treatment', price: 150 },
      { service: 'termite_foam', label: 'Termite foam treatment', price: 900 },
    ])));
    expect(keys.size).toBe(0);
  });

  test('a recurring lawn line still carries lawn_care; recurring keys are unchanged', () => {
    const keys = estimateRecurringKeysForDetails(estimateRow({
      result: {
        recurring: { services: [{ service: 'pest_control', mo: 60 }] },
        oneTime: { items: [LAWN_ROW('plugging', 'Lawn plugging')] },
      },
    }));
    expect([...keys].sort()).toEqual(['lawn_care', 'pest_control']);
  });

  test('a $0 or unpriced one-time lawn row does not count (not on the customer page)', () => {
    const keys = estimateRecurringKeysForDetails(estimateRow(oneTime([{ service: 'plugging', label: 'Lawn plugging', price: 0 }])));
    expect(keys.size).toBe(0);
  });
});

describe('GET /:token/service-details/:serviceKey/pdf', () => {
  test('serves the lawn_care guide for a one-time-lawn-only estimate', async () => {
    require('../models/db').__holder.row = estimateRow(oneTime([LAWN_ROW('top_dressing', 'Lawn top dressing')]));
    const res = await getPdf('lawn_care');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    const { buildServiceDetailsContent } = require('../services/estimate-service-details');
    expect(buildServiceDetailsContent).toHaveBeenCalledWith('lawn_care', expect.objectContaining({ token: TOKEN }));
  });

  test('still 404s every guide the estimate does not carry', async () => {
    require('../models/db').__holder.row = estimateRow(oneTime([LAWN_ROW('dethatching', 'Lawn dethatching')]));
    for (const key of ['pest_control', 'mosquito', 'termite_bait', 'tree_shrub', 'nope']) {
      const res = await getPdf(key);
      expect(res.status).toBe(404);
    }
  });

  test('404s lawn_care when the estimate has no lawn line at all', async () => {
    require('../models/db').__holder.row = estimateRow(oneTime([{ service: 'one_time_pest', label: 'One-time pest treatment', price: 150 }]));
    const res = await getPdf('lawn_care');
    expect(res.status).toBe(404);
  });
});

describe('POST /:token/service-details/send', () => {
  test('emails the lawn_care guide for a one-time-lawn-only estimate', async () => {
    require('../models/db').__holder.row = estimateRow(oneTime([LAWN_ROW('one_time_lawn', 'One-time lawn treatment')]));
    const { sendTemplate } = require('../services/email-template-library');
    sendTemplate.mockResolvedValueOnce({ sent: true, blocked: false });
    const res = await postSend('lawn_care');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, channel: 'email' });
    expect(sendTemplate).toHaveBeenCalledTimes(1);
    expect(sendTemplate.mock.calls[0][0].triggerEventId).toMatch(/:lawn_care$/);
  });

  test('404s (no send) for a guide the estimate does not carry', async () => {
    require('../models/db').__holder.row = estimateRow(oneTime([LAWN_ROW('plugging', 'Lawn plugging')]));
    const { sendTemplate } = require('../services/email-template-library');
    const res = await postSend('pest_control');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
    expect(sendTemplate).not.toHaveBeenCalled();
  });
});
