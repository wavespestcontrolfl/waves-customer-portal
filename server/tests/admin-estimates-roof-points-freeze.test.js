/**
 * Roof points frozen at send (owner ruling 2026-11-20, choice 4A): every send in sendEstimateNow with a real provider
 * handoff copies the technician-confirmed roof points of the newest finished read into estimate_roof_points (the customer
 * page prints that copy), but only when the points were saved for the address the estimate still has. A re-send replaces
 * it, a send with no confirmed points (or with the points hidden) deletes it, a send with no real handoff leaves it alone,
 * and a failure in the step never fails the send. The copy carries the handoff time the same send stamps on the estimate,
 * so a copy a later send could not replace or delete is older than that stamp and the page does not print it. The real estimate-roof-points service runs against a small in-memory stand-in for the two
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
const { roofPointsDocBlock } = require('../services/estimate-roof-points');

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
  context_key: `e:${over.estimate_id || 'est-1'}`,
  // The read names the customer who held the estimate when its points were saved (estimateRow's customer).
  customer_id: 'cust-1',
  status: 'done',
  tech_pins: [
    { x: 0.25, y: 0.4, type: 'roof_returns_and_valleys', note: 'front left' },
    { x: 0.7, y: 0.55, type: 'trees_touching_roof' },
  ],
  hide_on_estimate: false,
  points_address: '12 Synthetic Way, Bradenton, FL 34203',
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
  let pointsOnly = false;
  // The SQL filter: reads whose points the technician set (a stored photo centre, or a list). Applied in list().
  q.whereRaw = jest.fn(() => { pointsOnly = true; return q; });
  q.orderBy = jest.fn(() => q);
  const list = () => {
    if (failOn === 'reads') throw new Error('reads down');
    return reads
      .filter((r) => Object.entries(where).every(([k, v]) => r[k] === v))
      .filter((r) => !pointsOnly || r.crop_lat != null || Array.isArray(r.tech_pins))
      .sort((a, b) => b.created_at - a.created_at);
  };
  q.select = jest.fn(async () => list());
  q.first = jest.fn(async () => list()[0]);
  return q;
}
function pointsBuilder() {
  const q = {};
  let key = null;
  // A send's write names only a copy that no later handoff wrote (`delivered_at <= ?`); the upsert carries the same test.
  let notAfter = null;
  const newer = (id, at) => id in store && at != null && new Date(store[id].delivered_at) > new Date(at);
  q.where = jest.fn((...args) => {
    if (args.length === 1) key = args[0].estimate_id;
    else [, , notAfter] = args;
    return q;
  });
  q.first = jest.fn(async () => store[key]);
  q.del = jest.fn(async () => {
    if (failOn === 'write') throw new Error('write down');
    const had = key in store && !newer(key, notAfter);
    if (had) delete store[key];
    return had ? 1 : 0;
  });
  q.insert = jest.fn((rec) => ({
    onConflict: () => ({
      merge: () => ({
        where: (_column, _op, at) => ({
          returning: async () => {
            if (failOn === 'write') throw new Error('write down');
            if (newer(rec.estimate_id, at)) return [];
            store[rec.estimate_id] = { ...rec, snapshot: JSON.parse(rec.snapshot) };
            return [{ estimate_id: rec.estimate_id }];
          },
        }),
      }),
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

// The handoff time a send stamped on the estimate row: the newest deliveryState.lastDeliveredAt among the JSON merge
// patches it wrote (db.raw is a pass-through here, so its bindings are the patches).
function stampedHandoff() {
  const stamps = db.raw.mock.calls
    .map(([, bindings]) => { try { return JSON.parse(bindings[0]).deliveryState.lastDeliveredAt; } catch { return null; } })
    .filter(Boolean);
  return stamps[stamps.length - 1];
}
const pause = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

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

  test('the copy carries the handoff time this send stamps on the estimate, and the page prints it', async () => {
    reads = [read()];
    await router.sendEstimateNow(estimateRow(), 'email');
    const stamped = stampedHandoff();
    expect(Number.isFinite(Date.parse(stamped))).toBe(true);
    expect(store['est-1'].delivered_at).toBe(stamped);
    const sent = estimateRow({ estimate_data: { deliveryState: { lastDeliveredAt: stamped } } });
    expect((await roofPointsDocBlock(sent, { knex: db })).roofPoints.pins).toHaveLength(2);
  });

  test('points removed, then the re-send cannot delete the copy: the copy is older than the new handoff and the page omits it', async () => {
    reads = [read()];
    await router.sendEstimateNow(estimateRow(), 'email');
    const first = stampedHandoff();
    await pause(5);
    reads = [read({ tech_pins: [] })];
    failOn = 'write';
    const result = await router.sendEstimateNow(estimateRow({ estimate_data: { deliveryState: { firstDeliveredAt: first, lastDeliveredAt: first } } }), 'email');
    failOn = null;
    expect(result.sent).toBe(true);
    const second = stampedHandoff();
    expect(Date.parse(second)).toBeGreaterThan(Date.parse(first));
    // The delete failed: the first send's copy is still stored, under the first handoff time.
    expect(store['est-1'].delivered_at).toBe(first);
    const now = estimateRow({ estimate_data: { deliveryState: { lastDeliveredAt: second } } });
    expect(await roofPointsDocBlock(now, { knex: db })).toEqual({});
    // Before the re-send the same copy was printed.
    const before = estimateRow({ estimate_data: { deliveryState: { lastDeliveredAt: first } } });
    reads = [read()];
    expect((await roofPointsDocBlock(before, { knex: db })).roofPoints).toBeDefined();
  });

  test('a re-send replaces the copy with the points as they stand now; between sends the copy does not change', async () => {
    reads = [read()];
    await router.sendEstimateNow(estimateRow(), 'email');
    const first = JSON.stringify(store['est-1'].snapshot);
    // The technician edits the points after the send: the sent copy keeps its content.
    reads = [read({ tech_pins: [{ x: 0.1, y: 0.1, type: 'chimney_or_flue' }] })];
    expect(JSON.stringify(store['est-1'].snapshot)).toBe(first);
    await router.sendEstimateNow(estimateRow(), 'email');
    expect(store['est-1'].snapshot.pins).toEqual([{ n: 1, x: 0.1, y: 0.1, type: 'chimney_or_flue', label: 'Chimney or flue', action: 'screen' }]);
  });

  test('the newest finished read with saved points wins over an older one', async () => {
    reads = [
      read({ id: 'read-old', created_at: new Date('2026-11-19T15:00:00Z') }),
      read({ id: 'read-new', tech_pins: [{ x: 0.5, y: 0.5, type: 'gable_vents' }], created_at: new Date('2026-11-20T15:00:00Z') }),
      read({ id: 'read-unsaved', tech_pins: null, crop_lat: null, crop_lng: null, created_at: new Date('2026-11-20T16:00:00Z') }),
    ];
    await router.sendEstimateNow(estimateRow(), 'email');
    expect(store['est-1'].read_id).toBe('read-new');
  });

  test("an estimate takes only its own customer's read: never the newer read another customer had on it, and none with no customer", async () => {
    // While the estimate had no customer, staff read this roof for two customers. Each read is keyed to its customer.
    const forA = read({ id: 'read-a', context_key: 'e:est-1|c:cust-1', customer_id: 'cust-1', tech_pins: [{ x: 0.2, y: 0.2, type: 'gable_vents', note: 'note for A' }] });
    const forB = read({
      id: 'read-b', context_key: 'e:est-1|c:cust-2', customer_id: 'cust-2', created_at: new Date('2026-11-20T16:00:00Z'),
      tech_pins: [{ x: 0.3, y: 0.3, type: 'gable_vents', note: 'note for B' }],
    });
    const send = async (row) => {
      db.mockImplementation((table) => {
        if (table === 'roof_entry_reads') return readsBuilder();
        if (table === 'estimate_roof_points') return pointsBuilder();
        return makeBuilder(row);
      });
      await router.sendEstimateNow(row, 'email');
      return row;
    };
    reads = [forA, forB];
    // The estimate now belongs to customer A (cust-1): B's read is newer and is not taken.
    const owned = await send(estimateRow());
    expect(store['est-1'].read_id).toBe('read-a');
    expect(JSON.stringify(store['est-1'].snapshot)).toContain('note for A');
    expect(JSON.stringify(store['est-1'].snapshot)).not.toContain('note for B');
    // Handed to customer B after the send, with no new send: the page does not show A's copy.
    const stamp = { deliveryState: { lastDeliveredAt: stampedHandoff() } };
    expect((await roofPointsDocBlock({ ...owned, estimate_data: stamp }, { knex: db })).roofPoints).toBeDefined();
    expect(await roofPointsDocBlock({ ...owned, customer_id: 'cust-2', estimate_data: stamp }, { knex: db })).toEqual({});
    // No customer on the estimate: neither customer's read can be shown to whoever holds the link.
    await send(estimateRow({ customer_id: null }));
    expect(store['est-1']).toBeUndefined();
    // Points saved for a lead (the plain read names no customer) are taken while the estimate has no customer.
    const forLead = read({ id: 'read-plain', customer_id: null, created_at: new Date('2026-11-20T18:00:00Z') });
    reads = [forA, forB, forLead];
    await send(estimateRow({ customer_id: null }));
    expect(store['est-1'].read_id).toBe('read-plain');
    // Once the estimate has a customer, the lead's read is not taken, though it is the newest: the customer's own is.
    await send(estimateRow());
    expect(store['est-1'].read_id).toBe('read-a');
    // Lead, then customer A, then customer B: B gets nothing, and the page shows B nothing from the lead's copy.
    reads = [forLead];
    await send(estimateRow({ customer_id: null }));
    expect(store['est-1'].read_id).toBe('read-plain');
    const lead = { deliveryState: { lastDeliveredAt: stampedHandoff() } };
    expect(await roofPointsDocBlock(estimateRow({ estimate_data: lead }), { knex: db })).toEqual({});
    expect(await roofPointsDocBlock(estimateRow({ customer_id: 'cust-2', estimate_data: lead }), { knex: db })).toEqual({});
    await send(estimateRow({ customer_id: 'cust-2' }));
    expect(store['est-1']).toBeUndefined();
  });

  test('the copy names the customer it was frozen for: a lead copy is not shown to the first customer until the next send', async () => {
    const send = async (row) => {
      db.mockImplementation((table) => {
        if (table === 'roof_entry_reads') return readsBuilder();
        if (table === 'estimate_roof_points') return pointsBuilder();
        return makeBuilder(row);
      });
      await router.sendEstimateNow(row, 'email');
    };
    // Sent while the estimate had no customer: the copy is frozen for no customer and shows on the lead's link.
    const forLead = read({ customer_id: null, tech_pins: [{ x: 0.2, y: 0.2, type: 'gable_vents', note: 'lead note' }] });
    reads = [forLead];
    await send(estimateRow({ customer_id: null }));
    expect(store['est-1'].customer_id).toBeNull();
    const stamp = { deliveryState: { lastDeliveredAt: stampedHandoff() } };
    expect((await roofPointsDocBlock(estimateRow({ customer_id: null, estimate_data: stamp }), { knex: db })).roofPoints).toBeDefined();
    // The estimate gets customer A and staff save points on the same read, so the read names A now. The lead's frozen
    // copy still holds the lead's notes: it is not shown to A before a send freezes a copy for A.
    reads = [{ ...forLead, customer_id: 'cust-1', tech_pins: [{ x: 0.2, y: 0.2, type: 'gable_vents', note: 'note for A' }] }];
    expect(await roofPointsDocBlock(estimateRow({ estimate_data: stamp }), { knex: db })).toEqual({});
    await send(estimateRow());
    expect(store['est-1'].customer_id).toBe('cust-1');
    const shown = (await roofPointsDocBlock(estimateRow({ estimate_data: { deliveryState: { lastDeliveredAt: stampedHandoff() } } }), { knex: db })).roofPoints;
    expect(JSON.stringify(shown)).toContain('note for A');
    expect(JSON.stringify(shown)).not.toContain('lead note');
  });

  test('a plain read taken while customer A held the estimate is not sent to customer B after the estimate is reassigned', async () => {
    // Read with the estimate and its customer: the key is the plain one, and the row names customer A (cust-1).
    reads = [read({ customer_id: 'cust-1', tech_pins: [{ x: 0.2, y: 0.2, type: 'gable_vents', note: 'note for A' }] })];
    const send = async (row) => {
      db.mockImplementation((table) => {
        if (table === 'roof_entry_reads') return readsBuilder();
        if (table === 'estimate_roof_points') return pointsBuilder();
        return makeBuilder(row);
      });
      await router.sendEstimateNow(row, 'email');
    };
    await send(estimateRow());
    expect(store['est-1'].read_id).toBe('read-1');
    // Reassigned to customer B with no new send: the page does not show A's copy.
    const stamp = { deliveryState: { lastDeliveredAt: stampedHandoff() } };
    expect((await roofPointsDocBlock(estimateRow({ estimate_data: stamp }), { knex: db })).roofPoints).toBeDefined();
    expect(await roofPointsDocBlock(estimateRow({ customer_id: 'cust-2', estimate_data: stamp }), { knex: db })).toEqual({});
    expect(await roofPointsDocBlock(estimateRow({ customer_id: null, estimate_data: stamp }), { knex: db })).toEqual({});
    // A send to customer B takes nothing and deletes A's copy.
    await send(estimateRow({ customer_id: 'cust-2' }));
    expect(store['est-1']).toBeUndefined();
  });

  test('points cleared on the newest read: the copy is deleted and the older list does not come back', async () => {
    const later = new Date('2026-11-20T16:00:00Z');
    reads = [read()];
    await router.sendEstimateNow(estimateRow(), 'email');
    expect(store['est-1'].read_id).toBe('read-1');
    // A clear (pins: null) leaves the stored photo centre on the read, so the read still counts as the newest one set.
    reads = [read(), read({ id: 'read-2', tech_pins: null, created_at: later })];
    await router.sendEstimateNow(estimateRow(), 'email');
    expect(store['est-1']).toBeUndefined();
    // A newer read on which no list was ever saved is not a clear: the older read's points stay.
    reads = [read(), read({ id: 'read-3', tech_pins: null, crop_lat: null, crop_lng: null, created_at: later })];
    await router.sendEstimateNow(estimateRow(), 'email');
    expect(store['est-1'].read_id).toBe('read-1');
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

  test('points saved for another address are not copied, and an older copy is deleted (the estimate moved homes)', async () => {
    reads = [read()];
    await router.sendEstimateNow(estimateRow(), 'email');
    expect(store['est-1']).toBeDefined();
    const moved = estimateRow({ address: '99 Other Road, Sarasota, FL 34232' });
    db.mockImplementation((table) => {
      if (table === 'roof_entry_reads') return readsBuilder();
      if (table === 'estimate_roof_points') return pointsBuilder();
      return makeBuilder(moved);
    });
    const result = await router.sendEstimateNow(moved, 'email');
    expect(result.sent).toBe(true);
    expect(store['est-1']).toBeUndefined();
  });

  test('points saved before the address was recorded (points_address null) are not copied', async () => {
    reads = [read({ points_address: null })];
    await router.sendEstimateNow(estimateRow(), 'email');
    expect(store).toEqual({});
  });

  test('points saved for the same street in another ZIP are not copied; a ZIP on one side only still is', async () => {
    reads = [read({ points_address: '12 Synthetic Way, Bradenton, FL 34208' })];
    await router.sendEstimateNow(estimateRow(), 'email');
    expect(store).toEqual({});
    reads = [read({ points_address: '12 Synthetic Way, Bradenton, FL' })];
    await router.sendEstimateNow(estimateRow(), 'email');
    expect(store['est-1']).toBeDefined();
  });

  test('the copy keeps the ZIP that either address names, so a later ZIP change on the estimate takes the roof off', async () => {
    const stamp = () => ({ deliveryState: { lastDeliveredAt: stampedHandoff() } });
    const send = async (estimateAddress, pointsAddress) => {
      const row = estimateRow({ address: estimateAddress });
      db.mockImplementation((table) => {
        if (table === 'roof_entry_reads') return readsBuilder();
        if (table === 'estimate_roof_points') return pointsBuilder();
        return makeBuilder(row);
      });
      reads = [read({ points_address: pointsAddress })];
      await router.sendEstimateNow(row, 'email');
    };
    const page = (address) => roofPointsDocBlock(estimateRow({ address, estimate_data: stamp() }), { knex: db });

    // The points name ZIP 34203; the estimate has no ZIP at the send.
    await send('12 Synthetic Way, Bradenton, FL', '12 Synthetic Way, Bradenton, FL 34203');
    expect(store['est-1'].address).toBe('12 Synthetic Way, Bradenton, FL 34203');
    expect((await page('12 Synthetic Way, Bradenton, FL')).roofPoints).toBeDefined();
    expect((await page('12 Synthetic Way, Bradenton, FL 34203')).roofPoints).toBeDefined();
    // Staff then correct the estimate to the same street in another ZIP: another home.
    expect(await page('12 Synthetic Way, Bradenton, FL 34208')).toEqual({});

    // The other way round: only the estimate named the ZIP at the send.
    await send('12 Synthetic Way, Bradenton, FL 34203', '12 Synthetic Way, Bradenton, FL');
    expect(store['est-1'].address).toBe('12 Synthetic Way, Bradenton, FL 34203');
    expect(await page('12 Synthetic Way, Bradenton, FL 34208')).toEqual({});
  });

  test('an estimate whose address is blank or only punctuation gets no copy, whatever the points name', async () => {
    for (const [estimateAddress, pointsAddress] of [['   ', '12 Synthetic Way, Bradenton, FL 34203'], [' - ', ' - '], ['.', '   ']]) {
      const blank = estimateRow({ address: estimateAddress });
      db.mockImplementation((table) => {
        if (table === 'roof_entry_reads') return readsBuilder();
        if (table === 'estimate_roof_points') return pointsBuilder();
        return makeBuilder(blank);
      });
      reads = [read({ points_address: pointsAddress })];
      const result = await router.sendEstimateNow(blank, 'email');
      expect(result.sent).toBe(true);
      expect(store).toEqual({});
    }
  });

  test('a send with no real provider handoff (a deduplicated email) leaves the copy alone', async () => {
    reads = [read()];
    await router.sendEstimateNow(estimateRow(), 'email');
    const before = JSON.stringify(store['est-1']);
    reads = [read({ tech_pins: [{ x: 0.1, y: 0.1, type: 'chimney_or_flue' }] })];
    EmailTemplateLibrary.sendTemplate.mockResolvedValue({ sent: true, providerAttempted: false, providerAccepted: false });
    const result = await router.sendEstimateNow(estimateRow(), 'email');
    expect(result.sent).toBe(true);
    expect(JSON.stringify(store['est-1'])).toBe(before);
  });

  // The claimed-sibling group send shape from admin-estimates-send-channel-links (one builder for every estimates query),
  // with the two roof tables routed to the in-memory stand-ins.
  function groupSend({ failSiblingPublish = false } = {}) {
    const anchor = estimateRow({ estimate_group_id: 'grp-roof' });
    const sibling = estimateRow({ id: 'est-2', token: 'tok-2', status: 'draft', estimate_group_id: 'grp-roof', estimate_data: '{}',
      address: '14 Synthetic Way, Bradenton, FL 34203' });
    db.mockImplementation((table) => {
      if (table === 'roof_entry_reads') return readsBuilder();
      if (table === 'estimate_roof_points') return pointsBuilder();
      const b = makeBuilder(anchor);
      let groupProbe = false; let claimable = false;
      b.where = jest.fn((clause) => { if (clause?.estimate_group_id && !clause.id) groupProbe = true; return b; });
      b.whereNot = jest.fn(() => b);
      b.whereIn = jest.fn((column, statuses) => { if (column === 'status' && statuses.includes('draft')) claimable = true; return b; });
      b.modify = jest.fn((callback) => { callback(b); return b; });
      b.first = jest.fn(async () => (groupProbe ? null : anchor));
      b.select = jest.fn(async () => (claimable ? [sibling] : []));
      b.then = (resolve, reject) => Promise.resolve(claimable ? [sibling] : []).then(resolve, reject);
      b.update = jest.fn(async (patch) => {
        if (patch.status === 'sending') sibling.status = 'sending';
        if (patch.sent_at && patch.expires_at && patch.followup_expiring_sent) {
          if (failSiblingPublish) throw new Error('sibling publication down');
          sibling.status = 'sent';
        }
        return 1;
      });
      return b;
    });
    reads = [read(), read({ id: 'read-2', estimate_id: 'est-2', points_address: sibling.address })];
    return router.sendEstimateNow(anchor, 'email', { callerPreClaimed: true });
  }

  test("a group send copies each sibling it published, from that sibling's own read and address", async () => {
    const result = await groupSend();
    expect(result.sent).toBe(true);
    expect(store['est-1']).toMatchObject({ read_id: 'read-1' });
    expect(store['est-2']).toMatchObject({ read_id: 'read-2', address: '14 Synthetic Way, Bradenton, FL 34203' });
    // One handoff: both copies carry the time the anchor's and the sibling's delivery state get.
    expect(store['est-1'].delivered_at).toBe(stampedHandoff());
    expect(store['est-2'].delivered_at).toBe(store['est-1'].delivered_at);
  });

  test('a sibling whose publication fails (released for a re-send) gets no copy; the anchor keeps its own', async () => {
    const result = await groupSend({ failSiblingPublish: true });
    expect(result.sent).toBe(true);
    expect(store['est-1']).toBeDefined();
    expect(store['est-2']).toBeUndefined();
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
