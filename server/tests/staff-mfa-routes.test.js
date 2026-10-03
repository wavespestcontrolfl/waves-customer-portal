// Staff two-step sign-in (GATE_ADMIN_MFA) through the real login handlers
// and the real adminAuthenticate / verifyStaffBearer: gate off is today's
// login, gate on issues no session until the code passes, and a session that
// never passed the code is refused everywhere the gate is on.
jest.mock('../models/db', () => jest.fn());
jest.mock('bcryptjs', () => ({ compare: jest.fn(), hash: jest.fn() }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/push-notifications', () => ({ deactivateStaffUser: jest.fn() }));
jest.mock('../sockets', () => ({ disconnectStaffSockets: jest.fn() }));
jest.mock('../services/staff-password-reset-email', () => ({
  RESET_LINK_TTL_MINUTES: 30,
  sendStaffPasswordResetEmail: jest.fn(),
}));
jest.mock('../config', () => ({ jwt: { secret: 'test-secret' } }));
jest.mock('../services/staff-mfa', () => {
  const actual = jest.requireActual('../services/staff-mfa');
  return {
    ...actual,
    verifySecondFactor: jest.fn(),
    confirmSetup: jest.fn(),
    startSetup: jest.fn(),
    disable: jest.fn(),
    regenerateRecoveryCodes: jest.fn(),
  };
});

const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const db = require('../models/db');
const staffMfa = require('../services/staff-mfa');
const { adminAuthenticate, verifyStaffBearer } = require('../middleware/admin-auth');
const {
  changePassword, login, loginMfa, mfaConfirm, mfaDisable, mfaRegenerateRecoveryCodes, mfaSetup, resetPassword,
} = require('../routes/admin-auth')._handlers;

const SECRET = 'test-secret';
const ENV = ['GATE_ADMIN_MFA', 'GATE_ADMIN_MFA_ENFORCE', 'GATE_STAFF_DEFAULT_DENY'];
const savedEnv = {};

function staffRow(overrides = {}) {
  return {
    id: 'tech-1',
    name: 'Owner',
    email: 'owner@example.test',
    role: 'admin',
    active: true,
    employment_status: 'active',
    auth_token_version: 3,
    password_hash: '$2a$12$hash',
    must_change_password: false,
    mfa_enabled_at: null,
    ...overrides,
  };
}

function builder({ first, select, returning } = {}) {
  const qb = {
    where: jest.fn(() => qb),
    whereIn: jest.fn(() => qb),
    whereRaw: jest.fn(() => qb),
    whereNull: jest.fn(() => qb),
    orWhere: jest.fn(() => qb),
    select: jest.fn(async () => select || []),
    update: jest.fn(() => qb),
    returning: jest.fn(async () => returning || []),
    first: jest.fn(async () => first),
    then: (resolve, reject) => Promise.resolve(1).then(resolve, reject),
  };
  return qb;
}

function response() {
  return {
    statusCode: 200,
    body: null,
    cookie: jest.fn(),
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

async function invoke(handler, req) {
  const res = response();
  const next = jest.fn((error) => { throw error; });
  await handler(req, res, next);
  return res;
}

beforeEach(() => {
  jest.clearAllMocks();
  db.mockReset();
  db.fn = { now: () => 'now()' };
  for (const k of ENV) { savedEnv[k] = process.env[k]; delete process.env[k]; }
});
afterEach(() => {
  for (const k of ENV) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
});

describe('POST /login', () => {
  test('gate off: an enrolled account signs in with the password alone, payload unchanged', async () => {
    db.mockReturnValueOnce(builder({ select: [staffRow({ mfa_enabled_at: new Date() })] }));
    db.mockReturnValueOnce(builder());
    bcrypt.compare.mockResolvedValue(true);

    const res = await invoke(login, { body: { email: 'owner@example.test', password: 'correct horse battery' } });

    expect(res.statusCode).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['refreshToken', 'token', 'user']);
    expect(res.body.user).toEqual({ id: 'tech-1', name: 'Owner', email: 'owner@example.test', role: 'admin', mustChangePassword: false });
    expect(jwt.verify(res.body.token, SECRET).mfa).toBeUndefined();
  });

  test('gate on, enrolled: the password returns only a short-lived challenge — no session, no cookie', async () => {
    process.env.GATE_ADMIN_MFA = 'true';
    db.mockReturnValueOnce(builder({ select: [staffRow({ mfa_enabled_at: new Date() })] }));
    bcrypt.compare.mockResolvedValue(true);

    const res = await invoke(login, { body: { email: 'owner@example.test', password: 'correct horse battery' } });

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ mfaRequired: true, challengeToken: expect.any(String) });
    const claims = jwt.verify(res.body.challengeToken, SECRET);
    expect(claims).toMatchObject({ technicianId: 'tech-1', type: 'staff_mfa_challenge', tokenVersion: 3 });
    expect(claims.exp - claims.iat).toBe(300);
    expect(res.cookie).not.toHaveBeenCalled();
    expect(db).toHaveBeenCalledTimes(1); // no last_login_at write
  });

  test('gate on, not enrolled: signs in as before and tells the client whether enrollment is required', async () => {
    process.env.GATE_ADMIN_MFA = 'true';
    process.env.GATE_ADMIN_MFA_ENFORCE = 'true';
    db.mockReturnValueOnce(builder({ select: [staffRow()] }));
    db.mockReturnValueOnce(builder());
    bcrypt.compare.mockResolvedValue(true);

    const res = await invoke(login, { body: { email: 'owner@example.test', password: 'correct horse battery' } });

    expect(res.body.token).toEqual(expect.any(String));
    expect(res.body.user.twoStep).toEqual({ enabled: false, enrollmentRequired: true });
  });

  test('a wrong password never reveals whether the account is enrolled', async () => {
    process.env.GATE_ADMIN_MFA = 'true';
    db.mockReturnValueOnce(builder({ select: [staffRow({ mfa_enabled_at: new Date() })] }));
    bcrypt.compare.mockResolvedValue(false);
    const res = await invoke(login, { body: { email: 'owner@example.test', password: 'wrong password here' } });
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: 'Invalid credentials' });
  });
});

