'use strict';

// services/email-resubscribe.js (GATE_PORTAL_EMAIL_RESUBSCRIBE): the SendGrid
// pre-clear (runs BEFORE the release transaction), the local release that
// follows it, and the token and mask helpers. Which rows are releasable, the
// 24 h limit and the click are proven on real SQL in email-resubscribe-postgres.test.js.

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../utils/email-equivalence', () => ({ suppressionCoversEmail: jest.fn(() => function covers() {}) }));
jest.mock('../utils/customer-comms-lock', () => ({ lockCustomerEmail: jest.fn(() => Promise.resolve()) }));
jest.mock('../services/email-resubscribe-confirm', () => ({ sendResubscribeConfirmation: jest.fn() }));

const db = require('../models/db');
const logger = require('../services/logger');
const { lockCustomerEmail } = require('../utils/customer-comms-lock');
const {
  releaseOwnUnsubscribes, clearSendgridBeforeRelease, maskEmail, hashToken, isTokenShape,
} = require('../services/email-resubscribe');

// A thenable query builder: a select resolves to `selectRows`; an update
// records its patch and resolves (via returning) to the row it targeted.
function fakeDbh({ selectRows = [] } = {}) {
  const updates = [];
  const guards = [];
  const dbh = jest.fn(() => {
    const b = {};
    let target = null;
    ['whereIn', 'orderBy', 'select'].forEach((m) => { b[m] = () => b; });
    b.where = (arg) => { if (arg && arg.id) target = arg.id; return b; };
    b.whereRaw = (sql, bindings) => { if (sql.startsWith('xmin')) guards.push({ id: target, sql, bindings }); return b; };
    b.then = (resolve, reject) => Promise.resolve(selectRows).then(resolve, reject);
    b.update = (patch) => {
      updates.push({ id: target, patch });
      return { returning: async () => [{ ...selectRows.find((r) => r.id === target), status: 'released' }] };
    };
    return b;
  });
  dbh.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
  dbh.updates = updates;
  dbh.guards = guards;
  return dbh;
}
const metaOf = (dbh, i = 0) => JSON.parse(dbh.raw.mock.calls.filter(([, bindings]) => bindings)[i][1][0]);

describe('releaseOwnUnsubscribes', () => {
  const ROWS = [
    { id: 'a', email: 'pat@example.com', group_key: null, row_version: '100' },
    { id: 'b', email: 'pat@example.com', group_key: 'service_operational', row_version: '101' },
  ];
  const AT = '2026-11-04T12:00:00.000Z';

  test('releases only the ids SendGrid confirmed, with the stamps, the clear note in the SAME update, and the address lock', async () => {
    const dbh = fakeDbh({ selectRows: ROWS });
    const released = await releaseOwnUnsubscribes({
      email: ' Pat@Example.com ', customerId: 42, requestId: 'req-1',
      onlyIds: ['a'], versionById: { a: '100' }, sendgridClear: { a: { ok: true, status: 204, at: AT } },
    }, { dbh });
    expect(lockCustomerEmail).toHaveBeenCalledWith(dbh, 'pat@example.com');
    expect(released.map((r) => r.id)).toEqual(['a']);
    expect(dbh.updates).toHaveLength(1);
    const { id, patch } = dbh.updates[0];
    expect(id).toBe('a');
    expect(dbh.guards).toEqual([{ id: 'a', sql: 'xmin::text = ?', bindings: ['100'] }]);
    expect(patch).toMatchObject({ status: 'released', consent_source: 'email_confirm_link' });
    for (const key of ['released_at', 'updated_at', 'consent_timestamp']) expect(patch[key]).toBeInstanceOf(Date);
    expect(metaOf(dbh)).toEqual({
      released_via: 'email_confirm_link',
      release_reason: 'Customer confirmed by email link',
      released_by: null,
      released_for_customer_id: '42',
      request_id: 'req-1',
      sendgrid_clear: { ok: true, status: 204, at: AT },
    });
  });

  test('a row updated since the pre-read (version changed, or none captured) is not released', async () => {
    const dbh = fakeDbh({ selectRows: ROWS });
    await expect(releaseOwnUnsubscribes({
      email: 'pat@example.com', customerId: 1, onlyIds: ['a', 'b'], versionById: { a: '99' },
    }, { dbh })).resolves.toEqual([]);
    expect(dbh.updates).toEqual([]);
  });

  test('no onlyIds, no address, or nothing releasable: no lock and no write', async () => {
    const dbh = fakeDbh({ selectRows: ROWS });
    await expect(releaseOwnUnsubscribes({ email: 'pat@example.com', customerId: 1 }, { dbh })).resolves.toEqual([]);
    await expect(releaseOwnUnsubscribes({ email: '', customerId: 1, onlyIds: ['a'] }, { dbh })).resolves.toEqual([]);
    await expect(releaseOwnUnsubscribes({ email: 'pat@example.com', customerId: 1, onlyIds: ['zzz'] }, { dbh: fakeDbh() })).resolves.toEqual([]);
    expect(dbh.updates).toEqual([]);
  });
});

