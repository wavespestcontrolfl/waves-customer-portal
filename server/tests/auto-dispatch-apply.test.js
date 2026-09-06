// apply.js stale guard: must re-read the row and refuse to move it if it was
// locked/excluded or its date/window/tech changed since it was scored.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/rebooker', () => ({ reschedule: jest.fn().mockResolvedValue({ success: true }) }));
jest.mock('../services/appointment-reminders', () => ({ handleReschedule: jest.fn().mockResolvedValue() }));
jest.mock('../services/auto-dispatch/route-tiers', () => ({
  ...jest.requireActual('../services/auto-dispatch/route-tiers'),
  loadReminderFreeze: jest.fn().mockResolvedValue({ failed: false, frozen: new Set() }),
  loadAnchorMap: jest.fn().mockResolvedValue(new Map()),
}));

const db = require('../models/db');
const SmartRebooker = require('../services/rebooker');
const AppointmentReminders = require('../services/appointment-reminders');
const { applyAutoDispatchMove, makeMemberGuard } = require('../services/auto-dispatch/apply');
const routeTiers = require('../services/auto-dispatch/route-tiers');
const { classifyServiceCategory } = require('../services/auto-dispatch/service-category');
const { etDateString, addETDays, parseETDateTime } = require('../utils/datetime-et');
const { shiftDateStr } = require('../services/auto-dispatch/dates');

const SERVICE = {
  id: 's1', status: 'confirmed', scheduled_date: '2026-08-04',
  window_start: '09:00', window_end: '11:00', technician_id: 't1', auto_dispatch_change_count: 0,
};
const BEST = { date: '2026-08-11', start_time: '08:00', end_time: '10:00', technician_id: 't1' };

function readRow(row) {
  return { where() { return this; }, first: async () => row };
}

beforeEach(() => {
  jest.clearAllMocks();
  db.raw = jest.fn((s) => ({ raw: s }));
  db.fn = { now: jest.fn(() => 'now()') };
});

test('applies the move and atomically increments the change count', async () => {
  const update = jest.fn().mockResolvedValue(1);
  const queue = [
    readRow({ scheduled_date: '2026-08-04', window_start: '09:00', window_end: '11:00', technician_id: 't1', status: 'confirmed', auto_dispatch_locked: false, auto_dispatch_excluded: false }),
    { where() { return this; }, update },
  ];
  db.mockImplementation(() => queue.shift());

  const res = await applyAutoDispatchMove(SERVICE, BEST, 'run1', { notifyCustomers: false });

  const callArgs = SmartRebooker.reschedule.mock.calls[0];
  expect(callArgs.slice(0, 5)).toEqual(['s1', '2026-08-11', { start: '08:00', end: '10:00' }, 'auto_dispatch', 'auto_dispatch']);
  // atomic expect predicate (full original placement + status) carried into the rebooker's move transaction
  expect(callArgs[5].expect).toMatchObject({
    auto_dispatch_locked: false, auto_dispatch_excluded: false, status: 'confirmed', scheduled_date: '2026-08-04',
    window_start: '09:00', window_end: '11:00', technician_id: 't1',
  });
  expect(res).toMatchObject({ ok: true, pre_status: 'confirmed', post_status: 'confirmed' });
  expect(update.mock.calls[0][0].auto_dispatch_change_count).toEqual({ raw: 'COALESCE(auto_dispatch_change_count, 0) + 1' });
  // reminders re-aligned to the new slot (non-notifying)
  expect(AppointmentReminders.handleReschedule).toHaveBeenCalledWith('s1', '2026-08-11T08:00', { sendNotification: false, preserveMoveHold: false });
});

test('the tapped row\'s bookkeeping is fenced on the landed slot; a miss skips EVERY stamp (local audit)', async () => {
  const tappedWhere = jest.fn();
  const fenced = jest.fn().mockResolvedValue(0); // staff confirmed / moved it after the commit
  const plain = jest.fn().mockResolvedValue(1);
  const insert = jest.fn().mockResolvedValue();
  const queue = [
    readRow({ scheduled_date: '2026-08-04', window_start: '09:00', window_end: '11:00', technician_id: 't1', status: 'pending', auto_dispatch_locked: false, auto_dispatch_excluded: false }),
    { where(pred) { tappedWhere(pred); return this; }, update: fenced },
    { where() { return this; }, update: plain },
    { insert },
  ];
  db.mockImplementation(() => queue.shift());
  await applyAutoDispatchMove({ ...SERVICE, status: 'pending' }, BEST, 'run1', {});
  // complete landed slot + customer_confirmed=false (codex r17): an admin/customer confirm at the same slot is never rewound
  expect(tappedWhere).toHaveBeenCalledWith({ id: 's1', status: 'confirmed', scheduled_date: '2026-08-11', window_start: '08:00', window_end: '10:00', customer_confirmed: false });
  expect(plain).not.toHaveBeenCalled();  // no unfenced fallback stamp: the operator's newer state is not attributed to this run
  expect(insert).not.toHaveBeenCalled();
});

