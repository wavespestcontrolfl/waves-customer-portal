/**
 * delete_duplicate_customer — owner ruling 2026-10-07 (Q3): "soft-delete for
 * empty stubs only (no visits, invoices, payments), carded, restorable."
 *
 * ARCHIVE ONLY: the commit is the customer page's delete handler
 * (admin-customers.js archiveCustomerAsAdmin, mocked here and proven against
 * the real handler in admin-customers-archive-relink.test.js) with the
 * decisive checks in its `precheck`. The emptiness readers (customer-dedupe.js
 * loserAutoBlockers, previewMergeEffects, nonFkMergeRewrites), the queue
 * (duplicateWinnerFor) and the pair lock are mocked: this suite proves the
 * order of the locked checks, what refuses, and that the merge executor is
 * never called. Allow-list and schema-default rules are proven on the real
 * customer-empty-loser module over a mocked information_schema. All names
 * synthetic.
 */

jest.mock('../models/db', () => {
  const state = { stub: null, winner: null, twins: [], counts: {}, properties: [], sibling: null, columnRows: [], selfRefRows: [], selfRefCounts: {}, columnsError: false, selfRefError: false };
  const builder = (table) => {
    const q = { _table: table, _single: false, _count: false, _where: {} };
    q.where = (arg) => { if (arg && typeof arg === 'object') Object.assign(q._where, arg); else if (typeof arg === 'function') arg({ orWhereRaw: () => null, orWhere: (col) => { q._orCol = col; } }); return q; };
    q.whereNull = () => q;
    q.whereNot = () => q;
    q.whereIn = () => q;
    q.orderBy = () => q;
    q.select = () => q;
    // `await conn('customer_properties').where(...).select('*')` reads the rows.
    q.then = (resolve, reject) => Promise.resolve(table === 'customer_properties' ? state.properties : []).then(resolve, reject);
    q.count = () => { q._count = true; return q; };
    q.limit = async () => (table === 'customers' ? state.twins : []);
    q.first = async () => {
      if (table === 'customers' && q._orCol) {
        const n = state.selfRefCounts[q._orCol];
        if (n === 'throw') throw new Error('count failed');
        return { n: n || 0 };
      }
      if (table === 'customers' && q._where.account_id) return state.sibling;
      if (table === 'customers' && state.winner && q._where.id === state.winner.id) return state.winner;
      if (table === 'customers') return state.stub;
      if (q._count) return { n: state.counts[table] || 0 };
      return null;
    };
    q.update = jest.fn(async () => { throw new Error('the tool must never write directly'); });
    q.insert = q.update;
    q.del = q.update;
    return q;
  };
  const db = jest.fn((table) => builder(table));
  // information_schema reads answer rows (a promise); every other raw is a
  // select fragment.
  db.raw = jest.fn((sql) => {
    if (String(sql).includes('is_generated')) return state.columnsError ? Promise.reject(new Error('schema unreadable')) : Promise.resolve({ rows: state.columnRows });
    if (String(sql).includes('constraint_type')) return state.selfRefError ? Promise.reject(new Error('schema unreadable')) : Promise.resolve({ rows: state.selfRefRows });
    return sql;
  });
  db.__state = state;
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const mockLoserAutoBlockers = jest.fn();
const mockPreviewMergeEffects = jest.fn();
const mockNonFkMergeRewrites = jest.fn();
const mockDuplicateWinnerFor = jest.fn();
const mockPairLock = jest.fn();
jest.mock('../services/customer-dedupe', () => ({
  loserAutoBlockers: (...args) => mockLoserAutoBlockers(...args),
  previewMergeEffects: (...args) => mockPreviewMergeEffects(...args),
  nonFkMergeRewrites: (...args) => mockNonFkMergeRewrites(...args),
  // The duplicate queue's own answer from ONE queue build, and the pair lock
  // (the real rules are proven in the customer-dedupe suites).
  duplicateWinnerFor: (...args) => mockDuplicateWinnerFor(...args),
  acquirePairAdjudicationLock: (...args) => mockPairLock(...args),
  // The REAL note-append rule: its column list decides what is customer text.
  predictNoteAppends: jest.requireActual('../services/customer-dedupe').predictNoteAppends,
  // The REAL exclusion list: every table the merge reader skips is counted.
  REPOINT_EXCLUDED_TABLES: jest.requireActual('../services/customer-dedupe').REPOINT_EXCLUDED_TABLES,
}));

const mockArchiveCustomerAsAdmin = jest.fn();
jest.mock('../routes/admin-customers', () => ({
  archiveCustomerAsAdmin: (...args) => mockArchiveCustomerAsAdmin(...args),
}));

const fs = require('fs');
const path = require('path');
const db = require('../models/db');
const { executeCustomerLifecycleTool } = require('../services/intelligence-bar/customer-lifecycle-tools');
const AuthorizationContract = require('../services/intelligence-bar/authorization-contract');
const emptyLoser = require('../services/customer-empty-loser');

const STUB_ID = '20000000-0000-4000-8000-000000000001';
const TWIN_ID = '20000000-0000-4000-8000-000000000002';
const baseStub = () => ({
  id: STUB_ID, first_name: 'Unknown', last_name: '', phone: '(941) 555-0199', email: null,
  address_line1: '12 Sample Lane', address_line2: null, city: 'Bradenton', state: 'FL', zip: '34208',
  deleted_at: null, version: '2026-10-01 12:00:00.000001+00', created_at: '2026-10-01T15:00:00Z',
  waveguard_tier: null, monthly_rate: '0.00', account_credits: '0.00', crm_notes: null, technician_notes: null,
  service_contact_name: null, service_contact2_phone: null, reservice_token: 'tok_generated_by_the_database',
});
const baseWinner = () => ({
  id: TWIN_ID, first_name: 'Jordan', last_name: 'Sample', phone: '9415550199', email: 'jordan.sample@example.com',
  deleted_at: null, version: '2026-09-01 08:00:00.000001+00', created_at: '2025-03-14T15:00:00Z',
});
// The untouched primary the backfill (ensurePrimaryCore) creates from the
// customer's own address.
const autoPrimary = () => ({
  id: 'prop-1', customer_id: STUB_ID, label: 'Primary', occupancy_type: 'owner_occupied', relationship: null, is_primary: true,
  address_line1: '12 Sample Lane', address_line2: null, city: 'Bradenton', state: 'FL', zip: '34208', latitude: null, longitude: null,
  property_type: null, lawn_type: null, property_sqft: null, lot_sqft: null, bed_sqft: null, linear_ft_perimeter: null, palm_count: null, canopy_type: null,
  address_key: require('../services/customer-properties').addressKey(baseStub()), source: 'backfill', active: true,
  neighborhood_id: null, neighborhood_source: null, county_subdivision: null, neighborhood_checked_at: null,
  created_at: new Date('2026-10-01'), updated_at: new Date('2026-10-01'),
});
// The customers columns the mock schema reports (name, default). Real defaults
// are read from information_schema at runtime; these mirror their shapes.
const COLUMN_ROWS = [
  ['id', null], ['first_name', null], ['last_name', null], ['phone', null], ['email', null], ['state', "'FL'::character varying"],
  ['created_at', 'now()'], ['updated_at', 'now()'], ['deleted_at', null], ['active', 'true'],
  ['waveguard_tier', null], ['monthly_rate', '0.00'], ['account_credits', '0.00'], ['crm_notes', null], ['technician_notes', null],
  ['service_contact_name', null], ['service_contact2_phone', null],
  ['gate_code', null], ['access_notes', null], ['pet_info', null], ['follow_up_notes', null], ['secondary_phone', null],
  ['referred_by_customer_id', null], ['reservice_token', "encode(gen_random_bytes(32), 'hex'::text)"], ['autopay_enabled', 'false'],
  ['tags', "'{}'::jsonb"], ['sms_opt_out_reason', "'none'::text"],
].map(([column_name, column_default]) => ({ column_name, column_default, is_generated: 'NEVER' }));
// The content pins the card carries: a fingerprint of the allow-listed columns.
const stubPin = (row = baseStub()) => emptyLoser.contentFingerprint(row);
const keeperPin = (row = baseWinner()) => emptyLoser.contentFingerprint(row);
const eligibleVerdict = (winnerId = TWIN_ID) => ({ winnerId, eligible: true, code: 'eligible', reason: null, candidate: {} });

const run = (input, ctx = {}) => executeCustomerLifecycleTool('delete_duplicate_customer', input, ctx);
const preview = () => run({ customer_id: STUB_ID });
const commit = (ctx = {}) => run({ customer_id: STUB_ID }, { confirmed: true, technicianId: 'admin-7', ...ctx });

beforeEach(() => {
  jest.clearAllMocks();
  process.env.GATE_IB_DELETE_CUSTOMER = 'true';
  db.__state.stub = baseStub();
  db.__state.winner = baseWinner();
  db.__state.twins = [];
  db.__state.sibling = null;
  db.__state.counts = {};
  db.__state.properties = [autoPrimary()];
  emptyLoser._resetCaches();
  db.__state.columnRows = COLUMN_ROWS.map((r) => ({ ...r }));
  db.__state.selfRefRows = [{ column_name: 'referred_by_customer_id' }];
  db.__state.selfRefCounts = {};
  db.__state.columnsError = false;
  db.__state.selfRefError = false;
  mockPairLock.mockResolvedValue(undefined);
  mockLoserAutoBlockers.mockResolvedValue([]);
  mockNonFkMergeRewrites.mockResolvedValue({});
  // Default: the duplicate queue lists the stub as a mergeable duplicate of the twin.
  mockDuplicateWinnerFor.mockResolvedValue(eligibleVerdict());
  // The real adapter runs `precheck` inside the archive transaction before
  // any write (proven in admin-customers-archive-relink.test.js); here the
  // transaction is the db mock and a precheck throw rejects, writing nothing.
  mockArchiveCustomerAsAdmin.mockImplementation(async ({ precheck }) => {
    if (precheck) await precheck(db);
    return { status: 200, json: { success: true } };
  });
  // One auto-created primary property and the nightly health score: allowed.
  mockPreviewMergeEffects.mockResolvedValue({ moving: { customer_properties: 1, customer_health_scores: 1, total_rows: 2 }, referral: { loser_enrolled: false } });
});
afterAll(() => { delete process.env.GATE_IB_DELETE_CUSTOMER; });

describe('gate', () => {
  test.each([undefined, 'false', '1', 'on', 'TRUE'])('GATE_IB_DELETE_CUSTOMER=%s: refuses before any read, preview and commit alike', async (value) => {
    if (value === undefined) delete process.env.GATE_IB_DELETE_CUSTOMER; else process.env.GATE_IB_DELETE_CUSTOMER = value;
    expect(await preview()).toMatchObject({ code: 'gate_off', error: expect.stringMatching(/GATE_IB_DELETE_CUSTOMER/) });
    expect(await commit()).toMatchObject({ code: 'gate_off' });
    expect(db).not.toHaveBeenCalled();
    expect(mockArchiveCustomerAsAdmin).not.toHaveBeenCalled();
  });
});

describe('preview (empty stub)', () => {
  test('returns the card: the stub, the record it duplicates, every check, the restore line, the write window, no customer message', async () => {
    const result = await preview();
    expect(result.error).toBeUndefined();
    expect(result).toMatchObject({
      preview: true,
      customer_id: STUB_ID,
      stub: { name: 'Unknown', phone_masked: '(***) ***-0199', email_masked: null, created_on: '2026-10-01' },
      duplicate_of: { customer_id: TWIN_ID, name: 'Jordan Sample', phone_masked: '(***) ***-0199', email_masked: 'j***@example.com', created_on: '2025-03-14', version: keeperPin() },
      customer_message: 'No customer message is sent',
      _version: stubPin(),
    });
    expect(Object.values(result.checks).every((v) => v === 'none')).toBe(true);
    expect(Object.keys(result.checks)).toEqual(expect.arrayContaining(['Visits', 'Service records', 'Invoices', 'Payments, saved cards, Stripe profile',
      'Estimates', 'Leads', 'Calls, texts, emails', 'Plan-rate ledger', 'Monthly rate, plan, billing', 'Portal login', 'Referral or credit balance',
      'Other live members of its account', 'Other customer records pointing at it (referrals)']));
    expect(result.card).toMatchObject({
      delete: 'Delete the empty duplicate record Unknown (phone (***) ***-0199), created 2026-10-01',
      duplicate_of: 'Jordan Sample (phone (***) ***-0199, email j***@example.com), created 2025-03-14; stays as is',
      how: 'It is archived only (nothing is moved or merged); the record above is not touched.',
      restore: 'Restorable: an admin can restore it from the customer record (restore route); nothing is moved or merged.',
      customer_message: 'No customer message is sent',
    });
    expect(result.card.window).toMatch(/Same window as the customer page delete/);
    expect(result.card.window).toMatch(/stays restorable/);
    // The merge engine's own readers, keyed on the stub only.
    expect(mockLoserAutoBlockers).toHaveBeenCalledWith(db, expect.objectContaining({ id: STUB_ID }));
    expect(mockPreviewMergeEffects).toHaveBeenCalledWith(db, TWIN_ID, STUB_ID);
    expect(mockNonFkMergeRewrites).toHaveBeenCalledWith(db, expect.objectContaining({ id: TWIN_ID }), expect.objectContaining({ id: STUB_ID }));
    expect(mockArchiveCustomerAsAdmin).not.toHaveBeenCalled();
  });

  test('missing or already-deleted record refuses as unavailable', async () => {
    db.__state.stub = null;
    expect(await preview()).toMatchObject({ code: 'record_unavailable' });
    db.__state.stub = { ...baseStub(), deleted_at: new Date('2026-10-02') };
    expect(await preview()).toMatchObject({ code: 'record_unavailable', error: expect.stringMatching(/already deleted/) });
    expect(await run({})).toMatchObject({ error: 'customer_id is required' });
  });
});

describe('the retained record comes from ONE queue build (finding 5)', () => {
  test('one duplicateWinnerFor call per preview, however many records share the phone; the winner it names is the card record', async () => {
    db.__state.twins = Array.from({ length: 24 }, (_, i) => ({ id: `t-${i}`, phone: '9415550199', email: null }));
    const result = await preview();
    expect(result.duplicate_of.customer_id).toBe(TWIN_ID);
    expect(mockDuplicateWinnerFor).toHaveBeenCalledTimes(1);
    expect(mockDuplicateWinnerFor).toHaveBeenCalledWith(STUB_ID, db, { requireSameIdentity: true });
  });

  test('a confirmed call with the card pins builds the queue once, under the pair lock', async () => {
    await run({ customer_id: STUB_ID, _approved_version: stubPin(), _approved_keeper: { id: TWIN_ID, version: keeperPin() } }, { confirmed: true, technicianId: 'admin-7' });
    expect(mockDuplicateWinnerFor).toHaveBeenCalledTimes(1);
    expect(mockPairLock.mock.invocationCallOrder[0]).toBeLessThan(mockDuplicateWinnerFor.mock.invocationCallOrder[0]);
  });

  test('the engine no longer exports decideWinner, and nothing in the tool reads it', () => {
    const dedupe = jest.requireActual('../services/customer-dedupe');
    expect(dedupe.decideWinner).toBeUndefined();
    for (const file of ['duplicate-customer-delete.js', 'customer-empty-loser.js']) {
      expect(fs.readFileSync(path.join(__dirname, '..', 'services', file), 'utf8')).not.toContain('decideWinner');
    }
    expect(fs.readFileSync(path.join(__dirname, '..', 'services', 'customer-dedupe.js'), 'utf8')).not.toContain('decideWinner');
  });
});

describe('the selected record must be a duplicate the merge machinery accepts', () => {
  test('no live record shares its phone or email: refused', async () => {
    mockDuplicateWinnerFor.mockResolvedValue({ winnerId: null, eligible: false, code: 'not_in_queue', reason: 'x', candidate: null });
    db.__state.twins = [];
    expect(await preview()).toMatchObject({ code: 'no_duplicate', error: expect.stringMatching(/No live duplicate found/) });
  });

  test('the queue lists the pair but refuses it (red, address conflict, unreadable dismissals): refused, naming no one', async () => {
    for (const code of ['red_pair', 'address_conflict', 'dismissals_unreadable']) {
      mockDuplicateWinnerFor.mockResolvedValue({ winnerId: code === 'dismissals_unreadable' ? null : TWIN_ID, eligible: false, code, reason: `reason ${code}`, candidate: {} });
      db.__state.twins = [{ id: TWIN_ID, phone: '9415550199', email: null }];
      const result = await preview();
      expect(result).toMatchObject({ code: 'not_a_mergeable_duplicate', pair_code: code });
      expect(result.error).not.toMatch(/Jordan|Sample/);
    }
  });

  test('the queue keeps this record (it is not a loser in any group): refused', async () => {
    mockDuplicateWinnerFor.mockResolvedValue({ winnerId: null, eligible: false, code: 'not_in_queue', reason: 'Pair is no longer in the duplicate queue', candidate: null });
    db.__state.twins = [{ id: TWIN_ID, phone: '9415550199', email: null }];
    expect(await preview()).toMatchObject({ code: 'not_a_mergeable_duplicate', pair_code: 'not_in_queue' });
  });

  test('a record linked only by a shared email is refused (no email pair check exists)', async () => {
    mockDuplicateWinnerFor.mockResolvedValue({ winnerId: null, eligible: false, code: 'not_in_queue', reason: 'x', candidate: null });
    db.__state.stub = { ...baseStub(), email: 'kit.example@example.org' };
    db.__state.twins = [{ id: TWIN_ID, phone: '9415550111', email: 'kit.example@example.org' }];
    expect(await preview()).toMatchObject({ code: 'email_only_duplicate', error: expect.stringMatching(/shares an email, not a phone/) });
    // A stub with no phone at all is the same case.
    db.__state.stub = { ...baseStub(), phone: null, email: 'kit.example@example.org' };
    expect(await preview()).toMatchObject({ code: 'email_only_duplicate' });
  });
});

describe('the created date is the Eastern calendar date', () => {
  test('a record created 22:30 ET on Sep 30 (02:30 UTC Oct 1) reads Sep 30, for the stub and the retained record', async () => {
    db.__state.stub = { ...baseStub(), created_at: '2026-10-01T02:30:00Z' };
    db.__state.winner = { ...baseWinner(), created_at: '2026-10-01T02:45:00Z' };
    const result = await preview();
    expect(result.stub.created_on).toBe('2026-09-30');
    expect(result.duplicate_of.created_on).toBe('2026-09-30');
    expect(result.card.delete).toMatch(/created 2026-09-30$/);
    expect(result.card.duplicate_of).toMatch(/created 2026-09-30;/);
  });

  test('the dates are not computed in SQL (a UTC session would shift an evening record)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'duplicate-customer-delete.js'), 'utf8');
    expect(src).not.toMatch(/to_char\(created_at/);
    expect(src).toContain("require('../utils/datetime-et')");
  });
});

describe('refuses any record that is not empty, naming what it found and pointing to merge_customers', () => {
  const moving = (extra) => () => mockPreviewMergeEffects.mockResolvedValue({ moving: { customer_properties: 1, ...extra, total_rows: 9 } });
  const blockers = (list) => () => mockLoserAutoBlockers.mockResolvedValue(list);
  const CASES = [
    ['a visit (any status)', moving({ scheduled_services: 1 }), 'Visits', /1 scheduled_services/],
    ['a service record', moving({ service_records: 2 }), 'Service records', /2 service_records/],
    ['an invoice (blocker table)', blockers(['invoices']), 'Invoices', /invoices rows/],
    ['an invoice (blocker + count reads once)', () => { blockers(['invoices'])(); moving({ invoices: 3 })(); }, 'Invoices', /3 invoices/],
    ['a payment', moving({ payments: 1 }), 'Payments, saved cards, Stripe profile', /1 payments/],
    ['a saved card', moving({ payment_methods: 1 }), 'Payments, saved cards, Stripe profile', /1 payment_methods/],
    ['a Stripe customer profile', blockers(['stripe_customer_id']), 'Payments, saved cards, Stripe profile', /a Stripe customer profile/],
    ['an estimate', moving({ estimates: 1 }), 'Estimates', /1 estimates/],
    ['a linked lead', moving({ leads: 1 }), 'Leads', /1 leads/],
    ['a call', moving({ call_log: 1 }), 'Calls, texts, emails', /1 call_log/],
    ['a text', moving({ sms_log: 4 }), 'Calls, texts, emails', /4 sms_log/],
    ['an email (polymorphic pointer)', moving({ 'email_messages.recipient_id': 1 }), 'Calls, texts, emails', /email_messages\.recipient_id/],
    ['a second saved property', moving({ customer_properties: 2 }), 'Saved properties', /2 customer_properties/],
    ['one saved property that is not the primary', () => { db.__state.properties = [{ ...autoPrimary(), is_primary: false }]; }, 'Saved properties', /not the primary/],
    ['a manual primary', () => { db.__state.properties = [{ ...autoPrimary(), source: 'manual' }]; }, 'Saved properties', /source manual/],
    ['a call-pipeline primary', () => { db.__state.properties = [{ ...autoPrimary(), source: 'call_pipeline' }]; }, 'Saved properties', /source call_pipeline/],
    ['a self-book primary', () => { db.__state.properties = [{ ...autoPrimary(), source: 'self_book' }]; }, 'Saved properties', /source self_book/],
    ['a primary with a nickname', () => { db.__state.properties = [{ ...autoPrimary(), label: 'Beach house' }]; }, 'Saved properties', /edited label/],
    ['a primary with an edited address', () => { db.__state.properties = [{ ...autoPrimary(), address_line1: '14 Sample Lane', address_key: 'other' }]; }, 'Saved properties', /edited address_line1/],
    ['an edited backfill primary: occupancy (editManualProperty keeps source backfill)', () => { db.__state.properties = [{ ...autoPrimary(), occupancy_type: 'rental_investment' }]; }, 'Saved properties', /edited occupancy_type/],
    ['an edited backfill primary: relationship', () => { db.__state.properties = [{ ...autoPrimary(), relationship: 'managed_for_client' }]; }, 'Saved properties', /edited relationship/],
    ['an edited backfill primary: a measurement', () => { db.__state.properties = [{ ...autoPrimary(), lot_sqft: 9000 }]; }, 'Saved properties', /edited lot_sqft/],
    ['a primary with operator data in another column', () => { db.__state.properties = [{ ...autoPrimary(), access_notes: 'side gate' }]; }, 'Saved properties', /access_notes/],
    ['a primary with an office neighborhood entry', () => { db.__state.properties = [{ ...autoPrimary(), neighborhood_id: 'n-1', neighborhood_source: 'office' }]; }, 'Saved properties', /office neighborhood/],
    ['CRM notes', () => { db.__state.stub.crm_notes = 'Prefers mornings'; }, 'Record fields', /holds crm notes \(crm_notes\)/],
    ['technician notes', () => { db.__state.stub.technician_notes = 'Dog in yard'; }, 'Record fields', /holds technician notes \(technician_notes\)/],
    ['a service contact', () => { db.__state.stub.service_contact_name = 'Sam Example'; }, 'Record fields', /holds service contact name \(service_contact_name\)/],
    ['a plan-rate ledger row', () => { db.__state.counts.customer_plan_rates = 1; }, 'Plan-rate ledger', /1 customer_plan_rates/],
    ['a monthly rate', blockers(['monthly_rate']), 'Monthly rate, plan, billing', /a monthly rate/],
    ['a live customer stage', blockers(['live_stage']), 'Monthly rate, plan, billing', /a live customer stage/],
    ['a billing mode', blockers(['billing_mode']), 'Monthly rate, plan, billing', /a billing mode/],
    ['a plan tier', () => { db.__state.stub.waveguard_tier = 'Gold'; }, 'Record fields', /holds waveguard tier \(waveguard_tier\)/],
    ['a portal login', blockers(['portal_login']), 'Portal login', /a portal login/],
    ['a referral enrollment', moving({ referral_promoters: 1 }), 'Referral or credit balance', /1 referral_promoters/],
    ['an account credit', () => { db.__state.stub.account_credits = '15.00'; }, 'Record fields', /holds account credits \(account_credits\)/],
    ['a credit allocation', () => { db.__state.counts.field_credit_allocations = 1; }, 'Referral or credit balance', /1 field_credit_allocations/],
    ['any other linked row', moving({ customer_tags: 1 }), 'Other linked records', /1 customer_tags/],
    // Finding 1: history a merge rewrites that no customer_id column names.
    ['a call whose customer link was overridden by an operator (non-FK)', () => mockNonFkMergeRewrites.mockResolvedValue({ 'call_log.customer_link_override': 1 }), 'Calls, texts, emails', /1 call_log\.customer_link_override/],
    ['an irrigation weekly email identity (non-FK)', () => mockNonFkMergeRewrites.mockResolvedValue({ 'email_messages.trigger_event_id': 2 }), 'Calls, texts, emails', /2 email_messages\.trigger_event_id/],
    ['an unstamped visit address (non-FK)', () => mockNonFkMergeRewrites.mockResolvedValue({ 'scheduled_services.service_address_stamp': 1 }), 'Visits', /1 scheduled_services\.service_address_stamp/],
    ['a non-FK count that could not be read (fail closed)', () => mockNonFkMergeRewrites.mockResolvedValue({ 'call_log.customer_link_override': 'unknown' }), 'Calls, texts, emails', /could not be checked/],
    // Finding 2 (account ownership): a primary profile with other live members.
    ['an account primary profile with other live members', () => { db.__state.stub = { ...baseStub(), account_id: 'acct-1', is_primary_profile: true }; db.__state.sibling = { id: 'sibling-1' }; }, 'Other live members of its account', /other live members in its account/],
    ['a count that could not be read (fail closed)', moving({ sms_log: 'unknown' }), 'Calls, texts, emails', /sms_log \(could not be checked\)/],
    ['a blocker table that could not be read (fail closed)', blockers(['payments (check failed)']), 'Payments, saved cards, Stripe profile', /payments \(could not be checked\)/],
    ['the linked-table sweep failing (fail closed)', moving({ fk_sweep: 'unknown' }), 'Other linked records', /could not be checked/],
  ];

  // Every table the merge reader (previewMergeEffects) excludes is counted by
  // this check itself, read from the engine's own REPOINT_EXCLUDED_TABLES.
  const { REPOINT_EXCLUDED_TABLES } = jest.requireActual('../services/customer-dedupe');
  test('the real exclusion list covers plan rates, credits, location reviews, merge journal and dismissals', () => {
    expect([...REPOINT_EXCLUDED_TABLES].sort()).toEqual(['customer_duplicate_dismissals', 'customer_geocode_reviews', 'customer_merge_journal', 'customer_plan_rates', 'field_credit_allocations']);
  });
  test.each([...REPOINT_EXCLUDED_TABLES])('a row in merge-excluded table %s refuses', async (table) => {
    db.__state.counts[table] = 1;
    const result = await preview();
    expect(result).toMatchObject({ code: 'not_empty' });
    expect(result.error).toContain(`1 ${table}`);
  });

  test.each(CASES)('%s', async (_name, arrange, label, detail) => {
    arrange();
    const result = await preview();
    expect(result).toMatchObject({ code: 'not_empty' });
    expect(result.preview).toBeUndefined();
    expect(result.error).toContain(label);
    expect(result.error).toMatch(detail);
    expect(result.error).toMatch(/merge_customers/);
    // A refusal never names the person (the route runs the preview before
    // validating the target).
    expect(result.error).not.toMatch(/Jordan|Sample/);
    expect(mockArchiveCustomerAsAdmin).not.toHaveBeenCalled();
  });
  test('the sprinkler home-changed stamp is a premise about two addresses, not history', async () => {
    mockNonFkMergeRewrites.mockResolvedValue({ 'property_preferences.irrigation_home_changed_at': 'stamped' });
    expect((await preview()).preview).toBe(true);
  });

  test('an account primary alone in its account, or a non-primary member, passes', async () => {
    db.__state.stub = { ...baseStub(), account_id: 'acct-1', is_primary_profile: true };
    db.__state.sibling = null;
    expect((await preview()).preview).toBe(true);
    db.__state.stub = { ...baseStub(), account_id: 'acct-1', is_primary_profile: false };
    db.__state.sibling = { id: 'sibling-1' };
    expect((await preview()).preview).toBe(true);
  });
});

describe('A. fields: only what the unknown-caller stub creator writes may be set (fail closed)', () => {
  const setField = (column, value) => { db.__state.stub = { ...baseStub(), [column]: value }; };

  test('the allow-list is exactly the insert keys in call-recording-processor.js plus row bookkeeping', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'call-recording-processor.js'), 'utf8');
    const insert = src.slice(src.indexOf("[newCust] = await trx('customers').insert(applyContactNormalization({"));
    const body = insert.slice(0, insert.indexOf('})).returning'));
    const written = [...body.matchAll(/^\s{14}([a-z_0-9]+):/gm)].map((m) => m[1]);
    expect(written.length).toBeGreaterThan(15);
    for (const column of written) expect(emptyLoser.STUB_CREATOR_COLUMNS.has(column)).toBe(true);
    expect([...emptyLoser.STUB_CREATOR_COLUMNS].sort()).toEqual([
      'account_id', 'active', 'address_line1', 'address_line2', 'city', 'created_at', 'deleted_at', 'email', 'first_name', 'id',
      'is_primary_profile', 'last_name', 'lead_source', 'lead_source_detail', 'nearest_location_id', 'phone', 'pipeline_stage',
      'pipeline_stage_changed_at', 'profile_label', 'referral_code', 'state', 'updated_at', 'zip',
    ]);
  });

  test.each([
    ['gate_code', '4821#'], ['access_notes', 'Side door'], ['pet_info', 'Two dogs'], ['follow_up_notes', 'Call back'],
    ['secondary_phone', '9415550123'], ['referred_by_customer_id', '20000000-0000-4000-8000-0000000000aa'],
  ])('a value in %s refuses, naming the column and never the value', async (column, value) => {
    setField(column, value);
    const result = await preview();
    expect(result).toMatchObject({ code: 'not_empty' });
    expect(result.error).toContain(`holds ${column.replace(/_/g, ' ')} (${column})`);
    expect(result.error).not.toContain(String(value));
    expect(JSON.stringify(result.found)).not.toContain(String(value));
  });

  test('a column added later refuses by default (in the schema, no default, a value set)', async () => {
    db.__state.columnRows.push({ column_name: 'brand_new_flag', column_default: null, is_generated: 'NEVER' });
    setField('brand_new_flag', 'x');
    expect(await preview()).toMatchObject({ code: 'not_empty', error: expect.stringContaining('holds brand new flag (brand_new_flag)') });
  });

  test('a column the schema read does not know refuses too (the schema cache is older than the row)', async () => {
    setField('column_from_a_newer_deploy', 'x');
    expect(await preview()).toMatchObject({ code: 'not_empty', error: expect.stringContaining('column_from_a_newer_deploy') });
  });

  test('NULL and the schema default pass: a literal default, a database-generated default, a jsonb default', async () => {
    db.__state.stub = { ...baseStub(), autopay_enabled: false, tags: {}, sms_opt_out_reason: 'none', monthly_rate: '0.00' };
    expect((await preview()).preview).toBe(true);
  });

  test('a value that differs from its default refuses', async () => {
    for (const [column, value] of [['autopay_enabled', true], ['tags', { vip: true }], ['sms_opt_out_reason', 'asked'], ['monthly_rate', '89.00']]) {
      setField(column, value);
      expect(await preview()).toMatchObject({ code: 'not_empty', error: expect.stringContaining(`(${column})`) });
    }
  });

  test('a default the check cannot read refuses any value; a generated default accepts any value', async () => {
    db.__state.columnRows.push({ column_name: 'odd_default', column_default: "lower('X'::text)", is_generated: 'NEVER' });
    setField('odd_default', 'x');
    expect(await preview()).toMatchObject({ code: 'not_empty', error: expect.stringContaining('(odd_default)') });
    setField('reservice_token', 'any-generated-token');
    expect((await preview()).preview).toBe(true);
  });

  test('unreadable schema refuses (fail closed)', async () => {
    db.__state.columnsError = true;
    expect(await preview()).toMatchObject({ code: 'not_empty', error: expect.stringContaining('the record fields could not be checked') });
    db.__state.columnsError = false;
    db.__state.columnRows = [];
    emptyLoser._resetCaches();
    expect(await preview()).toMatchObject({ code: 'not_empty', error: expect.stringContaining('could not be checked') });
  });

  test('default parsing: casts, booleans, numbers, strings, jsonb, generated, unknown', () => {
    const { parseColumnDefault: p, valueMatchesDefault: m } = emptyLoser;
    expect(p("'FL'::character varying")).toEqual({ kind: 'literal', value: 'FL' });
    expect(p('false')).toEqual({ kind: 'literal', value: false });
    expect(p('0.00')).toEqual({ kind: 'literal', value: 0 });
    expect(p('now()')).toEqual({ kind: 'generated' });
    expect(p(null)).toEqual({ kind: 'none' });
    expect(p("lower('X'::text)")).toEqual({ kind: 'unknown' });
    expect(m('0.00', p('0'))).toBe(true);
    expect(m(0, p('0.00'))).toBe(true);
    expect(m('5.00', p('0.00'))).toBe(false);
    expect(m('x', p(null))).toBe(false);
    expect(m({}, p("'{}'::jsonb"))).toBe(true);
    expect(m([], p("'{}'::text[]"))).toBe(true);
    expect(m(['a'], p("'{}'::text[]"))).toBe(false);
  });
});

