// Team tab API — employment status + field eligibility (Field Team Program,
// Phase 0 item 1). Mirrors the mock style of
// admin-timetracking-technician-boundaries.test.js.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/time-tracking', () => ({}));
jest.mock('../services/push-notifications', () => ({ deactivateStaffUser: jest.fn(async () => 1) }));
jest.mock('../sockets', () => ({ disconnectStaffSockets: jest.fn() }));
jest.mock('../services/tech-photo', () => ({ resolveTechPhotoUrl: jest.fn(async (_k, fallback) => fallback) }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (_req, _res, next) => next(),
  requireTechOrAdmin: (_req, _res, next) => next(),
  requireAdmin: (_req, _res, next) => next(),
}));
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({ send: jest.fn() })),
  PutObjectCommand: jest.fn(), GetObjectCommand: jest.fn(), DeleteObjectCommand: jest.fn(),
}));
jest.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: jest.fn() }));

const db = require('../models/db');
const PushService = require('../services/push-notifications');
const router = require('../routes/admin-timetracking');
const { createTechnician, deactivateTechnician, updateTechnician } = router._handlers;

const ADAM = {
  id: 'adam', name: 'Adam', email: 'adam@wavespestcontrol.com', role: 'admin',
  active: true, employment_status: 'active', field_dispatchable: true, auth_token_version: 3,
};
const PLACEHOLDER = {
  id: 'tech-1', name: 'Tech #1', email: null, role: 'technician',
  active: false, employment_status: 'prospective', field_dispatchable: false, auth_token_version: 0,
};

function makeChain({ rows = [], first, returning = [] } = {}) {
  const chain = {};
  for (const m of ['insert', 'orderBy', 'orderByRaw', 'select', 'update', 'where', 'whereNot', 'whereIn', 'whereNotIn', 'whereNotNull', 'whereRaw', 'forUpdate', 'leftJoin']) {
    chain[m] = jest.fn(() => chain);
  }
  chain.first = jest.fn(async () => first);
  chain.returning = jest.fn(async () => returning);
  chain.then = (res, rej) => Promise.resolve(rows).then(res, rej);
  return chain;
}

// createTechnician seeds technician_capabilities on the same trx
// (insert → onConflict → ignore); the chain resolves to nothing.
function capabilityChain() {
  const chain = makeChain();
  chain.onConflict = jest.fn(() => chain);
  chain.ignore = jest.fn(async () => undefined);
  chain.merge = jest.fn(async () => undefined);
  return chain;
}

