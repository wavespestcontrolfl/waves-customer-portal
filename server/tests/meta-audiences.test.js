// Tests services/ads/meta-audiences.js — Meta Custom Audiences sync (suppression + retargeting).

let tableData = {};   // { customers: [...], leads: [...] } returned by .select()
let stateRow = null;  // ad_audience_syncs .first()
const inserts = [];

const mockDb = jest.fn((table) => {
  const b = {};
  ['where', 'whereNull', 'whereNotNull', 'orWhereNotNull', 'whereIn', 'whereRaw', 'andWhere', 'whereNotExists'].forEach((m) => {
    b[m] = jest.fn(() => b);
  });
  b.select = jest.fn(() => Promise.resolve(tableData[table] || []));
  b.first = jest.fn(() => Promise.resolve(table === 'ad_audience_syncs' ? stateRow : null));
  b.insert = jest.fn((row) => {
    inserts.push({ table, row });
    return { onConflict: jest.fn(() => ({ merge: jest.fn(() => Promise.resolve(1)) })) };
  });
  return b;
});
mockDb.fn = { now: () => 'NOW()' };

jest.mock('../models/db', () => mockDb);
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../utils/cron-lock', () => ({ runExclusive: (_n, fn) => fn() }));
jest.mock('../services/ads/data-manager', () => ({
  _private: {
    sha256Hex: (s) => `h:${s}`,
    normalizeEmail: (e) => (e && String(e).includes('@') ? String(e).trim().toLowerCase() : null),
    normalizePhone: (p) => {
      const d = String(p || '').replace(/\D/g, '');
      if (d.length === 10) return `+1${d}`;
      if (d.length === 11 && d[0] === '1') return `+${d}`;
      return null;
    },
  },
}));

const MetaAudiences = require('../services/ads/meta-audiences');
const { hashMember, collectCustomerMembers, collectUnbookedLeadMembers } = MetaAudiences._private;

const ENV = { ...process.env };
beforeEach(() => {
  tableData = {};
  stateRow = null;
  inserts.length = 0;
  process.env = { ...ENV };
  delete process.env.META_AUDIENCES_ACCESS_TOKEN;
  delete process.env.META_AUDIENCES_ALLOW_UPLOADS;
  delete process.env.META_ADS_ACCOUNT_ID;
  global.fetch = jest.fn();
});
afterAll(() => { process.env = ENV; });

function configure({ allow = false } = {}) {
  process.env.META_ADS_ACCOUNT_ID = '1481633672581509';
  process.env.META_AUDIENCES_ACCESS_TOKEN = 'EAA-mgmt-token';
  if (allow) process.env.META_AUDIENCES_ALLOW_UPLOADS = 'true';
}

function okFetch(json = { id: 'AUD123' }) {
  return jest.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve(json) }));
}

describe('config', () => {
  test('isConfigured is false until token + account id present', () => {
    expect(MetaAudiences.isConfigured()).toBe(false);
    configure();
    expect(MetaAudiences.isConfigured()).toBe(true);
  });
});

describe('hashMember', () => {
  test('hashes email + phone (phone without +), aligned to schema', () => {
    expect(hashMember({ email: 'A@X.com', phone: '(941) 297-5749' })).toEqual(['h:a@x.com', 'h:19412975749']);
  });
  test('missing phone leaves an empty slot, not a hash', () => {
    expect(hashMember({ email: 'a@x.com', phone: null })).toEqual(['h:a@x.com', '']);
  });
  test('no usable identifiers → null (skipped)', () => {
    expect(hashMember({ email: 'not-an-email', phone: '123' })).toBeNull();
  });
});

describe('member collection', () => {
  test('customers → customer:<id> keys', async () => {
    tableData.customers = [{ id: 'c1', email: 'c1@x.com', phone: '9412975749' }];
    const m = await collectCustomerMembers();
    expect(m).toEqual([{ key: 'customer:c1', email: 'c1@x.com', phone: '9412975749' }]);
  });
  test('leads → lead:<id> keys', async () => {
    tableData.leads = [{ id: 'l1', email: 'l1@x.com', phone: null }];
    const m = await collectUnbookedLeadMembers();
    expect(m).toEqual([{ key: 'lead:l1', email: 'l1@x.com', phone: null }]);
  });
});