describe('error text never reaches logs or stored notes', () => {
  const SECRET = 'pat.private@example.com';
  const logged = () => JSON.stringify([logger.warn, logger.error, logger.info].map((fn) => fn.mock.calls));

  beforeEach(() => { [logger.warn, logger.error, logger.info].forEach((fn) => fn.mockClear()); });

  test('a DB error carrying the address in its message is logged by code or name only (lookup and pre-clear)', async () => {
    const { resubscribeStatus } = require('../services/email-resubscribe');
    const boom = () => { const err = new Error(`select * from email_suppressions where LOWER(email) = '${SECRET}' - relation missing`); err.code = '42P01'; throw err; };
    db.mockImplementation(boom);
    await expect(resubscribeStatus(SECRET)).resolves.toBeNull();
    await clearSendgridBeforeRelease(SECRET);
    expect(logged()).not.toContain(SECRET);
    expect(logged()).toContain('42P01');
  });

  test('a fetch error carrying the URL or address is stored as its name only, and not logged', async () => {
    process.env.SENDGRID_API_KEY = 'SG.test';
    const rows = [{ id: 'g', email: SECRET, group_key: null, row_version: '1' }];
    db.mockImplementation(() => {
      const b = { then: (resolve) => Promise.resolve(rows).then(resolve) };
      ['where', 'whereIn', 'whereRaw', 'orderBy', 'select'].forEach((m) => { b[m] = () => b; });
      return b;
    });
    db.raw = (sql) => ({ sql });
    global.fetch = jest.fn(async () => { throw new TypeError(`fetch failed for https://api.sendgrid.com/v3/asm/suppressions/global/${SECRET}`); });
    const out = await clearSendgridBeforeRelease(SECRET);
    delete global.fetch;
    delete process.env.SENDGRID_API_KEY;
    expect(JSON.stringify(out)).not.toContain(SECRET);
    expect(out.outcomes).toEqual([{ list: 'global', ok: false, reason: 'TypeError' }]);
    expect(logged()).not.toContain(SECRET);
  });
});

