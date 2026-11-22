// Staff page "Hired" button (GATE_HIRED_PACKET) against a migrated PostgreSQL:
// the real table lock, canonical-email lookups, conditional token clears and
// the audit row. SendGrid is mocked; no email leaves the machine. Synthetic
// staff only. Skips unless C360_TEST_DATABASE_URL names a private QA database.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'qa-hire-packet-secret';
const { randomUUID } = require('node:crypto');
const express = require('express');
const knex = require('knex');

let mockDatabase;
jest.mock('../models/db', () => {
  const database = (...args) => mockDatabase(...args);
  database.transaction = (...args) => mockDatabase.transaction(...args);
  database.raw = (...args) => mockDatabase.raw(...args);
  Object.defineProperty(database, 'fn', { get: () => mockDatabase.fn });
  return database;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/sendgrid-mail', () => ({
  isConfigured: jest.fn(() => true),
  sendOne: jest.fn(async () => ({ messageId: 'msg-1' })),
}));
jest.mock('../sockets', () => ({ disconnectStaffSockets: jest.fn() }));
jest.mock('../services/tech-photo', () => ({ resolveTechPhotoUrl: jest.fn(async (_k, fallback) => fallback) }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, _res, next) => {
    req.technicianId = req.headers['x-fixture-actor'];
    req.technician = { id: req.technicianId, role: req.headers['x-fixture-role'] || 'admin' };
    next();
  },
  requireTechOrAdmin: (_req, _res, next) => next(),
  requireAdmin: (req, res, next) => (
    req.technician.role === 'admin' ? next() : res.status(403).json({ error: 'Admin only' })
  ),
}));
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({ send: jest.fn() })),
  PutObjectCommand: jest.fn(), GetObjectCommand: jest.fn(), DeleteObjectCommand: jest.fn(),
}));
jest.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: jest.fn() }));

const sendgrid = require('../services/sendgrid-mail');
const timetracking = require('../routes/admin-timetracking');
const authHandlers = require('../routes/admin-auth')._handlers;
const { hashResetToken } = require('../services/staff-reset-token');

const connection = process.env.C360_TEST_DATABASE_URL;
const postgres = connection ? describe : describe.skip;
const DAY = 24 * 60 * 60 * 1000;