function response() {
  return { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
}

async function invoke(handler, req) {
  const res = response();
  const next = jest.fn();
  await handler(req, res, next);
  if (next.mock.calls[0]?.[0]) throw next.mock.calls[0][0];
  return res;
}

// techChains: queue of technicians-table chains; history: per-table first() answers;
// futureVisits: rows the deactivate handler lists.
function installTransaction(techChains, { history = {}, futureVisits = [] } = {}) {
  const queue = [...techChains];
  const trx = jest.fn((table) => {
    if (table === 'time_entries') return makeChain({ first: history.time_entries });
    if (table === 'scheduled_services') return makeChain({ first: history.scheduled_services });
    if (table === 'service_records') return makeChain({ first: history.service_records });
    if (table === 'review_incentive_payouts') return makeChain({ first: history.review_incentive_payouts });
    if (['payroll_checks', 'payroll_pay_lines', 'payroll_time_off', 'payroll_w4_elections'].includes(table)) {
      return makeChain({ first: history[table] });
    }
    if (table === 'tech_voice_pins') {
      const c = makeChain();
      c.del = jest.fn(async () => 0);
      return c;
    }
    if (table === 'audit_log') return makeChain({ returning: [{ id: 'audit-1' }] });
    if (table === 'scheduled_services as s') return makeChain({ rows: futureVisits });
    if (table === 'technician_capabilities') return capabilityChain();
    if (table !== 'technicians') throw new Error(`Unexpected transaction table: ${table}`);
    const chain = queue.shift();
    if (!chain) throw new Error('Unexpected technicians query');
    return chain;
  });
  trx.raw = jest.fn(async () => undefined);
  trx.fn = { now: jest.fn(() => 'NOW') };
  // A savepoint of the save's transaction (the shift-hours list reads in one).
  trx.transaction = jest.fn(async (cb) => cb(trx));
  db.transaction = jest.fn(async (cb) => cb(trx));
  return trx;
}

beforeEach(() => jest.clearAllMocks());

describe('createTechnician', () => {
  test('a Team-tab profile is active + NOT field-dispatchable by default (assignment is granted, never implied)', async () => {
    const insert = makeChain({ returning: [{ ...ADAM, id: 'new', field_dispatchable: false }] });
    installTransaction([makeChain({ first: undefined }), insert]);
    const res = await invoke(createTechnician, { body: { name: 'Casey', email: 'casey@example.com' } });
    expect(res.statusCode).toBe(200);
    expect(insert.insert).toHaveBeenCalledWith(expect.objectContaining({
      employment_status: 'active', active: true, field_dispatchable: false,
      // Owner 2026-10-25: a new technician cannot move visits until switched on.
      can_move_visits: false,
    }));
  });

  test('a prospective placeholder needs only a name: no email, no login, not dispatchable', async () => {
    const insert = makeChain({ returning: [PLACEHOLDER] });
    installTransaction([insert]);
    const res = await invoke(createTechnician, { body: { name: 'Tech #1', employmentStatus: 'prospective' } });
    expect(res.statusCode).toBe(200);
    expect(insert.insert).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Tech #1', email: null, employment_status: 'prospective', active: false, field_dispatchable: false,
    }));
    expect(insert.insert.mock.calls[0][0]).not.toHaveProperty('password_hash');
    expect(res.body.technician).toMatchObject({ employment_status: 'prospective', field_dispatchable: false });
  });

  test('an active profile still requires a staff email; inactive cannot be created; bad inputs are 400', async () => {
    expect((await invoke(createTechnician, { body: { name: 'X' } })).statusCode).toBe(400);
    expect((await invoke(createTechnician, { body: { name: 'X', employmentStatus: 'inactive' } })).statusCode).toBe(400);
    expect((await invoke(createTechnician, { body: { name: 'X', employmentStatus: 'fired' } })).statusCode).toBe(400);
    expect((await invoke(createTechnician, { body: { name: 'X', employmentStatus: 'prospective', fieldDispatchable: 'yes' } })).statusCode).toBe(400);
    expect((await invoke(createTechnician, { body: { name: 'X', employmentStatus: 'prospective', canMoveVisits: 'yes' } })).statusCode).toBe(400);
    expect(db.transaction).not.toHaveBeenCalled();
  });
});