describe('POST /login/mfa', () => {
  const challenge = (overrides = {}) => jwt.sign({ technicianId: 'tech-1', type: 'staff_mfa_challenge', tokenVersion: 3, ...overrides }, SECRET, { expiresIn: '5m' });

  beforeEach(() => { process.env.GATE_ADMIN_MFA = 'true'; });

  test('a passing code issues a two-step session', async () => {
    db.mockReturnValueOnce(builder({ first: staffRow({ mfa_enabled_at: new Date() }) }));
    db.mockReturnValueOnce(builder());
    staffMfa.verifySecondFactor.mockResolvedValue({ ok: true, method: 'totp' });

    const res = await invoke(loginMfa, { body: { challengeToken: challenge(), code: '123456' } });

    expect(res.statusCode).toBe(200);
    expect(staffMfa.verifySecondFactor).toHaveBeenCalledWith('tech-1', '123456');
    expect(jwt.verify(res.body.token, SECRET)).toMatchObject({ technicianId: 'tech-1', type: 'access', tokenVersion: 3, mfa: true });
    expect(jwt.verify(res.body.token, SECRET).mfaRecoveryUntil).toBeUndefined();
    expect(res.body.user.twoStep).toEqual({ enabled: true, enrollmentRequired: false });
    expect(res.cookie).toHaveBeenCalledWith('waves_admin', expect.any(String), expect.any(Object));
  });

  test('a recovery-code sign-in marks the session so a lost phone can be replaced', async () => {
    db.mockReturnValueOnce(builder({ first: staffRow({ mfa_enabled_at: new Date() }) }));
    db.mockReturnValueOnce(builder());
    staffMfa.verifySecondFactor.mockResolvedValue({ ok: true, method: 'recovery' });
    const res = await invoke(loginMfa, { body: { challengeToken: challenge(), code: 'AAAA-BBBB-CCCC-DDDD' } });
    const claims = jwt.verify(res.body.token, SECRET);
    expect(claims.mfa).toBe(true);
    expect(claims.mfaRecoveryUntil - claims.iat).toBeGreaterThanOrEqual(29 * 60);
    expect(claims.mfaRecoveryUntil - claims.iat).toBeLessThanOrEqual(30 * 60);
  });

  test.each([
    ['invalid', 401, 'MFA_INVALID'],
    ['locked', 429, 'MFA_LOCKED'],
    ['unavailable', 503, 'MFA_UNAVAILABLE'],
  ])('a %s result issues no session (%s)', async (reason, status, code) => {
    db.mockReturnValueOnce(builder({ first: staffRow({ mfa_enabled_at: new Date() }) }));
    staffMfa.verifySecondFactor.mockResolvedValue({ ok: false, reason });
    const res = await invoke(loginMfa, { body: { challengeToken: challenge(), code: '123456' } });
    expect(res.statusCode).toBe(status);
    expect(res.body.code).toBe(code);
    expect(res.body.token).toBeUndefined();
  });

  test.each([
    ['an access token used as a challenge', () => jwt.sign({ technicianId: 'tech-1', type: 'access', tokenVersion: 3 }, SECRET)],
    ['a challenge signed with another secret', () => jwt.sign({ technicianId: 'tech-1', type: 'staff_mfa_challenge', tokenVersion: 3 }, 'other')],
    ['an expired challenge', () => jwt.sign({ technicianId: 'tech-1', type: 'staff_mfa_challenge', tokenVersion: 3, exp: Math.floor(Date.now() / 1000) - 1 }, SECRET)],
  ])('refuses %s before checking any code', async (_label, make) => {
    const res = await invoke(loginMfa, { body: { challengeToken: make(), code: '123456' } });
    expect(res.statusCode).toBe(401);
    expect(res.body.code).toBe('MFA_CHALLENGE_INVALID');
    expect(staffMfa.verifySecondFactor).not.toHaveBeenCalled();
  });

  test('a password change since the challenge (token version moved) restarts sign-in', async () => {
    db.mockReturnValueOnce(builder({ first: staffRow({ mfa_enabled_at: new Date(), auth_token_version: 4 }) }));
    const res = await invoke(loginMfa, { body: { challengeToken: challenge(), code: '123456' } });
    expect(res.body.code).toBe('MFA_CHALLENGE_INVALID');
    expect(staffMfa.verifySecondFactor).not.toHaveBeenCalled();
  });

  test('gate turned off between the steps: the challenge is dead', async () => {
    delete process.env.GATE_ADMIN_MFA;
    const res = await invoke(loginMfa, { body: { challengeToken: challenge(), code: '123456' } });
    expect(res.body.code).toBe('MFA_CHALLENGE_INVALID');
    expect(db).not.toHaveBeenCalled();
  });
});

