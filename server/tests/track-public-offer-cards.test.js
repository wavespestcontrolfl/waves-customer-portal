// Tracker add-a-service + referral cards (GATE_DOC_CROSS_SELL, owner
// 2026-11-21). Each card is a link into the Waves app (owner 2026-11-22):
// the track link is texted to the visit's contacts, so nothing on the
// tracker acts and the app's sign-in decides who may. What this suite pins
// is the TRACKER's own decisions: when a completed visit's link shows the
// cards (a live link with an expiry on record; never for a payer, a service
// contact or a callback visit), that they are built for the visit's own
// customer, and that the track router gained no card write route.
const mockDb = jest.fn();
jest.mock('../models/db', () => mockDb);
jest.mock('../services/geocoder', () => ({ ensureCustomerGeocoded: jest.fn() }));
jest.mock('../services/photos', () => ({ getViewUrl: jest.fn() }));
jest.mock('../services/logger', () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn() }));
jest.mock('../config/feature-gates', () => ({
  ...jest.requireActual('../config/feature-gates'),
  isEnabled: jest.fn(),
}));
// The app's own answer to "which offer does this customer see"; its gate and
// composer are pinned in app-link-cards.test.js.
jest.mock('../services/property-recommendations', () => ({ appOfferForCustomer: jest.fn() }));
jest.mock('../services/referral-share', () => ({ composeReferralCard: jest.fn() }));

const logger = require('../services/logger');
const { isEnabled } = require('../config/feature-gates');
const { appOfferForCustomer } = require('../services/property-recommendations');
const referralShare = require('../services/referral-share');
const router = require('../routes/track-public');

const { trackCards } = router._test;
const TOKEN = 'a'.repeat(64);
const VISIT = {
  id: 'ss-1',
  customer_id: 'cust-1',
  status: 'completed',
  track_token_expires_at: new Date(Date.now() + 86400000).toISOString(),
  job_payer_id: null,
  customer_payer_id: null,
  customer_active: true,
  customer_deleted_at: null,
};
const RECORD = { id: 'sr-1', is_callback: false };
const APP_OFFER = {
  serviceKey: 'pest_control', label: 'Pest Control', mode: 'priced', relationship: 'add',
  option: { id: 'pest-quarterly', perVisit: 45 }, fingerprint: 'fp',
};
const CARD = { label: 'Pest Control', relationship: 'add', perApplication: 45 };
const REFERRAL = { headline: 'Know someone who could use Waves?', cta: 'Send My Referral Link' };

// One fake database handle over a set of rows.
// records: the visit's service records. invoices: the visit's invoices, as
// { scheduled_service_id | service_record_id, payer_id } rows. The fake
// applies the route's own filter (either link to the visit, payer set), so a
// wrong filter in the route fails here.
function install({ visit = VISIT, record = RECORD, records = record ? [record] : [], invoices = [] } = {}) {
  mockDb.mockImplementation((table) => {
    const name = String(table);
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
      const chain = { where: () => chain, select: async () => records };
      return chain;
    }
    if (name.startsWith('scheduled_services')) {
      const chain = { where: () => chain, leftJoin: () => chain, first: async () => visit };
      return chain;
    }
    throw new Error(`unexpected table ${name}`);
  });
  mockDb.transaction = jest.fn();
}

afterEach(() => { delete process.env.GATE_RESERVICE_REPORT_COPY; });

beforeEach(() => {
  jest.clearAllMocks();
  mockDb.mockReset();
  isEnabled.mockImplementation((key) => key === 'docCrossSell');
  appOfferForCustomer.mockResolvedValue(APP_OFFER);
  referralShare.composeReferralCard.mockResolvedValue(REFERRAL);
});

test('a completed visit on an account with no payer and no service contact shows both cards, built for its own customer', async () => {
  install();
  expect(await trackCards(TOKEN)).toEqual({ crossSell: CARD, referral: REFERRAL });
  expect(appOfferForCustomer).toHaveBeenCalledWith('cust-1', expect.anything());
  expect(referralShare.composeReferralCard).toHaveBeenCalledWith({ customerId: 'cust-1' });
  // A read: nothing is locked or written.
  expect(mockDb.transaction).not.toHaveBeenCalled();
});