test('a sibling reported without a landed slot gets NO bookkeeping (cannot be fenced)', async () => {
  SmartRebooker.reschedule.mockResolvedValueOnce({
    success: true,
    visitMove: { visitId: 'v1', moved: ['s1', 's2'], failed: [], members: [
      { id: 's1', isPrimary: true, previousStatus: 'confirmed' },
      { id: 's2', isPrimary: false, previousStatus: 'pending', landed: null },
    ] },
  });
  const updateSib = jest.fn().mockResolvedValue(1);
  const insert = jest.fn().mockResolvedValue();
  const queue = [
    readRow({ scheduled_date: '2026-08-04', window_start: '09:00', window_end: '11:00', technician_id: 't1', status: 'confirmed', auto_dispatch_locked: false, auto_dispatch_excluded: false }),
    { where() { return this; }, update: jest.fn().mockResolvedValue(1) },
    { where() { return this; }, update: updateSib },
    { insert },
  ];
  db.mockImplementation(() => queue.shift());
  await applyAutoDispatchMove(SERVICE, BEST, 'run1', {});
  expect(updateSib).not.toHaveBeenCalled();
  expect(insert).not.toHaveBeenCalled();
});

test('preserves pending: restores pending + writes a compensating history row', async () => {
  const update = jest.fn().mockResolvedValue(1);
  const insert = jest.fn().mockResolvedValue();
  const queue = [
    readRow({ scheduled_date: '2026-08-04', window_start: '09:00', window_end: '11:00', technician_id: 't1', status: 'pending', auto_dispatch_locked: false, auto_dispatch_excluded: false }),
    { where() { return this; }, update },
    { insert }, // job_status_history compensating row
  ];
  db.mockImplementation(() => queue.shift());

  const res = await applyAutoDispatchMove({ ...SERVICE, status: 'pending' }, BEST, 'run1', {});
  expect(res.post_status).toBe('pending');
  expect(update.mock.calls[0][0].status).toBe('pending');
  expect(insert).toHaveBeenCalledWith({ job_id: 's1', from_status: 'confirmed', to_status: 'pending', transitioned_by: null });
});

test('does not undo a concurrent confirm: scored pending but fresh confirmed stays confirmed', async () => {
  const update = jest.fn().mockResolvedValue(1);
  const queue = [
    readRow({ scheduled_date: '2026-08-04', window_start: '09:00', window_end: '11:00', technician_id: 't1', status: 'confirmed', auto_dispatch_locked: false, auto_dispatch_excluded: false }),
    { where() { return this; }, update },
  ];
  db.mockImplementation(() => queue.shift());

  const res = await applyAutoDispatchMove({ ...SERVICE, status: 'pending' }, BEST, 'run1', {});
  expect(res.post_status).toBe('confirmed');
  expect(update.mock.calls[0][0].status).toBeUndefined(); // no pending restore
});

test('re-arms a still-pending creation confirmation after the silent reminder sync', async () => {
  AppointmentReminders.handleReschedule.mockResolvedValueOnce({ id: 'r1', confirmation_sent: false });
  const stamp = jest.fn().mockResolvedValue(1);
  const rearm = jest.fn().mockResolvedValue(1);
  const queue = [
    readRow({ scheduled_date: '2026-08-04', window_start: '09:00', window_end: '11:00', technician_id: 't1', status: 'confirmed', auto_dispatch_locked: false, auto_dispatch_excluded: false }),
    { where() { return this; }, update: stamp },     // bookkeeping stamp
    { where() { return this; }, update: rearm },     // appointment_reminders re-arm
  ];
  db.mockImplementation(() => queue.shift());

  await applyAutoDispatchMove(SERVICE, BEST, 'run1', {});
  expect(rearm).toHaveBeenCalledWith({ confirmation_sent: false, confirmation_sent_at: null });
});

test('aborts (STALE_PLACEMENT) when the visit was locked after scoring', async () => {
  db.mockImplementation(() => readRow({ scheduled_date: '2026-08-04', window_start: '09:00', window_end: '11:00', technician_id: 't1', status: 'confirmed', auto_dispatch_locked: true, auto_dispatch_excluded: false }));
  await expect(applyAutoDispatchMove(SERVICE, BEST, 'run1', {})).rejects.toMatchObject({ code: 'STALE_PLACEMENT' });
  expect(SmartRebooker.reschedule).not.toHaveBeenCalled();
});

test('aborts when status flipped to rescheduled (customer request) after scoring', async () => {
  db.mockImplementation(() => readRow({ scheduled_date: '2026-08-04', window_start: '09:00', window_end: '11:00', technician_id: 't1', status: 'rescheduled', auto_dispatch_locked: false, auto_dispatch_excluded: false }));
  await expect(applyAutoDispatchMove(SERVICE, BEST, 'run1', {})).rejects.toMatchObject({ code: 'STALE_PLACEMENT' });
  expect(SmartRebooker.reschedule).not.toHaveBeenCalled();
});

