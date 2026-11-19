/**
 * Estimate call list (admin only, nothing sent to a customer):
 *   - PATCH /api/admin/estimates/:id takes a staff loss reason on an EXPIRED row with no status change;
 *     every live row keeps the old refusal.
 *   - Reviving an expired row (extend, direct and grouped siblings) sheds a staff loss reason.
 *   - lastCalledAt: one batched call_log read for the viewed rows, phone matched as call_log.to_phone is stored.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

jest.mock('../models/db', () => {
  const db = jest.fn();
  db.fn = { now: jest.fn(() => 'NOW()') };
  db.raw = jest.fn((sql) => ({ __raw: sql }));
  db.transaction = jest.fn(async (run) => run(db));
  return db;
});
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => next(),
  requireTechOrAdmin: (req, res, next) => next(),
  requireAdmin: (req, res, next) => next(),
}));
jest.mock('../services/logger', () => ({ warn: jest.fn(), error: jest.fn(), info: jest.fn() }));
jest.mock('../services/short-url', () => ({ shortenOrPassthrough: jest.fn() }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../services/estimate-delivery-options', () => ({
  estimateDataHasQuoteRequirement: jest.fn(() => false),
  estimateDataHasUnresolvedManagerApproval: jest.fn(() => false),
  validateEstimateDeliveryOptions: jest.fn(() => null),
}));
jest.mock('../services/estimate-pricing-audit', () => ({
  buildEstimatePricingAudit: jest.fn(),
  buildEstimatePricingRiskBatch: jest.fn(),
  getLatestEstimatePricingAuditSnapshot: jest.fn(),
  saveEstimatePricingAuditSnapshot: jest.fn(),
}));
jest.mock('../services/lead-estimate-link', () => ({ markLinkedLeadEstimateSent: jest.fn() }));
jest.mock('../services/estimate-manual-acceptance', () => ({ markEstimateManuallyAccepted: jest.fn() }));
jest.mock('../services/estimate-conversion-guard', () => ({
  customerConvertedSince: jest.fn(async () => ({ converted: false })),
  whereConversionEligibilitySignal: jest.fn((q) => q),
  whereNoConversionBeforeEstimate: jest.fn((q) => q),
  excludePendingFirstBookings: jest.fn((q) => q),
  NON_LIVE_APPOINTMENT_STATUSES: ['cancelled', 'rescheduled', 'skipped', 'no_show'],
}));
jest.mock('../services/admin-estimate-persistence', () => ({
  createOrReuseAdminEstimate: jest.fn(),
  estimateExpiresAt: jest.fn(),
  estimateViewUrl: jest.fn(),
}));
jest.mock('../routes/estimate-public', () => ({ acceptanceServiceLists: jest.fn(), bookingServiceFor: jest.fn() }));
jest.mock('../services/email-template-library', () => ({ sendTemplate: jest.fn() }));
jest.mock('../services/sendgrid-mail', () => ({ isConfigured: jest.fn(() => false) }));
jest.mock('../services/visual-service-notes', () => ({
  VISUAL_SERVICE_NOTES_FLAG: 'visual_service_notes',
  getVisualServiceNotesSettings: jest.fn(),
  isVisualServiceNotesEnabled: jest.fn(async () => false),
  setVisualServiceNotesSettings: jest.fn(),
}));

const db = require('../models/db');
const adminEstimatesRouter = require('../routes/admin-estimates');
const { lastCalledAtByEstimateId, callLogPhoneFor, CUSTOMER_ANSWERED_SQL, estimateListQuery } = require('../services/estimate-call-list');
const { extendEstimate } = require('../services/estimate-extension');

function routeHandler(router, path, method) {
  const layer = router.stack.find((entry) => entry.route?.path === path && entry.route?.methods?.[method]);
  if (!layer) throw new Error(`Route not found: ${method.toUpperCase()} ${path}`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function makeBuilder({ first = null, updateCount = 1 } = {}) {
  const builder = {};
  for (const m of ['where', 'whereNotIn', 'whereNull', 'whereNotNull', 'whereIn', 'andWhere', 'whereRaw', 'whereNot', 'orderBy', 'limit']) {
    builder[m] = jest.fn(() => builder);
  }
  builder.modify = jest.fn((fn) => { fn(builder); return builder; });
  builder.first = jest.fn(async () => first);
  builder.update = jest.fn(async () => updateCount);
  return builder;
}

function makeRes() {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

const SENT = '2026-10-01T12:00:00Z';

describe('PATCH /api/admin/estimates/:id staff reason on an expired row', () => {
  const patchHandler = routeHandler(adminEstimatesRouter, '/:id', 'patch');
  const expiredRow = (extra = {}) => ({
    id: 'e1', status: 'expired', sent_at: SENT, viewed_at: SENT, disposition: 'expired_viewed', disposition_source: 'system', archived_at: null, ...extra,
  });

  beforeEach(() => { db.mockReset(); });

  async function run(row, body) {
    db.mockReset();
    const read = makeBuilder({ first: row });
    const write = makeBuilder({ updateCount: 1 });
    db.mockImplementationOnce(() => read).mockImplementationOnce(() => write);
    const res = makeRes();
    await patchHandler({ params: { id: 'e1' }, body }, res, jest.fn());
    return { res, write };
  }

  test('stamps the reason as staff, leaves the status alone, and guards on status = expired', async () => {
    const { res, write } = await run(expiredRow(), { disposition: 'declined_competitor', competitorName: 'Rival Pest', competitorPrice: '$45', dispositionNote: 'went cheaper' });
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({ success: true });
    const payload = write.update.mock.calls[0][0];
    expect(payload).toMatchObject({ disposition: 'declined_competitor', disposition_source: 'staff', competitor_name: 'Rival Pest', competitor_price: 45, disposition_note: 'went cheaper' });
    expect(payload).not.toHaveProperty('status');
    expect(payload).not.toHaveProperty('declined_at');
    expect(write.where).toHaveBeenCalledWith({ status: 'expired' });
  });

  test('a request that repeats status expired is still a reason-only edit', async () => {
    const { res, write } = await run(expiredRow(), { status: 'expired', disposition: 'diy' });
    expect(res.json).toHaveBeenCalledWith({ success: true });
    expect(write.update.mock.calls[0][0]).not.toHaveProperty('status');
  });

  test.each(['draft', 'scheduled', 'sending', 'sent', 'viewed', 'send_failed', 'accepted'])('a %s row is still refused', async (status) => {
    const { res, write } = await run({ id: 'e1', status, sent_at: SENT, viewed_at: SENT }, { disposition: 'declined_price' });
    expect(res.status).toHaveBeenCalledWith(400);
    expect(write.update).not.toHaveBeenCalled();
  });

  test('a request that tries to change the status is refused', async () => {
    const { res } = await run(expiredRow(), { status: 'declined', disposition: 'declined_price' });
    expect(res.status).toHaveBeenCalledWith(409);
  });

  test('a never-sent expired draft (expired_unsent) is refused', async () => {
    const { res } = await run(expiredRow({ sent_at: null, viewed_at: null, disposition: 'expired_unsent' }), { disposition: 'declined_price' });
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('the validator still applies (Other needs a note, unknown code refused)', async () => {
    expect((await run(expiredRow(), { disposition: 'declined_other' })).res.status).toHaveBeenCalledWith(400);
    expect((await run(expiredRow(), { disposition: 'expired_viewed' })).res.status).toHaveBeenCalledWith(400);
  });

  test('a revive racing the write (0 rows) answers 409', async () => {
    const read = makeBuilder({ first: expiredRow() });
    const write = makeBuilder({ updateCount: 0 });
    db.mockImplementationOnce(() => read).mockImplementationOnce(() => write);
    const res = makeRes();
    await patchHandler({ params: { id: 'e1' }, body: { disposition: 'diy' } }, res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(409);
  });
});

describe('revive clears a staff loss reason', () => {
  // `locked` = the row the extension reads under FOR UPDATE; the staff reason is judged on it.
  function revivalBuilder(locked = { estimate_data: {}, disposition: 'declined_competitor', disposition_source: 'staff' }) {
    const updates = [];
    const q = {};
    for (const m of ['where', 'whereNull', 'whereRaw', 'whereNot', 'whereIn', 'whereNotNull', 'orWhere', 'orWhereNotNull', 'orderBy', 'forUpdate', 'modify']) {
      q[m] = jest.fn((arg) => { if (typeof arg === 'function' && m === 'where') arg.call(q, q); return q; });
    }
    q.first = jest.fn(async () => locked);
    q.select = jest.fn(async () => [{ id: 'e1', ...locked }]);
    q.update = jest.fn(async (payload) => { updates.push(payload); return 1; });
    return { q, updates };
  }

  const staffExpired = (extra = {}) => ({
    id: 'e1', status: 'expired', sent_at: SENT, viewed_at: SENT, expires_at: '2026-10-08T00:00:00Z', archived_at: null,
    estimate_data: {}, disposition: 'declined_competitor', disposition_source: 'staff', estimate_group_id: null, ...extra,
  });

  beforeEach(() => { db.mockReset(); db.fn = { now: jest.fn(() => 'NOW()') }; });

  test('the extended row sheds disposition, competitor fields and the legacy label', async () => {
    const { q, updates } = revivalBuilder();
    db.mockImplementation(() => q);
    await extendEstimate({ estimate: staffExpired(), days: 7, silent: true, entryPoint: 'test' });
    expect(updates[0]).toMatchObject({
      status: 'viewed', disposition: null, disposition_source: null, disposition_at: null, disposition_note: null,
      competitor_name: null, competitor_price: null, decline_reason: null,
    });
    // The locked read carries the loss columns the verdict needs.
    expect(q.first).toHaveBeenCalledWith('estimate_data', 'disposition', 'disposition_source');
  });

  test('a Pick reason saved after the snapshot (seen only on the locked row) is still cleared', async () => {
    const { q, updates } = revivalBuilder({ estimate_data: {}, disposition: 'declined_price', disposition_source: 'staff' });
    db.mockImplementation(() => q);
    // The caller read the row before the reason landed: its snapshot still shows the sweep's code.
    await extendEstimate({ estimate: staffExpired({ disposition: 'expired_viewed', disposition_source: 'system' }), days: 7, silent: true, entryPoint: 'test' });
    expect(updates[0]).toMatchObject({
      status: 'viewed', disposition: null, disposition_source: null, competitor_name: null, competitor_price: null, decline_reason: null,
    });
  });

  test('the sweep codes still clear as before, and a system code does not touch decline fields', async () => {
    const { q, updates } = revivalBuilder({ estimate_data: {}, disposition: 'expired_viewed', disposition_source: 'system' });
    db.mockImplementation(() => q);
    await extendEstimate({ estimate: staffExpired({ disposition: 'expired_viewed', disposition_source: 'system' }), days: 7, silent: true, entryPoint: 'test' });
    expect(updates[0]).toMatchObject({ disposition: null, disposition_source: null });
    expect(updates[0]).not.toHaveProperty('competitor_name');
    expect(updates[0]).not.toHaveProperty('decline_reason');
  });

  test('a live viewed row (no revive) keeps whatever it carries', async () => {
    const { q, updates } = revivalBuilder({ estimate_data: {}, disposition: null, disposition_source: null });
    db.mockImplementation(() => q);
    await extendEstimate({ estimate: staffExpired({ status: 'viewed', disposition: null, disposition_source: null }), days: 7, silent: true, entryPoint: 'test' });
    expect(updates[0]).not.toHaveProperty('disposition');
  });

  test('grouped siblings revive with a staff-aware CASE for every loss column', async () => {
    const { q, updates } = revivalBuilder();
    db.mockImplementation(() => q);
    await extendEstimate({ estimate: staffExpired({ estimate_group_id: 'g1' }), days: 7, silent: true, entryPoint: 'test' });
    const sibling = updates.find((u) => u.followup_expiring_sent === true);
    expect(sibling).toBeTruthy();
    for (const column of ['disposition', 'disposition_source', 'disposition_at', 'disposition_note', 'competitor_name', 'competitor_price', 'decline_reason']) {
      expect(sibling[column].__raw).toContain("disposition_source = 'staff'");
      expect(sibling[column].__raw).toMatch(new RegExp(`ELSE ${column} END$`));
    }
  });
});

describe('lastCalledAt (one batched read)', () => {
  function callLogDb(rows) {
    const q = {};
    for (const m of ['where', 'whereIn', 'whereRaw', 'groupBy']) q[m] = jest.fn(() => q);
    q.select = jest.fn(() => q);
    q.max = jest.fn(async () => rows);
    const database = jest.fn(() => q);
    return { database, q };
  }

  test('matches phones the way the click-to-call rows store them (E.164) and reads once', async () => {
    const { database, q } = callLogDb([{ to_phone: '+19415550101', last_called_at: '2026-11-01T14:00:00Z' }]);
    const estimates = [
      { id: 'a', status: 'viewed', customer_phone: '(941) 555-0101' },
      { id: 'b', status: 'viewed', customer_phone: '941-555-0101' },
      { id: 'c', status: 'viewed', customer_phone: '+1 941 555 0202' },
      { id: 'd', status: 'viewed', customer_phone: '' },
      { id: 'e', status: 'sent', customer_phone: '9415550101' },
      { id: 'f', status: 'expired', customer_phone: '9415550101' },
    ];
    const now = Date.parse('2026-11-01T15:00:00Z');
    const out = await lastCalledAtByEstimateId(database, estimates, now);
    expect(database).toHaveBeenCalledTimes(1);
    expect(database).toHaveBeenCalledWith('call_log');
    expect(q.where).toHaveBeenCalledWith({ direction: 'outbound' });
    expect(q.whereIn).toHaveBeenCalledWith('to_phone', ['+19415550101', '+19415550202']);
    // Only a call the CUSTOMER answered counts: status and bridged_at describe the staff leg, so the
    // read requires the bell's answered-leg proof (customer_leg completed with seconds, or a recording).
    expect(q.whereRaw).toHaveBeenCalledWith(CUSTOMER_ANSWERED_SQL);
    // A voice-agent sandbox (test) call never counts as calling the customer.
    expect(q.whereRaw).toHaveBeenCalledWith("COALESCE(??, '') <> ?", ['source', 'voice_relay_sandbox']);
    expect(CUSTOMER_ANSWERED_SQL).toContain('bridged_at IS NOT NULL');
    expect(CUSTOMER_ANSWERED_SQL).toContain("metadata->'customer_leg'->>'status' = 'completed'");
    expect(CUSTOMER_ANSWERED_SQL).toContain('recording_duration_seconds > 0');
    expect(CUSTOMER_ANSWERED_SQL).not.toContain('?');
    expect(q.whereIn).not.toHaveBeenCalledWith('status', expect.anything());
    expect(q.where).toHaveBeenCalledWith('created_at', '>=', new Date(now - 30 * 24 * 60 * 60 * 1000));
    expect(out.get('a')).toBe('2026-11-01T14:00:00Z');
    expect(out.get('b')).toBe('2026-11-01T14:00:00Z');
    expect(out.get('c')).toBeNull();
    expect(out.has('d')).toBe(false);
    expect(out.has('e')).toBe(false);
    expect(out.has('f')).toBe(false);
  });

  test('no viewed row with a phone = no query at all', async () => {
    const { database } = callLogDb([]);
    const out = await lastCalledAtByEstimateId(database, [{ id: 'a', status: 'sent', customer_phone: '9415550101' }, { id: 'b', status: 'viewed', customer_phone: null }]);
    expect(database).not.toHaveBeenCalled();
    expect(out.size).toBe(0);
  });

  test('callLogPhoneFor refuses garbage', () => {
    expect(callLogPhoneFor({ customer_phone: 'abc' })).toBeNull();
    expect(callLogPhoneFor({ customer_phone: '(941) 555-0101' })).toBe('+19415550101');
  });
});

// The list route's row selection, shared with the 9 AM Call today push (estimate-call-today-push.js).
describe('estimateListQuery', () => {
  const recorder = () => {
    const calls = [];
    const q = new Proxy({}, { get: (_t, name) => (...args) => { calls.push([name, ...args]); return q; } });
    return { q, calls };
  };

  test('joins the creator, newest first, hides archived rows by default', () => {
    const { q, calls } = recorder();
    estimateListQuery(() => q);
    expect(calls).toEqual([
      ['leftJoin', 'technicians', 'estimates.created_by_technician_id', 'technicians.id'],
      ['select', 'estimates.*', 'technicians.name as created_by_name'],
      ['orderBy', 'estimates.created_at', 'desc'],
      // A stable tie-breaker: the push and the page cut the newest 2,000 at the same rows.
      ['orderBy', 'estimates.id', 'desc'],
      ['whereNull', 'estimates.archived_at'],
    ]);
  });

  test('status, source list and archived modes narrow the same query', () => {
    const only = recorder();
    estimateListQuery(() => only.q, { status: 'draft', sources: ['a', 'b'], archived: 'only' });
    expect(only.calls).toContainEqual(['where', 'estimates.status', 'draft']);
    expect(only.calls).toContainEqual(['whereIn', 'estimates.source', ['a', 'b']]);
    expect(only.calls).toContainEqual(['whereNotNull', 'estimates.archived_at']);
    const all = recorder();
    estimateListQuery(() => all.q, { archived: 'all' });
    expect(all.calls.map(([name]) => name)).not.toContain('whereNull');
    expect(all.calls.map(([name]) => name)).not.toContain('whereNotNull');
  });
});
