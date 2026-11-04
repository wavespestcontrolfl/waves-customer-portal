'use strict';

// services/email-resubscribe.js (GATE_PORTAL_EMAIL_RESUBSCRIBE): the stamps a
// release writes and the best-effort SendGrid clear. Which rows are releasable
// is proven on real SQL in email-resubscribe-postgres.test.js.

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../utils/email-equivalence', () => ({ suppressionCoversEmail: jest.fn(() => function covers() {}) }));
jest.mock('../utils/customer-comms-lock', () => ({ lockCustomerEmail: jest.fn(() => Promise.resolve()) }));

const db = require('../models/db');
const logger = require('../services/logger');
const { lockCustomerEmail } = require('../utils/customer-comms-lock');
const { releaseOwnUnsubscribes, clearSendgridUnsubscribes } = require('../services/email-resubscribe');

// A thenable query builder: a select resolves to `selectRows`; an update
// records its patch and resolves (via returning) to the matching rows.
function fakeDbh({ selectRows = [] } = {}) {
  const updates = [];
  const dbh = jest.fn(() => {
    const b = {};
    ['where', 'whereIn', 'orderBy'].forEach((m) => { b[m] = () => b; });
    b.then = (resolve, reject) => Promise.resolve(selectRows).then(resolve, reject);
    b.update = (patch) => {
      updates.push(patch);
      return { returning: async () => [{ ...selectRows[updates.length - 1], status: 'released' }] };
    };
    return b;
  });
  dbh.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
  dbh.updates = updates;
  return dbh;
}

describe('releaseOwnUnsubscribes', () => {
  test('stamps the release, merges the metadata and takes the per-address lock', async () => {
    const dbh = fakeDbh({ selectRows: [{ id: 'a', email: 'pat@example.com', group_key: null }] });
    const released = await releaseOwnUnsubscribes({ email: ' Pat@Example.com ', customerId: 42, actor: 'contact', contactSlot: 2 }, { dbh });
    expect(lockCustomerEmail).toHaveBeenCalledWith(dbh, 'pat@example.com');
    expect(released).toHaveLength(1);
    const [patch] = dbh.updates;
    expect(patch).toMatchObject({ status: 'released', consent_source: 'portal_email_switch' });
    expect(patch.released_at).toBeInstanceOf(Date);
    expect(patch.updated_at).toBeInstanceOf(Date);
    expect(patch.consent_timestamp).toBeInstanceOf(Date);
    const [, bindings] = dbh.raw.mock.calls[0];
    expect(JSON.parse(bindings[0])).toEqual({
      released_via: 'portal_email_switch',
      release_reason: 'Customer turned Email messages on in the app',
      released_by: null,
      released_for_customer_id: '42',
      actor: 'contact',
      contact_slot: 2,
    });
  });

  test('no address, or nothing releasable: no write', async () => {
    const dbh = fakeDbh();
    await expect(releaseOwnUnsubscribes({ email: '', customerId: 1, actor: 'holder' }, { dbh })).resolves.toEqual([]);
    await expect(releaseOwnUnsubscribes({ email: 'x@example.com', customerId: 1, actor: 'holder' }, { dbh })).resolves.toEqual([]);
    expect(dbh.updates).toEqual([]);
  });
});

