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
  },
}));
// Faithful Google-formatting helpers so the hashing assertions are meaningful:
// sha256Hex echoes its input ("h:<value>") so the test can read the normalized string,
// and normalize* mirror data-manager (phone keeps '+', email lowercases/trims).
jest.mock('../services/ads/data-manager', () => ({
  _private: {
    sha256Hex: (v) => `h:${v}`,
    normalizeEmail: (v) => {
      const e = String(v || '').trim().replace(/\s+/g, '').toLowerCase();
      return e && e.includes('@') ? e : null;
    },
    normalizePhone: (v) => {
      const raw = String(v || '').trim();
      const digits = raw.replace(/\D/g, '');
      if (raw.startsWith('+') && digits.length >= 8 && digits.length <= 15) return `+${digits}`;
      if (digits.length === 10) return `+1${digits}`;
      if (digits.length === 11 && digits[0] === '1') return `+${digits}`;
      return null;
    },
    cleanNumericId: (v) => String(v || '').trim().replace(/[^\d]/g, ''),
  },
}));
jest.mock('googleapis', () => ({
  google: { auth: { GoogleAuth: class { getClient() { return { getAccessToken: async () => ({ token: 'tok' }) }; } } } },
}));

const GCM = require('../services/ads/google-customer-match');
const { toUserData, destination, hashMember, canonicalEmail, customerId, requestStatusOf } = GCM._private;