describe('token and mask helpers', () => {
  test('maskEmail keeps the first letter and the domain only', () => {
    expect(maskEmail(' Tom.Smith@Gmail.com ')).toBe('t***@gmail.com');
    expect(maskEmail('a@b.co')).toBe('a***@b.co');
    expect(maskEmail('')).toBe('');
    expect(maskEmail('not-an-address')).toBe('');
  });

  test('hashToken is sha256 hex and never the token; only 43-character base64url tokens pass the shape gate', () => {
    const token = require('crypto').randomBytes(32).toString('base64url');
    expect(token).toHaveLength(43);
    expect(hashToken(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(token)).not.toContain(token);
    expect(hashToken(token)).toBe(require('crypto').createHash('sha256').update(token).digest('hex'));
    expect(isTokenShape(token)).toBe(true);
    for (const bad of ['', 'abc', `${token}x`, `${token.slice(0, 42)}!`, undefined, null, 42, {}]) expect(isTokenShape(bad)).toBe(false);
  });
});

describe('releasableUnsubscribes query', () => {
  test('filters on the three customer-origin sources, the staff marker, the type and the groups', async () => {
    const { releasableUnsubscribes } = require('../services/email-resubscribe');
    const calls = [];
    const dbh = () => {
      const b = { then: (resolve) => Promise.resolve([]).then(resolve) };
      ['where', 'whereIn', 'whereRaw', 'orderBy', 'select'].forEach((m) => { b[m] = (...args) => { calls.push([m, ...args]); return b; }; });
      return b;
    };
    dbh.raw = (sql) => ({ sql });
    await releasableUnsubscribes('Pat@Example.com', { dbh });
    expect(calls).toContainEqual(['select', 'email_suppressions.*', { sql: 'xmin::text AS row_version' }]);
    expect(calls).toContainEqual(['where', { status: 'active', suppression_type: 'unsubscribe' }]);
    expect(calls).toContainEqual(['whereIn', 'source', ['sendgrid_event_webhook', 'sendgrid_asm_backfill', 'sendgrid_dropped_backfill_2026_06_01']]);
    const raw = calls.find(([m]) => m === 'whereRaw');
    expect(raw[1]).toBe("(COALESCE(metadata, '{}'::jsonb) -> 'created_by') IS NULL");
    expect(raw[1]).not.toContain('?');
  });
});

describe('clearSendgridBeforeRelease', () => {
  let rows;
  beforeEach(() => {
    process.env.SENDGRID_API_KEY = 'SG.test';
    process.env.SENDGRID_ASM_GROUP_SERVICE = '777';
    global.fetch = jest.fn(async () => ({ ok: true, status: 204 }));
    rows = [];
    db.mockImplementation(() => {
      const b = {};
      ['where', 'whereIn', 'whereRaw', 'orderBy', 'select'].forEach((m) => { b[m] = () => b; });
      b.then = (resolve, reject) => Promise.resolve(rows).then(resolve, reject);
      return b;
    });
    db.raw = (sql) => ({ sql });
    logger.warn.mockClear();
  });
  afterEach(() => {
    delete process.env.SENDGRID_API_KEY;
    delete process.env.SENDGRID_ASM_GROUP_SERVICE;
    delete global.fetch;
  });
  const urls = () => global.fetch.mock.calls.map(([url]) => url);

  test('a global row clears the global list and a service row the service group (address URL-encoded, as stored); both ids are cleared', async () => {
    rows = [
      { id: 'g', email: 'pat+tag@example.com', group_key: null, row_version: '10' },
      { id: 's', email: 'Sam@Example.com', group_key: 'service_operational', row_version: '11' },
    ];
    const out = await clearSendgridBeforeRelease('anything@example.com');
    expect(global.fetch.mock.calls.map(([url, init]) => [init.method, url])).toEqual([
      ['DELETE', 'https://api.sendgrid.com/v3/asm/suppressions/global/pat%2Btag%40example.com'],
      ['DELETE', 'https://api.sendgrid.com/v3/asm/groups/777/suppressions/Sam%40Example.com'],
    ]);
    expect(global.fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer SG.test');
    expect(global.fetch.mock.calls[0][1].signal).toBeDefined();
    expect(out.clearedIds.sort()).toEqual(['g', 's']);
    expect(out.clearById.g).toMatchObject({ ok: true, status: 204, at: expect.any(String) });
    expect(out.versionById).toEqual({ g: '10', s: '11' });
  });

  test('global and service DELETEs for one address run in parallel (both started before either settles)', async () => {
    rows = [
      { id: 'g', email: 'pat@example.com', group_key: null },
      { id: 's', email: 'pat@example.com', group_key: 'service_operational' },
    ];
    const releases = [];
    global.fetch = jest.fn(() => new Promise((resolve) => { releases.push(() => resolve({ ok: true, status: 204 })); }));
    const pending = clearSendgridBeforeRelease('pat@example.com');
    await new Promise((resolve) => setImmediate(resolve));
    expect(global.fetch).toHaveBeenCalledTimes(2);
    releases.forEach((release) => release());
    expect((await pending).clearedIds.sort()).toEqual(['g', 's']);
  });

  test('404 (address not on the list) counts as cleared', async () => {
    rows = [{ id: 'g', email: 'pat@example.com', group_key: null }];
    global.fetch = jest.fn(async () => ({ ok: false, status: 404 }));
    const out = await clearSendgridBeforeRelease('pat@example.com');
    expect(out.clearedIds).toEqual(['g']);
    expect(out.clearById.g).toMatchObject({ ok: true, status: 404 });
  });

  test('an HTTP error or a thrown error leaves the rows out, logs, and never throws', async () => {
    rows = [{ id: 'g', email: 'pat@example.com', group_key: null }];
    global.fetch = jest.fn(async () => ({ ok: false, status: 500 }));
    expect((await clearSendgridBeforeRelease('pat@example.com')).clearedIds).toEqual([]);
    global.fetch = jest.fn(async () => { throw new Error('socket hang up'); });
    const out = await clearSendgridBeforeRelease('pat@example.com');
    expect(out.clearedIds).toEqual([]);
    expect(out.outcomes).toEqual([{ list: 'global', ok: false, reason: 'Error' }]);
    expect(logger.warn).toHaveBeenCalled();
  });

  test('partial: the global list clears but the service list fails, so only the global row is cleared', async () => {
    rows = [
      { id: 'g', email: 'pat@example.com', group_key: null },
      { id: 's', email: 'pat@example.com', group_key: 'service_operational' },
    ];
    global.fetch = jest.fn(async (url) => (url.includes('/groups/') ? { ok: false, status: 500 } : { ok: true, status: 204 }));
    expect((await clearSendgridBeforeRelease('pat@example.com')).clearedIds).toEqual(['g']);
  });

  test('a failing row read never throws', async () => {
    db.mockImplementation(() => { throw new Error('db down'); });
    await expect(clearSendgridBeforeRelease('pat@example.com')).resolves.toEqual({ clearedIds: [], outcomes: [], clearById: {}, versionById: {} });
  });

  test('no SENDGRID_API_KEY: no request, nothing cleared', async () => {
    delete process.env.SENDGRID_API_KEY;
    rows = [{ id: 'g', email: 'pat@example.com', group_key: null }];
    const out = await clearSendgridBeforeRelease('pat@example.com');
    expect(global.fetch).not.toHaveBeenCalled();
    expect(out.clearedIds).toEqual([]);
    expect(out.outcomes).toEqual([{ list: 'global', ok: false, reason: 'no_api_key' }]);
  });

  test('a service row without SENDGRID_ASM_GROUP_SERVICE makes no request and is not cleared; a global row beside it still is', async () => {
    delete process.env.SENDGRID_ASM_GROUP_SERVICE;
    rows = [
      { id: 'g', email: 'pat@example.com', group_key: null },
      { id: 's', email: 'pat@example.com', group_key: 'service_operational' },
    ];
    const out = await clearSendgridBeforeRelease('pat@example.com');
    expect(urls()).toEqual(['https://api.sendgrid.com/v3/asm/suppressions/global/pat%40example.com']);
    expect(out.clearedIds).toEqual(['g']);
    expect(out.outcomes).toContainEqual({ list: 'service', ok: false, reason: 'service_group_not_configured' });
  });

  test('nothing releasable: no request', async () => {
    const out = await clearSendgridBeforeRelease('pat@example.com');
    expect(global.fetch).not.toHaveBeenCalled();
    expect(out.clearedIds).toEqual([]);
  });
});

describe('requestResubscribeEmail: the send claim is durable, the handoff re-checks hard blocks', () => {
  const { requestResubscribeEmail } = require('../services/email-resubscribe');
  const { sendResubscribeConfirmation } = require('../services/email-resubscribe-confirm');
  const { lockCustomerEmail } = require('../utils/customer-comms-lock');

  // Records ordering across the two transactions. `state.hardBlock` = a do_not_email row exists
  // (the test flips it at the moment it wants the block to "appear").
  function claimDbh() {
    const events = [];
    const writes = [];
    const state = { hardBlock: false, claimed: false };
    const makeTable = (name) => {
      const b = new Proxy({}, {
        get: (_t, method) => {
          if (method === 'then') return (resolve) => Promise.resolve(name === 'email_suppressions' ? [{ id: 'sup-1' }] : []).then(resolve);
          return (...args) => {
            if (method === 'first') {
              if (name === 'email_suppressions') return Promise.resolve(state.hardBlock ? { id: 'block-1' } : undefined);
              return Promise.resolve(state.claimed ? { id: 'req-1', sent_at: NOW, used_at: null } : undefined);
            }
            if (method === 'insert') { events.push('claim-insert'); state.claimed = true; writes.push({ insert: args[0] }); return { returning: async () => [{ id: 'req-1' }] }; }
            if (method === 'update') { events.push('settle'); writes.push({ update: args[0] }); return Promise.resolve(1); }
            if (method === 'forUpdate' && name === 'email_resubscribe_requests') events.push('row-lock');
            return b;
          };
        },
      });
      return b;
    };
    const dbh = jest.fn((name) => makeTable(name));
    dbh.raw = (sql) => ({ sql });
    let n = 0;
    dbh.transaction = async (fn) => {
      n += 1;
      const label = `tx${n}`;
      const trx = jest.fn((name) => makeTable(name));
      trx.raw = dbh.raw;
      trx.label = label;
      events.push(`${label}-start`);
      const out = await fn(trx);
      events.push(`${label}-end`);
      return out;
    };
    return { dbh, events, writes, state };
  }
  const NOW = new Date('2026-11-04T15:00:00.000Z');
  const ask = (dbh) => requestResubscribeEmail({ customerId: 'c-1', email: 'Pat@Example.com', firstName: 'Pat' }, { dbh, now: NOW });

  beforeEach(() => { sendResubscribeConfirmation.mockReset(); lockCustomerEmail.mockClear(); logger.warn.mockClear(); });

  test('tx1 inserts the claim (sent_at = now, send_claimed) and COMMITS before tx2 locks the address and sends; the sender gets tx2 and a boundary check', async () => {
    const { dbh, events, writes } = claimDbh();
    lockCustomerEmail.mockImplementation(async (trx) => { events.push(`lock-${trx.label}`); });
    sendResubscribeConfirmation.mockImplementation(async (args) => { events.push('send'); expect(args.database.label).toBe('tx2'); expect(typeof args.providerBoundaryCheck).toBe('function'); return {}; });
    const out = await ask(dbh);
    expect(events).toEqual(['tx1-start', 'lock-tx1', 'claim-insert', 'tx1-end', 'tx2-start', 'row-lock', 'lock-tx2', 'send', 'settle', 'tx2-end']);
    expect(writes[0].insert).toMatchObject({ email: 'pat@example.com', sent_at: NOW, outcome: JSON.stringify({ send_claimed: true }) });
    expect(writes[1].update).toMatchObject({ outcome: JSON.stringify({ sent: true }) });
    expect(out).toEqual({ state: 'sent', maskedEmail: 'p***@example.com', sentAt: NOW.toISOString() });
    lockCustomerEmail.mockImplementation(() => Promise.resolve());
  });

  test('a do_not_email that appears after the claim commits but before the send: no send, claim undone, not_paused', async () => {
    const { dbh, writes, state } = claimDbh();
    // The block lands between tx1 and tx2: the first lock call of tx2 is when it becomes visible.
    let locks = 0;
    lockCustomerEmail.mockImplementation(async () => { locks += 1; if (locks === 2) state.hardBlock = true; });
    expect(await ask(dbh)).toEqual({ state: 'not_paused' });
    expect(sendResubscribeConfirmation).not.toHaveBeenCalled();
    expect(writes[1].update).toMatchObject({ sent_at: null, outcome: JSON.stringify({ send_refused: 'hard_block' }) });
    lockCustomerEmail.mockImplementation(() => Promise.resolve());
  });

  test('a hard block that appears inside providerBoundaryCheck refuses the send (tagged providerBoundaryBlocked): claim undone, not_paused', async () => {
    const { dbh, writes, state } = claimDbh();
    sendResubscribeConfirmation.mockImplementation(async ({ providerBoundaryCheck }) => {
      expect(await providerBoundaryCheck()).toEqual({ ok: true });
      state.hardBlock = true; // lands right before the fetch
      await providerBoundaryCheck();
      throw new Error('fetch must not be reached');
    });
    expect(await ask(dbh)).toEqual({ state: 'not_paused' });
    expect(writes[1].update).toMatchObject({ sent_at: null, outcome: JSON.stringify({ send_refused: 'hard_block' }) });
    // The refusal is a definite no-send, not a logged send failure.
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('outcome uncertain');
  });

  test('HTTP 4xx rejection: sent_at is cleared and the word recorded; the answer is failed', async () => {
    const { dbh, writes } = claimDbh();
    sendResubscribeConfirmation.mockRejectedValue(Object.assign(new Error('SendGrid 400: pat@example.com'), { status: 400 }));
    expect(await ask(dbh)).toEqual({ state: 'failed' });
    expect(writes[1].update).toMatchObject({ sent_at: null, outcome: JSON.stringify({ send_failed: 'http_400' }) });
    expect(JSON.stringify([logger.warn.mock.calls, writes[1]])).not.toContain('pat@example.com');
  });

  test.each([
    ['a timeout', Object.assign(new Error('x'), { name: 'TimeoutError' })],
    ['a 502', Object.assign(new Error('x'), { status: 502 })],
    ['no status', new Error('socket hang up')],
  ])('%s: the claim stays (no sent_at write) and the answer is sent', async (_name, error) => {
    const { dbh, writes } = claimDbh();
    sendResubscribeConfirmation.mockRejectedValue(error);
    expect(await ask(dbh)).toMatchObject({ state: 'sent', sentAt: NOW.toISOString() });
    expect(writes[1].update).not.toHaveProperty('sent_at');
    expect(JSON.parse(writes[1].update.outcome)).toHaveProperty('send_uncertain');
  });
});