describe('B. linked rows: the customers table pointing at it, non-FK links, unreadable counts', () => {
  test('another customer whose referred_by_customer_id points at it refuses', async () => {
    db.__state.selfRefCounts = { referred_by_customer_id: 2 };
    const result = await preview();
    expect(result).toMatchObject({ code: 'not_empty', error: expect.stringContaining('Other customer records pointing at it (referrals): 2 customers.referred_by_customer_id') });
  });

  test('every customers column that points at a customer is counted (declared FK or *customer_id)', async () => {
    db.__state.selfRefRows = [{ column_name: 'referred_by_customer_id' }, { column_name: 'merged_into_customer_id' }];
    db.__state.selfRefCounts = { merged_into_customer_id: 1 };
    expect(await preview()).toMatchObject({ code: 'not_empty', error: expect.stringContaining('1 customers.merged_into_customer_id') });
  });

  test('a self-reference count or column list that cannot be read refuses', async () => {
    db.__state.selfRefCounts = { referred_by_customer_id: 'throw' };
    expect(await preview()).toMatchObject({ code: 'not_empty', error: expect.stringContaining('customers.referred_by_customer_id (could not be checked)') });
    db.__state.selfRefCounts = {};
    db.__state.selfRefError = true;
    emptyLoser._resetCaches();
    expect(await preview()).toMatchObject({ code: 'not_empty', error: expect.stringContaining('the customer pointer columns could not be checked') });
  });

  test('the engine non-FK readers feed the same check (call link override, irrigation email identity)', async () => {
    mockNonFkMergeRewrites.mockResolvedValue({ 'call_log.customer_link_override': 1 });
    expect(await preview()).toMatchObject({ code: 'not_empty', error: expect.stringContaining('1 call_log.customer_link_override') });
  });
});

