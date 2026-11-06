process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../services/time-tracking', () => ({}));
jest.mock('../services/push-notifications', () => ({
  deactivateStaffUser: jest.fn(async () => 1),
}));
jest.mock('../sockets', () => ({
  disconnectStaffSockets: jest.fn(),
}));
jest.mock('../services/tech-photo', () => ({
  resolveTechPhotoUrl: jest.fn(async (key, fallback) => (
    key ? `https://photos.example/${key}` : fallback
  )),
}));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (_req, _res, next) => next(),
  requireTechOrAdmin: (_req, _res, next) => next(),
  requireAdmin: (_req, _res, next) => next(),
}));
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({ send: jest.fn() })),
  PutObjectCommand: jest.fn(),
  GetObjectCommand: jest.fn(),
  DeleteObjectCommand: jest.fn(),
}));
jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn(),
}));

const db = require('../models/db');
const PushService = require('../services/push-notifications');
const { disconnectStaffSockets } = require('../sockets');
const featureGates = require('../config/feature-gates');
const router = require('../routes/admin-timetracking');
const {
  deactivateTechnician,
  hireTechnician,
  updateTechnician,
} = router._handlers;

function makeChain({ rows = [], first, returning = [] } = {}) {
  const chain = {};
  for (const method of [
    'insert', 'orderBy', 'orderByRaw', 'select', 'update', 'where', 'whereNot',
    'whereIn', 'whereNotIn', 'whereNotNull', 'whereRaw', 'forUpdate', 'leftJoin',
  ]) {
    chain[method] = jest.fn(() => chain);
  }
  // If a regression reintroduces hard deletion, this spy makes it visible in
  // the focused test instead of silently behaving like another chain method.
  chain.del = jest.fn(() => chain);
  chain.first = jest.fn(async () => first);
  chain.returning = jest.fn(async () => returning);
  chain.then = (resolve, reject) => Promise.resolve(rows).then(resolve, reject);
  chain.catch = (reject) => Promise.resolve(rows).catch(reject);
  return chain;
}

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

async function invoke(handler, req) {
  const res = response();
  const next = jest.fn();
  await handler(req, res, next);
  if (next.mock.calls[0]?.[0]) throw next.mock.calls[0][0];
  expect(next).not.toHaveBeenCalled();
  return res;
}

function installTransaction(chains, { activeTimer } = {}) {
  const queue = [...chains];
  const activeTimers = makeChain({ first: activeTimer });
  const audit = makeChain({ returning: [{ id: 'audit-1' }] });
  const trx = jest.fn((table) => {
    if (table === 'time_entries') return activeTimers;
    if (table === 'audit_log') return audit;
    if (table === 'scheduled_services as s') return makeChain({ rows: [] });
    if (table === 'scheduled_services' || table === 'service_records' || table === 'review_incentive_payouts') return makeChain({ first: undefined });
    if (table === 'technician_capabilities') {
      // createTechnician seeds the five dispatch categories on the same trx.
      const seed = makeChain();
      seed.onConflict = jest.fn(() => seed);
      seed.ignore = jest.fn(async () => undefined);
      return seed;
    }
    if (table !== 'technicians') throw new Error(`Unexpected transaction table: ${table}`);
    const chain = queue.shift();
    if (!chain) throw new Error('Unexpected technicians query');
    return chain;
  });
  trx.raw = jest.fn(async () => undefined);
  trx.fn = { now: jest.fn(() => 'NOW') };
  db.transaction = jest.fn(async (callback) => callback(trx));
  return { activeTimers, audit, trx, remaining: () => queue };
}

const rawTechnician = {
  id: 'tech-1',
  name: 'Casey Tech',
  phone: '+12345678900',
  email: 'casey@example.com',
  role: 'technician',
  active: true,
  employment_status: 'active',
  field_dispatchable: true,
  auto_flip_enabled: true,
  pay_rate: '42.50',
  address: '100 Private Way',
  ssn_last4: '1234',
  photo_s3_key: 'tech-photos/tech-1/avatar.jpg',
  password_hash: 'bcrypt-secret',
  auth_token_version: 8,
  must_change_password: true,
  password_changed_at: '2026-07-01T00:00:00Z',
  password_reset_token_hash: 'reset-secret',
  password_reset_expires_at: '2026-07-10T14:00:00Z',
  password_reset_requested_at: '2026-07-10T13:00:00Z',
  last_login_at: '2026-07-10T12:00:00Z',
  future_auth_secret: 'new-column-must-fail-closed',
};

const OWNER_EMAIL = 'owner@example.test';
const ownerRow = {
  ...rawTechnician,
  id: 'owner-row',
  role: 'admin',
  email: OWNER_EMAIL,
  active: true,
  employment_status: 'active',
  auth_token_version: 8,
};
const otherAdminRow = { ...ownerRow, id: 'admin-3', email: 'admin3@example.test' };
const actor = { id: 'admin-2', role: 'admin', email: 'staff-admin@example.test' };

function reqFor(row, extra = {}, who = actor) {
  return {
    params: { id: row.id },
    query: {},
    technician: who,
    techRole: 'admin',
    technicianId: who.id,
    ...extra,
  };
}
const ownerActor = { id: 'owner-row', role: 'admin', email: OWNER_EMAIL };

// Queue for a status write: target lock, "another active admin" probe, write, re-read.
function statusQueue(row, nextState) {
  return [
    makeChain({ first: row }),
    makeChain({ first: { id: 'admin-2' } }),
    makeChain(),
    makeChain({ first: { ...row, ...nextState, auth_token_version: 9 } }),
  ];
}