describe('updateTechnician', () => {
  test('renaming an unused placeholder is allowed (that is how a hire takes over the row)', async () => {
    const target = makeChain({ first: PLACEHOLDER });
    const write = makeChain();
    const reread = makeChain({ first: { ...PLACEHOLDER, name: 'Jordan Reyes' } });
    installTransaction([target, write, reread]);
    const res = await invoke(updateTechnician, { params: { id: 'tech-1' }, body: { name: 'Jordan Reyes' }, technicianId: 'adam' });
    expect(res.statusCode).toBe(200);
    expect(write.update).toHaveBeenCalledWith(expect.objectContaining({ name: 'Jordan Reyes' }));
  });

  test('canCreateEstimates (GATE_TECH_ESTIMATES) must be a boolean; a boolean writes can_create_estimates and comes back on the row', async () => {
    const bad = await invoke(updateTechnician, { params: { id: 'tech-1' }, body: { canCreateEstimates: 'yes' }, technicianId: 'adam' });
    expect(bad.statusCode).toBe(400);
    const target = makeChain({ first: { ...ADAM, id: 'tech-9', role: 'technician' } });
    const write = makeChain();
    const reread = makeChain({ first: { ...ADAM, id: 'tech-9', role: 'technician', can_create_estimates: true } });
    installTransaction([target, write, reread]);
    const res = await invoke(updateTechnician, { params: { id: 'tech-9' }, body: { canCreateEstimates: true }, technicianId: 'adam' });
    expect(res.statusCode).toBe(200);
    expect(write.update).toHaveBeenCalledWith(expect.objectContaining({ can_create_estimates: true }));
    expect(res.body.technician.can_create_estimates).toBe(true);
  });

  test.each([
    ['service history', { scheduled_services: { id: 'ss-1' } }],
    ['completed service records', { service_records: { id: 'sr-1' } }],
    ['time entries', { time_entries: { id: 'te-1' } }],
    ['review payouts', { review_incentive_payouts: { id: 'rp-1' } }],
  ])('a row with %s cannot be renamed into a different person (409 IDENTITY_LOCKED, no write)', async (_label, history) => {
    const target = makeChain({ first: { ...ADAM, id: 'tech-9', name: 'Jordan Reyes', role: 'technician' } });
    const write = makeChain();
    installTransaction([target, write], { history });
    const res = await invoke(updateTechnician, { params: { id: 'tech-9' }, body: { name: 'Someone Else' }, technicianId: 'adam' });
    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('IDENTITY_LOCKED');
    expect(write.update).not.toHaveBeenCalled();
  });

  test('same-name saves on a historied row are not a rename', async () => {
    const target = makeChain({ first: { ...ADAM, id: 'tech-9', name: 'Jordan Reyes', role: 'technician' } });
    const write = makeChain();
    const reread = makeChain({ first: { ...ADAM, id: 'tech-9', name: 'Jordan Reyes', phone: '+15550001111' } });
    installTransaction([target, write, reread], { history: { scheduled_services: { id: 'ss-1' } } });
    const res = await invoke(updateTechnician, { params: { id: 'tech-9' }, body: { name: 'Jordan Reyes', phone: '+15550001111' }, technicianId: 'adam' });
    expect(res.statusCode).toBe(200);
  });

  test('prospective → active rotates credentials and writes both columns; the legacy active:true input maps the same way', async () => {
    for (const body of [{ employmentStatus: 'active', email: 'jordan@wavespestcontrol.com' }, { active: true, email: 'jordan@wavespestcontrol.com' }]) {
      jest.clearAllMocks();
      const target = makeChain({ first: PLACEHOLDER });
      const noConflict = makeChain({ first: undefined });
      const write = makeChain();
      const reread = makeChain({ first: { ...PLACEHOLDER, email: 'jordan@wavespestcontrol.com', employment_status: 'active', active: true, auth_token_version: 1 } });
      installTransaction([target, noConflict, write, reread]);
      const res = await invoke(updateTechnician, { params: { id: 'tech-1' }, body, technicianId: 'adam' });
      expect(res.statusCode).toBe(200);
      expect(write.update).toHaveBeenCalledWith(expect.objectContaining({
        employment_status: 'active', active: true, auth_token_version: 1,
      }));
    }
  });

  test('active → prospective is a leave-active transition: sessions revoked, push deactivated, legacy flag false, remaining visits listed', async () => {
    const target = makeChain({ first: { ...ADAM, id: 'tech-9', role: 'technician', auth_token_version: 5 } });
    const write = makeChain();
    const reread = makeChain({ first: { ...ADAM, id: 'tech-9', employment_status: 'prospective', active: false } });
    installTransaction([target, write, reread], { futureVisits: [{ id: 'ss-7', scheduled_date: '2026-09-20', service_type: 'Pest Control', first_name: 'Ana', last_name: 'Ruiz' }] });
    const res = await invoke(updateTechnician, { params: { id: 'tech-9' }, body: { employmentStatus: 'prospective' }, technicianId: 'adam' });
    expect(res.statusCode).toBe(200);
    // Offboarding through Edit surfaces the same list as DELETE; nothing on the visit is written.
    expect(res.body.futureAssignedVisits).toEqual([{ id: 'ss-7', scheduledDate: '2026-09-20', serviceType: 'Pest Control', customerName: 'Ana Ruiz' }]);
    expect(write.update).toHaveBeenCalledWith(expect.objectContaining({
      employment_status: 'prospective', active: false, auth_token_version: 6, password_reset_token_hash: null,
    }));
    expect(PushService.deactivateStaffUser).toHaveBeenCalledWith('tech-9', expect.any(Function));
  });

  test('field eligibility toggles independently of employment and never rotates credentials', async () => {
    const target = makeChain({ first: { ...ADAM, id: 'tech-9', role: 'technician', field_dispatchable: false } });
    const write = makeChain();
    const reread = makeChain({ first: { ...ADAM, id: 'tech-9', field_dispatchable: true } });
    installTransaction([target, write, reread]);
    const res = await invoke(updateTechnician, { params: { id: 'tech-9' }, body: { fieldDispatchable: true }, technicianId: 'adam' });
    expect(res.statusCode).toBe(200);
    const patch = write.update.mock.calls[0][0];
    expect(patch).toMatchObject({ field_dispatchable: true });
    expect(patch).not.toHaveProperty('auth_token_version');
    expect(patch).not.toHaveProperty('employment_status');
    expect(PushService.deactivateStaffUser).not.toHaveBeenCalled();
  });

  test('removing field eligibility from an assignable tech lists the visits still on them (they vanish from the board)', async () => {
    const target = makeChain({ first: { ...ADAM, id: 'tech-9', role: 'technician' } });
    const write = makeChain();
    const reread = makeChain({ first: { ...ADAM, id: 'tech-9', field_dispatchable: false } });
    installTransaction([target, write, reread], { futureVisits: [{ id: 'ss-8', scheduled_date: '2026-09-21', service_type: 'Lawn Care', first_name: 'Bo', last_name: 'Lee' }] });
    const res = await invoke(updateTechnician, { params: { id: 'tech-9' }, body: { fieldDispatchable: false }, technicianId: 'adam' });
    expect(res.statusCode).toBe(200);
    expect(res.body.futureAssignedVisits).toEqual([{ id: 'ss-8', scheduledDate: '2026-09-21', serviceType: 'Lawn Care', customerName: 'Bo Lee' }]);
    // Still employed: no credential rotation, no push deactivation.
    expect(write.update.mock.calls[0][0]).not.toHaveProperty('auth_token_version');
    expect(PushService.deactivateStaffUser).not.toHaveBeenCalled();
  });

  test('a non-assignable row that is edited without re-entering the pool lists nothing', async () => {
    const target = makeChain({ first: { ...PLACEHOLDER, id: 'tech-9' } });
    const write = makeChain();
    const reread = makeChain({ first: { ...PLACEHOLDER, id: 'tech-9', name: 'Tech Nine' } });
    installTransaction([target, write, reread], { futureVisits: [{ id: 'ss-9' }] });
    const res = await invoke(updateTechnician, { params: { id: 'tech-9' }, body: { name: 'Tech Nine' }, technicianId: 'adam' });
    expect(res.statusCode).toBe(200);
    expect(res.body.futureAssignedVisits).toEqual([]);
  });

  test('the "Can move visits" switch writes its column only and never rotates credentials', async () => {
    const target = makeChain({ first: { ...ADAM, id: 'tech-9', role: 'technician', can_move_visits: false } });
    const write = makeChain();
    const reread = makeChain({ first: { ...ADAM, id: 'tech-9', can_move_visits: true } });
    installTransaction([target, write, reread]);
    const res = await invoke(updateTechnician, { params: { id: 'tech-9' }, body: { canMoveVisits: true }, technicianId: 'adam' });
    expect(res.statusCode).toBe(200);
    expect(write.update.mock.calls[0][0]).toMatchObject({ can_move_visits: true });
    expect(write.update.mock.calls[0][0]).not.toHaveProperty('auth_token_version');
    expect(res.body.technician).toMatchObject({ can_move_visits: true });
  });

  test('a bad employmentStatus, fieldDispatchable or canMoveVisits is rejected before any read', async () => {
    expect((await invoke(updateTechnician, { params: { id: 'x' }, body: { employmentStatus: 'quit' } })).statusCode).toBe(400);
    expect((await invoke(updateTechnician, { params: { id: 'x' }, body: { fieldDispatchable: 1 } })).statusCode).toBe(400);
    expect((await invoke(updateTechnician, { params: { id: 'x' }, body: { canMoveVisits: 'on' } })).statusCode).toBe(400);
    expect(db.transaction).not.toHaveBeenCalled();
  });
});