test.each([
  ['gate off', {}, () => isEnabled.mockReturnValue(false)],
  ['no visit for the token', { visit: null }, null],
  ['visit not completed', { visit: { ...VISIT, status: 'en_route' } }, null],
  ['expired link', { visit: { ...VISIT, track_token_expires_at: new Date(Date.now() - 1000).toISOString() } }, null],
  // The tracker page itself stays up for such a link; the cards do not.
  ['a link with no expiry on record', { visit: { ...VISIT, track_token_expires_at: null } }, null],
  // The cards open the Waves app. A cancelled customer's app has no Refer tab
  // and no offer, and any other inactive customer cannot sign in.
  ['a customer who has since cancelled', { visit: { ...VISIT, customer_active: false } }, null],
  ['a customer with no active flag on record', { visit: { ...VISIT, customer_active: null } }, null],
  ['a removed customer', { visit: { ...VISIT, customer_deleted_at: '2026-11-01T00:00:00Z' } }, null],
  ['a service contact also gets this link', { visit: { ...VISIT, service_contact_name: 'Tenant Tina', service_contact_phone: '+19415550100' } }, null],
  ['third-party payer on the job', { visit: { ...VISIT, job_payer_id: 7 } }, null],
  ['third-party payer on the account', { visit: { ...VISIT, customer_payer_id: 7 } }, null],
  // An invoice can bill a third party with no payer on the job or the account.
  ['the visit\'s invoice bills a third party (linked by the visit)', { invoices: [{ scheduled_service_id: 'ss-1', payer_id: 9 }] }, null],
  ['the visit\'s invoice bills a third party (linked by the service record)', { invoices: [{ service_record_id: 'sr-1', payer_id: 9 }] }, null],
  ['an older invoice of the visit bills a third party', { invoices: [{ scheduled_service_id: 'ss-1', payer_id: null }, { scheduled_service_id: 'ss-1', payer_id: 9 }] }, null],
  // The payer check reads every service record of the visit, not only one.
  ['an invoice on another service record of the visit bills a third party', {
    records: [RECORD, { ...RECORD, id: 'sr-0' }], invoices: [{ service_record_id: 'sr-0', payer_id: 9 }],
  }, null],
  ['a callback visit (flagged on the job)', { visit: { ...VISIT, is_callback: true } }, () => { process.env.GATE_RESERVICE_REPORT_COPY = 'true'; }],
  ['a callback visit (flagged on any service record)', {
    records: [RECORD, { id: 'sr-0', is_callback: true }],
  }, () => { process.env.GATE_RESERVICE_REPORT_COPY = 'true'; }],
])('%s → no cards, and the offer is never built', async (_label, fixture, arrange) => {
  install(fixture);
  if (arrange) arrange();
  expect(await trackCards(TOKEN)).toEqual({});
  expect(appOfferForCustomer).not.toHaveBeenCalled();
  expect(referralShare.composeReferralCard).not.toHaveBeenCalled();
});

test('a malformed token never reaches the database', async () => {
  install();
  expect(await trackCards('not-a-token')).toEqual({});
  expect(mockDb).not.toHaveBeenCalled();
});

test('invoices that bill the customer, or belong to another visit, keep the cards', async () => {
  install({ invoices: [
    { scheduled_service_id: 'ss-1', payer_id: null },
    { scheduled_service_id: 'ss-other', payer_id: 9 },
    { service_record_id: 'sr-other', payer_id: 9 },
  ] });
  expect(await trackCards(TOKEN)).toEqual({ crossSell: CARD, referral: REFERRAL });
});

test('a completed visit with no service record still shows the cards', async () => {
  install({ record: null });
  expect(await trackCards(TOKEN)).toEqual({ crossSell: CARD, referral: REFERRAL });
});

test('a callback flag does nothing while the re-service gate is off', async () => {
  install({ visit: { ...VISIT, is_callback: true } });
  expect(await trackCards(TOKEN)).toEqual({ crossSell: CARD, referral: REFERRAL });
});

test('the app shows this customer no offer → the referral card alone', async () => {
  install();
  appOfferForCustomer.mockResolvedValue(null);
  expect(await trackCards(TOKEN)).toEqual({ referral: REFERRAL });
});

// Best-effort: a card failure never fails the tracker, and the log never
// carries the error text (Knex puts the bound track token in it).
test('a failed card build → no cards and a code-only log', async () => {
  install();
  appOfferForCustomer.mockRejectedValue(Object.assign(new Error(`where track_view_token = ${TOKEN}`), { code: '57014' }));
  expect(await trackCards(TOKEN)).toEqual({});
  expect(logger.warn).toHaveBeenCalledTimes(1);
  expect(logger.warn.mock.calls[0][0]).toContain('code=57014');
  expect(logger.warn.mock.calls[0][0]).not.toContain(TOKEN);
});

// Owner 2026-11-22: a track link reaches tenants, managers and anyone it is
// forwarded to, so a card must never file a request, mint an estimate or
// enroll a promoter from it. The tracker keeps its two bounded writes
// (/:token/stops-ahead and /:token/view) and gains none.
test('the track router has no card write route', () => {
  const writes = router.stack
    .filter((l) => l.route)
    .flatMap((l) => Object.keys(l.route.methods).filter((m) => m !== 'get').map((m) => `${m.toUpperCase()} ${l.route.path}`));
  expect(writes.filter((w) => /cross-sell|referral/i.test(w))).toEqual([]);
  expect(writes).toHaveLength(2);
});
