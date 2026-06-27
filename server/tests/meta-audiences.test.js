// Tests services/ads/meta-audiences.js — Meta Custom Audiences sync (suppression + retargeting).

let tableData = {};   // { customers: [...], leads: [...] } returned by .select()
let stateRow = null;  // ad_audience_syncs .first()
const inserts = [];

const mockDb = jest.fn((table) => {
  const b = {};
  ['where', 'whereNull', 'whereNotNull', 'orWhereNotNull', 'whereIn', 'whereRaw', 'andWhere'].forEach((m) => {
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
    stateRow = { meta_audience_id: 'AUD123', member_keys: ['customer:OLD', 'customer:KEEP'] };
    const r = await MetaAudiences.syncAudience('customers', {});
    expect(r.dryRun).toBe(true);
    expect(r.eligible).toBe(2);
    expect(r.toAdd).toBe(1);          // NEW
    expect(r.toRemove).toBe(1);       // OLD
    expect(r.addWithMatchKeys).toBe(1);
    expect(global.fetch).not.toHaveBeenCalled();
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
