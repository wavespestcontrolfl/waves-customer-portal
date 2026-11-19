// Tests services/ads/google-customer-match.js — Google Customer Match audience sync.

let stateRow = null;
let tableData = {}; // rows returned by .select() per table (consent suppression lists)
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

const mockCollectCustomers = jest.fn();
const mockCollectLeads = jest.fn();
const mockStaleOptOuts = jest.fn();

jest.mock('../models/db', () => mockDb);
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../utils/cron-lock', () => ({ runExclusive: (_n, fn) => fn() }));
// The sync collects with partition: true; an array a test returns stands for the kept members.
const mockAsPartition = (opts, out) => (opts && opts.partition && Array.isArray(out) ? { kept: out, dropped: [], testKeys: [] } : out);
jest.mock('../services/ads/meta-audiences', () => ({
  _private: {
    collectCustomerMembers: async (...a) => mockAsPartition(a[0], await mockCollectCustomers(...a)),
    collectUnbookedLeadMembers: async (...a) => mockAsPartition(a[0], await mockCollectLeads(...a)),
    staleLeadOptOutKeys: (...a) => mockStaleOptOuts(...a),
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
  mockStaleOptOuts.mockReset().mockResolvedValue([]);
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

// ── r2 (Codex): consent removal overrides shared-identifier retention ──
describe('consent (r2)', () => {
  beforeEach(() => { tableData = {}; });
  afterEach(() => { tableData = {}; });

  test('an opted-out prior row is removed even when it shares a phone with a current member', async () => {
    configure(); // dry run — the delta itself carries the decision
    tableData.email_suppressions = [{ email: 'opted@x.com' }];
    mockCollectLeads.mockResolvedValue([{ key: 'lead:l2', email: 'fine@x.com', phone: '9415551111' }]);
    stateRow = {
      member_keys: [
        { k: 'lead:l1', d: ['h:opted@x.com', 'h:+19415551111'] }, // opted out, shares household phone
        { k: 'lead:l2', d: ['h:fine@x.com', 'h:+19415551111'] },  // current housemate
      ],
    };
    const r = await GCM.syncAudience('unbooked_leads', {});
    expect(r.consentRemovals).toBe(1);
    expect(r.toRemove).toBe(1);   // the old rule would have retained it forever
    expect(r.retained).toBe(0);
    expect(r.deferredReAdds).toBe(1); // housemate re-adds after the remove settles
  });

  test('gmail dot-variant suppression removes the row uploaded under the canonical hash', async () => {
    configure();
    tableData.email_suppressions = [{ email: 'o.p.t.e.d+x@gmail.com' }]; // stored variant
    mockCollectLeads.mockResolvedValue([]);
    stateRow = {
      // uploaded hash is of the CANONICAL form — the suppression must still match it
      member_keys: [{ k: 'lead:l1', d: ['h:opted@gmail.com', ''] }],
    };
    const r = await GCM.syncAudience('unbooked_leads', {});
    expect(r.consentRemovals).toBe(1);
    expect(r.toRemove).toBe(1);
  });

  test('a lead opted out through its linked customer leaves even beside a current member', async () => {
    configure();
    // The collector names l1 in optOutKeys: its customer opted out. l2 shares its phone.
    mockCollectLeads.mockResolvedValue({
      kept: [{ key: 'lead:l2', email: 'house@x.com', phone: '9415550123' }], dropped: [], testKeys: [], optOutKeys: ['lead:l1'],
    });
    stateRow = { member_keys: [
      { k: 'lead:l1', d: ['h:lead@x.com', 'h:+19415550123'], a: 'h:jo|h:lee|US|34202' },
      { k: 'lead:l2', d: ['h:house@x.com', 'h:+19415550123'] },
    ] };
    const r = await GCM.syncAudience('unbooked_leads', {});
    expect(r).toMatchObject({ toRemove: 1, retained: 0, consentRemovals: 1, testRemovals: 0, deferredReAdds: 1 });
  });

  test('a stored lead no longer collected leaves on its linked customer opt-out too, even beside a current member', async () => {
    configure();
    // l1 closed or aged out, so the collector no longer sees it; its customer opted out.
    mockCollectLeads.mockResolvedValue({
      kept: [{ key: 'lead:l2', email: 'house@x.com', phone: '9415550123' }], dropped: [], testKeys: [], optOutKeys: [],
    });
    mockStaleOptOuts.mockResolvedValue(['lead:l1']);
    const l1 = { k: 'lead:l1', d: ['h:lead@x.com', 'h:+19415550123'], a: 'h:jo|h:lee|US|34202' };
    stateRow = { member_keys: [l1, { k: 'lead:l2', d: ['h:house@x.com', 'h:+19415550123'] }] };
    const r = await GCM.syncAudience('unbooked_leads', {});
    expect(r).toMatchObject({ toRemove: 1, retained: 0, consentRemovals: 1, testRemovals: 0, deferredReAdds: 1 });
    // The hook reads the stored rows and the current members.
    const [priorArg, membersArg] = mockStaleOptOuts.mock.calls[0];
    expect(priorArg.map((e) => e.k)).toEqual(['lead:l1', 'lead:l2']);
    expect(membersArg.map((m) => m.key)).toEqual(['lead:l2']);
    // The customers list has no such hook.
    mockCollectCustomers.mockResolvedValue([]);
    await GCM.syncAudience('customers', {});
    expect(mockStaleOptOuts).toHaveBeenCalledTimes(1);
  });
});

describe('name + ZIP address on the Google list (2b)', () => {
  const NAMED = { key: 'customer:c1', email: 'c1@x.com', phone: '9412975749', firstName: 'Pat', lastName: "O'Neil", zip: '34219-1234' };
  const ADDR = { givenName: 'h:pat', familyName: 'h:oneil', regionCode: 'US', postalCode: '34219' };
  const SIG = 'h:pat|h:oneil|US|34219';

  test('toUserData rebuilds the address from the stored signature; no signature, no address', () => {
    expect(GCM._private.addressSig(ADDR)).toBe(SIG);
    expect(toUserData(['h:e', 'h:p'], SIG).userIdentifiers).toEqual([{ emailAddress: 'h:e' }, { phoneNumber: 'h:p' }, { address: ADDR }]);
    expect(toUserData(['h:e', 'h:p']).userIdentifiers).toHaveLength(2);
  });

  test('addressFor: hashed names + plain regionCode/postalCode; null without both names and a 5-digit ZIP', () => {
    const { addressFor } = GCM._private;
    expect(addressFor(NAMED)).toEqual(ADDR);
    expect(addressFor({ ...NAMED, lastName: null })).toBeNull();
    expect(addressFor({ ...NAMED, firstName: '' })).toBeNull();
    expect(addressFor({ ...NAMED, zip: '342' })).toBeNull();
    expect(addressFor({ email: 'a@x.com' })).toBeNull();
  });

  test('live ingest carries addressInfo for a named member and omits it for an unnamed one', async () => {
    configure({ allow: true });
    global.fetch = okFetch({ requestId: 'req-add' });
    mockCollectCustomers.mockResolvedValue([NAMED, { key: 'customer:c2', email: 'c2@x.com', phone: null }]);
    await GCM.syncAudience('customers', {});
    const call = global.fetch.mock.calls.find((c) => /audienceMembers:ingest$/.test(c[0]));
    const members = JSON.parse(call[1].body).audienceMembers;
    expect(members[0].userData.userIdentifiers).toContainEqual({ address: ADDR });
    expect(members[1].userData.userIdentifiers.some((u) => u.address)).toBe(false);
    // state and the pending op keep only the signature, never a plaintext name
    const saved = inserts.find((i) => i.table === 'ad_audience_syncs');
    expect(JSON.parse(saved.row.member_keys)[0].a).toBe(SIG);
    expect(JSON.parse(saved.row.pending)[0].members[0].a).toBe(SIG);
    expect(JSON.stringify(saved.row)).not.toMatch(/Pat|O'Neil/);
  });

  test('one-time upgrade: a member stored without an address is re-ingested once, not removed', async () => {
    configure({ allow: true });
    global.fetch = okFetch({ requestId: 'req-up' });
    mockCollectCustomers.mockResolvedValue([NAMED]);
    stateRow = { member_keys: [{ k: 'customer:c1', d: ['h:c1@x.com', 'h:+19412975749'] }] };
    const r = await GCM.syncAudience('customers', {});
    expect(r.toEnrich).toBe(1);
    expect(r.toAdd).toBe(0);
    expect(r.toRemove).toBe(0);
    expect(global.fetch.mock.calls.some((c) => /audienceMembers:remove$/.test(c[0]))).toBe(false);
  });

  test('already-upgraded member is not re-sent', async () => {
    configure();
    mockCollectCustomers.mockResolvedValue([NAMED]);
    stateRow = { member_keys: [{ k: 'customer:c1', d: ['h:c1@x.com', 'h:+19412975749'], a: SIG }] };
    const r = await GCM.syncAudience('customers', {});
    expect(r.toAdd + r.toEnrich + r.toRemove).toBe(0);
  });

  test('a sent address stays the row\'s: an edited or cleared name is not re-sent, the stored one is kept', async () => {
    configure({ allow: true });
    global.fetch = okFetch({});
    mockCollectCustomers.mockResolvedValue([
      { ...NAMED, lastName: 'Smith' },                                      // name edited since the upload
      { key: 'customer:c2', email: 'c2@x.com', phone: null, firstName: null }, // name cleared since
    ]);
    stateRow = { member_keys: [
      { k: 'customer:c1', d: ['h:c1@x.com', 'h:+19412975749'], a: SIG },
      { k: 'customer:c2', d: ['h:c2@x.com', ''], a: 'h:sam|h:lee|US|34202' },
    ] };
    const r = await GCM.syncAudience('customers', {});
    expect(r.toAdd + r.toEnrich + r.toRemove).toBe(0);
    const persisted = JSON.parse(inserts.find((i) => i.table === 'ad_audience_syncs').row.member_keys);
    expect(persisted.map((e) => e.a)).toEqual([SIG, 'h:sam|h:lee|US|34202']);
  });

  test('a removal carries the address the row was added with; a row stored before addresses by email/phone only', async () => {
    configure({ allow: true });
    global.fetch = okFetch({ requestId: 'req-rm' });
    mockCollectCustomers.mockResolvedValue([]);
    stateRow = { member_keys: [
      { k: 'customer:gone', d: ['h:gone@x.com', ''], a: SIG },
      { k: 'customer:old', d: ['h:old@x.com', ''] },
    ] };
    await GCM.syncAudience('customers', {});
    const call = global.fetch.mock.calls.find((c) => /audienceMembers:remove$/.test(c[0]));
    expect(JSON.parse(call[1].body).audienceMembers.map((m) => m.userData.userIdentifiers)).toEqual([
      [{ emailAddress: 'h:gone@x.com' }, { address: ADDR }],
      [{ emailAddress: 'h:old@x.com' }],
    ]);
  });

  test('a failed enrichment keeps the row, so a later opt-out still removes it with the address it sent', async () => {
    configure({ allow: true });
    tableData = { email_suppressions: [{ email: 'l1@x.com' }] };
    mockCollectLeads.mockResolvedValue([]); // opted out: no longer collected
    const row = { k: 'lead:l1', d: ['h:l1@x.com', ''], a: SIG };
    stateRow = { member_keys: [row], pending: [{ requestId: 'req-e', op: 'ingest', at: recentIso(), members: [row] }] };
    global.fetch = routedFetch({
      'requestStatus:retrieve': { requestStatusPerDestination: [{ requestStatus: 'FAILED' }] },
      'audienceMembers:remove': { requestId: 'req-rm' },
    });
    try {
      const r = await GCM.syncAudience('unbooked_leads', {});
      expect(r.consentRemovals).toBe(1);
      expect(r.removed).toBe(1);
      const call = global.fetch.mock.calls.find((c) => /audienceMembers:remove$/.test(c[0]));
      expect(JSON.parse(call[1].body).audienceMembers[0].userData.userIdentifiers)
        .toEqual([{ emailAddress: 'h:l1@x.com' }, { address: ADDR }]);
    } finally { tableData = {}; }
  });

  test('a failed ingest of a current member is re-sent with the keys it stored, then stored without the flag', async () => {
    configure({ allow: true });
    mockCollectCustomers.mockResolvedValue([{ ...NAMED, lastName: 'Smith' }]); // edited since the failed send
    const row = { k: 'customer:c1', d: ['h:c1@x.com', 'h:+19412975749'], a: SIG };
    stateRow = { member_keys: [row], pending: [{ requestId: 'req-e', op: 'ingest', at: recentIso(), members: [row] }] };
    global.fetch = routedFetch({
      'requestStatus:retrieve': { requestStatusPerDestination: [{ requestStatus: 'PARTIAL_SUCCESS' }] },
      'audienceMembers:ingest': { requestId: 'req-2' },
    });
    const r = await GCM.syncAudience('customers', {});
    expect(r.added).toBe(1);
    const call = global.fetch.mock.calls.find((c) => /audienceMembers:ingest$/.test(c[0]));
    expect(JSON.parse(call[1].body).audienceMembers[0].userData.userIdentifiers).toContainEqual({ address: ADDR });
    const persisted = JSON.parse(inserts.find((i) => i.table === 'ad_audience_syncs').row.member_keys);
    expect(persisted).toEqual([row]);
  });

  test('an address is a shared key like email or phone: a leaving row keeps it while a member holds it', async () => {
    configure();
    // Same name + ZIP, different email and phone: a remove sending this address could drop the member.
    mockCollectCustomers.mockResolvedValue([NAMED]);
    stateRow = { member_keys: [
      { k: 'customer:c1', d: ['h:c1@x.com', 'h:+19412975749'], a: SIG },
      { k: 'lead:dup', d: ['h:other@x.com', ''], a: SIG },
    ] };
    const r = await GCM.syncAudience('customers', {});
    expect(r.toRemove).toBe(0);
    expect(r.retained).toBe(1);
  });

  test('an address is a shared key for the in-flight holds too: an add waits for a remove that sends it', async () => {
    configure({ allow: true });
    mockCollectCustomers.mockResolvedValue([NAMED]);
    stateRow = { member_keys: [], pending: [{ requestId: 'req-r', op: 'remove', at: recentIso(), members: [{ k: 'lead:dup', d: ['h:other@x.com', ''], a: SIG }] }] };
    global.fetch = routedFetch({ 'requestStatus:retrieve': { requestStatusPerDestination: [{ requestStatus: 'PROCESSING' }] } });
    const r = await GCM.syncAudience('customers', {});
    expect(r.heldAdds).toBe(1);
    expect(global.fetch.mock.calls.some((c) => /audienceMembers:ingest$/.test(c[0]))).toBe(false);
  });

  test('an address the member never sent holds back no removal', async () => {
    configure();
    // c1 was sent with ZIP 34219 and has moved to 34202 since; its stored address stays.
    mockCollectCustomers.mockResolvedValue([{ ...NAMED, zip: '34202' }]);
    stateRow = { member_keys: [
      { k: 'customer:c1', d: ['h:c1@x.com', 'h:+19412975749'], a: SIG },
      // Another person with the same name, in 34202, who has left the list.
      { k: 'lead:gone', d: ['h:gone@x.com', ''], a: 'h:pat|h:oneil|US|34202' },
    ] };
    const r = await GCM.syncAudience('customers', {});
    expect(r).toMatchObject({ toRemove: 1, retained: 0 });
  });

  test('an uploaded test record goes even when it shares a phone with a current member; that member re-adds next run', async () => {
    configure();
    // The collector drops the test record and names it in testKeys.
    mockCollectCustomers.mockResolvedValue({
      kept: [{ key: 'customer:real1', email: 'real1@x.com', phone: '9415550140' }], dropped: [], testKeys: ['customer:t1'],
    });
    stateRow = { member_keys: [
      { k: 'customer:real1', d: ['h:real1@x.com', 'h:+19415550140'] },
      { k: 'customer:t1', d: ['h:tester@x.com', 'h:+19415550140'] },
    ] };
    const r = await GCM.syncAudience('customers', {});
    expect(r).toMatchObject({ toRemove: 1, retained: 0, testRemovals: 1, deferredReAdds: 1 });
    expect(mockCollectCustomers).toHaveBeenCalledWith(expect.objectContaining({ partition: true }));
  });

  test('an uploaded test record goes even when a member has its exact email and phone; the member is sent once the remove settles, with its own address', async () => {
    configure({ allow: true });
    mockCollectCustomers.mockResolvedValue({ kept: [{ ...NAMED, key: 'customer:real1' }], dropped: [], testKeys: ['customer:t1'] });
    const testSig = 'h:shakedown|h:test|US|34202';
    stateRow = { member_keys: [{ k: 'customer:t1', d: ['h:c1@x.com', 'h:+19412975749'], a: testSig }] };
    const run = async (status) => {
      global.fetch = routedFetch({
        'requestStatus:retrieve': { requestStatusPerDestination: [{ requestStatus: status }] },
        'audienceMembers:ingest': { requestId: 'req-add' },
        'audienceMembers:remove': { requestId: 'req-rm' },
      });
      const r = await GCM.syncAudience('customers', {});
      const saved = inserts.filter((i) => i.table === 'ad_audience_syncs').pop().row;
      stateRow = { member_keys: JSON.parse(saved.member_keys), pending: JSON.parse(saved.pending) };
      return r;
    };
    const sent = (op) => global.fetch.mock.calls.filter((c) => c[0].endsWith(`audienceMembers:${op}`))
      .map((c) => JSON.parse(c[1].body).audienceMembers.map((m) => m.userData.userIdentifiers));
    const contact = [{ emailAddress: 'h:c1@x.com' }, { phoneNumber: 'h:+19412975749' }];

    // Only the remove goes: Google may apply an ingest before a remove sent beside
    // it, and the member, left out of state, would then never be removed.
    expect(await run('SUCCESS')).toMatchObject({ toAdd: 0, heldAdds: 1, toRemove: 1, testRemovals: 1 });
    expect(sent('ingest')).toEqual([]);
    expect(sent('remove')).toEqual([[[...contact, { address: { givenName: 'h:shakedown', familyName: 'h:test', regionCode: 'US', postalCode: '34202' } }]]]);
    expect(stateRow.member_keys).toEqual([]);
    // While the remove is in flight the member still waits.
    expect(await run('PROCESSING')).toMatchObject({ toAdd: 0, heldAdds: 1, toRemove: 0 });
    expect(sent('ingest')).toEqual([]);
    // Once it applied, the member is sent with its own address, never the test record's.
    expect(await run('SUCCESS')).toMatchObject({ toAdd: 1, heldAdds: 0, toRemove: 0 });
    expect(sent('ingest')).toEqual([[[...contact, { address: ADDR }]]]);
  });
});
