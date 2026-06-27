// Tests services/ads/google-customer-match.js — Google Customer Match audience sync.

let stateRow = null;
const inserts = [];
const mockDb = jest.fn((table) => {
  const b = {};
  ['where', 'whereNull', 'whereNotNull', 'orWhereNotNull', 'whereIn', 'whereRaw', 'andWhere', 'whereNotExists'].forEach((m) => {
    b[m] = jest.fn(() => b);
  });
  b.select = jest.fn(() => Promise.resolve([]));
  b.first = jest.fn(() => Promise.resolve(table === 'ad_audience_syncs' ? stateRow : null));
  b.insert = jest.fn((row) => {
    inserts.push({ table, row });
    return { onConflict: jest.fn(() => ({ merge: jest.fn(() => Promise.resolve(1)) })) };
  });
  return b;
});
mockDb.fn = { now: () => 'NOW()' };

const mockCollectCustomers = jest.fn();
const mockCollectLeads = jest.fn();

jest.mock('../models/db', () => mockDb);
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../utils/cron-lock', () => ({ runExclusive: (_n, fn) => fn() }));
jest.mock('../services/ads/meta-audiences', () => ({
  _private: {
    collectCustomerMembers: (...a) => mockCollectCustomers(...a),
    collectUnbookedLeadMembers: (...a) => mockCollectLeads(...a),
    hashMember: (m) => {
      const email = m && m.email && String(m.email).includes('@') ? String(m.email).trim().toLowerCase() : null;
      const digits = String((m && m.phone) || '').replace(/\D/g, '');
      const phone = digits.length === 10 ? `1${digits}` : (digits.length === 11 && digits[0] === '1' ? digits : null);
      const e = email ? `h:${email}` : '';
      const p = phone ? `h:${phone}` : '';
      return (e || p) ? [e, p] : null;
    },
  },
}));
jest.mock('googleapis', () => ({
  google: { auth: { GoogleAuth: class { getClient() { return { getAccessToken: async () => ({ token: 'tok' }) }; } } } },
}));

const GCM = require('../services/ads/google-customer-match');
const { toUserData, destination } = GCM._private;

const ENV = { ...process.env };
beforeEach(() => {
  stateRow = null;
  inserts.length = 0;
  mockCollectCustomers.mockReset();
  mockCollectLeads.mockReset();
  process.env = { ...ENV };
  for (const k of ['GOOGLE_ADS_DATA_MANAGER_SERVICE_ACCOUNT_JSON', 'GOOGLE_SERVICE_ACCOUNT_JSON',
    'GOOGLE_ADS_DATA_MANAGER_CUSTOMER_ID', 'GOOGLE_ADS_CUSTOMER_ID', 'GOOGLE_ADS_DATA_MANAGER_LOGIN_CUSTOMER_ID',
    'GOOGLE_CM_CUSTOMERS_LIST_ID', 'GOOGLE_CM_UNBOOKED_LEADS_LIST_ID', 'GOOGLE_CUSTOMER_MATCH_ALLOW_UPLOADS']) {
    delete process.env[k];
  }
  global.fetch = jest.fn();
});
afterAll(() => { process.env = ENV; });

function configure({ allow = false, lists = true } = {}) {
  process.env.GOOGLE_ADS_DATA_MANAGER_SERVICE_ACCOUNT_JSON = JSON.stringify({ client_email: 'x@y.iam', private_key: 'k' });
  process.env.GOOGLE_ADS_DATA_MANAGER_CUSTOMER_ID = '3393936713';
  if (lists) { process.env.GOOGLE_CM_CUSTOMERS_LIST_ID = '111'; process.env.GOOGLE_CM_UNBOOKED_LEADS_LIST_ID = '222'; }
  if (allow) process.env.GOOGLE_CUSTOMER_MATCH_ALLOW_UPLOADS = 'true';
}
const okFetch = (json = {}) => jest.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve(json) }));

describe('config', () => {
  test('isConfigured needs service account + customer id + a list id', () => {
    expect(GCM.isConfigured()).toBe(false);
    configure({ lists: false });
    expect(GCM.isConfigured()).toBe(false);
    process.env.GOOGLE_CM_CUSTOMERS_LIST_ID = '111';
    expect(GCM.isConfigured()).toBe(true);
  });
});

describe('payload builders', () => {
  test('toUserData maps the hash row to userIdentifiers', () => {
    expect(toUserData(['h:e', 'h:p'])).toEqual({ userIdentifiers: [{ emailAddress: 'h:e' }, { phoneNumber: 'h:p' }] });
    expect(toUserData(['h:e', ''])).toEqual({ userIdentifiers: [{ emailAddress: 'h:e' }] });
  });
  test('destination targets the user list on the operating account', () => {
    configure();
    process.env.GOOGLE_ADS_DATA_MANAGER_LOGIN_CUSTOMER_ID = '999';
    expect(destination('111')).toEqual({
      operatingAccount: { accountType: 'GOOGLE_ADS', accountId: '3393936713' },
      productDestinationId: '111',
      loginAccount: { accountType: 'GOOGLE_ADS', accountId: '999' },
    });
  });
});