describe('C. commit: archive only, decisive checks in the archive transaction in a fixed order', () => {
  const KEEPER = { id: TWIN_ID, version: keeperPin() };
  const approved = (extra = {}) => run(
    { customer_id: STUB_ID, _approved_version: stubPin(), _approved_keeper: KEEPER, ...extra },
    { confirmed: true, technicianId: 'admin-7' },
  );

  test('runs the customer page archive handler with the stub id, the operator and a precheck; never the merge executor', async () => {
    const result = await approved();
    expect(mockArchiveCustomerAsAdmin).toHaveBeenCalledTimes(1);
    expect(mockArchiveCustomerAsAdmin).toHaveBeenCalledWith({
      customerId: STUB_ID,
      actor: { technicianId: 'admin-7', userAgent: 'intelligence-bar:delete_duplicate_customer' },
      precheck: expect.any(Function),
      // The retained record's row is locked with the archived one, in id order.
      alsoLock: TWIN_ID,
    });
    expect(result).toMatchObject({ success: true, customer_id: STUB_ID, deleted: true, customer_message: 'No customer message is sent' });
    expect(result.restore).toBe('Restorable: an admin can restore it from the customer record (restore route); nothing is moved or merged.');
    const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'duplicate-customer-delete.js'), 'utf8');
    expect(src).not.toMatch(/executeMerge\(|requireEmptyLoser|restoreCustomerAsAdmin|historyAppearedAfterCommit/);
    const dedupe = fs.readFileSync(path.join(__dirname, '..', 'services', 'customer-dedupe.js'), 'utf8');
    expect(dedupe).not.toContain('requireEmptyLoser');
    expect(dedupe).not.toContain('emptyLoserRefusal');
  });

  test('lock order inside the archive transaction: both row locks (handler), pair lock, queue verdict, both content pins, emptiness scan', async () => {
    const order = [];
    mockPairLock.mockImplementation(async (trx, a, b) => { order.push(['pair_lock', trx === db, a, b]); });
    mockDuplicateWinnerFor.mockImplementation(async (id, conn) => { order.push(['verdict', id, conn === db]); return eligibleVerdict(); });
    mockLoserAutoBlockers.mockImplementation(async () => { order.push(['scan']); return []; });
    await approved();
    expect(order).toEqual([
      ['pair_lock', true, TWIN_ID, STUB_ID],
      ['verdict', STUB_ID, true],
      ['scan'],
    ]);
    // The verdict is the same-identity one, and the pair lock precedes it.
    expect(mockDuplicateWinnerFor).toHaveBeenLastCalledWith(STUB_ID, db, { requireSameIdentity: true });
    // The pair lock call precedes the verdict call precedes the scan.
    expect(mockPairLock.mock.invocationCallOrder[0]).toBeLessThan(mockDuplicateWinnerFor.mock.invocationCallOrder.at(-1));
    expect(mockDuplicateWinnerFor.mock.invocationCallOrder.at(-1)).toBeLessThan(mockLoserAutoBlockers.mock.invocationCallOrder.at(-1));
  });

  test('a "not a duplicate" dismissal (or any queue change) that lands before the lock: preview_changed, nothing archived', async () => {
    mockDuplicateWinnerFor.mockResolvedValue({ winnerId: null, eligible: false, code: 'not_in_queue', reason: 'x', candidate: null });
    const result = await approved();
    expect(result).toMatchObject({ code: 'not_a_mergeable_duplicate', preview_changed: true, error: expect.stringMatching(/no longer lists this record/) });
  });

  test('the queue keeps a different record than the card showed: keeper_changed', async () => {
    mockDuplicateWinnerFor.mockResolvedValue(eligibleVerdict('20000000-0000-4000-8000-0000000000bb'));
    expect(await approved()).toMatchObject({ code: 'keeper_changed', preview_changed: true });
  });

  test('both pinned versions: the stub moved, or the other record moved, after the card', async () => {
    expect(await approved({ _approved_version: '2026-09-30 08:00:00+00' })).toMatchObject({ code: 'version_changed', preview_changed: true });
    expect(await approved({ _approved_keeper: { id: TWIN_ID, version: '2026-08-30 08:00:00+00' } })).toMatchObject({ code: 'keeper_version_changed', preview_changed: true });
    // The approved pins themselves pass.
    expect(await approved()).toMatchObject({ success: true });
  });

  test('P1 content pin: an allowed-field edit that does NOT bump updated_at refuses, on the stub and on the retained record', async () => {
    // Customer 360 saves these columns without touching updated_at.
    const stubBefore = baseStub();
    db.__state.stub = { ...stubBefore, first_name: 'Edited' };
    expect(db.__state.stub.updated_at).toBe(stubBefore.updated_at);
    expect(await approved()).toMatchObject({ code: 'version_changed', preview_changed: true });
    db.__state.stub = baseStub();
    db.__state.winner = { ...baseWinner(), email: 'moved.sample@example.com' };
    expect(await approved()).toMatchObject({ code: 'keeper_version_changed', preview_changed: true });
    db.__state.winner = baseWinner();
    expect(await approved()).toMatchObject({ success: true });
    // The pin covers exactly the allow-listed columns: a change to one of them
    // changes it, a column outside the list (checked by the emptiness scan) or
    // the card's own aliases do not.
    const base = stubPin(baseStub());
    for (const column of emptyLoser.STUB_CREATOR_COLUMNS) {
      const edited = { ...baseStub(), [column]: column === 'active' ? false : `changed-${column}` };
      if (column === 'id') continue;
      expect(stubPin(edited)).not.toBe(base);
    }
    expect(stubPin({ ...baseStub(), crm_notes: 'x', version: 'other', created_on: '1999-01-01' })).toBe(base);
  });

  test('the other record deleted after the card: refused', async () => {
    db.__state.winner = { ...baseWinner(), deleted_at: new Date() };
    expect(await approved()).toMatchObject({ code: 'record_unavailable', preview_changed: true });
  });

  test('the emptiness scan runs again on the locked row: a field or a linked row that landed since the card refuses', async () => {
    mockArchiveCustomerAsAdmin.mockImplementationOnce(async ({ precheck }) => {
      db.__state.stub.gate_code = '0000';
      await precheck(db);
      throw new Error('unreachable: the archive must not run');
    });
    const result = await approved();
    expect(result).toMatchObject({ code: 'not_empty', preview_changed: true, error: expect.stringContaining('(gate_code)') });
    expect(result.error).not.toContain('0000');
    mockPreviewMergeEffects.mockResolvedValue({ moving: { sms_log: 1, total_rows: 1 } });
    expect(await approved()).toMatchObject({ code: 'not_empty', error: expect.stringMatching(/1 sms_log/) });
  });

  test('deleted elsewhere after the card, or the queue no longer lists the pair at commit start: preview_changed, the archive never runs', async () => {
    db.__state.stub = { ...baseStub(), deleted_at: new Date() };
    expect(await commit()).toMatchObject({ code: 'record_unavailable', preview_changed: true });
    db.__state.stub = baseStub();
    mockDuplicateWinnerFor.mockResolvedValue({ winnerId: null, eligible: false, code: 'not_in_queue', reason: 'x', candidate: null });
    expect(await commit()).toMatchObject({ preview_changed: true });
    expect(mockArchiveCustomerAsAdmin).not.toHaveBeenCalled();
  });

  test('a direct call with no card pins what it reads at commit start', async () => {
    expect(await commit()).toMatchObject({ success: true });
    expect(mockDuplicateWinnerFor).toHaveBeenCalledTimes(2); // once to name the keeper, once under the pair lock
  });

  test("the route's own refusal is relayed (409 still billing); a 404 reads as preview_changed", async () => {
    mockArchiveCustomerAsAdmin.mockResolvedValueOnce({ status: 409, json: { error: 'customer_still_billing_or_scheduled', message: 'This customer still has an active prepay term. Cancel the plan before archiving.' } });
    expect(await approved()).toEqual({ error: 'This customer still has an active prepay term. Cancel the plan before archiving.' });
    mockArchiveCustomerAsAdmin.mockResolvedValueOnce({ status: 404, json: { error: 'Customer not found' } });
    expect(await approved()).toEqual({ error: 'Customer not found', preview_changed: true });
  });

  test('an unrelated failure in the archive surfaces as a tool error', async () => {
    mockArchiveCustomerAsAdmin.mockRejectedValueOnce(new Error('relink exploded'));
    expect(await approved()).toEqual({ error: 'relink exploded' });
  });

  test('a model-supplied confirmed field or pin never commits or pins', async () => {
    const result = await run({ customer_id: STUB_ID, confirmed: true, _approved_keeper: KEEPER }, {});
    expect(result.preview).toBe(true);
    expect(mockArchiveCustomerAsAdmin).not.toHaveBeenCalled();
  });
});

