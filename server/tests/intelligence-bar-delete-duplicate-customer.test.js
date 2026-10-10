/**
 * delete_duplicate_customer — owner ruling 2026-10-07 (Q3): "soft-delete for
 * empty stubs only (no visits, invoices, payments), carded, restorable."
 *
 * The tool is a thin preset of the merge engine: the commit is
 * customer-dedupe.js executeMerge (mocked here) called with the stub as the
 * loser, the record ONE queue build names as the winner, the locked queue
 * re-check and requireEmptyLoser. The emptiness readers (loserAutoBlockers,
 * previewMergeEffects, nonFkMergeRewrites) are mocked: this suite proves the
 * card reads ONLY them, refuses on anything they report, and commits only
 * through executeMerge. The engine's own locked behavior (requireEmptyLoser
 * under the row and pair locks, before any write) is proven in
 * customer-merge-require-empty-loser.test.js. All names synthetic.
 */

jest.mock('../models/db', () => {
  const state = { stub: null, winner: null, twins: [], counts: {}, properties: [], sibling: null };
  const builder = (table) => {
    const q = { _table: table, _single: false, _count: false, _where: {} };
    q.where = (arg) => { if (arg && typeof arg === 'object') Object.assign(q._where, arg); else if (typeof arg === 'function') arg({ orWhereRaw: () => null, orWhere: () => null }); return q; };
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
  db.raw = jest.fn((sql) => sql);
  db.__state = state;
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const mockLoserAutoBlockers = jest.fn();
const mockPreviewMergeEffects = jest.fn();
const mockNonFkMergeRewrites = jest.fn();
const mockDuplicateWinnerFor = jest.fn();
const mockRowConflict = jest.fn();
const mockDbConflict = jest.fn();
const mockExecuteMerge = jest.fn();
jest.mock('../services/customer-dedupe', () => ({
  loserAutoBlockers: (...args) => mockLoserAutoBlockers(...args),
  previewMergeEffects: (...args) => mockPreviewMergeEffects(...args),
  nonFkMergeRewrites: (...args) => mockNonFkMergeRewrites(...args),
  // The duplicate queue's own answer from ONE queue build, and the merge
  // executor itself (the real rules are proven in the customer-dedupe suites).
  duplicateWinnerFor: (...args) => mockDuplicateWinnerFor(...args),
  rowLevelMergeConflict: (...args) => mockRowConflict(...args),
  dbLevelMergeConflict: (...args) => mockDbConflict(...args),
  executeMerge: (...args) => mockExecuteMerge(...args),
  // The REAL note-append rule: its column list decides what is customer text.
  predictNoteAppends: jest.requireActual('../services/customer-dedupe').predictNoteAppends,
  // The REAL exclusion list: every table the merge reader skips is counted.
  REPOINT_EXCLUDED_TABLES: jest.requireActual('../services/customer-dedupe').REPOINT_EXCLUDED_TABLES,
}));

const fs = require('fs');
const path = require('path');
const db = require('../models/db');
const { executeCustomerLifecycleTool } = require('../services/intelligence-bar/customer-lifecycle-tools');
const AuthorizationContract = require('../services/intelligence-bar/authorization-contract');

const STUB_ID = '20000000-0000-4000-8000-000000000001';
const TWIN_ID = '20000000-0000-4000-8000-000000000002';
const baseStub = () => ({
  id: STUB_ID, first_name: 'Unknown', last_name: '', phone: '(941) 555-0199', email: null,
  address_line1: '12 Sample Lane', address_line2: null, city: 'Bradenton', state: 'FL', zip: '34208',
  deleted_at: null, version: '2026-10-01 12:00:00.000001+00', created_at: '2026-10-01T15:00:00Z',
  waveguard_tier: null, monthly_rate: '0', account_credits: '0', crm_notes: null, technician_notes: '',
  service_contact_name: null, service_contact2_phone: '',
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
  mockLoserAutoBlockers.mockResolvedValue([]);
  mockNonFkMergeRewrites.mockResolvedValue({});
  // Default: the duplicate queue lists the stub as a mergeable duplicate of the twin.
  mockDuplicateWinnerFor.mockResolvedValue(eligibleVerdict());
  mockRowConflict.mockReturnValue(null);
  mockDbConflict.mockResolvedValue(null);
  mockExecuteMerge.mockResolvedValue({ journalId: 'journal-1', repointed: {}, backfills: {} });
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
    expect(mockExecuteMerge).not.toHaveBeenCalled();
  });
});

describe('preview (empty stub)', () => {
  test('returns the card: the stub, the record it is archived into, every check, the undo line, no customer message', async () => {
    const result = await preview();
    expect(result.error).toBeUndefined();
    expect(result).toMatchObject({
      preview: true,
      customer_id: STUB_ID,
      stub: { name: 'Unknown', phone_masked: '(***) ***-0199', email_masked: null, created_on: '2026-10-01' },
      archived_into: { customer_id: TWIN_ID, name: 'Jordan Sample', phone_masked: '(***) ***-0199', email_masked: 'j***@example.com', created_on: '2025-03-14' },
      customer_message: 'No customer message is sent',
      _version: '2026-10-01 12:00:00.000001+00',
    });
    expect(result.undo).toMatch(/duplicate queue's undo/);
    expect(Object.values(result.checks).every((v) => v === 'none')).toBe(true);
    expect(Object.keys(result.checks)).toEqual(expect.arrayContaining(['Visits', 'Service records', 'Invoices', 'Payments, saved cards, Stripe profile',
      'Estimates', 'Leads', 'Calls, texts, emails', 'Plan-rate ledger', 'Monthly rate, plan, billing', 'Portal login', 'Referral or credit balance',
      'Other live members of its account']));
    expect(result.card).toMatchObject({
      delete: 'Delete the empty duplicate record Unknown (phone (***) ***-0199), created 2026-10-01',
      archived_into: 'Jordan Sample (phone (***) ***-0199, email j***@example.com), created 2025-03-14; stays as is',
      how: 'It is archived into the record above through the merge engine; nothing moves because the record holds nothing.',
      customer_message: 'No customer message is sent',
    });
    // The merge engine's own readers, keyed on the stub only.
    expect(mockLoserAutoBlockers).toHaveBeenCalledWith(db, expect.objectContaining({ id: STUB_ID }));
    expect(mockPreviewMergeEffects).toHaveBeenCalledWith(db, TWIN_ID, STUB_ID);
    expect(mockNonFkMergeRewrites).toHaveBeenCalledWith(db, expect.objectContaining({ id: TWIN_ID }), expect.objectContaining({ id: STUB_ID }));
    expect(mockExecuteMerge).not.toHaveBeenCalled();
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
    expect(result.archived_into.customer_id).toBe(TWIN_ID);
    expect(mockDuplicateWinnerFor).toHaveBeenCalledTimes(1);
    expect(mockDuplicateWinnerFor).toHaveBeenCalledWith(STUB_ID, db);
  });

  test('the commit also builds the queue once to name the winner', async () => {
    await commit();
    expect(mockDuplicateWinnerFor).toHaveBeenCalledTimes(1);
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

  test('the merge path would refuse the pair (e.g. a different multi-property account with other live members): refused', async () => {
    mockDbConflict.mockResolvedValue({ code: 'multi_property_account_conflict', message: 'the duplicate belongs to a multi-property account with other live members — reconcile accounts first' });
    expect(await preview()).toMatchObject({ code: 'merge_conflict', merge_code: 'multi_property_account_conflict', error: expect.stringMatching(/multi-property account/) });
    mockDbConflict.mockResolvedValue(null);
    mockRowConflict.mockReturnValue({ code: 'payer_conflict', message: 'customers have different third-party payers' });
    expect(await preview()).toMatchObject({ code: 'merge_conflict', merge_code: 'payer_conflict' });
  });
});

describe('the created date is the Eastern calendar date', () => {
  test('a record created 22:30 ET on Sep 30 (02:30 UTC Oct 1) reads Sep 30, for the stub and the retained record', async () => {
    db.__state.stub = { ...baseStub(), created_at: '2026-10-01T02:30:00Z' };
    db.__state.winner = { ...baseWinner(), created_at: '2026-10-01T02:45:00Z' };
    const result = await preview();
    expect(result.stub.created_on).toBe('2026-09-30');
    expect(result.archived_into.created_on).toBe('2026-09-30');
    expect(result.card.delete).toMatch(/created 2026-09-30$/);
    expect(result.card.archived_into).toMatch(/created 2026-09-30;/);
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
    ['CRM notes', () => { db.__state.stub.crm_notes = 'Prefers mornings'; }, 'Notes and service contacts', /crm_notes/],
    ['technician notes', () => { db.__state.stub.technician_notes = 'Dog in yard'; }, 'Notes and service contacts', /technician_notes/],
    ['a service contact', () => { db.__state.stub.service_contact_name = 'Sam Example'; }, 'Notes and service contacts', /service_contact_name/],
    ['a plan-rate ledger row', () => { db.__state.counts.customer_plan_rates = 1; }, 'Plan-rate ledger', /1 customer_plan_rates/],
    ['a monthly rate', blockers(['monthly_rate']), 'Monthly rate, plan, billing', /a monthly rate/],
    ['a live customer stage', blockers(['live_stage']), 'Monthly rate, plan, billing', /a live customer stage/],
    ['a billing mode', blockers(['billing_mode']), 'Monthly rate, plan, billing', /a billing mode/],
    ['a plan tier', () => { db.__state.stub.waveguard_tier = 'Gold'; }, 'Monthly rate, plan, billing', /a Gold plan tier/],
    ['a portal login', blockers(['portal_login']), 'Portal login', /a portal login/],
    ['a referral enrollment', moving({ referral_promoters: 1 }), 'Referral or credit balance', /1 referral_promoters/],
    ['an account credit', () => { db.__state.stub.account_credits = '15.00'; }, 'Referral or credit balance', /\$15\.00 account credit/],
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
    expect(mockExecuteMerge).not.toHaveBeenCalled();
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

describe('commit: a thin preset of executeMerge', () => {
  test('confirmed: calls executeMerge with the stub as loser, the queue winner as winner, the locked queue re-check and requireEmptyLoser', async () => {
    const result = await commit();
    expect(mockExecuteMerge).toHaveBeenCalledTimes(1);
    expect(mockExecuteMerge).toHaveBeenCalledWith({
      winnerId: TWIN_ID,
      loserId: STUB_ID,
      performedBy: 'ib:admin-7',
      performedById: 'admin-7',
      mode: 'intelligence_bar',
      evidence: { via: 'intelligence_bar', preset: 'delete_duplicate_customer' },
      expectedVersions: { loser: '2026-10-01 12:00:00.000001+00' },
      requireQueueEligibility: true,
      requireEmptyLoser: true,
    });
    expect(result).toMatchObject({ success: true, customer_id: STUB_ID, deleted: true, archived_into: TWIN_ID, journal_id: 'journal-1', customer_message: 'No customer message is sent' });
    expect(result.undo).toMatch(/duplicate queue's undo/);
    // The tool itself scans nothing at commit: the engine does, under its locks.
    expect(mockLoserAutoBlockers).not.toHaveBeenCalled();
    expect(mockPreviewMergeEffects).not.toHaveBeenCalled();
    expect(mockNonFkMergeRewrites).not.toHaveBeenCalled();
  });

  test('the approved card version (route pin) is what the engine validates under its locks', async () => {
    await run({ customer_id: STUB_ID, _approved_version: '2026-09-30 08:00:00+00' }, { confirmed: true, technicianId: 'admin-7' });
    expect(mockExecuteMerge).toHaveBeenCalledWith(expect.objectContaining({ expectedVersions: { loser: '2026-09-30 08:00:00+00' } }));
  });

  test('the engine finds the loser no longer empty under its locks: preview_changed with what it found, nothing deleted', async () => {
    mockExecuteMerge.mockRejectedValueOnce(Object.assign(new Error('executeMerge: This record is not empty'), {
      previewChanged: true,
      emptyLoserRefusal: { error: 'This record is not empty, so the bar will not delete it. Found — Calls, texts, emails: 1 call_log.customer_link_override.', code: 'not_empty', found: { messages: ['1 call_log.customer_link_override'] } },
    }));
    expect(await commit()).toMatchObject({ code: 'not_empty', preview_changed: true, error: expect.stringMatching(/call_log\.customer_link_override/), found: { messages: expect.any(Array) } });
  });

  test("the engine's other refusals are relayed (pair no longer mergeable, version moved, billing conflict); drift reads as preview_changed", async () => {
    mockExecuteMerge.mockRejectedValueOnce(Object.assign(new Error('executeMerge: the pair is no longer mergeable (dismissed) — review a fresh proposal'), { previewChanged: true }));
    expect(await commit()).toEqual({ error: 'executeMerge: the pair is no longer mergeable (dismissed) — review a fresh proposal', preview_changed: true });
    mockExecuteMerge.mockRejectedValueOnce(Object.assign(new Error('executeMerge: the loser customer changed since this merge was approved — review a fresh proposal'), { previewChanged: true }));
    expect(await commit()).toMatchObject({ preview_changed: true });
    mockExecuteMerge.mockRejectedValueOnce(Object.assign(new Error('executeMerge: customers have different billing modes'), { mergeConflictCode: 'billing_mode_conflict' }));
    expect(await commit()).toEqual({ error: 'executeMerge: customers have different billing modes', code: 'billing_mode_conflict' });
  });

  test('deleted elsewhere after the card, or the queue no longer lists the pair: preview_changed, the engine never runs', async () => {
    db.__state.stub = { ...baseStub(), deleted_at: new Date() };
    expect(await commit()).toMatchObject({ code: 'record_unavailable', preview_changed: true });
    db.__state.stub = baseStub();
    mockDuplicateWinnerFor.mockResolvedValue({ winnerId: null, eligible: false, code: 'not_in_queue', reason: 'x', candidate: null });
    expect(await commit()).toMatchObject({ preview_changed: true });
    expect(mockExecuteMerge).not.toHaveBeenCalled();
  });

  test('a failure with no message surfaces as a tool error', async () => {
    mockExecuteMerge.mockRejectedValueOnce(new Error('relink exploded'));
    expect(await commit()).toEqual({ error: 'relink exploded' });
  });

  test('a model-supplied confirmed field never commits', async () => {
    const result = await run({ customer_id: STUB_ID, confirmed: true }, {});
    expect(result.preview).toBe(true);
    expect(mockExecuteMerge).not.toHaveBeenCalled();
  });

  test('no customer-page archive/restore route, no own scan, no auto-restore remain in the tool', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'duplicate-customer-delete.js'), 'utf8');
    for (const gone of ['archiveCustomerAsAdmin', 'restoreCustomerAsAdmin', 'historyAppearedAfterCommit', 'restoreAfterLateHistory', 'duplicatePairEligibility']) {
      expect(src).not.toContain(gone);
    }
    expect(src).toContain('requireEmptyLoser: true');
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
    db.__state.stub = { ...baseStub(), version: '2026-10-01 12:05:00.000001+00' };
    expect(AuthorizationContract.previewFingerprint(await preview())).not.toBe(AuthorizationContract.previewFingerprint(a));
    db.__state.stub = baseStub();
    db.__state.winner = { ...baseWinner(), email: 'other.sample@example.com' };
    const twinChanged = await preview();
    expect(twinChanged.preview).toBe(true);
    expect(AuthorizationContract.previewFingerprint(twinChanged)).not.toBe(AuthorizationContract.previewFingerprint(a));
    // A different retained record, or a new version of it, also changes the card.
    db.__state.winner = { ...baseWinner(), version: '2026-09-02 08:00:00.000001+00' };
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
      expect.stringMatching(/^undo: Reversible/),
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
    // The fingerprint-verified preview's record version rides to the executor.
    expect(src).toContain("if (action.tool_name === 'delete_duplicate_customer' && livePreview?._version) execParams._approved_version = String(livePreview._version);");
  });

  test('executeMerge takes requireEmptyLoser and checks it after the pair lock, before any write', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'customer-dedupe.js'), 'utf8');
    expect(src).toMatch(/pairKind = 'phone', requireEmptyLoser = false \}\) \{/);
    const pairLock = src.indexOf('await acquirePairAdjudicationLock(trx, winnerId, loserId);');
    const emptyCheck = src.indexOf('await emptyLoserRefusal(trx, winner, loser)');
    const firstWrite = src.indexOf("await trx('customers').where({ id: loserId }).update({\n      phone: `merged-");
    expect(pairLock).toBeGreaterThan(-1);
    expect(emptyCheck).toBeGreaterThan(pairLock);
    expect(firstWrite).toBeGreaterThan(emptyCheck);
  });

  test('find_duplicates never suggests a deleted record (every grouping filters deleted_at)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'intelligence-bar', 'tools.js'), 'utf8');
    const body = src.slice(src.indexOf('async function findDuplicates('), src.indexOf('// ─── WRITE IMPLEMENTATIONS'));
    expect(body.match(/\.whereNull\('deleted_at'\)/g)).toHaveLength(3);
  });
});
