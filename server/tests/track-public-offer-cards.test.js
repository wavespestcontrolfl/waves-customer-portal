// Tracker add-a-service + referral cards (GATE_DOC_CROSS_SELL, owner
// 2026-11-21). The track link also reaches the account's service contacts
// (tenant, home buyer, property manager), so the tracker's own decision is
// WHO may see the cards: only a completed visit whose account has no
// service contact and no third-party payer. The offer and the tap are the
// report's own (cross-sell-tap.js); this suite pins the tracker's gate on
// them. Handlers are driven directly (no supertest in this repo).
// Each tap reads that decision twice: once before the tap, and again inside
// the write with the customer row locked (AGENTS.md: the commit path
// re-checks the preflight read). The fake below answers the second read from
// its own rows (`later`), so a test can change the world between the two.
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
  // The real referral tap wrapper: the customer lock, then the second read.
  referralShareIfStillEligible: jest.requireActual('../services/service-report/cross-sell-tap').referralShareIfStillEligible,
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
const RECORD = { id: 'sr-1', customer_id: 'cust-1', structured_notes: {} };

// One fake database handle over a set of rows.
// records: the visit's service records, newest first (`record` = the usual
// one). invoices: the visit's invoices, as { scheduled_service_id |
// service_record_id, payer_id } rows. The fake applies the route's own
// filter (either link to the visit, payer set), so a wrong filter in the
// route fails here. Only the customers chain can be row-locked: a lock on a
// visit or an invoice row fails a payment (settlement takes the visit FOR
// UPDATE NOWAIT), so a route that asks for one throws here.
function fakeTables({ visit = VISIT, record = RECORD, records = record ? [record] : [], invoices = [] } = {}) {
  return (table) => {
    const name = String(table);
    if (name === 'customers') {
      const chain = { where: () => chain, forUpdate: () => chain, first: async () => ({ id: visit?.customer_id }) };
      return chain;
    }
    if (name === 'invoices') {
      let rows = invoices;
      const chain = {
        where: jest.fn((arg) => {
          if (typeof arg !== 'function') throw new Error('invoices: expected the grouped visit filter');
          const matchers = [];
          const group = {
            where: (criteria) => { matchers.push((r) => Object.entries(criteria).every(([k, v]) => r[k] === v)); return group; },
            orWhereIn: (col, values) => { matchers.push((r) => values.includes(r[col])); return group; },
          };
          arg(group);
          rows = rows.filter((r) => matchers.some((match) => match(r)));
          return chain;
        }),
        whereNotNull: jest.fn((col) => { rows = rows.filter((r) => r[col] != null); return chain; }),
        first: jest.fn(async () => rows[0]),
      };
      return chain;
    }
    if (name === 'service_records') {
      const chain = { where: () => chain, orderBy: () => chain, select: async () => records };
      return chain;
    }
    const chain = { where: () => chain, leftJoin: () => chain, first: async () => visit };
    return chain;
  };
}

// fixture: the rows the route reads before the tap. later: the rows the tap
// reads again inside its write (default: nothing changed). → the fake
// transaction handle, so a test can assert what rode it.
function install(fixture = {}, later = fixture) {
  mockDb.mockImplementation(fakeTables(fixture));
  const trx = jest.fn(fakeTables(later));
  mockDb.transaction = jest.fn(async (work) => work(trx));
  return trx;
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
    // The tap recomputes, locks and writes for this visit's customer only.
    linkCustomerId: 'cust-1',
  }));
});

test.each([
  ['gate off', {}, () => isEnabled.mockReturnValue(false)],
  ['visit not completed', { visit: { ...VISIT, status: 'en_route' } }, null],
  ['expired link', { visit: { ...VISIT, track_token_expires_at: new Date(Date.now() - 1000).toISOString() } }, null],
  // The tracker page itself stays up for such a link; the cards do not.
  ['a link with no expiry on record', { visit: { ...VISIT, track_token_expires_at: null } }, null],
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
  const trx = install({ record: { ...RECORD, structured_notes: { typedReportDelivery: 'internal_only' } } });
  expect((await drive('/:token/cross-sell', { metadata: {} })).statusCode).toBe(404);
  const res = await drive('/:token/referral-link');
  expect(res.statusCode).toBe(200);
  expect(referralShare.buildReferralShareForCustomer).toHaveBeenCalledWith('cust-1', { conn: trx });
});