test('aborts when window_end changed since scoring', async () => {
  db.mockImplementation(() => readRow({ scheduled_date: '2026-08-04', window_start: '09:00', window_end: '10:00', technician_id: 't1', status: 'confirmed', auto_dispatch_locked: false, auto_dispatch_excluded: false }));
  await expect(applyAutoDispatchMove(SERVICE, BEST, 'run1', {})).rejects.toMatchObject({ code: 'STALE_PLACEMENT' });
  expect(SmartRebooker.reschedule).not.toHaveBeenCalled();
});

test('a grouped stop moved as a unit: every moved sibling gets the same bookkeeping stamp and pending restoration as the tapped row', async () => {
  SmartRebooker.reschedule.mockResolvedValueOnce({
    success: true,
    visitMove: { visitId: 'v1', moved: ['s1', 's2'], failed: [], members: [
      { id: 's1', isPrimary: true, previousStatus: 'confirmed' },
      { id: 's2', isPrimary: false, previousStatus: 'pending', landed: { scheduled_date: '2026-08-11', window_start: '08:00', window_end: '10:00' } },
    ] },
  });
  const updateTapped = jest.fn().mockResolvedValue(1);
  const updateSib = jest.fn().mockResolvedValue(1);
  const insert = jest.fn().mockResolvedValue();
  const queue = [
    readRow({ scheduled_date: '2026-08-04', window_start: '09:00', window_end: '11:00', technician_id: 't1', status: 'confirmed', auto_dispatch_locked: false, auto_dispatch_excluded: false }),
    { where() { return this; }, update: updateTapped },
    { where() { return this; }, update: updateSib },
    { insert }, // sibling's compensating confirmed→pending row
  ];
  db.mockImplementation(() => queue.shift());

  const res = await applyAutoDispatchMove(SERVICE, BEST, 'run1', { notifyCustomers: false });
  expect(res).toMatchObject({ ok: true, post_status: 'confirmed' });
  expect(updateTapped.mock.calls[0][0].status).toBeUndefined();
  expect(updateSib.mock.calls[0][0]).toMatchObject({ status: 'pending', last_auto_dispatch_run_id: 'run1', auto_dispatch_change_count: { raw: 'COALESCE(auto_dispatch_change_count, 0) + 1' } });
  expect(insert).toHaveBeenCalledWith({ job_id: 's2', from_status: 'confirmed', to_status: 'pending', transitioned_by: null });
});

test('a grouped sibling whose status moved on after the unit move (cancel/complete/start) is NOT rewound to pending and gets no false history row', async () => {
  SmartRebooker.reschedule.mockResolvedValueOnce({
    success: true,
    visitMove: { visitId: 'v1', moved: ['s1', 's2'], failed: [], members: [
      { id: 's1', isPrimary: true, previousStatus: 'confirmed' },
      { id: 's2', isPrimary: false, previousStatus: 'pending', landed: { scheduled_date: '2026-08-11', window_start: '08:00', window_end: '10:00' } },
    ] },
  });
  const updateTapped = jest.fn().mockResolvedValue(1);
  const sibWhere = jest.fn();
  const updateSibFenced = jest.fn().mockResolvedValue(0); // status is no longer 'confirmed'
  const updateSibPlain = jest.fn().mockResolvedValue(1);
  const insert = jest.fn().mockResolvedValue();
  const queue = [
    readRow({ scheduled_date: '2026-08-04', window_start: '09:00', window_end: '11:00', technician_id: 't1', status: 'confirmed', auto_dispatch_locked: false, auto_dispatch_excluded: false }),
    { where() { return this; }, update: updateTapped },
    { where(pred) { sibWhere(pred); return this; }, update: updateSibFenced },
    { where() { return this; }, update: updateSibPlain },
  ];
  db.mockImplementation(() => queue.shift());

  await applyAutoDispatchMove(SERVICE, BEST, 'run1', { notifyCustomers: false });
  // fenced on status AND the landed slot (local audit): a newer confirm/move is never rewound
  expect(sibWhere).toHaveBeenCalledWith({ id: 's2', status: 'confirmed', scheduled_date: '2026-08-11', window_start: '08:00', window_end: '10:00', customer_confirmed: false });
  expect(updateSibPlain).not.toHaveBeenCalled(); // fence miss ⇒ no stamp at all (local audit)
  expect(insert).not.toHaveBeenCalled();
});

test('a grouped visit that only PARTLY moved is an explicit failure carrying movedCount (rows that moved still get bookkeeping)', async () => {
  SmartRebooker.reschedule.mockResolvedValueOnce({
    success: true,
    visitMove: { visitId: 'v1', moved: ['s1'], failed: [{ id: 's2', reason: 'member s2 boom', code: 'SLOT_TAKEN' }], members: [
      { id: 's1', isPrimary: true, previousStatus: 'confirmed' },
    ] },
  });
  const updateTapped = jest.fn().mockResolvedValue(1);
  const queue = [
    readRow({ scheduled_date: '2026-08-04', window_start: '09:00', window_end: '11:00', technician_id: 't1', status: 'confirmed', auto_dispatch_locked: false, auto_dispatch_excluded: false }),
    { where() { return this; }, update: updateTapped },
  ];
  db.mockImplementation(() => queue.shift());
  await expect(applyAutoDispatchMove(SERVICE, BEST, 'run1', { notifyCustomers: false }))
    .rejects.toMatchObject({ code: 'VISIT_PARTIAL_MOVE', movedCount: 1, failedMembers: ['s2'] });
  expect(updateTapped).toHaveBeenCalledTimes(1);
});

