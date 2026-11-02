// Sign in with Google (GATE_STAFF_GOOGLE_SIGNIN) over HTTP against a migrated
// PostgreSQL: the real start / callback / finish handlers, the single-use
// attempt UPDATEs, the Google-id pin and its unique indexes, and the Team tab
// link endpoint. Only Google is faked, at the googleapis boundary (the code
// exchange and the ID token check). Synthetic staff only. Skips unless
// C360_TEST_DATABASE_URL names a private QA database.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'qa-google-signin-secret';
const { createHash, randomBytes, randomUUID } = require('node:crypto');
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
jest.mock('../sockets', () => ({ disconnectStaffSockets: jest.fn() }));
jest.mock('../services/tech-photo', () => ({ resolveTechPhotoUrl: jest.fn(async (_k, fallback) => fallback) }));
jest.mock('../middleware/admin-auth', () => {
  const actual = jest.requireActual('../middleware/admin-auth');
  return {
    ...actual,
    adminAuthenticate: (req, _res, next) => {
      req.technicianId = req.headers['x-fixture-actor'];
      req.techRole = req.headers['x-fixture-role'] || 'admin';
      req.technician = { id: req.technicianId, role: req.techRole, email: req.headers['x-fixture-email'] || null };
      next();
    },
    requireTechOrAdmin: (_req, _res, next) => next(),
    requireAdmin: (req, res, next) => (req.techRole === 'admin' ? next() : res.status(403).json({ error: 'Admin only' })),
  };
});
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({ send: jest.fn() })),
  PutObjectCommand: jest.fn(), GetObjectCommand: jest.fn(), DeleteObjectCommand: jest.fn(),
}));
jest.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: jest.fn() }));
const mockGetToken = jest.fn();
const mockVerifyIdToken = jest.fn();
jest.mock('googleapis', () => ({
  google: {
    auth: {
      OAuth2: jest.fn().mockImplementation(() => ({ getToken: mockGetToken, verifyIdToken: mockVerifyIdToken })),
    },
  },
}));

const { adminAuthenticate: realAdminAuthenticate } = jest.requireActual('../middleware/admin-auth');
const authRouter = require('../routes/admin-auth');
const timetracking = require('../routes/admin-timetracking');

const connection = process.env.C360_TEST_DATABASE_URL;
const postgres = connection ? describe : describe.skip;
const DOMAIN = 'wavespestcontrol.test';
const ENV = [
  'GATE_STAFF_GOOGLE_SIGNIN', 'GOOGLE_STAFF_SIGNIN_CLIENT_ID', 'GOOGLE_STAFF_SIGNIN_CLIENT_SECRET',
  'GOOGLE_STAFF_SIGNIN_DOMAINS', 'IB_FULL_ACCESS_EMAILS', 'GATE_ADMIN_MFA',
];

const s256 = (value) => createHash('sha256').update(value).digest('base64url');
const pageSecret = () => randomBytes(32).toString('base64url');