// The tap files its request for the service record's customer, so a record
// of another customer id gives no offer on this visit's link.
test('a service record of another customer gives no offer; the referral still works', async () => {
  install({ record: { ...RECORD, customer_id: 'cust-other' } });
  expect((await drive('/:token/cross-sell', { metadata: {} })).statusCode).toBe(404);
  expect(tap.handleCrossSellTap).not.toHaveBeenCalled();
  expect((await drive('/:token/referral-link')).statusCode).toBe(200);
});

// Pre-push audit P0 (2026-11-22): the payer check read only the newest
// service record, so an invoice on an OLDER record of the same visit that
// bills a third party kept the cards.
test('an invoice on an older service record of the visit bills a third party → no taps', async () => {
  install({
    records: [RECORD, { ...RECORD, id: 'sr-0' }],
    invoices: [{ service_record_id: 'sr-0', payer_id: 9 }],
  });
  expect((await drive('/:token/cross-sell', { metadata: {} })).statusCode).toBe(404);
  expect((await drive('/:token/referral-link')).statusCode).toBe(404);
  expect(tap.handleCrossSellTap).not.toHaveBeenCalled();
  expect(referralShare.buildReferralShareForCustomer).not.toHaveBeenCalled();
});

// Pre-push audit P0 (2026-11-22): eligibility was read before the write
// only. Each tap now reads it again inside its write.
describe('the tap reads its eligibility again inside the write', () => {
  const CHANGES = [
    ['the link expired', { visit: { ...VISIT, track_token_expires_at: new Date(Date.now() - 1000).toISOString() } }],
    ['a service contact was added to the account', { visit: { ...VISIT, service_contact_name: 'Tenant Tina', service_contact_phone: '+19415550100' } }],
    ['the visit\'s invoice now bills a third party', { invoices: [{ scheduled_service_id: 'ss-1', payer_id: 9 }] }],
    ['the visit moved to another customer', { visit: { ...VISIT, customer_id: 'cust-2' }, record: { ...RECORD, customer_id: 'cust-2' } }],
  ];

  async function stillEligibleOf(later) {
    const trx = install({}, later);
    await drive('/:token/cross-sell', { metadata: {} });
    const { stillEligible, surface } = tap.handleCrossSellTap.mock.calls[0][0];
    return { trx, stillEligible, surface };
  }

  test('offer tap: nothing changed → still eligible, read on the tap\'s own transaction', async () => {
    const { trx, stillEligible, surface } = await stillEligibleOf({});
    const readsBefore = mockDb.mock.calls.length;
    expect(await stillEligible(trx)).toBe(true);
    expect(trx).toHaveBeenCalledWith('scheduled_services as s');
    expect(mockDb.mock.calls).toHaveLength(readsBefore);
    // What the shared tap answers when the second read says no.
    expect(surface.notFoundBody).toEqual({ error: 'Not found' });
  });

  test.each([
    ...CHANGES,
    ['the report stopped reaching the customer', { record: { ...RECORD, structured_notes: { typedReportDelivery: 'internal_only' } } }],
    ['a newer service record replaced the one the card was built from', { records: [{ ...RECORD, id: 'sr-2' }, RECORD] }],
  ])('offer tap: %s → no longer eligible', async (_label, later) => {
    const { trx, stillEligible } = await stillEligibleOf(later);
    expect(await stillEligible(trx)).toBe(false);
  });

  test('offer tap: the gate went off → no longer eligible', async () => {
    const { trx, stillEligible } = await stillEligibleOf({});
    isEnabled.mockReturnValue(false);
    expect(await stillEligible(trx)).toBe(false);
  });

  test('referral tap: nothing changed → enrolls on the transaction, after the customer row lock', async () => {
    const trx = install();
    const res = await drive('/:token/referral-link');
    expect(res.statusCode).toBe(200);
    expect(mockDb.transaction).toHaveBeenCalledTimes(1);
    expect(trx.mock.calls[0][0]).toBe('customers');
    expect(referralShare.buildReferralShareForCustomer).toHaveBeenCalledWith('cust-1', { conn: trx });
  });

  test.each(CHANGES)('referral tap: %s → 404, nobody enrolled', async (_label, later) => {
    install({}, later);
    const res = await drive('/:token/referral-link');
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: 'Not found' });
    expect(referralShare.buildReferralShareForCustomer).not.toHaveBeenCalled();
  });

  test('referral tap: the gate went off after the first read → 404, nobody enrolled', async () => {
    install();
    isEnabled.mockReset();
    isEnabled.mockReturnValueOnce(true).mockReturnValue(false);
    expect((await drive('/:token/referral-link')).statusCode).toBe(404);
    // The first read passed; the second read, inside the write, said no.
    expect(mockDb.transaction).toHaveBeenCalledTimes(1);
    expect(referralShare.buildReferralShareForCustomer).not.toHaveBeenCalled();
  });

  // The report's office-only state closes the offer, never the referral.
  test('referral tap: the report stopped reaching the customer → still enrolls', async () => {
    install({}, { record: { ...RECORD, structured_notes: { typedReportDelivery: 'internal_only' } } });
    expect((await drive('/:token/referral-link')).statusCode).toBe(200);
  });
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

