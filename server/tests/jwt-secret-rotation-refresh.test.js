// JWT_SECRET_PREVIOUS + the refresh exchange: a refresh token that verifies
// only under a retired secret is accepted only when its jti/familyId is already
// registered in the DB; a legacy-shaped (no jti) old-key token never migrates
// into a new family.
process.env.JWT_SECRET = 'refresh-current-secret-0123456789';

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const db = require('../models/db');
const { createRefreshSession, rotateRefreshSession } = require('../middleware/auth');

const OLD = 'refresh-retired-secret-abcdefghij';
const ago = (seconds) => Math.floor(Date.now() / 1000) - seconds;
const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');

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


function retiredRefresh(extra = {}) {
  return jwt.sign({
    customerId: customer.id, accountId: customer.account_id, type: 'refresh', iat: ago(90), ...extra,
  }, OLD, { expiresIn: '30d' });
}

function register(rows, token, { jti, familyId }) {
  rows.push({
    jti, family_id: familyId, customer_id: customer.id, account_id: customer.account_id,
    token_hash: sha(token), expires_at: new Date(Date.now() + 86400000), consumed_at: null, revoked_at: null,
    created_at: new Date(), updated_at: new Date(),
  });
}

describe('refresh exchange under JWT_SECRET_PREVIOUS', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.JWT_SECRET_PREVIOUS = OLD;
    process.env.JWT_SECRET_ROTATED_AT = new Date(Date.now() - 1000).toISOString();
  });
  afterAll(() => {
    delete process.env.JWT_SECRET_PREVIOUS;
    delete process.env.JWT_SECRET_ROTATED_AT;
  });

  test('a registered old-key refresh token (jti + family in the DB) rotates into the same family', async () => {
    const rows = installMemoryDb();
    const ids = { jti: crypto.randomUUID(), familyId: crypto.randomUUID() };
    const token = retiredRefresh(ids);
    register(rows, token, ids);
    const out = await rotateRefreshSession(token);
    expect(out.ok).toBe(true);
    expect(out.familyId).toBe(ids.familyId);
    // The replacement is signed with the CURRENT secret.
    expect(() => jwt.verify(out.refreshToken, process.env.JWT_SECRET)).not.toThrow();
  });

  test('an old-key token with an unregistered jti/family is refused and nothing is written', async () => {
    const rows = installMemoryDb();
    const out = await rotateRefreshSession(retiredRefresh({ jti: crypto.randomUUID(), familyId: crypto.randomUUID() }));
    expect(out).toMatchObject({ ok: false, code: 'INVALID_REFRESH_TOKEN' });
    expect(rows).toHaveLength(0);
  });

  test('an old-key legacy-shaped token (no jti/family) never migrates into a new family', async () => {
    const rows = installMemoryDb();
    const out = await rotateRefreshSession(retiredRefresh());
    expect(out).toMatchObject({ ok: false, code: 'INVALID_REFRESH_TOKEN' });
    expect(db.transaction).not.toHaveBeenCalled();
    expect(rows).toHaveLength(0);
  });

  test('a current-key legacy-shaped token keeps its one-time migration', async () => {
    const rows = installMemoryDb();
    const legacy = jwt.sign({ customerId: customer.id, accountId: customer.account_id, type: 'refresh' }, process.env.JWT_SECRET, { expiresIn: '30d' });
    const out = await rotateRefreshSession(legacy);
    expect(out.ok).toBe(true);
    expect(rows.length).toBeGreaterThan(0);
  });

  test('without JWT_SECRET_ROTATED_AT the old-key token is refused even when registered', async () => {
    delete process.env.JWT_SECRET_ROTATED_AT;
    const rows = installMemoryDb();
    const ids = { jti: crypto.randomUUID(), familyId: crypto.randomUUID() };
    const token = retiredRefresh(ids);
    register(rows, token, ids);
    expect(await rotateRefreshSession(token)).toMatchObject({ ok: false, code: 'INVALID_REFRESH_TOKEN' });
  });

  test('current-key sessions are unaffected', async () => {
    installMemoryDb();
    const session = await createRefreshSession(customer.id, customer.account_id);
    expect((await rotateRefreshSession(session.refreshToken)).ok).toBe(true);
  });
});
