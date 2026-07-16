process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const jwt = require('jsonwebtoken');
const db = require('../models/db');
const logger = require('../services/logger');
const {
  createRefreshSession,
  reissueRefreshSessionForProperty,
  revokeRefreshSession,
  rotateRefreshSession,
} = require('../middleware/auth');

const customer = {
  id: '11111111-1111-4111-8111-111111111111',
  account_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  active: true,
  deleted_at: null,
};

function matches(row, filters) {
  return filters.every(([kind, value]) => {
    if (kind === 'where') {
      return Object.entries(value).every(([key, expected]) => String(row[key]) === String(expected));
    }
    if (kind === 'null') return row[value] == null;
    return true;
  });
}

function installMemoryDb() {
  const refreshRows = [];

  class Builder {
    constructor(table) {
      this.table = table;
      this.filters = [];
    }

    where(value, expected) {
      this.filters.push(['where', typeof value === 'object' ? value : { [value]: expected }]);
      return this;
    }

    whereNull(column) {
      this.filters.push(['null', column]);
      return this;
    }

    forUpdate() { return this; }

    async first() {
      const rows = this.table === 'customers' ? [customer] : refreshRows;
      return rows.find((row) => matches(row, this.filters));
    }

    insert(value) {
      if (this.table !== 'customer_refresh_tokens') throw new Error(`Unexpected insert ${this.table}`);
      let ignoreConflict = false;
      let resultPromise = null;
      const perform = () => {
        if (!resultPromise) {
          resultPromise = Promise.resolve().then(() => {
            const duplicate = refreshRows.find((row) => row.token_hash === value.token_hash);
            if (duplicate && ignoreConflict) return [];
            if (duplicate) throw new Error('duplicate token_hash');
            const row = { created_at: new Date(), updated_at: new Date(), ...value };
            refreshRows.push(row);
            return [row];
          });
        }
        return resultPromise;
      };
      const chain = {
        onConflict: () => chain,
        ignore: () => { ignoreConflict = true; return chain; },
        returning: () => perform(),
        then: (resolve, reject) => perform().then(resolve, reject),
      };
      return chain;
    }

    async update(value) {
      const rows = this.table === 'customers' ? [customer] : refreshRows;
      const found = rows.filter((row) => matches(row, this.filters));
      found.forEach((row) => Object.assign(row, value));
      return found.length;
    }
  }

  db.mockImplementation((table) => new Builder(table));
  db.transaction = jest.fn(async (callback) => callback(db));
  return refreshRows;
}