describe('P1 same identity only: a possible match is not a confirmed duplicate', () => {
  const POSSIBLE = 'the queue lists this as a possible match, not a confirmed duplicate; use merge_customers';
  const possible = { winnerId: TWIN_ID, eligible: false, code: 'possible_match_only', reason: POSSIBLE, candidate: { tier: 'yellow', reasons: ['name_conflict'] } };

  test('the preview asks the queue for the same-identity verdict and refuses a yellow candidate with the queue wording', async () => {
    mockDuplicateWinnerFor.mockResolvedValue(possible);
    const result = await preview();
    expect(result).toMatchObject({ code: 'not_a_mergeable_duplicate', pair_code: 'possible_match_only', error: expect.stringContaining(POSSIBLE) });
    expect(result.error).not.toMatch(/Jordan|Sample/);
    expect(mockDuplicateWinnerFor).toHaveBeenCalledWith(STUB_ID, db, { requireSameIdentity: true });
    // A green candidate passes the same call.
    mockDuplicateWinnerFor.mockResolvedValue(eligibleVerdict());
    expect((await preview()).preview).toBe(true);
  });

  test('a pair that turns yellow after the card refuses under the pair lock, and nothing is archived', async () => {
    mockArchiveCustomerAsAdmin.mockImplementation(async ({ precheck }) => {
      mockDuplicateWinnerFor.mockResolvedValue(possible);
      await precheck(db);
      throw new Error('unreachable: the archive must not run');
    });
    const result = await run({ customer_id: STUB_ID, _approved_version: stubPin(), _approved_keeper: { id: TWIN_ID, version: keeperPin() } }, { confirmed: true, technicianId: 'admin-7' });
    expect(result).toMatchObject({ code: 'possible_match_only', preview_changed: true });
  });

  test('the delete tool is the only caller of the strict read; merge paths keep the default', () => {
    for (const file of ['routes/admin-customer-duplicates.js', 'services/intelligence-bar/customer-lifecycle-tools.js', 'services/customer-merge-tools.js']) {
      const full = path.join(__dirname, '..', file);
      if (fs.existsSync(full)) expect(fs.readFileSync(full, 'utf8')).not.toContain('requireSameIdentity');
    }
    expect(fs.readFileSync(path.join(__dirname, '..', 'services', 'duplicate-customer-delete.js'), 'utf8')).toContain('requireSameIdentity: true');
  });
});

