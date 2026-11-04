'use strict';

// services/email-resubscribe.js (GATE_PORTAL_EMAIL_RESUBSCRIBE): the SendGrid
// pre-clear (runs BEFORE the route's transaction) and the local release that
// follows it. Which rows are releasable is proven on real SQL in
// email-resubscribe-postgres.test.js.

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../utils/email-equivalence', () => ({ suppressionCoversEmail: jest.fn(() => function covers() {}) }));
jest.mock('../utils/customer-comms-lock', () => ({ lockCustomerEmail: jest.fn(() => Promise.resolve()) }));

const db = require('../models/db');
const logger = require('../services/logger');
const { lockCustomerEmail } = require('../utils/customer-comms-lock');
const { releaseOwnUnsubscribes, clearSendgridBeforeRelease } = require('../services/email-resubscribe');

// A thenable query builder: a select resolves to `selectRows`; an update
// records its patch and resolves (via returning) to the row it targeted.
function fakeDbh({ selectRows = [] } = {}) {
  const updates = [];
  const dbh = jest.fn(() => {
    const b = {};
    let target = null;
    ['whereIn', 'whereRaw', 'orderBy'].forEach((m) => { b[m] = () => b; });
    b.where = (arg) => { if (arg && arg.id) target = arg.id; return b; };
    b.then = (resolve, reject) => Promise.resolve(selectRows).then(resolve, reject);
    b.update = (patch) => {
      updates.push({ id: target, patch });
      return { returning: async () => [{ ...selectRows.find((r) => r.id === target), status: 'released' }] };
    };
    return b;
  });
  dbh.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
  dbh.updates = updates;
  return dbh;
}
const metaOf = (dbh, i = 0) => JSON.parse(dbh.raw.mock.calls[i][1][0]);

describe('releaseOwnUnsubscribes', () => {
  const ROWS = [
    { id: 'a', email: 'pat@example.com', group_key: null },
    { id: 'b', email: 'pat@example.com', group_key: 'service_operational' },
  ];
  const AT = '2026-11-04T12:00:00.000Z';

  test('releases only the ids SendGrid confirmed, with the stamps, the clear note in the SAME update, and the address lock', async () => {
    const dbh = fakeDbh({ selectRows: ROWS });
    const released = await releaseOwnUnsubscribes({
      email: ' Pat@Example.com ', customerId: 42, actor: 'contact', contactSlot: 2,
      onlyIds: ['a'], sendgridClear: { a: { ok: true, status: 204, at: AT } },
    }, { dbh });
    expect(lockCustomerEmail).toHaveBeenCalledWith(dbh, 'pat@example.com');
    expect(released.map((r) => r.id)).toEqual(['a']);
    expect(dbh.updates).toHaveLength(1);
    const { id, patch } = dbh.updates[0];
    expect(id).toBe('a');
    expect(patch).toMatchObject({ status: 'released', consent_source: 'portal_email_switch' });
    for (const key of ['released_at', 'updated_at', 'consent_timestamp']) expect(patch[key]).toBeInstanceOf(Date);
    expect(metaOf(dbh)).toEqual({
      released_via: 'portal_email_switch',
      release_reason: 'Customer turned Email messages on in the app',
      released_by: null,
      released_for_customer_id: '42',
      actor: 'contact',
      contact_slot: 2,
      sendgrid_clear: { ok: true, status: 204, at: AT },
    });
  });

  test('no onlyIds, no address, or nothing releasable: no lock and no write', async () => {
    const dbh = fakeDbh({ selectRows: ROWS });
    await expect(releaseOwnUnsubscribes({ email: 'pat@example.com', customerId: 1, actor: 'holder' }, { dbh })).resolves.toEqual([]);
    await expect(releaseOwnUnsubscribes({ email: '', customerId: 1, actor: 'holder', onlyIds: ['a'] }, { dbh })).resolves.toEqual([]);
    await expect(releaseOwnUnsubscribes({ email: 'pat@example.com', customerId: 1, actor: 'holder', onlyIds: ['zzz'] }, { dbh: fakeDbh() })).resolves.toEqual([]);
    expect(dbh.updates).toEqual([]);
  });
});

describe('releasableUnsubscribes query', () => {
  test('filters on the three customer-origin sources, the staff marker, the type and the groups', async () => {
    const { releasableUnsubscribes } = require('../services/email-resubscribe');
    const calls = [];
    const dbh = () => {
      const b = { then: (resolve) => Promise.resolve([]).then(resolve) };
      ['where', 'whereIn', 'whereRaw', 'orderBy'].forEach((m) => { b[m] = (...args) => { calls.push([m, ...args]); return b; }; });
      return b;
    };
    await releasableUnsubscribes('Pat@Example.com', { dbh });
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
      ['where', 'whereIn', 'whereRaw', 'orderBy'].forEach((m) => { b[m] = () => b; });
      b.then = (resolve, reject) => Promise.resolve(rows).then(resolve, reject);
      return b;
    });
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
      { id: 'g', email: 'pat+tag@example.com', group_key: null },
      { id: 's', email: 'Sam@Example.com', group_key: 'service_operational' },
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
    expect(out.outcomes).toEqual([{ list: 'global', ok: false, reason: 'socket hang up' }]);
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
    await expect(clearSendgridBeforeRelease('pat@example.com')).resolves.toEqual({ clearedIds: [], outcomes: [], clearById: {} });
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
