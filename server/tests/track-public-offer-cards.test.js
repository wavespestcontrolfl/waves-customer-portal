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

function install({ visit = VISIT, record = RECORD } = {}) {
  mockDb.mockImplementation((table) => {
    const row = String(table).startsWith('scheduled_services') ? visit : record;
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
])('%s → 404 for both taps, nothing recorded or enrolled', async (_label, fixture, arrange) => {
  install(fixture);
  if (arrange) arrange();
  expect((await drive('/:token/cross-sell', { metadata: {} })).statusCode).toBe(404);
  expect((await drive('/:token/referral-link')).statusCode).toBe(404);
  expect(tap.handleCrossSellTap).not.toHaveBeenCalled();
  expect(referralShare.buildReferralShareForCustomer).not.toHaveBeenCalled();
});

test('a report that never reaches the customer gives no offer, but the referral still works', async () => {
  install({ record: { id: 'sr-1', structured_notes: { typedReportDelivery: 'internal_only' } } });
  expect((await drive('/:token/cross-sell', { metadata: {} })).statusCode).toBe(404);
  const res = await drive('/:token/referral-link');
  expect(res.statusCode).toBe(200);
  expect(referralShare.buildReferralShareForCustomer).toHaveBeenCalledWith('cust-1');
});
