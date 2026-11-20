/**
 * Roof points frozen at send (owner ruling 2026-11-20, choice 4A): every delivered send in sendEstimateNow copies the
 * technician-confirmed roof points of the newest finished read into estimate_roof_points (the customer page prints that
 * copy). A re-send replaces it, a send with no confirmed points (or with the points hidden) deletes it, and a failure in
 * the step never fails the send. The real estimate-roof-points service runs against a small in-memory stand-in for the two
 * tables; the rest of the send harness is the one the channel-link suite uses.
 */

jest.mock('../models/db', () => {
  const mockDb = jest.fn();
  mockDb.raw = jest.fn((expr) => expr);
  mockDb.fn = { now: jest.fn(() => 'NOW()') };
  // The pre-delivery verdict check runs a short transaction on the same
  // connection shape.
  mockDb.transaction = jest.fn(async (fn) => fn(mockDb));
  return mockDb;
});
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => next(),
  requireTechOrAdmin: (req, res, next) => next(),
  requireAdmin: (req, res, next) => next(),
}));
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../services/short-url', () => ({
  // Channel-distinguishable URLs so the wiring (which leg got which link)
  // is observable downstream.
  shortenOrPassthrough: jest.fn(async (url, opts = {}) => `https://short.test/${opts.channel}`),
}));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn(async () => ({ sent: true, providerMessageId: 'SM-synthetic-accepted' })),
}));
jest.mock('../routes/admin-sms-templates', () => ({
  getTemplate: jest.fn(async (_key, vars) => `SMS: ${vars.estimate_url}`),
}));
jest.mock('../services/estimate-lead-linkage', () => ({
  leadIdForEstimate: jest.fn(async () => 'lead-9'),
}));
jest.mock('../services/estimate-delivery-options', () => ({
  estimateDataHasQuoteRequirement: jest.fn(() => false),
  estimateDataHasUnresolvedManagerApproval: jest.fn(() => false),
  commercialRiskTypeReviewNeeded: jest.fn(() => false),
  validateEstimateDeliveryOptions: jest.fn(),
}));
jest.mock('../services/estimate-pricing-audit', () => ({
  buildEstimatePricingAudit: jest.fn(),
  buildEstimatePricingRiskBatch: jest.fn(),
  getLatestEstimatePricingAuditSnapshot: jest.fn(),
  saveEstimatePricingAuditSnapshot: jest.fn(),
}));
jest.mock('../services/lead-estimate-link', () => ({ markLinkedLeadEstimateSent: jest.fn() }));
jest.mock('../services/estimate-manual-acceptance', () => ({ markEstimateManuallyAccepted: jest.fn() }));
jest.mock('../services/admin-estimate-persistence', () => ({
  createOrReuseAdminEstimate: jest.fn(),
  estimateExpiresAt: jest.fn(() => new Date('2026-08-04T00:00:00.000Z')),
  estimateViewUrl: jest.fn((token) => `https://portal.wavespestcontrol.com/estimate/${token}`),
  // REAL implementations — the pre-delivery revalidation and the
  // deferred-invalidation release below exercise these against the mocked db.
  staleCallLinkageReason: jest.requireActual('../services/admin-estimate-persistence').staleCallLinkageReason,
  completePendingInvalidation: jest.requireActual('../services/admin-estimate-persistence').completePendingInvalidation,
  takePendingInvalidation: jest.requireActual('../services/admin-estimate-persistence').takePendingInvalidation,
}));
jest.mock('../routes/estimate-public', () => ({
  acceptanceServiceLists: jest.fn(),
  buildPricingBundle: jest.fn(async () => ({})),
  bookingServiceFor: jest.fn(),
}));
jest.mock('../services/email-template-library', () => ({ sendTemplate: jest.fn() }));
jest.mock('../services/sendgrid-mail', () => ({
  isConfigured: jest.fn(() => true),
  isDefiniteRejection: jest.requireActual('../services/sendgrid-mail').isDefiniteRejection,
}));
jest.mock('../services/automation-runner', () => ({ enrollCustomer: jest.fn() }));

const db = require('../models/db');
const router = require('../routes/admin-estimates');
const EmailTemplateLibrary = require('../services/email-template-library');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const smsTemplates = require('../routes/admin-sms-templates');


const logger = require('../services/logger');