const ENV = { ...process.env };
beforeEach(() => {
  stateRow = null;
  inserts.length = 0;
  mockCollectCustomers.mockReset();
  mockCollectLeads.mockReset();
  process.env = { ...ENV };
  for (const k of ['GOOGLE_ADS_DATA_MANAGER_SERVICE_ACCOUNT_JSON', 'GOOGLE_SERVICE_ACCOUNT_JSON',
    'GOOGLE_ADS_DATA_MANAGER_CUSTOMER_ID', 'GOOGLE_ADS_CUSTOMER_ID', 'GOOGLE_ADS_DATA_MANAGER_LOGIN_CUSTOMER_ID',
    'GOOGLE_ADS_LOGIN_CUSTOMER_ID', 'GOOGLE_CM_CUSTOMERS_LIST_ID', 'GOOGLE_CM_UNBOOKED_LEADS_LIST_ID',
    'GOOGLE_CUSTOMER_MATCH_ALLOW_UPLOADS', 'GOOGLE_CM_MAX_MEMBERS_PER_CALL']) {
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
// Route fetch by URL substring -> { ok, json }.
function routedFetch(routes) {
  return jest.fn((url) => {
    for (const [needle, json] of Object.entries(routes)) {
      if (String(url).includes(needle)) return Promise.resolve({ ok: true, json: () => Promise.resolve(json) });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
  });
}
const recentIso = () => new Date(Date.now() - 60 * 1000).toISOString();

describe('config', () => {
  test('isConfigured needs service account + customer id + a list id', () => {
    expect(GCM.isConfigured()).toBe(false);
    configure({ lists: false });
    expect(GCM.isConfigured()).toBe(false);
    process.env.GOOGLE_CM_CUSTOMERS_LIST_ID = '111';
    expect(GCM.isConfigured()).toBe(true);
  });
});

describe('Google-correct hashing', () => {
  test('phone is hashed in E.164 WITH the leading "+"', () => {
    expect(hashMember({ key: 'k', email: null, phone: '(941) 297-5749' })).toEqual(['', 'h:+19412975749']);
    expect(hashMember({ key: 'k', email: null, phone: '+44 7700 900123' })).toEqual(['', 'h:+447700900123']);
  });
  test('gmail/googlemail addresses drop dots + strip the "+tag"; other domains keep them', () => {
    expect(canonicalEmail('First.Last+promo@Gmail.com')).toBe('firstlast@gmail.com');
    expect(canonicalEmail('a.b.c@googlemail.com')).toBe('abc@googlemail.com');
    expect(canonicalEmail('User.Name+NYC@Example.com')).toBe('user.name+nyc@example.com');
  });
  test('email + phone produce both hashes', () => {
    expect(hashMember({ key: 'k', email: 'c1@x.com', phone: '9412975749' }))
      .toEqual(['h:c1@x.com', 'h:+19412975749']);
  });
});

describe('payload builders', () => {
  test('toUserData maps the hash row to userIdentifiers', () => {
    expect(toUserData(['h:e', 'h:p'])).toEqual({ userIdentifiers: [{ emailAddress: 'h:e' }, { phoneNumber: 'h:p' }] });
    expect(toUserData(['h:e', ''])).toEqual({ userIdentifiers: [{ emailAddress: 'h:e' }] });
  });
  test('destination normalizes dashed account ids to digits', () => {
    process.env.GOOGLE_ADS_DATA_MANAGER_SERVICE_ACCOUNT_JSON = '{}';
    process.env.GOOGLE_ADS_DATA_MANAGER_CUSTOMER_ID = '339-393-6713';
    process.env.GOOGLE_ADS_DATA_MANAGER_LOGIN_CUSTOMER_ID = '850-769-4331';
    expect(customerId()).toBe('3393936713');
    expect(destination('111')).toEqual({
      operatingAccount: { accountType: 'GOOGLE_ADS', accountId: '3393936713' },
      productDestinationId: '111',
      loginAccount: { accountType: 'GOOGLE_ADS', accountId: '8507694331' },
    });
  });
});

describe('requestStatusOf', () => {
  test('maps per-destination statuses to a coarse status', () => {
    expect(requestStatusOf({ requestStatusPerDestination: [{ requestStatus: 'SUCCESS' }] })).toBe('SUCCESS');
    expect(requestStatusOf({ requestStatusPerDestination: [{ requestStatus: 'PROCESSING' }] })).toBe('PROCESSING');
    expect(requestStatusOf({ requestStatusPerDestination: [{ requestStatus: 'FAILED' }] })).toBe('FAILED');
    expect(requestStatusOf({ requestStatusPerDestination: [{ requestStatus: 'PARTIAL_SUCCESS' }] })).toBe('PARTIAL');
    expect(requestStatusOf({})).toBe('UNKNOWN');
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
      { k: 'customer:KEEP', d: ['h:keep@x.com', 'h:+19412975749'] },
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
    global.fetch = okFetch({ requestId: 'req-add' });
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
      [{ emailAddress: 'h:c1@x.com' }, { phoneNumber: 'h:+19412975749' }],
    );
    // requestId tracked as pending until Google confirms it.
    expect(r.status).toBe('pending');
    const saved = inserts.find((i) => i.table === 'ad_audience_syncs');
    expect(JSON.parse(saved.row.pending)[0]).toMatchObject({ requestId: 'req-add', op: 'ingest' });
    expect(saved.row.last_status).toBe('pending');
  });

  test('dropped member is removed via audienceMembers:remove WITHOUT termsOfService', async () => {
    configure({ allow: true });
    global.fetch = okFetch({ requestId: 'req-rm' });
    mockCollectCustomers.mockResolvedValue([]); // c1 gone
    stateRow = { member_keys: [{ k: 'customer:c1', d: ['h:gone@x.com', ''] }], pending: [] };
    const r = await GCM.syncAudience('customers', {});
    expect(r.removed).toBe(1);
    const del = global.fetch.mock.calls.find((c) => /audienceMembers:remove$/.test(c[0]));
    expect(del).toBeTruthy();
    const body = JSON.parse(del[1].body);
    expect(body.audienceMembers[0].userData.userIdentifiers).toEqual([{ emailAddress: 'h:gone@x.com' }]);
    expect(body.termsOfService).toBeUndefined(); // remove schema rejects it
  });

  test('partial change keeps the still-current member (no remove, orphan retained)', async () => {
    configure({ allow: true });
    global.fetch = okFetch({ requestId: 'req-add' });
    mockCollectCustomers.mockResolvedValue([{ key: 'customer:c1', email: 'a@x.com', phone: '9412975749' }]);
    stateRow = { member_keys: [{ k: 'customer:c1', d: ['h:a@x.com', 'h:OLD'] }], pending: [] };
    const r = await GCM.syncAudience('customers', {});
    expect(r.toAdd).toBe(1);
    expect(r.toRemove).toBe(0);
    expect(r.retained).toBe(1);
    expect(global.fetch.mock.calls.some((c) => /audienceMembers:remove$/.test(c[0]))).toBe(false);
  });
});

describe('reconcile pending requests', () => {
  test('a FAILED prior ingest is reverted so the member re-uploads', async () => {
    configure({ allow: true });
    // c1 is still a current member; the prior ingest of c1 is marked FAILED.
    mockCollectCustomers.mockResolvedValue([{ key: 'customer:c1', email: 'c1@x.com', phone: null }]);
    stateRow = {
      member_keys: [{ k: 'customer:c1', d: ['h:c1@x.com', ''] }],
      pending: [{ requestId: 'req-1', op: 'ingest', at: recentIso(), members: [{ k: 'customer:c1', d: ['h:c1@x.com', ''] }] }],
    };
    global.fetch = routedFetch({
      'requestStatus:retrieve': { requestStatusPerDestination: [{ requestStatus: 'FAILED' }] },
      'audienceMembers:ingest': { requestId: 'req-2' },
    });
    const r = await GCM.syncAudience('customers', {});
    expect(r.toAdd).toBe(1); // reverted -> re-sent
    expect(global.fetch.mock.calls.some((c) => /audienceMembers:ingest$/.test(c[0]))).toBe(true);
  });

  test('a SUCCESS prior ingest is NOT re-sent', async () => {
    configure({ allow: true });
    mockCollectCustomers.mockResolvedValue([{ key: 'customer:c1', email: 'c1@x.com', phone: null }]);
    stateRow = {
      member_keys: [{ k: 'customer:c1', d: ['h:c1@x.com', ''] }],
      pending: [{ requestId: 'req-1', op: 'ingest', at: recentIso(), members: [{ k: 'customer:c1', d: ['h:c1@x.com', ''] }] }],
    };
    global.fetch = routedFetch({
      'requestStatus:retrieve': { requestStatusPerDestination: [{ requestStatus: 'SUCCESS' }] },
    });
    const r = await GCM.syncAudience('customers', {});
    expect(r.toAdd).toBe(0);
    expect(global.fetch.mock.calls.some((c) => /audienceMembers:ingest$/.test(c[0]))).toBe(false);
  });

  test('a still-PROCESSING op stays pending and is carried forward', async () => {
    configure({ allow: true });
    mockCollectCustomers.mockResolvedValue([{ key: 'customer:c1', email: 'c1@x.com', phone: null }]);
    stateRow = {
      member_keys: [{ k: 'customer:c1', d: ['h:c1@x.com', ''] }],
      pending: [{ requestId: 'req-1', op: 'ingest', at: recentIso(), members: [{ k: 'customer:c1', d: ['h:c1@x.com', ''] }] }],
    };
    global.fetch = routedFetch({
      'requestStatus:retrieve': { requestStatusPerDestination: [{ requestStatus: 'PROCESSING' }] },
    });
    const r = await GCM.syncAudience('customers', {});
    expect(r.toAdd).toBe(0); // optimistic state stands
    const saved = inserts.find((i) => i.table === 'ad_audience_syncs');
    expect(JSON.parse(saved.row.pending).some((p) => p.requestId === 'req-1')).toBe(true);
  });

  test('HOLDS a removal while that hash still has a pending ingest (async ordering)', async () => {
    configure({ allow: true });
    mockCollectCustomers.mockResolvedValue([]); // c1 dropped from the source
    stateRow = {
      member_keys: [{ k: 'customer:c1', d: ['h:c1@x.com', ''] }],
      pending: [{ requestId: 'req-i', op: 'ingest', at: recentIso(), members: [{ k: 'customer:c1', d: ['h:c1@x.com', ''] }] }],
    };
    global.fetch = routedFetch({
      'requestStatus:retrieve': { requestStatusPerDestination: [{ requestStatus: 'PROCESSING' }] },
    });
    const r = await GCM.syncAudience('customers', {});
    expect(r.toRemove).toBe(0);
    expect(r.heldRemoves).toBe(1);
    expect(global.fetch.mock.calls.some((c) => /audienceMembers:remove$/.test(c[0]))).toBe(false);
    // kept in state so it removes once the ingest is terminal
    const saved = inserts.find((i) => i.table === 'ad_audience_syncs');
    expect(JSON.parse(saved.row.member_keys).some((e) => e.k === 'customer:c1')).toBe(true);
  });

  test('HOLDS a re-add while that hash still has a pending removal (async ordering)', async () => {
    configure({ allow: true });
    mockCollectCustomers.mockResolvedValue([{ key: 'customer:c1', email: 'c1@x.com', phone: null }]); // reappeared
    stateRow = {
      member_keys: [],
      pending: [{ requestId: 'req-r', op: 'remove', at: recentIso(), members: [{ k: 'customer:c1', d: ['h:c1@x.com', ''] }] }],
    };
    global.fetch = routedFetch({
      'requestStatus:retrieve': { requestStatusPerDestination: [{ requestStatus: 'PROCESSING' }] },
    });
    const r = await GCM.syncAudience('customers', {});
    expect(r.toAdd).toBe(0);
    expect(r.heldAdds).toBe(1);
    expect(global.fetch.mock.calls.some((c) => /audienceMembers:ingest$/.test(c[0]))).toBe(false);
    // NOT persisted as present, so it re-adds once the removal is terminal
    const saved = inserts.find((i) => i.table === 'ad_audience_syncs');
    expect(JSON.parse(saved.row.member_keys).some((e) => e.k === 'customer:c1')).toBe(false);
  });

  test('holds a re-add by IDENTIFIER when a pending remove shares an identifier (changed row)', async () => {
    configure({ allow: true });
    // reappears with a NEW phone but the SAME email as the in-flight remove
    mockCollectCustomers.mockResolvedValue([{ key: 'customer:c1', email: 'c1@x.com', phone: '9412975749' }]);
    stateRow = {
      member_keys: [],
      pending: [{ requestId: 'req-r', op: 'remove', at: recentIso(), members: [{ k: 'customer:c1', d: ['h:c1@x.com', 'h:+19999999999'] }] }],
    };
    global.fetch = routedFetch({ 'requestStatus:retrieve': { requestStatusPerDestination: [{ requestStatus: 'PROCESSING' }] } });
    const r = await GCM.syncAudience('customers', {});
    expect(r.toAdd).toBe(0); // email hash matches the in-flight remove → held (row hashes differ)
    expect(r.heldAdds).toBe(1);
    expect(global.fetch.mock.calls.some((c) => /audienceMembers:ingest$/.test(c[0]))).toBe(false);
  });

  test('holds a removal by IDENTIFIER when a pending ingest shares an identifier (changed row)', async () => {
    configure({ allow: true });
    mockCollectCustomers.mockResolvedValue([]); // c1 dropped from the source
    stateRow = {
      member_keys: [{ k: 'customer:c1', d: ['h:c1@x.com', 'h:+19412975749'] }],
      pending: [{ requestId: 'req-i', op: 'ingest', at: recentIso(), members: [{ k: 'customer:c1', d: ['h:c1@x.com', 'h:+19999999999'] }] }],
    };
    global.fetch = routedFetch({ 'requestStatus:retrieve': { requestStatusPerDestination: [{ requestStatus: 'PROCESSING' }] } });
    const r = await GCM.syncAudience('customers', {});
    expect(r.toRemove).toBe(0); // email hash matches the in-flight ingest → held
    expect(r.heldRemoves).toBe(1);
    expect(global.fetch.mock.calls.some((c) => /audienceMembers:remove$/.test(c[0]))).toBe(false);
  });
});

describe('destination scoping', () => {
  test('resets state when the configured destination changed → full re-upload', async () => {
    configure({ allow: true }); // customer 3393936713, list 111 → sig "3393936713:111"
    global.fetch = okFetch({ requestId: 'req-add' });
    mockCollectCustomers.mockResolvedValue([{ key: 'customer:c1', email: 'c1@x.com', phone: null }]);
    stateRow = {
      member_keys: [{ k: 'customer:c1', d: ['h:c1@x.com', ''] }], // uploaded to the OLD list
      pending: [],
      destination_sig: '3393936713:999', // OLD list id 999 ≠ current 111
    };
    const r = await GCM.syncAudience('customers', {});
    expect(r.toAdd).toBe(1); // prior ignored → re-add to the new list
    const saved = inserts.find((i) => i.table === 'ad_audience_syncs');
    expect(saved.row.destination_sig).toBe('3393936713:111');
  });

  test('does NOT reset when the destination is unchanged', async () => {
    configure({ allow: true });
    global.fetch = okFetch({});
    mockCollectCustomers.mockResolvedValue([{ key: 'customer:c1', email: 'c1@x.com', phone: null }]);
    stateRow = {
      member_keys: [{ k: 'customer:c1', d: ['h:c1@x.com', ''] }],
      pending: [],
      destination_sig: '3393936713:111', // matches configure()
    };
    const r = await GCM.syncAudience('customers', {});
    expect(r.toAdd).toBe(0); // already present, no re-upload
  });
});

describe('credentials', () => {
  test('isConfigured tolerates the service-account JSON missing its closing brace', () => {
    process.env.GOOGLE_ADS_DATA_MANAGER_CUSTOMER_ID = '3393936713';
    process.env.GOOGLE_CM_CUSTOMERS_LIST_ID = '111';
    process.env.GOOGLE_ADS_DATA_MANAGER_SERVICE_ACCOUNT_JSON = '{"client_email":"x@y.iam","private_key":"k"'; // no trailing }
    expect(GCM.isConfigured()).toBe(true);
  });
});

describe('batching', () => {
  test('persists one pending entry per batch/requestId (no overwrite)', async () => {
    configure({ allow: true });
    process.env.GOOGLE_CM_MAX_MEMBERS_PER_CALL = '1'; // force 1 member per request
    mockCollectCustomers.mockResolvedValue([
      { key: 'customer:a', email: 'a@x.com', phone: null },
      { key: 'customer:b', email: 'b@x.com', phone: null },
    ]);
    let n = 0;
    global.fetch = jest.fn((url) => {
      if (/audienceMembers:ingest$/.test(url)) { n += 1; return Promise.resolve({ ok: true, json: () => Promise.resolve({ requestId: `req-${n}` }) }); }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });
    const r = await GCM.syncAudience('customers', {});
    expect(r.added).toBe(2);
    expect(global.fetch.mock.calls.filter((c) => /audienceMembers:ingest$/.test(c[0])).length).toBe(2);
    const saved = inserts.find((i) => i.table === 'ad_audience_syncs');
    const ids = JSON.parse(saved.row.pending).filter((p) => p.op === 'ingest').map((p) => p.requestId).sort();
    expect(ids).toEqual(['req-1', 'req-2']); // both batches tracked, not just the last
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
