/**
 * delete_duplicate_customer — owner ruling 2026-10-07 (Q3): "soft-delete for
 * empty stubs only (no visits, invoices, payments), carded, restorable."
 *
 * The emptiness readers (customer-dedupe.js loserAutoBlockers +
 * previewMergeEffects) and the route adapter (admin-customers.js
 * archiveCustomerAsAdmin) are mocked: this suite proves the tool reads ONLY
 * them, refuses on anything they report, and commits through the adapter
 * with the stub's id. The adapter itself is proven against the real route
 * handler in admin-customers-archive-relink.test.js. All names synthetic.
 */

jest.mock('../models/db', () => {
  const state = { stub: null, twins: [], counts: {}, primaryCount: 1 };
  const builder = (table) => {
    const q = { _table: table, _single: false, _count: false, _where: {} };
    q.where = (arg) => { if (arg && typeof arg === 'object') Object.assign(q._where, arg); else if (typeof arg === 'function') arg({ orWhereRaw: () => null, orWhere: () => null }); return q; };
    q.whereNull = () => q;
    q.whereNot = () => q;
    q.whereIn = () => q;
    q.orderBy = () => q;
    q.select = () => q;
    q.count = () => { q._count = true; return q; };
    q.limit = async () => (table === 'customers' ? state.twins : []);
    q.first = async () => {
      if (table === 'customers') return state.stub;
      if (q._count && table === 'customer_properties') return { n: state.primaryCount };
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
jest.mock('../services/customer-dedupe', () => ({
  loserAutoBlockers: (...args) => mockLoserAutoBlockers(...args),
  previewMergeEffects: (...args) => mockPreviewMergeEffects(...args),
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

const STUB_ID = '20000000-0000-4000-8000-000000000001';
const TWIN_ID = '20000000-0000-4000-8000-000000000002';
const baseStub = () => ({
  id: STUB_ID, first_name: 'Unknown', last_name: '', phone: '(941) 555-0199', email: null,
  deleted_at: null, version: '2026-10-01 12:00:00.000001+00', created_on: '2026-10-01',
  waveguard_tier: null, monthly_rate: '0', account_credits: '0',
});
const twin = { customer_id: TWIN_ID, id: TWIN_ID, first_name: 'Jordan', last_name: 'Sample', phone: '9415550199', email: 'jordan.sample@example.com', created_on: '2025-03-14' };

const run = (input, ctx = {}) => executeCustomerLifecycleTool('delete_duplicate_customer', input, ctx);
const preview = () => run({ customer_id: STUB_ID });
const commit = (ctx = {}) => run({ customer_id: STUB_ID }, { confirmed: true, technicianId: 'admin-7', ...ctx });

beforeEach(() => {
  jest.clearAllMocks();
  process.env.GATE_IB_DELETE_CUSTOMER = 'true';
  db.__state.stub = baseStub();
  db.__state.twins = [twin];
  db.__state.counts = {};
  db.__state.primaryCount = 1;
  mockLoserAutoBlockers.mockResolvedValue([]);
  // One auto-created primary property and the nightly health score: allowed.
  mockPreviewMergeEffects.mockResolvedValue({ moving: { customer_properties: 1, customer_health_scores: 1, total_rows: 2 }, referral: { loser_enrolled: false } });
  // The real adapter runs `precheck` inside the archive transaction before
  // any write (proven in admin-customers-archive-relink.test.js); here the
  // transaction is the db mock and a precheck throw rejects, writing nothing.
  mockArchiveCustomerAsAdmin.mockImplementation(async ({ precheck }) => {
    if (precheck) await precheck(db);
    return { status: 200, json: { success: true } };
  });
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
  test('returns the card: the stub, the record sharing its phone, every check, restore, no customer message', async () => {
    const result = await preview();
    expect(result.error).toBeUndefined();
    expect(result).toMatchObject({
      preview: true,
      customer_id: STUB_ID,
      stub: { name: 'Unknown', phone_last4: '0199', created_on: '2026-10-01' },
      duplicate_of: [{ customer_id: TWIN_ID, name: 'Jordan Sample', phone_last4: '0199', created_on: '2025-03-14', shares: 'phone' }],
      customer_message: 'No customer message is sent',
      _version: '2026-10-01 12:00:00.000001+00',
    });
    expect(result.restore).toMatch(/PATCH \/api\/admin\/customers\/:id\/restore/);
    expect(Object.values(result.checks).every((v) => v === 'none')).toBe(true);
    expect(Object.keys(result.checks)).toEqual(expect.arrayContaining(['Visits', 'Service records', 'Invoices', 'Payments, saved cards, Stripe profile',
      'Estimates', 'Leads', 'Calls, texts, emails', 'Plan-rate ledger', 'Monthly rate, plan, billing', 'Portal login', 'Referral or credit balance']));
    expect(result.card).toMatchObject({
      delete: 'Unknown (…0199), created 2026-10-01',
      duplicate_of: expect.stringMatching(/^Jordan Sample \(…0199\), created 2025-03-14 — shares phone; stays as is$/),
      customer_message: 'No customer message is sent',
    });
    // The merge engine's own readers, keyed on the stub only.
    expect(mockLoserAutoBlockers).toHaveBeenCalledWith(db, expect.objectContaining({ id: STUB_ID }));
    expect(mockPreviewMergeEffects).toHaveBeenCalledWith(db, STUB_ID, STUB_ID);
    expect(mockArchiveCustomerAsAdmin).not.toHaveBeenCalled();
  });

  test('no record shares the phone or email: the card says so', async () => {
    db.__state.twins = [];
    const result = await preview();
    expect(result.duplicate_of).toEqual([]);
    expect(result.card.duplicate_of).toBe('No other live customer shares this phone or email');
  });

  test('missing or already-deleted record refuses as unavailable', async () => {
    db.__state.stub = null;
    expect(await preview()).toMatchObject({ code: 'record_unavailable' });
    db.__state.stub = { ...baseStub(), deleted_at: new Date('2026-10-02') };
    expect(await preview()).toMatchObject({ code: 'record_unavailable', error: expect.stringMatching(/already deleted/) });
    expect(await run({})).toMatchObject({ error: 'customer_id is required' });
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
    ['one saved property that is not the primary', () => { db.__state.primaryCount = 0; }, 'Saved properties', /1 customer_properties/],
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
});

describe('commit', () => {
  test('confirmed: runs the customer page delete handler with the stub id, the operator, and the locked re-check', async () => {
    const result = await commit();
    expect(mockArchiveCustomerAsAdmin).toHaveBeenCalledTimes(1);
    expect(mockArchiveCustomerAsAdmin).toHaveBeenCalledWith({
      customerId: STUB_ID,
      actor: { technicianId: 'admin-7', userAgent: 'intelligence-bar:delete_duplicate_customer' },
      precheck: expect.any(Function),
    });
    expect(result).toMatchObject({ success: true, customer_id: STUB_ID, deleted: true, customer_message: 'No customer message is sent' });
    expect(result.restore).toMatch(/restore/);
    // The emptiness readers ran on the archive transaction (the precheck's conn).
    expect(mockLoserAutoBlockers).toHaveBeenCalledWith(db, expect.objectContaining({ id: STUB_ID }));
    expect(mockPreviewMergeEffects).toHaveBeenCalledWith(db, STUB_ID, STUB_ID);
  });

  test('history landed before the lock: the locked re-check throws, preview_changed, nothing deleted', async () => {
    mockPreviewMergeEffects.mockResolvedValue({ moving: { sms_log: 1, total_rows: 1 } });
    mockArchiveCustomerAsAdmin.mockImplementationOnce(async ({ precheck }) => {
      await precheck(db);
      throw new Error('unreachable: the delete must not run');
    });
    const result = await commit();
    expect(result).toMatchObject({ code: 'not_empty', preview_changed: true });
    expect(result.error).toMatch(/1 sms_log/);
  });

  test('the record version moved after the card: preview_changed (the route pins _approved_version)', async () => {
    const result = await run({ customer_id: STUB_ID, _approved_version: '2026-09-30 08:00:00+00' }, { confirmed: true, technicianId: 'admin-7' });
    expect(result).toMatchObject({ code: 'version_changed', preview_changed: true });
    // The approved version itself passes.
    expect(await run({ customer_id: STUB_ID, _approved_version: baseStub().version }, { confirmed: true, technicianId: 'admin-7' }))
      .toMatchObject({ success: true });
  });

  test('deleted elsewhere after the card: preview_changed', async () => {
    db.__state.stub = { ...baseStub(), deleted_at: new Date() };
    expect(await commit()).toMatchObject({ code: 'record_unavailable', preview_changed: true });
  });

  test("the route's own refusal is relayed (409 still billing); a 404 reads as preview_changed", async () => {
    mockArchiveCustomerAsAdmin.mockResolvedValueOnce({ status: 409, json: { error: 'customer_still_billing_or_scheduled', message: 'This customer still has an active prepay term. Cancel the plan before archiving.' } });
    expect(await commit()).toEqual({ error: 'This customer still has an active prepay term. Cancel the plan before archiving.' });
    mockArchiveCustomerAsAdmin.mockResolvedValueOnce({ status: 404, json: { error: 'Customer not found' } });
    expect(await commit()).toEqual({ error: 'Customer not found', preview_changed: true });
  });

  test('an unrelated failure in the delete surfaces as a tool error', async () => {
    mockArchiveCustomerAsAdmin.mockRejectedValueOnce(new Error('relink exploded'));
    expect(await commit()).toEqual({ error: 'relink exploded' });
  });

  test('a model-supplied confirmed field never commits', async () => {
    const result = await run({ customer_id: STUB_ID, confirmed: true }, {});
    expect(result.preview).toBe(true);
    expect(mockArchiveCustomerAsAdmin).not.toHaveBeenCalled();
  });
});

describe('pins and card contract', () => {
  test('the route pin (preview fingerprint) binds the stub version, the checks and the shared-phone record', async () => {
    const a = await preview();
    const same = await preview();
    expect(AuthorizationContract.previewFingerprint(same)).toBe(AuthorizationContract.previewFingerprint(a));
    db.__state.stub = { ...baseStub(), version: '2026-10-01 12:05:00.000001+00' };
    expect(AuthorizationContract.previewFingerprint(await preview())).not.toBe(AuthorizationContract.previewFingerprint(a));
    db.__state.stub = baseStub();
    db.__state.twins = [];
    expect(AuthorizationContract.previewFingerprint(await preview())).not.toBe(AuthorizationContract.previewFingerprint(a));
  });

  test('the contract: labelled, reversible, no customer contact, card lines only', async () => {
    const p = await preview();
    const contract = AuthorizationContract.buildContract({ toolName: 'delete_duplicate_customer', params: { customer_id: STUB_ID }, displayParams: p.card, preview: p });
    expect(contract).toMatchObject({ action_label: 'Delete empty duplicate customer', tier: 'yellow', irreversible: false, notifies_customer: false });
    const labels = contract.effects.map((e) => e.label);
    expect(labels).toEqual(expect.arrayContaining([
      'delete: Unknown (…0199), created 2026-10-01',
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
    // The fingerprint-verified preview's record version rides to the executor.
    expect(src).toContain("if (action.tool_name === 'delete_duplicate_customer' && livePreview?._version) execParams._approved_version = String(livePreview._version);");
  });

  test('the canonical delete and its restore route exist; the adapter runs the named delete handler', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'admin-customers.js'), 'utf8');
    expect(src).toContain("router.delete('/:id', requireAdmin, customerArchiveHandler);");
    expect(src).toContain("router.patch('/:id/restore', requireAdmin, async (req, res, next) => {");
    expect(src).toMatch(/async function archiveCustomerAsAdmin\([\s\S]*?customerArchiveHandler\(req, res, reject\)/);
    // The precheck runs right after the archive's row lock, before any write.
    expect(src).toContain("await trx('customers').where({ id: req.params.id }).forUpdate().first();\n        if (req.archivePrecheck) await req.archivePrecheck(trx);");
    expect(src).toContain('router.archiveCustomerAsAdmin = archiveCustomerAsAdmin;');
  });

  test('find_duplicates never suggests a deleted record (every grouping filters deleted_at)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'intelligence-bar', 'tools.js'), 'utf8');
    const body = src.slice(src.indexOf('async function findDuplicates('), src.indexOf('// ─── WRITE IMPLEMENTATIONS'));
    expect(body.match(/\.whereNull\('deleted_at'\)/g)).toHaveLength(3);
  });
});
