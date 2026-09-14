process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

jest.mock('../models/db', () => {
  const mock = jest.fn();
  mock.fn = { now: jest.fn(() => 'NOW') };
  mock.raw = jest.fn((sql) => sql);
  return mock;
});
jest.mock('../config/feature-gates', () => ({
  isEnabled: jest.fn(() => false),
  gateEnvValue: jest.fn(() => false),
  gates: {},
}));
jest.mock('../services/property-lookup/lookup-cache', () => ({
  getCachedLookup: jest.fn().mockResolvedValue(null),
}));
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
jest.mock('../services/estimate-group-navigation', () => ({
  refreshExpiredGroupNavigation: jest.fn().mockResolvedValue(null),
}));

const express = require('express');
const db = require('../models/db');
const estimatePublicRouter = require('../routes/estimate-public');
const { refreshExpiredGroupNavigation } = require('../services/estimate-group-navigation');

let dbRows = {};
function chainFor(result) {
  const chain = {
    where: jest.fn(() => chain),
    whereIn: jest.fn(() => chain),
    whereNull: jest.fn(() => chain),
    whereRaw: jest.fn(() => chain),
    andWhere: jest.fn(() => chain),
    orWhere: jest.fn(() => chain),
    orWhereRaw: jest.fn(() => chain),
    leftJoin: jest.fn(() => chain),
    select: jest.fn(() => chain),
    orderBy: jest.fn(() => chain),
    then: (resolve, reject) => Promise.resolve(dbRows.siblings || []).then(resolve, reject),
    first: jest.fn().mockResolvedValue(result),
    update: jest.fn().mockResolvedValue(1),
    insert: jest.fn().mockResolvedValue([1]),
  };
  return chain;
}
db.mockImplementation((table) => chainFor(dbRows[table]));

function estimateRow(overrides = {}) {
  return {
    id: 'est-regulated-1',
    token: 'regulatedsurfacetoken',
    status: 'sent',
    sent_at: null,
    viewed_at: null,
    expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    customer_name: 'Pat Tester',
    customer_phone: null,
    customer_email: null,
    address: '123 Trust Ln, Bradenton, FL 34203',
    satellite_url: null,
    waveguard_tier: 'Bronze',
    bill_by_invoice: false,
    monthly_total: 88,
    annual_total: 1056,
    onetime_total: 125,
    estimate_data: {
      sendSnapshot: {
        pricingBundle: {
          frequencies: [{ key: 'quarterly', label: 'Quarterly', monthly: 88, annual: 1056 }],
          waveGuardTier: 'Bronze',
          anchorOneTimePrice: 125,
          source: 'send_snapshot_fixture',
        },
      },
      result: {
        recurring: { discount: 0, services: [{ name: 'Pest Control', mo: 88 }] },
        oneTime: { items: [{ service: 'wdo_inspection', name: 'WDO Inspection', price: 125 }], membershipFee: 0 },
      },
    },
    ...overrides,
  };
}

async function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use('/estimates', estimatePublicRouter);
  app.use((err, _req, res, _next) => { res.status(err.status || 500).json({ error: err.message }); });
  const server = app.listen(0);
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
  }
}

