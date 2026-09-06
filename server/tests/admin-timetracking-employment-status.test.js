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
    if (table === 'scheduled_services as s') return makeChain({ rows: futureVisits });
    if (table === 'technician_capabilities') return capabilityChain();
    if (table !== 'technicians') throw new Error(`Unexpected transaction table: ${table}`);
    const chain = queue.shift();
    if (!chain) throw new Error('Unexpected technicians query');
    return chain;
  });
  trx.raw = jest.fn(async () => undefined);
  trx.fn = { now: jest.fn(() => 'NOW') };
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

  test('a bad employmentStatus or fieldDispatchable is rejected before any read', async () => {
    expect((await invoke(updateTechnician, { params: { id: 'x' }, body: { employmentStatus: 'quit' } })).statusCode).toBe(400);
    expect((await invoke(updateTechnician, { params: { id: 'x' }, body: { fieldDispatchable: 1 } })).statusCode).toBe(400);
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
