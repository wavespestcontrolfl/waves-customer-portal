/**
 * completion-followup-booking — the Dispatch follow-up CTA's gates + write,
 * shared with the IB closeout repair. Covers the options only the repair
 * uses (dryRun, useSuggestedDate, expectedTechnicianId) and the booking
 * contract adoption; the CTA's gate text is pinned by
 * admin-dispatch-followup-alert.test.js.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/complete-scheduled-service', () => ({
  parseJsonObject: (v) => (v && typeof v === 'object' ? v : {}),
  serviceDateOnly: (v) => String(v || '').slice(0, 10),
}));
jest.mock('../services/service-completion-profiles', () => ({
  resolveCompletionProfileForScheduledService: jest.fn(async () => ({ findingsType: null, followupPolicy: 'alert' })),
}));
jest.mock('../services/typed-followup-obligation', () => ({
  typedFollowupVerdict: jest.fn(),
  FOLLOWUP_CHILD_INACTIVE_STATUSES: ['cancelled', 'skipped', 'no_show'],
}));
jest.mock('../utils/customer-comms-lock', () => ({ lockCustomerComms: jest.fn(async () => {}) }));
jest.mock('../services/scheduling/window-rules', () => ({
  probeSlotOverlap: jest.fn(async () => []),
  // The real validator — the on-the-hour invariant is what's under test.
  assertAdminAppointmentWindow: jest.requireActual('../services/scheduling/window-rules').assertAdminAppointmentWindow,
  slotOverlapWarning: (date) => `overlap on ${date}`,
  ADMIN_OCCUPANCY_EXCLUDE_STATUSES: ['cancelled', 'completed', 'skipped', 'no_show'],
}));
jest.mock('../services/scheduling/occupancy', () => ({ findConflictingVisits: jest.fn(async () => []) }));
jest.mock('../services/technician-eligibility', () => ({ assertAssignableTechnician: jest.fn(async () => true) }));
jest.mock('../utils/datetime-et', () => ({ etDateString: () => '2026-09-28' }));
jest.mock('../services/booking/create-scheduled-service', () => ({
  completeScheduledServiceInsert: jest.fn(async (data, { source }) => ({ ...data, source_action: source.sourceAction })),
}));
jest.mock('../services/dispatch-alerts', () => ({ resolveAlert: jest.fn() }));
jest.mock('../services/visit-groups', () => ({ maybeGroupRow: jest.fn() }));
jest.mock('../services/tech-visit-notifications', () => ({ notifyTechVisitChange: jest.fn() }));
jest.mock('../services/appointment-reminders', () => ({ registerAppointment: jest.fn() }));

const db = require('../models/db');
const { lockCustomerComms } = require('../utils/customer-comms-lock');
const { probeSlotOverlap } = require('../services/scheduling/window-rules');
const { findConflictingVisits } = require('../services/scheduling/occupancy');
const { assertAssignableTechnician } = require('../services/technician-eligibility');
const { completeScheduledServiceInsert } = require('../services/booking/create-scheduled-service');
const { resolveAlert } = require('../services/dispatch-alerts');
const { registerAppointment } = require('../services/appointment-reminders');
const { bookCompletionFollowup } = require('../services/completion-followup-booking');

const SOURCE = {
  id: 'svc-1', customer_id: 'cust-1', technician_id: 'tech-1', status: 'completed',
  scheduled_date: '2026-09-14', window_start: '09:00', window_end: '10:00', service_type: 'Bed Bug Treatment',
};
const FROZEN = { structured_notes: { typedFollowupVerdict: { required: true, suggestedDate: '2026-10-05' } } };
const COLS = { followup_source_service_id: {}, followup_included: {}, source_action: {} };

// Table-routed fake: scheduled_services serves the source row / columnInfo /
// the existing-child lookup; service_records the frozen verdict.
function install({ existing = null, record = FROZEN, inserted = { id: 'fu-1', scheduled_date: '2026-10-05', status: 'pending', technician_id: 'tech-1' } } = {}) {
  const writes = [];
  db.mockImplementation((table) => {
    const chain = {
      where: () => chain,
      whereNull: () => chain,
      whereNotIn: () => chain,
      orderBy: () => chain,
      select: async () => [],
      columnInfo: async () => COLS,
      first: async () => {
        if (table === 'service_records') return record;
        if (table === 'scheduled_services') return chain._followupLookup ? existing : SOURCE;
        return null;
      },
    };
    const origWhere = chain.where;
    chain.where = (w) => { if (w && w.followup_source_service_id) chain._followupLookup = true; return origWhere(w); };
    return chain;
  });
  db.transaction = jest.fn(async (fn) => {
    const trx = (table) => {
      const q = {
        where: () => q,
        forUpdate: () => q,
        first: async () => ({ customer_id: 'cust-1' }),
        insert: (row) => { writes.push({ table, row }); return { returning: async () => [inserted] }; },
      };
      return q;
    };
    return fn(trx);
  });
  return { writes };
}

beforeEach(() => jest.clearAllMocks());

test('dryRun + useSuggestedDate: every gate, then what would be booked — no write, no alert, no reminder', async () => {
  const { writes } = install();
  const out = await bookCompletionFollowup({ serviceId: 'svc-1', useSuggestedDate: true, dryRun: true, isAdmin: true });
  expect(out.status).toBe(200);
  expect(out.body).toEqual({
    dryRun: true,
    alreadyScheduled: false,
    wouldBook: { date: '2026-10-05', windowStart: '09:00', windowEnd: '10:00', technicianId: 'tech-1', status: 'pending', serviceType: 'Bed Bug Treatment', overlap: false },
  });
  expect(writes).toEqual([]);
  expect(db.transaction).not.toHaveBeenCalled();
  expect(resolveAlert).not.toHaveBeenCalled();
  expect(registerAppointment).not.toHaveBeenCalled();
});

test('dryRun reports an inherited technician who is no longer assignable as unassigned, like the write', async () => {
  install();
  assertAssignableTechnician.mockRejectedValueOnce(Object.assign(new Error('out'), { code: 'TECH_NOT_ASSIGNABLE' }));
  const out = await bookCompletionFollowup({ serviceId: 'svc-1', useSuggestedDate: true, dryRun: true, isAdmin: true });
  expect(out.body.wouldBook.technicianId).toBeNull();
});

test('useSuggestedDate keeps the today-or-later rule', async () => {
  install({ record: { structured_notes: { typedFollowupVerdict: { required: true, suggestedDate: '2026-09-20' } } } });
  const out = await bookCompletionFollowup({ serviceId: 'svc-1', useSuggestedDate: true, dryRun: true, isAdmin: true });
  expect(out).toEqual({ status: 400, body: expect.objectContaining({ code: 'followup_date_past', suggestedDate: '2026-09-20' }) });
});

test('a dryRun that finds an existing child reports it without resolving the parked alert', async () => {
  install({ existing: { id: 'fu-old', scheduled_date: '2026-10-05', status: 'pending' } });
  const out = await bookCompletionFollowup({ serviceId: 'svc-1', useSuggestedDate: true, dryRun: true, isAdmin: true });
  expect(out.body).toEqual(expect.objectContaining({ dryRun: true, alreadyScheduled: true }));
  expect(resolveAlert).not.toHaveBeenCalled();
});

test('the write goes through the booking contract with the caller\'s source, then registers reminders without a text', async () => {
  const { writes } = install();
  const out = await bookCompletionFollowup({ serviceId: 'svc-1', useSuggestedDate: true, isAdmin: true, actorId: 'admin-1', sourceAction: 'admin_ib', expectedTechnicianId: 'tech-1' });
  expect(out.status).toBe(200);
  expect(out.body).toEqual(expect.objectContaining({ success: true, alreadyScheduled: false, appointment: expect.objectContaining({ id: 'fu-1' }) }));
  expect(completeScheduledServiceInsert).toHaveBeenCalledWith(expect.objectContaining({ followup_source_service_id: 'svc-1', scheduled_date: '2026-10-05', status: 'pending' }), expect.objectContaining({ source: { sourceAction: 'admin_ib' } }));
  expect(writes).toEqual([{ table: 'scheduled_services', row: expect.objectContaining({ source_action: 'admin_ib', followup_included: true }) }]);
  expect(registerAppointment).toHaveBeenCalledWith('fu-1', 'cust-1', '2026-10-05T09:00', 'Bed Bug Treatment', 'booking_followup', { sendConfirmation: false });
});

test('expectedTechnicianId refuses when the technician resolved under the lock differs from the approval', async () => {
  const { writes } = install();
  assertAssignableTechnician.mockRejectedValueOnce(Object.assign(new Error('out'), { code: 'TECH_NOT_ASSIGNABLE' }));
  await expect(bookCompletionFollowup({ serviceId: 'svc-1', useSuggestedDate: true, isAdmin: true, expectedTechnicianId: 'tech-1' }))
    .rejects.toMatchObject({ statusCode: 409, code: 'FOLLOWUP_TECH_CHANGED' });
  expect(writes).toEqual([]);
});

test('the Dispatch CTA shape is unchanged: a typed date must match the verdict; default source is admin_manual', async () => {
  install();
  const mismatch = await bookCompletionFollowup({ serviceId: 'svc-1', date: '2026-10-06', isAdmin: true });
  expect(mismatch).toEqual({ status: 409, body: expect.objectContaining({ code: 'followup_date_mismatch', suggestedDate: '2026-10-05' }) });
  const ok = await bookCompletionFollowup({ serviceId: 'svc-1', date: '2026-10-05', isAdmin: true });
  expect(ok.status).toBe(200);
  expect(completeScheduledServiceInsert).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ source: { sourceAction: 'admin_manual' } }));
});

test('expectedWindow: a source window changed since the approval refuses before any write', async () => {
  const { writes } = install();
  const out = await bookCompletionFollowup({
    serviceId: 'svc-1', date: '2026-10-05', isAdmin: true, expectedWindow: { start: '08:00', end: '09:00' }, expectedTechnicianId: 'tech-1',
  });
  expect(out).toEqual({ status: 409, body: expect.objectContaining({ code: 'followup_window_changed' }) });
  expect(writes).toEqual([]);
  expect(db.transaction).not.toHaveBeenCalled();
});

test('an approved date that no longer matches the verdict refuses before any write (the CTA gate)', async () => {
  const { writes } = install({ record: { structured_notes: { typedFollowupVerdict: { required: true, suggestedDate: '2026-10-12' } } } });
  const out = await bookCompletionFollowup({
    serviceId: 'svc-1', date: '2026-10-05', isAdmin: true, expectedWindow: { start: '09:00', end: '10:00' }, expectedTechnicianId: 'tech-1',
  });
  expect(out).toEqual({ status: 409, body: expect.objectContaining({ code: 'followup_date_mismatch', suggestedDate: '2026-10-12' }) });
  expect(writes).toEqual([]);
});

test('rung 1 before rung 6: the overlap probe runs first and a hit is advisory — the booking commits with a warning', async () => {
  const order = [];
  const { writes } = install();
  probeSlotOverlap.mockImplementationOnce(async () => { order.push('probe'); return [{ id: 'other' }]; });
  lockCustomerComms.mockImplementationOnce(async () => { order.push('comms'); });
  const out = await bookCompletionFollowup({ serviceId: 'svc-1', date: '2026-10-05', isAdmin: true });
  expect(order).toEqual(['probe', 'comms']);
  expect(out.status).toBe(200);
  expect(out.body.overlapWarning).toBe('overlap on 2026-10-05');
  expect(writes).toHaveLength(1);
});

test('the preview reports an overlap the write would warn about, without taking any lock', async () => {
  install();
  findConflictingVisits.mockResolvedValueOnce([{ id: 'other' }]);
  const out = await bookCompletionFollowup({ serviceId: 'svc-1', useSuggestedDate: true, dryRun: true, isAdmin: true });
  expect(out.body.wouldBook.overlap).toBe(true);
  expect(probeSlotOverlap).not.toHaveBeenCalled();
});

test('expectedCustomerId refuses under the source-row lock when the visit changed hands', async () => {
  const { writes } = install();
  await expect(bookCompletionFollowup({ serviceId: 'svc-1', date: '2026-10-05', isAdmin: true, expectedCustomerId: 'cust-OTHER' }))
    .rejects.toMatchObject({ statusCode: 409, code: 'FOLLOWUP_CUSTOMER_CHANGED' });
  expect(writes).toEqual([]);
});

test('an existing follow-up that differs from the approval is a 409, never a reported success', async () => {
  install({ existing: { id: 'fu-old', scheduled_date: '2026-10-05', status: 'pending', window_start: '13:00', window_end: '14:00', technician_id: 'tech-1', customer_id: 'cust-1' } });
  const out = await bookCompletionFollowup({
    serviceId: 'svc-1', date: '2026-10-05', isAdmin: true,
    expectedWindow: { start: '09:00', end: '10:00' }, expectedTechnicianId: 'tech-1', expectedCustomerId: 'cust-1',
  });
  expect(out).toEqual({ status: 409, body: expect.objectContaining({ code: 'followup_exists_differs', appointment: expect.objectContaining({ id: 'fu-old' }) }) });
});

test('an existing follow-up matching every pin is the idempotent success', async () => {
  install({ existing: { id: 'fu-old', scheduled_date: '2026-10-05', status: 'pending', window_start: '09:00', window_end: '10:00', technician_id: 'tech-1', customer_id: 'cust-1' } });
  const out = await bookCompletionFollowup({
    serviceId: 'svc-1', date: '2026-10-05', isAdmin: true,
    expectedWindow: { start: '09:00', end: '10:00' }, expectedTechnicianId: 'tech-1', expectedCustomerId: 'cust-1',
  });
  expect(out).toEqual({ status: 200, body: expect.objectContaining({ success: true, alreadyScheduled: true }) });
});

test('an inherited off-hour window (legacy :15 start) refuses before preview or write — never copied onto the follow-up', async () => {
  const { writes } = install();
  const src = require('../models/db');
  const orig = src.getMockImplementation();
  src.mockImplementation((table) => {
    const chain = orig(table);
    const first = chain.first;
    chain.first = async (...a) => {
      const row = await first(...a);
      return row && row.id === 'svc-1' ? { ...row, window_start: '09:15', window_end: '10:15' } : row;
    };
    return chain;
  });
  const preview = await bookCompletionFollowup({ serviceId: 'svc-1', useSuggestedDate: true, dryRun: true, isAdmin: true });
  expect(preview).toEqual({ status: 409, body: expect.objectContaining({ code: 'followup_window_invalid', error: expect.stringMatching(/start on the hour/) }) });
  const commit = await bookCompletionFollowup({ serviceId: 'svc-1', date: '2026-10-05', isAdmin: true });
  expect(commit.body.code).toBe('followup_window_invalid');
  expect(writes).toEqual([]);
});
