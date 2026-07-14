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
const router = require('../routes/admin-timetracking');
const {
  createTechnician,
  deactivateTechnician,
  listTechnicians,
  updateTechnician,
} = router._handlers;

function makeChain({ rows = [], first, returning = [] } = {}) {
  const chain = {};
  for (const method of [
    'insert', 'orderBy', 'select', 'update', 'where', 'whereNot',
    'whereIn', 'whereNotNull', 'whereRaw', 'forUpdate',
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
  const trx = jest.fn((table) => {
    if (table === 'time_entries') return activeTimers;
    if (table !== 'technicians') throw new Error(`Unexpected transaction table: ${table}`);
    const chain = queue.shift();
    if (!chain) throw new Error('Unexpected technicians query');
    return chain;
  });
  trx.raw = jest.fn(async () => undefined);
  db.transaction = jest.fn(async (callback) => callback(trx));
  return { activeTimers, trx, remaining: () => queue };
}

const sensitiveFields = [
  'password_hash',
  'auth_token_version',
  'must_change_password',
  'password_changed_at',
  'password_reset_token_hash',
  'password_reset_expires_at',
  'password_reset_requested_at',
  'last_login_at',
  'photo_s3_key',
  'future_auth_secret',
];

const rawTechnician = {
  id: 'tech-1',
  name: 'Casey Tech',
  phone: '+12345678900',
  email: 'casey@example.com',
  role: 'technician',
  active: true,
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

describe('admin timetracking technician data/auth boundaries', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.mockReset();
    db.transaction = jest.fn();
  });

  test('list responses use positive allowlists for admins and technicians', async () => {
    db.mockReturnValueOnce(makeChain({ rows: [rawTechnician] }));
    const admin = await invoke(listTechnicians, {
      technician: { id: 'admin-1', role: 'admin' },
    });

    expect(admin.body.technicians[0]).toMatchObject({
      id: 'tech-1',
      email: 'casey@example.com',
      pay_rate: '42.50',
      ssn_last4: '1234',
      avatar_url: 'https://photos.example/tech-photos/tech-1/avatar.jpg',
    });
    for (const field of sensitiveFields) {
      expect(admin.body.technicians[0]).not.toHaveProperty(field);
    }

    db.mockReturnValueOnce(makeChain({ rows: [rawTechnician] }));
    const tech = await invoke(listTechnicians, {
      technician: { id: 'tech-2', role: 'technician' },
    });
    expect(tech.body.technicians[0]).toMatchObject({
      id: 'tech-1',
      name: 'Casey Tech',
      email: 'casey@example.com',
    });
    expect(tech.body.technicians[0]).not.toHaveProperty('pay_rate');
    expect(tech.body.technicians[0]).not.toHaveProperty('ssn_last4');
    for (const field of sensitiveFields) {
      expect(tech.body.technicians[0]).not.toHaveProperty(field);
    }
  });

  test('create trims/lowercases email and rejects a case-insensitive duplicate', async () => {
    const noConflict = makeChain({ first: undefined });
    const insert = makeChain({ returning: [{
      ...rawTechnician,
      email: 'casey@example.com',
    }] });
    const successful = installTransaction([noConflict, insert]);

    const created = await invoke(createTechnician, {
      body: { name: ' Casey Tech ', email: '  CASEY@Example.COM  ', payRate: '42.50' },
    });
    expect(created.statusCode).toBe(200);
    expect(noConflict.whereRaw).toHaveBeenCalledWith(
      'LOWER(BTRIM(email)) = ?',
      ['casey@example.com'],
    );
    expect(insert.insert).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Casey Tech',
      email: 'casey@example.com',
      pay_rate: '42.50',
    }));
    expect(successful.trx.raw).toHaveBeenCalledWith(
      'LOCK TABLE technicians IN SHARE ROW EXCLUSIVE MODE',
    );
    for (const field of sensitiveFields) {
      expect(created.body.technician).not.toHaveProperty(field);
    }

    const conflictLookup = makeChain({ first: { id: 'tech-existing' } });
    const conflictTx = installTransaction([conflictLookup]);
    const duplicate = await invoke(createTechnician, {
      body: { name: 'Duplicate', email: ' Casey@example.com ' },
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.body).toEqual({ error: 'Email already in use' });
    expect(conflictTx.remaining()).toHaveLength(0);
  });

  test('update canonicalizes an equivalent email without rotating credentials', async () => {
    const target = makeChain({ first: rawTechnician });
    const noConflict = makeChain({ first: undefined });
    const write = makeChain();
    const reread = makeChain({ first: rawTechnician });
    installTransaction([target, noConflict, write, reread]);

    const updated = await invoke(updateTechnician, {
      params: { id: 'tech-1' },
      body: { email: '  CASEY@Example.COM ', active: true },
      technicianId: 'admin-1',
    });

    expect(updated.statusCode).toBe(200);
    expect(noConflict.whereNot).toHaveBeenCalledWith('id', 'tech-1');
    expect(write.update).toHaveBeenCalledWith(expect.objectContaining({
      email: 'casey@example.com',
    }));
    expect(write.update.mock.calls[0][0]).not.toHaveProperty('auth_token_version');
    expect(updated.body.technician.email).toBe('casey@example.com');
    expect(PushService.deactivateStaffUser).not.toHaveBeenCalled();
    expect(disconnectStaffSockets).not.toHaveBeenCalled();
  });

  test.each([
    ['changes', 'casey@example.com', '  NEW@Example.com ', 'new@example.com'],
    ['adds', null, '  NEW@Example.com ', 'new@example.com'],
  ])('PUT rotates credentials when it %s the login email', async (
    _label,
    existingEmail,
    requestedEmail,
    storedEmail,
  ) => {
    const existing = { ...rawTechnician, email: existingEmail, auth_token_version: 8 };
    const target = makeChain({ first: existing });
    const noConflict = requestedEmail ? makeChain({ first: undefined }) : null;
    const write = makeChain();
    const reread = makeChain({ first: { ...existing, email: storedEmail, auth_token_version: 9 } });
    installTransaction([target, ...(noConflict ? [noConflict] : []), write, reread]);

    const result = await invoke(updateTechnician, {
      params: { id: 'tech-1' },
      body: { email: requestedEmail },
      technicianId: 'admin-1',
    });

    expect(result.statusCode).toBe(200);
    expect(write.update).toHaveBeenCalledWith(expect.objectContaining({
      email: storedEmail,
      auth_token_version: 9,
      password_reset_token_hash: null,
      password_reset_expires_at: null,
      password_reset_requested_at: null,
    }));
    expect(PushService.deactivateStaffUser).toHaveBeenCalledWith('tech-1', expect.any(Function));
    expect(disconnectStaffSockets).toHaveBeenCalledWith('tech-1', 'email_changed');
  });

  test('PUT preserves the active-account email invariant', async () => {
    const target = makeChain({ first: rawTechnician });
    const tx = installTransaction([target]);

    const result = await invoke(updateTechnician, {
      params: { id: 'tech-1' },
      body: { email: null },
      technicianId: 'admin-1',
    });

    expect(result.statusCode).toBe(400);
    expect(result.body.error).toMatch(/active technician requires a valid staff email/i);
    expect(tx.remaining()).toHaveLength(0);
    expect(target.update).not.toHaveBeenCalled();
    expect(PushService.deactivateStaffUser).not.toHaveBeenCalled();
    expect(disconnectStaffSockets).not.toHaveBeenCalled();
  });

  test('PUT may remove the login email only while deactivating the account', async () => {
    const target = makeChain({ first: rawTechnician });
    const write = makeChain();
    const reread = makeChain({ first: {
      ...rawTechnician,
      active: false,
      email: null,
      auth_token_version: 9,
    } });
    installTransaction([target, write, reread]);

    const result = await invoke(updateTechnician, {
      params: { id: 'tech-1' },
      body: { active: false, email: null },
      technicianId: 'admin-1',
    });

    expect(result.statusCode).toBe(200);
    expect(write.update).toHaveBeenCalledWith(expect.objectContaining({
      active: false,
      email: null,
      auth_token_version: 9,
    }));
    expect(disconnectStaffSockets).toHaveBeenCalledWith('tech-1', 'account_deactivated');
  });

  test('PUT rotates only once when email and active state change together', async () => {
    const existing = {
      ...rawTechnician,
      active: false,
      email: 'casey@example.com',
      auth_token_version: 8,
    };
    const target = makeChain({ first: existing });
    const noConflict = makeChain({ first: undefined });
    const write = makeChain();
    const reread = makeChain({ first: {
      ...existing,
      active: true,
      email: 'new@example.com',
      auth_token_version: 9,
    } });
    installTransaction([target, noConflict, write, reread]);

    const result = await invoke(updateTechnician, {
      params: { id: 'tech-1' },
      body: { active: true, email: 'new@example.com' },
      technicianId: 'admin-1',
    });

    expect(result.statusCode).toBe(200);
    expect(write.update).toHaveBeenCalledWith(expect.objectContaining({
      active: true,
      email: 'new@example.com',
      auth_token_version: 9,
      password_reset_token_hash: null,
      password_reset_expires_at: null,
      password_reset_requested_at: null,
    }));
    expect(PushService.deactivateStaffUser).toHaveBeenCalledWith('tech-1', expect.any(Function));
    expect(disconnectStaffSockets).toHaveBeenCalledWith('tech-1', 'account_status_changed');
  });

  test.each([
    ['activating', false, true],
    ['deactivating', true, false],
  ])('PUT rotates credentials when %s a technician', async (_label, wasActive, active) => {
    const existing = { ...rawTechnician, active: wasActive, auth_token_version: 8 };
    const target = makeChain({ first: existing });
    const write = makeChain();
    const reread = makeChain({ first: { ...existing, active, auth_token_version: 9 } });
    installTransaction([target, write, reread]);

    const result = await invoke(updateTechnician, {
      params: { id: 'tech-1' },
      body: { active },
      technicianId: 'admin-1',
    });

    expect(result.statusCode).toBe(200);
    expect(write.update).toHaveBeenCalledWith(expect.objectContaining({
      active,
      auth_token_version: 9,
      password_reset_token_hash: null,
      password_reset_expires_at: null,
      password_reset_requested_at: null,
    }));
    expect(PushService.deactivateStaffUser).toHaveBeenCalledWith('tech-1', expect.any(Function));
    expect(disconnectStaffSockets).toHaveBeenCalledWith(
      'tech-1',
      active ? 'account_status_changed' : 'account_deactivated',
    );
  });

  test('PUT refuses deactivation while any time-entry type is active', async () => {
    const target = makeChain({ first: rawTechnician });
    const tx = installTransaction([target], {
      activeTimer: { id: 'timer-1', entry_type: 'drive' },
    });

    const result = await invoke(updateTechnician, {
      params: { id: 'tech-1' },
      body: { active: false },
      technicianId: 'admin-1',
    });

    expect(result.statusCode).toBe(409);
    expect(result.body.code).toBe('ACTIVE_TIME_ENTRIES');
    expect(tx.activeTimers.whereIn).not.toHaveBeenCalled();
    expect(PushService.deactivateStaffUser).not.toHaveBeenCalled();
    expect(disconnectStaffSockets).not.toHaveBeenCalled();
  });

  test('update rejects an email owned by another row regardless of casing', async () => {
    const target = makeChain({ first: rawTechnician });
    const collision = makeChain({ first: { id: 'tech-2' } });
    const tx = installTransaction([target, collision]);

    const result = await invoke(updateTechnician, {
      params: { id: 'tech-1' },
      body: { email: '  OTHER@Example.com ' },
      technicianId: 'admin-1',
    });

    expect(result.statusCode).toBe(409);
    expect(result.body).toEqual({ error: 'Email already in use' });
    expect(collision.whereRaw).toHaveBeenCalledWith(
      'LOWER(BTRIM(email)) = ?',
      ['other@example.com'],
    );
    expect(tx.remaining()).toHaveLength(0);
    expect(collision.update).not.toHaveBeenCalled();
  });

  test('PUT refuses self-deactivation before writing', async () => {
    const target = makeChain({ first: {
      ...rawTechnician,
      id: 'admin-1',
      role: 'admin',
      active: true,
    } });
    const tx = installTransaction([target]);

    const result = await invoke(updateTechnician, {
      params: { id: 'admin-1' },
      body: { active: false },
      technicianId: 'admin-1',
    });

    expect(result.statusCode).toBe(409);
    expect(result.body.error).toMatch(/own staff account/i);
    expect(tx.remaining()).toHaveLength(0);
    expect(target.update).not.toHaveBeenCalled();
  });

  test('DELETE refuses deactivation of the final active admin', async () => {
    const target = makeChain({ first: {
      ...rawTechnician,
      id: 'admin-2',
      role: 'admin',
      active: true,
    } });
    const noOtherAdmin = makeChain({ first: undefined });
    installTransaction([target, noOtherAdmin]);

    const result = await invoke(deactivateTechnician, {
      params: { id: 'admin-2' },
      query: {},
      technicianId: 'admin-1',
    });

    expect(result.statusCode).toBe(409);
    expect(result.body.error).toMatch(/final active admin/i);
    expect(noOtherAdmin.where).toHaveBeenCalledWith({ role: 'admin', active: true });
    expect(noOtherAdmin.whereNot).toHaveBeenCalledWith('id', 'admin-2');
  });

  test('DELETE, including force=true, only deactivates and preserves the staff row', async () => {
    const target = makeChain({ first: rawTechnician });
    const write = makeChain();
    const inactive = { ...rawTechnician, active: false };
    const reread = makeChain({ first: inactive });
    const tx = installTransaction([target, write, reread]);

    const result = await invoke(deactivateTechnician, {
      params: { id: 'tech-1' },
      query: { force: 'true' },
      technicianId: 'admin-1',
    });

    expect(result.statusCode).toBe(200);
    expect(result.body).toMatchObject({
      success: true,
      deactivated: true,
      technician: { id: 'tech-1', active: false, pay_rate: '42.50' },
    });
    const patch = write.update.mock.calls[0][0];
    expect(patch).toEqual({
      active: false,
      auth_token_version: 9,
      password_reset_token_hash: null,
      password_reset_expires_at: null,
      password_reset_requested_at: null,
      updated_at: expect.any(Date),
    });
    expect(tx.activeTimers.where).toHaveBeenCalledWith({
      technician_id: 'tech-1',
      status: 'active',
    });
    expect(tx.activeTimers.forUpdate).toHaveBeenCalled();
    expect(PushService.deactivateStaffUser).toHaveBeenCalledWith('tech-1', tx.trx);
    expect(disconnectStaffSockets).toHaveBeenCalledWith('tech-1', 'account_deactivated');
    for (const chain of [target, write, reread]) {
      expect(chain.del).not.toHaveBeenCalled();
    }
    for (const field of sensitiveFields) {
      expect(result.body.technician).not.toHaveProperty(field);
    }
  });

  test('DELETE refuses deactivation while an admin-time entry is active', async () => {
    const target = makeChain({ first: rawTechnician });
    const tx = installTransaction([target], {
      activeTimer: { id: 'timer-2', entry_type: 'admin_time' },
    });

    const result = await invoke(deactivateTechnician, {
      params: { id: 'tech-1' },
      query: { force: 'true' },
      technicianId: 'admin-1',
    });

    expect(result.statusCode).toBe(409);
    expect(result.body).toMatchObject({ code: 'ACTIVE_TIME_ENTRIES' });
    expect(tx.activeTimers.whereIn).not.toHaveBeenCalled();
    expect(PushService.deactivateStaffUser).not.toHaveBeenCalled();
    expect(disconnectStaffSockets).not.toHaveBeenCalled();
  });
});
