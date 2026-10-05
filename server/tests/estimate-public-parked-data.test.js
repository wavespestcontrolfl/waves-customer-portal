process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

// B18 park: GET /:token/data reports the page's EXISTING review-before-booking state (cta.reviewBeforeBooking with
// reviewReason 'contact_review', canAccept false) for an open, unlinked estimate whose lone phone candidate it
// contradicts - and says nothing about the other customer. Every other estimate is exactly as before.

jest.mock('../models/db', () => {
  const mock = jest.fn();
  mock.fn = { now: jest.fn(() => 'NOW') };
  mock.raw = jest.fn((sql) => sql);
  return mock;
});
jest.mock('../config/feature-gates', () => ({
  ...jest.requireActual('../config/feature-gates'),
  isEnabled: jest.fn(() => false),
  gateEnvValue: jest.fn(() => false),
  gates: {},
}));
jest.mock('../services/property-lookup/lookup-cache', () => ({ getCachedLookup: jest.fn().mockResolvedValue(null) }));
jest.mock('../services/estimate-membership-context', () => ({
  buildEstimateMembershipContext: jest.fn().mockResolvedValue(null),
  publicMembershipView: jest.fn((snapshot) => snapshot ?? null),
}));
jest.mock('../services/estimate-deposits', () => ({
  ensureDepositSatisfied: jest.fn(),
  resolveDepositPolicyForEstimate: jest.fn().mockResolvedValue({ enforced: false, required: false, slotRequired: false }),
  computeDepositAmount: jest.fn(() => 0),
  pendingDepositCredit: jest.fn(),
  consumeDepositCredit: jest.fn(),
  refundUnconsumedDeposits: jest.fn(),
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
// The park side effects (deduped office alert + server-side hold release) are asserted at their seams.
const mockRaiseAdminAlert = jest.fn(async () => ({ id: 'alert-1' }));
jest.mock('../services/admin-alert-compose', () => ({
  ...jest.requireActual('../services/admin-alert-compose'),
  raiseAdminAlert: (...a) => mockRaiseAdminAlert(...a),
}));
// The episode (reopen) raise is asserted at its seam too.
const mockRaiseWithReopen = jest.fn(async () => ({ id: 'alert-1', rang: true }));
jest.mock('../services/admin-alert-episodes', () => ({
  ...jest.requireActual('../services/admin-alert-episodes'),
  raiseAdminAlertWithReopen: (...a) => mockRaiseWithReopen(...a),
}));
const mockReleaseEstimateHolds = jest.fn(async () => ({ released: 1 }));
jest.mock('../services/slot-reservation', () => ({
  ...jest.requireActual('../services/slot-reservation'),
  releaseEstimateHolds: (...a) => mockReleaseEstimateHolds(...a),
}));

const express = require('express');
const db = require('../models/db');
const estimatePublicRouter = require('../routes/estimate-public');

let estimateRow;
let phoneCandidates;
function chainFor(result) {
  const chain = {
    where: jest.fn(() => chain), whereIn: jest.fn(() => chain), whereNull: jest.fn(() => chain), whereRaw: jest.fn(() => chain),
    andWhere: jest.fn(() => chain), orWhere: jest.fn(() => chain), orWhereRaw: jest.fn(() => chain), leftJoin: jest.fn(() => chain),
    select: jest.fn(() => chain), orderBy: jest.fn(() => chain), orderByRaw: jest.fn(() => chain),
    first: jest.fn().mockResolvedValue(result),
    forUpdate: jest.fn(() => chain), forShare: jest.fn(() => chain), noWait: jest.fn(() => chain),
    update: jest.fn().mockResolvedValue(1),
    insert: jest.fn().mockResolvedValue([1]),
  };
  return chain;
}
// A grouped estimate's accepted sibling (the accept's - and the shared owner resolver's - lookup: same group, another
// estimate, customer_id set). null = no accepted sibling.
let siblingEstimate = null;
let priorNotification = null; // the standing park alert row (notifications), if any
db.mockImplementation((table) => {
  if (table === 'notifications') return chainFor(priorNotification);
  if (table === 'customers') {
    // The phone sweep awaits the chain itself (a list); other customers reads end in .first().
    const c = chainFor(siblingEstimate ? { id: siblingEstimate.customer_id } : null);
    c.then = (resolve, reject) => Promise.resolve(phoneCandidates).then(resolve, reject);
    return c;
  }
  const chain = chainFor(table === 'estimates' ? estimateRow : undefined);
  if (table === 'estimates') {
    // `.whereNot(...)` marks the sibling lookup (the estimate's own reads never use it).
    chain.whereNot = jest.fn(() => { chain.first = jest.fn().mockResolvedValue(siblingEstimate); return chain; });
    chain.whereNotNull = jest.fn(() => chain);
  }
  return chain;
});

db.transaction = jest.fn(async (fn) => fn(db)); // the hold release's short locked transaction

const BOB = { id: 'cust-bob', first_name: 'Bob', last_name: 'Example', phone: '(941) 555-0123', email: 'bob@example.com', address_line1: '9 Other St' };
let tokenSeq = 0;
function makeEstimate(overrides = {}) {
  tokenSeq += 1;
  return {
    id: `est-parked-data-${tokenSeq}`,
    token: `parkeddatatoken${tokenSeq}`,
    status: 'sent', sent_at: '2026-09-01T00:00:00.000Z', viewed_at: null,
    expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    customer_id: null,
    customer_name: 'Pat Tester', customer_phone: '(941) 555-0123', customer_email: 'pat@example.com',
    address: '123 Palm Ave, Bradenton, FL 34203',
    satellite_url: null, waveguard_tier: 'Bronze', bill_by_invoice: false,
    monthly_total: 88, annual_total: 1056, onetime_total: 0,
    estimate_data: {
      sendSnapshot: { pricingBundle: { frequencies: [{ key: 'quarterly', label: 'Quarterly', monthly: 88, annual: 1056 }], waveGuardTier: 'Bronze', source: 'send_snapshot_fixture' } },
      result: { recurring: { discount: 0, services: [{ name: 'Pest Control', mo: 88 }] }, oneTime: { items: [], membershipFee: 0 } },
    },
    ...overrides,
  };
}

async function getData(estimate, { headers = {}, query = '' } = {}) {
  estimateRow = estimate;
  const app = express();
  app.use(express.json());
  app.use('/estimates', estimatePublicRouter);
  app.use((err, _req, res, _next) => { res.status(err.status || 500).json({ error: err.message }); });
  const server = app.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/estimates/${estimate.token}/data${query}`, { headers });
    return { status: res.status, text: await res.text() };
  } finally {
    server.close();
  }
}
const ctaOf = (r) => JSON.parse(r.text).cta;

beforeEach(() => { priorNotification = null; process.env.ALERT_EPISODES = 'off'; mockRaiseWithReopen.mockClear(); phoneCandidates = []; siblingEstimate = null; mockRaiseAdminAlert.mockClear(); mockReleaseEstimateHolds.mockClear(); });

test('a contradicted lone phone candidate: the page gets the existing review state (no accept, no card step) and no word about the other customer', async () => {
  phoneCandidates = [BOB];
  const res = await getData(makeEstimate());
  expect(res.status).toBe(200);
  expect(ctaOf(res)).toMatchObject({ canAccept: false, reviewBeforeBooking: true, reviewReason: 'contact_review', terminalState: null });
  expect(res.text).not.toContain('cust-bob');
  expect(res.text).not.toContain('Bob Example');
});

test.each([
  ['the candidate agrees on email', () => ({ phoneCandidates: [{ ...BOB, email: 'pat@example.com' }], estimate: {} })],
  ['the candidate agrees on address', () => ({ phoneCandidates: [{ ...BOB, address_line1: '123 Palm Ave' }], estimate: {} })],
  ['no phone candidate', () => ({ phoneCandidates: [], estimate: {} })],
  ['several candidates', () => ({ phoneCandidates: [BOB, { ...BOB, id: 'cust-2', address_line1: '55 Pine Ct' }], estimate: {} })],
  ['the estimate is already linked to a customer', () => ({ phoneCandidates: [BOB], estimate: { customer_id: 'cust-9' } })],
  ['the estimate has no phone', () => ({ phoneCandidates: [BOB], estimate: { customer_phone: null } })],
])('control: %s - the page is as before (accept stays available)', async (_label, build) => {
  const { phoneCandidates: candidates, estimate } = build();
  phoneCandidates = candidates;
  const res = await getData(makeEstimate(estimate));
  expect(res.status).toBe(200);
  expect(ctaOf(res)).toMatchObject({ canAccept: true, reviewBeforeBooking: false, reviewReason: null });
});

// The P0: a parked estimate's payload must not be derived from the rejected customer. Every match reader sees NO
// match for it, so the policy / billing fields are exactly those of an estimate with no candidate at all.
describe('parked /data derives nothing from the rejected customer', () => {
  const RICH_BOB = {
    ...BOB,
    billing_mode: 'monthly_membership',
    waveguard_tier: 'Gold',
    monthly_rate: 79,
    autopay_enabled: true,
    autopay_paused_until: '2099-01-01',
    autopay_opt_out: true,
    pipeline_stage: 'active_customer',
    active: true,
  };
  const neutralFields = (res) => {
    const body = JSON.parse(res.text);
    return {
      monthlyBilled: body.cta.monthlyBilled,
      recurringCardPolicy: body.recurringCardPolicy ?? null,
      cardHoldPolicy: body.cardHoldPolicy ?? null,
      depositPolicy: body.depositPolicy ?? null,
      membership: body.estimate.membership ?? null,
    };
  };

  test('a rejected candidate with monthly billing, a saved method, paused Auto Pay and an opt-out produces the same policy/billing fields as no candidate at all', async () => {
    phoneCandidates = [];
    const none = await getData(makeEstimate());
    phoneCandidates = [RICH_BOB];
    const parkedRes = await getData(makeEstimate());
    expect(ctaOf(parkedRes)).toMatchObject({ reviewBeforeBooking: true, reviewReason: 'contact_review' });
    expect(neutralFields(parkedRes)).toEqual(neutralFields(none));
    expect(parkedRes.text).not.toContain('Gold');
    expect(parkedRes.text).not.toContain('cust-bob');
  });

  test('control (the fixture is sensitive): the SAME rich candidate that AGREES on email is matched, and monthly billing then shows', async () => {
    phoneCandidates = [{ ...RICH_BOB, email: 'pat@example.com' }];
    const matched = await getData(makeEstimate());
    expect(ctaOf(matched).reviewBeforeBooking).toBe(false);
    phoneCandidates = [];
    const none = await getData(makeEstimate());
    expect(neutralFields(matched)).not.toEqual(neutralFields(none));
  });
});

describe('GET /data on a parked estimate runs the park side effects (the page promises office follow-up)', () => {
  test('a parked customer view files the deduped alert once per view request and returns any live hold\'s capacity; controls do not', async () => {
    phoneCandidates = [BOB];
    const est = makeEstimate();
    const res = await getData(est);
    expect(ctaOf(res)).toMatchObject({ reviewReason: 'contact_review' });
    expect(mockRaiseAdminAlert).toHaveBeenCalledTimes(1);
    expect(mockRaiseAdminAlert.mock.calls[0][1]).toMatchObject({ area: 'Customers', severity: 'needs-you', subject: { type: 'estimate', id: est.id } });
    expect(mockRaiseAdminAlert.mock.calls[0][2]).toMatchObject({ dedupeKey: `accept-phone-contradicted:${est.id}` });
    expect(mockReleaseEstimateHolds).toHaveBeenCalledWith(expect.objectContaining({ estimateId: est.id }));
    mockRaiseAdminAlert.mockClear(); mockReleaseEstimateHolds.mockClear();
    phoneCandidates = [];
    await getData(makeEstimate());
    phoneCandidates = [BOB];
    await getData(makeEstimate({ customer_id: 'cust-9' }));
    expect(mockRaiseAdminAlert).not.toHaveBeenCalled();
    expect(mockReleaseEstimateHolds).not.toHaveBeenCalled();
  });

  test('a failing alert or release never breaks the page', async () => {
    phoneCandidates = [BOB];
    mockRaiseAdminAlert.mockRejectedValueOnce(new Error('alerts down'));
    mockReleaseEstimateHolds.mockRejectedValueOnce(new Error('db down'));
    const res = await getData(makeEstimate());
    expect(res.status).toBe(200);
    expect(ctaOf(res)).toMatchObject({ reviewBeforeBooking: true, reviewReason: 'contact_review' });
  });
});

describe('grouped sibling (r8): an unlinked estimate whose group already has an accepted customer is never parked', () => {
  const { estimatePublicBlockingState } = estimatePublicRouter;
  const GROUP = 'grp-1';
  const SIBLING = { id: 'est-sib', estimate_group_id: GROUP, customer_id: 'cust-bob', accepted_at: '2026-09-01T00:00:00.000Z' };
  // The second property: unlinked, a different email AND address from the group's customer, who alone holds the phone.
  const grouped = () => makeEstimate({ estimate_group_id: GROUP });

  test('/data keeps the accept available, files no alert and releases no hold; and the matcher shows what main showed (the lone candidate)', async () => {
    phoneCandidates = [BOB];
    siblingEstimate = SIBLING;
    const est = grouped();
    const res = await getData(est);
    expect(ctaOf(res)).toMatchObject({ canAccept: true, reviewBeforeBooking: false, reviewReason: null });
    expect(mockRaiseAdminAlert).not.toHaveBeenCalled();
    expect(mockReleaseEstimateHolds).not.toHaveBeenCalled();
    // Every reader of the matcher (billing / card policy) sees main's match, not the neutral null a park gives.
    await expect(estimatePublicRouter.matchAcceptCustomerByPhone(grouped())).resolves.toMatchObject({ match: { id: 'cust-bob' }, candidateCount: 1 });
  });

  test('the shared blocking-state helper (every surface: intent routes, slot routes, accept preflight, reminder) reports nothing, fresh or cached', async () => {
    phoneCandidates = [BOB];
    siblingEstimate = SIBLING;
    expect(await estimatePublicBlockingState(grouped())).toBeNull();
    expect(await estimatePublicBlockingState(grouped(), { fresh: true })).toBeNull();
  });

  test('the accept transaction\'s own phone match (it runs only after its sibling lookup found no owner) is NOT exempted', async () => {
    phoneCandidates = [BOB];
    siblingEstimate = SIBLING;
    const verdict = await estimatePublicRouter.matchAcceptCustomerByPhone(grouped(), db, { authoritative: true, afterSiblingResolution: true });
    expect(verdict).toMatchObject({ match: null, contradicted: true, rejectedCustomerId: 'cust-bob' });
  });

  test('control: the same estimate with no accepted sibling is parked', async () => {
    phoneCandidates = [BOB];
    const est = grouped();
    expect(await estimatePublicBlockingState(est)).toMatchObject({ state: 'contact_review', rejectedCustomerId: 'cust-bob' });
    const res = await getData(grouped());
    expect(ctaOf(res)).toMatchObject({ canAccept: false, reviewBeforeBooking: true, reviewReason: 'contact_review' });
  });

  test('control: a sibling accepted for a DIFFERENT group does not exempt it (the owner lookup is scoped to this group)', async () => {
    phoneCandidates = [BOB];
    siblingEstimate = null; // the lookup is `where estimate_group_id = <this group>`: another group\'s sibling is simply not found
    expect(await estimatePublicBlockingState(makeEstimate({ estimate_group_id: 'grp-2' }))).toMatchObject({ state: 'contact_review' });
  });

  test('an unreadable owner lookup is not guessed: the matcher throws (callers decide; /data does not park, the intent routes 500)', async () => {
    phoneCandidates = [BOB];
    const original = db.getMockImplementation();
    db.mockImplementation((table) => {
      if (table === 'estimates') return { where: () => ({ whereNot: () => { throw new Error('estimates read failed'); } }), first: jest.fn() };
      return original(table);
    });
    try {
      // customer_phone_typed present (null = an office phone): the matcher reads no extra column, so the one
      // estimates read this fake fails is the owner lookup under test.
      await expect(estimatePublicRouter.matchAcceptCustomerByPhone({ ...grouped(), customer_phone_typed: null })).rejects.toThrow('estimates read failed');
    } finally { db.mockImplementation(original); }
  });
});

describe('the composer is a pure read unless a caller opts in (the Intelligence Bar projection must not alert or delete a hold)', () => {
  const { composeEstimateDataPayload } = estimatePublicRouter;
  test('an IB-style projection of a parked estimate shows the review state but raises NO alert and releases NO hold; the customer /data does both once', async () => {
    phoneCandidates = [BOB];
    db.transaction.mockClear();
    const est = makeEstimate();
    estimateRow = est;
    // Exactly the Intelligence Bar's call (services/intelligence-bar/estimate-detail.js pageProjection).
    const payload = await composeEstimateDataPayload(est, { adminDraftPreview: false, isPdfRenderPass: false, docRenderPin: null });
    expect(payload.cta).toMatchObject({ reviewBeforeBooking: true, reviewReason: 'contact_review' });
    expect(mockRaiseAdminAlert).not.toHaveBeenCalled();
    expect(mockReleaseEstimateHolds).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
    // The public customer GET /data (the one opt-in) does both, once.
    await getData(makeEstimate());
    expect(mockRaiseAdminAlert).toHaveBeenCalledTimes(1);
    expect(mockReleaseEstimateHolds).toHaveBeenCalledTimes(1);
    // The explicit opt-in is what does it.
    mockRaiseAdminAlert.mockClear(); mockReleaseEstimateHolds.mockClear();
    await composeEstimateDataPayload(est, { runParkSideEffects: true });
    expect(mockRaiseAdminAlert).toHaveBeenCalledTimes(1);
    expect(mockReleaseEstimateHolds).toHaveBeenCalledTimes(1);
  });
});

describe('park side effects run only for a request the view counter treats as a real customer view (r7)', () => {
  const jwt = require('jsonwebtoken');
  const config = require('../config');
  const sentAt = '2026-09-01T00:00:00.000Z';
  const adminMarker = () => `waves_admin=${encodeURIComponent(jwt.sign({ kind: 'admin_marker' }, config.jwt.secret))}`;

  test('an admin-marked read and a bot read show the review state but file no alert and release no hold; a plain customer view does both', async () => {
    phoneCandidates = [BOB];
    const staff = await getData(makeEstimate({ sent_at: sentAt }), { headers: { Cookie: adminMarker() } });
    expect(ctaOf(staff)).toMatchObject({ reviewReason: 'contact_review' });
    const bot = await getData(makeEstimate({ sent_at: sentAt }), { headers: { 'User-Agent': 'Googlebot/2.1' } });
    expect(ctaOf(bot)).toMatchObject({ reviewReason: 'contact_review' });
    expect(mockRaiseAdminAlert).not.toHaveBeenCalled();
    expect(mockReleaseEstimateHolds).not.toHaveBeenCalled();
    await getData(makeEstimate({ sent_at: sentAt }), { headers: { 'User-Agent': 'Mozilla/5.0 (iPhone)' } });
    expect(mockRaiseAdminAlert).toHaveBeenCalledTimes(1);
    expect(mockReleaseEstimateHolds).toHaveBeenCalledTimes(1);
  });

  test('the page\'s own internal refresh (?refresh=1 of a real customer) still runs them (deduped and idempotent): a park that arises mid-sitting is covered', async () => {
    phoneCandidates = [BOB];
    await getData(makeEstimate({ sent_at: sentAt, viewed_at: sentAt }), { headers: { 'User-Agent': 'Mozilla/5.0 (iPhone)' }, query: '?refresh=1' });
    expect(mockRaiseAdminAlert).toHaveBeenCalledTimes(1);
    expect(mockReleaseEstimateHolds).toHaveBeenCalledTimes(1);
  });
});

describe('the one helper decides trenching vs quote_required (r7: no ordering dependence)', () => {
  const { estimatePublicBlockingState } = estimatePublicRouter;
  const trenchingData = { result: { recurring: { services: [] }, oneTime: { items: [{ service: 'trenching', name: 'Termite Trenching', price: 2210 }], specItems: [] } } };
  test('trenching-only is termite_trenching_review; trenching AND quote-required is quote_required; a pricing failure still reports trenching, but never un-parks a parked estimate', async () => {
    const trench = makeEstimate({ estimate_data: trenchingData });
    expect((await estimatePublicBlockingState(trench, { estData: trenchingData }))?.state).toBe('termite_trenching_review');
    const both = { ...trenchingData, proposal: { enabled: true } };
    expect((await estimatePublicBlockingState(makeEstimate({ estimate_data: both }), { estData: both }))?.state).toBe('quote_required');
  });

  test('a pricing failure during the lazy quote lookup still reports trenching (the slot routes used to refuse it with no pricing work)', async () => {
    // The estimate row's data cannot be read by the pricing build (the caller supplied the parsed data separately).
    const broken = makeEstimate();
    Object.defineProperty(broken, 'estimate_data', { get() { throw new Error('pricing input unreadable'); } });
    expect((await estimatePublicBlockingState(broken, { estData: trenchingData }))?.state).toBe('termite_trenching_review');
    phoneCandidates = [BOB];
    await expect(estimatePublicBlockingState(broken, { estData: {} })).rejects.toThrow('pricing input unreadable');
  });
});

describe('suppressionGated: a suppression-shaped estimate is never priced for the blocking state (r9 follow-up)', () => {
  const { estimatePublicBlockingState } = estimatePublicRouter;
  test('parked + suppressionGated -> contact_review without any pricing work; without the flag the same lookup would need (and fail on) pricing', async () => {
    phoneCandidates = [BOB];
    const broken = makeEstimate();
    Object.defineProperty(broken, 'estimate_data', { get() { throw new Error('pricing input unreadable'); } });
    expect(await estimatePublicBlockingState(broken, { estData: {}, suppressionGated: true })).toMatchObject({ state: 'contact_review', rejectedCustomerId: 'cust-bob' });
    await expect(estimatePublicBlockingState(broken, { estData: {} })).rejects.toThrow('pricing input unreadable');
    // Not parked: nothing to report (and still no pricing).
    phoneCandidates = [];
    expect(await estimatePublicBlockingState(broken, { estData: {}, suppressionGated: true, fresh: true })).toBeNull();
  });
});

describe('the park alert is an episode (r11): a recurrence after Done / auto-clear reopens and rings; a standing open row is never re-rung', () => {
  const { refuseParkedWrite } = estimatePublicRouter;
  beforeEach(() => { delete process.env.ALERT_EPISODES; }); // ships live; the kill switch is covered below
  afterEach(() => { process.env.ALERT_EPISODES = 'off'; });
  const raised = () => mockRaiseWithReopen.mock.calls.map(([category, headline, why, opts]) => ({ category, headline, why, opts }));

  test('first raise: through raiseAdminAlertWithReopen, versioned by the rejected customer id, refreshing, with the same key / detail / metadata', async () => {
    const est = makeEstimate();
    await refuseParkedWrite(est, 'cust-bob');
    expect(mockRaiseAdminAlert).not.toHaveBeenCalled();
    expect(raised()).toHaveLength(1);
    const { category, headline, why, opts } = raised()[0];
    expect(category).toBe('estimate');
    expect(headline).toMatch(/estimate phone$/);
    expect(why).toBe('The phone on their estimate is another customer\u2019s, so self-booking is held.');
    expect(opts).toMatchObject({ bell: true, dedupeKey: `accept-phone-contradicted:${est.id}`, dedupeVersion: 'rejected:cust-bob::e0', refreshOnDedupe: true, link: `/admin/estimates?estimateId=${est.id}` });
    expect(opts.metadata).toMatchObject({ estimateId: est.id, rejectedCustomerId: 'cust-bob', parkEpisode: 0, area: 'Customers', severity: 'needs-you', doneWhen: 'phone_corrected' });
    expect(opts.detail).toContain('customer id cust-bob');
  });

  test('a standing OPEN row keeps its episode: every later attempt sends the SAME version (a silent dedupe: no re-ring)', async () => {
    priorNotification = { metadata: { parkEpisode: 2 }, done_at: null };
    await refuseParkedWrite(makeEstimate(), 'cust-bob');
    await refuseParkedWrite(makeEstimate(), 'cust-bob');
    expect(raised().map((r) => r.opts.dedupeVersion)).toEqual(['rejected:cust-bob::e2', 'rejected:cust-bob::e2']);
    expect(raised().every((r) => r.opts.metadata.parkEpisode === 2)).toBe(true);
  });

  test('a row a person COMPLETED (Done) while the estimate is still parked: the next attempt is the next episode (new version -> refresh + ring)', async () => {
    priorNotification = { metadata: { parkEpisode: 0, dedupeVersion: 'rejected:cust-bob::e0' }, done_at: '2026-10-03T12:00:00.000Z' };
    await refuseParkedWrite(makeEstimate(), 'cust-bob');
    expect(raised()[0].opts).toMatchObject({ dedupeVersion: 'rejected:cust-bob::e1', metadata: expect.objectContaining({ parkEpisode: 1 }) });
  });

  test('an AUTO-CLEARED row is the helper\'s own reopen (it bumps its recurrence generation): this call does not also bump the episode', async () => {
    priorNotification = { metadata: { parkEpisode: 0, autoCleared: true }, done_at: '2026-10-03T12:00:00.000Z' };
    await refuseParkedWrite(makeEstimate(), 'cust-bob');
    expect(raised()[0].opts.dedupeVersion).toBe('rejected:cust-bob::e0');
  });

  test('the phone later changed to a DIFFERENT customer\'s number is a new version', async () => {
    priorNotification = { metadata: { parkEpisode: 0 }, done_at: null };
    await refuseParkedWrite(makeEstimate(), 'cust-bob');
    await refuseParkedWrite(makeEstimate(), 'cust-other');
    const versions = raised().map((r) => r.opts.dedupeVersion);
    expect(versions).toEqual(['rejected:cust-bob::e0', 'rejected:cust-other::e0']);
    expect(new Set(versions).size).toBe(2);
  });

  test('ALERT_EPISODES killed: the plain deduped raise it always had (no reopen helper)', async () => {
    process.env.ALERT_EPISODES = 'off';
    await refuseParkedWrite(makeEstimate(), 'cust-bob');
    expect(mockRaiseWithReopen).not.toHaveBeenCalled();
    expect(mockRaiseAdminAlert).toHaveBeenCalledTimes(1);
    expect(mockRaiseAdminAlert.mock.calls[0][2]).toMatchObject({ dedupeVersion: 'v1' });
  });

  test('a failed raise is retried once and never throws', async () => {
    mockRaiseWithReopen.mockRejectedValueOnce(new Error('alerts down'));
    await expect(refuseParkedWrite(makeEstimate(), 'cust-bob')).resolves.toMatchObject({ code: 'ACCEPT_NEEDS_OFFICE_REVIEW' });
    expect(mockRaiseWithReopen).toHaveBeenCalledTimes(2);
  });
});

describe('the bulk hold release is judged on the estimate as it is now, under the estimate row lock (r6 P2)', () => {
  const { refuseParkedWrite } = estimatePublicRouter;
  const estimateChains = () => db.mock.results.map((r, i) => ({ table: db.mock.calls[i][0], chain: r.value })).filter((c) => c.table === 'estimates');
  beforeEach(() => { db.transaction.mockClear(); db.mockClear?.(); });

  test('still parked: one short transaction locks the estimate row FOR UPDATE first, re-judges fresh on the locked row, and deletes the holds on that transaction', async () => {
    phoneCandidates = [BOB];
    const est = makeEstimate();
    estimateRow = est;
    await refuseParkedWrite(est, 'cust-bob');
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(estimateChains().some((c) => c.chain.forUpdate.mock.calls.length > 0)).toBe(true);
    expect(mockReleaseEstimateHolds).toHaveBeenCalledTimes(1);
    expect(mockReleaseEstimateHolds).toHaveBeenCalledWith({ estimateId: est.id, database: db });
    // The alert is filed outside that transaction (a failing release never blocks it, and vice versa).
    expect(mockRaiseAdminAlert).toHaveBeenCalledTimes(1);
  });

  test('a Bermuda-suppression estimate (gate off) is rechecked with suppressionGated, so its hold is released without any pricing work', async () => {
    const mapper = require('../services/pricing-engine/v1-legacy-mapper');
    const gates = require('../config/feature-gates');
    const carries = jest.spyOn(mapper, 'estimateDataCarriesBermudaSuppression').mockReturnValue(true);
    const prevGate = process.env.GATE_BERMUDA_SUPPRESSION;
    delete process.env.GATE_BERMUDA_SUPPRESSION;
    try {
      expect(gates.gateEnvValue('GATE_BERMUDA_SUPPRESSION')).toBeFalsy();
      phoneCandidates = [BOB];
      const est = makeEstimate();
      estimateRow = est;
      await refuseParkedWrite(est, 'cust-bob');
      expect(carries).toHaveBeenCalled();
      expect(mockReleaseEstimateHolds).toHaveBeenCalledTimes(1);
      // The recheck passes the suppression flag (source pin: the release must not take the pricing path for it).
      const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'routes', 'estimate-public.js'), 'utf8');
      const fn = src.slice(src.indexOf('async function releaseHoldsIfStillParked'), src.indexOf('async function refuseParkedWrite'));
      expect(fn).toMatch(/estimatePublicBlockingState\(row, \{ database: trx, lock: true, fresh: true, suppressionGated \}\)/);
    } finally {
      carries.mockRestore();
      if (prevGate === undefined) delete process.env.GATE_BERMUDA_SUPPRESSION; else process.env.GATE_BERMUDA_SUPPRESSION = prevGate;
    }
  });

  test('the estimate was corrected after the unlocked read said parked (phone fixed): NO hold is deleted', async () => {
    const stale = makeEstimate();
    estimateRow = { ...stale, customer_phone: '(941) 555-0999' }; // staff fixed the phone; the locked re-read sees it
    phoneCandidates = []; // ... and nobody else owns that number
    await refuseParkedWrite(stale, 'cust-bob');
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(mockReleaseEstimateHolds).not.toHaveBeenCalled();
  });

  test('the estimate was linked to a customer after the unlocked read: NO hold is deleted', async () => {
    phoneCandidates = [BOB];
    const stale = makeEstimate();
    estimateRow = { ...stale, customer_id: 'cust-9' };
    await refuseParkedWrite(stale, 'cust-bob');
    expect(mockReleaseEstimateHolds).not.toHaveBeenCalled();
  });

  test('the estimate row is gone, or the customer row is busy (55P03): nothing is deleted and nothing throws', async () => {
    const est = makeEstimate();
    estimateRow = null;
    await expect(refuseParkedWrite(est, 'cust-bob')).resolves.toMatchObject({ code: 'ACCEPT_NEEDS_OFFICE_REVIEW' });
    expect(mockReleaseEstimateHolds).not.toHaveBeenCalled();
    estimateRow = est;
    phoneCandidates = [BOB];
    db.transaction.mockImplementationOnce(async () => { throw Object.assign(new Error('could not obtain lock'), { code: '55P03' }); });
    await expect(refuseParkedWrite(est, 'cust-bob')).resolves.toMatchObject({ code: 'ACCEPT_NEEDS_OFFICE_REVIEW' });
    expect(mockReleaseEstimateHolds).not.toHaveBeenCalled();
  });
});

describe('estimatePublicBlockingState resolves the quote requirement itself when the caller does not (no precedence level can be skipped)', () => {
  const { estimatePublicBlockingState } = estimatePublicRouter;
  test('parked AND quote-required (an enabled commercial proposal) reports quote_required, with or without the caller supplying it; parked alone is contact_review', async () => {
    phoneCandidates = [BOB];
    const quoteRequiredEstimate = makeEstimate();
    quoteRequiredEstimate.estimate_data = { ...quoteRequiredEstimate.estimate_data, proposal: { enabled: true } };
    expect((await estimatePublicBlockingState(quoteRequiredEstimate, { estData: quoteRequiredEstimate.estimate_data }))?.state).toBe('quote_required');
    const parkedOnly = makeEstimate();
    expect(await estimatePublicBlockingState(parkedOnly, { estData: parkedOnly.estimate_data })).toMatchObject({ state: 'contact_review', rejectedCustomerId: 'cust-bob' });
    // Caller-supplied requirement still wins first.
    expect((await estimatePublicBlockingState(makeEstimate(), { quoteRequirement: { quoteRequired: true } }))?.state).toBe('quote_required');
    // Not parked, not review: nothing (and no phone-less surprises).
    phoneCandidates = [];
    expect(await estimatePublicBlockingState(makeEstimate())).toBeNull();
  });
});

describe('refuseParkedWrite (what every public write path answers a parked estimate with)', () => {
  const { refuseParkedWrite } = estimatePublicRouter;
  test('files the deduped alert, releases the estimate\'s holds, and returns the coded review body - never throwing', async () => {
    phoneCandidates = [BOB];
    const est = makeEstimate();
    expect(await refuseParkedWrite(est, 'cust-bob')).toMatchObject({ code: 'ACCEPT_NEEDS_OFFICE_REVIEW', reviewBeforeBooking: true, reason: 'contact_review' });
    expect(mockRaiseAdminAlert).toHaveBeenCalledTimes(1);
    expect(mockReleaseEstimateHolds).toHaveBeenCalledWith(expect.objectContaining({ estimateId: est.id }));
    mockRaiseAdminAlert.mockRejectedValueOnce(new Error('alerts down'));
    mockReleaseEstimateHolds.mockRejectedValueOnce(new Error('db down'));
    await expect(refuseParkedWrite(est, 'cust-bob')).resolves.toMatchObject({ code: 'ACCEPT_NEEDS_OFFICE_REVIEW' });
  });
});
