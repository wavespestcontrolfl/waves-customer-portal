// Tracker add-a-service + referral cards (GATE_DOC_CROSS_SELL, owner
// 2026-11-21). The track link also reaches the account's service contacts
// (tenant, home buyer, property manager), so the tracker's own decision is
// WHO may see the cards: only a completed visit whose account has no
// service contact and no third-party payer. The offer and the tap are the
// report's own (cross-sell-tap.js); this suite pins the tracker's gate on
// them. Handlers are driven directly (no supertest in this repo).
const mockDb = jest.fn();
jest.mock('../models/db', () => mockDb);
jest.mock('../services/geocoder', () => ({ ensureCustomerGeocoded: jest.fn() }));
jest.mock('../services/photos', () => ({ getViewUrl: jest.fn() }));
jest.mock('../config/feature-gates', () => ({
  ...jest.requireActual('../config/feature-gates'),
  isEnabled: jest.fn(),
}));
jest.mock('../services/service-report/cross-sell-tap', () => ({
  // The real who-may-see-it rule; only the offer and the tap are stubbed.
  linkReachesOnlyAccountHolder: jest.requireActual('../services/service-report/cross-sell-tap').linkReachesOnlyAccountHolder,
  reportSuppressedForCustomer: jest.requireActual('../services/service-report/cross-sell-tap').reportSuppressedForCustomer,
  buildCrossSellForServiceRecord: jest.fn(),
  handleCrossSellTap: jest.fn(),
}));
jest.mock('../services/referral-share', () => ({
  composeReferralCard: jest.fn(),
  buildReferralShareForCustomer: jest.fn(),
}));

const { isEnabled } = require('../config/feature-gates');
const tap = require('../services/service-report/cross-sell-tap');
const referralShare = require('../services/referral-share');
const router = require('../routes/track-public');

const TOKEN = 'a'.repeat(64);
const VISIT = {
  id: 'ss-1',
  customer_id: 'cust-1',
  status: 'completed',
  track_token_expires_at: new Date(Date.now() + 86400000).toISOString(),
  job_payer_id: null,
  customer_payer_id: null,
};
const RECORD = { id: 'sr-1', structured_notes: {} };

// invoices: the visit's invoices, as { scheduled_service_id | service_record_id,
// payer_id } rows. The fake applies the route's own filter (either link to
// the visit, payer set), so a wrong filter in the route fails here.
function install({ visit = VISIT, record = RECORD, invoices = [] } = {}) {
  mockDb.mockImplementation((table) => {
    const name = String(table);
    if (name === 'invoices') {
      let rows = invoices;
      const chain = {
        where: jest.fn((arg) => {
          if (typeof arg !== 'function') throw new Error('invoices: expected the grouped visit filter');
          const alternatives = [];
          const group = {
            where: (criteria) => { alternatives.push(criteria); return group; },
            orWhere: (criteria) => { alternatives.push(criteria); return group; },
          };
          arg(group);
          rows = rows.filter((r) => alternatives.some((c) => Object.entries(c).every(([k, v]) => r[k] === v)));
          return chain;
        }),
        whereNotNull: jest.fn((col) => { rows = rows.filter((r) => r[col] != null); return chain; }),
        first: jest.fn(async () => rows[0]),
      };
      return chain;
    }
    const row = name.startsWith('scheduled_services') ? visit : record;
    const chain = {
      where: jest.fn(() => chain),
      leftJoin: jest.fn(() => chain),
      orderBy: jest.fn(() => chain),
      first: jest.fn(async () => row),
    };
    return chain;
  });
}

function handlerFor(path) {
  const layer = router.stack.find((l) => l.route?.path === path && l.route.methods.post);
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}

async function drive(path, body) {
  const res = {
    statusCode: 200,
    set: jest.fn(() => res),
    status: jest.fn((c) => { res.statusCode = c; return res; }),
    json: jest.fn((b) => { res.body = b; return res; }),
  };
  await handlerFor(path)({ params: { token: TOKEN }, body }, res);
  return res;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockDb.mockReset();
  isEnabled.mockImplementation((key) => key === 'docCrossSell');
  tap.handleCrossSellTap.mockResolvedValue({ status: 200, body: { ok: true } });
  referralShare.buildReferralShareForCustomer.mockResolvedValue({ code: 'WAVES-1' });
});

test('a completed visit reached only by the account holder taps through the report\'s own tap', async () => {
  install();
  const metadata = { serviceKey: 'pest_control', fingerprint: 'fp' };
  const res = await drive('/:token/cross-sell', { metadata });
  expect(res.statusCode).toBe(200);
  expect(tap.handleCrossSellTap).toHaveBeenCalledWith(expect.objectContaining({
    serviceRecordId: 'sr-1', metadata, surface: expect.objectContaining({ source: 'tracker' }),
  }));
});