test('a full grouped move reports movedCount = every moved row', async () => {
  SmartRebooker.reschedule.mockResolvedValueOnce({
    success: true,
    visitMove: { visitId: 'v1', moved: ['s1', 's2'], failed: [], members: [
      { id: 's1', isPrimary: true, previousStatus: 'confirmed' },
      { id: 's2', isPrimary: false, previousStatus: 'confirmed' },
    ] },
  });
  const queue = [
    readRow({ scheduled_date: '2026-08-04', window_start: '09:00', window_end: '11:00', technician_id: 't1', status: 'confirmed', auto_dispatch_locked: false, auto_dispatch_excluded: false }),
    { where() { return this; }, update: jest.fn().mockResolvedValue(1) },
    { where() { return this; }, update: jest.fn().mockResolvedValue(1) },
  ];
  db.mockImplementation(() => queue.shift());
  const res = await applyAutoDispatchMove(SERVICE, BEST, 'run1', { notifyCustomers: false });
  expect(res.movedCount).toBe(2);
});

test('a failed visit-parent retarget after a full member move is an explicit failure carrying movedCount', async () => {
  SmartRebooker.reschedule.mockResolvedValueOnce({
    success: true,
    warnings: ['visit parent retarget failed: boom'],
    visitMove: { visitId: 'v1', moved: ['s1', 's2'], failed: [], parentRetargetFailed: true, members: [
      { id: 's1', isPrimary: true, previousStatus: 'confirmed' },
      { id: 's2', isPrimary: false, previousStatus: 'confirmed' },
    ] },
  });
  const queue = [
    readRow({ scheduled_date: '2026-08-04', window_start: '09:00', window_end: '11:00', technician_id: 't1', status: 'confirmed', auto_dispatch_locked: false, auto_dispatch_excluded: false }),
    { where() { return this; }, update: jest.fn().mockResolvedValue(1) },
    { where() { return this; }, update: jest.fn().mockResolvedValue(1) },
  ];
  db.mockImplementation(() => queue.shift());
  await expect(applyAutoDispatchMove(SERVICE, BEST, 'run1', { notifyCustomers: false }))
    .rejects.toMatchObject({ code: 'VISIT_PARENT_RETARGET_FAILED', movedCount: 2 });
});

test('the remaining per-run budget is handed to the unit move as maxUnitSize', async () => {
  const queue = [
    readRow({ scheduled_date: '2026-08-04', window_start: '09:00', window_end: '11:00', technician_id: 't1', status: 'confirmed', auto_dispatch_locked: false, auto_dispatch_excluded: false }),
    { where() { return this; }, update: jest.fn().mockResolvedValue(1) },
  ];
  db.mockImplementation(() => queue.shift());
  await applyAutoDispatchMove(SERVICE, BEST, 'run1', { notifyCustomers: false, remainingChanges: 4 });
  expect(SmartRebooker.reschedule.mock.calls[0][5].maxUnitSize).toBe(4);
});