describe('clearSendgridUnsubscribes', () => {
  let noted;
  beforeEach(() => {
    process.env.SENDGRID_API_KEY = 'SG.test';
    process.env.SENDGRID_ASM_GROUP_SERVICE = '777';
    global.fetch = jest.fn(async () => ({ ok: true, status: 204 }));
    noted = [];
    db.mockImplementation(() => ({
      whereIn: (_col, ids) => ({ update: async (patch) => { noted.push({ ids, patch }); return ids.length; } }),
    }));
    db.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
    logger.warn.mockClear();
  });
  afterEach(() => {
    delete process.env.SENDGRID_API_KEY;
    delete process.env.SENDGRID_ASM_GROUP_SERVICE;
    delete global.fetch;
  });
  const noteOf = (i = 0) => JSON.parse(db.raw.mock.calls[i][1][0]).sendgrid_clear;

  test('a global row clears the global list, a service row clears the service group (address URL-encoded, as stored)', async () => {
    await clearSendgridUnsubscribes([
      { id: 'g', email: 'pat+tag@example.com', group_key: null },
      { id: 's', email: 'Sam@Example.com', group_key: 'service_operational' },
    ]);
    const calls = global.fetch.mock.calls.map(([url, init]) => [init.method, url]);
    expect(calls).toEqual([
      ['DELETE', 'https://api.sendgrid.com/v3/asm/suppressions/global/pat%2Btag%40example.com'],
      ['DELETE', 'https://api.sendgrid.com/v3/asm/groups/777/suppressions/Sam%40Example.com'],
    ]);
    expect(global.fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer SG.test');
    expect(global.fetch.mock.calls[0][1].signal).toBeDefined();
    expect(noted.map((n) => n.ids)).toEqual([['g'], ['s']]);
    expect(noteOf(0)).toMatchObject({ ok: true, status: 204 });
    expect(noteOf(0).at).toEqual(expect.any(String));
  });

  test('an address with both a global and a service row clears both lists once each', async () => {
    await clearSendgridUnsubscribes([
      { id: 'g', email: 'pat@example.com', group_key: null },
      { id: 's', email: 'pat@example.com', group_key: 'service_operational' },
    ]);
    expect(global.fetch.mock.calls.map(([url]) => url)).toEqual([
      'https://api.sendgrid.com/v3/asm/suppressions/global/pat%40example.com',
      'https://api.sendgrid.com/v3/asm/groups/777/suppressions/pat%40example.com',
    ]);
    expect(noted).toHaveLength(1);
    expect(noted[0].ids).toEqual(['g', 's']);
  });

  test('404 (address not on the list) counts as cleared', async () => {
    global.fetch = jest.fn(async () => ({ ok: false, status: 404 }));
    await clearSendgridUnsubscribes([{ id: 'g', email: 'pat@example.com', group_key: null }]);
    expect(noteOf()).toMatchObject({ ok: true, status: 404 });
  });

  test('an HTTP failure or a thrown error is logged and noted, and never throws', async () => {
    global.fetch = jest.fn(async () => ({ ok: false, status: 500 }));
    await expect(clearSendgridUnsubscribes([{ id: 'g', email: 'pat@example.com', group_key: null }])).resolves.toBeDefined();
    expect(noteOf(0)).toMatchObject({ ok: false, status: 500 });
    global.fetch = jest.fn(async () => { throw new Error('socket hang up'); });
    await expect(clearSendgridUnsubscribes([{ id: 'g', email: 'pat@example.com', group_key: null }])).resolves.toBeDefined();
    expect(noteOf(1)).toMatchObject({ ok: false, reason: 'socket hang up' });
    expect(logger.warn).toHaveBeenCalled();
  });

  test('a failing note write does not throw either', async () => {
    db.mockImplementation(() => ({ whereIn: () => ({ update: async () => { throw new Error('db down'); } }) }));
    await expect(clearSendgridUnsubscribes([{ id: 'g', email: 'pat@example.com', group_key: null }])).resolves.toBeDefined();
  });

  test('no SENDGRID_API_KEY: no request is made and the skip is noted', async () => {
    delete process.env.SENDGRID_API_KEY;
    await clearSendgridUnsubscribes([{ id: 'g', email: 'pat@example.com', group_key: null }]);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(noteOf()).toMatchObject({ ok: false, reason: 'no_api_key' });
  });

  test('a service row without SENDGRID_ASM_GROUP_SERVICE makes no request', async () => {
    delete process.env.SENDGRID_ASM_GROUP_SERVICE;
    await clearSendgridUnsubscribes([{ id: 's', email: 'pat@example.com', group_key: 'service_operational' }]);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(noteOf()).toMatchObject({ ok: false, reason: 'service_group_not_configured' });
  });

  test('nothing released: nothing to do', async () => {
    await expect(clearSendgridUnsubscribes([])).resolves.toEqual([]);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
