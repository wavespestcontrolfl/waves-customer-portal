// Staff page "Hired" button (the Google press) against a migrated PostgreSQL:
// the real table lock, canonical-email lookups, the credential columns and
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
const { hashResetToken, mintResetToken, HIRE_LINK_TTL_MS } = require('../services/staff-reset-token');

const connection = process.env.C360_TEST_DATABASE_URL;
const postgres = connection ? describe : describe.skip;

const GOOGLE_ENV = {
  GATE_STAFF_GOOGLE_SIGNIN: 'true',
  GOOGLE_STAFF_SIGNIN_CLIENT_ID: 'fixture-client-id',
  GOOGLE_STAFF_SIGNIN_CLIENT_SECRET: 'fixture-client-secret',
  GOOGLE_STAFF_SIGNIN_DOMAINS: 'company.test',
};

postgres('Hired button on migrated PostgreSQL', () => {
  const savedEnv = {};
  const savedGoogleEnv = {};
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
  const address = () => `hire-${randomUUID().slice(0, 12)}@company.test`;
  const listed = async (id) => (await call('/technicians', { method: 'GET' })).body.technicians.find((t) => t.id === id);
  // A prospective row with a linked company Google address the press can turn on, and that address.
  const linkedTech = async (overrides = {}) => {
    const google = address();
    return { id: await addTech({ google_email: google, ...overrides }), google };
  };
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
    for (const k of ['STAFF_PASSWORD_RESET_ORIGIN', 'NODE_ENV']) savedEnv[k] = process.env[k];
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
    for (const [k, v] of Object.entries(GOOGLE_ENV)) {
      savedGoogleEnv[k] = process.env[k];
      process.env[k] = v;
    }
    jest.clearAllMocks();
    sendgrid.isConfigured.mockReturnValue(true);
    sendgrid.sendOne.mockResolvedValue({ messageId: 'msg-1' });
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(savedGoogleEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
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

  test('Google sign-in not ready: the press answers 404 before any write or email', async () => {
    const { id, google } = await linkedTech();
    const before = await row(id);
    const auditBefore = await auditCount();
    for (const env of [{ GATE_STAFF_GOOGLE_SIGNIN: 'false' }, { GATE_STAFF_GOOGLE_SIGNIN: '1' }, { GOOGLE_STAFF_SIGNIN_CLIENT_SECRET: '' }]) {
      const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
      Object.assign(process.env, env);
      expect(await call(`/technicians/${id}/hire/google`, { body: hireBody({ googleEmail: google }) }))
        .toEqual({ status: 404, body: { enabled: false } });
      Object.assign(process.env, saved);
    }
    expect(await row(id)).toEqual(before);
    expect(await auditCount()).toBe(auditBefore);
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
  });

  test('a technician login cannot hire', async () => {
    const { id, google } = await linkedTech();
    expect((await call(`/technicians/${id}/hire/google`, { body: hireBody({ googleEmail: google }), role: 'technician' })).status).toBe(403);
    expect((await row(id)).employment_status).toBe('prospective');
  });

  test('refuses a row that is not prospective, and an unknown id', async () => {
    const active = await addTech({ employment_status: 'active', active: true, email: `act-${randomUUID()}@example.test` });
    const inactive = await addTech({ employment_status: 'inactive', active: false });
    for (const id of [active, inactive]) {
      const before = await row(id);
      const res = await call(`/technicians/${id}/hire/google`, { body: hireBody({ googleEmail: address() }) });
      expect(res).toEqual({ status: 409, body: { error: 'Only a prospective row can be hired.' } });
      expect(await row(id)).toEqual(before);
    }
    expect((await call(`/technicians/${randomUUID()}/hire/google`, { body: hireBody({ googleEmail: address() }) })).status).toBe(404);
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
  });

  test('refuses an email another staff row already holds, in any casing', async () => {
    const holder = await addTech({ employment_status: 'active', active: true, email: `Holder-${randomUUID().slice(0, 8)}@Example.test` });
    const holderEmail = (await row(holder)).email;
    const { id, google } = await linkedTech();
    const before = await row(id);
    const res = await call(`/technicians/${id}/hire/google`, { body: hireBody({ email: ` ${holderEmail.toUpperCase()} `, googleEmail: google }) });
    expect(res).toEqual({ status: 409, body: { error: 'Email already in use' } });
    expect(await row(id)).toEqual(before);
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
  });

  test('validates the body before touching the row', async () => {
    const { id, google } = await linkedTech();
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
      const res = await call(`/technicians/${id}/hire/google`, { body: hireBody({ googleEmail: google, ...patch }) });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(message);
    }
    expect(await row(id)).toEqual(before);
  });

  test('renames a placeholder with no history, and refuses a rename once it has history', async () => {
    const fresh = await linkedTech();
    expect((await call(`/technicians/${fresh.id}/hire/google`, { body: hireBody({ name: 'Renamed Person', googleEmail: fresh.google }) })).status).toBe(200);
    expect((await row(fresh.id)).name).toBe('Renamed Person');

    const withHistory = await linkedTech();
    await mockDatabase('time_entries').insert({ technician_id: withHistory.id, entry_type: 'shift', status: 'completed' });
    const before = await row(withHistory.id);
    const refused = await call(`/technicians/${withHistory.id}/hire/google`, { body: hireBody({ name: 'Someone Else', googleEmail: withHistory.google }) });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('IDENTITY_LOCKED');
    expect(await row(withHistory.id)).toEqual(before);
    // The same name (no rename) is fine even with history.
    const same = await call(`/technicians/${withHistory.id}/hire/google`, { body: hireBody({ name: before.name, googleEmail: withHistory.google }) });
    expect(same.status).toBe(200);
  });

  test('two clicks at once hire the row once', async () => {
    const { id, google } = await linkedTech();
    const [a, b] = await Promise.all([
      call(`/technicians/${id}/hire/google`, { body: hireBody({ googleEmail: google }) }),
      call(`/technicians/${id}/hire/google`, { body: hireBody({ googleEmail: google }) }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
  });

  describe('GET /technicians', () => {
    test('admins get the Hired action on a linked prospective row, with no secrets; a technician caller gets none', async () => {
      const { id } = await linkedTech();
      const plain = await addTech();
      const list = await call('/technicians', { method: 'GET' });
      expect(list.status).toBe(200);
      expect(list.body.technicians.find((t) => t.id === id)).toMatchObject({ hire_action: 'hire', hire_login: 'google' });
      expect(JSON.stringify(list.body)).not.toMatch(/password_reset_token_hash|password_hash/);
      const plainRow = list.body.technicians.find((t) => t.id === plain);
      for (const field of ['hire_action', 'hire_login', 'hire_google_only']) expect(plainRow).not.toHaveProperty(field);
      for (const t of list.body.technicians) {
        for (const field of ['hire_password_unset', 'hire_link_pending', 'hire_link_expires_at']) expect(t).not.toHaveProperty(field);
      }
      const asTech = await call('/technicians', { method: 'GET', role: 'technician' });
      expect(asTech.status).toBe(200);
      for (const t of asTech.body.technicians) {
        expect(t).not.toHaveProperty('hire_action');
        expect(t).not.toHaveProperty('hire_google_only');
      }
    });
  });

  // One mailbox belongs to one staff row. A staff email gets that row's password reset mail, and a linked Google
  // address signs in to its row, so no writer of either column takes an address another row holds in either.
  describe('one mailbox, one staff row', () => {
    const onStaff = (overrides = {}) => addTech({ employment_status: 'active', active: true, email: address(), ...overrides });
    const EMAIL_IN_USE = { status: 409, body: { error: 'Email already in use' } };

    test("no staff email writer takes another row's linked Google address", async () => {
      const google = address();
      const linked = await onStaff({ google_email: google });
      // The edit form, in any letter case.
      const other = await onStaff();
      const otherEmail = (await row(other)).email;
      expect(await call(`/technicians/${other}`, { method: 'PUT', body: { email: ` ${google.toUpperCase()} ` } })).toEqual(EMAIL_IN_USE);
      expect((await row(other)).email).toBe(otherEmail);
      // The Hired form.
      const prospective = await linkedTech();
      expect(await call(`/technicians/${prospective.id}/hire/google`, { body: hireBody({ email: google, googleEmail: prospective.google }) })).toEqual(EMAIL_IN_USE);
      expect(await row(prospective.id)).toMatchObject({ employment_status: 'prospective', active: false, email: null });
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
    // A prospective row, linked, then hired by the press its form showed.
    const googleHire = async (overrides = {}) => {
      const { id, google } = await linkedTech(overrides);
      const body = hireBody({ googleEmail: google });
      const res = await call(`/technicians/${id}/hire/google`, { body });
      expect(res.body).toMatchObject({ hired: true, login: 'google' });
      return { id, email: body.email, google };
    };

    test('the press makes an active account with no password, no link and no email', async () => {
      const { id, google } = await linkedTech({ auth_token_version: 1 });
      const plain = await addTech();
      expect(await listed(id)).toMatchObject({ hire_action: 'hire', hire_login: 'google' });
      expect(await listed(id)).not.toHaveProperty('hire_google_only');
      const plainRow = await listed(plain);
      for (const field of ['hire_action', 'hire_login', 'hire_google_only']) expect(plainRow).not.toHaveProperty(field);

      const auditBefore = await auditCount();
      const versionBefore = Number((await row(id)).auth_token_version);
      const before = Date.now();
      // The address is compared in its canonical form; the email is stored canonical too.
      const body = hireBody({ email: '  Casey.Fixture@Example.TEST ', googleEmail: ` ${google.toUpperCase()} ` });
      const res = await call(`/technicians/${id}/hire/google`, { body });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ hired: true, emailed: null, login: 'google' });
      expect(res.body.technician).toMatchObject({ id, employment_status: 'active', field_dispatchable: false, hire_google_only: 'ready' });
      for (const field of ['hire_action', 'hire_login', 'hire_password_unset', 'hire_link_pending', 'hire_link_expires_at']) {
        expect(res.body.technician).not.toHaveProperty(field);
      }
      expect(JSON.stringify(res.body)).not.toMatch(/password_reset_token_hash|password_hash/);

      const after = await row(id);
      expect(after).toMatchObject({
        name: 'Casey Fixture',
        email: 'casey.fixture@example.test',
        phone: '+19415550123',
        employment_status: 'active',
        active: true,
        field_dispatchable: false,
        job_title: 'Technician',
        employment_type: 'w2',
        // No password to change: the staff middleware refuses every route while this is true.
        must_change_password: false,
        // Entering active rotates sessions, as for every press.
        auth_token_version: versionBefore + 1,
        google_email: google,
        google_sub: null,
        ...NO_CREDENTIAL,
      });
      expect(Number(after.pay_rate)).toBe(21.5);
      expect(`${after.hire_date.getFullYear()}-${after.hire_date.getMonth() + 1}-${after.hire_date.getDate()}`).toBe('2027-1-4');
      expect(new Date(after.google_only_login_at).getTime()).toBeGreaterThanOrEqual(before - 1000);
      expect(sendgrid.sendOne).not.toHaveBeenCalled();
      expect(await auditCount()).toBe(auditBefore + 1);
      const audit = await mockDatabase('audit_log').where({ action: 'staff.hired', resource_id: id }).first();
      expect(audit).toMatchObject({ actor_id: adminId, resource_type: 'technician' });
      expect(audit.metadata).toEqual({ technician_id: id });
      expect(await listed(id)).toMatchObject({ hire_google_only: 'ready' });
      expect(await listed(id)).not.toHaveProperty('hire_action');
    });

    test.each([
      ['an old password', { password_hash: 'fixture-old-hash' }],
      ['an empty password value (not NULL, so the table CHECK would refuse the mark)', { password_hash: '' }],
      // Changing a Google link clears the pinned id, so the sign-in on record is what remains of it.
      ['a sign-in on record', { last_login_at: new Date('2026-06-01T12:00:00Z') }],
      ['a Google account id an earlier sign-in pinned', { google_sub: `fixture-sub-${randomUUID()}` }],
      ['a two-step enrollment', { mfa_enabled_at: new Date('2026-06-01T12:00:00Z') }],
    ])('a row that held a sign-in before is not offered the Google press: %s', async (_name, held) => {
      // The Google press only adds a sign-in to a row that has none. A row that was an account is turned on again
      // from the edit form, and the press changes nothing about it.
      const { id, google } = await linkedTech({ auth_token_version: 3, ...held });
      expect(await listed(id)).not.toHaveProperty('hire_action');
      expect(await call(`/technicians/${id}/hire/google`, { body: hireBody({ googleEmail: google }) })).toEqual(CHANGED);
      expect(await row(id)).toMatchObject({ employment_status: 'prospective', google_only_login_at: null, ...held });
      expect(sendgrid.sendOne).not.toHaveBeenCalled();
    });

    test('the list carries the Hired action only where the press makes a Google-only login', async () => {
      const { id, google } = await linkedTech();
      const plain = await addTech();
      const linkedRow = await listed(id);
      expect(linkedRow).toMatchObject({ hire_action: 'hire', hire_login: 'google' });
      for (const field of ['hire_password_unset', 'hire_link_pending', 'hire_link_expires_at', 'hire_google_only']) {
        expect(linkedRow).not.toHaveProperty(field);
      }
      const plainRow = await listed(plain);
      for (const field of ['hire_action', 'hire_login', 'hire_google_only']) expect(plainRow).not.toHaveProperty(field);

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
      // With staff Google sign-in off, no press exists at all.
      process.env.GATE_STAFF_GOOGLE_SIGNIN = 'false';
      const { id: later, google: laterGoogle } = await linkedTech();
      expect(await call(`/technicians/${later}/hire/google`, { body: hireBody({ googleEmail: laterGoogle }) }))
        .toEqual({ status: 404, body: { enabled: false } });
      expect(sendgrid.sendOne).not.toHaveBeenCalled();
    });

    test('the press names the Google address its form showed; a row that no longer holds it is refused', async () => {
      const { id: linked, google } = await linkedTech();
      const plain = await addTech();
      // The press names its address.
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
      expect(timetracking._test.hireStateFor(await row(id))).toEqual({});
      // An account made Google-only earlier says why it cannot sign in today.
      expect(timetracking._test.hireStateFor(await row(earlier.id))).toEqual({ hire_google_only: state });
      const refused = await call(`/technicians/${id}/hire/google`, { body: hireBody({ googleEmail: google }) });
      expect([404, 409]).toContain(refused.status);
      expect((await row(id)).employment_status).toBe('prospective');
      expect(sendgrid.sendOne).not.toHaveBeenCalled();
    });

    test('an office (admin) row is never Google-only: no press, and the table holds the rule', async () => {
      // Two-step sign-in setup asks for the account password, so a Google-only admin could never set it up.
      const { id, google } = await linkedTech({ role: 'admin' });
      expect(await listed(id)).not.toHaveProperty('hire_action');
      expect(await call(`/technicians/${id}/hire/google`, { body: hireBody({ googleEmail: google }) })).toEqual(CHANGED);
      expect(await row(id)).toMatchObject({ role: 'admin', employment_status: 'prospective', google_only_login_at: null });
      // Whatever code writes the mark (the token is cleared here so that only this rule can refuse it).
      await expect(mockDatabase('technicians').where({ id })
        .update({ password_reset_token_hash: null, google_only_login_at: new Date() }))
        .rejects.toMatchObject({ code: '23514', constraint: 'technicians_google_only_login_not_admin' });
      // A row with no role cannot sign in at all (the column allows NULL): no Google press for it either.
      const noRole = await linkedTech({ role: null });
      expect(await listed(noRole.id)).not.toHaveProperty('hire_action');
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

    test('no password link reaches a Google-only account by a reset request', async () => {
      const { id, email } = await googleHire();
      await expect(authHandlers.issuePasswordReset(email)).resolves.toEqual({ issued: false });
      // Clearing the Google sign-in does not open the reset: the row gets a password only by a new Hired press.
      await mockDatabase('technicians').where({ id }).update({ google_email: null });
      expect(await listed(id)).toMatchObject({ hire_google_only: 'unlinked' });
      expect(await listed(id)).not.toHaveProperty('hire_action');
      await expect(authHandlers.issuePasswordReset(email)).resolves.toEqual({ issued: false });
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
      // A link an admin sent (what the Team tab's Hired press once stored, so a build before this one may have left
      // one): written the way that press wrote it, a request time and exactly HIRE_LINK_TTL_MS of life.
      const storeAdminLink = async (techId) => {
        const { token, tokenHash } = mintResetToken();
        const now = new Date();
        await mockDatabase('technicians').where({ id: techId }).update({
          password_reset_token_hash: tokenHash,
          password_reset_requested_at: now,
          password_reset_expires_at: new Date(now.getTime() + HIRE_LINK_TTL_MS),
          must_change_password: true,
        });
        return token;
      };
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
      expect((await put(second, '/google-signin', { googleEmail: address() })).status).toBe(200);
      // No request issues a link for either row, and the link that was stored before the Google address was linked
      // (as a link stored by an older build would be) sets no password.
      for (const mailbox of [firstEmail, secondEmail]) {
        await expect(authHandlers.issuePasswordReset(mailbox)).resolves.toEqual({ issued: false });
      }
      expect(sendgrid.sendOne).toHaveBeenCalledTimes(1);
      expect(await redeem(token)).toEqual(REFUSED);
      expect(await row(second)).toMatchObject({ employment_status: 'active', google_only_login_at: null, password_hash: null });
      // A link an admin sent to that row sets the password.
      expect((await redeem(await storeAdminLink(second))).status).toBe(200);
      expect((await row(second)).password_hash).not.toBeNull();

      // An admin's link stays good when the Google address is linked after it, and a reset request for that
      // row sends nothing and leaves the admin's link.
      const hiredEmail = address();
      const hired = await addTech({ employment_status: 'active', active: true, email: hiredEmail });
      const adminToken = await storeAdminLink(hired);
      expect((await put(hired, '/google-signin', { googleEmail: address() })).status).toBe(200);
      await pastCooldown(hired);
      await expect(authHandlers.issuePasswordReset(hiredEmail)).resolves.toEqual({ issued: false });
      expect((await row(hired)).password_reset_token_hash).toBe(hashResetToken(adminToken));
      expect((await redeem(adminToken)).status).toBe(200);

      // A reset request that replaced an admin's link (the row had no Google address then) does not inherit its
      // standing: the stored link is the request's own.
      const replacedEmail = address();
      const replaced = await addTech({ employment_status: 'active', active: true, email: replacedEmail });
      await storeAdminLink(replaced);
      await pastCooldown(replaced);
      await expect(authHandlers.issuePasswordReset(replacedEmail)).resolves.toEqual({ issued: true });
      const requested = tokenFromLastEmail();
      expect((await put(replaced, '/google-signin', { googleEmail: address() })).status).toBe(200);
      expect(await redeem(requested.token)).toEqual(REFUSED);
      // Only an admin link's own lifetime counts as an admin's link: a stored link of any other length is refused.
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
      // What a build that does not know the mark would do (a password reset request).
      await expect(mockDatabase('technicians').where({ id }).update({ password_reset_token_hash: 'a'.repeat(64) }))
        .rejects.toMatchObject(refused);
      await expect(mockDatabase('technicians').where({ id }).update({ password_hash: 'fixture-hash' }))
        .rejects.toMatchObject(refused);
      expect(await row(id)).toMatchObject(NO_CREDENTIAL);
    });

    test('a returning Google-only row offers no press until an admin clears its Google sign-in', async () => {
      const { id, google } = await googleHire();
      // The hire signed in (Google pinned their account id), then the owner set the row back to prospective. The
      // Google press no longer applies to a row that held a sign-in, and the address is still linked and usable.
      await mockDatabase('technicians').where({ id })
        .update({ employment_status: 'prospective', active: false, google_sub: `fixture-sub-${randomUUID()}` });
      // No press applies, so the row offers none and says what to do.
      expect(await listed(id)).toMatchObject({ hire_google_only: 'returning' });
      expect(await listed(id)).not.toHaveProperty('hire_action');
      const before = await row(id);
      expect(await call(`/technicians/${id}/hire/google`, { body: hireBody({ googleEmail: google }) })).toEqual(CHANGED);
      expect(await row(id)).toEqual(before);
      expect(sendgrid.sendOne).not.toHaveBeenCalled();
      // An address that cannot sign in today says why, and the row still offers no press: outside the sign-in
      // domains (relink it), or staff Google sign-in off (the link cannot be cleared until it is on again).
      const { GOOGLE_STAFF_SIGNIN_DOMAINS: domains } = process.env;
      process.env.GOOGLE_STAFF_SIGNIN_DOMAINS = 'other.test';
      expect(timetracking._test.hireStateFor(before)).toEqual({ hire_google_only: 'bad_address' });
      Object.assign(process.env, { GOOGLE_STAFF_SIGNIN_DOMAINS: domains, GATE_STAFF_GOOGLE_SIGNIN: 'false' });
      expect(timetracking._test.hireStateFor(before)).toEqual({ hire_google_only: 'off' });
      process.env.GATE_STAFF_GOOGLE_SIGNIN = 'true';

      // The owner clears the Google sign-in on purpose: the row offers no press and shows no Google state.
      await mockDatabase('technicians').where({ id }).update({ google_email: null, google_sub: null });
      expect(timetracking._test.hireStateFor(await row(id))).toEqual({});
    });
  });
});