describe('GET /:token/data — navigation after the anchor offer expires', () => {
  const past = new Date(Date.now() - 86400000).toISOString();
  const future = new Date(Date.now() + 30 * 86400000).toISOString();
  function anchor(overrides = {}) {
    const base = estimateRow();
    return { ...base, estimate_group_id: 'group-bid', expires_at: past,
      viewed_at: past, sent_at: past,
      estimate_data: { ...base.estimate_data, groupLinkViewableThrough: future }, ...overrides };
  }
  beforeEach(() => { dbRows = {}; refreshExpiredGroupNavigation.mockReset().mockResolvedValue(null); });

  test.each(['sent', 'viewed', 'expired'])('serves the %s anchor and live sibling while leaving the anchor offer expired', async (status) => {
    const row = anchor({ status });
    const sibling = estimateRow({ id: 'fixed-sibling', token: 'fixedsiblingtoken', estimate_group_id: row.estimate_group_id, expires_at: future });
    dbRows = { estimates: row, siblings: [row, sibling] };
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/estimates/${row.token}/data?refresh=1`);
      const body = await res.json();
      expect({ status: res.status, error: body.error }).toEqual({ status: 200 });
      expect(body.estimate.expiresAt).toBe(past);
      expect(body.propertyGroup.map((member) => member.token)).toEqual([row.token, sibling.token]);
      expect(body.cta).toMatchObject({ canAccept: false, terminalState: 'expired' });
      expect(estimatePublicRouter.isEstimateAcceptActive(row)).toBe(false);
      expect(estimatePublicRouter.isEstimateCustomerViewable(row)).toBe(false);
    });
  });

  test('shows only published expired siblings as nonactionable summaries', async () => {
    const row = anchor();
    const expiredByDate = estimateRow({ id: 'expired-date', token: 'expireddatetoken', estimate_group_id: row.estimate_group_id,
      status: 'sent', sent_at: past, expires_at: past });
    const expiredBySweep = estimateRow({ id: 'expired-sweep', token: 'expiredsweeptoken', estimate_group_id: row.estimate_group_id,
      status: 'expired', sent_at: past, expires_at: past });
    const withheld = [
      { id: 'never-published', status: 'expired', expires_at: past },
      { id: 'draft', status: 'draft', sent_at: past, expires_at: past },
      { id: 'send-failed', status: 'send_failed', sent_at: past, expires_at: past },
      { id: 'expired-unsent', status: 'expired', disposition: 'expired_unsent', sent_at: past, expires_at: past },
      { id: 'price-locked', status: 'expired', sent_at: past, expires_at: past, price_locked_at: past },
      { id: 'archived', status: 'expired', sent_at: past, expires_at: past, archived_at: past },
      { id: 'held', status: 'expired', sent_at: past, expires_at: past,
        estimate_data: { estimatorEngine: { reprice_pending_at: past } } },
      { id: 'invalidated', status: 'expired', sent_at: past, expires_at: past,
        estimate_data: { estimatorEngine: { linkage_invalidated_at: past } } },
      { id: 'call-blocked', status: 'expired', sent_at: past, expires_at: past,
        estimate_data: { estimatorEngine: { callLogId: 'missing-call' } } },
    ].map((item) => estimateRow({ token: `${item.id.replace(/-/g, '')}token`, estimate_group_id: row.estimate_group_id, ...item }));
    dbRows = { estimates: row, siblings: [row, expiredByDate, expiredBySweep, ...withheld] };
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/estimates/${row.token}/data?refresh=1`);
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.propertyGroup).toHaveLength(3);
      expect(body.propertyGroup[0]).toMatchObject({ token: row.token, status: 'expired', isCurrent: true });
      expect(body.propertyGroup.slice(1)).toEqual([
        expect.objectContaining({ status: 'expired', isCurrent: false }),
        expect.objectContaining({ status: 'expired', isCurrent: false }),
      ]);
      expect(body.propertyGroup.slice(1).every((member) => !Object.hasOwn(member, 'token'))).toBe(true);
      expect(body.cta).toMatchObject({ canAccept: false, terminalState: 'expired' });

      // A summary does not turn the expired sibling's own bearer link back on.
      dbRows.estimates = expiredByDate;
      const siblingRes = await fetch(`${baseUrl}/estimates/${expiredByDate.token}/data?refresh=1`);
      expect(siblingRes.status).toBe(404);
    });
  });

  test('an active published anchor includes expired siblings without a stored navigation floor', async () => {
    const row = estimateRow({ estimate_group_id: 'group-bid', sent_at: past, expires_at: future });
    const expired = estimateRow({ id: 'expired-sibling', token: 'expiredsiblingtoken', estimate_group_id: row.estimate_group_id,
      status: 'expired', sent_at: past, expires_at: past });
    dbRows = { estimates: row, siblings: [row, expired] };
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/estimates/${row.token}/data?refresh=1`);
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.propertyGroup).toHaveLength(2);
      expect(body.propertyGroup[0]).toMatchObject({ token: row.token, isCurrent: true });
      expect(body.propertyGroup[1]).toMatchObject({ status: 'expired', isCurrent: false });
      expect(body.propertyGroup[1]).not.toHaveProperty('token');
      expect(body.cta.terminalState).toBeNull();
    });
  });

  test.each(['accepted', 'declined'].flatMap((status) => [
    [status, 'absent', undefined], [status, 'elapsed', past],
  ]))('a %s anchor with an expired offer and %s navigation floor cannot reveal expired siblings', async (status, _label, floor) => {
    const base = estimateRow();
    const row = estimateRow({ status, estimate_group_id: 'group-bid', sent_at: past, expires_at: past,
      estimate_data: { ...base.estimate_data, ...(floor ? { groupLinkViewableThrough: floor } : {}) } });
    const expired = estimateRow({ id: 'expired-sibling', token: 'expiredsiblingtoken', estimate_group_id: row.estimate_group_id,
      status: 'expired', sent_at: past, expires_at: past });
    dbRows = { estimates: row, siblings: [row, expired] };
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/estimates/${row.token}/data?refresh=1`);
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.propertyGroup).toBeUndefined();
      expect(body.cta.terminalState).toBe(status);
      expect(refreshExpiredGroupNavigation).not.toHaveBeenCalled();
    });
  });

  test('an expired anchor recovers a durable group window after a held sibling clears', async () => {
    const row = anchor({ estimate_data: estimateRow().estimate_data });
    const sibling = estimateRow({ id: 'fixed-sibling', token: 'fixedsiblingtoken', estimate_group_id: row.estimate_group_id,
      sent_at: past, expires_at: future });
    dbRows = { estimates: row, siblings: [row, sibling] };
    refreshExpiredGroupNavigation.mockImplementationOnce(async (_database, stale) => ({
      ...stale, estimate_data: { ...stale.estimate_data, groupLinkViewableThrough: future },
    }));
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/estimates/${row.token}/data?refresh=1`);
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.propertyGroup.map((member) => member.token)).toEqual([row.token, sibling.token]);
      expect(body.cta).toMatchObject({ canAccept: false, terminalState: 'expired' });
      expect(refreshExpiredGroupNavigation).toHaveBeenCalledWith(db, expect.objectContaining({ id: row.id }));
    });
  });

  test('a rejected group refresh keeps an expired anchor private', async () => {
    const row = anchor({ estimate_data: estimateRow().estimate_data });
    dbRows = { estimates: row };
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/estimates/${row.token}/data?refresh=1`);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'Estimate not found' });
      expect(refreshExpiredGroupNavigation).toHaveBeenCalledTimes(1);
    });
  });

  test.each([
    { status: 'draft' }, { status: 'scheduled' }, { status: 'send_failed' },
    { archived_at: past }, { estimate_group_id: null },
    { estimate_data: { groupLinkViewableThrough: past } },
    { estimate_data: { groupLinkViewableThrough: 'invalid' } },
    ...['reprice_pending_at', 'linkage_invalidated_at', 'invalidation_pending_at'].map((marker) => ({
      estimate_data: { groupLinkViewableThrough: future, estimatorEngine: { [marker]: past } },
    })),
  ])('keeps ineligible anchors private: %j', async (overrides) => {
    const row = anchor(overrides);
    dbRows = { estimates: row };
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/estimates/${row.token}/data?refresh=1`);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'Estimate not found' });
    });
  });
});