describe('durable customer refresh sessions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('rotates once, detects replay, and revokes every descendant', async () => {
    const rows = installMemoryDb();
    const initial = await createRefreshSession(customer.id, customer.account_id);

    const firstRotation = await rotateRefreshSession(initial.refreshToken);
    expect(firstRotation.ok).toBe(true);
    expect(firstRotation.refreshToken).not.toBe(initial.refreshToken);
    expect(firstRotation.familyId).toBe(initial.familyId);
    expect(rows).toHaveLength(2);
    expect(rows[0].token_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(rows)).not.toContain(initial.refreshToken);
    expect(rows.find((row) => row.jti === initial.jti).consumed_at).toBeInstanceOf(Date);
    expect(rows.find((row) => row.jti === firstRotation.jti).parent_jti).toBe(initial.jti);

    // Outside the same-browser concurrency grace, reuse is treated as theft.
    rows.find((row) => row.jti === initial.jti).consumed_at = new Date(Date.now() - 60_000);
    const replay = await rotateRefreshSession(initial.refreshToken);
    expect(replay).toMatchObject({ ok: false, code: 'REFRESH_TOKEN_REUSED' });
    expect(rows.every((row) => row.revoked_at instanceof Date)).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('replay detected'));

    const descendant = await rotateRefreshSession(firstRotation.refreshToken);
    expect(descendant).toMatchObject({ ok: false, code: 'REFRESH_SESSION_REVOKED' });
  });

  test('a simultaneous tab refresh gets no token and does not revoke the winner', async () => {
    const rows = installMemoryDb();
    const initial = await createRefreshSession(customer.id, customer.account_id);
    const winner = await rotateRefreshSession(initial.refreshToken);

    const concurrent = await rotateRefreshSession(initial.refreshToken);

    expect(concurrent).toMatchObject({ ok: false, code: 'REFRESH_TOKEN_ALREADY_ROTATED' });
    expect(concurrent.refreshToken).toBeUndefined();
    expect(rows.every((row) => row.revoked_at == null)).toBe(true);
    await expect(rotateRefreshSession(winner.refreshToken))
      .resolves.toMatchObject({ ok: true, familyId: initial.familyId });
  });

  test('logout revokes a family without requiring an access token', async () => {
    const rows = installMemoryDb();
    const session = await createRefreshSession(customer.id, customer.account_id);

    await expect(revokeRefreshSession(session.refreshToken, 'logout')).resolves.toEqual({ revoked: true });
    expect(rows[0]).toMatchObject({ revoke_reason: 'logout' });

    const refreshAfterLogout = await rotateRefreshSession(session.refreshToken);
    expect(refreshAfterLogout).toMatchObject({ ok: false, code: 'REFRESH_SESSION_REVOKED' });
  });

  test('property switching requires and consumes the current refresh credential', async () => {
    const rows = installMemoryDb();
    const session = await createRefreshSession(customer.id, customer.account_id);
    const targetCustomerId = '22222222-2222-4222-8222-222222222222';
    const targetCustomer = { ...customer, id: targetCustomerId };
    const originalImplementation = db.getMockImplementation();
    db.mockImplementation((table) => {
      const builder = originalImplementation(table);
      if (table === 'customers') {
        const originalFirst = builder.first.bind(builder);
        builder.first = async () => {
          const found = await originalFirst();
          if (found) return found;
          const idFilter = builder.filters.find(([kind, value]) => kind === 'where' && value.id);
          return idFilter && String(idFilter[1].id) === targetCustomerId ? targetCustomer : undefined;
        };
      }
      return builder;
    });

    const switched = await reissueRefreshSessionForProperty(
      session.refreshToken,
      targetCustomerId,
      customer.account_id,
      customer.id,
      session.familyId,
    );

    expect(switched.ok).toBe(true);
    expect(switched.familyId).toBe(session.familyId);
    expect(jwt.decode(switched.refreshToken)).toMatchObject({
      customerId: targetCustomerId,
      accountId: customer.account_id,
      familyId: session.familyId,
      type: 'refresh',
    });
    expect(rows.filter((row) => row.revoked_at == null && row.consumed_at == null)).toHaveLength(1);
    expect(rows[0]).toMatchObject({ revoke_reason: 'property_switch' });
  });

  test('a family id from an access token cannot switch property without the matching refresh token', async () => {
    installMemoryDb();
    const session = await createRefreshSession(customer.id, customer.account_id);
    const accessOnly = jwt.sign({
      customerId: customer.id,
      accountId: customer.account_id,
      sessionId: session.familyId,
    }, process.env.JWT_SECRET, { expiresIn: '15m' });

    const result = await reissueRefreshSessionForProperty(
      accessOnly,
      '22222222-2222-4222-8222-222222222222',
      customer.account_id,
      customer.id,
      session.familyId,
    );

    expect(result).toMatchObject({ ok: false, code: 'INVALID_REFRESH_TOKEN' });
  });

  test('gives a pre-rollout refresh token one migration exchange, then detects replay', async () => {
    const rows = installMemoryDb();
    const legacyToken = jwt.sign({
      customerId: customer.id,
      accountId: customer.account_id,
      type: 'refresh',
    }, process.env.JWT_SECRET, { expiresIn: '30d' });

    const migrated = await rotateRefreshSession(legacyToken);
    expect(migrated.ok).toBe(true);
    expect(jwt.decode(migrated.refreshToken)).toMatchObject({
      customerId: customer.id,
      accountId: customer.account_id,
      type: 'refresh',
      familyId: migrated.familyId,
    });
    expect(rows).toHaveLength(2);

    rows.find((row) => row.token_hash && row.jti === row.token_hash).consumed_at = new Date(Date.now() - 60_000);
    const replay = await rotateRefreshSession(legacyToken);
    expect(replay).toMatchObject({ ok: false, code: 'REFRESH_TOKEN_REUSED' });
    expect(rows.every((row) => row.revoked_at instanceof Date)).toBe(true);
  });
});