describe('deactivateTechnician', () => {
  test('writes inactive + the legacy flag, and lists future assigned visits WITHOUT touching them', async () => {
    const target = makeChain({ first: { ...ADAM, id: 'tech-9', role: 'technician', auth_token_version: 2 } });
    const write = makeChain();
    const reread = makeChain({ first: { ...ADAM, id: 'tech-9', employment_status: 'inactive', active: false } });
    const future = [
      { id: 'ss-5', scheduled_date: '2026-09-12', service_type: 'Pest Control', first_name: 'Pat', last_name: 'Lee' },
      { id: 'ss-6', scheduled_date: '2026-09-19', service_type: 'Lawn Care', first_name: 'Sam', last_name: null },
    ];
    const trx = installTransaction([target, write, reread], { futureVisits: future });
    const res = await invoke(deactivateTechnician, { params: { id: 'tech-9' }, query: {}, technicianId: 'adam' });
    expect(res.statusCode).toBe(200);
    expect(write.update).toHaveBeenCalledWith(expect.objectContaining({
      employment_status: 'inactive', active: false, auth_token_version: 3,
    }));
    expect(res.body.futureAssignedVisits).toEqual([
      { id: 'ss-5', scheduledDate: '2026-09-12', serviceType: 'Pest Control', customerName: 'Pat Lee' },
      { id: 'ss-6', scheduledDate: '2026-09-19', serviceType: 'Lawn Care', customerName: 'Sam' },
    ]);
    // Nothing on scheduled_services was written: the only visit-table call is the read.
    const visitCalls = trx.mock.calls.filter(([t]) => String(t).startsWith('scheduled_services'));
    expect(visitCalls).toEqual([['scheduled_services as s']]);
    expect(write.update).toHaveBeenCalledTimes(1);
  });

  test('a prospective placeholder is offboarded to inactive too; the row is kept, never deleted', async () => {
    const target = makeChain({ first: PLACEHOLDER });
    const write = makeChain();
    const reread = makeChain({ first: { ...PLACEHOLDER, employment_status: 'inactive' } });
    installTransaction([target, write, reread]);
    const res = await invoke(deactivateTechnician, { params: { id: 'tech-1' }, query: {}, technicianId: 'adam' });
    expect(res.statusCode).toBe(200);
    expect(res.body.deactivated).toBe(true);
    expect(write.update).toHaveBeenCalledWith(expect.objectContaining({ employment_status: 'inactive', active: false }));
    expect(write.del).toBeUndefined();
  });
});

