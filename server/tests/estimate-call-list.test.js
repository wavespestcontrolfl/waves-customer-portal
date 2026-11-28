/**
 * Estimate call list (admin only, nothing sent to a customer):
 *   - PATCH /api/admin/estimates/:id takes a staff loss reason on an EXPIRED row with no status change;
 *     every live row keeps the old refusal.
 *   - Reviving an expired row (extend, direct and grouped siblings) sheds a staff loss reason.
 *   - lastCalledAt: one batched call_log read for the viewed rows, phone matched as call_log.to_phone is stored.
 *   - Call outcomes: POST /api/admin/estimates/:id/call-outcome saves one activity_log row; one batched read per list.
 *   - Still deciding: one batched read of the reason a customer sent on the estimate page; the shared rule shows that
 *     row at once and keeps it until someone answers the reason.
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

  test('sentOnly includes accepted/declined rows even when sent_at is null (mid-flight acceptance/decline)', () => {
    const outer = recorder();
    const inner = recorder();
    estimateListQuery(() => outer.q, { sentOnly: true });
    const whereCallback = outer.calls.find(([name, arg]) => name === 'where' && typeof arg === 'function')?.[1];
    expect(typeof whereCallback).toBe('function');
    whereCallback.call(inner.q);
    expect(inner.calls).toContainEqual(['whereNotNull', 'estimates.sent_at']);
    const statusCall = inner.calls.find(([name]) => name === 'orWhereIn');
    expect(statusCall[1]).toBe('estimates.status');
    expect(statusCall[2]).toEqual(expect.arrayContaining(['scheduled', 'sending', 'send_failed', 'accepted', 'declined']));
  });
});

describe('clickStatsByEstimateId (the click read the list route and the Call today push share)', () => {
  const { clickStatsByEstimateId } = require('../services/estimate-call-list');

  test('one grouped read: summed click counts and the newest click, keyed by estimate id', async () => {
    const calls = [];
    const q = {};
    for (const name of ['where', 'whereIn', 'groupBy', 'select', 'sum', 'max']) q[name] = (...args) => { calls.push([name, ...args]); return q; };
    q.then = (ok, no) => Promise.resolve([{ entity_id: 'e1', click_count: '3', last_clicked_at: '2026-11-19T15:00:00Z' }]).then(ok, no);
    const database = jest.fn(() => q);
    const stats = await clickStatsByEstimateId(database, ['e1', 'e2']);
    expect(database).toHaveBeenCalledTimes(1);
    expect(database).toHaveBeenCalledWith('short_codes');
    expect(calls).toEqual([
      ['where', { entity_type: 'estimates' }],
      ['whereIn', 'entity_id', ['e1', 'e2']],
      ['groupBy', 'entity_id'],
      ['select', 'entity_id'],
      ['sum', { click_count: 'click_count' }],
      ['max', { last_clicked_at: 'last_clicked_at' }],
    ]);
    expect(stats.get('e1')).toMatchObject({ click_count: '3', last_clicked_at: '2026-11-19T15:00:00Z' });
    expect(stats.has('e2')).toBe(false);
  });

  test('no ids = no query', async () => {
    const database = jest.fn();
    expect((await clickStatsByEstimateId(database, [])).size).toBe(0);
    expect(database).not.toHaveBeenCalled();
  });

  // One click read: a change to which clicks count reaches the page and the push together.
  test('the list route and the Call today push both read clicks through it', () => {
    const fs = require('fs');
    const path = require('path');
    for (const file of ['routes/admin-estimates.js', 'services/estimate-call-today-push.js']) {
      const src = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
      expect(src).toContain('clickStatsByEstimateId(db, ');
      expect(src).not.toMatch(/\.max\(\{ last_clicked_at: 'last_clicked_at' \}\)/);
    }
  });
});

// Call outcomes (owner 2026-11-20, D1 A): one tap on a Call today row saves Booked, Call back, Not interested or No
// answer, with who and when, as an activity_log row on the estimate. It only records.
describe('call outcomes', () => {
  const { lastCallOutcomeByEstimateId, callTodayFields } = require('../services/estimate-call-list');
  const handler = routeHandler(adminEstimatesRouter, '/:id/call-outcome', 'post');

  function insertBuilder(createdAt) {
    const q = {};
    q.insert = jest.fn(() => q);
    q.returning = jest.fn(async () => [{ created_at: createdAt }]);
    return q;
  }

  beforeEach(() => { db.mockReset(); });

  test('saves the outcome, who and when as one activity_log row, and changes nothing on the estimate', async () => {
    const read = makeBuilder({ first: { id: 'e1', customer_id: 'c1', status: 'viewed' } });
    const write = insertBuilder('2026-11-20T14:42:00.000Z');
    db.mockImplementationOnce(() => read).mockImplementationOnce(() => write);
    const res = makeRes();
    const next = jest.fn();
    await handler({ params: { id: 'e1' }, body: { outcome: 'no_answer' }, technicianId: 't1', technician: { name: 'Virginia Fixture' } }, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(db.mock.calls.map(([table]) => table)).toEqual(['estimates', 'activity_log']);
    expect(read.where).toHaveBeenCalledWith({ id: 'e1' });
    // No customer name is read or logged (AGENTS.md, PII in logs: a failed insert's error carries its bindings).
    expect(read.first).toHaveBeenCalledWith('id', 'customer_id', 'status');
    expect(read.update).not.toHaveBeenCalled();
    expect(write.insert).toHaveBeenCalledWith({
      admin_user_id: 't1',
      customer_id: 'c1',
      estimate_id: 'e1',
      action: 'estimate_call_outcome',
      description: 'Call outcome: No answer',
      metadata: JSON.stringify({ outcome: 'no_answer' }),
    });
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith({ callOutcome: { outcome: 'no_answer', at: '2026-11-20T14:42:00.000Z', by: 'Virginia' } });
  });

  test.each([undefined, '', 'voicemail', 'BOOKED', 'toString'])('an outcome outside the four (%p) is refused before any read', async (outcome) => {
    const res = makeRes();
    await handler({ params: { id: 'e1' }, body: { outcome }, technicianId: 't1' }, res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(400);
    expect(db).not.toHaveBeenCalled();
  });

  // Only a draft can be deleted, and an outcome row would block that delete (activity_log.estimate_id has no ON DELETE).
  test('a draft answers 409 and writes nothing', async () => {
    db.mockImplementationOnce(() => makeBuilder({ first: { id: 'd1', customer_id: 'c1', status: 'draft' } }));
    const res = makeRes();
    await handler({ params: { id: 'd1' }, body: { outcome: 'booked' }, technicianId: 't1' }, res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(409);
    expect(db).toHaveBeenCalledTimes(1);
  });

  test('an unknown estimate answers 404 and writes nothing', async () => {
    db.mockImplementationOnce(() => makeBuilder({ first: null }));
    const res = makeRes();
    await handler({ params: { id: 'missing' }, body: { outcome: 'booked' }, technicianId: 't1' }, res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(404);
    expect(db).toHaveBeenCalledTimes(1);
  });

  test('one read: the newest outcome per estimate, with the first name of who tapped it', async () => {
    const calls = [];
    const q = {};
    for (const name of ['leftJoin', 'where', 'whereIn', 'distinctOn', 'orderBy', 'select']) q[name] = (...args) => { calls.push([name, ...args]); return q; };
    q.then = (ok, no) => Promise.resolve([
      { estimate_id: 'e1', created_at: '2026-11-20T14:42:00Z', metadata: { outcome: 'no_answer' }, by_name: 'Virginia Fixture' },
      { estimate_id: 'e2', created_at: '2026-11-20T15:00:00Z', metadata: { outcome: 'voicemail' }, by_name: 'Adam' },
      { estimate_id: 'e3', created_at: '2026-11-20T15:10:00Z', metadata: { outcome: 'booked' }, by_name: null },
    ]).then(ok, no);
    const database = jest.fn(() => q);
    const out = await lastCallOutcomeByEstimateId(database, ['e1', 'e2', 'e3', 'e4']);
    expect(database).toHaveBeenCalledTimes(1);
    expect(database).toHaveBeenCalledWith('activity_log as a');
    expect(calls).toEqual([
      ['leftJoin', 'technicians as t', 't.id', 'a.admin_user_id'],
      ['where', 'a.action', 'estimate_call_outcome'],
      ['whereIn', 'a.estimate_id', ['e1', 'e2', 'e3', 'e4']],
      ['distinctOn', 'a.estimate_id'],
      ['orderBy', [{ column: 'a.estimate_id' }, { column: 'a.created_at', order: 'desc' }, { column: 'a.id', order: 'desc' }]],
      ['select', 'a.estimate_id', 'a.created_at', 'a.metadata', 't.name as by_name'],
    ]);
    expect(out.get('e1')).toEqual({ outcome: 'no_answer', at: '2026-11-20T14:42:00Z', by: 'Virginia' });
    expect(out.has('e2')).toBe(false); // not one of the four
    expect(out.get('e3')).toEqual({ outcome: 'booked', at: '2026-11-20T15:10:00Z', by: null });
    expect(out.has('e4')).toBe(false);
  });

  test('no ids = no query', async () => {
    const database = jest.fn();
    expect((await lastCallOutcomeByEstimateId(database, [])).size).toBe(0);
    expect(database).not.toHaveBeenCalled();
  });

  test('the list row carries the newest outcome, and the shared rule takes the row off once it is newer than the last touch', () => {
    const { isCallTodayEstimate } = require('../../shared/estimate-call-today.cjs');
    const now = Date.parse('2026-11-20T15:00:00Z');
    const stored = {
      status: 'viewed', customer_phone: '+19415550101', archived_at: null, sent_at: '2026-11-19T12:00:00Z',
      viewed_at: '2026-11-20T09:00:00Z', last_viewed_at: '2026-11-20T09:00:00Z', last_follow_up_at: null,
    };
    expect(isCallTodayEstimate(callTodayFields(stored), now)).toBe(true);
    const tapped = { outcome: 'no_answer', at: '2026-11-20T14:00:00Z', by: 'Virginia' };
    expect(callTodayFields(stored, { lastCallOutcome: tapped }).lastCallOutcome).toEqual(tapped);
    expect(isCallTodayEstimate(callTodayFields(stored, { lastCallOutcome: tapped }), now)).toBe(false);
    // An outcome from before the customer's last touch: the row is back on the list.
    const older = { outcome: 'call_back', at: '2026-11-20T08:00:00Z', by: 'Virginia' };
    expect(isCallTodayEstimate(callTodayFields(stored, { lastCallOutcome: older }), now)).toBe(true);
    expect(callTodayFields(stored).lastCallOutcome).toBeNull();
    // A failed outcome read (codex pre-push P1): the row says so, and the shared rule withholds it.
    expect(callTodayFields(stored).callOutcomeUnknown).toBe(false);
    expect(callTodayFields(stored, { callOutcomeUnknown: true }).callOutcomeUnknown).toBe(true);
    expect(isCallTodayEstimate(callTodayFields(stored, { callOutcomeUnknown: true }), now)).toBe(false);
  });

  test('the list route and the 9 AM push both read outcomes through the one batched read', () => {
    const fs = require('fs');
    const path = require('path');
    for (const file of ['routes/admin-estimates.js', 'services/estimate-call-today-push.js']) {
      const src = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
      expect(src).toContain('lastCallOutcomeByEstimateId(db, ');
      expect(src).toContain('lastCallOutcome: ');
    }
  });
});

// Owner 2026-11-21 (estimate page changes, change 1): a customer who says what would help them decide goes on
// "Call today" with the reason.
describe('what would help a still-deciding customer', () => {
  const { stillDecidingByEstimateId, callTodayFields } = require('../services/estimate-call-list');
  const shared = require('../../shared/estimate-call-today.cjs');
  const HOUR = 3600000;
  const now = Date.parse('2026-11-21T15:00:00Z');
  const ago = (hours) => new Date(now - hours * HOUR).toISOString();
  const stored = (viewedHoursAgo, over = {}) => ({
    status: 'viewed', customer_phone: '+19415550101', archived_at: null, sent_at: ago(viewedHoursAgo + 24),
    viewed_at: ago(viewedHoursAgo), last_viewed_at: ago(viewedHoursAgo), last_follow_up_at: null, ...over,
  });
  const onList = (row, fields) => shared.isCallTodayEstimate(callTodayFields(row, fields), now);

  test('one read: the newest reason per estimate, at the time the customer sent it', async () => {
    const calls = [];
    const q = {};
    for (const name of ['where', 'whereIn', 'whereRaw', 'distinctOn', 'orderBy', 'select']) q[name] = (...args) => { calls.push([name, ...args]); return q; };
    q.then = (ok, no) => Promise.resolve([
      { estimate_id: 'e1', created_at: '2026-11-21T13:00:00Z', metadata: { reason: 'person', reason_at: '2026-11-21T13:04:00Z' } },
      { estimate_id: 'e2', created_at: '2026-11-21T13:10:00Z', metadata: { reason: 'price' } },
      { estimate_id: 'e3', created_at: '2026-11-21T13:20:00Z', metadata: { reason: 'constructor' } },
    ]).then(ok, no);
    const database = jest.fn(() => q);
    const out = await stillDecidingByEstimateId(database, ['e1', 'e2', 'e3', 'e4']);
    expect(database).toHaveBeenCalledTimes(1);
    expect(database).toHaveBeenCalledWith('activity_log');
    expect(calls).toEqual([
      ['where', 'action', 'estimate_customer_still_deciding'],
      ['whereIn', 'estimate_id', ['e1', 'e2', 'e3', 'e4']],
      // A later tap with no reason (Skip) never hides the reason the customer sent before it.
      ['whereRaw', "metadata->>'reason' IS NOT NULL"],
      ['distinctOn', 'estimate_id'],
      ['orderBy', [{ column: 'estimate_id' }, { column: 'created_at', order: 'desc' }, { column: 'id', order: 'desc' }]],
      ['select', 'estimate_id', 'created_at', 'metadata'],
    ]);
    expect(out.get('e1')).toEqual({ reason: 'person', at: '2026-11-21T13:04:00Z' });
    expect(out.get('e2')).toEqual({ reason: 'price', at: '2026-11-21T13:10:00Z' }); // no reason_at: the row's own time
    expect(out.has('e3')).toBe(false); // not one of the five
    expect(out.has('e4')).toBe(false);
  });

  test('no ids = no query', async () => {
    const database = jest.fn();
    expect((await stillDecidingByEstimateId(database, [])).size).toBe(0);
    expect(database).not.toHaveBeenCalled();
  });

  test('the row words every reason the server accepts, and no other', () => {
    const { STILL_DECIDING_REASONS } = require('../services/estimate-change-request');
    expect(Object.keys(shared.STILL_DECIDING_HELP).sort()).toEqual(Object.keys(STILL_DECIDING_REASONS).sort());
  });

  test('a sent reason shows the row at once: no 2 h wait', () => {
    const fresh = stored(0.2);
    expect(onList(fresh)).toBe(false); // opened 12 minutes ago: the wait gives the customer time to book alone
    expect(callTodayFields(fresh).stillDeciding).toBeNull();
    const told = { reason: 'person', at: ago(0.1) };
    expect(callTodayFields(fresh, { stillDeciding: told }).stillDeciding).toEqual(told);
    expect(onList(fresh, { stillDeciding: told })).toBe(true);
    for (const reason of Object.keys(shared.STILL_DECIDING_HELP)) {
      expect(onList(fresh, { stillDeciding: { reason, at: ago(0.1) } })).toBe(true);
    }
  });

  test('the row stays until someone answers the reason: a call, a follow-up or an outcome after it', () => {
    const row = stored(6);
    const told = { reason: 'price', at: ago(5) };
    expect(onList(row, { stillDeciding: told })).toBe(true);
    expect(onList(row, { stillDeciding: told, lastCalledAt: ago(1) })).toBe(false);
    expect(onList(row, { stillDeciding: told, lastCallOutcome: { outcome: 'call_back', at: ago(1), by: 'Virginia' } })).toBe(false);
    expect(onList(stored(6, { last_follow_up_at: ago(1) }), { stillDeciding: told })).toBe(false);
    // A contact from BEFORE the reason does not answer it.
    expect(onList(stored(0.5), { stillDeciding: { reason: 'person', at: ago(0.2) }, lastCalledAt: ago(3) })).toBe(true);
  });

  test('a reason is a customer touch: it puts back a row a call had taken off', () => {
    // Opened 6 h ago, called 3 h ago (off the list), then the customer sent a reason 20 minutes ago.
    const row = stored(6);
    expect(onList(row, { lastCalledAt: ago(3) })).toBe(false);
    expect(onList(row, { lastCalledAt: ago(3), stillDeciding: { reason: 'quotes', at: ago(0.3) } })).toBe(true);
    expect(shared.lastEngagementMs(callTodayFields(row, { stillDeciding: { reason: 'quotes', at: ago(0.3) } }))).toBe(now - 0.3 * HOUR);
  });

  test('after the answer, a new open follows the plain rule again', () => {
    // Reason 10 h ago, call 8 h ago, the customer opened the page again later.
    const answered = { stillDeciding: { reason: 'person', at: ago(10) }, lastCalledAt: ago(8) };
    expect(onList(stored(1), answered)).toBe(false); // inside the 2 h wait
    expect(onList(stored(3), answered)).toBe(true);
  });

  test('the limits of the list still hold for a row with a reason', () => {
    const told = { reason: 'person', at: ago(0.1) };
    // 48 h since the last touch: off the list (the Going cold view has it).
    expect(onList(stored(60), { stillDeciding: { reason: 'person', at: ago(49) } })).toBe(false);
    expect(onList(stored(60), { stillDeciding: { reason: 'person', at: ago(47) } })).toBe(true);
    // A self-serve quote nobody delivered: the zero-follow-up contract.
    expect(onList(stored(0.2), { stillDeciding: told, undeliveredSelfServe: true })).toBe(false);
    // A failed outcome read still withholds the row.
    expect(onList(stored(0.2), { stillDeciding: told, callOutcomeUnknown: true })).toBe(false);
    // No phone, an archived row, a settled row: not callable.
    expect(onList(stored(0.2, { customer_phone: null }), { stillDeciding: told })).toBe(false);
    expect(onList(stored(0.2, { archived_at: ago(0.05) }), { stillDeciding: told })).toBe(false);
    expect(onList(stored(0.2, { status: 'accepted' }), { stillDeciding: told })).toBe(false);
  });

  // The call read goes back 30 days, so an old reason can look unanswered. It must not skip the wait for a new open.
  test('the skip lasts 48 h from the reason: after that a new open follows the plain rule', () => {
    const old = { reason: 'person', at: ago(60) };
    expect(onList(stored(0.5), { stillDeciding: old })).toBe(false);
    expect(onList(stored(3), { stillDeciding: old })).toBe(true);
    // Inside 48 h the reason still skips the wait for a new open.
    expect(onList(stored(0.5), { stillDeciding: { reason: 'person', at: ago(40) } })).toBe(true);
  });

  test('only an open offer carries the reason: a settled row is not still deciding', () => {
    const told = { reason: 'price', at: ago(5) };
    for (const status of ['sent', 'viewed']) {
      expect(callTodayFields(stored(6, { status }), { stillDeciding: told }).stillDeciding).toEqual(told);
    }
    for (const status of ['accepted', 'declined', 'expired', 'draft']) {
      expect(callTodayFields(stored(6, { status }), { stillDeciding: told }).stillDeciding).toBeNull();
    }
  });

  test('a reason the list does not know, or one with no time, changes nothing', () => {
    expect(onList(stored(0.2), { stillDeciding: { reason: 'constructor', at: ago(0.1) } })).toBe(false);
    expect(onList(stored(0.2), { stillDeciding: { reason: 'price', at: 'not a date' } })).toBe(false);
    expect(onList(stored(5), { stillDeciding: { reason: 'constructor', at: ago(0.1) } })).toBe(true);
  });

  test('the list route and the 9 AM push both read reasons through the one batched read; a failed read costs only the field', () => {
    const fs = require('fs');
    const path = require('path');
    for (const file of ['routes/admin-estimates.js', 'services/estimate-call-today-push.js']) {
      const src = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
      expect(src).toContain('stillDecidingByEstimateId(db, ');
      expect(src).toContain('stillDeciding: ');
      expect(src).toContain('still-deciding read failed (${err?.code || \'no code\'})');
    }
  });
});

describe('callTodayFields: an undelivered self-serve quote carries no sentAt (codex pre-push P1)', () => {
  const { callTodayFields } = require('../services/estimate-call-list');
  const stored = {
    status: 'viewed', customer_phone: '+19415550101', archived_at: null, sent_at: '2026-11-12T15:00:00.000Z',
    viewed_at: '2026-11-12T15:05:00.000Z', last_viewed_at: '2026-11-13T15:00:00.000Z', last_follow_up_at: null,
  };

  test('its sent_at is the mint stamp, so the row shows no send; the customer\'s opens stay as stored', () => {
    expect(callTodayFields(stored, { undeliveredSelfServe: true })).toMatchObject({
      status: 'viewed', sentAt: null, viewedAt: stored.viewed_at, lastViewedAt: stored.last_viewed_at, undeliveredSelfServe: true,
    });
  });

  test('any other row reads as stored', () => {
    expect(callTodayFields(stored)).toMatchObject({
      status: 'viewed', sentAt: stored.sent_at, viewedAt: stored.viewed_at, lastViewedAt: stored.last_viewed_at,
      undeliveredSelfServe: false,
    });
  });
});