postgres('Hired button on migrated PostgreSQL', () => {
  const savedEnv = {};
  let server;
  let baseUrl;
  let adminId;
  const created = [];

  const call = async (path, { method = 'POST', body, role } = {}) => {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-fixture-actor': adminId, ...(role ? { 'x-fixture-role': role } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  const addTech = async (overrides = {}) => {
    const id = randomUUID();
    created.push(id);
    await mockDatabase('technicians').insert({
      id,
      name: 'Placeholder One',
      role: 'technician',
      email: null,
      employment_status: 'prospective',
      active: false,
      field_dispatchable: false,
      ...overrides,
    });
    return id;
  };
  const row = (id) => mockDatabase('technicians').where({ id }).first();
  const hireBody = (extra = {}) => ({
    name: 'Casey Fixture',
    email: `casey-${randomUUID().slice(0, 8)}@example.test`,
    phone: '+19415550123',
    hireDate: '2027-01-04',
    payRate: '21.5',
    jobTitle: 'Technician',
    employmentType: 'w2',
    ...extra,
  });
  const auditCount = async () => Number((await mockDatabase('audit_log').where({ action: 'staff.hired' }).count('* as n').first()).n);
  const tokenFromLastEmail = () => {
    const sent = sendgrid.sendOne.mock.calls.at(-1)[0];
    const match = /#token=([A-Za-z0-9_-]{43})/.exec(sent.text);
    return { sent, token: match && match[1] };
  };

  beforeAll(async () => {
    if (!/^\/waves_qa_[a-f0-9]{32}$/.test(new URL(connection).pathname)) throw new Error('Use a verified private QA database');
    mockDatabase = knex({ client: 'pg', connection, pool: { min: 0, max: 4 } });
    if (!await mockDatabase.schema.hasTable('knex_migrations')) throw new Error('Run development migrations first');
    for (const k of ['GATE_HIRED_PACKET', 'STAFF_PASSWORD_RESET_ORIGIN', 'NODE_ENV']) savedEnv[k] = process.env[k];
    process.env.STAFF_PASSWORD_RESET_ORIGIN = 'https://staff.example.test';
    adminId = randomUUID();
    created.push(adminId);
    await mockDatabase('technicians').insert({
      id: adminId, name: 'Fixture Admin', email: `fixture-admin-${adminId}@example.test`, role: 'admin', active: true,
      employment_status: 'active',
      // An established admin who set a password long ago: no hire action.
      password_hash: 'fixture-not-a-real-hash',
      password_changed_at: new Date('2026-01-01T12:00:00Z'),
    });
    const app = express();
    app.use(express.json());
    app.use('/', timetracking);
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  beforeEach(() => {
    process.env.GATE_HIRED_PACKET = 'true';
    jest.clearAllMocks();
    sendgrid.isConfigured.mockReturnValue(true);
    sendgrid.sendOne.mockResolvedValue({ messageId: 'msg-1' });
  });

  afterAll(async () => {
    for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    // close() waits for fetch's keep-alive sockets to go idle, which took this hook past its 5 seconds on a
    // busy machine: end them.
    await new Promise((resolve) => { server?.close(resolve); server?.closeAllConnections?.(); });
    await mockDatabase('audit_log').where({ action: 'staff.hired' }).whereIn('resource_id', created).del();
    await mockDatabase('time_entries').whereIn('technician_id', created).del();
    await mockDatabase('technician_capabilities').whereIn('technician_id', created).del().catch(() => {});
    await mockDatabase('push_subscriptions').whereIn('admin_user_id', created).del().catch(() => {});
    await mockDatabase('technicians').whereIn('id', created).del();
    await mockDatabase?.destroy();
  }, 30000);

  test('gate off refuses both endpoints before any write or email', async () => {
    delete process.env.GATE_HIRED_PACKET;
    const id = await addTech();
    const before = await row(id);
    const auditBefore = await auditCount();
    const hired = await call(`/technicians/${id}/hire`, { body: hireBody() });
    const resent = await call(`/technicians/${id}/hire/resend`, { body: {} });
    expect(hired).toEqual({ status: 404, body: { enabled: false } });
    expect(resent).toEqual({ status: 404, body: { enabled: false } });
    expect(await row(id)).toEqual(before);
    expect(await auditCount()).toBe(auditBefore);
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
    // 'false' and other near misses are off too (strict 'true').
    process.env.GATE_HIRED_PACKET = '1';
    expect((await call(`/technicians/${id}/hire`, { body: hireBody() })).status).toBe(404);
  });

  test('a technician login cannot hire or resend', async () => {
    const id = await addTech();
    expect((await call(`/technicians/${id}/hire`, { body: hireBody(), role: 'technician' })).status).toBe(403);
    expect((await call(`/technicians/${id}/hire/resend`, { body: {}, role: 'technician' })).status).toBe(403);
    expect((await row(id)).employment_status).toBe('prospective');
  });

  test('hires a prospective row: every field, a 7-day token, one audit row, one email', async () => {
    const id = await addTech({ auth_token_version: 1 });
    const body = hireBody({ email: '  Casey.Fixture@Example.TEST ' });
    const auditBefore = await auditCount();
    const before = Date.now();
    const res = await call(`/technicians/${id}/hire`, { body });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ hired: true, emailed: true });

    const after = await row(id);
    expect(after).toMatchObject({
      name: 'Casey Fixture',
      email: 'casey.fixture@example.test',
      phone: '+19415550123',
      employment_status: 'active',
      active: true,
      field_dispatchable: false,
      must_change_password: true,
      job_title: 'Technician',
      employment_type: 'w2',
      password_hash: null,
      password_changed_at: null,
      auth_token_version: 2,
    });
    expect(Number(after.pay_rate)).toBe(21.5);
    expect(`${after.hire_date.getFullYear()}-${after.hire_date.getMonth() + 1}-${after.hire_date.getDate()}`).toBe('2027-1-4');

    const { sent, token } = tokenFromLastEmail();
    expect(token).toBeTruthy();
    expect(after.password_reset_token_hash).toBe(hashResetToken(token));
    const ttl = new Date(after.password_reset_expires_at).getTime() - before;
    expect(ttl).toBeGreaterThan(7 * DAY - 60000);
    expect(ttl).toBeLessThan(7 * DAY + 60000);
    expect(after.password_reset_requested_at).not.toBeNull();

    expect(sendgrid.sendOne).toHaveBeenCalledTimes(1);
    expect(sent).toMatchObject({ to: 'casey.fixture@example.test', categories: ['staff_welcome'], asmGroupId: 0 });
    expect(sent.text).toContain('Monday, January 4');
    expect(sent.text).toContain(`https://staff.example.test/admin/reset-password#token=${token}`);

    // Response: the row in GET /technicians shape, never a token or a hash.
    expect(res.body.technician).toMatchObject({
      id, employment_status: 'active', field_dispatchable: false,
      hire_password_unset: true, hire_link_pending: true,
    });
    expect(JSON.stringify(res.body)).not.toContain(token);
    expect(JSON.stringify(res.body)).not.toMatch(/password_reset_token_hash|password_hash/);

    expect(await auditCount()).toBe(auditBefore + 1);
    const audit = await mockDatabase('audit_log').where({ action: 'staff.hired', resource_id: id }).first();
    expect(audit).toMatchObject({ actor_id: adminId, resource_type: 'technician' });
    expect(audit.metadata).toEqual({ technician_id: id });
  });

  test('the emailed token sets the first password through the normal reset handler', async () => {
    const id = await addTech();
    await call(`/technicians/${id}/hire`, { body: hireBody() });
    const { token } = tokenFromLastEmail();
    let status = 200;
    let payload;
    const res = { status(code) { status = code; return this; }, json(value) { payload = value; return this; }, cookie() { return this; } };
    await authHandlers.resetPassword({ body: { token, newPassword: 'Fixture-Pass-4821-xq' }, headers: {}, get: () => null }, res, (e) => { throw e; });
    expect(status).toBe(200);
    expect(payload.user).toBeDefined();
    const after = await row(id);
    expect(after.must_change_password).toBe(false);
    expect(after.password_changed_at).not.toBeNull();
    expect(after.password_reset_token_hash).toBeNull();
    // The password is set, so Resend link is refused from now on.
    const resend = await call(`/technicians/${id}/hire/resend`, { body: {} });
    expect(resend).toEqual({ status: 409, body: { error: 'This person already set a password.' } });
  });

  test('refuses a row that is not prospective, and an unknown id', async () => {
    const active = await addTech({ employment_status: 'active', active: true, email: `act-${randomUUID()}@example.test` });
    const inactive = await addTech({ employment_status: 'inactive', active: false });
    for (const id of [active, inactive]) {
      const before = await row(id);
      const res = await call(`/technicians/${id}/hire`, { body: hireBody() });
      expect(res).toEqual({ status: 409, body: { error: 'Only a prospective row can be hired.' } });
      expect(await row(id)).toEqual(before);
    }
    expect((await call(`/technicians/${randomUUID()}/hire`, { body: hireBody() })).status).toBe(404);
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
  });

  test('refuses an email another staff row already holds, in any casing', async () => {
    const holder = await addTech({ employment_status: 'active', active: true, email: `Holder-${randomUUID().slice(0, 8)}@Example.test` });
    const holderEmail = (await row(holder)).email;
    const id = await addTech();
    const before = await row(id);
    const res = await call(`/technicians/${id}/hire`, { body: hireBody({ email: ` ${holderEmail.toUpperCase()} ` }) });
    expect(res).toEqual({ status: 409, body: { error: 'Email already in use' } });
    expect(await row(id)).toEqual(before);
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
  });

  test('validates the body before touching the row', async () => {
    const id = await addTech();
    const before = await row(id);
    const bad = [
      [{ name: '' }, /Name is required/],
      [{ email: '' }, /Email is required/],
      [{ email: 'not-an-email' }, /valid address/],
      [{ hireDate: undefined }, /First day/],
      [{ hireDate: '2027-02-30' }, /First day/],
      [{ payRate: 'abc' }, /Pay rate/],
      [{ employmentType: 'contractor' }, /Employment type/],
    ];
    for (const [patch, message] of bad) {
      const res = await call(`/technicians/${id}/hire`, { body: hireBody(patch) });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(message);
    }
    expect(await row(id)).toEqual(before);
  });

  test('renames a placeholder with no history, and refuses a rename once it has history', async () => {
    const fresh = await addTech();
    expect((await call(`/technicians/${fresh}/hire`, { body: hireBody({ name: 'Renamed Person' }) })).status).toBe(200);
    expect((await row(fresh)).name).toBe('Renamed Person');

    const withHistory = await addTech();
    await mockDatabase('time_entries').insert({ technician_id: withHistory, entry_type: 'shift', status: 'completed' });
    const before = await row(withHistory);
    const refused = await call(`/technicians/${withHistory}/hire`, { body: hireBody({ name: 'Someone Else' }) });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('IDENTITY_LOCKED');
    expect(await row(withHistory)).toEqual(before);
    // The same name (no rename) is fine even with history.
    const same = await call(`/technicians/${withHistory}/hire`, { body: hireBody({ name: before.name }) });
    expect(same.status).toBe(200);
  });

  test('a definite send failure clears the token and still answers hired with emailed:false', async () => {
    const id = await addTech();
    sendgrid.sendOne.mockRejectedValueOnce(Object.assign(new Error('bad request'), { status: 400 }));
    const res = await call(`/technicians/${id}/hire`, { body: hireBody() });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ hired: true, emailed: false });
    const after = await row(id);
    expect(after.employment_status).toBe('active');
    expect(after.password_reset_token_hash).toBeNull();
    expect(after.password_reset_expires_at).toBeNull();
    expect(after.password_reset_requested_at).toBeNull();
    expect(res.body.technician).toMatchObject({ hire_password_unset: true, hire_link_pending: false });
  });

  test('SendGrid not configured counts as a definite failure', async () => {
    const id = await addTech();
    sendgrid.isConfigured.mockReturnValue(false);
    const res = await call(`/technicians/${id}/hire`, { body: hireBody() });
    expect(res.body).toMatchObject({ hired: true, emailed: false });
    expect((await row(id)).password_reset_token_hash).toBeNull();
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
  });

  test('an ambiguous send failure keeps the token and answers emailed:uncertain', async () => {
    const id = await addTech();
    sendgrid.sendOne.mockRejectedValueOnce(Object.assign(new Error('upstream'), { status: 503 }));
    const res = await call(`/technicians/${id}/hire`, { body: hireBody() });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ hired: true, emailed: 'uncertain' });
    const after = await row(id);
    expect(after.password_reset_token_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(after.employment_status).toBe('active');
    expect(res.body.technician.hire_link_pending).toBe(true);
  });

  test('a failed send never erases a newer link (hash must still match)', async () => {
    const id = await addTech();
    let resolveSend;
    sendgrid.sendOne.mockImplementationOnce(() => new Promise((_resolve, reject) => { resolveSend = () => reject(Object.assign(new Error('bad'), { status: 400 })); }));
    const pending = call(`/technicians/${id}/hire`, { body: hireBody() });
    await new Promise((resolve) => { const t = setInterval(() => { if (resolveSend) { clearInterval(t); resolve(); } }, 10); });
    // A newer link lands while the first send is still in flight.
    const newer = 'f'.repeat(64);
    await mockDatabase('technicians').where({ id }).update({ password_reset_token_hash: newer });
    resolveSend();
    const res = await pending;
    expect(res.body).toMatchObject({ hired: true, emailed: false });
    expect((await row(id)).password_reset_token_hash).toBe(newer);
  });

  test('two clicks at once hire the row once and send one email', async () => {
    const id = await addTech();
    const [a, b] = await Promise.all([
      call(`/technicians/${id}/hire`, { body: hireBody() }),
      call(`/technicians/${id}/hire`, { body: hireBody() }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(sendgrid.sendOne).toHaveBeenCalledTimes(1);
  });

  describe('resend', () => {
    test('replaces the token, restarts the 7 days and sends the same email', async () => {
      const id = await addTech();
      await call(`/technicians/${id}/hire`, { body: hireBody() });
      const first = tokenFromLastEmail().token;
      // Past the 60-second cooldown.
      await mockDatabase('technicians').where({ id }).update({ password_reset_requested_at: new Date(Date.now() - 2 * 60000) });
      jest.clearAllMocks();
      const before = Date.now();
      const res = await call(`/technicians/${id}/hire/resend`, { body: {} });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ resent: true, emailed: true });
      const second = tokenFromLastEmail().token;
      expect(second).not.toBe(first);
      const after = await row(id);
      expect(after.password_reset_token_hash).toBe(hashResetToken(second));
      expect(after.password_reset_token_hash).not.toBe(hashResetToken(first));
      const ttl = new Date(after.password_reset_expires_at).getTime() - before;
      expect(ttl).toBeGreaterThan(7 * DAY - 60000);
      expect(sendgrid.sendOne.mock.calls[0][0].text).toContain('Monday, January 4');
      expect(JSON.stringify(res.body)).not.toContain(second);
    });

    test('answers a one-minute cooldown right after a link was sent', async () => {
      const id = await addTech();
      await call(`/technicians/${id}/hire`, { body: hireBody() });
      const hash = (await row(id)).password_reset_token_hash;
      jest.clearAllMocks();
      const res = await call(`/technicians/${id}/hire/resend`, { body: {} });
      expect(res).toEqual({ status: 409, body: { error: 'A link was just sent. Try again in a minute.' } });
      expect((await row(id)).password_reset_token_hash).toBe(hash);
      expect(sendgrid.sendOne).not.toHaveBeenCalled();
    });

    test('refuses a prospective row, an inactive row and a person who already set a password', async () => {
      const prospective = await addTech();
      const inactive = await addTech({ employment_status: 'inactive', active: false, email: `gone-${randomUUID()}@example.test` });
      const setPassword = await addTech({
        employment_status: 'active', active: true, email: `set-${randomUUID()}@example.test`,
        password_hash: 'x'.repeat(60), password_changed_at: new Date(),
      });
      for (const id of [prospective, inactive]) {
        expect((await call(`/technicians/${id}/hire/resend`, { body: {} })).status).toBe(409);
      }
      expect(await call(`/technicians/${setPassword}/hire/resend`, { body: {} }))
        .toEqual({ status: 409, body: { error: 'This person already set a password.' } });
      expect((await call(`/technicians/${randomUUID()}/hire/resend`, { body: {} })).status).toBe(404);
      expect(sendgrid.sendOne).not.toHaveBeenCalled();
    });

    test('works for a hire added by hand (active, email, no password) and shares the failure rules', async () => {
      const id = await addTech({ employment_status: 'active', active: true, email: `hand-${randomUUID()}@example.test`, hire_date: '2027-03-01' });
      sendgrid.sendOne.mockRejectedValueOnce(Object.assign(new Error('bad'), { status: 422 }));
      const failed = await call(`/technicians/${id}/hire/resend`, { body: {} });
      expect(failed.body).toMatchObject({ resent: true, emailed: false });
      expect((await row(id)).password_reset_token_hash).toBeNull();
      sendgrid.sendOne.mockRejectedValueOnce(Object.assign(new Error('upstream'), { status: 502 }));
      const unsure = await call(`/technicians/${id}/hire/resend`, { body: {} });
      expect(unsure.body).toMatchObject({ resent: true, emailed: 'uncertain' });
      expect((await row(id)).password_reset_token_hash).toMatch(/^[a-f0-9]{64}$/);
    });
  });

  describe('GET /technicians', () => {
    test('gate on: admins get the flag and per-row link state, with no secrets', async () => {
      const id = await addTech();
      await call(`/technicians/${id}/hire`, { body: hireBody() });
      const list = await call('/technicians', { method: 'GET' });
      expect(list.status).toBe(200);
      const hired = list.body.technicians.find((t) => t.id === id);
      expect(hired).toMatchObject({ hire_action: 'resend', hire_password_unset: true, hire_link_pending: true });
      expect(new Date(hired.hire_link_expires_at).getTime()).toBeGreaterThan(Date.now() + 6 * DAY);
      expect(JSON.stringify(list.body)).not.toMatch(/password_reset_token_hash|password_hash/);
      const admin = list.body.technicians.find((t) => t.id === adminId);
      expect(admin).toMatchObject({ hire_action: null, hire_link_pending: false });
      const waiting = await addTech();
      const again = await call('/technicians', { method: 'GET' });
      expect(again.body.technicians.find((t) => t.id === waiting).hire_action).toBe('hire');
      // A technician caller never gets the hire fields, gate on or not.
      const asTech = await call('/technicians', { method: 'GET', role: 'technician' });
      expect(asTech.status).toBe(200);
      for (const t of asTech.body.technicians) {
        expect(t).not.toHaveProperty('hire_action');
        expect(t).not.toHaveProperty('hire_password_unset');
      }
    });

    test('gate off: the list has no new fields at all', async () => {
      const id = await addTech();
      await call(`/technicians/${id}/hire`, { body: hireBody() });
      delete process.env.GATE_HIRED_PACKET;
      const list = await call('/technicians', { method: 'GET' });
      for (const t of list.body.technicians) {
        expect(t).not.toHaveProperty('hire_action');
        expect(t).not.toHaveProperty('hire_link_pending');
        expect(t).not.toHaveProperty('hire_password_unset');
        expect(t).not.toHaveProperty('hire_link_expires_at');
      }
    });

    test('an expired link is not pending but the hire can still be resent', async () => {
      const id = await addTech();
      await call(`/technicians/${id}/hire`, { body: hireBody() });
      await mockDatabase('technicians').where({ id }).update({
        password_reset_expires_at: new Date(Date.now() - 1000),
        password_reset_requested_at: new Date(Date.now() - 8 * DAY),
      });
      const list = await call('/technicians', { method: 'GET' });
      expect(list.body.technicians.find((t) => t.id === id)).toMatchObject({
        hire_password_unset: true, hire_link_pending: false, hire_link_expires_at: null,
      });
      expect((await call(`/technicians/${id}/hire/resend`, { body: {} })).body).toMatchObject({ resent: true, emailed: true });
    });
  });

  // One mailbox belongs to one staff row. A staff email gets that row's password reset mail, and a linked Google
  // address signs in to its row, so no writer of either column takes an address another row holds in either.
  describe('one mailbox, one staff row', () => {
    const GOOGLE_ENV = {
      GATE_STAFF_GOOGLE_SIGNIN: 'true',
      GOOGLE_STAFF_SIGNIN_CLIENT_ID: 'fixture-client-id',
      GOOGLE_STAFF_SIGNIN_CLIENT_SECRET: 'fixture-client-secret',
      GOOGLE_STAFF_SIGNIN_DOMAINS: 'company.test',
    };
    const savedGoogleEnv = {};
    const address = () => `staff-${randomUUID().slice(0, 12)}@company.test`;
    const onStaff = (overrides = {}) => addTech({ employment_status: 'active', active: true, email: address(), ...overrides });
    const EMAIL_IN_USE = { status: 409, body: { error: 'Email already in use' } };

    beforeEach(() => {
      for (const [k, v] of Object.entries(GOOGLE_ENV)) {
        savedGoogleEnv[k] = process.env[k];
        process.env[k] = v;
      }
    });
    afterEach(() => {
      for (const [k, v] of Object.entries(savedGoogleEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    });

    test("no staff email writer takes another row's linked Google address", async () => {
      const google = address();
      const linked = await onStaff({ google_email: google });
      // The edit form, in any letter case.
      const other = await onStaff();
      const otherEmail = (await row(other)).email;
      expect(await call(`/technicians/${other}`, { method: 'PUT', body: { email: ` ${google.toUpperCase()} ` } })).toEqual(EMAIL_IN_USE);
      expect((await row(other)).email).toBe(otherEmail);
      // The Hired form.
      const prospective = await addTech();
      expect(await call(`/technicians/${prospective}/hire`, { body: hireBody({ email: google }) })).toEqual(EMAIL_IN_USE);
      expect(await row(prospective)).toMatchObject({ employment_status: 'prospective', active: false, email: null });
      // A new row.
      expect(await call('/technicians', { body: { name: 'Second Fixture', email: google } })).toEqual(EMAIL_IN_USE);
      expect(sendgrid.sendOne).not.toHaveBeenCalled();
      // A row's own staff email may be its own Google address.
      expect((await call(`/technicians/${linked}`, { method: 'PUT', body: { email: google } })).status).toBe(200);
      expect((await row(linked)).email).toBe(google);
    });

    test("the Google link writer does not take another row's staff email", async () => {
      const mailbox = address();
      await onStaff({ email: mailbox });
      const target = await onStaff();
      expect(await call(`/technicians/${target}/google-signin`, { method: 'PUT', body: { googleEmail: mailbox.toUpperCase() } }))
        .toEqual({ status: 409, body: { error: "That address is another staff member's email" } });
      expect((await row(target)).google_email).toBeNull();
      // A row's own staff email may be its own Google address.
      const own = (await row(target)).email;
      expect((await call(`/technicians/${target}/google-signin`, { method: 'PUT', body: { googleEmail: own } })).status).toBe(200);
      expect((await row(target)).google_email).toBe(own);
    });
  });

  // Owner 2026-11-22 "press": Hired on a row with a linked company Google address makes an account that signs in
  // with that address and nothing else. No password, no link and no email, at the press or later.
  describe('Google-only login', () => {
    const GOOGLE_ENV = {
      GATE_STAFF_GOOGLE_SIGNIN: 'true',
      GOOGLE_STAFF_SIGNIN_CLIENT_ID: 'fixture-client-id',
      GOOGLE_STAFF_SIGNIN_CLIENT_SECRET: 'fixture-client-secret',
      GOOGLE_STAFF_SIGNIN_DOMAINS: 'company.test',
    };
    const savedGoogleEnv = {};
    const address = () => `hire-${randomUUID().slice(0, 12)}@company.test`;
    const listed = async (id) => (await call('/technicians', { method: 'GET' })).body.technicians.find((t) => t.id === id);
    const NO_CREDENTIAL = {
      password_hash: null,
      password_changed_at: null,
      password_reset_token_hash: null,
      password_reset_expires_at: null,
      password_reset_requested_at: null,
    };
    const CHANGED = {
      status: 409,
      body: {
        error: 'The sign-in for this person changed. Reload the page, then press Hired again.',
        code: 'HIRE_LOGIN_CHANGED',
      },
    };
    const EMAIL_IN_USE = { status: 409, body: { error: 'Email already in use' } };
    const linkedTech = async (overrides = {}) => {
      const google = address();
      return { id: await addTech({ google_email: google, ...overrides }), google };
    };
    // A prospective row, linked, then hired by the press its form showed.
    const googleHire = async (overrides = {}) => {
      const { id, google } = await linkedTech(overrides);
      const body = hireBody({ googleEmail: google });
      const res = await call(`/technicians/${id}/hire/google`, { body });
      expect(res.body).toMatchObject({ hired: true, login: 'google' });
      return { id, email: body.email, google };
    };

    beforeEach(() => {
      for (const [k, v] of Object.entries(GOOGLE_ENV)) {
        savedGoogleEnv[k] = process.env[k];
        process.env[k] = v;
      }
    });
    afterEach(() => {
      for (const [k, v] of Object.entries(savedGoogleEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    });

    test('the press makes an active account with no password, no link and no email', async () => {
      const { id, google } = await linkedTech();
      const plain = await addTech();
      expect(await listed(id)).toMatchObject({ hire_action: 'hire', hire_login: 'google', hire_google_only: null });
      expect(await listed(plain)).toMatchObject({ hire_action: 'hire', hire_login: 'password', hire_google_only: null });

      const auditBefore = await auditCount();
      const versionBefore = Number((await row(id)).auth_token_version);
      const before = Date.now();
      // The address is compared in its canonical form.
      const body = hireBody({ googleEmail: ` ${google.toUpperCase()} ` });
      const res = await call(`/technicians/${id}/hire/google`, { body });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ hired: true, emailed: null, login: 'google' });
      expect(res.body.technician).toMatchObject({
        id, employment_status: 'active', hire_action: null, hire_login: null, hire_google_only: 'ready',
        hire_password_unset: false, hire_link_pending: false, hire_link_expires_at: null,
      });

      const after = await row(id);
      expect(after).toMatchObject({
        name: 'Casey Fixture',
        email: body.email,
        employment_status: 'active',
        active: true,
        field_dispatchable: false,
        // No password to change: the staff middleware refuses every route while this is true.
        must_change_password: false,
        // Entering active rotates sessions, as for every press.
        auth_token_version: versionBefore + 1,
        google_email: google,
        google_sub: null,
        ...NO_CREDENTIAL,
      });
      expect(new Date(after.google_only_login_at).getTime()).toBeGreaterThanOrEqual(before - 1000);
      expect(sendgrid.sendOne).not.toHaveBeenCalled();
      expect(await auditCount()).toBe(auditBefore + 1);
      expect(await listed(id)).toMatchObject({ hire_action: null, hire_google_only: 'ready', hire_password_unset: false });
    });

    test.each([
      ['an old password', { password_hash: 'fixture-old-hash' }],
      ['an empty password value (not NULL, so the table CHECK would refuse the mark)', { password_hash: '' }],
      // Changing a Google link clears the pinned id, so the sign-in on record is what remains of it.
      ['a sign-in on record', { last_login_at: new Date('2026-06-01T12:00:00Z') }],
      ['a Google account id an earlier sign-in pinned', { google_sub: `fixture-sub-${randomUUID()}` }],
      ['a two-step enrollment', { mfa_enabled_at: new Date('2026-06-01T12:00:00Z') }],
    ])('a row that held a sign-in before is not offered the Google press: %s', async (_name, held) => {
      // The Google press only adds a sign-in to a row that has none. A row that was an account keeps the press it
      // had before this variant (the emailed link) and the press changes nothing else about it.
      const { id, google } = await linkedTech({ auth_token_version: 3, ...held });
      expect(await listed(id)).toMatchObject({ hire_action: 'hire', hire_login: 'password', hire_google_only: null });
      expect(await call(`/technicians/${id}/hire/google`, { body: hireBody({ googleEmail: google }) })).toEqual(CHANGED);
      expect(await row(id)).toMatchObject({ employment_status: 'prospective', google_only_login_at: null, ...held });
      expect(sendgrid.sendOne).not.toHaveBeenCalled();
      const res = await call(`/technicians/${id}/hire`, { body: hireBody() });
      expect(res.body).toMatchObject({ hired: true, emailed: true, login: 'password' });
      expect((await row(id)).google_only_login_at).toBeNull();
    });

    test('GATE_HIRED_PACKET off: only the Google press exists, and it mails nothing', async () => {
      delete process.env.GATE_HIRED_PACKET;
      const OFF = { status: 404, body: { enabled: false } };
      const { id, google } = await linkedTech();
      const plain = await addTech();
      // The list carries the Hired action where the press makes a Google-only login, and nothing else.
      const linkedRow = await listed(id);
      expect(linkedRow).toMatchObject({ hire_action: 'hire', hire_login: 'google' });
      for (const field of ['hire_password_unset', 'hire_link_pending', 'hire_link_expires_at', 'hire_google_only']) {
        expect(linkedRow).not.toHaveProperty(field);
      }
      const plainRow = await listed(plain);
      for (const field of ['hire_action', 'hire_login', 'hire_google_only']) expect(plainRow).not.toHaveProperty(field);

      // The emailed-link press does not exist: on a plain row, on the linked row, or with a Google address in its body.
      expect(await call(`/technicians/${plain}/hire`, { body: hireBody() })).toEqual(OFF);
      expect(await call(`/technicians/${id}/hire`, { body: hireBody() })).toEqual(OFF);
      expect(await call(`/technicians/${id}/hire`, { body: { ...hireBody(), googleEmail: google } })).toEqual(OFF);
      // A Google press that names an address the row does not hold as its sign-in writes nothing.
      expect(await call(`/technicians/${plain}/hire/google`, { body: hireBody({ googleEmail: google }) })).toEqual(CHANGED);
      for (const techId of [id, plain]) expect((await row(techId)).employment_status).toBe('prospective');

      const res = await call(`/technicians/${id}/hire/google`, { body: hireBody({ googleEmail: google }) });
      expect(res.body).toMatchObject({ hired: true, emailed: null, login: 'google' });
      expect(res.body.technician).toMatchObject({ hire_google_only: 'ready' });
      expect(res.body.technician).not.toHaveProperty('hire_action');
      expect(await row(id)).toMatchObject({ employment_status: 'active', must_change_password: false, ...NO_CREDENTIAL });
      expect((await row(id)).google_only_login_at).not.toBeNull();
      expect(await listed(id)).toMatchObject({ hire_google_only: 'ready' });
      // Resend link stays behind the packet gate.
      expect(await call(`/technicians/${id}/hire/resend`, { body: {} })).toEqual(OFF);
      // With staff Google sign-in off as well, no press exists at all.
      process.env.GATE_STAFF_GOOGLE_SIGNIN = 'false';
      const { id: later, google: laterGoogle } = await linkedTech();
      expect(await call(`/technicians/${later}/hire/google`, { body: hireBody({ googleEmail: laterGoogle }) })).toEqual(OFF);
      expect(sendgrid.sendOne).not.toHaveBeenCalled();
    });

    test('the press names the Google address its form showed; a row that no longer holds it is refused', async () => {
      const { id: linked, google } = await linkedTech();
      const plain = await addTech();
      // The emailed-link press (its form, or a tab loaded before the Google press existed) on a row that now has a
      // usable link. It reads no Google address, whatever the body says.
      expect(await call(`/technicians/${linked}/hire`, { body: hireBody() })).toEqual(CHANGED);
      expect(await call(`/technicians/${linked}/hire`, { body: { ...hireBody(), googleEmail: google } })).toEqual(CHANGED);
      // The Google press names its address.
      const NO_ADDRESS = { status: 400, body: { error: 'Google address must be a valid email' } };
      expect(await call(`/technicians/${linked}/hire/google`, { body: hireBody() })).toEqual(NO_ADDRESS);
      expect(await call(`/technicians/${linked}/hire/google`, { body: hireBody({ googleEmail: '' }) })).toEqual(NO_ADDRESS);
      // A form that showed a Google address on a row whose link was cleared since.
      expect(await call(`/technicians/${plain}/hire/google`, { body: hireBody({ googleEmail: google }) })).toEqual(CHANGED);
      // The link was moved to another company address while the form was open: both are usable, and the press
      // would give the staff login to a mailbox the form never showed.
      await mockDatabase('technicians').where({ id: linked }).update({ google_email: address() });
      expect(await call(`/technicians/${linked}/hire/google`, { body: hireBody({ googleEmail: google }) })).toEqual(CHANGED);
      expect(await call(`/technicians/${linked}/hire/google`, { body: hireBody({ googleEmail: 'not-an-address' }) })).toEqual(NO_ADDRESS);

      for (const id of [linked, plain]) {
        expect(await row(id)).toMatchObject({ employment_status: 'prospective', active: false, google_only_login_at: null });
      }
      expect(sendgrid.sendOne).not.toHaveBeenCalled();
    });

    test.each([
      ['staff Google sign-in is off', { GATE_STAFF_GOOGLE_SIGNIN: 'false' }, 'off'],
      ['the Google client is not set up', { GOOGLE_STAFF_SIGNIN_CLIENT_SECRET: '' }, 'off'],
      ['the linked address is outside the sign-in domains', { GOOGLE_STAFF_SIGNIN_DOMAINS: 'other.test' }, 'bad_address'],
    ])('a linked address that cannot sign in is no Google login: %s', async (_name, env, state) => {
      const earlier = await googleHire();
      const { id, google } = await linkedTech();
      Object.assign(process.env, env);
      // (The list hides google_email with the gate off; the hire state is read from the stored row.)
      expect(timetracking._test.hireLinkState(await row(id))).toMatchObject({ hire_action: 'hire', hire_login: 'password' });
      // An account made Google-only earlier says why it cannot sign in today.
      expect(timetracking._test.hireLinkState(await row(earlier.id))).toMatchObject({ hire_action: null, hire_google_only: state });
      expect(await call(`/technicians/${id}/hire/google`, { body: hireBody({ googleEmail: google }) })).toEqual(CHANGED);
      expect((await row(id)).employment_status).toBe('prospective');
      // The emailed link, as for any row with no usable Google address.
      const res = await call(`/technicians/${id}/hire`, { body: hireBody() });
      expect(res.body).toMatchObject({ hired: true, emailed: true, login: 'password' });
      expect(await row(id)).toMatchObject({ must_change_password: true, google_only_login_at: null });
      expect(sendgrid.sendOne).toHaveBeenCalledTimes(1);
    });

    test('an office (admin) row is never Google-only: the press emails the link and the table holds the rule', async () => {
      // Two-step sign-in setup asks for the account password, so a Google-only admin could never set it up.
      const { id, google } = await linkedTech({ role: 'admin' });
      expect(await listed(id)).toMatchObject({ hire_action: 'hire', hire_login: 'password' });
      expect(await call(`/technicians/${id}/hire/google`, { body: hireBody({ googleEmail: google }) })).toEqual(CHANGED);
      const res = await call(`/technicians/${id}/hire`, { body: hireBody() });
      expect(res.body).toMatchObject({ hired: true, emailed: true, login: 'password' });
      expect(res.body.technician).toMatchObject({ hire_action: 'resend', hire_google_only: null });
      expect(await row(id)).toMatchObject({
        role: 'admin', employment_status: 'active', must_change_password: true, google_only_login_at: null,
      });
      // Whatever code writes the mark (the token is cleared here so that only this rule can refuse it).
      await expect(mockDatabase('technicians').where({ id })
        .update({ password_reset_token_hash: null, google_only_login_at: new Date() }))
        .rejects.toMatchObject({ code: '23514', constraint: 'technicians_google_only_login_not_admin' });
      // A row with no role cannot sign in at all (the column allows NULL): no Google press for it either.
      const noRole = await linkedTech({ role: null });
      expect(await listed(noRole.id)).toMatchObject({ hire_action: 'hire', hire_login: 'password' });
      expect(await call(`/technicians/${noRole.id}/hire/google`, { body: hireBody({ googleEmail: noRole.google }) })).toEqual(CHANGED);
    });

    test("a row linked before the mailbox rule is refused at the press; a row's own email may be its Google address", async () => {
      // Written directly: the link writer refuses this address today.
      const shared = address();
      await addTech({ employment_status: 'active', active: true, email: shared });
      const id = await addTech({ google_email: shared });
      expect(await call(`/technicians/${id}/hire/google`, { body: hireBody({ googleEmail: shared }) })).toEqual({
        status: 409,
        body: {
          error: "The linked Google address is another staff member's email. Change the Google sign-in first.",
          code: 'HIRE_GOOGLE_ADDRESS_IN_USE',
        },
      });
      expect(await row(id)).toMatchObject({ employment_status: 'prospective', active: false, google_only_login_at: null });

      const { id: self, google: own } = await linkedTech();
      expect((await call(`/technicians/${self}/hire/google`, { body: hireBody({ googleEmail: own, email: own }) })).body)
        .toMatchObject({ hired: true, login: 'google' });
    });

    test('no password link reaches a Google-only account: not by Resend link, not by a reset request', async () => {
      const { id, email } = await googleHire();
      expect(await call(`/technicians/${id}/hire/resend`, { body: {} }))
        .toEqual({ status: 409, body: { error: 'This person signs in with Google. No password link is sent.' } });
      await expect(authHandlers.issuePasswordReset(email)).resolves.toEqual({ issued: false });
      // Clearing the Google sign-in does not open the reset: the row gets a password only by a new Hired press.
      await mockDatabase('technicians').where({ id }).update({ google_email: null });
      expect(await listed(id)).toMatchObject({ hire_action: null, hire_google_only: 'unlinked' });
      await expect(authHandlers.issuePasswordReset(email)).resolves.toEqual({ issued: false });
      expect(await call(`/technicians/${id}/hire/resend`, { body: {} }))
        .toEqual({ status: 409, body: { error: 'This person signs in with Google. No password link is sent.' } });
      expect(sendgrid.sendOne).not.toHaveBeenCalled();
      expect(await row(id)).toMatchObject(NO_CREDENTIAL);

      // The same request for an ordinary account sends its link (the control for the two refusals above).
      const ordinary = `ordinary-${randomUUID().slice(0, 8)}@example.test`;
      await addTech({ employment_status: 'active', active: true, email: ordinary, password_hash: 'fixture-not-a-real-hash' });
      await expect(authHandlers.issuePasswordReset(ordinary)).resolves.toEqual({ issued: true });
      expect(sendgrid.sendOne).toHaveBeenCalledTimes(1);
    });

    test('a reset request never creates the first password of a row with a linked Google address', async () => {
      const put = (techId, path, body) => call(`/technicians/${techId}${path}`, { method: 'PUT', body });
      const REFUSED = { status: 400, payload: { error: 'Reset link is invalid or expired' } };
      const redeem = async (token) => {
        const out = { status: 200 };
        const res = { status(code) { out.status = code; return this; }, json(value) { out.payload = value; return this; }, cookie() { return this; } };
        await authHandlers.resetPassword({ body: { token, newPassword: 'Fixture-Pass-4821-xq' }, headers: {}, get: () => null }, res, (e) => { throw e; });
        return out;
      };
      const pastCooldown = (techId) => mockDatabase('technicians').where({ id: techId }).update({
        password_reset_requested_at: mockDatabase.raw("password_reset_requested_at - interval '10 minutes'"),
        password_reset_expires_at: mockDatabase.raw("password_reset_expires_at - interval '10 minutes'"),
      });
      // Activate and the edit form make a row active with no Google-only mark. Activate after the link:
      const first = await linkedTech();
      const firstEmail = address();
      expect((await put(first.id, '', { active: true, email: firstEmail })).status).toBe(200);
      // The link after the edit form. While the row has no Google address a reset request is main's manual path:
      const second = await addTech();
      const secondEmail = address();
      expect((await put(second, '', { employmentStatus: 'active', email: secondEmail })).status).toBe(200);
      await expect(authHandlers.issuePasswordReset(secondEmail)).resolves.toEqual({ issued: true });
      const { token } = tokenFromLastEmail();
      expect(await listed(second)).toMatchObject({ hire_action: 'resend', hire_link_pending: true });
      expect((await put(second, '/google-signin', { googleEmail: address() })).status).toBe(200);
      // The Team tab does not call that link pending: the redeem refuses it (below).
      expect(await listed(second)).toMatchObject({ hire_action: 'resend', hire_link_pending: false });
      // No request issues a link for either row, and the link that was stored before the Google address was linked
      // (as a link stored by an older build would be) sets no password.
      for (const mailbox of [firstEmail, secondEmail]) {
        await expect(authHandlers.issuePasswordReset(mailbox)).resolves.toEqual({ issued: false });
      }
      expect(sendgrid.sendOne).toHaveBeenCalledTimes(1);
      expect(await redeem(token)).toEqual(REFUSED);
      expect(await row(second)).toMatchObject({ employment_status: 'active', google_only_login_at: null, password_hash: null });
      // Resend link on that row is an admin's own act: its link sets the password.
      await pastCooldown(second);
      expect((await call(`/technicians/${second}/hire/resend`, { body: {} })).status).toBe(200);
      expect((await redeem(tokenFromLastEmail().token)).status).toBe(200);
      expect((await row(second)).password_hash).not.toBeNull();

      // An admin's Hired link stays good when the Google address is linked after it, and a reset request for that
      // row sends nothing and leaves the admin's link.
      const hired = await addTech();
      const hiredBody = hireBody();
      await call(`/technicians/${hired}/hire`, { body: hiredBody });
      const sent = tokenFromLastEmail();
      expect((await put(hired, '/google-signin', { googleEmail: address() })).status).toBe(200);
      expect(await listed(hired)).toMatchObject({ hire_action: 'resend', hire_link_pending: true });
      await pastCooldown(hired);
      await expect(authHandlers.issuePasswordReset(hiredBody.email)).resolves.toEqual({ issued: false });
      expect((await row(hired)).password_reset_token_hash).toBe(hashResetToken(sent.token));
      expect((await redeem(sent.token)).status).toBe(200);

      // A reset request that replaced an admin's link (the row had no Google address then) does not inherit its
      // standing: the stored link is the request's own.
      const replaced = await addTech();
      const replacedBody = hireBody();
      await call(`/technicians/${replaced}/hire`, { body: replacedBody });
      await pastCooldown(replaced);
      await expect(authHandlers.issuePasswordReset(replacedBody.email)).resolves.toEqual({ issued: true });
      const requested = tokenFromLastEmail();
      expect((await put(replaced, '/google-signin', { googleEmail: address() })).status).toBe(200);
      expect(await redeem(requested.token)).toEqual(REFUSED);
      // Only the Hired link's own lifetime counts as an admin's link: a stored link of any other length is refused.
      await mockDatabase('technicians').where({ id: replaced })
        .update({ password_reset_expires_at: mockDatabase.raw("password_reset_requested_at + interval '2 hours'") });
      expect(await redeem(requested.token)).toEqual(REFUSED);
      expect((await row(replaced)).password_hash).toBeNull();

      // A row that has a password keeps the ordinary reset with a Google address linked.
      const settled = address();
      const withPassword = await addTech({ employment_status: 'active', active: true, email: settled, password_hash: 'fixture-not-a-real-hash' });
      expect((await put(withPassword, '/google-signin', { googleEmail: address() })).status).toBe(200);
      await expect(authHandlers.issuePasswordReset(settled)).resolves.toEqual({ issued: true });
      expect((await redeem(tokenFromLastEmail().token)).status).toBe(200);

      // An empty password value is no password, as the Team tab reads it: the same rule at both ends.
      const blank = address();
      const blankRow = await addTech({ employment_status: 'active', active: true, email: blank, password_hash: '' });
      await expect(authHandlers.issuePasswordReset(blank)).resolves.toEqual({ issued: true });
      const early = tokenFromLastEmail();
      expect((await put(blankRow, '/google-signin', { googleEmail: address() })).status).toBe(200);
      await pastCooldown(blankRow);
      await expect(authHandlers.issuePasswordReset(blank)).resolves.toEqual({ issued: false });
      expect(await redeem(early.token)).toEqual(REFUSED);
      expect((await row(blankRow)).password_hash).toBe('');
    }, 30000); // real password hashes: slow on a loaded machine

    test('the table refuses a token or a password on a Google-only row, whatever code writes it', async () => {
      const { id } = await googleHire();
      const refused = { code: '23514', constraint: 'technicians_google_only_login_no_password' };
      // What a build that does not know the mark would do (a password reset request, a resend).
      await expect(mockDatabase('technicians').where({ id }).update({ password_reset_token_hash: 'a'.repeat(64) }))
        .rejects.toMatchObject(refused);
      await expect(mockDatabase('technicians').where({ id }).update({ password_hash: 'fixture-hash' }))
        .rejects.toMatchObject(refused);
      expect(await row(id)).toMatchObject(NO_CREDENTIAL);
    });

    test('a Google-only row gets the emailed link only after an admin clears its Google sign-in', async () => {
      const { id, google } = await googleHire();
      // The hire signed in (Google pinned their account id), then the owner set the row back to prospective. The
      // Google press no longer applies to a row that held a sign-in, and the address is still linked and usable.
      await mockDatabase('technicians').where({ id })
        .update({ employment_status: 'prospective', active: false, google_sub: `fixture-sub-${randomUUID()}` });
      // No press applies, so the row offers none and says what to do.
      expect(await listed(id)).toMatchObject({ hire_action: null, hire_login: null, hire_google_only: 'returning' });
      const before = await row(id);
      expect(await call(`/technicians/${id}/hire`, { body: hireBody() })).toEqual({
        status: 409,
        body: {
          error: 'This person signs in with Google. Clear the Google sign-in on the row first, or turn the account on again from the edit form.',
          code: 'HIRE_GOOGLE_ONLY_ROW',
        },
      });
      expect(await call(`/technicians/${id}/hire/google`, { body: hireBody({ googleEmail: google }) })).toEqual(CHANGED);
      expect(await row(id)).toEqual(before);
      expect(sendgrid.sendOne).not.toHaveBeenCalled();
      // An address that cannot sign in today says why, and the row still offers no press: outside the sign-in
      // domains (relink it), or staff Google sign-in off (the link cannot be cleared until it is on again).
      const { GOOGLE_STAFF_SIGNIN_DOMAINS: domains } = process.env;
      process.env.GOOGLE_STAFF_SIGNIN_DOMAINS = 'other.test';
      expect(timetracking._test.hireLinkState(before)).toMatchObject({ hire_action: null, hire_google_only: 'bad_address' });
      Object.assign(process.env, { GOOGLE_STAFF_SIGNIN_DOMAINS: domains, GATE_STAFF_GOOGLE_SIGNIN: 'false' });
      expect(timetracking._test.hireLinkState(before)).toMatchObject({ hire_action: null, hire_google_only: 'off' });
      process.env.GATE_STAFF_GOOGLE_SIGNIN = 'true';

      // The owner clears the Google sign-in on purpose, then presses Hired: an ordinary account.
      await mockDatabase('technicians').where({ id }).update({ google_email: null, google_sub: null });
      const res = await call(`/technicians/${id}/hire`, { body: hireBody() });
      expect(res.body).toMatchObject({ hired: true, emailed: true, login: 'password' });
      const after = await row(id);
      expect(after.google_only_login_at).toBeNull();
      expect(after.must_change_password).toBe(true);
      expect(after.password_reset_token_hash).toBe(hashResetToken(tokenFromLastEmail().token));
      expect(await listed(id)).toMatchObject({ hire_action: 'resend', hire_google_only: null, hire_password_unset: true, hire_link_pending: true });
    });
  });
});
