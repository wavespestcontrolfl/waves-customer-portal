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
    await new Promise((resolve) => server?.close(resolve));
    await mockDatabase('audit_log').where({ action: 'staff.hired' }).whereIn('resource_id', created).del();
    await mockDatabase('time_entries').whereIn('technician_id', created).del();
    await mockDatabase('technician_capabilities').whereIn('technician_id', created).del().catch(() => {});
    await mockDatabase('push_subscriptions').whereIn('admin_user_id', created).del().catch(() => {});
    await mockDatabase('technicians').whereIn('id', created).del();
    await mockDatabase?.destroy();
  });

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
});