describe('syncAudience', () => {
  test('not configured → configured:false, no fetch', async () => {
    const r = await GCM.syncAudience('customers');
    expect(r.configured).toBe(false);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('dry run computes delta without calling the API', async () => {
    configure(); // uploads not allowed → dry run
    mockCollectCustomers.mockResolvedValue([
      { key: 'customer:KEEP', email: 'keep@x.com', phone: '9412975749' },
      { key: 'customer:NEW', email: 'new@x.com', phone: null },
    ]);
    stateRow = { member_keys: [
      { k: 'customer:OLD', d: ['h:old@x.com', ''] },
      { k: 'customer:KEEP', d: ['h:keep@x.com', 'h:19412975749'] },
    ] };
    const r = await GCM.syncAudience('customers', {});
    expect(r.dryRun).toBe(true);
    expect(r.eligible).toBe(2);
    expect(r.toAdd).toBe(1);    // NEW
    expect(r.toRemove).toBe(1); // OLD
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('live run ingests hashed members to the right list with ToS + HEX', async () => {
    configure({ allow: true });
    global.fetch = okFetch({});
    mockCollectCustomers.mockResolvedValue([{ key: 'customer:c1', email: 'c1@x.com', phone: '9412975749' }]);
    const r = await GCM.syncAudience('customers', {});
    expect(r.dryRun).toBe(false);
    expect(r.added).toBe(1);
    const call = global.fetch.mock.calls.find((c) => /audienceMembers:ingest$/.test(c[0]));
    expect(call).toBeTruthy();
    expect(call[1].headers.Authorization).toBe('Bearer tok');
    const body = JSON.parse(call[1].body);
    expect(body.encoding).toBe('HEX');
    expect(body.termsOfService).toEqual({ customerMatchTermsOfServiceStatus: 'ACCEPTED' });
    expect(body.destinations[0].productDestinationId).toBe('111');
    expect(body.audienceMembers[0].userData.userIdentifiers).toEqual(
      [{ emailAddress: 'h:c1@x.com' }, { phoneNumber: 'h:19412975749' }],
    );
  });

  test('dropped member is removed via audienceMembers:remove (stored hash)', async () => {
    configure({ allow: true });
    global.fetch = okFetch({});
    mockCollectCustomers.mockResolvedValue([]); // c1 gone
    stateRow = { member_keys: [{ k: 'customer:c1', d: ['h:gone@x.com', ''] }] };
    const r = await GCM.syncAudience('customers', {});
    expect(r.removed).toBe(1);
    const del = global.fetch.mock.calls.find((c) => /audienceMembers:remove$/.test(c[0]));
    expect(del).toBeTruthy();
    expect(JSON.parse(del[1].body).audienceMembers[0].userData.userIdentifiers).toEqual([{ emailAddress: 'h:gone@x.com' }]);
  });

  test('partial change keeps the still-current member (no remove, orphan retained)', async () => {
    configure({ allow: true });
    global.fetch = okFetch({});
    mockCollectCustomers.mockResolvedValue([{ key: 'customer:c1', email: 'a@x.com', phone: '9412975749' }]);
    stateRow = { member_keys: [{ k: 'customer:c1', d: ['h:a@x.com', 'h:OLD'] }] };
    const r = await GCM.syncAudience('customers', {});
    expect(r.toAdd).toBe(1);
    expect(r.toRemove).toBe(0);
    expect(r.retained).toBe(1);
    expect(global.fetch.mock.calls.some((c) => /audienceMembers:remove$/.test(c[0]))).toBe(false);
  });
});

describe('buildReadiness', () => {
  test('reports per-audience list id + match-key counts', async () => {
    configure();
    mockCollectCustomers.mockResolvedValue([
      { key: 'customer:c1', email: 'c1@x.com', phone: null },
      { key: 'customer:c2', email: null, phone: 'bad' },
    ]);
    mockCollectLeads.mockResolvedValue([{ key: 'lead:l1', email: 'l1@x.com', phone: null }]);
    const r = await GCM.buildReadiness();
    expect(r.configured).toBe(true);
    expect(r.audiences.customers.listId).toBe('111');
    expect(r.audiences.customers.eligible).toBe(2);
    expect(r.audiences.customers.withMatchKeys).toBe(1);
    expect(r.audiences.unbooked_leads.listId).toBe('222');
  });
});