describe('D. restore wording and the remaining window', () => {
  test('the card and the result say restore route, nothing moved or merged, and name the same-window limit', async () => {
    const p = await preview();
    expect(p.restore).toBe('Restorable: an admin can restore it from the customer record (restore route); nothing is moved or merged.');
    expect(p.window).toMatch(/at the very instant of the delete can attach to the archived record\. It stays restorable/);
    expect(p.card.how).toMatch(/archived only \(nothing is moved or merged\)/);
    expect(JSON.stringify(p)).not.toMatch(/duplicate queue's undo|merge engine/);
  });
});

describe('allowed: the untouched automatic primary', () => {
  test('a county neighborhood stamp from the automatic lookup is still the untouched primary', async () => {
    db.__state.properties = [{ ...autoPrimary(), neighborhood_id: 'n-1', neighborhood_source: 'county', county_subdivision: 'Example Glen', neighborhood_checked_at: new Date() }];
    expect((await preview()).preview).toBe(true);
  });
});

describe('pins and card contract', () => {
  test('the route pin (preview fingerprint) binds the stub version, the checks and the record it is archived into', async () => {
    const a = await preview();
    const same = await preview();
    expect(AuthorizationContract.previewFingerprint(same)).toBe(AuthorizationContract.previewFingerprint(a));
    db.__state.stub = { ...baseStub(), zip: '34209' };
    expect(AuthorizationContract.previewFingerprint(await preview())).not.toBe(AuthorizationContract.previewFingerprint(a));
    db.__state.stub = baseStub();
    db.__state.winner = { ...baseWinner(), email: 'other.sample@example.com' };
    const twinChanged = await preview();
    expect(twinChanged.preview).toBe(true);
    expect(AuthorizationContract.previewFingerprint(twinChanged)).not.toBe(AuthorizationContract.previewFingerprint(a));
    // A different retained record, or a new version of it, also changes the card.
    db.__state.winner = { ...baseWinner(), city: 'Sarasota' };
    expect(AuthorizationContract.previewFingerprint(await preview())).not.toBe(AuthorizationContract.previewFingerprint(a));
  });

  test('the contract: labelled, reversible, no customer contact, card lines only', async () => {
    const p = await preview();
    const contract = AuthorizationContract.buildContract({ toolName: 'delete_duplicate_customer', params: { customer_id: STUB_ID }, displayParams: p.card, preview: p });
    expect(contract).toMatchObject({ action_label: 'Delete empty duplicate customer', tier: 'yellow', irreversible: false, notifies_customer: false });
    const labels = contract.effects.map((e) => e.label);
    expect(labels).toEqual(expect.arrayContaining([
      'delete: Delete the empty duplicate record Unknown (phone (***) ***-0199), created 2026-10-01',
      'customer message: No customer message is sent',
      'visits: none',
      'invoices: none',
      expect.stringMatching(/^restore: Restorable/),
    ]));
    // The raw uuid never reaches the card.
    expect(labels.join(' ')).not.toContain(STUB_ID);
  });
});

describe('wiring', () => {
  test('two-step write, admin-only policy, never owner-direct, offered only behind the gate on the platform path', () => {
    const { WRITE_TWO_STEP_TOOL_NAMES } = require('../services/intelligence-bar/write-gates');
    expect(WRITE_TWO_STEP_TOOL_NAMES.has('delete_duplicate_customer')).toBe(true);
    const policy = require('../services/intelligence-bar/action-policy.json');
    expect(policy.delete_duplicate_customer).toEqual({
      module: 'customer-lifecycle-tools.js', domain: 'customers', kind: 'internal_write', role: 'admin', approval: 'ui_confirm', scope: 'record',
    });
    const OwnerDirect = require('../services/intelligence-bar/owner-direct');
    expect(OwnerDirect.executesWithoutCard('delete_duplicate_customer', {})).toBe(false);
    const registry = require('../services/intelligence-bar/action-registry');
    const action = registry.actions.get('delete_duplicate_customer');
    expect(registry.allowed(action, { role: 'admin', context: 'customers' })).toBe(true);
    expect(registry.allowed(action, { role: 'technician', context: 'customers' })).toBe(false);
    expect(registry.allowed(action, { role: 'admin', context: 'tech' })).toBe(false);
    delete process.env.GATE_IB_DELETE_CUSTOMER;
    expect(registry.allowed(action, { role: 'admin', context: 'customers' })).toBe(false);
  });

  test('route source: admin-only set, gated tool list, curated card builder', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'admin-intelligence-bar.js'), 'utf8');
    const adminOnly = src.slice(src.indexOf('const ADMIN_ONLY_TOOL_NAMES = new Set(['), src.indexOf(']);', src.indexOf('const ADMIN_ONLY_TOOL_NAMES = new Set([')));
    expect(adminOnly).toContain("'delete_duplicate_customer'");
    expect(src).toMatch(/filter\(t => deleteDuplicateCustomerEnabled\(\) \|\| t\.name !== 'delete_duplicate_customer'\)/);
    expect(src).toMatch(/delete_duplicate_customer: \(params, preview\) => \(preview\?\.preview === true && preview\.card \? preview\.card : null\)/);
    // The fingerprint-verified preview's content pins ride to the executor.
    expect(src).toContain("if (action.tool_name === 'delete_duplicate_customer') Object.assign(execParams, deleteDuplicatePins(livePreview));");
    expect(src).toContain('pins._approved_version = String(livePreview._version);');
  });

  test('the canonical delete and its restore route exist; the adapter runs the named delete handler with the precheck after the row lock', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'admin-customers.js'), 'utf8');
    expect(src).toContain("router.delete('/:id', requireAdmin, customerArchiveHandler);");
    expect(src).toContain("router.patch('/:id/restore', requireAdmin, async (req, res, next) => {");
    expect(src).toMatch(/async function archiveCustomerAsAdmin\([\s\S]*?customerArchiveHandler\(req, res, reject\)/);
    expect(src).toContain("await trx('customers').whereIn('id', [req.params.id, req.archiveAlsoLock]).orderBy('id').forUpdate().select('id');");
    expect(src).toMatch(/forUpdate\(\)\.first\(\);\n        \}\n        if \(req\.archivePrecheck\) await req\.archivePrecheck\(trx\);/);
    expect(src).toContain('router.archiveCustomerAsAdmin = archiveCustomerAsAdmin;');
  });

  test('the route owns both pins (strips inbound copies, sets them from the fingerprint-verified preview)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'admin-intelligence-bar.js'), 'utf8');
    expect(src).toContain('delete execParams._approved_version;');
    expect(src).toContain('delete execParams._approved_keeper;');
    expect(src).toMatch(/pins\._approved_keeper = \{ id: String\(keeper\.customer_id\), version: String\(keeper\.version\) \}/);
  });

  test('find_duplicates never suggests a deleted record (every grouping filters deleted_at)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'intelligence-bar', 'tools.js'), 'utf8');
    const body = src.slice(src.indexOf('async function findDuplicates('), src.indexOf('// ─── WRITE IMPLEMENTATIONS'));
    expect(body.match(/\.whereNull\('deleted_at'\)/g)).toHaveLength(3);
  });
});