function estimateRow(overrides = {}) {
  return {
    id: 'est-1',
    token: 'tok-1',
    status: 'sending',
    customer_id: 'cust-1',
    customer_name: 'Dana Reyes',
    customer_phone: '+19415550101',
    customer_email: 'dana@example.com',
    address: '12 Synthetic Way, Bradenton, FL 34203',
    monthly_total: '89',
    annual_total: '1068',
    estimate_data: null,
    created_at: '2026-07-01T12:00:00.000Z',
    updated_at: '2026-07-01T12:00:00.000Z',
    ...overrides,
  };
}

function makeBuilder(row) {
  const b = {};
  for (const m of ['where', 'whereIn', 'whereNull', 'whereNotNull', 'whereNotIn', 'whereRaw', 'forUpdate', 'select', 'orderBy', 'limit']) {
    b[m] = jest.fn(() => b);
  }
  b.first = jest.fn(async () => row);
  b.update = jest.fn(async () => 1);
  return b;
}

const read = (over = {}) => ({
  id: 'read-1',
  estimate_id: 'est-1',
  status: 'done',
  tech_pins: [
    { x: 0.25, y: 0.4, type: 'roof_returns_and_valleys', note: 'front left' },
    { x: 0.7, y: 0.55, type: 'trees_touching_roof' },
  ],
  hide_on_estimate: false,
  crop_lat: 26.95,
  crop_lng: -82.4,
  image_source: 'manatee_2025_rgb',
  image_year: 2025,
  created_at: new Date('2026-11-20T15:00:00Z'),
  ...over,
});

// In-memory stand-in: roof_entry_reads rows and the one estimate_roof_points row per estimate.
let reads;
let store;
let failOn;
function readsBuilder() {
  const q = {};
  let where = {};
  q.where = jest.fn((w) => { where = { ...where, ...w }; return q; });
  q.whereRaw = jest.fn(() => q); // the SQL filter (tech_pins saved as an array) is applied in first()
  q.orderBy = jest.fn(() => q);
  q.first = jest.fn(async () => {
    if (failOn === 'reads') throw new Error('reads down');
    const rows = reads
      .filter((r) => Object.entries(where).every(([k, v]) => r[k] === v))
      .filter((r) => (where.id ? true : Array.isArray(r.tech_pins)))
      .sort((a, b) => b.created_at - a.created_at);
    return rows[0];
  });
  return q;
}
function pointsBuilder() {
  const q = {};
  let key = null;
  q.where = jest.fn((w) => { key = w.estimate_id; return q; });
  q.first = jest.fn(async () => store[key]);
  q.del = jest.fn(async () => { if (failOn === 'write') throw new Error('write down'); const had = key in store; delete store[key]; return had ? 1 : 0; });
  q.insert = jest.fn((rec) => ({
    onConflict: () => ({
      merge: async () => { if (failOn === 'write') throw new Error('write down'); store[rec.estimate_id] = { ...rec, snapshot: JSON.parse(rec.snapshot) }; },
    }),
  }));
  return q;
}

beforeEach(() => {
  jest.clearAllMocks();
  reads = [];
  store = {};
  failOn = null;
  db.mockImplementation((table) => {
    if (table === 'roof_entry_reads') return readsBuilder();
    if (table === 'estimate_roof_points') return pointsBuilder();
    return makeBuilder(estimateRow());
  });
  db.raw = jest.fn((expr) => expr);
  db.fn = { now: jest.fn(() => 'NOW()') };
  db.transaction = jest.fn(async (fn) => fn(db));
  sendCustomerMessage.mockResolvedValue({ sent: true, providerMessageId: 'SM-synthetic-accepted' });
  smsTemplates.getTemplate.mockImplementation(async (_key, vars) => `SMS: ${vars.estimate_url}`);
  EmailTemplateLibrary.sendTemplate.mockResolvedValue({ sent: true, providerAttempted: true, providerAccepted: true, message: { provider_message_id: 'sg-1' } });
});

