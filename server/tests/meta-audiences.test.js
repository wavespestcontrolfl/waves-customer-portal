// Tests services/ads/meta-audiences.js — Meta Custom Audiences sync (suppression + retargeting).

let tableData = {};   // { customers: [...], leads: [...] } returned by .select()
let stateRow = null;  // ad_audience_syncs .first()
const inserts = [];

const mockDb = jest.fn((table) => {
  const b = {};
  ['leftJoin', 'where', 'whereNull', 'whereNotNull', 'orWhereNotNull', 'whereIn', 'whereRaw', 'andWhere', 'whereNotExists'].forEach((m) => {
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
    expect(m).toEqual([expect.objectContaining({ key: 'customer:c1', email: 'c1@x.com', phone: '9412975749', externalId: 'c1' })]);
  });
  test('customers carry name + address + our customer id as external id', async () => {
    tableData.customers = [{ id: 'c1', email: 'c1@x.com', phone: null, first_name: 'Jo', last_name: 'Lee', city: 'Parrish', state: 'FL', zip: '34219' }];
    const [m] = await collectCustomerMembers();
    expect(m).toEqual({
      key: 'customer:c1', email: 'c1@x.com', phone: null, externalId: 'c1',
      firstName: 'Jo', lastName: 'Lee', city: 'Parrish', state: 'FL', zip: '34219',
    });
  });
  test('leads → lead:<id> keys', async () => {
    tableData.leads = [{ id: 'l1', email: 'l1@x.com', phone: null }];
    const m = await collectUnbookedLeadMembers();
    expect(m).toEqual([expect.objectContaining({ key: 'lead:l1', email: 'l1@x.com', phone: null, externalId: 'lead:l1' })]);
  });
  test('lead uses its own name/ZIP, borrows state from the linked customer, and shares the customer external id', async () => {
    tableData.leads = [{
      id: 'l1', email: 'l1@x.com', phone: null, customer_id: 'cust9',
      first_name: 'Jo', last_name: 'Lee', city: null, zip: '34219',
      customer_first_name: 'Joanne', customer_last_name: 'Lee', customer_city: 'Parrish', customer_state: 'FL', customer_zip: '34219',
    }];
    const [m] = await collectUnbookedLeadMembers();
    expect(m).toMatchObject({ firstName: 'Jo', lastName: 'Lee', city: 'Parrish', state: 'FL', zip: '34219', externalId: 'cust9' });
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
    expect(r.toAdd).toBe(1);
    expect(r.toRemove).toBe(1);
    expect(r.retained).toBe(0);
    expect(r.added).toBe(1);
    expect(r.removed).toBe(1);
    const post = global.fetch.mock.calls.find((c) => c[1].method === 'POST' && /\/users$/.test(c[0]));
    const del = global.fetch.mock.calls.find((c) => c[1] && c[1].method === 'DELETE');
    expect(JSON.parse(post[1].body).payload.data).toEqual([['h:new@x.com', '', '', '', '', '', '', '', 'h:c1']]);
    // a legacy row (uploaded before extras existed) is removed with the same email/phone row it went up with
    expect(JSON.parse(del[1].body).payload.schema).toEqual(['EMAIL', 'PHONE']);
    expect(JSON.parse(del[1].body).payload.data).toEqual([['h:old@x.com', '']]);
  });

  test('partial change (shared email) adds the new row but does NOT delete the still-current one', async () => {
    configure({ allow: true });
    global.fetch = okFetch({ id: 'AUDX' });
    // email unchanged (a@x.com), phone changed → old row shares the current email hash
    tableData.customers = [{ id: 'c1', email: 'a@x.com', phone: '9412975749' }]; // -> ['h:a@x.com','h:19412975749']
    stateRow = { meta_audience_id: 'AUDX', member_keys: [{ k: 'customer:c1', d: ['h:a@x.com', 'h:OLD'] }] };
    const r = await MetaAudiences.syncAudience('customers', {});
    expect(r.toAdd).toBe(1);
    expect(r.toRemove).toBe(0); // must NOT delete — would remove the person by their unchanged email
    expect(r.removed).toBe(0);
    expect(r.retained).toBe(1);
    expect(global.fetch.mock.calls.some((c) => c[1] && c[1].method === 'DELETE')).toBe(false);
    // the stale orphan row is carried forward in state so a later sync can clean it up
    const saved = inserts.filter((x) => x.table === 'ad_audience_syncs').pop();
    const persisted = JSON.parse(saved.row.member_keys);
    expect(persisted).toEqual(expect.arrayContaining([
      expect.objectContaining({ k: 'customer:c1', d: ['h:a@x.com', 'h:19412975749'] }),
      expect.objectContaining({ k: 'customer:c1', d: ['h:a@x.com', 'h:OLD'] }),
    ]));
  });

  test('retained orphan is deleted once the member drops out (self-heals)', async () => {
    configure({ allow: true });
    global.fetch = okFetch({});
    tableData.customers = []; // c1 no longer a customer
    stateRow = { meta_audience_id: 'AUDX', member_keys: [
      { k: 'customer:c1', d: ['h:a@x.com', 'h:NEW'] },
      { k: 'customer:c1', d: ['h:a@x.com', 'h:OLD'] }, // retained orphan from a past partial change
    ] };
    const r = await MetaAudiences.syncAudience('customers', {});
    expect(r.toRemove).toBe(2); // nothing current shares these now → both safe to delete
    expect(r.removed).toBe(2);
    expect(r.retained).toBe(0);
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
    expect(body.payload.schema).toEqual(['EMAIL', 'PHONE', 'FN', 'LN', 'ZIP', 'CT', 'ST', 'COUNTRY', 'EXTERN_ID']);
    expect(body.payload.data).toEqual([['h:c1@x.com', 'h:19412975749', '', '', '', '', '', '', 'h:c1']]);
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

// ── r2 (Codex): consent semantics in the delta ───────────────────────
describe('consent (r2)', () => {
  test('customers audience KEEPS an opted-out customer — it is the prospecting EXCLUSION list', async () => {
    configure();
    tableData.customers = [{ id: 'c1', email: 'opted@x.com', phone: '9415551234' }];
    tableData.email_suppressions = [{ email: 'opted@x.com' }];
    const r = await MetaAudiences.syncAudience('customers', {});
    expect(r.eligible).toBe(1);   // NOT dropped — removing them would re-expose them to ads
    expect(r.toAdd).toBe(1);
  });

  test('unbooked_leads (retargeting) drops the opted-out lead at collection', async () => {
    configure();
    tableData.leads = [{ id: 'l1', email: 'opted@x.com', phone: null }];
    tableData.email_suppressions = [{ email: 'opted@x.com' }];
    const r = await MetaAudiences.syncAudience('unbooked_leads', {});
    expect(r.eligible).toBe(0);
    expect(r.toAdd).toBe(0);
  });

  test('consent removal overrides shared-identifier retention; housemate re-adds next run', async () => {
    configure({ allow: true });
    global.fetch = okFetch({ id: 'AUDX' });
    // Opted-out lead l1 (unique email) shares a household phone with current lead l2:
    // the old rule would RETAIN l1's row forever, keeping the opted-out email matchable.
    tableData.leads = [{ id: 'l2', email: 'fine@x.com', phone: '9415551111' }];
    tableData.email_suppressions = [{ email: 'opted@x.com' }];
    stateRow = { meta_audience_id: 'AUDX', member_keys: [
      { k: 'lead:l1', d: ['h:opted@x.com', 'h:19415551111'] },
      { k: 'lead:l2', d: ['h:fine@x.com', 'h:19415551111'] },
    ] };
    const r = await MetaAudiences.syncAudience('unbooked_leads', {});
    expect(r.consentRemovals).toBe(1);
    expect(r.toRemove).toBe(1);
    expect(r.retained).toBe(0);
    expect(r.deferredReAdds).toBe(1);
    const del = global.fetch.mock.calls.find((c) => c[1] && c[1].method === 'DELETE');
    expect(JSON.parse(del[1].body).payload.data).toEqual([['h:opted@x.com', 'h:19415551111']]);
    // l2 is deliberately absent from persisted state — the DELETE (which runs after
    // adds and matches by ANY identifier) may knock them out; next sync re-adds.
    const saved = inserts.filter((x) => x.table === 'ad_audience_syncs').pop();
    expect(JSON.parse(saved.row.member_keys)).toEqual([]);
  });
});

// ── r3 (Codex): variant-uploaded rows removed via dropped-member hashing ──
describe('consent (r3)', () => {
  test('a canonical-variant suppression removes the row uploaded under the raw source variant', async () => {
    configure({ allow: true });
    global.fetch = okFetch({ id: 'AUDX' });
    // l1's SOURCE email is a dotted gmail variant; the suppression stores the
    // canonical form. The uploaded row hashed the raw variant, so the raw
    // suppression hash alone can never match it — the dropped member's own
    // source string must drive the removal. l1 also shares a household phone
    // with current lead l2 (the retention case).
    tableData.leads = [
      { id: 'l1', email: 'o.p.t.e.d@gmail.com', phone: '9415551111' },
      { id: 'l2', email: 'fine@x.com', phone: '9415551111' },
    ];
    tableData.email_suppressions = [{ email: 'opted@gmail.com' }];
    stateRow = { meta_audience_id: 'AUDX', member_keys: [
      { k: 'lead:l1', d: ['h:o.p.t.e.d@gmail.com', 'h:19415551111'] },
      { k: 'lead:l2', d: ['h:fine@x.com', 'h:19415551111'] },
    ] };
    const r = await MetaAudiences.syncAudience('unbooked_leads', {});
    expect(r.eligible).toBe(1); // l1 dropped at collection (canonical match)
    expect(r.consentRemovals).toBe(1);
    expect(r.toRemove).toBe(1);
    expect(r.retained).toBe(0);
    const del = global.fetch.mock.calls.find((c) => c[1] && c[1].method === 'DELETE');
    expect(JSON.parse(del[1].body).payload.data).toEqual([['h:o.p.t.e.d@gmail.com', 'h:19415551111']]);
  });
});

// ── r4 (Codex): canonical consent hash in state + one-snapshot suppression ──
describe('consent (r4)', () => {
  test('persisted rows carry the canonical consent hash (c)', async () => {
    configure({ allow: true });
    global.fetch = okFetch({ id: 'AUDX' });
    tableData.customers = [{ id: 'c1', email: 'First.Last+promo@Gmail.com', phone: null }];
    await MetaAudiences.syncAudience('customers', {});
    const saved = inserts.filter((x) => x.table === 'ad_audience_syncs').pop();
    const persisted = JSON.parse(saved.row.member_keys);
    expect(persisted[0].c).toBe('h:firstlast@gmail.com'); // canonical, not raw
  });

  test('a variant-uploaded row whose SOURCE was hard-deleted is still consent-removed via its stored canonical hash', async () => {
    configure({ allow: true });
    global.fetch = okFetch({ id: 'AUDX' });
    // l1's source lead is GONE; its state row was uploaded from a dotted
    // variant (raw hash unmatchable from the canonical suppression) but a
    // post-fix sync stamped the canonical hash c. It shares a household phone
    // with current lead l2 — the previously-retained untraceable case.
    tableData.leads = [{ id: 'l2', email: 'fine@x.com', phone: '9415551111' }];
    tableData.email_suppressions = [{ email: 'opted@gmail.com' }];
    stateRow = { meta_audience_id: 'AUDX', member_keys: [
      { k: 'lead:l1', d: ['h:o.p.t.e.d@gmail.com', 'h:19415551111'], c: 'h:opted@gmail.com' },
      { k: 'lead:l2', d: ['h:fine@x.com', 'h:19415551111'], c: 'h:fine@x.com' },
    ] };
    const r = await MetaAudiences.syncAudience('unbooked_leads', {});
    expect(r.consentRemovals).toBe(1);
    expect(r.toRemove).toBe(1);
    expect(r.retained).toBe(0);
  });

  test('ONE suppression snapshot serves both collection and removal (no double load)', async () => {
    configure();
    tableData.leads = [{ id: 'l1', email: 'a@x.com', phone: null }];
    mockDb.mockClear(); // count only THIS sync's loads
    await MetaAudiences.syncAudience('unbooked_leads', {});
    const loads = mockDb.mock.calls.filter((c) => c[0] === 'messaging_suppression').length;
    expect(loads).toBe(1);
  });
});


// ── extra match keys (name / ZIP / city / state / country / external id) ──
describe('extra match keys', () => {
  const JO = { first_name: 'Jo-Ann', last_name: "O'Neil Jr.", city: 'Palmetto', state: 'Florida', zip: '34221-1234' };
  const jo = { fn: 'h:joann', ln: 'h:oneil', zp: 'h:34221', ct: 'h:palmetto', st: 'h:fl', co: 'h:us', xid: 'h:c1' };
  const FULL_SCHEMA = ['EMAIL', 'PHONE', 'FN', 'LN', 'ZIP', 'CT', 'ST', 'COUNTRY', 'EXTERN_ID'];
  const calls = (method, matcher = /\/users$/) => global.fetch.mock.calls
    .filter((c) => c[1] && c[1].method === method && matcher.test(c[0]))
    .map((c) => JSON.parse(c[1].body).payload);
  const savedState = () => JSON.parse(inserts.filter((x) => x.table === 'ad_audience_syncs').pop().row.member_keys);

  test('hashExtras normalizes per Meta rules, then hashes each key', () => {
    expect(MetaAudiences._private.hashExtras({
      firstName: 'Jo-Ann', lastName: "O'Neil Jr.", city: 'Palm  Harbor.', state: 'Florida', zip: '34221-1234', externalId: 'C1',
    })).toEqual({ ...jo, ct: 'h:palmharbor', xid: 'h:c1' });
  });
  test('country only rides with an address/name key; nothing usable → null', () => {
    expect(MetaAudiences._private.hashExtras({ firstName: 'Jo' }).co).toBe('h:us');
    expect(MetaAudiences._private.hashExtras({ externalId: 'c1' })).toEqual({ xid: 'h:c1' });
    expect(MetaAudiences._private.hashExtras({ firstName: 'Unknown', zip: 'K1A 0B1' })).toBeNull();
  });
  test('a new member uploads the full row and persists its hashed extras next to the identity row', async () => {
    configure({ allow: true });
    global.fetch = okFetch({ id: 'AUDX' });
    tableData.customers = [{ id: 'c1', email: 'a@x.com', phone: null, ...JO }];
    stateRow = { meta_audience_id: 'AUDX', member_keys: [] };
    await MetaAudiences.syncAudience('customers', {});
    const [post] = calls('POST');
    expect(post.schema).toEqual(FULL_SCHEMA);
    expect(post.data).toEqual([['h:a@x.com', '', 'h:joann', 'h:oneil', 'h:34221', 'h:palmetto', 'h:fl', 'h:us', 'h:c1']]);
    expect(savedState()).toEqual([expect.objectContaining({ d: ['h:a@x.com', ''], e: jo })]);
  });
  test('a member with only extras (no email/phone) never enters an audience', async () => {
    configure();
    tableData.customers = [{ id: 'c1', email: null, phone: null, ...JO }];
    const r = await MetaAudiences.syncAudience('customers', {});
    expect(r.withMatchKeys).toBe(0);
    expect(r.toAdd).toBe(0);
  });

  test('ROLLOUT: already-uploaded members are enriched by re-adding — never removed, no churn', async () => {
    configure({ allow: true });
    global.fetch = okFetch({ id: 'AUDX' });
    tableData.customers = [
      { id: 'c1', email: 'a@x.com', phone: null, ...JO },
      { id: 'c2', email: 'b@x.com', phone: null }, // no name/address: only the external id is new
    ];
    // both were uploaded under the old email/phone-only shape (no `e`)
    stateRow = { meta_audience_id: 'AUDX', member_keys: [
      { k: 'customer:c1', d: ['h:a@x.com', ''] },
      { k: 'customer:c2', d: ['h:b@x.com', ''] },
    ] };
    const r = await MetaAudiences.syncAudience('customers', {});
    expect(r).toMatchObject({ toAdd: 0, toRemove: 0, retained: 0, toEnrich: 2, memberCount: 2 });
    expect(calls('DELETE')).toEqual([]);
    expect(calls('POST')[0].data).toEqual([
      ['h:a@x.com', '', 'h:joann', 'h:oneil', 'h:34221', 'h:palmetto', 'h:fl', 'h:us', 'h:c1'],
      ['h:b@x.com', '', '', '', '', '', '', '', 'h:c2'],
    ]);
    expect(savedState()).toHaveLength(2);
    // second run: extras unchanged → nothing to send
    stateRow = { meta_audience_id: 'AUDX', member_keys: savedState() };
    global.fetch = okFetch({});
    const r2 = await MetaAudiences.syncAudience('customers', {});
    expect(r2).toMatchObject({ toAdd: 0, toRemove: 0, toEnrich: 0 });
    expect(global.fetch).not.toHaveBeenCalled();
  });
  test('a changed address re-adds the full row; the identity row is unchanged (no remove)', async () => {
    configure();
    tableData.customers = [{ id: 'c1', email: 'a@x.com', phone: null, ...JO, zip: '34222' }];
    stateRow = { meta_audience_id: 'AUDX', member_keys: [{ k: 'customer:c1', d: ['h:a@x.com', ''], e: jo }] };
    expect(await MetaAudiences.syncAudience('customers', {})).toMatchObject({ toAdd: 0, toRemove: 0, toEnrich: 1 });
  });

  test('consent removal of an enriched row deletes BOTH the legacy email/phone row and the exact full row', async () => {
    configure({ allow: true });
    global.fetch = okFetch({ id: 'AUDX' });
    tableData.leads = [];
    tableData.email_suppressions = [{ email: 'opted@x.com' }];
    stateRow = { meta_audience_id: 'AUDX', member_keys: [{ k: 'lead:l1', d: ['h:opted@x.com', ''], e: jo }] };
    const r = await MetaAudiences.syncAudience('unbooked_leads', {});
    expect(r.consentRemovals).toBe(1);
    const dels = calls('DELETE');
    expect(dels).toEqual([
      { schema: ['EMAIL', 'PHONE'], data: [['h:opted@x.com', '']] },
      { schema: FULL_SCHEMA, data: [['h:opted@x.com', '', 'h:joann', 'h:oneil', 'h:34221', 'h:palmetto', 'h:fl', 'h:us', 'h:c1']] },
    ]);
  });
  test('an opted-out lead is dropped whole: none of its name/ZIP/external id is uploaded', async () => {
    configure({ allow: true });
    global.fetch = okFetch({ id: 'AUDX' });
    tableData.leads = [
      { id: 'l1', email: 'opted@x.com', phone: null, ...JO },
      { id: 'l2', email: 'fine@x.com', phone: null, first_name: 'Kay', last_name: 'Ray', zip: '34202' },
    ];
    tableData.email_suppressions = [{ email: 'opted@x.com' }];
    stateRow = { meta_audience_id: 'AUDX', member_keys: [] };
    await MetaAudiences.syncAudience('unbooked_leads', {});
    const sent = JSON.stringify(calls('POST'));
    expect(sent).toContain('h:kay');
    for (const gone of ['opted', 'joann', 'oneil', 'h:34221', 'lead:l1', 'h:palmetto']) expect(sent).not.toContain(gone);
  });
  test('suppression audience KEEPS opted-out customers WITH extras (exclusion list — more keys = better exclusion)', async () => {
    configure();
    tableData.customers = [{ id: 'c1', email: 'opted@x.com', phone: null, ...JO }];
    tableData.email_suppressions = [{ email: 'opted@x.com' }];
    const r = await MetaAudiences.syncAudience('customers', {});
    expect(r.toAdd).toBe(1);
  });
  test('a stale row sharing a current member\'s name+ZIP handle is retained, not deleted', async () => {
    configure({ allow: true });
    global.fetch = okFetch({ id: 'AUDX' });
    tableData.customers = [{ id: 'c1', email: 'new@x.com', phone: null, ...JO }];
    // same person, previously uploaded under another email; the old row's DELETE could match the current member by name+ZIP
    stateRow = { meta_audience_id: 'AUDX', member_keys: [{ k: 'customer:c1', d: ['h:old@x.com', ''], e: { ...jo, xid: 'h:other' } }] };
    const r = await MetaAudiences.syncAudience('customers', {});
    expect(r).toMatchObject({ toAdd: 1, toRemove: 0, retained: 1 });
    expect(calls('DELETE')).toEqual([]);
  });

  test('source fields cleared after enrichment: nothing is sent, the uploaded extras stay remembered, and removal deletes them', async () => {
    configure({ allow: true });
    global.fetch = okFetch({ id: 'AUDX' });
    tableData.customers = [{ id: 'c1', email: 'a@x.com', phone: null }]; // name/ZIP wiped, no external id in the way
    stateRow = { meta_audience_id: 'AUDX', member_keys: [{ k: 'customer:c1', d: ['h:a@x.com', ''], e: jo }] };
    const r = await MetaAudiences.syncAudience('customers', {});
    // the external id is re-derived (same id), so this row still matches the stored latest variant → nothing to send
    expect(r).toMatchObject({ toAdd: 0, toRemove: 0 });
    const kept = savedState();
    expect(kept).toEqual([expect.objectContaining({ d: ['h:a@x.com', ''], e: jo })]);
    // later the member is removed (gone from source) → the uploaded full row is deleted too
    stateRow = { meta_audience_id: 'AUDX', member_keys: kept };
    global.fetch = okFetch({});
    tableData.customers = [];
    await MetaAudiences.syncAudience('customers', {});
    expect(calls('DELETE').map((p) => p.schema)).toEqual([['EMAIL', 'PHONE'], FULL_SCHEMA]);
    expect(calls('DELETE')[1].data).toEqual([['h:a@x.com', '', 'h:joann', 'h:oneil', 'h:34221', 'h:palmetto', 'h:fl', 'h:us', 'h:c1']]);
  });
  test('address change: the new row is sent, the old variant is remembered, and removal deletes BOTH full rows', async () => {
    configure({ allow: true });
    global.fetch = okFetch({ id: 'AUDX' });
    tableData.customers = [{ id: 'c1', email: 'a@x.com', phone: null, ...JO, zip: '34222' }];
    stateRow = { meta_audience_id: 'AUDX', member_keys: [{ k: 'customer:c1', d: ['h:a@x.com', ''], e: jo }] };
    const r = await MetaAudiences.syncAudience('customers', {});
    expect(r).toMatchObject({ toEnrich: 1, toRemove: 0 });
    expect(calls('POST')[0].data).toHaveLength(1);
    const saved = savedState();
    expect(saved[0].e.zp).toBe('h:34222');
    expect(saved[0].o).toEqual([jo]);
    // member leaves → both variants deleted
    stateRow = { meta_audience_id: 'AUDX', member_keys: saved };
    global.fetch = okFetch({});
    tableData.customers = [];
    await MetaAudiences.syncAudience('customers', {});
    const full = calls('DELETE').find((p) => p.schema.length === 9);
    expect(full.data.map((row) => row[4]).sort()).toEqual(['h:34221', 'h:34222']);
  });
  test('shared-handle guards consider EARLIER variants too (a stale row is retained when an old variant shares a handle)', async () => {
    configure({ allow: true });
    global.fetch = okFetch({ id: 'AUDX' });
    tableData.customers = [{ id: 'c1', email: 'new@x.com', phone: null, ...JO }];
    const older = { ...jo, xid: 'h:other' };
    stateRow = { meta_audience_id: 'AUDX', member_keys: [{ k: 'customer:c1', d: ['h:old@x.com', ''], e: { fn: 'h:zz', ln: 'h:zz', zp: 'h:zz' }, o: [older] }] };
    expect(await MetaAudiences.syncAudience('customers', {})).toMatchObject({ toAdd: 1, toRemove: 0, retained: 1 });
  });
});