postgres('staff Google sign-in on migrated PostgreSQL', () => {
  const savedEnv = {};
  const created = [];
  let server;
  let baseUrl;
  let ownerEmail;

  async function addStaff(overrides = {}) {
    const id = randomUUID();
    const tag = id.slice(0, 8);
    await mockDatabase('technicians').insert({
      id,
      name: `Google Fixture ${tag}`,
      email: `google-${id}@example.test`,
      role: 'technician',
      active: true,
      employment_status: 'active',
      google_email: `tech-${tag}@${DOMAIN}`,
      ...overrides,
    });
    created.push(id);
    return mockDatabase('technicians').where({ id }).first();
  }

  function googleSays(claims) {
    mockGetToken.mockResolvedValueOnce({ tokens: { id_token: 'fixture-id-token' } });
    mockVerifyIdToken.mockResolvedValueOnce({ getPayload: () => claims });
  }

  // GET /start like a browser: returns Google's URL and the state cookie.
  async function start(client = 'web', secret = pageSecret()) {
    const res = await fetch(`${baseUrl}/api/admin/auth/google/start?client=${client}&challenge=${s256(secret)}`, { redirect: 'manual' });
    const google = res.status === 302 ? new URL(res.headers.get('location')) : null;
    const cookie = (res.headers.get('set-cookie') || '').split(';')[0];
    return { res, google, cookie, secret, state: google?.searchParams.get('state'), nonce: google?.searchParams.get('nonce') };
  }

  async function callback(flow, { code = 'fixture-code', cookie = flow.cookie, state = flow.state, error } = {}) {
    const params = new URLSearchParams(error ? { state, error } : { state, code });
    const res = await fetch(`${baseUrl}/api/admin/auth/google/callback?${params}`, {
      redirect: 'manual',
      headers: cookie ? { cookie } : {},
    });
    return { res, location: res.headers.get('location') || '' };
  }

  async function finish(result, verifier, { cookie } = {}) {
    const res = await fetch(`${baseUrl}/api/admin/auth/google/finish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: JSON.stringify({ result, verifier }),
    });
    return { status: res.status, body: await res.json() };
  }

  // The cookie /login/mfa sets after a passing code, for this staff row as stored now.
  function rememberedDeviceCookie(techRow) {
    let header = null;
    authRouter._deviceTrust.rememberDevice({ cookie: (name, value) => { header = `${name}=${value}`; } }, techRow);
    return header;
  }

  const claimsFor = (tech, flow, extra = {}) => ({
    sub: `google-${tech.id}`,
    email: tech.google_email,
    email_verified: true,
    hd: DOMAIN,
    nonce: flow.nonce,
    ...extra,
  });

  async function signedResult(tech, client = 'web') {
    const flow = await start(client);
    googleSays(claimsFor(tech, flow));
    const { location } = await callback(flow);
    return { flow, result: decodeURIComponent(location.split('result=')[1] || '') };
  }

  async function linkCall(techId, body, { actor = created[0], role = 'admin', email = null } = {}) {
    const res = await fetch(`${baseUrl}/api/admin/timetracking/technicians/${techId}/google-signin`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        'x-fixture-actor': actor,
        'x-fixture-role': role,
        ...(email ? { 'x-fixture-email': email } : {}),
      },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  }

  beforeAll(async () => {
    if (!/^\/waves_qa_[a-f0-9]{32}$/.test(new URL(connection).pathname)) throw new Error('Use a verified private QA database');
    mockDatabase = knex({ client: 'pg', connection, pool: { min: 0, max: 4 } });
    if (!await mockDatabase.schema.hasTable('staff_google_signin_attempts')) throw new Error('Run development migrations first');
    for (const k of ENV) savedEnv[k] = process.env[k];
    ownerEmail = `owner-${randomUUID()}@example.test`;
    Object.assign(process.env, {
      GATE_STAFF_GOOGLE_SIGNIN: 'true',
      GOOGLE_STAFF_SIGNIN_CLIENT_ID: 'fixture.apps.googleusercontent.com',
      GOOGLE_STAFF_SIGNIN_CLIENT_SECRET: 'fixture-client-secret',
      GOOGLE_STAFF_SIGNIN_DOMAINS: DOMAIN,
      IB_FULL_ACCESS_EMAILS: ownerEmail,
    });
    delete process.env.GATE_ADMIN_MFA;
    const app = express();
    app.use(express.json());
    app.use('/api/admin/auth', authRouter);
    app.use('/api/admin/timetracking', timetracking);
    await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    // created[0]: the acting admin for Team tab calls.
    await addStaff({ role: 'admin', google_email: null });
  });

  afterAll(async () => {
    for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await new Promise((resolve) => (server ? server.close(resolve) : resolve()));
    if (mockDatabase) {
      await mockDatabase('staff_google_signin_attempts').whereIn('technician_id', created).del();
      await mockDatabase('push_subscriptions').whereIn('admin_user_id', created).del();
      await mockDatabase('technicians').whereIn('id', created).del();
      await mockDatabase.destroy();
    }
  });

  beforeEach(() => {
    mockGetToken.mockReset();
    mockVerifyIdToken.mockReset();
  });

  test('a linked company account signs in once and gets a session the real staff check accepts', async () => {
    const tech = await addStaff();
    const flow = await start();
    expect(flow.res.status).toBe(302);
    expect(flow.google.origin + flow.google.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(Object.fromEntries(flow.google.searchParams)).toEqual(expect.objectContaining({
      client_id: 'fixture.apps.googleusercontent.com',
      response_type: 'code',
      scope: 'openid email profile',
      code_challenge_method: 'S256',
      prompt: 'select_account',
      hd: DOMAIN,
    }));
    expect(flow.google.searchParams.get('redirect_uri')).toMatch(/\/api\/admin\/auth\/google\/callback$/);
    expect(flow.res.headers.get('set-cookie')).toMatch(/waves_google_signin=[A-Za-z0-9_-]{43}; Max-Age=600; Path=\/api\/admin\/auth\/google; Expires=.*; HttpOnly; SameSite=Lax/);
    expect(flow.res.headers.get('cache-control')).toMatch(/no-store/);

    const attempt = await mockDatabase('staff_google_signin_attempts')
      .where({ state_hash: createHash('sha256').update(flow.state).digest('hex') })
      .first();
    expect(attempt).toMatchObject({ client: 'web', page_challenge: s256(flow.secret), callback_at: null });
    expect(flow.google.searchParams.get('code_challenge')).toBe(s256(attempt.pkce_verifier));

    googleSays(claimsFor(tech, flow));
    const back = await callback(flow);
    expect(back.res.status).toBe(302);
    expect(back.location).toMatch(/^\/admin\/login#google_result=[A-Za-z0-9_-]{43}$/);
    expect(back.res.headers.get('set-cookie')).toMatch(/^waves_google_signin=;/);
    expect(mockGetToken).toHaveBeenCalledWith({ code: 'fixture-code', codeVerifier: attempt.pkce_verifier });
    expect(mockVerifyIdToken).toHaveBeenCalledWith({ idToken: 'fixture-id-token', audience: 'fixture.apps.googleusercontent.com' });
    expect((await mockDatabase('technicians').where({ id: tech.id }).first()).google_sub).toBe(`google-${tech.id}`);

    const result = back.location.split('result=')[1];
    const done = await finish(result, flow.secret);
    expect(done.status).toBe(200);
    expect(done.body.user).toMatchObject({ id: tech.id, role: 'technician' });
    const req = { headers: { authorization: `Bearer ${done.body.token}` }, baseUrl: '/api/admin/auth', path: '/me' };
    const res = { status: jest.fn(() => res), json: jest.fn(() => res) };
    const next = jest.fn();
    await realAdminAuthenticate(req, res, next);
    expect(res.status).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
    expect(req.technician.id).toBe(tech.id);

    // Single use: the result, and the callback for the same state.
    expect((await finish(result, flow.secret)).status).toBe(401);
    googleSays(claimsFor(tech, flow));
    expect((await callback(flow)).location).toBe('/admin/login#google_error=expired');
  });

  test('only the page that started the flow can finish it, and a wrong secret burns the result', async () => {
    const tech = await addStaff();
    const { flow, result } = await signedResult(tech);
    const wrong = await finish(result, pageSecret());
    expect(wrong).toMatchObject({ status: 401, body: { code: 'GOOGLE_SIGNIN_EXPIRED' } });
    expect((await finish(result, flow.secret)).status).toBe(401);
  });

  test('Google refusals and unknown accounts end on the sign-in page with a reason, and pin nothing', async () => {
    const tech = await addStaff();
    const cases = [
      [{ hd: 'gmail.com' }, 'not_allowed'],
      [{ hd: undefined }, 'not_allowed'],
      [{ email_verified: false }, 'not_allowed'],
      [{ email: `someone-else@${DOMAIN}` }, 'not_allowed'],
      [{ email: 'personal@gmail.com' }, 'not_allowed'],
      [{ nonce: 'a-different-nonce' }, 'failed'],
    ];
    for (const [extra, reason] of cases) {
      const flow = await start();
      googleSays(claimsFor(tech, flow, extra));
      expect((await callback(flow)).location).toBe(`/admin/login#google_error=${reason}`);
    }
    // No cookie, or another browser's cookie: the state is not this browser's.
    const flow = await start();
    const other = await start();
    expect((await callback(flow, { cookie: other.cookie })).location).toBe('/admin/login#google_error=expired');
    expect((await callback(other, { cookie: '' })).location).toBe('/admin/login#google_error=expired');
    expect(mockGetToken).toHaveBeenCalledTimes(cases.length);
    expect((await mockDatabase('technicians').where({ id: tech.id }).first()).google_sub).toBeNull();
  });

  test('Waves Admin on iPhone gets its result and refusals on its own scheme', async () => {
    const tech = await addStaff();
    const { result } = await signedResult(tech, 'ios');
    expect(result).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const canceled = await start('ios');
    expect((await callback(canceled, { error: 'access_denied' })).location).toBe('wavespay://google-signin?error=canceled');
    const replay = await callback(canceled, { error: 'access_denied' });
    expect(replay.location).toBe('wavespay://google-signin?error=expired');
  });

  test('a Google account id is pinned once: a recreated account with the same address must be relinked', async () => {
    const tech = await addStaff();
    await signedResult(tech);
    const flow = await start();
    googleSays(claimsFor(tech, flow, { sub: 'google-recreated-account' }));
    expect((await callback(flow)).location).toBe('/admin/login#google_error=relink_needed');
  });

  test('on a new device a staff member with an authenticator still enters its code after Google', async () => {
    const tech = await addStaff({ mfa_enabled_at: new Date() });
    process.env.GATE_ADMIN_MFA = 'true';
    try {
      const { flow, result } = await signedResult(tech);
      const done = await finish(result, flow.secret);
      expect(done).toEqual({ status: 200, body: { mfaRequired: true, challengeToken: expect.any(String) } });
    } finally {
      delete process.env.GATE_ADMIN_MFA;
    }
  });

  test('a device that passed the code skips it after Google, and the session passes the two-step check', async () => {
    const tech = await addStaff({ mfa_enabled_at: new Date() });
    process.env.GATE_ADMIN_MFA = 'true';
    try {
      const { flow, result } = await signedResult(tech);
      const stored = await mockDatabase('technicians').where({ id: tech.id }).first();
      const done = await finish(result, flow.secret, { cookie: rememberedDeviceCookie(stored) });
      expect(done.status).toBe(200);
      expect(done.body).not.toHaveProperty('mfaRequired');
      expect(done.body.user).toMatchObject({ id: tech.id, twoStep: { enabled: true } });
      expect(JSON.parse(Buffer.from(done.body.token.split('.')[1], 'base64url').toString())).toMatchObject({ mfa: true });
      const req = { headers: { authorization: `Bearer ${done.body.token}` }, baseUrl: '/api/admin/auth', path: '/me' };
      const res = { status: jest.fn(() => res), json: jest.fn(() => res) };
      const next = jest.fn();
      await realAdminAuthenticate(req, res, next);
      expect(res.status).not.toHaveBeenCalled();
      expect(next).toHaveBeenCalledTimes(1);
    } finally {
      delete process.env.GATE_ADMIN_MFA;
    }
  });

  test('another staff member\'s remembered device, or one from before a sign-out everywhere or a new authenticator, still needs the code', async () => {
    const tech = await addStaff({ mfa_enabled_at: new Date() });
    const other = await addStaff({ mfa_enabled_at: new Date() });
    process.env.GATE_ADMIN_MFA = 'true';
    const challenged = { status: 200, body: { mfaRequired: true, challengeToken: expect.any(String) } };
    try {
      const otherCookie = rememberedDeviceCookie(await mockDatabase('technicians').where({ id: other.id }).first());
      let signed = await signedResult(tech);
      expect(await finish(signed.result, signed.flow.secret, { cookie: otherCookie })).toEqual(challenged);

      const before = rememberedDeviceCookie(await mockDatabase('technicians').where({ id: tech.id }).first());
      await mockDatabase('technicians').where({ id: tech.id }).increment('auth_token_version', 1);
      signed = await signedResult(tech);
      expect(await finish(signed.result, signed.flow.secret, { cookie: before })).toEqual(challenged);

      const beforeNewAuthenticator = rememberedDeviceCookie(await mockDatabase('technicians').where({ id: tech.id }).first());
      await mockDatabase('technicians').where({ id: tech.id }).update({ mfa_enabled_at: new Date(Date.now() + 1000) });
      signed = await signedResult(tech);
      expect(await finish(signed.result, signed.flow.secret, { cookie: beforeNewAuthenticator })).toEqual(challenged);
    } finally {
      delete process.env.GATE_ADMIN_MFA;
    }
  });

  test('inactive staff cannot sign in with a linked account', async () => {
    const tech = await addStaff({ employment_status: 'inactive', active: false });
    const flow = await start();
    googleSays(claimsFor(tech, flow));
    expect((await callback(flow)).location).toBe('/admin/login#google_error=not_allowed');
  });

  test('a result goes stale after two minutes and dies with a Team tab relink', async () => {
    const stale = await addStaff();
    const staleRun = await signedResult(stale);
    await mockDatabase('staff_google_signin_attempts')
      .where({ technician_id: stale.id })
      .update({ callback_at: mockDatabase.raw("now() - interval '3 minutes'") });
    expect((await finish(staleRun.result, staleRun.flow.secret)).status).toBe(401);

    const relinked = await addStaff();
    const relinkRun = await signedResult(relinked);
    expect((await linkCall(relinked.id, { googleEmail: `moved-${relinked.id.slice(0, 8)}@${DOMAIN}` })).status).toBe(200);
    expect((await finish(relinkRun.result, relinkRun.flow.secret)).status).toBe(401);
  });

  test('Team tab: link and clear; clearing a pinned link signs the person out', async () => {
    const tech = await addStaff({ google_email: null });
    const address = `Linked-${tech.id.slice(0, 8)}@${DOMAIN.toUpperCase()}`;
    const linked = await linkCall(tech.id, { googleEmail: address });
    expect(linked.status).toBe(200);
    expect(linked.body.technician).toMatchObject({ google_email: address.toLowerCase(), google_linked: false });
    const first = await mockDatabase('technicians').where({ id: tech.id }).first();
    expect(first.auth_token_version).toBe(tech.auth_token_version);

    await signedResult(first);
    const pinned = await mockDatabase('technicians').where({ id: tech.id }).first();
    expect(pinned.google_sub).toBe(`google-${tech.id}`);

    const cleared = await linkCall(tech.id, { googleEmail: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.technician).toMatchObject({ google_email: null, google_linked: false });
    const after = await mockDatabase('technicians').where({ id: tech.id }).first();
    expect(after).toMatchObject({ google_email: null, google_sub: null, auth_token_version: pinned.auth_token_version + 1 });
  });

  test('Team tab refuses other domains, a second row for one address, technicians and non-owners on the owner row', async () => {
    const tech = await addStaff({ google_email: null });
    const other = await addStaff();
    expect((await linkCall(tech.id, { googleEmail: 'someone@gmail.com' })).status).toBe(400);
    expect((await linkCall(tech.id, { googleEmail: other.google_email.toUpperCase() })).status).toBe(409);
    expect((await linkCall(tech.id, { googleEmail: `x-${tech.id.slice(0, 8)}@${DOMAIN}` }, { role: 'technician' })).status).toBe(403);
    await expect(mockDatabase('technicians').where({ id: tech.id }).update({ google_email: other.google_email.toUpperCase() }))
      .rejects.toMatchObject({ code: '23505' });

    const owner = await addStaff({ role: 'admin', email: ownerEmail, google_email: null });
    const ownerLink = { googleEmail: `owner-${owner.id.slice(0, 8)}@${DOMAIN}` };
    expect((await linkCall(owner.id, ownerLink)).status).toBe(403);
    expect((await linkCall(owner.id, ownerLink, { actor: owner.id, email: ownerEmail })).status).toBe(200);
  });

  test('gate off: every Google route answers 404, the status says off and the Team tab hides the fields', async () => {
    process.env.GATE_STAFF_GOOGLE_SIGNIN = 'false';
    try {
      const tech = await addStaff();
      expect(await (await fetch(`${baseUrl}/api/admin/auth/google/status`)).json()).toEqual({ enabled: false });
      expect((await start()).res.status).toBe(404);
      expect((await fetch(`${baseUrl}/api/admin/auth/google/callback?state=x&code=y`, { redirect: 'manual' })).status).toBe(404);
      expect((await finish('x'.repeat(43), 'y'.repeat(43))).status).toBe(404);
      expect((await linkCall(tech.id, { googleEmail: null })).status).toBe(404);
    } finally {
      process.env.GATE_STAFF_GOOGLE_SIGNIN = 'true';
    }
    expect(await (await fetch(`${baseUrl}/api/admin/auth/google/status`)).json()).toEqual({ enabled: true });
  });
});