describe('sendEstimateNow: roof points frozen at send', () => {
  test('a delivered send copies the confirmed points, numbered, with the read id and the estimate address', async () => {
    reads = [read()];
    const result = await router.sendEstimateNow(estimateRow(), 'email');
    expect(result.sent).toBe(true);
    expect(store['est-1']).toMatchObject({ estimate_id: 'est-1', read_id: 'read-1', address: '12 Synthetic Way, Bradenton, FL 34203' });
    expect(store['est-1'].snapshot).toEqual({
      imageUrl: expect.stringContaining('mymanatee.org'),
      imageYear: 2025,
      pins: [
        { n: 1, x: 0.25, y: 0.4, type: 'roof_returns_and_valleys', label: 'Roof return, front left', action: 'seal' },
        { n: 2, x: 0.7, y: 0.55, type: 'trees_touching_roof', label: 'Branch touching the roof', action: 'trim back' },
      ],
    });
  });

  test('a re-send replaces the copy with the points as they stand now; between sends the copy does not change', async () => {
    reads = [read()];
    await router.sendEstimateNow(estimateRow(), 'email');
    const first = JSON.stringify(store['est-1'].snapshot);
    // The technician edits the points after the send: the sent copy keeps its content.
    reads = [read({ tech_pins: [{ x: 0.1, y: 0.1, type: 'chimney_or_flue' }] })];
    expect(JSON.stringify(store['est-1'].snapshot)).toBe(first);
    await router.sendEstimateNow(estimateRow(), 'email');
    expect(store['est-1'].snapshot.pins).toEqual([{ n: 1, x: 0.1, y: 0.1, type: 'chimney_or_flue', label: 'Chimney or flue', action: 'seal' }]);
  });

  test('the newest finished read with saved points wins over an older one', async () => {
    reads = [
      read({ id: 'read-old', created_at: new Date('2026-11-19T15:00:00Z') }),
      read({ id: 'read-new', tech_pins: [{ x: 0.5, y: 0.5, type: 'gable_vents' }], created_at: new Date('2026-11-20T15:00:00Z') }),
      read({ id: 'read-unsaved', tech_pins: null, created_at: new Date('2026-11-20T16:00:00Z') }),
    ];
    await router.sendEstimateNow(estimateRow(), 'email');
    expect(store['est-1'].read_id).toBe('read-new');
  });

  test('points removed before the next send: the old copy is deleted', async () => {
    reads = [read()];
    await router.sendEstimateNow(estimateRow(), 'email');
    expect(store['est-1']).toBeDefined();
    reads = [read({ tech_pins: [] })];
    const result = await router.sendEstimateNow(estimateRow(), 'email');
    expect(result.sent).toBe(true);
    expect(store['est-1']).toBeUndefined();
  });

  test('points hidden before the next send: the old copy is deleted; no read at all writes nothing', async () => {
    reads = [read()];
    await router.sendEstimateNow(estimateRow(), 'email');
    reads = [read({ hide_on_estimate: true })];
    await router.sendEstimateNow(estimateRow(), 'email');
    expect(store['est-1']).toBeUndefined();
    reads = [];
    await router.sendEstimateNow(estimateRow(), 'email');
    expect(store).toEqual({});
  });

  test('an unfinished read, or one with no stored crop centre, is not copied', async () => {
    reads = [read({ status: 'pending' })];
    await router.sendEstimateNow(estimateRow(), 'email');
    expect(store).toEqual({});
    reads = [read({ crop_lat: null, crop_lng: null })];
    await router.sendEstimateNow(estimateRow(), 'email');
    expect(store).toEqual({});
  });

  test.each(['reads', 'write'])('the send still succeeds when the snapshot step fails (%s)', async (where) => {
    reads = [read()];
    failOn = where;
    const result = await router.sendEstimateNow(estimateRow(), 'email');
    expect(result.sent).toBe(true);
    expect(EmailTemplateLibrary.sendTemplate).toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('[estimate-roof-points] freeze skipped for estimate est-1'));
  });

  test('a send that delivered nothing leaves the copy alone', async () => {
    reads = [read()];
    await router.sendEstimateNow(estimateRow(), 'email');
    const before = JSON.stringify(store['est-1']);
    reads = [read({ tech_pins: [] })];
    EmailTemplateLibrary.sendTemplate.mockResolvedValue({ sent: false, providerAttempted: true, providerAccepted: false, error: 'rejected' });
    const result = await router.sendEstimateNow(estimateRow(), 'email');
    expect(result.sent).toBe(false);
    expect(JSON.stringify(store['est-1'])).toBe(before);
  });
});