describe('owner (full-access) staff row lifecycle is owner-only', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.mockReset();
    process.env.IB_FULL_ACCESS_EMAILS = OWNER_EMAIL;
  });
  afterAll(() => { delete process.env.IB_FULL_ACCESS_EMAILS; });

  const statusBodies = [
    ['inactive', { employmentStatus: 'inactive' }],
    ['prospective', { employmentStatus: 'prospective' }],
    ['legacy active:false', { active: false }],
  ];

  test.each(statusBodies)('a non-owner admin cannot set the owner row %s through PUT', async (_label, body) => {
    const chains = statusQueue(ownerRow, { employment_status: 'inactive', active: false });
    const write = chains[2];
    const tx = installTransaction(chains);
    const res = await invoke(updateTechnician, reqFor(ownerRow, { body }));
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toMatch(/Only the owner account/);
    expect(write.update).not.toHaveBeenCalled();
    expect(PushService.deactivateStaffUser).not.toHaveBeenCalled();
    expect(disconnectStaffSockets).not.toHaveBeenCalled();
    expect(tx.remaining()).toHaveLength(3);
  });

  test('a non-owner admin cannot delete the owner row', async () => {
    const chains = statusQueue(ownerRow, { employment_status: 'inactive', active: false });
    const write = chains[2];
    installTransaction(chains);
    const res = await invoke(deactivateTechnician, reqFor(ownerRow));
    expect(res.statusCode).toBe(403);
    expect(write.update).not.toHaveBeenCalled();
    expect(PushService.deactivateStaffUser).not.toHaveBeenCalled();
    expect(disconnectStaffSockets).not.toHaveBeenCalled();
  });

  test('a non-owner admin cannot re-activate an inactive owner row', async () => {
    const inactive = { ...ownerRow, active: false, employment_status: 'inactive' };
    const chains = [makeChain({ first: inactive }), makeChain({ first: undefined }), makeChain(), makeChain({ first: ownerRow })];
    installTransaction(chains);
    const res = await invoke(updateTechnician, reqFor(inactive, { body: { employmentStatus: 'active' } }));
    expect(res.statusCode).toBe(403);
    expect(chains[2].update).not.toHaveBeenCalled();
  });

  test('a non-owner admin can still edit other fields of the owner row (status unchanged)', async () => {
    const chains = [
      makeChain({ first: ownerRow }), makeChain(),
      makeChain({ first: { ...ownerRow, field_dispatchable: false } }),
    ];
    installTransaction(chains);
    const res = await invoke(updateTechnician, reqFor(ownerRow, { body: { fieldDispatchable: false, employmentStatus: 'active' } }));
    expect(res.statusCode).toBe(200);
    expect(chains[1].update).toHaveBeenCalled();
  });

  test('control: the existing email guard still refuses a non-owner email change', async () => {
    installTransaction([makeChain({ first: ownerRow }), makeChain({ first: undefined })]);
    const res = await invoke(updateTechnician, reqFor(ownerRow, { body: { email: 'someone-else@example.test' } }));
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toBe('Only the owner account can change this email address.');
  });

  test.each(statusBodies)('control: a non-owner admin still sets another admin row %s', async (_label, body) => {
    const chains = statusQueue(otherAdminRow, { employment_status: 'inactive', active: false });
    installTransaction(chains);
    const res = await invoke(updateTechnician, reqFor(otherAdminRow, { body }));
    expect(res.statusCode).toBe(200);
    expect(chains[2].update).toHaveBeenCalledWith(expect.objectContaining({ active: false, auth_token_version: 9 }));
    expect(PushService.deactivateStaffUser).toHaveBeenCalledWith('admin-3', expect.anything());
  });

  test('control: a non-owner admin still deletes another admin row', async () => {
    const chains = statusQueue(otherAdminRow, { employment_status: 'inactive', active: false });
    installTransaction(chains);
    const res = await invoke(deactivateTechnician, reqFor(otherAdminRow));
    expect(res.statusCode).toBe(200);
    expect(chains[2].update).toHaveBeenCalled();
  });

  test('the owner can still deactivate the owner row (other active admin exists)', async () => {
    const chains = statusQueue(ownerRow, { employment_status: 'inactive', active: false });
    installTransaction(chains);
    const res = await invoke(deactivateTechnician, reqFor(ownerRow, {}, { ...ownerActor, id: 'owner-actor' }));
    expect(res.statusCode).toBe(200);
    expect(chains[2].update).toHaveBeenCalled();
  });

  test('the owner can still set the owner row inactive through PUT', async () => {
    const chains = statusQueue(ownerRow, { employment_status: 'inactive', active: false });
    installTransaction(chains);
    const res = await invoke(updateTechnician, reqFor(ownerRow, { body: { employmentStatus: 'inactive' } }, { ...ownerActor, id: 'owner-actor' }));
    expect(res.statusCode).toBe(200);
  });

  test('a non-owner admin cannot hire a prospective owner row', async () => {
    const gateSpy = jest.spyOn(featureGates, 'hiredPacketLive').mockReturnValue(true);
    const prospective = { ...ownerRow, active: false, employment_status: 'prospective' };
    const chains = [makeChain({ first: prospective })];
    installTransaction(chains);
    const res = await invoke(hireTechnician, reqFor(prospective, {
      body: { name: prospective.name, email: OWNER_EMAIL, hireDate: '2026-11-05' },
    }));
    gateSpy.mockRestore();
    expect(res.statusCode).toBe(403);
    expect(chains[0].update).not.toHaveBeenCalled();
  });
});