describe('password reset with two-step sign-in on', () => {
  test('an emailed reset link changes the password but issues no session for an enrolled account', async () => {
    process.env.GATE_ADMIN_MFA = 'true';
    const enrolled = staffRow({ mfa_enabled_at: new Date() });
    db.mockReturnValueOnce(builder({ first: enrolled }));
    bcrypt.compare.mockResolvedValue(false);
    bcrypt.hash.mockResolvedValue('$2a$12$new');
    db.transaction = jest.fn(async (fn) => {
      const trx = jest.fn(() => builder({ returning: [{ ...enrolled, auth_token_version: 4 }] }));
      trx.fn = { now: () => 'now()' };
      return fn(trx);
    });

    const res = await invoke(resetPassword, { body: { token: 'a'.repeat(43), newPassword: 'Brand-new-Password-42' } });

    expect(res.body).toEqual({ passwordReset: true, signInRequired: true });
    expect(res.cookie).not.toHaveBeenCalled();
  });
});

describe('self-service routes', () => {
  beforeEach(() => { process.env.GATE_ADMIN_MFA = 'true'; });

  test('setup asks for the account password; replacing also asks for the current code', async () => {
    bcrypt.compare.mockResolvedValue(false);
    let res = await invoke(mfaSetup, { technician: staffRow(), body: { currentPassword: 'nope' } });
    expect(res.statusCode).toBe(400);
    expect(staffMfa.startSetup).not.toHaveBeenCalled();

    bcrypt.compare.mockResolvedValue(true);
    res = await invoke(mfaSetup, { technician: staffRow({ mfa_enabled_at: new Date() }), body: { currentPassword: 'right' } });
    expect(res.statusCode).toBe(400);
    expect(staffMfa.startSetup).not.toHaveBeenCalled();

    staffMfa.verifySecondFactor.mockResolvedValue({ ok: true, method: 'totp' });
    staffMfa.startSetup.mockResolvedValue({ ok: true, secret: 'ABC', otpauthUrl: 'otpauth://totp/x' });
    res = await invoke(mfaSetup, { technician: staffRow({ mfa_enabled_at: new Date() }), body: { currentPassword: 'right', code: '123456' } });
    expect(res.body).toEqual({ secret: 'ABC', otpauthUrl: 'otpauth://totp/x', expiresInMinutes: 15 });
    expect(staffMfa.startSetup).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'tech-1' }), { expectedTokenVersion: 3 });

    staffMfa.startSetup.mockResolvedValue({ ok: false, reason: 'revoked' });
    res = await invoke(mfaSetup, { technician: staffRow({ mfa_enabled_at: new Date() }), body: { currentPassword: 'right', code: '123456' } });
    expect(res.statusCode).toBe(401);
    expect(res.body.secret).toBeUndefined();
  });

  test('confirm is fenced on the session version and continues this session on the new version', async () => {
    staffMfa.confirmSetup.mockResolvedValue({
      ok: true,
      recoveryCodes: ['AAAA-BBBB-CCCC-DDDD'],
      technician: staffRow({ mfa_enabled_at: new Date(), auth_token_version: 4 }),
    });
    const res = await invoke(mfaConfirm, { technician: staffRow(), body: { code: '123456' } });
    expect(staffMfa.confirmSetup).toHaveBeenCalledWith(expect.objectContaining({ id: 'tech-1' }), '123456', { expectedTokenVersion: 3 });
    expect(res.body.recoveryCodes).toEqual(['AAAA-BBBB-CCCC-DDDD']);
    expect(jwt.verify(res.body.token, SECRET)).toMatchObject({ mfa: true, tokenVersion: 4 });
    expect(require('../sockets').disconnectStaffSockets).toHaveBeenCalledWith('tech-1', 'mfa_enrolled');
  });

  test('a revoked session cannot finish enrollment; a wrong code is a 400, never a session end', async () => {
    staffMfa.confirmSetup.mockResolvedValue({ ok: false, reason: 'revoked' });
    let res = await invoke(mfaConfirm, { technician: staffRow(), body: { code: '123456' } });
    expect(res.statusCode).toBe(401);
    expect(res.body.code).toBe('TOKEN_REVOKED');
    expect(res.body.token).toBeUndefined();

    staffMfa.confirmSetup.mockResolvedValue({ ok: false, reason: 'invalid' });
    res = await invoke(mfaConfirm, { technician: staffRow(), body: { code: '000000' } });
    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('MFA_INVALID');
  });

  test('an enforced admin cannot turn two-step sign-in off', async () => {
    process.env.GATE_ADMIN_MFA_ENFORCE = 'true';
    const res = await invoke(mfaDisable, { technician: staffRow({ mfa_enabled_at: new Date() }), body: { currentPassword: 'x', code: '123456' } });
    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('MFA_REQUIRED_FOR_ROLE');
    expect(staffMfa.disable).not.toHaveBeenCalled();
  });

  test('turning it off needs the password and a code', async () => {
    bcrypt.compare.mockResolvedValue(true);
    staffMfa.verifySecondFactor.mockResolvedValue({ ok: false, reason: 'invalid' });
    let res = await invoke(mfaDisable, { technician: staffRow({ mfa_enabled_at: new Date() }), body: { currentPassword: 'x', code: '000000' } });
    expect(res.statusCode).toBe(400);
    expect(staffMfa.disable).not.toHaveBeenCalled();
    staffMfa.verifySecondFactor.mockResolvedValue({ ok: true, method: 'totp' });
    staffMfa.disable.mockResolvedValue({ ok: true });
    res = await invoke(mfaDisable, { technician: staffRow({ mfa_enabled_at: new Date() }), body: { currentPassword: 'x', code: '123456' } });
    expect(res.body).toEqual({ ok: true });
    expect(staffMfa.disable).toHaveBeenCalledWith('tech-1', { expectedTokenVersion: 3 });

    // A factor replacement or password change that landed first wins.
    staffMfa.disable.mockResolvedValue({ ok: false, reason: 'revoked' });
    res = await invoke(mfaDisable, { technician: staffRow({ mfa_enabled_at: new Date() }), body: { currentPassword: 'x', code: '123456' } });
    expect(res.statusCode).toBe(401);
    expect(res.body.code).toBe('TOKEN_REVOKED');
  });

  test('a password change keeps the recovery window of the session, never extends it', async () => {
    bcrypt.compare.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    bcrypt.hash.mockResolvedValue('$2a$12$new');
    const enrolled = staffRow({ mfa_enabled_at: new Date() });
    db.transaction = jest.fn(async (fn) => {
      const trx = jest.fn(() => builder({ returning: [{ ...enrolled, auth_token_version: 4 }] }));
      trx.fn = { now: () => 'now()' };
      return fn(trx);
    });
    const until = Math.floor(Date.now() / 1000) + 600;
    const res = await invoke(changePassword, {
      technician: enrolled,
      staffToken: { mfa: true, mfaRecoveryUntil: until },
      body: { currentPassword: 'Old-Password-1234', newPassword: 'Brand-new-Password-42' },
    });
    expect(jwt.verify(res.body.token, SECRET)).toMatchObject({ mfa: true, mfaRecoveryUntil: until, tokenVersion: 4 });
  });

  test('new recovery codes are fenced on the session version', async () => {
    staffMfa.verifySecondFactor.mockResolvedValue({ ok: true, method: 'totp' });
    staffMfa.regenerateRecoveryCodes.mockResolvedValue({ ok: false, reason: 'revoked' });
    const res = await invoke(mfaRegenerateRecoveryCodes, { technician: staffRow({ mfa_enabled_at: new Date() }), body: { code: '123456' } });
    expect(staffMfa.regenerateRecoveryCodes).toHaveBeenCalledWith('tech-1', { expectedTokenVersion: 3 });
    expect(res.statusCode).toBe(401);
    expect(res.body.recoveryCodes).toBeUndefined();
  });

  test('a session that signed in with a recovery code may replace the authenticator without another code, briefly', async () => {
    bcrypt.compare.mockResolvedValue(true);
    staffMfa.startSetup.mockResolvedValue({ ok: true, secret: 'ABC', otpauthUrl: 'otpauth://totp/x' });
    const enrolled = staffRow({ mfa_enabled_at: new Date() });
    const now = Math.floor(Date.now() / 1000);
    let res = await invoke(mfaSetup, { technician: enrolled, staffToken: { mfa: true, mfaRecoveryUntil: now + 60 }, body: { currentPassword: 'right' } });
    expect(res.body.secret).toBe('ABC');
    expect(staffMfa.verifySecondFactor).not.toHaveBeenCalled();

    staffMfa.startSetup.mockClear();
    res = await invoke(mfaSetup, { technician: enrolled, staffToken: { mfa: true, mfaRecoveryUntil: now - 1 }, body: { currentPassword: 'right' } });
    expect(res.statusCode).toBe(400);
    expect(staffMfa.startSetup).not.toHaveBeenCalled();
  });
});