test.each([
  ['gate off', {}, () => isEnabled.mockReturnValue(false)],
  ['visit not completed', { visit: { ...VISIT, status: 'en_route' } }, null],
  ['expired link', { visit: { ...VISIT, track_token_expires_at: new Date(Date.now() - 1000).toISOString() } }, null],
  ['a service contact also gets this link', { visit: { ...VISIT, service_contact_name: 'Tenant Tina', service_contact_phone: '+19415550100' } }, null],
  ['third-party payer on the job', { visit: { ...VISIT, job_payer_id: 7 } }, null],
  ['third-party payer on the account', { visit: { ...VISIT, customer_payer_id: 7 } }, null],
  // An invoice can bill a third party with no payer on the job or the account.
  ['the visit\'s invoice bills a third party (linked by the visit)', { invoices: [{ scheduled_service_id: 'ss-1', payer_id: 9 }] }, null],
  ['the visit\'s invoice bills a third party (linked by the service record)', { invoices: [{ service_record_id: 'sr-1', payer_id: 9 }] }, null],
  ['an older invoice of the visit bills a third party', { invoices: [{ scheduled_service_id: 'ss-1', payer_id: null }, { scheduled_service_id: 'ss-1', payer_id: 9 }] }, null],
])('%s → 404 for both taps, nothing recorded or enrolled', async (_label, fixture, arrange) => {
  install(fixture);
  if (arrange) arrange();
  expect((await drive('/:token/cross-sell', { metadata: {} })).statusCode).toBe(404);
  expect((await drive('/:token/referral-link')).statusCode).toBe(404);
  expect(tap.handleCrossSellTap).not.toHaveBeenCalled();
  expect(referralShare.buildReferralShareForCustomer).not.toHaveBeenCalled();
});

test('invoices that bill the customer, or belong to another visit, keep the cards', async () => {
  install({ invoices: [
    { scheduled_service_id: 'ss-1', payer_id: null },
    { scheduled_service_id: 'ss-other', payer_id: 9 },
    { service_record_id: 'sr-other', payer_id: 9 },
  ] });
  expect((await drive('/:token/cross-sell', { metadata: {} })).statusCode).toBe(200);
  expect((await drive('/:token/referral-link')).statusCode).toBe(200);
});

test('a report that never reaches the customer gives no offer, but the referral still works', async () => {
  install({ record: { id: 'sr-1', structured_notes: { typedReportDelivery: 'internal_only' } } });
  expect((await drive('/:token/cross-sell', { metadata: {} })).statusCode).toBe(404);
  const res = await drive('/:token/referral-link');
  expect(res.statusCode).toBe(200);
  expect(referralShare.buildReferralShareForCustomer).toHaveBeenCalledWith('cust-1');
});

test.each([
  ['/:token/cross-sell', 'gate off', TOKEN, false],
  ['/:token/referral-link', 'gate off', TOKEN, false],
  ['/:token/cross-sell', 'malformed token', 'nope', true],
])('%s, %s → the generic 404 ahead of the limiter (a dark route never 429s)', async (path, _label, token, gateOn) => {
  isEnabled.mockReturnValue(gateOn);
  const layer = router.stack.find((l) => l.route?.path === path && l.route.methods.post);
  const res = { statusCode: 200, set: jest.fn(), json: jest.fn() };
  res.status = jest.fn((code) => { res.statusCode = code; return res; });
  const next = jest.fn();
  layer.route.stack[0].handle({ params: { token } }, res, next);
  expect(next).not.toHaveBeenCalled();
  expect(res.statusCode).toBe(404);
  expect(mockDb).not.toHaveBeenCalled();
});

test('a callback visit gets neither card (the report\'s rule, with the re-service copy gate on)', async () => {
  const prior = process.env.GATE_RESERVICE_REPORT_COPY;
  process.env.GATE_RESERVICE_REPORT_COPY = 'true';
  try {
    install({ record: { ...RECORD, is_callback: true } });
    expect((await drive('/:token/cross-sell', { metadata: {} })).statusCode).toBe(404);
    expect((await drive('/:token/referral-link')).statusCode).toBe(404);
    expect(tap.handleCrossSellTap).not.toHaveBeenCalled();
    expect(referralShare.buildReferralShareForCustomer).not.toHaveBeenCalled();
  } finally {
    if (prior === undefined) delete process.env.GATE_RESERVICE_REPORT_COPY;
    else process.env.GATE_RESERVICE_REPORT_COPY = prior;
  }
});

// Codex #8262 P0: every limiter (the global /api/ one and the tracker's
// router-wide 120/min one) sits behind the dark guard index.js mounts first —
// over the budget the dark taps still answer the generic 404, never a
// revealing 429. Real HTTP through the guard + the real router.
test('gate off: more than the router budget of card taps all answer 404, never 429', async () => {
  isEnabled.mockReturnValue(false);
  const express = require('express');
  const app = express();
  app.use(express.json());
  const { docCardTapDarkGuard, CARD_TAP_SURFACES } = require('../middleware/doc-card-tap-dark-guard');
  app.use('/t', (req, res, next) => docCardTapDarkGuard(CARD_TAP_SURFACES.track, req, res, next));
  app.use('/t', router);
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  try {
    const { port } = server.address();
    const statuses = [];
    for (let i = 0; i < 125; i += 1) {
      const r = await fetch(`http://127.0.0.1:${port}/t/${TOKEN}/cross-sell`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      statuses.push(r.status);
    }
    expect(new Set(statuses)).toEqual(new Set([404]));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
