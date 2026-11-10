process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.WAVES_ADMIN_IPS = '203.0.113.9';

jest.mock('../models/db', () => {
  const mock = jest.fn();
  mock.fn = { now: jest.fn(() => 'NOW') };
  mock.raw = jest.fn((sql) => sql);
  return mock;
});
jest.mock('../config/feature-gates', () => ({
  isEnabled: jest.fn(() => true),
  mosquitoMistingLive: () => false,
  mistingLayoutDesignerLive: () => false,
  gateEnvValue: jest.fn(() => false),
  gates: {},
  payAfterFirstVisitLive: () => false,
  pafSetupFeeLive: () => false,
  commercialProposalSignLive: () => false,
  commercialFirstVisitLive: () => false,
  estimateAssessmentFirstLive: () => false,
  estimateConsumerNoticeLive: () => false,
}));
jest.mock('../services/estimate-membership-context', () => ({
  buildEstimateMembershipContext: jest.fn().mockResolvedValue(null),
  publicMembershipView: jest.fn((snapshot) => snapshot ?? null),
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/estimate-group-navigation', () => ({
  refreshExpiredGroupNavigation: jest.fn().mockResolvedValue(null),
}));
jest.mock('../services/estimate-extension', () => ({
  ...jest.requireActual('../services/estimate-extension'),
  fixedBidBlocksExtension: jest.fn().mockResolvedValue(false),
  extensionDeliverableUnderGate: jest.fn().mockResolvedValue(true),
}));
jest.mock('../middleware/admin-auth', () => ({
  ...jest.requireActual('../middleware/admin-auth'),
  verifyStaffBearer: jest.fn().mockResolvedValue(null),
}));
jest.mock('../services/audit-log', () => ({
  ...jest.requireActual('../services/audit-log'),
  auditEstimateExpiredOpen: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../services/estimate-stuck-alert', () => ({ noteExpiredReturn: jest.fn(async () => null) }));

const express = require('express');
const jwt = require('jsonwebtoken');
const config = require('../config');
const db = require('../models/db');
const featureGates = require('../config/feature-gates');
const estimatePublicRouter = require('../routes/estimate-public');
const { auditEstimateExpiredOpen } = require('../services/audit-log');
const { noteExpiredReturn } = require('../services/estimate-stuck-alert');

const BARE = { error: 'Estimate not found' };
const SENT = '2026-10-28T15:00:00.000Z';
const EXPIRED = '2026-11-04T15:00:00.000Z';
const CUSTOMER_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/604.1';

let dbRows = {};
function chainFor(result) {
  const chain = {
    where: jest.fn(() => chain),
    whereIn: jest.fn(() => chain),
    whereNull: jest.fn(() => chain),
    whereRaw: jest.fn(() => chain),
    select: jest.fn(() => chain),
    orderBy: jest.fn(() => chain),
    then: (resolve, reject) => Promise.resolve([]).then(resolve, reject),
    first: jest.fn().mockResolvedValue(result),
    update: jest.fn().mockResolvedValue(1),
    insert: jest.fn().mockResolvedValue([1]),
  };
  return chain;
}
db.mockImplementation((table) => chainFor(dbRows[table]));

function expiredRow(overrides = {}) {
  return {
    id: 'est-expired-1',
    token: 'expiredopentoken',
    status: 'expired',
    sent_at: SENT,
    viewed_at: null,
    expires_at: EXPIRED,
    extension_auto_granted_at: null,
    customer_name: 'Pat Tester',
    estimate_data: {},
    ...overrides,
  };
}

async function get(row, headers = {}) {
  dbRows = { estimates: row };
  const app = express();
  app.use('/estimates', estimatePublicRouter);
  app.use((err, _req, res, _next) => { res.status(err.status || 500).json({ error: err.message }); });
  const server = app.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/estimates/${row.token}/data${headers.query || ''}`, {
      headers: { 'user-agent': CUSTOMER_UA, ...headers.headers },
    });
    return { status: res.status, body: await res.json() };
  } finally {
    server.close();
  }
}

beforeEach(() => {
  dbRows = {};
  auditEstimateExpiredOpen.mockClear();
  noteExpiredReturn.mockClear();
  featureGates.isEnabled.mockImplementation(() => true);
});

describe('GET /:token/data — expired estimate that can be reopened', () => {
  test('carries the expiry, send date and self-serve flag while the first reopen is unused', async () => {
    const { status, body } = await get(expiredRow());
    expect(status).toBe(404);
    expect(body).toEqual({
      error: 'Estimate not found',
      extensionRequestEligible: true,
      expiresAt: EXPIRED,
      sentAt: SENT,
      extensionSelfServe: true,
    });
  });

  test('leaves out extensionSelfServe once the first reopen was granted', async () => {
    const { body } = await get(expiredRow({ extension_auto_granted_at: '2026-10-31T12:00:00.000Z' }));
    expect(body).toEqual({
      error: 'Estimate not found',
      extensionRequestEligible: true,
      expiresAt: EXPIRED,
      sentAt: SENT,
    });
    expect(Object.hasOwn(body, 'extensionSelfServe')).toBe(false);
  });

  test('leaves out extensionSelfServe after a request in the last 24 hours (the tap only tells the office)', async () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const { body } = await get(expiredRow({ extension_requested_at: twoHoursAgo }));
    expect(body.extensionRequestEligible).toBe(true);
    expect(Object.hasOwn(body, 'extensionSelfServe')).toBe(false);
  });

  test('offers the self-serve reopen again once a request is over 24 hours old', async () => {
    const thirtyHoursAgo = new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString();
    const { body } = await get(expiredRow({ extension_requested_at: thirtyHoursAgo }));
    expect(body.extensionSelfServe).toBe(true);
  });

  test('still answers the eligible 404 when the audit write fails', async () => {
    auditEstimateExpiredOpen.mockRejectedValueOnce(new Error('audit down'));
    const { status, body } = await get(expiredRow());
    expect(status).toBe(404);
    expect(body.extensionRequestEligible).toBe(true);
    expect(body.extensionSelfServe).toBe(true);
  });

  test('leaves out sentAt when the row has none (viewed but never stamped as sent)', async () => {
    const { body } = await get(expiredRow({ sent_at: null, viewed_at: SENT }));
    expect(body).toEqual({
      error: 'Estimate not found',
      extensionRequestEligible: true,
      expiresAt: EXPIRED,
      extensionSelfServe: true,
    });
  });

  test.each([
    ['archived', { archived_at: SENT }],
    ['a plan restart quote', { source: 'plan_restart' }],
    ['a fixed-bid validity window', { estimate_data: { proposal: { validThrough: '2026-11-04' } } }],
    ['a draft', { status: 'draft', sent_at: null }],
    ['a row never sent or viewed', { sent_at: null, viewed_at: null }],
  ])('answers the bare 404 for %s and records nothing', async (_label, overrides) => {
    const { status, body } = await get(expiredRow(overrides));
    expect(status).toBe(404);
    expect(body).toEqual(BARE);
    expect(auditEstimateExpiredOpen).not.toHaveBeenCalled();
  });

  test('answers the bare 404 when the extension gate is off, but still records the open', async () => {
    featureGates.isEnabled.mockImplementation(() => false);
    const { status, body } = await get(expiredRow());
    expect(status).toBe(404);
    expect(body).toEqual(BARE);
    expect(auditEstimateExpiredOpen).toHaveBeenCalledTimes(1);
    expect(auditEstimateExpiredOpen).toHaveBeenCalledWith(expect.objectContaining({ extensionOffered: false }));
  });

  test('answers the bare 404 when a fixed bid blocks the extension, but still records the open', async () => {
    require('../services/estimate-extension').fixedBidBlocksExtension.mockResolvedValueOnce(true);
    const { body } = await get(expiredRow());
    expect(body).toEqual(BARE);
    expect(auditEstimateExpiredOpen).toHaveBeenCalledWith(expect.objectContaining({ extensionOffered: false }));
  });
  test('answers the bare 404 when the reopen route would refuse the tap (pricing authority), but still records the open', async () => {
    require('../services/estimate-extension').extensionDeliverableUnderGate.mockResolvedValueOnce(false);
    const { body } = await get(expiredRow());
    expect(body).toEqual(BARE);
    expect(auditEstimateExpiredOpen).toHaveBeenCalledWith(expect.objectContaining({ extensionOffered: false }));
  });
});

describe('GET /:token/data — recording that a customer opened an expired estimate', () => {
  test('records one audit event for a customer browser', async () => {
    await get(expiredRow(), { headers: { 'x-forwarded-for': '198.51.100.20' } });
    expect(auditEstimateExpiredOpen).toHaveBeenCalledTimes(1);
    expect(auditEstimateExpiredOpen).toHaveBeenCalledWith({
      estimateId: 'est-expired-1',
      expiresAt: EXPIRED,
      extensionOffered: true,
      ipAddress: '198.51.100.20',
      userAgent: CUSTOMER_UA,
    });
  });

  test('tells the office the customer came back, with what the page offered them', async () => {
    await get(expiredRow(), { headers: { 'x-forwarded-for': '198.51.100.20' } });
    expect(noteExpiredReturn).toHaveBeenCalledTimes(1);
    expect(noteExpiredReturn).toHaveBeenCalledWith(expect.objectContaining({ id: 'est-expired-1' }), { offered: true, selfServe: true });
    noteExpiredReturn.mockClear();
    await get(expiredRow({ extension_auto_granted_at: '2026-10-31T12:00:00.000Z' }));
    expect(noteExpiredReturn).toHaveBeenCalledWith(expect.anything(), { offered: true, selfServe: false });
    noteExpiredReturn.mockClear();
    featureGates.isEnabled.mockImplementation(() => false);
    await get(expiredRow());
    expect(noteExpiredReturn).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ offered: false }));
  });

  test('a staff browser, a bot, an admin IP, a PDF render or the page refresh tells the office nothing', async () => {
    const marker = jwt.sign({ kind: 'admin_marker' }, config.jwt.secret);
    await get(expiredRow(), { headers: { cookie: `waves_admin=${marker}` } });
    await get(expiredRow(), { headers: { 'user-agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' } });
    await get(expiredRow(), { headers: { 'x-forwarded-for': '203.0.113.9' } });
    await get(expiredRow(), { query: '?mode=pdf' });
    await get(expiredRow({ viewed_at: SENT }), { query: '?refresh=1' });
    expect(noteExpiredReturn).not.toHaveBeenCalled();
  });

  test('does not record a bot user agent', async () => {
    await get(expiredRow(), { headers: { 'user-agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' } });
    expect(auditEstimateExpiredOpen).not.toHaveBeenCalled();
  });

  test('does not record a request from the staff browser marker', async () => {
    const marker = jwt.sign({ kind: 'admin_marker' }, config.jwt.secret);
    const { body } = await get(expiredRow(), { headers: { cookie: `waves_admin=${marker}` } });
    expect(body.extensionRequestEligible).toBe(true);
    expect(auditEstimateExpiredOpen).not.toHaveBeenCalled();
  });

  test('does not record a verified staff preview (no marker cookie, not an admin IP)', async () => {
    require('../middleware/admin-auth').verifyStaffBearer.mockResolvedValueOnce({ id: 'staff-1', role: 'admin' });
    const { body } = await get(expiredRow(), { query: '?adminPreview=1', headers: { 'x-forwarded-for': '198.51.100.20' } });
    expect(body.extensionRequestEligible).toBe(true);
    expect(auditEstimateExpiredOpen).not.toHaveBeenCalled();
  });

  test('records ?adminPreview=1 without a valid staff sign-in as a customer open', async () => {
    await get(expiredRow(), { query: '?adminPreview=1', headers: { 'x-forwarded-for': '198.51.100.20' } });
    expect(auditEstimateExpiredOpen).toHaveBeenCalledTimes(1);
  });

  test("does not record the page's own refresh of an estimate it already showed", async () => {
    await get(expiredRow({ viewed_at: SENT }), { query: '?refresh=1' });
    expect(auditEstimateExpiredOpen).not.toHaveBeenCalled();
  });

  test('does not record a request from an admin IP', async () => {
    await get(expiredRow(), { headers: { 'x-forwarded-for': '203.0.113.9' } });
    expect(auditEstimateExpiredOpen).not.toHaveBeenCalled();
  });

  test('does not record a PDF render pass', async () => {
    await get(expiredRow(), { query: '?mode=pdf' });
    expect(auditEstimateExpiredOpen).not.toHaveBeenCalled();
  });
});

describe('auditEstimateExpiredOpen', () => {
  test('writes a customer-actor audit_log row with the expiry and whether the reopen was offered', async () => {
    const insert = jest.fn().mockResolvedValue([1]);
    db.mockImplementationOnce((table) => {
      expect(table).toBe('audit_log');
      return { insert };
    });
    await jest.requireActual('../services/audit-log').auditEstimateExpiredOpen({
      estimateId: 'est-expired-1', expiresAt: EXPIRED, extensionOffered: true, ipAddress: '198.51.100.20', userAgent: CUSTOMER_UA,
    });
    expect(insert).toHaveBeenCalledWith({
      actor_type: 'customer',
      actor_id: null,
      action: 'estimate_expired_open',
      resource_type: 'estimate',
      resource_id: 'est-expired-1',
      metadata: { expires_at: EXPIRED, extension_offered: true },
      ip_address: '198.51.100.20',
      user_agent: CUSTOMER_UA,
    });
  });
});