describe('adminAuthenticate and verifyStaffBearer', () => {
  function authed(tech, claims, path = '/kb') {
    db.mockImplementation(() => builder({ first: tech }));
    const token = jwt.sign({ technicianId: tech.id, type: 'access', tokenVersion: tech.auth_token_version, ...claims }, SECRET);
    return { headers: { authorization: `Bearer ${token}` }, baseUrl: '/api/admin', path };
  }
  async function run(req) {
    const res = response();
    res.json = jest.fn(function json(body) { this.body = body; return this; });
    const next = jest.fn();
    await adminAuthenticate(req, res, next);
    return { res, next };
  }

  test('gate off: an enrolled account with a password-only session is let through', async () => {
    const { next } = await run(authed(staffRow({ mfa_enabled_at: new Date() }), {}));
    expect(next).toHaveBeenCalled();
  });

  test('gate on: a session that never passed the code is refused with 401 MFA_REQUIRED', async () => {
    process.env.GATE_ADMIN_MFA = 'true';
    const enrolled = staffRow({ mfa_enabled_at: new Date() });
    const { res, next } = await run(authed(enrolled, {}));
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(res.body.code).toBe('MFA_REQUIRED');
    expect(await verifyStaffBearer(authed(enrolled, {}))).toBeNull();

    const passed = await run(authed(enrolled, { mfa: true }));
    expect(passed.next).toHaveBeenCalled();
    expect(await verifyStaffBearer(authed(enrolled, { mfa: true }))).toEqual(enrolled);
  });

  test('enforce: an admin without an authenticator reaches only /me and the setup routes', async () => {
    process.env.GATE_ADMIN_MFA = 'true';
    process.env.GATE_ADMIN_MFA_ENFORCE = 'true';
    const bare = staffRow();
    const blocked = await run(authed(bare, {}, '/kb'));
    expect(blocked.res.statusCode).toBe(403);
    expect(blocked.res.body.code).toBe('MFA_ENROLLMENT_REQUIRED');
    for (const path of ['/auth/me', '/auth/mfa', '/auth/mfa/totp/setup', '/auth/mfa/totp/confirm']) {
      const { next } = await run(authed(bare, {}, path));
      expect(next).toHaveBeenCalled();
    }
    const disable = await run(authed(bare, {}, '/auth/mfa/disable'));
    expect(disable.res.statusCode).toBe(403);
  });

  test('enforce plus a forced password change: the change runs first, then enrollment', async () => {
    process.env.GATE_ADMIN_MFA = 'true';
    process.env.GATE_ADMIN_MFA_ENFORCE = 'true';
    const rotating = staffRow({ must_change_password: true });
    expect((await run(authed(rotating, {}, '/auth/change-password'))).next).toHaveBeenCalled();
    const setup = await run(authed(rotating, {}, '/auth/mfa/totp/setup'));
    expect(setup.res.body.code).toBe('PASSWORD_CHANGE_REQUIRED');
  });
});
