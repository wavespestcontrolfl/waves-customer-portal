// Tests services/ads/meta-audiences.js — Meta Custom Audiences sync (suppression + retargeting).

let tableData = {};   // { customers: [...], leads: [...] } returned by .select(); a function gets the ids a whereIn('id') asked for
let stateRow = null;  // ad_audience_syncs .first()
const inserts = [];

const mockDb = jest.fn((table) => {
  const b = {};
  ['where', 'whereNull', 'whereNotNull', 'orWhereNotNull', 'whereRaw', 'andWhere', 'whereNotExists'].forEach((m) => {
    b[m] = jest.fn(() => b);
  });
  b.whereIn = jest.fn((col, ids) => { if (col === 'id') b.ids = ids; return b; });
  b.select = jest.fn(() => Promise.resolve(typeof tableData[table] === 'function' ? tableData[table](b.ids) : tableData[table] || []));
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
    expect(m).toEqual([expect.objectContaining({ key: 'customer:c1', email: 'c1@x.com', phone: '9412975749' })]);
  });
  test('leads → lead:<id> keys', async () => {
    tableData.leads = [{ id: 'l1', email: 'l1@x.com', phone: null }];
    const m = await collectUnbookedLeadMembers();
    expect(m).toEqual([expect.objectContaining({ key: 'lead:l1', email: 'l1@x.com', phone: null })]);
    expect(m[0]).not.toHaveProperty('internalTest');
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
    expect(JSON.parse(post[1].body).payload.data).toEqual([['h:new@x.com', '', '', '', '', '']]);
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
    expect(body.payload.schema).toEqual(['EMAIL', 'PHONE', 'FN', 'LN', 'ZIP', 'COUNTRY']);
    // no name/ZIP on file: the four extra slots are blank, never invented
    expect(body.payload.data).toEqual([['h:c1@x.com', 'h:19412975749', '', '', '', '']]);
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

describe('unbooked lead status rule (owner 2026-11-02 "B")', () => {
  const knexPg = require('knex')({ client: 'pg' });
  const { unbookedLeadStatusFilter } = MetaAudiences._private;
  const leadsBuilder = () => {
    const i = mockDb.mock.calls.findIndex((c) => c[0] === 'leads');
    return mockDb.mock.results[i].value;
  };

  test('a lead parked unresponsive with reason no_response stays in; other unresponsive leads stay out', () => {
    const { sql, bindings } = unbookedLeadStatusFilter(knexPg('leads')).select('id').toSQL();
    expect(sql).toMatch(/where \(LOWER\(COALESCE\(status, ''\)\) NOT IN \((\?,)+\?\) or \(LOWER\(COALESCE\(status, ''\)\) = 'unresponsive' and "lost_reason" = \?\)\)$/);
    expect(bindings[bindings.length - 1]).toBe('no_response');
    // 'unresponsive' is still in the closed list: only the no_response branch lets one back in.
    expect(bindings.slice(0, -1)).toContain('unresponsive');
  });

  test('the collector applies the rule', async () => {
    tableData.leads = [];
    mockDb.mockClear();
    await collectUnbookedLeadMembers();
    expect(leadsBuilder().where.mock.calls[0][0].name).toBe('openOrQuietNoResponse');
    expect(leadsBuilder().whereRaw).not.toHaveBeenCalled();
  });
});

describe('internal test records never reach the lists (owner 2026-11-19)', () => {
  // The listed test name, read from the list so no real name is written here.
  const { INTERNAL_TEST_CUSTOMERS } = require('../services/internal-test-customers');
  const [LISTED_FIRST, ...LISTED_REST] = INTERNAL_TEST_CUSTOMERS[0].split(' ');
  const LISTED_LAST = LISTED_REST.join(' ');
  // A fictional owner cell: the rule reads ADAM_PHONE, never a number in code.
  const OWNER_CELL = '(941) 555-0177';
  const savedOwnerPhone = process.env.ADAM_PHONE;
  beforeEach(() => { process.env.ADAM_PHONE = '+19415550177'; });
  afterAll(() => {
    if (savedOwnerPhone === undefined) delete process.env.ADAM_PHONE; else process.env.ADAM_PHONE = savedOwnerPhone;
  });
  test('customers collector drops test name, owner cell, demo email and demo id', async () => {
    tableData.customers = [
      { id: 'real1', email: 'real1@x.com', phone: '9412975749', first_name: 'Pat', last_name: 'Sample' },
      { id: 't1', email: 'a@x.com', phone: '9415550101', first_name: LISTED_FIRST, last_name: LISTED_LAST },
      { id: 't2', email: 'b@x.com', phone: OWNER_CELL, first_name: 'Sam', last_name: 'Other' },
      { id: 't3', email: 'appreview+demo@wavespestcontrol.com', phone: null, first_name: 'Demo', last_name: 'User' },
      { id: '3274944a-f509-413c-9dee-a8b0cdb16493', email: 'c@x.com', phone: null, first_name: 'X', last_name: 'Y' },
      { id: 't5', email: 'd@x.com', phone: null, first_name: 'Shakedown', last_name: 'Test (internal)' },
    ];
    const m = await collectCustomerMembers();
    expect(m.map((x) => x.key)).toEqual(['customer:real1']);
  });
  test('leads collector drops a lead on the owner cell and a lead linked to a test customer', async () => {
    tableData.leads = [
      { id: 'l1', email: 'l1@x.com', phone: null, first_name: 'Pat', last_name: 'Sample', zip: '34219' },
      { id: 'l2', email: null, phone: OWNER_CELL, first_name: 'Pat', last_name: 'Sample' },
      { id: 'l3', email: 'l3@x.com', phone: null, customer_id: 'cT' },
    ];
    tableData.customers = [{ id: 'cT', email: 'x@x.com', phone: null, first_name: LISTED_FIRST, last_name: LISTED_LAST }];
    const m = await collectUnbookedLeadMembers();
    expect(m.map((x) => x.key)).toEqual(['lead:l1']);
    expect(m[0]).toMatchObject({ firstName: 'Pat', lastName: 'Sample', zip: '34219' });
  });
  test('a deleted linked customer lends no name or ZIP; a deleted test customer still drops its lead', async () => {
    tableData.leads = [
      { id: 'l1', email: 'pat@x.com', phone: null, first_name: null, last_name: null, zip: null, customer_id: 'cGone' },
      { id: 'l2', email: 'l2@x.com', phone: null, customer_id: 'cGoneTest' },
    ];
    tableData.customers = [
      { id: 'cGone', email: 'pat@x.com', phone: null, first_name: 'Pat', last_name: 'Sample', zip: '34219', deleted_at: '2026-11-01T12:00:00Z' },
      { id: 'cGoneTest', email: 'x@x.com', phone: null, first_name: LISTED_FIRST, last_name: LISTED_LAST, deleted_at: '2026-11-01T12:00:00Z' },
    ];
    const m = await collectUnbookedLeadMembers();
    expect(m.map((x) => x.key)).toEqual(['lead:l1']);
    expect(m[0]).toMatchObject({ firstName: null, lastName: null, zip: null });
  });
  test('a dropped test record already uploaded is removed by the daily delta', async () => {
    configure();
    tableData.customers = [{ id: 'real1', email: 'real1@x.com', phone: null, first_name: 'Pat', last_name: 'Sample' }];
    stateRow = { meta_audience_id: 'AUD', member_keys: [{ k: 'customer:t1', d: ['h:test@x.com', 'h:19415550177'] }] };
    const r = await MetaAudiences.syncAudience('customers', {});
    expect(r.toRemove).toBe(1);
    expect(r.toAdd).toBe(1);
  });
  test('an uploaded test record goes even when it shares a phone with a current member; that member re-adds next run', async () => {
    configure();
    tableData.customers = [
      { id: 'real1', email: 'real1@x.com', phone: '9415550140', first_name: null, last_name: null },
      { id: 't1', email: 'tester@x.com', phone: '9415550140', first_name: 'Shakedown', last_name: 'Test (internal)' },
    ];
    stateRow = { meta_audience_id: 'AUD', member_keys: [
      { k: 'customer:real1', d: ['h:real1@x.com', 'h:19415550140'] },
      { k: 'customer:t1', d: ['h:tester@x.com', 'h:19415550140'] },
    ] };
    const r = await MetaAudiences.syncAudience('customers', {});
    expect(r).toMatchObject({ toRemove: 1, retained: 0, testRemovals: 1, deferredReAdds: 1 });
  });
  test('an uploaded test record goes even when a member has its exact email and phone; the member is sent with its own name and ZIP', async () => {
    configure({ allow: true });
    global.fetch = okFetch({ id: 'AUD' });
    tableData.customers = [
      { id: 'real1', email: 'same@x.com', phone: '9415550140', first_name: 'Pat', last_name: 'Sample', zip: '34219' },
      { id: 't1', email: 'same@x.com', phone: '9415550140', first_name: 'Shakedown', last_name: 'Test', zip: '34202' },
    ];
    const testX = ['h:shakedown', 'h:test', 'h:34202', 'h:us'];
    stateRow = { meta_audience_id: 'AUD', member_keys: [{ k: 'customer:t1', d: ['h:same@x.com', 'h:19415550140'], x: testX }] };
    const r = await MetaAudiences.syncAudience('customers', {});
    expect(r).toMatchObject({ toAdd: 1, toEnrich: 0, toRemove: 1, testRemovals: 1, deferredReAdds: 1 });
    const users = global.fetch.mock.calls
      .filter((c) => /\/users$/.test(c[0]))
      .map((c) => [c[1].method, JSON.parse(c[1].body).payload.data]);
    expect(users).toEqual([
      ['POST', [['h:same@x.com', 'h:19415550140', 'h:pat', 'h:sample', 'h:34219', 'h:us']]],
      ['DELETE', [['h:same@x.com', 'h:19415550140', ...testX]]],
    ]);
    // The DELETE runs after the add, so the member is left out of state and sent again next run.
    const saved = JSON.parse(inserts.filter((i) => i.table === 'ad_audience_syncs').pop().row.member_keys);
    expect(saved).toEqual([]);
  });
  test('LEAD_CLOSED already keeps disqualified, duplicate and spam out; no_response unresponsive stays in', () => {
    const { unbookedLeadStatusFilter } = MetaAudiences._private;
    expect(typeof unbookedLeadStatusFilter).toBe('function');
    const src = require('fs').readFileSync(require.resolve('../services/ads/meta-audiences'), 'utf8');
    expect(src).toMatch(/LEAD_CLOSED = \[[\s\S]*'disqualified'[\s\S]*'spam'[\s\S]*'duplicate'/);
    expect(src).toMatch(/lost_reason', 'no_response'/);
  });
});

describe('name + ZIP on the Meta list (2b)', () => {
  const NAMED = { id: 'c1', email: 'c1@x.com', phone: '9412975749', first_name: 'Pat', last_name: "O'Neil-Smith", zip: '34219-1234', city: 'Parrish', state: 'FL' };

  test('hashIdentity: Meta normalization (lowercase, no punctuation, 5-digit ZIP, country us)', () => {
    const { hashIdentity } = MetaAudiences._private;
    expect(hashIdentity({ firstName: ' Pat ', lastName: "O'Neil-Smith", zip: '34219-1234' }))
      .toEqual(['h:pat', 'h:oneilsmith', 'h:34219', 'h:us']);
    expect(hashIdentity({ firstName: 'Pat', lastName: null, zip: null })).toEqual(['h:pat', '', '', 'h:us']);
    expect(hashIdentity({ firstName: null, lastName: null, zip: null })).toBeNull();
  });

  test('adds carry FN/LN/ZIP/COUNTRY under the 6-key schema; row identity stays email|phone', async () => {
    configure({ allow: true });
    global.fetch = okFetch({ id: 'AUD' });
    tableData.customers = [NAMED];
    await MetaAudiences.syncAudience('customers', {});
    const call = global.fetch.mock.calls.find((c) => /\/users$/.test(c[0]));
    const body = JSON.parse(call[1].body);
    expect(body.payload.schema).toEqual(['EMAIL', 'PHONE', 'FN', 'LN', 'ZIP', 'COUNTRY']);
    expect(body.payload.data).toEqual([['h:c1@x.com', 'h:19412975749', 'h:pat', 'h:oneilsmith', 'h:34219', 'h:us']]);
    const saved = JSON.parse(inserts.filter((x) => x.table === 'ad_audience_syncs').pop().row.member_keys);
    expect(saved[0].d).toEqual(['h:c1@x.com', 'h:19412975749']);
    expect(saved[0].x).toEqual(['h:pat', 'h:oneilsmith', 'h:34219', 'h:us']);
  });

  test('one-time upgrade: a member stored before this change is re-added once with its name, nobody is wiped', async () => {
    configure({ allow: true });
    global.fetch = okFetch({ id: 'AUD' });
    tableData.customers = [NAMED];
    stateRow = { meta_audience_id: 'AUD', member_keys: [{ k: 'customer:c1', d: ['h:c1@x.com', 'h:19412975749'], c: 'h:c1@x.com' }] };
    const r = await MetaAudiences.syncAudience('customers', {});
    expect(r.toEnrich).toBe(1);
    expect(r.toAdd).toBe(0);
    expect(r.toRemove).toBe(0);
    const calls = global.fetch.mock.calls.filter((c) => /\/users$/.test(c[0]));
    expect(calls).toHaveLength(1);
    expect(calls[0][1].method).toBe('POST');
  });

  test('second run with the same name hashes sends nothing', async () => {
    configure();
    tableData.customers = [NAMED];
    stateRow = { meta_audience_id: 'AUD', member_keys: [{ k: 'customer:c1', d: ['h:c1@x.com', 'h:19412975749'], x: ['h:pat', 'h:oneilsmith', 'h:34219', 'h:us'] }] };
    const r = await MetaAudiences.syncAudience('customers', {});
    expect(r.toAdd + r.toEnrich + r.toRemove).toBe(0);
  });

  test('a removal sends the row that was added: 6-key with the stored name/ZIP, 2-key for a row stored before', async () => {
    configure({ allow: true });
    global.fetch = okFetch({ id: 'AUD' });
    tableData.customers = [];
    stateRow = { meta_audience_id: 'AUD', member_keys: [
      { k: 'customer:gone', d: ['h:gone@x.com', 'h:19415550111'], x: ['h:a', 'h:b', 'h:c', 'h:us'] },
      { k: 'customer:old', d: ['h:old@x.com', ''] },
    ] };
    const r = await MetaAudiences.syncAudience('customers', {});
    expect(r.removed).toBe(2);
    const bodies = global.fetch.mock.calls
      .filter((c) => /\/users$/.test(c[0]) && c[1].method === 'DELETE')
      .map((c) => JSON.parse(c[1].body).payload);
    expect(bodies).toEqual([
      { schema: ['EMAIL', 'PHONE'], data: [['h:old@x.com', '']] },
      { schema: ['EMAIL', 'PHONE', 'FN', 'LN', 'ZIP', 'COUNTRY'], data: [['h:gone@x.com', 'h:19415550111', 'h:a', 'h:b', 'h:c', 'h:us']] },
    ]);
  });

  test('sent name/ZIP hashes stay the row\'s: an edited name is not re-sent and the stored hashes are kept', async () => {
    configure({ allow: true });
    global.fetch = okFetch({ id: 'AUD' });
    tableData.customers = [{ ...NAMED, last_name: 'Smith' }];
    const x = ['h:pat', 'h:oneilsmith', 'h:34219', 'h:us'];
    stateRow = { meta_audience_id: 'AUD', member_keys: [{ k: 'customer:c1', d: ['h:c1@x.com', 'h:19412975749'], c: 'h:c1@x.com', x }] };
    const r = await MetaAudiences.syncAudience('customers', {});
    expect(r.toAdd + r.toEnrich + r.toRemove).toBe(0);
    const saved = JSON.parse(inserts.filter((i) => i.table === 'ad_audience_syncs').pop().row.member_keys);
    expect(saved[0].x).toEqual(x);
  });

  test('a full name + ZIP is a shared key: a leaving row holding it is retained; a ZIP alone is not a key', async () => {
    configure();
    // c3 holds only the same ZIP: that must not keep lead:zip in the audience.
    tableData.customers = [NAMED, { id: 'c3', email: 'c3@x.com', phone: null, first_name: null, last_name: null, zip: '34219' }];
    stateRow = { meta_audience_id: 'AUD', member_keys: [
      { k: 'customer:c1', d: ['h:c1@x.com', 'h:19412975749'], x: ['h:pat', 'h:oneilsmith', 'h:34219', 'h:us'] },
      { k: 'lead:dup', d: ['h:other@x.com', ''], x: ['h:pat', 'h:oneilsmith', 'h:34219', 'h:us'] },
      { k: 'lead:zip', d: ['h:zip@x.com', ''], x: ['', '', 'h:34219', 'h:us'] },
    ] };
    const r = await MetaAudiences.syncAudience('customers', {});
    expect(r.retained).toBe(1); // lead:dup: its DELETE could drop the current member
    expect(r.toRemove).toBe(1); // lead:zip: same ZIP only, safe to remove
  });

  test('a name + ZIP the member never sent holds back no removal', async () => {
    configure();
    // c1 was sent with ZIP 34219 and has moved to 34202 since; its stored keys stay.
    tableData.customers = [{ ...NAMED, zip: '34202' }];
    stateRow = { meta_audience_id: 'AUD', member_keys: [
      { k: 'customer:c1', d: ['h:c1@x.com', 'h:19412975749'], x: ['h:pat', 'h:oneilsmith', 'h:34219', 'h:us'] },
      // Another person with the same name, in 34202, who has left the list.
      { k: 'lead:gone', d: ['h:gone@x.com', ''], x: ['h:pat', 'h:oneilsmith', 'h:34202', 'h:us'] },
    ] };
    const r = await MetaAudiences.syncAudience('customers', {});
    expect(r).toMatchObject({ toRemove: 1, retained: 0, toAdd: 0, toEnrich: 0 });
  });

  test('a wrong-number phone never makes a lead and its customer one person: no borrowed name or ZIP', async () => {
    tableData.messaging_suppression = [{ phone: '+19415550123', reason: 'wrong_number' }];
    tableData.leads = [{ id: 'l1', email: 'lead@x.com', phone: '9415550123', first_name: null, last_name: null, zip: null, customer_id: 'c9' }];
    tableData.customers = [{ id: 'c9', email: 'other@x.com', phone: '(941) 555-0123', first_name: 'Jo', last_name: 'Lee', zip: '34202' }];
    const [m] = await collectUnbookedLeadMembers();
    expect(m).toMatchObject({ email: 'lead@x.com', phone: null, firstName: null, lastName: null, zip: null });
    // The same two records with a working number are one person.
    tableData.messaging_suppression = [];
    const [ok] = await collectUnbookedLeadMembers();
    expect(ok).toMatchObject({ phone: '9415550123', firstName: 'Jo', lastName: 'Lee', zip: '34202' });
  });

  test("a lead whose linked customer opted out is not uploaded, and its row (with the customer's name and ZIP) leaves even beside a current member", async () => {
    // l1 and its customer c9 share a phone but not an email; c9 opted out by email.
    tableData.email_suppressions = [{ email: 'jo.lee@x.com' }];
    tableData.leads = [
      { id: 'l1', email: 'lead@x.com', phone: '9415550123', first_name: null, last_name: null, zip: null, customer_id: 'c9' },
      { id: 'l2', email: 'house@x.com', phone: '9415550123' },
    ];
    tableData.customers = [{ id: 'c9', email: 'jo.lee@x.com', phone: '(941) 555-0123', first_name: 'Jo', last_name: 'Lee', zip: '34202' }];
    const collected = await collectUnbookedLeadMembers({ partition: true });
    expect(collected.kept.map((m) => m.key)).toEqual(['lead:l2']);
    expect(collected.optOutKeys).toEqual(['lead:l1']);
    // l1 was uploaded before c9 opted out, with c9's name and ZIP; l2 shares its phone.
    configure({ allow: true });
    global.fetch = okFetch({ id: 'AUD' });
    const joX = ['h:jo', 'h:lee', 'h:34202', 'h:us'];
    stateRow = { meta_audience_id: 'AUD', member_keys: [
      { k: 'lead:l1', d: ['h:lead@x.com', 'h:19415550123'], x: joX },
      { k: 'lead:l2', d: ['h:house@x.com', 'h:19415550123'] },
    ] };
    const r = await MetaAudiences.syncAudience('unbooked_leads', {});
    expect(r).toMatchObject({ toRemove: 1, retained: 0, consentRemovals: 1, testRemovals: 0, deferredReAdds: 1 });
    const del = global.fetch.mock.calls.find((c) => /\/users$/.test(c[0]) && c[1].method === 'DELETE');
    expect(JSON.parse(del[1].body).payload.data).toEqual([['h:lead@x.com', 'h:19415550123', ...joX]]);
    // Deleted or not, the linked customer's opt-out is the lead's.
    tableData.customers[0].deleted_at = '2026-11-01T12:00:00Z';
    expect((await collectUnbookedLeadMembers()).map((m) => m.key)).toEqual(['lead:l2']);
  });

  test('a stored lead no longer collected leaves on its linked customer opt-out too, even beside a current member', async () => {
    tableData.email_suppressions = [{ email: 'jo.lee@x.com' }];
    const stale = { id: 'l1', customer_id: 'c9' };
    const housemate = { id: 'l2', email: 'house@x.com', phone: '9415550123' };
    // l1 closed or aged out: the collection query no longer returns it, a lookup by id does.
    tableData.leads = (ids) => (ids ? [stale, housemate].filter((r) => ids.includes(r.id)) : [housemate]);
    tableData.customers = [{ id: 'c9', email: 'jo.lee@x.com', phone: '(941) 555-0123', first_name: 'Jo', last_name: 'Lee', zip: '34202' }];
    configure({ allow: true });
    global.fetch = okFetch({ id: 'AUD' });
    const joX = ['h:jo', 'h:lee', 'h:34202', 'h:us'];
    const stored = [
      { k: 'lead:l1', d: ['h:lead@x.com', 'h:19415550123'], x: joX },
      { k: 'lead:l2', d: ['h:house@x.com', 'h:19415550123'] },
    ];
    stateRow = { meta_audience_id: 'AUD', member_keys: stored };
    const r = await MetaAudiences.syncAudience('unbooked_leads', {});
    expect(r).toMatchObject({ toRemove: 1, retained: 0, consentRemovals: 1, testRemovals: 0, deferredReAdds: 1 });
    const del = global.fetch.mock.calls.find((c) => /\/users$/.test(c[0]) && c[1].method === 'DELETE');
    expect(JSON.parse(del[1].body).payload.data).toEqual([['h:lead@x.com', 'h:19415550123', ...joX]]);
    // Deleted or not, the customer's opt-out holds; a customer who did not opt out keeps the row.
    const { staleLeadOptOutKeys } = MetaAudiences._private;
    const { loadMarketingSuppression } = require('../services/ads/ad-audience-consent');
    tableData.customers[0].deleted_at = '2026-11-01T12:00:00Z';
    expect(await staleLeadOptOutKeys(stored, [{ key: 'lead:l2' }], await loadMarketingSuppression())).toEqual(['lead:l1']);
    tableData.email_suppressions = [];
    expect(await staleLeadOptOutKeys(stored, [], await loadMarketingSuppression())).toEqual([]);
  });
});