// GATE_TECH_WORK_DAYS (owner 2026-10-25): the Team tab "Work days" row.
describe('workDays on create and update', () => {
  afterEach(() => { delete process.env.GATE_TECH_WORK_DAYS; });
  const gateOn = () => { process.env.GATE_TECH_WORK_DAYS = 'true'; };
  const createWith = async (workDays) => {
    const insert = makeChain({ returning: [{ ...ADAM, id: 'new', work_days: Array.isArray(workDays) && workDays.length < 7 ? [...workDays].sort() : null }] });
    installTransaction([makeChain({ first: undefined }), insert]);
    const res = await invoke(createTechnician, { body: { name: 'Casey', email: 'casey@example.com', workDays } });
    return { res, insert };
  };

  test('create, gate on: a Monday-to-Thursday week is stored sorted, 0 = Sunday, and returned as work_days', async () => {
    gateOn();
    const { res, insert } = await createWith([4, 2, 1, 3]);
    expect(res.statusCode).toBe(200);
    expect(insert.insert).toHaveBeenCalledWith(expect.objectContaining({ work_days: [1, 2, 3, 4] }));
    expect(res.body.technician.work_days).toEqual([1, 2, 3, 4]);
  });

  test('create, gate on: all seven days and null both store NULL (works every day)', async () => {
    gateOn();
    const all = await createWith([0, 1, 2, 3, 4, 5, 6]);
    expect(all.insert.insert).toHaveBeenCalledWith(expect.objectContaining({ work_days: null }));
    const none = await createWith(null);
    expect(none.insert.insert).toHaveBeenCalledWith(expect.objectContaining({ work_days: null }));
  });

  test('create, gate on: an omitted workDays leaves the column out of the insert', async () => {
    gateOn();
    const insert = makeChain({ returning: [{ ...ADAM, id: 'new' }] });
    installTransaction([makeChain({ first: undefined }), insert]);
    await invoke(createTechnician, { body: { name: 'Casey', email: 'casey@example.com' } });
    expect(insert.insert.mock.calls[0][0]).not.toHaveProperty('work_days');
  });

  test.each([
    ['an empty list', [], 'Pick at least one work day'],
    ['a repeated day', [1, 1, 2], 'workDays must be'],
    ['a day above 6', [1, 7], 'workDays must be'],
    ['a negative day', [-1, 2], 'workDays must be'],
    ['a fractional day', [1.5], 'workDays must be'],
    ['a day name', ['mon', 'tue'], 'workDays must be'],
    ['a string of days', '1,2,3', 'workDays must be'],
  ])('create and update, gate on: %s is a 400 before any transaction', async (_label, workDays, message) => {
    gateOn();
    const created = await invoke(createTechnician, { body: { name: 'Casey', email: 'casey@example.com', workDays } });
    expect(created.statusCode).toBe(400);
    expect(created.body.error).toContain(message);
    const updated = await invoke(updateTechnician, { params: { id: 'tech-1' }, body: { workDays }, technicianId: 'adam' });
    expect(updated.statusCode).toBe(400);
    expect(updated.body.error).toContain(message);
    expect(db.transaction).not.toHaveBeenCalled();
  });

  test('update, gate on: workDays writes work_days, and null clears it', async () => {
    gateOn();
    const write = makeChain();
    installTransaction([makeChain({ first: ADAM }), write, makeChain({ first: { ...ADAM, work_days: [1, 2, 3, 4] } })]);
    const res = await invoke(updateTechnician, { params: { id: 'tech-1' }, body: { workDays: [1, 2, 3, 4] }, technicianId: 'admin-1' });
    expect(res.statusCode).toBe(200);
    expect(write.update).toHaveBeenCalledWith(expect.objectContaining({ work_days: [1, 2, 3, 4] }));
    expect(res.body.technician.work_days).toEqual([1, 2, 3, 4]);

    const clear = makeChain();
    installTransaction([makeChain({ first: { ...ADAM, work_days: [1, 2, 3, 4] } }), clear, makeChain({ first: { ...ADAM, work_days: null } })]);
    await invoke(updateTechnician, { params: { id: 'tech-1' }, body: { workDays: null }, technicianId: 'admin-1' });
    expect(clear.update).toHaveBeenCalledWith(expect.objectContaining({ work_days: null }));
  });

  test('update, gate on: an edit that omits workDays leaves work_days alone', async () => {
    gateOn();
    const write = makeChain();
    installTransaction([makeChain({ first: ADAM }), write, makeChain({ first: ADAM })]);
    await invoke(updateTechnician, { params: { id: 'tech-1' }, body: { name: 'Adam B' }, technicianId: 'admin-1' });
    expect(write.update.mock.calls[0][0]).not.toHaveProperty('work_days');
  });

  test('gate off: workDays is ignored on create and update (even an invalid value), and work_days is not returned', async () => {
    const created = await createWith([1, 2, 3, 4]);
    expect(created.res.statusCode).toBe(200);
    expect(created.insert.insert.mock.calls[0][0]).not.toHaveProperty('work_days');
    expect(created.res.body.technician).not.toHaveProperty('work_days');

    const write = makeChain();
    installTransaction([makeChain({ first: ADAM }), write, makeChain({ first: { ...ADAM, work_days: [1, 2] } })]);
    const res = await invoke(updateTechnician, { params: { id: 'tech-1' }, body: { workDays: [] }, technicianId: 'admin-1' });
    expect(res.statusCode).toBe(200);
    expect(write.update.mock.calls[0][0]).not.toHaveProperty('work_days');
    expect(res.body.technician).not.toHaveProperty('work_days');
  });
});

