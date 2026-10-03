// Staff two-step sign-in against a migrated PostgreSQL (pgcrypto, the real
// conditional UPDATEs): setup → confirm → login codes, replay protection,
// single-use recovery codes, lockout, and turning it off.
const { randomUUID } = require('node:crypto');
const knex = require('knex');

let mockDatabase;
jest.mock('../models/db', () => {
  const database = (...args) => mockDatabase(...args);
  database.transaction = (...args) => mockDatabase.transaction(...args);
  database.raw = (...args) => mockDatabase.raw(...args);
  Object.defineProperty(database, 'fn', { get: () => mockDatabase.fn });
  return database;
});

const staffMfa = require('../services/staff-mfa');

const connection = process.env.C360_TEST_DATABASE_URL;
const postgres = connection ? describe : describe.skip;

postgres('staff two-step sign-in on migrated PostgreSQL', () => {
  const savedEnv = {};
  let techId;
  let tech;

  // A code for the step `offset` steps from now, from the secret setup returned.
  const codeFor = (secret, offsetSteps = 0, nowMs = Date.now()) => staffMfa.hotp(
    staffMfa.base32Decode(secret),
    staffMfa.timeStep(nowMs) + offsetSteps,
  );

  beforeAll(async () => {
    if (!/^\/waves_qa_[a-f0-9]{32}$/.test(new URL(connection).pathname)) throw new Error('Use a verified private QA database');
    mockDatabase = knex({ client: 'pg', connection, pool: { min: 0, max: 2 } });
    if (!await mockDatabase.schema.hasTable('staff_mfa_totp')) throw new Error('Run development migrations first');
    for (const k of ['GATE_ADMIN_MFA', 'GATE_ADMIN_MFA_ENFORCE', 'STAFF_MFA_KEY', 'DATA_HYGIENE_VAULT_KEY']) savedEnv[k] = process.env[k];
    process.env.GATE_ADMIN_MFA = 'true';
    process.env.STAFF_MFA_KEY = `test-key-${randomUUID()}`;
  });

  beforeEach(async () => {
    techId = randomUUID();
    await mockDatabase('technicians').insert({
      id: techId, name: 'MFA Fixture', email: `mfa-${techId}@example.test`, role: 'admin', active: true,
    });
    tech = await mockDatabase('technicians').where({ id: techId }).first();
  });

  afterEach(async () => {
    await mockDatabase('push_subscriptions').where({ admin_user_id: techId }).del();
    await mockDatabase('technicians').where({ id: techId }).del();
  });

  afterAll(async () => {
    for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await mockDatabase?.destroy();
  });

  async function enroll() {
    const { secret } = await staffMfa.startSetup(tech, { expectedTokenVersion: 1 });
    // Confirm with the PREVIOUS step's code so the current step stays usable
    // for the login assertions below.
    const now = Date.now();
    const confirmed = await staffMfa.confirmSetup(tech, codeFor(secret, -1, now), { nowMs: now, expectedTokenVersion: 1 });
    expect(confirmed.ok).toBe(true);
    return { secret, recoveryCodes: confirmed.recoveryCodes };
  }

  test('setup stores only ciphertext; confirm activates it, stamps the account and issues recovery codes', async () => {
    await mockDatabase('push_subscriptions').insert({ admin_user_id: techId, subscription_data: '{}', active: true });
    const { secret, otpauthUrl } = await staffMfa.startSetup(tech, { expectedTokenVersion: 1 });
    expect(otpauthUrl).toContain(`secret=${secret}`);
    const pending = await mockDatabase('staff_mfa_totp').where({ technician_id: techId }).first();
    expect(pending.pending_secret_enc).toMatch(/BEGIN PGP MESSAGE/);
    expect(pending.pending_secret_enc).not.toContain(secret);
    expect(pending.secret_enc).toBeNull();

    // One pinned clock for generating and checking, so a 30-second boundary
    // between the two can never move the expected step.
    const now = Date.now();
    expect(await staffMfa.confirmSetup(tech, codeFor(secret, 5, now), { expectedTokenVersion: 1, nowMs: now })).toMatchObject({ ok: false, reason: 'invalid' });
    const confirmed = await staffMfa.confirmSetup(tech, codeFor(secret, 0, now), { expectedTokenVersion: 1, nowMs: now });
    expect(confirmed.ok).toBe(true);
    expect(confirmed.recoveryCodes).toHaveLength(10);

    const row = await mockDatabase('staff_mfa_totp').where({ technician_id: techId }).first();
    expect(row.secret_enc).toBe(pending.pending_secret_enc);
    expect(row.pending_secret_enc).toBeNull();
    expect(Number(row.last_used_step)).toBe(staffMfa.timeStep(now));
    const account = await mockDatabase('technicians').where({ id: techId }).first();
    expect(account.mfa_enabled_at).not.toBeNull();
    // Like a password change: every earlier session and device is signed out.
    expect(account.auth_token_version).toBe(2);
    expect(confirmed.technician.auth_token_version).toBe(2);
    expect(await mockDatabase('push_subscriptions').where({ admin_user_id: techId, active: true })).toHaveLength(0);
    const stored = await mockDatabase('staff_mfa_recovery_codes').where({ technician_id: techId });
    expect(stored).toHaveLength(10);
    expect(stored.every((r) => /^[0-9a-f]{64}$/.test(r.code_hash))).toBe(true);
  });

  test('the code that confirmed setup cannot be replayed at sign-in', async () => {
    const { secret } = await staffMfa.startSetup(tech, { expectedTokenVersion: 1 });
    const code = codeFor(secret);
    expect((await staffMfa.confirmSetup(tech, code, { expectedTokenVersion: 1 })).ok).toBe(true);
    expect(await staffMfa.verifySecondFactor(techId, code, { expectedTokenVersion: 2 })).toMatchObject({ ok: false, reason: 'invalid' });
  });

  test('a sign-in revoked by a password change consumes no code', async () => {
    const { recoveryCodes } = await enroll();
    expect(await staffMfa.verifySecondFactor(techId, recoveryCodes[0], { expectedTokenVersion: 1 })).toEqual({ ok: false, reason: 'revoked' });
    expect(await staffMfa.verifySecondFactor(techId, recoveryCodes[0], { expectedTokenVersion: 2 })).toEqual({ ok: true, method: 'recovery' });
  });

  test('a code is accepted once; replaying it, or an older step, is refused', async () => {
    const { secret } = await enroll();
    const code = codeFor(secret);
    const [first, second] = await Promise.all([
      staffMfa.verifySecondFactor(techId, code, { expectedTokenVersion: 2 }),
      staffMfa.verifySecondFactor(techId, code, { expectedTokenVersion: 2 }),
    ]);
    expect([first.ok, second.ok].sort()).toEqual([false, true]);
    expect(await staffMfa.verifySecondFactor(techId, codeFor(secret, -1), { expectedTokenVersion: 2 })).toMatchObject({ ok: false });
    expect(await staffMfa.verifySecondFactor(techId, codeFor(secret, 1), { expectedTokenVersion: 2 })).toEqual({ ok: true, method: 'totp' });
  });

  test('each recovery code works exactly once, typed any way', async () => {
    const { recoveryCodes } = await enroll();
    const typed = recoveryCodes[3].toLowerCase().replace(/-/g, ' ');
    expect(await staffMfa.verifySecondFactor(techId, typed, { expectedTokenVersion: 2 })).toEqual({ ok: true, method: 'recovery' });
    expect(await staffMfa.verifySecondFactor(techId, recoveryCodes[3], { expectedTokenVersion: 2 })).toMatchObject({ ok: false });
    const status = await staffMfa.status(await mockDatabase('technicians').where({ id: techId }).first());
    expect(status).toMatchObject({ available: true, enabled: true, recoveryCodesRemaining: 9 });
  });

  test('five wrong codes lock the account for 15 minutes, even against a right code', async () => {
    const { secret } = await enroll();
    for (let i = 0; i < 4; i += 1) {
      expect(await staffMfa.verifySecondFactor(techId, 'AAAA-AAAA-AAAA-AAAA', { expectedTokenVersion: 2 })).toEqual({ ok: false, reason: 'invalid' });
    }
    const fifth = await staffMfa.verifySecondFactor(techId, 'AAAA-AAAA-AAAA-AAAA', { expectedTokenVersion: 2 });
    expect(fifth.reason).toBe('locked');
    expect(fifth.lockedUntil.getTime()).toBeGreaterThan(Date.now() + 14 * 60 * 1000);
    expect((await staffMfa.verifySecondFactor(techId, codeFor(secret, 1), { expectedTokenVersion: 2 })).reason).toBe('locked');
  });

  test('without the encryption key the stored secret is unreadable and every code fails closed', async () => {
    const { secret } = await enroll();
    const key = process.env.STAFF_MFA_KEY;
    process.env.STAFF_MFA_KEY = `other-${randomUUID()}`;
    try {
      expect(await staffMfa.verifySecondFactor(techId, codeFor(secret, 1), { expectedTokenVersion: 2 })).toEqual({ ok: false, reason: 'unavailable' });
    } finally {
      process.env.STAFF_MFA_KEY = key;
    }
  });

  test('regenerating replaces every recovery code; turning it off removes the factor and the stamp', async () => {
    const { recoveryCodes } = await enroll();
    // enroll() moved the credential version from 1 to 2.
    expect(await staffMfa.regenerateRecoveryCodes(techId, { expectedTokenVersion: 1 })).toEqual({ ok: false, reason: 'revoked' });
    expect(await staffMfa.disable(techId, { expectedTokenVersion: 1 })).toEqual({ ok: false, reason: 'revoked' });
    const { recoveryCodes: fresh } = await staffMfa.regenerateRecoveryCodes(techId, { expectedTokenVersion: 2 });
    expect(fresh).toHaveLength(10);
    expect(await staffMfa.verifySecondFactor(techId, recoveryCodes[0], { expectedTokenVersion: 2 })).toMatchObject({ ok: false });
    expect(await staffMfa.verifySecondFactor(techId, fresh[0], { expectedTokenVersion: 2 })).toEqual({ ok: true, method: 'recovery' });

    expect(await staffMfa.disable(techId, { expectedTokenVersion: 2 })).toEqual({ ok: true });
    expect(await mockDatabase('staff_mfa_totp').where({ technician_id: techId }).first()).toBeUndefined();
    expect(await mockDatabase('staff_mfa_recovery_codes').where({ technician_id: techId })).toHaveLength(0);
    expect((await mockDatabase('technicians').where({ id: techId }).first()).mfa_enabled_at).toBeNull();
  });

  test('an expired setup cannot be confirmed', async () => {
    const { secret } = await staffMfa.startSetup(tech, { expectedTokenVersion: 1 });
    const later = Date.now() + staffMfa.PENDING_SETUP_TTL_MS + 60 * 1000;
    expect(await staffMfa.confirmSetup(tech, codeFor(secret, 0, later), { nowMs: later, expectedTokenVersion: 1 })).toEqual({ ok: false, reason: 'expired' });
  });
  test('a password change that landed after the request authenticated wins: nothing is enabled', async () => {
    const { secret } = await staffMfa.startSetup(tech, { expectedTokenVersion: 1 });
    await mockDatabase('technicians').where({ id: techId }).update({ auth_token_version: 2 });
    expect(await staffMfa.confirmSetup(tech, codeFor(secret), { expectedTokenVersion: 1 })).toEqual({ ok: false, reason: 'revoked' });
    expect((await mockDatabase('technicians').where({ id: techId }).first()).mfa_enabled_at).toBeNull();
  });

  test('a setup encrypted under the fallback key still confirms after a dedicated key is added', async () => {
    const dedicated = process.env.STAFF_MFA_KEY;
    delete process.env.STAFF_MFA_KEY;
    process.env.DATA_HYGIENE_VAULT_KEY = `fallback-${randomUUID()}`;
    try {
      const { secret } = await staffMfa.startSetup(tech, { expectedTokenVersion: 1 });
      process.env.STAFF_MFA_KEY = dedicated;
      expect((await staffMfa.confirmSetup(tech, codeFor(secret), { expectedTokenVersion: 1 })).ok).toBe(true);
    } finally {
      process.env.STAFF_MFA_KEY = dedicated;
      delete process.env.DATA_HYGIENE_VAULT_KEY;
    }
  });
  test('a failed setup write never carries the secret or the key in its error', async () => {
    await mockDatabase.raw('ALTER TABLE staff_mfa_totp ADD CONSTRAINT staff_mfa_totp_test_block CHECK (false) NOT VALID');
    try {
      const err = await staffMfa.startSetup(tech, { expectedTokenVersion: 1 }).catch((e) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toMatch(/^staff MFA setup failed: database error 23514$/);
      expect(`${err.message}\n${err.stack}`).not.toContain(process.env.STAFF_MFA_KEY);
    } finally {
      await mockDatabase.raw('ALTER TABLE staff_mfa_totp DROP CONSTRAINT staff_mfa_totp_test_block');
    }
  });

  test('a setup request from a session revoked meanwhile writes no secret', async () => {
    await mockDatabase('technicians').where({ id: techId }).update({ auth_token_version: 2 });
    expect(await staffMfa.startSetup(tech, { expectedTokenVersion: 1 })).toEqual({ ok: false, reason: 'revoked' });
    expect(await mockDatabase('staff_mfa_totp').where({ technician_id: techId }).first()).toBeUndefined();
  });
  test('a parallel burst of wrong codes cannot get past the lockout', async () => {
    const { secret } = await enroll();
    const right = codeFor(secret, 1);
    const wrong = right === '000000' ? '111111' : '000000';
    const results = await Promise.all([
      ...Array.from({ length: 8 }, () => staffMfa.verifySecondFactor(techId, wrong, { expectedTokenVersion: 2 })),
      staffMfa.verifySecondFactor(techId, 'BBBB-BBBB-BBBB-BBBB', { expectedTokenVersion: 2 }),
    ]);
    expect(results.every((r) => !r.ok)).toBe(true);
    expect(results.filter((r) => r.reason === 'invalid')).toHaveLength(4);
    expect(results.filter((r) => r.reason === 'locked')).toHaveLength(5);
    // Locked: even the right code is refused, and nothing reset the lock.
    expect((await staffMfa.verifySecondFactor(techId, right, { expectedTokenVersion: 2 })).reason).toBe('locked');
  });
  test('turning it off while a recovery code is being used never deadlocks', async () => {
    const { recoveryCodes } = await enroll();
    const results = await Promise.allSettled([
      staffMfa.disable(techId, { expectedTokenVersion: 2 }),
      staffMfa.verifySecondFactor(techId, recoveryCodes[0], { expectedTokenVersion: 2 }),
      staffMfa.disable(techId, { expectedTokenVersion: 2 }),
      staffMfa.verifySecondFactor(techId, recoveryCodes[1], { expectedTokenVersion: 2 }),
    ]);
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    expect((await mockDatabase('technicians').where({ id: techId }).first()).mfa_enabled_at).toBeNull();
  });
  test('gate on: staff pushes skip an enrolled account\'s devices registered without the code', async () => {
    const PushService = require('../services/push-notifications');
    await enroll(); // credential version 2, earlier devices deactivated
    await mockDatabase('push_subscriptions').insert([
      { admin_user_id: techId, subscription_data: '{"endpoint":"https://push.example.test/a"}', active: true, staff_token_version: 2, staff_mfa: false },
      { admin_user_id: techId, subscription_data: '{"endpoint":"https://push.example.test/b"}', active: true, staff_token_version: 2, staff_mfa: true },
    ]);
    // beforeDispatch returning false stops before any provider call and
    // reports how many devices the lookup chose.
    const lookup = () => PushService.sendToAdminUsers([techId], () => ({ title: 't', body: 'b' }), { beforeDispatch: async () => false });
    expect((await lookup()).subscriptions).toBe(1);
    process.env.GATE_ADMIN_MFA = 'false';
    try {
      expect((await lookup()).subscriptions).toBe(2);
    } finally {
      process.env.GATE_ADMIN_MFA = 'true';
    }
  });
  test('enforce: an admin still owed enrollment gets no staff push until enrolled', async () => {
    const PushService = require('../services/push-notifications');
    await mockDatabase('push_subscriptions').insert({ admin_user_id: techId, subscription_data: '{"endpoint":"https://push.example.test/c"}', active: true, staff_token_version: 1, staff_mfa: false });
    const lookup = () => PushService.sendToAdminUsers([techId], () => ({ title: 't', body: 'b' }), { beforeDispatch: async () => false });
    expect((await lookup()).subscriptions).toBe(1);
    process.env.GATE_ADMIN_MFA_ENFORCE = 'true';
    try {
      expect((await lookup()).subscriptions).toBe(0);
    } finally {
      delete process.env.GATE_ADMIN_MFA_ENFORCE;
    }
  });
  test('enrolling while a password-reset request holds the staff table lock waits, never deadlocks', async () => {
    const { secret } = await staffMfa.startSetup(tech, { expectedTokenVersion: 1 });
    const now = Date.now();
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    // The reset path: SHARE ROW EXCLUSIVE on technicians, then an update of
    // this account's row, while enrollment is in flight.
    const reset = mockDatabase.transaction(async (trx) => {
      await trx.raw('LOCK TABLE technicians IN SHARE ROW EXCLUSIVE MODE');
      await held;
      await trx('technicians').where({ id: techId }).update({ updated_at: trx.fn.now() });
    });
    const confirm = staffMfa.confirmSetup(tech, codeFor(secret, 0, now), { expectedTokenVersion: 1, nowMs: now });
    await new Promise((resolve) => { setTimeout(resolve, 200); });
    release();
    const [resetResult, confirmResult] = await Promise.allSettled([reset, confirm]);
    expect(resetResult.status).toBe('fulfilled');
    expect(confirmResult.status).toBe('fulfilled');
    expect(confirmResult.value.ok).toBe(true);
  });
});