describe('grouped member guard (codex #3609 r13 P1)', () => {
  // scheduled_services: the first call answers the member row read
  // (`siblings`), later calls are the per-sibling same-series date probes
  // (`seriesClash`, keyed by the sibling id the probe's whereNotIn excludes
  // is not observable, so one answer serves every probe).
  // Sibling rows come back customer-joined (eligibility needs customer_active +
  // geo); `eligible()` builds a row the orchestrator's gate accepts.
  const FAR = (() => { const d = new Date(); d.setUTCDate(d.getUTCDate() + 40); return d.toISOString().slice(0, 10); })();
  const eligible = (over = {}) => ({ id: 's2', service_type: 'Lawn Fertilization', is_recurring: true, recurring_parent_id: 'p2', status: 'confirmed', scheduled_date: FAR, auto_dispatch_locked: false, auto_dispatch_excluded: false, customer_active: true, customer_latitude: 27.5, customer_longitude: -82.4, ...over });
  // `capsByTech` answers the capability read per technician_id (the fence's
  // where clause); plain `caps` answers regardless of tech.
  const fakeTrx = ({ siblings = [], caps = [], capsByTech = null, seriesClash = null, planAlert = null } = {}) => {
    const calls = [];
    let ssCalls = 0;
    const trx = jest.fn((table) => {
      calls.push(String(table).split(' ')[0]);
      const isSS = String(table).startsWith('scheduled_services');
      const probe = isSS && ssCalls++ > 0;
      let techFilter = null;
      const api = {
        where: (w) => { if (typeof w === 'function') w.call(api); else if (w && w.technician_id) techFilter = w.technician_id; return api; },
        orWhere: () => api,
        whereIn: (column, values) => { if (column === 'technician_id') [techFilter] = values; return api; },
        whereNotIn: () => api, whereNull: () => api, leftJoin: () => api,
        forShare: () => api,
        select: async () => (isSS ? siblings : (capsByTech ? (capsByTech[techFilter] || []) : caps)),
        first: async () => (table === 'recurring_plan_alerts' ? planAlert : (probe ? seriesClash : null)),
      };
      return api;
    });
    trx.__calls = calls;
    return trx;
  };
  const primary = { id: 's1', status: 'confirmed' };

  test('applyAutoDispatchMove hands the unit mover a member guard AND the rebooker a per-row move guard', async () => {
    const queue = [
      readRow({ scheduled_date: '2026-08-04', window_start: '09:00', window_end: '11:00', technician_id: 't1', status: 'confirmed', auto_dispatch_locked: false, auto_dispatch_excluded: false }),
      { where() { return this; }, update: jest.fn().mockResolvedValue(1) },
    ];
    db.mockImplementation(() => queue.shift());
    await applyAutoDispatchMove(SERVICE, BEST, 'run1', {});
    const opts = SmartRebooker.reschedule.mock.calls[0][5];
    expect(typeof opts.memberGuard).toBe('function');
    expect(typeof opts.moveGuard).toBe('function');
  });

  test('move guard: the tapped row (standalone or primary) is re-checked against the receiving tech inside the move trx — Off refuses, active/missing pass, tech unchanged included', async () => {
    const { makeMoveGuard } = require('../services/auto-dispatch/apply');
    const lawnRow = { ...SERVICE, service_type: 'Lawn Fertilization' };
    const lawn = classifyServiceCategory(lawnRow.service_type);
    // Same tech as the row (BEST.technician_id === SERVICE.technician_id): still read.
    const guard = makeMoveGuard({ service: lawnRow, best: BEST });
    let trx = fakeTrx({ caps: [{ service_category: lawn, active: false }] });
    await expect(guard({ trx, technicianId: 't1' })).rejects.toMatchObject({ code: 'VISIT_AUTO_DISPATCH_CAPABILITY_GUARD', statusCode: 409 });
    // technician row share-locked FIRST (serializes with the editor's FOR UPDATE), then the read
    expect(trx.__calls).toEqual(['technicians', 'technician_capabilities']);
    trx = fakeTrx({ caps: [{ service_category: lawn, active: true }] });
    await expect(guard({ trx, technicianId: 't1' })).resolves.toBeUndefined();
    trx = fakeTrx({ caps: [] });
    await expect(guard({ trx, technicianId: 't1' })).resolves.toBeUndefined();
    // The DESTINATION (placement) tech is what gets checked, not the tech the
    // rebooker says the row is kept on: the unit mover strips technicianId
    // from member moves, so that "kept" tech is the old one. Old tech Off for
    // lawn + destination active → passes; destination Off → refuses.
    const toT2 = makeMoveGuard({ service: lawnRow, best: { ...BEST, technician_id: 't2' } });
    trx = fakeTrx({ capsByTech: { t1: [{ service_category: lawn, active: false }], t2: [{ service_category: lawn, active: true }] } });
    await expect(toT2({ trx, technicianId: 't1' })).resolves.toBeUndefined();
    trx = fakeTrx({ capsByTech: { t1: [{ service_category: lawn, active: true }], t2: [{ service_category: lawn, active: false }] } });
    await expect(toT2({ trx, technicianId: 't1' })).rejects.toMatchObject({ code: 'VISIT_AUTO_DISPATCH_CAPABILITY_GUARD' });
    // No receiving tech at all → nothing to check, no read.
    const unassigned = makeMoveGuard({ service: { ...lawnRow, technician_id: null }, best: { ...BEST, technician_id: null } });
    trx = fakeTrx();
    await expect(unassigned({ trx, technicianId: null })).resolves.toBeUndefined();
    expect(trx.__calls).toEqual([]);
    // A grouped SIBLING moved by the unit mover: the rebooker hands its own row,
    // which is what gets checked — not the closure's primary.
    const pestPrimary = makeMoveGuard({ service: { ...SERVICE, service_type: 'Quarterly Pest Control' }, best: BEST });
    trx = fakeTrx({ caps: [{ service_category: lawn, active: false }] });
    await expect(pestPrimary({ trx, technicianId: 't1', service: { id: 's2', service_type: 'Lawn Fertilization' } })).rejects.toMatchObject({ code: 'VISIT_AUTO_DISPATCH_CAPABILITY_GUARD' });
  });

  test('no siblings ⇒ nothing to check; a non-live sibling (customer reschedule request) refuses', async () => {
    const guard = makeMemberGuard({ service: SERVICE, best: BEST, config: {}, techChanged: false });
    const trx = fakeTrx();
    await expect(guard({ trx, members: [primary] })).resolves.toBeUndefined();
    expect(trx).not.toHaveBeenCalled();
    await expect(guard({ trx, members: [primary, { id: 's2', status: 'rescheduled' }] }))
      .rejects.toMatchObject({ statusCode: 409, code: 'VISIT_MEMBER_AUTO_DISPATCH_GUARD', memberId: 's2' });
  });

  test('route tiers on: a sibling inside its 72h reminder band, or an unreadable check, refuses (fail closed); tiers off never queries it', async () => {
    const members = [primary, { id: 's2', status: 'pending' }, { id: 's3', status: 'confirmed' }];
    const on = makeMemberGuard({ service: SERVICE, best: BEST, config: { routeTiersEnabled: true }, techChanged: false });
    routeTiers.loadReminderFreeze.mockResolvedValueOnce({ failed: false, frozen: new Set(['s3']) });
    const trx = fakeTrx();
    await expect(on({ trx, members })).rejects.toMatchObject({ code: 'VISIT_MEMBER_AUTO_DISPATCH_GUARD', memberId: 's3' });
    // queried on the caller's TRANSACTION for the SIBLINGS only
    expect(routeTiers.loadReminderFreeze).toHaveBeenLastCalledWith(trx, ['s2', 's3'], expect.any(Date));
    routeTiers.loadReminderFreeze.mockResolvedValueOnce({ failed: true, frozen: new Set() });
    await expect(on({ trx, members })).rejects.toMatchObject({ code: 'VISIT_MEMBER_AUTO_DISPATCH_GUARD' });
    routeTiers.loadReminderFreeze.mockResolvedValueOnce({ failed: false, frozen: new Set() });
    await expect(on({ trx, members })).resolves.toBeUndefined();
    routeTiers.loadReminderFreeze.mockClear();
    const off = makeMemberGuard({ service: SERVICE, best: BEST, config: {}, techChanged: false });
    await expect(off({ trx, members })).resolves.toBeUndefined();
    expect(routeTiers.loadReminderFreeze).not.toHaveBeenCalled();
  });

  test('the receiving tech DEACTIVATED for a sibling category refuses; missing/qualified passes; an UNCHANGED tech is re-read too (Off can land mid-run)', async () => {
    const lawn = classifyServiceCategory('Lawn Fertilization');
    const members = [primary, { id: 's2', status: 'confirmed' }];
    const best = { ...BEST, technician_id: 't9' };
    const guard = makeMemberGuard({ service: SERVICE, best, config: {}, techChanged: true });
    let trx = fakeTrx({ siblings: [eligible()], caps: [{ service_category: lawn, active: false }] });
    await expect(guard({ trx, members })).rejects.toMatchObject({ code: 'VISIT_MEMBER_AUTO_DISPATCH_GUARD', memberId: 's2' });
    expect(trx.__calls).toEqual(['scheduled_services', 'recurring_plan_alerts', 'scheduled_services', 'technicians', 'technician_capabilities']); // member read, plan check, series probe, tech-row share lock, capability
    trx = fakeTrx({ siblings: [eligible()], caps: [] });
    await expect(guard({ trx, members })).resolves.toBeUndefined();
    trx = fakeTrx({ siblings: [eligible()], caps: [{ service_category: lawn, active: true }] });
    await expect(guard({ trx, members })).resolves.toBeUndefined();
    // Same tech: the run's capability map is a start-of-run snapshot, so the
    // apply fence still reads the committed row — an Off written by the Team
    // tab during the run refuses; qualified passes.
    const same = makeMemberGuard({ service: SERVICE, best, config: {}, techChanged: false });
    trx = fakeTrx({ siblings: [eligible()], caps: [{ service_category: lawn, active: false }] });
    await expect(same({ trx, members })).rejects.toMatchObject({ code: 'VISIT_MEMBER_AUTO_DISPATCH_GUARD', memberId: 's2' });
    expect(trx.__calls).toContain('technician_capabilities');
    trx = fakeTrx({ siblings: [eligible()], caps: [{ service_category: lawn, active: true }] });
    await expect(same({ trx, members })).resolves.toBeUndefined();
  });

  test('route tiers on: each sibling must admit best.date inside its OWN tier/drift window; unknown anchor evidence refuses (local codex audit)', async () => {
    const today = etDateString(new Date());
    const dayOffset = (n) => etDateString(addETDays(parseETDateTime(`${today}T12:00`), n));
    const sibDate = dayOffset(30); // tier 1: widest radius
    const members = [primary, { id: 's2', status: 'confirmed' }];
    const sib = eligible({ scheduled_date: sibDate, auto_dispatch_change_count: 0 });
    const win = routeTiers.tierMoveWindow({ origDate: sibDate, anchorDate: sibDate, today, radius: routeTiers.tierRadiusForDaysOut(30) });
    expect(win).toBeTruthy();
    const on = (date) => makeMemberGuard({ service: SERVICE, best: { ...BEST, date }, config: { routeTiersEnabled: true }, techChanged: false });
    // inside the sibling's window ⇒ passes (anchor = its own date, never moved)
    await expect(on(win.dateTo)({ trx: fakeTrx({ siblings: [sib] }), members })).resolves.toBeUndefined();
    // one day past the sibling's drift budget ⇒ refused, even though the PRIMARY may have budget left
    await expect(on(shiftDateStr(win.dateTo, 1))({ trx: fakeTrx({ siblings: [sib] }), members }))
      .rejects.toMatchObject({ code: 'VISIT_MEMBER_AUTO_DISPATCH_GUARD', memberId: 's2' });
    // a sibling already moved by auto-dispatch: its DURABLE anchor bounds the budget
    routeTiers.loadAnchorMap.mockResolvedValueOnce(new Map([['s2', shiftDateStr(sibDate, -5)]]));
    await expect(on(shiftDateStr(sibDate, 1))({ trx: fakeTrx({ siblings: [{ ...sib, auto_dispatch_change_count: 1 }] }), members }))
      .rejects.toMatchObject({ code: 'VISIT_MEMBER_AUTO_DISPATCH_GUARD', memberId: 's2' });
    // change_count > 0 with no durable record ⇒ anchor unknown ⇒ refuse
    await expect(on(win.dateTo)({ trx: fakeTrx({ siblings: [{ ...sib, auto_dispatch_change_count: 1 }] }), members }))
      .rejects.toMatchObject({ code: 'VISIT_MEMBER_AUTO_DISPATCH_GUARD', memberId: 's2' });
    // evidence unreadable ⇒ refuse (fail closed)
    routeTiers.loadAnchorMap.mockResolvedValueOnce(null);
    await expect(on(win.dateTo)({ trx: fakeTrx({ siblings: [sib] }), members })).rejects.toMatchObject({ code: 'VISIT_MEMBER_AUTO_DISPATCH_GUARD' });
    // inside the <7-day no-move tier ⇒ refuse
    await expect(on(dayOffset(8))({ trx: fakeTrx({ siblings: [{ ...sib, scheduled_date: dayOffset(3) }] }), members }))
      .rejects.toMatchObject({ code: 'VISIT_MEMBER_AUTO_DISPATCH_GUARD', memberId: 's2' });
    // tiers off ⇒ no anchor read at all
    routeTiers.loadAnchorMap.mockClear();
    await expect(makeMemberGuard({ service: SERVICE, best: { ...BEST, date: shiftDateStr(win.dateTo, 20) }, config: {}, techChanged: false })({ trx: fakeTrx({ siblings: [sib] }), members })).resolves.toBeUndefined();
    expect(routeTiers.loadAnchorMap).not.toHaveBeenCalled();
  });

  test('preferred time: a sibling whose DERIVED start falls outside the explicit preferred window refuses (codex r16 P1)', async () => {
    const members = [primary, { id: 's2', status: 'confirmed' }];
    const prefs = { preferred_time_window: { startMin: 13 * 60, endMin: 17 * 60 } }; // 13:00–17:00
    const guard = (p) => makeMemberGuard({ service: SERVICE, best: BEST, config: { prefs: p }, techChanged: false });
    const targets = (sibStart) => [{ id: 's1', isPrimary: true, startHHMM: '15:00' }, { id: 's2', isPrimary: false, startHHMM: sibStart }];
    const sib = eligible();
    await expect(guard(prefs)({ trx: fakeTrx({ siblings: [sib] }), members, targets: targets('17:00') })).rejects.toMatchObject({ code: 'VISIT_MEMBER_AUTO_DISPATCH_GUARD', memberId: 's2' });
    await expect(guard(prefs)({ trx: fakeTrx({ siblings: [sib] }), members, targets: targets('16:00') })).resolves.toBeUndefined();
    // windowless sibling / no explicit window / no prefs ⇒ nothing to check
    await expect(guard(prefs)({ trx: fakeTrx({ siblings: [sib] }), members, targets: targets(null) })).resolves.toBeUndefined();
    await expect(guard({ preferred_time_window: null })({ trx: fakeTrx({ siblings: [sib] }), members, targets: targets('17:00') })).resolves.toBeUndefined();
    await expect(guard(undefined)({ trx: fakeTrx({ siblings: [sib] }), members, targets: targets('17:00') })).resolves.toBeUndefined();
  });

  test('skip_weekends: a Saturday target refuses when any sibling skips weekends (codex r15 P1)', async () => {
    const today = etDateString(new Date());
    let n = 1; let sat = null;
    while (!sat) { const d = etDateString(addETDays(parseETDateTime(`${today}T12:00`), n)); if (new Date(`${d}T12:00:00Z`).getUTCDay() === 6) sat = d; n += 1; }
    const friday = shiftDateStr(sat, -1);
    const members = [primary, { id: 's2', status: 'confirmed' }];
    const guard = (date) => makeMemberGuard({ service: SERVICE, best: { ...BEST, date }, config: {}, techChanged: false });
    const skipper = eligible({ skip_weekends: true });
    await expect(guard(sat)({ trx: fakeTrx({ siblings: [skipper] }), members })).rejects.toMatchObject({ code: 'VISIT_MEMBER_AUTO_DISPATCH_GUARD', memberId: 's2' });
    await expect(guard(friday)({ trx: fakeTrx({ siblings: [skipper] }), members })).resolves.toBeUndefined();
    await expect(guard(sat)({ trx: fakeTrx({ siblings: [{ ...skipper, skip_weekends: false }] }), members })).resolves.toBeUndefined();
  });

  test('per-row eligibility (local audit): a one-time / booster, parent-template, locked, geo-less, archived-customer or lapsed-plan sibling refuses the grouped automatic move', async () => {
    const members = [primary, { id: 's2', status: 'confirmed' }];
    const guard = makeMemberGuard({ service: SERVICE, best: BEST, config: {}, techChanged: false });
    const cases = [
      [eligible({ is_recurring: false }), /NON_RECURRING/],
      [eligible({ recurring_parent_id: null }), /PARENT_TEMPLATE_ROW/],
      [eligible({ auto_dispatch_locked: true }), /MANUALLY_LOCKED/],
      [eligible({ customer_latitude: null }), /MISSING_GEO/],
      [eligible({ customer_active: false }), /CUSTOMER_INACTIVE/],
      [eligible({ customer_deleted_at: '2026-01-01' }), /archived customer/],
    ];
    for (const [row, re] of cases) {
      const err = await guard({ trx: fakeTrx({ siblings: [row] }), members }).catch((e) => e);
      expect(err).toMatchObject({ code: 'VISIT_MEMBER_AUTO_DISPATCH_GUARD', memberId: 's2' });
      expect(err.message).toMatch(re);
    }
    // an unresolved plan_lapsed / plan_ending alert on the sibling's series ⇒ inactive plan ⇒ refuse
    const err = await guard({ trx: fakeTrx({ siblings: [eligible()], planAlert: { id: 'al', alert_type: 'plan_lapsed' } }), members }).catch((e) => e);
    expect(err).toMatchObject({ code: 'VISIT_MEMBER_AUTO_DISPATCH_GUARD', memberId: 's2' });
    expect(err.message).toMatch(/RECURRING_PLAN_INACTIVE/);
    // the orchestrator's lock boundary applies to siblings too (legacy flat lock)
    const locked = makeMemberGuard({ service: SERVICE, best: BEST, config: { lockBoundary: '2099-12-31', lockWindowDays: 14 }, techChanged: false });
    const err2 = await locked({ trx: fakeTrx({ siblings: [eligible()] }), members }).catch((e) => e);
    expect(err2.message).toMatch(/INSIDE_LOCK_WINDOW/);
    // an eligible sibling passes
    await expect(guard({ trx: fakeTrx({ siblings: [eligible()] }), members })).resolves.toBeUndefined();
  });

  test('same-series date: a sibling whose recurring series already has another visit on the target date refuses (codex r14 P1)', async () => {
    const members = [primary, { id: 's2', status: 'confirmed' }];
    const guard = makeMemberGuard({ service: SERVICE, best: BEST, config: {}, techChanged: false });
    let trx = fakeTrx({ siblings: [eligible()], seriesClash: { id: 'other-occurrence' } });
    await expect(guard({ trx, members })).rejects.toMatchObject({ code: 'VISIT_MEMBER_AUTO_DISPATCH_GUARD', memberId: 's2' });
    expect(trx.__calls).toEqual(['scheduled_services', 'recurring_plan_alerts', 'scheduled_services']); // member read, plan check, then the series probe
    // a clean series passes
    trx = fakeTrx({ siblings: [eligible()], seriesClash: null });
    await expect(guard({ trx, members })).resolves.toBeUndefined();
  });
});


const LOCATION = {
  property_id: 'property-original', service_address_line1: '100 Example Street', service_address_line2: '',
  service_address_city: 'Example City', service_address_state: 'FL', service_address_zip: '00000', lat: '27.4', lng: '-82.5',
};
test.each(Object.keys(LOCATION))('rejects a changed %s before applying a scored move', async (field) => {
  const scored = { ...SERVICE, ...LOCATION };
  db.mockImplementation(() => readRow({ ...scored, [field]: field === 'lat' || field === 'lng' ? '28.5' : 'changed' }));
  await expect(applyAutoDispatchMove(scored, BEST, 'run1', {})).rejects.toMatchObject({ code: 'STALE_PLACEMENT' });
  expect(SmartRebooker.reschedule).not.toHaveBeenCalled();
});

test('pins the complete location in the atomic rebooker expectation', async () => {
  const scored = { ...SERVICE, ...LOCATION };
  const queue = [readRow(scored), { where() { return this; }, update: jest.fn().mockResolvedValue(1) }];
  db.mockImplementation(() => queue.shift());
  await applyAutoDispatchMove(scored, BEST, 'run1', {});
  expect(SmartRebooker.reschedule.mock.calls[0][5].expect).toMatchObject(LOCATION);
});