// GATE_TECH_SHIFT_HOURS (owner 2026-11-19, page item D4): the Team tab "Shift hours" row.
describe('shiftHours on create and update', () => {
  afterEach(() => { delete process.env.GATE_TECH_SHIFT_HOURS; });
  const gateOn = () => { process.env.GATE_TECH_SHIFT_HOURS = 'true'; };

  test('create, gate on: the hours are stored as given and returned as HH:MM', async () => {
    gateOn();
    const insert = makeChain({ returning: [{ ...ADAM, id: 'new', shift_start: '07:00:00', shift_end: '17:00:00' }] });
    installTransaction([makeChain({ first: undefined }), insert]);
    const res = await invoke(createTechnician, { body: { name: 'Casey', email: 'casey@example.com', shiftHours: { start: '07:00', end: '17:00' } } });
    expect(res.statusCode).toBe(200);
    expect(insert.insert).toHaveBeenCalledWith(expect.objectContaining({ shift_start: '07:00', shift_end: '17:00' }));
    expect(res.body.technician).toMatchObject({ shift_start: '07:00', shift_end: '17:00' });
  });

  test('create, gate on: an omitted shiftHours leaves both columns out of the insert', async () => {
    gateOn();
    const insert = makeChain({ returning: [{ ...ADAM, id: 'new' }] });
    installTransaction([makeChain({ first: undefined }), insert]);
    await invoke(createTechnician, { body: { name: 'Casey', email: 'casey@example.com' } });
    expect(insert.insert.mock.calls[0][0]).not.toHaveProperty('shift_start');
    expect(insert.insert.mock.calls[0][0]).not.toHaveProperty('shift_end');
  });

  test.each([
    ['a missing end', { start: '08:00' }],
    ['an end before the start', { start: '18:00', end: '08:00' }],
    ['an end equal to the start', { start: '08:00', end: '08:00' }],
    ['times with seconds', { start: '08:00:00', end: '18:00:00' }],
    ['a 24:00 end', { start: '08:00', end: '24:00' }],
    ['a one-digit hour', { start: '8:00', end: '18:00' }],
    ['minute numbers', { start: 480, end: 1080 }],
    ['a list', ['08:00', '18:00']],
    ['a string', '08:00-18:00'],
  ])('create and update, gate on: %s is a 400 before any transaction', async (_label, shiftHours) => {
    gateOn();
    const created = await invoke(createTechnician, { body: { name: 'Casey', email: 'casey@example.com', shiftHours } });
    expect(created.statusCode).toBe(400);
    expect(created.body.error).toContain('shiftHours must be');
    const updated = await invoke(updateTechnician, { params: { id: 'tech-1' }, body: { shiftHours }, technicianId: 'adam' });
    expect(updated.statusCode).toBe(400);
    expect(updated.body.error).toContain('shiftHours must be');
    expect(db.transaction).not.toHaveBeenCalled();
  });

  test('update, gate on: shiftHours writes both columns, and null clears both', async () => {
    gateOn();
    const write = makeChain();
    installTransaction([makeChain({ first: ADAM }), write, makeChain({ first: { ...ADAM, shift_start: '08:00:00', shift_end: '18:00:00' } }), HOURS_8_TO_18()]);
    const res = await invoke(updateTechnician, { params: { id: 'tech-1' }, body: { shiftHours: { start: '08:00', end: '18:00' } }, technicianId: 'admin-1' });
    expect(res.statusCode).toBe(200);
    expect(write.update).toHaveBeenCalledWith(expect.objectContaining({ shift_start: '08:00', shift_end: '18:00' }));
    expect(res.body.technician).toMatchObject({ shift_start: '08:00', shift_end: '18:00' });
    // New hours and no coming visit: the list is there and empty.
    expect(res.body.outsideShiftVisits).toEqual([]);

    const clear = makeChain();
    installTransaction([makeChain({ first: { ...ADAM, shift_start: '08:00:00', shift_end: '18:00:00' } }), clear, makeChain({ first: { ...ADAM, shift_start: null, shift_end: null } })]);
    const cleared = await invoke(updateTechnician, { params: { id: 'tech-1' }, body: { shiftHours: null }, technicianId: 'admin-1' });
    expect(clear.update).toHaveBeenCalledWith(expect.objectContaining({ shift_start: null, shift_end: null }));
    expect(cleared.body.technician).toMatchObject({ shift_start: null, shift_end: null });
    // No set hours hold every visit: no list, and no read for one (the queue has no fourth technicians read).
    expect(cleared.body).not.toHaveProperty('outsideShiftVisits');
  });

  // The read of the set hours the list makes (loadTechShifts), after the save's own three.
  const HOURS_8_TO_18 = () => makeChain({ rows: [{ id: 'adam', shift_start: '08:00:00', shift_end: '18:00:00' }] });
  const visit = (id, over) => ({
    id, scheduled_date: '2031-03-03', service_type: 'Pest Control', first_name: 'Synthetic', last_name: id,
    window_start: '09:00:00', window_end: '10:00:00', estimated_duration_minutes: 60, ...over,
  });

  test('update, gate on: new hours list the coming visits they do not hold, and only those', async () => {
    gateOn();
    const futureVisits = [
      visit('inside'),
      visit('ends-late', { window_start: '17:30:00', window_end: '18:30:00' }),
      visit('starts-early', { scheduled_date: '2031-03-04', window_start: '07:00:00', window_end: '08:00:00' }),
      visit('long', { scheduled_date: '2031-03-05', window_start: '17:00:00', window_end: '17:30:00', estimated_duration_minutes: 90 }),
      visit('no-time', { window_start: null, window_end: null }),
    ];
    installTransaction(
      [makeChain({ first: { ...ADAM, shift_start: '07:00:00', shift_end: '19:00:00' } }), makeChain(), makeChain({ first: { ...ADAM, shift_start: '08:00:00', shift_end: '18:00:00' } }), HOURS_8_TO_18()],
      { futureVisits },
    );
    const res = await invoke(updateTechnician, { params: { id: 'adam' }, body: { shiftHours: { start: '08:00', end: '18:00' } }, technicianId: 'admin-1' });
    expect(res.statusCode).toBe(200);
    expect(res.body.outsideShiftVisits).toEqual([
      { id: 'ends-late', scheduledDate: '2031-03-03', serviceType: 'Pest Control', customerName: 'Synthetic ends-late' },
      { id: 'starts-early', scheduledDate: '2031-03-04', serviceType: 'Pest Control', customerName: 'Synthetic starts-early' },
      { id: 'long', scheduledDate: '2031-03-05', serviceType: 'Pest Control', customerName: 'Synthetic long' },
    ]);
    // The technician stays in the pool: the offboarding list is not this one.
    expect(res.body.futureAssignedVisits).toEqual([]);
  });

  test('update, gate on: a visit on a day the technician does not work is not listed (the shift is not that day\'s)', async () => {
    gateOn();
    process.env.GATE_TECH_WORK_DAYS = 'true';
    try {
      // 2031-03-03 is a Monday, 2031-03-07 a Friday. Monday to Thursday.
      const weekdays = { ...ADAM, work_days: [1, 2, 3, 4] };
      const late = { window_start: '18:30:00', window_end: '19:30:00' };
      installTransaction(
        [makeChain({ first: weekdays }), makeChain(), makeChain({ first: { ...weekdays, shift_start: '08:00:00', shift_end: '18:00:00' } }), HOURS_8_TO_18()],
        { futureVisits: [visit('monday', late), visit('friday', { ...late, scheduled_date: '2031-03-07' })] },
      );
      const res = await invoke(updateTechnician, { params: { id: 'adam' }, body: { shiftHours: { start: '08:00', end: '18:00' } }, technicianId: 'admin-1' });
      expect(res.body.outsideShiftVisits.map((v) => v.id)).toEqual(['monday']);
    } finally {
      delete process.env.GATE_TECH_WORK_DAYS;
    }
  });

  test('update, gate on: the same hours sent again list nothing and read nothing', async () => {
    gateOn();
    const same = { ...ADAM, shift_start: '08:00:00', shift_end: '18:00:00' };
    // Three technicians reads only: a fourth (the list's) would throw.
    const trx = installTransaction([makeChain({ first: same }), makeChain(), makeChain({ first: same })], { futureVisits: [visit('late', { window_start: '19:00:00', window_end: '20:00:00' })] });
    const res = await invoke(updateTechnician, { params: { id: 'adam' }, body: { shiftHours: { start: '08:00', end: '18:00' }, name: 'Adam' }, technicianId: 'admin-1' });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toHaveProperty('outsideShiftVisits');
    expect(trx.mock.calls.map(([table]) => table)).not.toContain('scheduled_services as s');
  });

  test('update, gate on: an edit that omits shiftHours leaves both columns alone', async () => {
    gateOn();
    const write = makeChain();
    installTransaction([makeChain({ first: ADAM }), write, makeChain({ first: ADAM })]);
    await invoke(updateTechnician, { params: { id: 'tech-1' }, body: { name: 'Adam B' }, technicianId: 'admin-1' });
    expect(write.update.mock.calls[0][0]).not.toHaveProperty('shift_start');
    expect(write.update.mock.calls[0][0]).not.toHaveProperty('shift_end');
  });

  test('gate off: shiftHours is ignored on create and update (even an invalid value), and the hours are not returned', async () => {
    const insert = makeChain({ returning: [{ ...ADAM, id: 'new', shift_start: '07:00:00', shift_end: '17:00:00' }] });
    installTransaction([makeChain({ first: undefined }), insert]);
    const created = await invoke(createTechnician, { body: { name: 'Casey', email: 'casey@example.com', shiftHours: { start: '07:00', end: '17:00' } } });
    expect(created.statusCode).toBe(200);
    expect(insert.insert.mock.calls[0][0]).not.toHaveProperty('shift_start');
    expect(created.body.technician).not.toHaveProperty('shift_start');
    expect(created.body.technician).not.toHaveProperty('shift_end');

    const write = makeChain();
    installTransaction([makeChain({ first: ADAM }), write, makeChain({ first: { ...ADAM, shift_start: '08:00:00', shift_end: '18:00:00' } })]);
    const res = await invoke(updateTechnician, { params: { id: 'tech-1' }, body: { shiftHours: { start: '18:00', end: '08:00' } }, technicianId: 'admin-1' });
    expect(res.statusCode).toBe(200);
    expect(write.update.mock.calls[0][0]).not.toHaveProperty('shift_start');
    expect(res.body.technician).not.toHaveProperty('shift_start');
    // Gate off: no list and no read for one, also for a row whose stored hours differ.
    expect(res.body).not.toHaveProperty('outsideShiftVisits');
  });
});
