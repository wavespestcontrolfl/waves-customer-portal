jest.mock('../models/db', () => {
  const db = jest.fn();
  db.transaction = jest.fn();
  return db;
});

const db = require('../models/db');
const {
  OAUTH_STATE_RE,
  createStaffOAuthState,
  withClaimedStaffOAuthState,
} = require('../services/staff-oauth-state');

const PREFIX = 'test.oauth_state:';
const STATE = 'A'.repeat(43);
const ADMIN = {
  id: 'admin-1',
  active: true,
  role: 'admin',
  auth_token_version: 7,
  must_change_password: false,
};

function chain(extra = {}) {
  const builder = {
    where: jest.fn(() => builder),
    andWhere: jest.fn(() => builder),
    forUpdate: jest.fn(() => builder),
    ...extra,
  };
  return builder;
}

function installClaim({ payload = {}, technician = ADMIN, claimed = true } = {}) {
  const returning = jest.fn(async () => claimed
    ? [{ value: JSON.stringify({
      state: STATE,
      technicianId: ADMIN.id,
      tokenVersion: 7,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      ...payload,
    }) }]
    : []);
  const stateBuilder = chain({
    delete: jest.fn(() => ({ returning })),
  });
  const techBuilder = chain({
    first: jest.fn(async () => technician),
  });
  const trx = jest.fn((table) => {
    if (table === 'system_settings') return stateBuilder;
    if (table === 'technicians') return techBuilder;
    throw new Error(`Unexpected table ${table}`);
  });
  db.transaction.mockImplementation(async (callback) => callback(trx));
  return { returning, stateBuilder, techBuilder, trx };
}

describe('staff OAuth state credential binding', () => {
  beforeEach(() => jest.clearAllMocks());

  test('creation stores only an opaque state bound to admin id and token version', async () => {
    const cleanup = chain({ del: jest.fn(async () => 0) });
    const insert = jest.fn(async () => 1);
    db.mockReturnValueOnce(cleanup).mockReturnValueOnce({ insert });

    const state = await createStaffOAuthState({
      prefix: PREFIX,
      technician: ADMIN,
      ttlMs: 600_000,
      metadata: { integration: 'test' },
    });

    expect(state).toMatch(OAUTH_STATE_RE);
    expect(cleanup.where).toHaveBeenCalledWith('key', 'like', `${PREFIX}%`);
    const row = insert.mock.calls[0][0];
    expect(row.key).toBe(`${PREFIX}${state}`);
    expect(JSON.parse(row.value)).toMatchObject({
      state,
      technicianId: ADMIN.id,
      tokenVersion: 7,
      integration: 'test',
    });
    expect(row.value).not.toContain('password');
  });

  test('claims once, row-locks the technician, revalidates, then mutates credentials', async () => {
    const { returning, techBuilder, trx } = installClaim();
    const mutate = jest.fn(async () => 'connected');

    await expect(withClaimedStaffOAuthState({
      prefix: PREFIX,
      rawState: STATE,
      callback: mutate,
    })).resolves.toBe('connected');

    expect(returning).toHaveBeenCalledWith(['value']);
    expect(techBuilder.forUpdate).toHaveBeenCalled();
    expect(mutate).toHaveBeenCalledWith(
      expect.objectContaining({ technicianId: ADMIN.id, tokenVersion: 7 }),
      expect.objectContaining({ technician: ADMIN, trx }),
    );
    expect(returning.mock.invocationCallOrder[0]).toBeLessThan(
      techBuilder.forUpdate.mock.invocationCallOrder[0],
    );
    expect(techBuilder.forUpdate.mock.invocationCallOrder[0]).toBeLessThan(
      mutate.mock.invocationCallOrder[0],
    );
  });

  test.each([
    ['rotated version', { ...ADMIN, auth_token_version: 8 }],
    ['inactive account', { ...ADMIN, active: false }],
    ['non-admin role', { ...ADMIN, role: 'technician' }],
    ['forced password change', { ...ADMIN, must_change_password: true }],
  ])('consumes but rejects state for a %s', async (_label, technician) => {
    installClaim({ technician });
    const mutate = jest.fn();

    await expect(withClaimedStaffOAuthState({
      prefix: PREFIX,
      rawState: STATE,
      callback: mutate,
    })).rejects.toMatchObject({
      message: 'Invalid or expired OAuth state',
      code: 'STAFF_OAUTH_STATE_INVALID',
    });
    expect(mutate).not.toHaveBeenCalled();
  });

  test('rejects a replay before taking a technician row lock', async () => {
    const { techBuilder } = installClaim({ claimed: false });
    await expect(withClaimedStaffOAuthState({
      prefix: PREFIX,
      rawState: STATE,
      callback: jest.fn(),
    })).rejects.toMatchObject({ code: 'STAFF_OAUTH_STATE_INVALID' });
    expect(techBuilder.forUpdate).not.toHaveBeenCalled();
  });

  test('keeps a provider failure one-shot by returning it after the claim transaction', async () => {
    installClaim();
    const providerError = new Error('provider rejected code');
    await expect(withClaimedStaffOAuthState({
      prefix: PREFIX,
      rawState: STATE,
      callback: jest.fn(async () => { throw providerError; }),
    })).rejects.toBe(providerError);
    expect(db.transaction).toHaveBeenCalledTimes(1);
  });

  test('rejects malformed public state without opening a transaction', async () => {
    await expect(withClaimedStaffOAuthState({
      prefix: PREFIX,
      rawState: 'not-a-real-state',
      callback: jest.fn(),
    })).rejects.toMatchObject({ code: 'STAFF_OAUTH_STATE_INVALID' });
    expect(db.transaction).not.toHaveBeenCalled();
  });

  test.each([null, undefined, '', -1, 0, 1.5])(
    'rejects an invalid initiating token version (%p)',
    async (authTokenVersion) => {
      const cleanup = chain({ del: jest.fn(async () => 0) });
      db.mockReturnValueOnce(cleanup);

      await expect(createStaffOAuthState({
        prefix: PREFIX,
        technician: { ...ADMIN, auth_token_version: authTokenVersion },
        ttlMs: 600_000,
      })).rejects.toThrow('A current admin session is required to start OAuth');
    },
  );
});