// The flag sits on the service record and on the job. Pre-push audit P1
// (2026-11-22): a completed callback with no service record kept the cards.
test.each([
  ['flagged on the service record', { record: { ...RECORD, is_callback: true } }],
  ['flagged on the job, with a service record', { visit: { ...VISIT, is_callback: true } }],
  ['flagged on the job, with no service record', { visit: { ...VISIT, is_callback: true }, record: null }],
  // A visit can have more than one record; the flag can sit on an older one.
  ['flagged on an older service record only', { records: [RECORD, { ...RECORD, id: 'sr-0', is_callback: true }] }],
])('a callback visit gets neither card (the report\'s rule, with the re-service copy gate on): %s', async (_label, fixture) => {
  const prior = process.env.GATE_RESERVICE_REPORT_COPY;
  process.env.GATE_RESERVICE_REPORT_COPY = 'true';
  try {
    install(fixture);
    expect((await drive('/:token/cross-sell', { metadata: {} })).statusCode).toBe(404);
    expect((await drive('/:token/referral-link')).statusCode).toBe(404);
    expect(tap.handleCrossSellTap).not.toHaveBeenCalled();
    expect(referralShare.buildReferralShareForCustomer).not.toHaveBeenCalled();
  } finally {
    if (prior === undefined) delete process.env.GATE_RESERVICE_REPORT_COPY;
    else process.env.GATE_RESERVICE_REPORT_COPY = prior;
  }
});

// Pre-push audit P1 (2026-11-22): with GATE_REFERRAL_STEP2 on, the composer
// builds the customer's own offer line (and applies its yearly limit) only
// when it knows the customer.
test('the page builds the referral card for the visit\'s own customer', async () => {
  install();
  tap.buildCrossSellForServiceRecord.mockResolvedValue({ serviceKey: 'lawn_care' });
  referralShare.composeReferralCard.mockResolvedValue({ headline: 'h', cta: 'c', offer: 'o' });
  const cards = await router._test.trackCards(TOKEN);
  expect(referralShare.composeReferralCard).toHaveBeenCalledWith({ customerId: 'cust-1' });
  expect(cards).toEqual({ crossSell: { serviceKey: 'lawn_care' }, referral: { headline: 'h', cta: 'c', offer: 'o' } });
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