describe('syncAudience', () => {
  test('not configured → returns configured:false, no fetch', async () => {
    const r = await MetaAudiences.syncAudience('customers');
    expect(r.configured).toBe(false);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('dry run computes add/remove delta without calling Meta', async () => {
    configure(); // allow uploads NOT set → dry run
    tableData.customers = [
      { id: 'KEEP', email: 'keep@x.com', phone: '9412975749' },
      { id: 'NEW', email: 'new@x.com', phone: null },
    ];
    stateRow = {
      meta_audience_id: 'AUD123',
      member_keys: [
        { k: 'customer:OLD', d: ['h:old@x.com', ''] },
        { k: 'customer:KEEP', d: ['h:keep@x.com', 'h:19412975749'] },
      ],
    };
    const r = await MetaAudiences.syncAudience('customers', {});
    expect(r.dryRun).toBe(true);
    expect(r.eligible).toBe(2);
    expect(r.withMatchKeys).toBe(2);  // KEEP + NEW both have email
    expect(r.skippedNoKeys).toBe(0);
    expect(r.toAdd).toBe(1);          // NEW
    expect(r.toRemove).toBe(1);       // OLD (gone from current)
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('skips members with no usable keys and does NOT persist them (corrected later → uploads)', async () => {
    configure();
    tableData.customers = [
      { id: 'good', email: 'good@x.com', phone: null },
      { id: 'bad', email: 'not-an-email', phone: '123' }, // unusable
    ];
    const r = await MetaAudiences.syncAudience('customers', {});
    expect(r.eligible).toBe(2);
    expect(r.withMatchKeys).toBe(1);
    expect(r.skippedNoKeys).toBe(1);
    expect(r.toAdd).toBe(1); // only the good one is a member
  });

  test('removes a hard-deleted member using the stored hash (no DB re-read)', async () => {
    configure({ allow: true });
    global.fetch = okFetch({});
    tableData.leads = []; // the lead was hard-deleted — not returned by any query
    stateRow = { meta_audience_id: 'AUDX', member_keys: [{ k: 'lead:GONE', d: ['h:gone@x.com', ''] }] };
    const r = await MetaAudiences.syncAudience('unbooked_leads', {});
    expect(r.toRemove).toBe(1);
    expect(r.removed).toBe(1);
    const del = global.fetch.mock.calls.find((c) => c[1] && c[1].method === 'DELETE');
    expect(del).toBeTruthy();
    expect(JSON.parse(del[1].body).payload.data).toEqual([['h:gone@x.com', '']]);
  });

  test('re-syncs a changed identifier (same key, new hash): adds new + removes stale', async () => {
    configure({ allow: true });
    global.fetch = okFetch({ id: 'AUDX' });
    tableData.customers = [{ id: 'c1', email: 'new@x.com', phone: null }];
    stateRow = { meta_audience_id: 'AUDX', member_keys: [{ k: 'customer:c1', d: ['h:old@x.com', ''] }] };
    const r = await MetaAudiences.syncAudience('customers', {});
    expect(r.changed).toBe(1);
    expect(r.toAdd).toBe(1);
    expect(r.toRemove).toBe(1);
    expect(r.added).toBe(1);
    expect(r.removed).toBe(1);
    const post = global.fetch.mock.calls.find((c) => c[1].method === 'POST' && /\/users$/.test(c[0]));
    const del = global.fetch.mock.calls.find((c) => c[1] && c[1].method === 'DELETE');
    expect(JSON.parse(post[1].body).payload.data).toEqual([['h:new@x.com', '']]);
    expect(JSON.parse(del[1].body).payload.data).toEqual([['h:old@x.com', '']]);
  });

  test('partial change (shared email) adds the new row but does NOT delete the still-current one', async () => {
    configure({ allow: true });
    global.fetch = okFetch({ id: 'AUDX' });
    // email unchanged (a@x.com), phone changed → old row shares the current email hash
    tableData.customers = [{ id: 'c1', email: 'a@x.com', phone: '9412975749' }]; // -> ['h:a@x.com','h:19412975749']
    stateRow = { meta_audience_id: 'AUDX', member_keys: [{ k: 'customer:c1', d: ['h:a@x.com', 'h:OLD'] }] };
    const r = await MetaAudiences.syncAudience('customers', {});
    expect(r.changed).toBe(1);
    expect(r.toAdd).toBe(1);
    expect(r.toRemove).toBe(0); // must NOT delete — would remove the person by their unchanged email
    expect(r.removed).toBe(0);
    expect(global.fetch.mock.calls.some((c) => c[1] && c[1].method === 'DELETE')).toBe(false);
  });

  test('live run creates the audience and adds hashed users', async () => {
    configure({ allow: true });
    global.fetch = okFetch({ id: 'AUD123' });
    tableData.customers = [{ id: 'c1', email: 'c1@x.com', phone: '9412975749' }];
    stateRow = null; // no audience yet
    const r = await MetaAudiences.syncAudience('customers', {});
    expect(r.dryRun).toBe(false);
    expect(r.added).toBe(1);
    expect(r.audienceId).toBe('AUD123');
    // create call + users add call
    const urls = global.fetch.mock.calls.map((c) => c[0]);
    expect(urls.some((u) => /act_1481633672581509\/customaudiences$/.test(u))).toBe(true);
    expect(urls.some((u) => /AUD123\/users$/.test(u))).toBe(true);
    // users payload carries the hashed multi-key schema
    const usersCall = global.fetch.mock.calls.find((c) => /\/users$/.test(c[0]));
    const body = JSON.parse(usersCall[1].body);
    expect(body.payload.schema).toEqual(['EMAIL', 'PHONE']);
    expect(body.payload.data).toEqual([['h:c1@x.com', 'h:19412975749']]);
  });

  test('explicit validateOnly forces dry run even when uploads allowed', async () => {
    configure({ allow: true });
    tableData.customers = [{ id: 'c1', email: 'c1@x.com', phone: '9412975749' }];
    const r = await MetaAudiences.syncAudience('customers', { validateOnly: true });
    expect(r.dryRun).toBe(true);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe('buildReadiness', () => {
  test('reports eligible + match-key counts per audience', async () => {
    configure();
    tableData.customers = [
      { id: 'c1', email: 'c1@x.com', phone: '9412975749' },
      { id: 'c2', email: null, phone: 'bad' }, // no usable keys
    ];
    tableData.leads = [{ id: 'l1', email: 'l1@x.com', phone: null }];
    const r = await MetaAudiences.buildReadiness();
    expect(r.configured).toBe(true);
    expect(r.audiences.customers.eligible).toBe(2);
    expect(r.audiences.customers.withMatchKeys).toBe(1);
    expect(r.audiences.customers.missingMatchKeys).toBe(1);
    expect(r.audiences.unbooked_leads.eligible).toBe(1);
  });
});
