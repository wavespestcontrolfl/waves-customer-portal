// Admin alert relevance (owner ruling 2026-09-28: "we don't want garbage"): an
// unread admin bell clears itself when the customer / visit / invoice / estimate
// / lead it is about has moved on, and a fresh row that has ALREADY moved on is
// written activity-only through notifyAdmin's existing ringGate seam.
//
// The fake db below is a thenable knex-chain stub over in-memory mockTables: it
// honors where({..}), whereNull, whereIn, where('id','>',x) and the notification
// writes (insert / first / update) so the real NotificationService and the real
// module run end to end, and it records every query so batching and the
// candidate filter can be asserted. SQL text itself is not executed (Postgres
// suites skip locally). All identities are synthetic.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/internal-test-customers', () => ({ isInternalTestCustomerId: () => false }));
// The watchdog's annual-prepay validator: true/false, or an Error to throw.
let mockAnnualCovered;
jest.mock('../services/annual-prepay-renewals', () => ({
  ANNUAL_PREPAY_PREPAID_METHOD: 'annual_prepay_invoice',
  annualPrepayCoversVisit: jest.fn(async () => {
    if (mockAnnualCovered instanceof Error) throw mockAnnualCovered;
    return mockAnnualCovered === true;
  }),
}));

let mockTables;
let mockQueries;
let mockHooks;
let mockFailTable;
let mockTrxs;
jest.mock('../models/db', () => {
  const strip = (col) => String(col).split('.').pop();
  const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : v || {});
  // Key-order-free JSON, like jsonb equality.
  const canon = (v) => (v && typeof v === 'object'
    ? (Array.isArray(v) ? `[${v.map(canon).join(',')}]` : `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`)
    : JSON.stringify(v ?? null));
  const builder = (table) => {
    const conds = [];
    const q = { table, calls: [] };
    let cap = null;
    const b = {};
    for (const m of ['select', 'leftJoin', 'orderBy', 'groupBy', 'max', 'whereNotIn', 'forShare', 'forUpdate']) {
      b[m] = (...args) => { q.calls.push([m, ...args]); return b; };
    }
    b.limit = (n) => { cap = n; q.calls.push(['limit', n]); return b; };
    b.modify = (fn) => { fn(b); return b; };
    b.where = (...args) => {
      q.calls.push(['where', ...args]);
      if (args.length === 1 && args[0] && typeof args[0] === 'object') Object.entries(args[0]).forEach(([k, v]) => conds.push((r) => r[k] === v));
      if (args.length === 2 && typeof args[0] === 'string') conds.push((r) => r[strip(args[0])] === args[1]);
      if (args.length === 3 && args[0] === 'id' && args[1] === '>') conds.push((r) => String(r.id) > String(args[2]));
      return b;
    };
    b.whereNull = (col) => { q.calls.push(['whereNull', col]); conds.push((r) => r[col] == null); return b; };
    b.whereIn = (col, ids) => { q.calls.push(['whereIn', col, ids]); conds.push((r) => ids.includes(String(r[strip(col)]))); return b; };
    b.whereRaw = (sql, args = []) => {
      q.calls.push(['whereRaw', sql, args]);
      const text = String(sql);
      const meta = (r) => (r.metadata == null ? null : parse(r.metadata));
      if (text.startsWith("metadata->>'dedupeKey' =")) conds.push((r) => parse(r.metadata).dedupeKey === args[0]);
      // The retire's version fence and its own-stamp match.
      if (text === 'link IS NOT DISTINCT FROM ?') conds.push((r) => (r.link ?? null) === (args[0] ?? null));
      if (text === 'metadata IS NOT DISTINCT FROM ?::jsonb') conds.push((r) => canon(meta(r)) === canon(args[0] == null ? null : JSON.parse(args[0])));
      if (text === "metadata->'retired'->>'at' = ?") conds.push((r) => meta(r)?.retired?.at === args[0]);
      // Clear-on-absence: bell-visible, under a key prefix, not a key raised this run.
      if (text === "COALESCE(metadata->>'feed', '') <> 'activity'") conds.push((r) => meta(r)?.feed !== 'activity');
      if (text === "left(COALESCE(metadata->>'dedupeKey', ''), ?) = ?") conds.push((r) => String(meta(r)?.dedupeKey || '').slice(0, args[0]) === args[1]);
      if (text === "NOT (metadata->>'dedupeKey' = ANY(?::text[]))") conds.push((r) => !args[0].includes(meta(r)?.dedupeKey));
      return b;
    };
    const hit = () => (mockTables[table] || []).filter((r) => conds.every((c) => c(r)));
    b.first = async () => {
      mockQueries.push(q);
      if (mockHooks[`${table}:first`]) mockHooks[`${table}:first`]();
      return hit()[0] || null;
    };
    b.update = (patch) => {
      let applied = null;
      const apply = () => {
        if (applied) return applied;
        mockQueries.push(q);
        applied = hit();
        applied.forEach((r) => {
          const { metadata, ...rest } = patch;
          Object.assign(r, rest);
          if (metadata && metadata.__raw && /- 'retired'/.test(metadata.__raw)) {
            const { retired: _dropped, ...kept } = parse(r.metadata);
            r.metadata = JSON.stringify({ ...kept, ...(metadata.bindings?.[0] ? JSON.parse(metadata.bindings[0]) : {}) });
          } else if (metadata && metadata.__raw) r.metadata = JSON.stringify({ ...parse(r.metadata), ...JSON.parse(metadata.bindings[0]) });
          else if (metadata !== undefined) r.metadata = metadata;
        });
        return applied;
      };
      const done = Promise.resolve().then(() => apply().length);
      done.returning = async () => apply().map((r) => ({ id: r.id, read_at: r.read_at }));
      return done;
    };
    b.insert = (row) => ({
      returning: async () => {
        const created = { id: `00000000-0000-4000-8000-9${String((mockTables[table] ||= []).length).padStart(11, '0')}`, ...row };
        mockTables[table].push(created);
        return [created];
      },
    });
    b.then = (res, rej) => {
      mockQueries.push(q);
      return Promise.resolve().then(() => {
        if (mockFailTable === table) throw new Error(`boom:${table}`);
        if (mockHooks[table]) mockHooks[table]();
        const rows = hit();
        return cap ? rows.sort((a, c) => String(a.id).localeCompare(String(c.id))).slice(0, cap) : rows;
      }).then(res, rej);
    };
    return b;
  };
  const fn = jest.fn((table) => builder(table));
  fn.fn = { now: () => 'NOW' };
  fn.raw = jest.fn((sql, bindings) => ({ __raw: sql, bindings }));
  const makeTrx = () => {
    const trx = jest.fn((table) => builder(table));
    trx.raw = jest.fn((sql, bindings) => ({ __raw: sql, bindings }));
    trx.fn = fn.fn;
    trx.transaction = jest.fn(async (cb) => cb(trx));
    mockTrxs.push(trx);
    return trx;
  };
  fn.transaction = jest.fn(async (cb) => cb(makeTrx()));
  return fn;
});

const db = require('../models/db');
const NotificationService = require('../services/notification-service');
const {
  runAdminAlertRelevanceSweep, classify, loadSubjects, subjectFor, refsFromRow, ringTimeCheck, retireKeysNoLongerRaised,
} = require('../services/admin-alert-relevance');
const { adminAlertRelevanceLive } = require('../config/feature-gates');

const TODAY = '2026-09-28';
const NOW = new Date('2026-09-28T16:00:00Z');
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const CUST = uid(1);
const CUST2 = uid(8);
const VISIT = uid(2);
const PARENT = uid(3);
const INV = uid(4);
const INV2 = uid(5);
const EST = uid(6);
const LEAD = uid(7);

let seq = 0;
const note = (over = {}) => ({
  id: uid(100 + (seq += 1)), recipient_type: 'admin', read_at: null, created_at: new Date('2026-09-27T12:00:00Z'),
  link: null, ...over, metadata: JSON.stringify(over.metadata || {}),
});
const customer = (over = {}) => ({ id: CUST, churned_at: null, deleted_at: null, ...over });
const visit = (over = {}) => ({
  id: VISIT, customer_id: CUST, status: 'pending', is_recurring: true, recurring_parent_id: null,
  estimated_price: null, primary_line_price: null, prepaid_amount: null, prepaid_method: null,
  first_application_invoice_id: null, first_application_invoice_status: null,
  parent_estimated_price: null, parent_primary_line_price: null, ...over,
});
const invoice = (over = {}) => ({ id: INV, customer_id: CUST, status: 'draft', ...over });

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.ADMIN_ALERT_RELEVANCE;
  mockTables = { notifications: [], customers: [customer()], scheduled_services: [], 'scheduled_services as ss': [], invoices: [], leads: [], estimates: [] };
  mockQueries = [];
  mockHooks = {};
  mockFailTable = null;
  mockTrxs = [];
  mockAnnualCovered = false;
});

// The reason a row's class gives against the current fake mockTables (null = still relevant).
async function reasonFor(row) {
  const cls = classify(row);
  if (!cls) return { cls: null, reason: null };
  const data = await loadSubjects([row]);
  return { cls: cls.key, reason: cls.rule(subjectFor(row, data, TODAY)) || null };
}

describe('kill switch', () => {
  test.each([[undefined, true], ['', true], ['on', true], ['true', true], ['off', false], ['OFF', false], [' False ', false], ['0', false], ['false', false]])(
    'ADMIN_ALERT_RELEVANCE=%j -> live=%s', (value, live) => {
      if (value === undefined) delete process.env.ADMIN_ALERT_RELEVANCE; else process.env.ADMIN_ALERT_RELEVANCE = value;
      expect(adminAlertRelevanceLive()).toBe(live);
    });
});

describe('subject references are parsed defensively', () => {
  test('metadata keys, payload and link params all resolve; bad ids never throw', () => {
    const refs = refsFromRow(note({
      link: `/admin/dispatch?tab=schedule&appointment=${VISIT}&invoice=${INV}&estimateId=${EST}&lead=${LEAD}&customerId=${CUST}`,
      metadata: { divergingSiblingIds: [PARENT, 'not-a-uuid', 42, null], stampedInvoiceId: INV2 },
    }));
    expect(refs).toMatchObject({ customerId: CUST, visitId: VISIT, estimateId: EST, leadId: LEAD });
    expect(refs.visitIds).toEqual([VISIT, PARENT]);
    expect(refs.invoiceIds).toEqual([INV, INV2]);
    expect(refsFromRow(note({ metadata: { payload: { leadId: LEAD, customerId: CUST } } }))).toMatchObject({ leadId: LEAD, customerId: CUST });
    const junk = refsFromRow({ link: 'http://[bad', metadata: '{not json', category: 'alert' });
    expect(junk).toMatchObject({ customerId: null, visitId: null, estimateId: null, leadId: null, visitIds: [], invoiceIds: [] });
    expect(refsFromRow({ metadata: { customerId: { $ne: 1 }, scheduledServiceId: ['x'] } })).toMatchObject({ customerId: null, visitId: null });
  });

  test('a batch reads each table once, and a row with only bad ids reads nothing', async () => {
    mockTables.scheduled_services = [];
    mockTables['scheduled_services as ss'] = [visit(), visit({ id: PARENT })];
    mockTables.invoices = [invoice()];
    await loadSubjects([
      note({ category: 'alert', metadata: { dedupeKey: 'unpriced-series:a', scheduled_service_id: VISIT, customer_id: CUST } }),
      note({ category: 'alert', metadata: { dedupeKey: 'stale-visit:b', scheduled_service_id: PARENT, customer_id: CUST } }),
      note({ category: 'billing', metadata: { invoiceId: INV } }),
    ]);
    const counts = mockQueries.reduce((a, q) => ({ ...a, [q.table]: (a[q.table] || 0) + 1 }), {});
    expect(counts).toEqual({ 'scheduled_services as ss': 1, invoices: 1, customers: 1 });
    mockQueries = [];
    await loadSubjects([note({ metadata: { scheduledServiceId: 'nope', customerId: 'nope' } })]);
    expect(mockQueries).toEqual([]);
  });
});

describe('class rules', () => {
  const divergence = (metadata = {}) => note({
    category: 'billing', link: `/admin/invoices?invoice=${INV}`,
    metadata: { dedupeKey: `first_application_sibling_divergence:${EST}:${INV}:x`, alertKind: 'diverged', customerId: CUST, invoiceId: INV, stampedInvoiceId: INV, ...metadata },
  });

  test('first-application divergence: retires only when the customer left AND the invoice is an unsent draft or void', async () => {
    mockTables.customers = [customer({ churned_at: new Date() })];
    for (const status of ['draft', 'void']) {
      mockTables.invoices = [invoice({ status })];
      expect(await reasonFor(divergence())).toMatchObject({ cls: 'first_application_divergence', reason: expect.stringContaining('Customer left') });
    }
    mockTables.customers = [customer({ deleted_at: new Date() })];
    mockTables.invoices = [invoice()];
    expect((await reasonFor(divergence())).reason).toEqual(expect.any(String));
  });

  test('first-application divergence: money paid, processing, sent or refunded keeps ringing — and so do other alert kinds', async () => {
    mockTables.customers = [customer({ churned_at: new Date() })];
    for (const status of ['paid', 'prepaid', 'processing', 'sent', 'viewed', 'refunded', 'scheduled', 'sending']) {
      mockTables.invoices = [invoice({ status })];
      expect((await reasonFor(divergence())).reason).toBeNull();
    }
    mockTables.invoices = [invoice()];
    for (const alertKind of ['paid_never_ran', 'payment_pending_never_ran', undefined]) {
      expect((await reasonFor(divergence({ alertKind }))).reason).toBeNull();
    }
    // Governing replacement is a draft but the stamped invoice was actually sent: one live money invoice keeps it ringing.
    mockTables.invoices = [invoice({ id: INV }), invoice({ id: INV2, status: 'sent' })];
    expect((await reasonFor(divergence({ stampedInvoiceId: INV2 }))).reason).toBeNull();
    // Invoice row missing or not referenced: cannot prove no money is involved.
    mockTables.invoices = [];
    expect((await reasonFor(divergence())).reason).toBeNull();
    mockTables.invoices = [invoice()];
    expect((await reasonFor({ ...divergence({ invoiceId: null, stampedInvoiceId: null }), link: '/admin/estimates' })).reason).toBeNull();
  });

  test('first-application divergence: a customer who is still here — or merely paused — keeps it ringing', async () => {
    mockTables.invoices = [invoice()];
    mockTables.customers = [customer()];
    expect((await reasonFor(divergence())).reason).toBeNull();
    mockTables.customers = [customer({ paused_at: new Date(), status: 'paused' })];
    expect((await reasonFor(divergence())).reason).toBeNull();
  });

  const unpriced = () => note({ category: 'alert', metadata: { dedupeKey: `unpriced-series:${PARENT}`, scheduled_service_id: VISIT, customer_id: CUST, series_root_id: PARENT } });

  test('unpriced series: still relevant while the visit is open, unpriced and the customer is here', async () => {
    mockTables['scheduled_services as ss'] = [visit()];
    expect(await reasonFor(unpriced())).toEqual({ cls: 'unpriced_series', reason: null });
  });

  test.each([
    ['customer churned', () => { mockTables.customers = [customer({ churned_at: new Date() })]; }, 'Customer left'],
    ['visit cancelled', () => { mockTables['scheduled_services as ss'] = [visit({ status: 'cancelled' })]; }, 'no longer open'],
    ['visit completed', () => { mockTables['scheduled_services as ss'] = [visit({ status: 'completed' })]; }, 'no longer open'],
    ['visit skipped', () => { mockTables['scheduled_services as ss'] = [visit({ status: 'skipped' })]; }, 'no longer open'],
    ['visit no-show', () => { mockTables['scheduled_services as ss'] = [visit({ status: 'no_show' })]; }, 'no longer open'],
    ['visit gone', () => { mockTables['scheduled_services as ss'] = []; }, 'no longer open'],
    ['visit now priced', () => { mockTables['scheduled_services as ss'] = [visit({ estimated_price: '99.00' })]; }, 'carries a price'],
    ['parent priced', () => { mockTables['scheduled_services as ss'] = [visit({ recurring_parent_id: PARENT, parent_primary_line_price: '72.00' })]; }, 'carries a price'],
    ['covered by a live combined invoice', () => { mockTables['scheduled_services as ss'] = [visit({ first_application_invoice_id: INV, first_application_invoice_status: 'sent' })]; }, 'covered'],
  ])('unpriced series: %s -> retired', async (_label, arrange, text) => {
    mockTables['scheduled_services as ss'] = [visit()];
    arrange();
    expect((await reasonFor(unpriced())).reason).toEqual(expect.stringContaining(text));
  });

  test('unpriced series: an annual-prepay stamp clears it only once the watchdog validator confirms the term (fail-closed)', async () => {
    const stamped = visit({ prepaid_method: 'annual_prepay_invoice', prepaid_amount: '98.01', annual_prepay_term_id: PARENT });
    mockTables['scheduled_services as ss'] = [stamped];
    mockAnnualCovered = true;
    expect((await reasonFor(unpriced())).reason).toEqual(expect.stringContaining('paid annual prepay'));
    mockTables['scheduled_services as ss'] = [{ ...stamped }];
    mockAnnualCovered = false;
    expect((await reasonFor(unpriced())).reason).toBeNull();
    mockTables['scheduled_services as ss'] = [{ ...stamped }];
    mockAnnualCovered = new Error('terms table unavailable');
    expect((await reasonFor(unpriced())).reason).toBeNull();
  });

  test('unpriced series: a merged-away (soft-deleted) profile frozen in the alert is not "customer left" when the live visit now belongs to the survivor', async () => {
    const merged = note({ category: 'alert', metadata: { dedupeKey: `unpriced-series:${PARENT}`, scheduled_service_id: VISIT, customer_id: CUST2, series_root_id: PARENT } });
    mockTables.customers = [customer(), customer({ id: CUST2, deleted_at: new Date() })];
    mockTables['scheduled_services as ss'] = [visit({ customer_id: CUST })];
    expect((await reasonFor(merged)).reason).toBeNull();
  });

  test('unpriced series: a voided combined invoice does not cover the visit', async () => {
    mockTables['scheduled_services as ss'] = [visit({ first_application_invoice_id: INV, first_application_invoice_status: 'void' })];
    expect((await reasonFor(unpriced())).reason).toBeNull();
  });

  test.each([['stale-visit:', 'stale_visit'], ['prepay-coverage:', 'prepay_coverage']])('%s alerts retire when the visit closed or the customer left', async (prefix, key) => {
    const row = note({ category: 'alert', metadata: { dedupeKey: `${prefix}${VISIT}:x`, scheduled_service_id: VISIT, customer_id: CUST } });
    mockTables['scheduled_services as ss'] = [visit({ status: 'on_site' })];
    expect(await reasonFor(row)).toEqual({ cls: key, reason: null });
    mockTables['scheduled_services as ss'] = [visit({ status: 'completed' })];
    expect((await reasonFor(row)).reason).toEqual(expect.stringContaining('no longer open'));
    mockTables['scheduled_services as ss'] = [visit({ status: 'on_site' })];
    mockTables.customers = [customer({ churned_at: new Date() })];
    expect((await reasonFor(row)).reason).toBe('Customer left');
  });

  test('accepted recurring plan review retires only when the customer left', async () => {
    const row = note({ category: 'alert', metadata: { dedupeKey: `accepted-schedule:${EST}:pest`, customer_id: CUST, estimate_id: EST } });
    expect(await reasonFor(row)).toEqual({ cls: 'accepted_schedule', reason: null });
    mockTables.customers = [customer({ deleted_at: new Date() })];
    expect((await reasonFor(row)).reason).toBe('Customer left');
  });

  const move = (metadata = {}) => note({
    category: 'schedule_conflict', link: '/admin/dispatch?tab=schedule',
    metadata: { scheduledServiceId: VISIT, seriesMoveId: 'move-1', conflicts: [], overlapDates: ['2026-10-05'], preservedOccurrences: [], ...metadata },
  });

  test('series move: relevant while any flagged date is today or later', async () => {
    mockTables['scheduled_services as ss'] = [visit()];
    expect(await reasonFor(move())).toEqual({ cls: 'series_move', reason: null });
    expect((await reasonFor(move({ overlapDates: ['2026-09-20'], conflicts: [{ id: VISIT, date: '2026-09-28' }] }))).reason).toBeNull();
  });

  test('series move: every overlap / conflict / preserved date in the past (Eastern), every visit it named closed, or the customer left', async () => {
    mockTables['scheduled_services as ss'] = [visit()];
    expect((await reasonFor(move({ overlapDates: ['2026-09-20', '2026-09-27'], conflicts: [{ id: VISIT, date: '2026-09-01' }], preservedOccurrences: [{ date: '2026-08-01' }] }))).reason)
      .toEqual(expect.stringContaining('passed'));
    mockTables['scheduled_services as ss'] = [visit({ status: 'cancelled' })];
    expect((await reasonFor(move())).reason).toEqual(expect.stringContaining('closed'));
    mockTables['scheduled_services as ss'] = [visit()];
    mockTables.customers = [customer({ churned_at: new Date() })];
    expect((await reasonFor(move())).reason).toBe('Customer left');
  });

  test('series move: cancelling only the moved visit keeps the alert while a conflict or preserved occurrence it named is still open', async () => {
    const named = move({ conflicts: [{ id: PARENT, date: '2026-10-12' }], preservedOccurrences: [{ id: uid(9), date: '2026-11-09' }] });
    mockTables['scheduled_services as ss'] = [visit({ status: 'cancelled' }), visit({ id: PARENT, status: 'pending' }), visit({ id: uid(9), status: 'completed' })];
    expect((await reasonFor(named)).reason).toBeNull();
    mockTables['scheduled_services as ss'] = [visit({ status: 'cancelled' }), visit({ id: PARENT, status: 'cancelled' }), visit({ id: uid(9), status: 'completed' })];
    expect((await reasonFor(named)).reason).toEqual(expect.stringContaining('closed'));
  });

  test('a schedule_conflict row that is not a series move is not in the table', () => {
    expect(classify(note({ category: 'schedule_conflict', metadata: { scheduledServiceId: VISIT } }))).toBeNull();
  });

  test.each([['accepted', true], ['declined', true], ['expired', true], ['viewed', false], ['sent', false]])(
    'estimate hot view: status %s -> retired=%s', async (status, retired) => {
      mockTables.estimates = [{ id: EST, status, archived_at: null, sent_at: null, customer_id: CUST }];
      const row = note({ category: 'estimate_hot_view', link: `/admin/estimates?estimateId=${EST}`, metadata: { dedupeKey: `estimate_hot_view:${EST}`, estimateId: EST } });
      expect((await reasonFor(row)).reason !== null).toBe(retired);
    });

  test('estimate hot view: an archived estimate retires; a missing one is unknown', async () => {
    const row = note({ category: 'estimate_hot_view', metadata: { estimateId: EST } });
    mockTables.estimates = [{ id: EST, status: 'viewed', archived_at: new Date(), sent_at: null, customer_id: CUST }];
    expect((await reasonFor(row)).reason).toEqual(expect.stringContaining('archived'));
    mockTables.estimates = [];
    expect((await reasonFor(row)).reason).toBeNull();
  });

  const leadNote = (extra = {}) => note({
    category: 'new_lead', link: `/admin/leads?lead=${LEAD}`, metadata: { triggerKey: 'new_lead', payload: { leadId: LEAD }, ...extra },
  });
  const lead = (over = {}) => ({ id: LEAD, status: 'new', converted_at: null, deleted_at: null, created_at: new Date('2026-09-27T10:00:00Z'), customer_id: CUST, estimate_id: null, ...over });

  test.each([
    ['new', false], ['contacted', false], ['open', false], ['qualified', false],
    ['estimate_sent', true], ['estimate_viewed', true], ['won', true], ['lost', true], ['duplicate', true], ['spam', true], ['unresponsive', true], ['disqualified', true],
  ])('new lead: status %s -> retired=%s', async (status, retired) => {
    mockTables.leads = [lead({ status })];
    expect((await reasonFor(leadNote())).reason !== null).toBe(retired);
  });

  test('new lead: deleted, converted, estimate sent, or a visit booked after it was created retires it; anything earlier or unknown does not', async () => {
    mockTables.leads = [lead({ deleted_at: new Date() })];
    expect((await reasonFor(leadNote())).reason).toEqual(expect.stringContaining('deleted'));
    mockTables.leads = [lead({ converted_at: new Date() })];
    expect((await reasonFor(leadNote())).reason).toEqual(expect.stringContaining('converted'));
    mockTables.leads = [lead({ estimate_id: EST })];
    mockTables.estimates = [{ id: EST, status: 'sent', archived_at: null, sent_at: new Date(), customer_id: CUST }];
    expect((await reasonFor(leadNote())).reason).toEqual(expect.stringContaining('Estimate'));
    mockTables.estimates = [{ id: EST, status: 'draft', archived_at: null, sent_at: null, customer_id: CUST }];
    expect((await reasonFor(leadNote())).reason).toBeNull();
    mockTables.leads = [lead()];
    mockTables.scheduled_services = [{ customer_id: CUST, latest_created_at: new Date('2026-09-27T15:00:00Z') }];
    expect((await reasonFor(leadNote())).reason).toEqual(expect.stringContaining('visit'));
    mockTables.scheduled_services = [{ customer_id: CUST, latest_created_at: new Date('2026-09-20T15:00:00Z') }];
    expect((await reasonFor(leadNote())).reason).toBeNull();
    // A child the system generated on its own (series top-up, seeded follow-up)
    // after the lead is not a booking anyone made for it.
    mockTables.scheduled_services = [
      { customer_id: CUST, latest_created_at: new Date('2026-09-27T15:00:00Z'), recurring_parent_id: VISIT },
      { customer_id: CUST, latest_created_at: new Date('2026-09-27T16:00:00Z'), parent_service_id: VISIT },
    ];
    expect((await reasonFor(leadNote())).reason).toBeNull();
    // Degraded emitter path: leadId is really a customer id, no lead row -> unknown, never "deleted".
    mockTables.leads = [];
    expect((await reasonFor(leadNote())).reason).toBeNull();
    // Lead id from the link alone.
    mockTables.leads = [lead({ status: 'won' })];
    expect((await reasonFor(note({ category: 'new_lead', link: `/admin/leads?lead=${LEAD}` }))).cls).toBe('new_lead');
    expect(classify(note({ category: 'new_lead', link: '/admin/leads' }))).toBeNull();
  });

  test('customer-contact bells and money-owed alerts are never in the table, whatever their metadata says', () => {
    const lookalike = { customerId: CUST, invoiceId: INV, scheduled_service_id: VISIT, alertKind: 'diverged', seriesMoveId: 'm', estimateId: EST, payload: { leadId: LEAD } };
    for (const category of ['inbound_sms', 'inbound_email', 'missed_call', 'voicemail_callback', 'review', 'payment', 'payment_failed', 'refund', 'dispute', 'system']) {
      for (const dedupeKey of [null, 'unpriced-series:x', 'stale-visit:x', 'prepay-coverage:x', 'accepted-schedule:x', 'first_application_sibling_divergence:x']) {
        expect(classify(note({ category, metadata: { ...lookalike, ...(dedupeKey ? { dedupeKey } : {}) } }))).toBeNull();
      }
    }
    // Same categories the classes use, but another emitter's dedupe key.
    expect(classify(note({ category: 'billing', metadata: { dedupeKey: 'payment-failed:x', alertKind: 'diverged' } }))).toBeNull();
    expect(classify(note({ category: 'alert', metadata: { dedupeKey: 'sms-commitment:x' } }))).toBeNull();
  });
});

describe('pushIsMovedOn (the push verdict for the trigger dispatcher)', () => {
  const { pushIsMovedOn } = require('../services/admin-alert-relevance');
  const leadEvent = { category: 'new_lead', link: null, metadata: { triggerKey: 'new_lead', payload: { leadId: LEAD } } };
  const leadRow = (over = {}) => ({ id: LEAD, status: 'new', converted_at: null, deleted_at: null, created_at: new Date('2026-09-28T12:00:00Z'), customer_id: CUST, estimate_id: null, ...over });

  test('a bell row written activity-only at ring time stays silent; a rung or sweep-retired row pushes', async () => {
    const quiet = { metadata: { feed: 'activity', quiet: true, retired: { by: 'alert-relevance', reason: 'x' } } };
    expect(await pushIsMovedOn({ bellRow: quiet, bellWritten: true, pushTo: ['a'], ...leadEvent })).toBe(true);
    expect(await pushIsMovedOn({ bellRow: { metadata: { retired: { by: 'alert-relevance' } } }, bellWritten: true, pushTo: ['a'], ...leadEvent })).toBe(false);
    expect(await pushIsMovedOn({ bellRow: { metadata: JSON.stringify({ triggerKey: 'new_lead' }) }, bellWritten: true, pushTo: ['a'], ...leadEvent })).toBe(false);
  });

  test('push-only (no bell row): judged directly — a worked lead stays silent, a new one pushes, nobody to push or the switch off never reads', async () => {
    mockTables.leads = [leadRow({ status: 'won' })];
    expect(await pushIsMovedOn({ bellRow: null, bellWritten: false, pushTo: ['a'], ...leadEvent })).toBe(true);
    mockTables.leads = [leadRow()];
    expect(await pushIsMovedOn({ bellRow: null, bellWritten: false, pushTo: ['a'], ...leadEvent })).toBe(false);
    db.mockClear();
    expect(await pushIsMovedOn({ bellRow: null, bellWritten: false, pushTo: [], ...leadEvent })).toBe(false);
    process.env.ADMIN_ALERT_RELEVANCE = 'off';
    mockTables.leads = [leadRow({ status: 'won' })];
    expect(await pushIsMovedOn({ bellRow: null, bellWritten: false, pushTo: ['a'], ...leadEvent })).toBe(false);
    expect(db).not.toHaveBeenCalled();
  });

  test('a failed read fails open (pushes); an event outside the table is never judged', async () => {
    mockTables.leads = [leadRow({ status: 'won' })];
    mockFailTable = 'leads';
    expect(await pushIsMovedOn({ bellRow: null, bellWritten: false, pushTo: ['a'], ...leadEvent })).toBe(false);
    mockFailTable = null;
    expect(await pushIsMovedOn({ bellRow: null, bellWritten: false, pushTo: ['a'], category: 'inbound_sms', metadata: { customerId: CUST } })).toBe(false);
  });
});

describe('runAdminAlertRelevanceSweep', () => {
  const staleNote = (id, over = {}) => note({ id, category: 'alert', metadata: { dedupeKey: `stale-visit:${id}`, scheduled_service_id: VISIT, customer_id: CUST, ...over } });

  test('retires only unread matching rows whose subject moved on; stamps the reason and touches nothing else', async () => {
    mockTables['scheduled_services as ss'] = [visit({ status: 'completed', customer_id: CUST2 })];
    const divergenceMeta = { dedupeKey: `first_application_sibling_divergence:${EST}:${INV}:z`, dedupeVersion: 'fp::g2', autoCleared: false, recurrenceGeneration: 2, alertKind: 'diverged', invoiceId: INV, stampedInvoiceId: INV, customerId: CUST };
    mockTables.customers = [customer({ churned_at: new Date('2026-09-21T12:00:00Z') }), customer({ id: CUST2 })];
    mockTables.invoices = [invoice()];
    const stale = staleNote(uid(501), { customer_id: CUST2 });
    const divergence = note({ id: uid(502), category: 'billing', metadata: divergenceMeta });
    const alreadyRead = { ...staleNote(uid(503), { customer_id: CUST2 }), read_at: new Date('2026-09-27T13:00:00Z') };
    const paid = note({ id: uid(504), category: 'billing', metadata: { ...divergenceMeta, dedupeKey: `${divergenceMeta.dedupeKey}2`, alertKind: 'paid_never_ran' } });
    const contact = note({ id: uid(505), category: 'inbound_sms', metadata: { customerId: CUST } });
    mockTables.notifications = [stale, divergence, alreadyRead, paid, contact];

    const result = await runAdminAlertRelevanceSweep({ now: NOW });
    expect(result).toEqual({ skipped: false, scanned: 4, retired: 2, byClass: { stale_visit: 1, first_application_divergence: 1 } });
    expect(stale.read_at).toBeInstanceOf(Date);
    expect(JSON.parse(stale.metadata).retired).toEqual({ by: 'alert-relevance', reason: 'Visit is no longer open', at: NOW.toISOString() });
    // Pure read + retired marker: every emitter-owned key survives as it was.
    expect(JSON.parse(divergence.metadata)).toEqual({ ...divergenceMeta, retired: { by: 'alert-relevance', reason: expect.stringContaining('Customer left'), at: NOW.toISOString() } });
    expect(alreadyRead.read_at).toEqual(new Date('2026-09-27T13:00:00Z'));
    expect(JSON.parse(alreadyRead.metadata).retired).toBeUndefined();
    for (const untouched of [paid, contact]) { expect(untouched.read_at).toBeNull(); expect(JSON.parse(untouched.metadata).retired).toBeUndefined(); }
  });

  test('the candidate query is unread, admin and bell-visible, with no age cut-off (a refreshed bell keeps its first created_at)', async () => {
    mockTables.notifications = [];
    await runAdminAlertRelevanceSweep({ now: NOW });
    const q = mockQueries.find((x) => x.table === 'notifications');
    const flat = JSON.stringify(q.calls);
    expect(q.calls).toEqual(expect.arrayContaining([['where', { recipient_type: 'admin' }], ['whereNull', 'read_at']]));
    expect(flat).toContain("metadata->>'feed'");
    expect(flat).not.toContain('created_at');
  });

  test('an unread bell first raised months ago (then re-rung by a refresh) is still judged and retired', async () => {
    mockTables['scheduled_services as ss'] = [visit({ status: 'completed' })];
    const old = { ...staleNote(uid(540)), created_at: new Date('2026-06-01T12:00:00Z') };
    mockTables.notifications = [old];
    expect(await runAdminAlertRelevanceSweep({ now: NOW })).toMatchObject({ scanned: 1, retired: 1 });
    expect(old.read_at).toBeInstanceOf(Date);
  });

  const divergenceRow = (id) => note({ id, category: 'billing', metadata: { dedupeKey: `first_application_sibling_divergence:${EST}:${INV}:z`, alertKind: 'diverged', invoiceId: INV, stampedInvoiceId: INV, customerId: CUST } });
  const churnedWithDraft = () => {
    mockTables.customers = [customer({ churned_at: new Date('2026-09-21T12:00:00Z') })];
    mockTables.invoices = [invoice()];
  };

  test('the retirement is judged on a fresh read: a payment that starts after the batch read keeps the divergence alert ringing', async () => {
    churnedWithDraft();
    const row = divergenceRow(uid(550));
    mockTables.notifications = [row];
    let invoiceReads = 0;
    mockHooks.invoices = () => { invoiceReads += 1; if (invoiceReads === 2) mockTables.invoices[0].status = 'processing'; };
    expect(await runAdminAlertRelevanceSweep({ now: NOW })).toMatchObject({ scanned: 1, retired: 0 });
    expect(row.read_at).toBeNull();
    expect(JSON.parse(row.metadata).retired).toBeUndefined();
  });

  test('a change that lands between the write and the final judgement puts the bell back exactly as it was', async () => {
    churnedWithDraft();
    const row = divergenceRow(uid(551));
    const before = JSON.parse(row.metadata);
    mockTables.notifications = [row];
    let invoiceReads = 0;
    mockHooks.invoices = () => { invoiceReads += 1; if (invoiceReads === 3) mockTables.invoices[0].status = 'processing'; };
    expect(await runAdminAlertRelevanceSweep({ now: NOW })).toMatchObject({ scanned: 1, retired: 0 });
    expect(row.read_at).toBeNull();
    expect(JSON.parse(row.metadata)).toEqual(before);
  });

  test('re-arm: a retired unpriced-series bell frees its forever-dedupe key, so the price removed again rings a fresh bell', async () => {
    const key = `unpriced-series:${PARENT}`;
    mockTables['scheduled_services as ss'] = [visit({ estimated_price: '99.00' })];
    const row = note({ id: uid(555), category: 'alert', metadata: { dedupeKey: key, scheduled_service_id: VISIT, customer_id: CUST } });
    mockTables.notifications = [row];
    expect(await runAdminAlertRelevanceSweep({ now: NOW })).toMatchObject({ retired: 1, byClass: { unpriced_series: 1 } });
    expect(JSON.parse(row.metadata)).toMatchObject({ dedupeKey: null, retired: { dedupeKey: key, reason: expect.stringContaining('price') } });
    // The price is removed again; the watchdog raises the same stable key.
    mockTables['scheduled_services as ss'] = [visit()];
    const again = await NotificationService.notifyAdmin('alert', 'Recurring service has no price', 'body', {
      bell: true, dedupeKey: key, metadata: { dedupeKey: key, scheduled_service_id: VISIT, customer_id: CUST },
    });
    expect(again.deduped).toBe(false);
    expect(mockTables.notifications).toHaveLength(2);
    const fresh = mockTables.notifications.find((r) => r.id !== row.id);
    expect(fresh.read_at == null).toBe(true);
    expect(JSON.parse(fresh.metadata).feed).toBeUndefined();
  });

  test('re-arm put-back: a change between the write and the final judgement restores the dedupe key with the bell', async () => {
    const key = `unpriced-series:${PARENT}`;
    mockTables['scheduled_services as ss'] = [visit({ estimated_price: '99.00' })];
    const row = note({ id: uid(556), category: 'alert', metadata: { dedupeKey: key, scheduled_service_id: VISIT, customer_id: CUST } });
    mockTables.notifications = [row];
    let visitReads = 0;
    mockHooks['scheduled_services as ss'] = () => { visitReads += 1; if (visitReads === 3) mockTables['scheduled_services as ss'] = [visit()]; };
    expect(await runAdminAlertRelevanceSweep({ now: NOW })).toMatchObject({ retired: 0 });
    expect(row.read_at).toBeNull();
    expect(JSON.parse(row.metadata)).toEqual({ dedupeKey: key, scheduled_service_id: VISIT, customer_id: CUST });
  });

  test('the retire writes an explicit millisecond read_at (never NOW(), whose microseconds a read-back would lose) and the put-back matches it exactly', async () => {
    churnedWithDraft();
    const row = divergenceRow(uid(557));
    mockTables.notifications = [row];
    const retireWrites = [];
    let invoiceReads = 0;
    mockHooks.invoices = () => {
      invoiceReads += 1;
      if (invoiceReads === 3) { retireWrites.push(row.read_at); mockTables.invoices[0].status = 'processing'; }
    };
    await runAdminAlertRelevanceSweep({ now: NOW });
    expect(retireWrites[0]).toBeInstanceOf(Date);
    expect(retireWrites[0]).not.toBe('NOW');
    expect(row.read_at).toBeNull(); // put back by an exact read_at match
  });

  test('a person who reads the bell in that window keeps their read: nothing is put back over it', async () => {
    churnedWithDraft();
    const row = divergenceRow(uid(552));
    mockTables.notifications = [row];
    const theirRead = new Date('2026-09-28T16:00:01Z');
    let invoiceReads = 0;
    mockHooks.invoices = () => {
      invoiceReads += 1;
      if (invoiceReads === 3) { mockTables.invoices[0].status = 'processing'; row.read_at = theirRead; }
    };
    await runAdminAlertRelevanceSweep({ now: NOW });
    expect(row.read_at).toBe(theirRead);
  });

  test('no row locks anywhere: the sweep never takes FOR SHARE / FOR UPDATE (invoice settlement takes the visit FOR UPDATE NOWAIT)', async () => {
    mockTables['scheduled_services as ss'] = [visit({ status: 'completed', recurring_parent_id: PARENT, first_application_invoice_id: INV, first_application_invoice_status: 'draft' })];
    mockTables.notifications = [staleNote(uid(553)), divergenceRow(uid(554))];
    churnedWithDraft();
    await runAdminAlertRelevanceSweep({ now: NOW });
    expect(mockQueries.some((q) => q.calls.some(([m]) => m === 'forShare' || m === 'forUpdate'))).toBe(false);
  });

  test('a row a refresh rewrote after the batch read is left for the next sweep', async () => {
    mockTables['scheduled_services as ss'] = [visit({ status: 'completed' })];
    const row = staleNote(uid(560));
    mockTables.notifications = [row];
    mockHooks.customers = () => {
      mockTables.notifications[0] = { ...row, metadata: JSON.stringify({ ...JSON.parse(row.metadata), dedupeVersion: 'refreshed' }) };
    };
    expect(await runAdminAlertRelevanceSweep({ now: NOW })).toMatchObject({ scanned: 1, retired: 0 });
    expect(mockTables.notifications[0].read_at).toBeNull();
  });

  test('switch off: no reads, no writes, nothing retired', async () => {
    process.env.ADMIN_ALERT_RELEVANCE = 'off';
    mockTables['scheduled_services as ss'] = [visit({ status: 'completed' })];
    mockTables.notifications = [staleNote(uid(510))];
    expect(await runAdminAlertRelevanceSweep({ now: NOW })).toEqual({ skipped: true, reason: 'switch_off' });
    expect(db).not.toHaveBeenCalled();
    expect(mockTables.notifications[0].read_at).toBeNull();
  });

  test('a row a person reads mid-sweep is never touched', async () => {
    mockTables['scheduled_services as ss'] = [visit({ status: 'completed' })];
    const row = staleNote(uid(520));
    mockTables.notifications = [row];
    const readAt = new Date('2026-09-28T15:59:00Z');
    mockHooks.customers = () => { row.read_at = readAt; };
    const result = await runAdminAlertRelevanceSweep({ now: NOW });
    expect(result).toMatchObject({ scanned: 1, retired: 0, byClass: {} });
    expect(row.read_at).toBe(readAt);
    expect(JSON.parse(row.metadata).retired).toBeUndefined();
  });

  test('pages through more unread rows than one page and keeps every read per-page batched', async () => {
    mockTables['scheduled_services as ss'] = [visit({ status: 'completed' })];
    mockTables.notifications = Array.from({ length: 205 }, (_v, i) => staleNote(uid(1000 + i)));
    const result = await runAdminAlertRelevanceSweep({ now: NOW });
    expect(result).toMatchObject({ scanned: 205, retired: 205 });
    expect(mockTables.notifications.every((r) => r.read_at instanceof Date)).toBe(true);
    // The batched first pass reads visits once per page; each retirement then
    // judges its row on a fresh read before the write and once after it.
    expect(mockQueries.filter((q) => q.table === 'scheduled_services as ss')).toHaveLength(2 + 205 * 2);
  });

  test('one unreadable row is skipped, not fatal', async () => {
    mockTables['scheduled_services as ss'] = [visit({ status: 'completed' })];
    const good = staleNote(uid(530));
    const odd = { ...note({ category: 'alert' }), id: uid(529), metadata: { dedupeKey: 'stale-visit:odd', scheduled_service_id: {} } };
    mockTables.notifications = [odd, good];
    const result = await runAdminAlertRelevanceSweep({ now: NOW });
    expect(result.retired).toBe(1);
    expect(good.read_at).toBeInstanceOf(Date);
  });

  test('a refresh that rewrote the bell between the fresh read and the write keeps it ringing: the retire lands only on the version it judged', async () => {
    churnedWithDraft();
    const row = divergenceRow(uid(570));
    mockTables.notifications = [row];
    const refreshed = { ...JSON.parse(row.metadata), invoiceId: INV2, stampedInvoiceId: INV2, dedupeVersion: 'paid-replacement' };
    let invoiceReads = 0;
    // During the fresh verdict's own read (the 2nd), the first-application
    // sweep refreshes the same keyed row onto a paid governing replacement.
    mockHooks.invoices = () => {
      invoiceReads += 1;
      if (invoiceReads === 2) {
        row.metadata = JSON.stringify(refreshed);
        mockTables.invoices.push(invoice({ id: INV2, status: 'paid' }));
      }
    };
    expect(await runAdminAlertRelevanceSweep({ now: NOW })).toMatchObject({ scanned: 1, retired: 0 });
    expect(row.read_at).toBeNull();
    expect(JSON.parse(row.metadata)).toEqual(refreshed);
  });

  test('a quiet refresh after the write is judged as it stands: the final verdict reads the bell again and puts it back when the new content has not moved on', async () => {
    churnedWithDraft();
    const row = divergenceRow(uid(571));
    mockTables.notifications = [row];
    const refreshed = { ...JSON.parse(row.metadata), invoiceId: INV2, stampedInvoiceId: INV2, dedupeVersion: 'paid-replacement' };
    let reads = 0;
    // 1st read: the fresh read before the write. 2nd: the read after it — a
    // quiet refresh (read_at untouched, the stamp merged in) lands just before.
    mockHooks['notifications:first'] = () => {
      reads += 1;
      if (reads === 2) {
        row.metadata = JSON.stringify({ ...refreshed, retired: JSON.parse(row.metadata).retired });
        mockTables.invoices.push(invoice({ id: INV2, status: 'paid' }));
      }
    };
    expect(await runAdminAlertRelevanceSweep({ now: NOW })).toMatchObject({ scanned: 1, retired: 0 });
    expect(row.read_at).toBeNull();
    expect(JSON.parse(row.metadata)).toEqual(refreshed);
  });

  test('re-arm: a retired hot-view bell frees its rolling-dedupe key, so the customer back on a restored estimate rings the same day', async () => {
    const key = `estimate_hot_view:${EST}`;
    mockTables.estimates = [{ id: EST, status: 'viewed', archived_at: new Date('2026-09-28T12:00:00Z'), sent_at: null, customer_id: CUST }];
    const row = note({ id: uid(572), category: 'estimate_hot_view', link: `/admin/estimates?estimateId=${EST}`, metadata: { dedupeKey: key, estimateId: EST, customerId: CUST, sessions: 3 } });
    mockTables.notifications = [row];
    expect(await runAdminAlertRelevanceSweep({ now: NOW })).toMatchObject({ retired: 1, byClass: { estimate_hot_view: 1 } });
    expect(JSON.parse(row.metadata)).toMatchObject({ dedupeKey: null, retired: { dedupeKey: key, reason: expect.stringContaining('archived') } });
    // Unarchived; the customer is back on it inside the 24-hour window.
    mockTables.estimates[0].archived_at = null;
    const again = await NotificationService.notifyAdmin('estimate_hot_view', 'Reading their estimate again', 'body', {
      bell: true, link: `/admin/estimates?estimateId=${EST}`, dedupeKey: key, dedupeWindowMs: 24 * 3600000,
      metadata: { estimateId: EST, customerId: CUST, sessions: 4 },
    });
    expect(again.deduped).toBe(false);
    const fresh = mockTables.notifications.find((r) => r.id !== row.id);
    expect(fresh.read_at == null).toBe(true);
    expect(JSON.parse(fresh.metadata).feed).toBeUndefined();
  });
});

describe('retireKeysNoLongerRaised (an emitter\'s clear-on-absence)', () => {
  const standing = (id, key, extra = {}) => note({ id, category: 'alert', metadata: { dedupeKey: key, scheduled_service_id: VISIT, ...extra } });
  const REASON = 'The schedule watchdog no longer finds this gap';

  test('retires only the unread, bell-visible bells under the prefix whose key the scan did not raise', async () => {
    const live = standing(uid(580), 'prepay-coverage:v1:annual_coverage_unverified:aaa');
    const gone = standing(uid(581), 'prepay-coverage:v1:annual_coverage_unverified:old');
    const theirs = { ...standing(uid(582), 'prepay-coverage:v2:x:y'), read_at: new Date('2026-09-28T10:00:00Z') };
    const other = standing(uid(583), 'accepted-schedule:e1:pest_control');
    const quiet = standing(uid(584), 'prepay-coverage:v3:x:y', { feed: 'activity' });
    mockTables.notifications = [live, gone, theirs, other, quiet];
    expect(await retireKeysNoLongerRaised({ prefix: 'prepay-coverage:', liveKeys: ['prepay-coverage:v1:annual_coverage_unverified:aaa'], reason: REASON, now: NOW })).toBe(1);
    expect(gone.read_at).toBeInstanceOf(Date);
    expect(JSON.parse(gone.metadata).retired).toEqual({ by: 'alert-relevance', reason: REASON, at: NOW.toISOString() });
    for (const r of [live, other, quiet]) {
      expect(r.read_at).toBeNull();
      expect(JSON.parse(r.metadata).retired).toBeUndefined();
    }
    expect(theirs.read_at).toEqual(new Date('2026-09-28T10:00:00Z'));
  });

  test('switch off: nothing is touched', async () => {
    process.env.ADMIN_ALERT_RELEVANCE = 'off';
    const gone = standing(uid(585), 'prepay-coverage:v9:x:y');
    mockTables.notifications = [gone];
    expect(await retireKeysNoLongerRaised({ prefix: 'prepay-coverage:', liveKeys: [], reason: REASON, now: NOW })).toBe(0);
    expect(gone.read_at).toBeNull();
  });
});

describe('ring time, through the existing ringGate seam', () => {
  const raise = (opts = {}, metaOver = {}, dedupeKey = `first_application_sibling_divergence:${EST}:${INV}:${VISIT}`) => NotificationService.notifyAdmin(
    'billing', 'First-application invoice may need to be split by hand', 'body', {
      link: `/admin/invoices?invoice=${INV}`, bell: true, dedupeKey, dedupeVersion: 'fp1::g0', refreshOnDedupe: true,
      metadata: { estimateId: EST, anchorId: VISIT, divergingSiblingIds: [VISIT], customerId: CUST, invoiceId: INV, stampedInvoiceId: INV, alertKind: 'diverged', autoCleared: false, recurrenceGeneration: 0, ...metaOver },
      ...opts,
    });
  const stored = () => mockTables.notifications.map((r) => JSON.parse(r.metadata));

  test('a fresh row whose customer already left and whose invoice is a draft lands activity-only with the retired stamp', async () => {
    mockTables.customers = [customer({ churned_at: new Date('2026-09-21T12:00:00Z') })];
    mockTables.invoices = [invoice()];
    const created = await raise();
    expect(created.deduped).toBe(false);
    expect(stored()).toHaveLength(1);
    expect(stored()[0]).toMatchObject({ quiet: true, feed: 'activity', retired: { by: 'alert-relevance', reason: expect.stringContaining('Customer left'), at: expect.any(String) }, dedupeKey: expect.any(String), dedupeVersion: 'fp1::g0' });
    expect(stored()[0].rungAt).toBeUndefined();
    expect(mockTables.notifications[0].read_at).toBeUndefined();
  });

  test('the same row for a customer who is still here rings as before (rungAt stamped, no quiet)', async () => {
    mockTables.invoices = [invoice()];
    await raise();
    expect(stored()[0]).toMatchObject({ rungAt: expect.any(String) });
    expect(stored()[0].quiet).toBeUndefined();
    expect(stored()[0].retired).toBeUndefined();
  });

  test('money paid keeps ringing even for a customer who left', async () => {
    mockTables.customers = [customer({ churned_at: new Date() })];
    mockTables.invoices = [invoice({ status: 'paid' })];
    await raise();
    expect(stored()[0].quiet).toBeUndefined();
  });

  test('switch off = today\'s behavior: a plain insert, no subject reads, no transaction', async () => {
    process.env.ADMIN_ALERT_RELEVANCE = 'off';
    mockTables.customers = [customer({ churned_at: new Date() })];
    mockTables.invoices = [invoice()];
    await NotificationService.notifyAdmin('billing', 'x', 'y', { metadata: { alertKind: 'diverged', customerId: CUST, invoiceId: INV } });
    expect(stored()[0].quiet).toBeUndefined();
    expect(mockQueries.filter((q) => ['customers', 'invoices'].includes(q.table))).toEqual([]);
  });

  test('a caller that passes its own ringGate keeps it — the relevance check never overrides it', async () => {
    mockTables.customers = [customer({ churned_at: new Date() })];
    mockTables.invoices = [invoice()];
    await raise({ ringGate: async () => true });
    expect(stored()[0]).toMatchObject({ rungAt: expect.any(String) });
    expect(stored()[0].retired).toBeUndefined();
  });

  test('a row outside the class table takes the untouched plain path (no subject reads)', async () => {
    mockTables.customers = [customer({ churned_at: new Date() })];
    await NotificationService.notifyAdmin('service', 'Something else', 'body', { dedupeKey: 'other:1', metadata: { customerId: CUST } });
    expect(stored()[0]).toEqual({ dedupeKey: 'other:1', customerId: CUST });
    expect(mockQueries.filter((q) => q.table === 'customers')).toEqual([]);
  });

  test('a failed subject read rings (fail open) on a savepoint, never aborting the caller\'s transaction', async () => {
    mockFailTable = 'customers';
    await raise();
    expect(stored()[0]).toMatchObject({ rungAt: expect.any(String) });
    expect(stored()[0].quiet).toBeUndefined();
    // The read ran inside a nested transaction (savepoint) on the insert's own transaction.
    expect(mockTrxs).toHaveLength(1);
    expect(mockTrxs[0].transaction).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['unpriced series, customer left', 'alert', `unpriced-series:${PARENT}`, { scheduled_service_id: VISIT, customer_id: CUST },
      () => { mockTables['scheduled_services as ss'] = [visit()]; mockTables.customers = [customer({ churned_at: new Date('2026-09-21T12:00:00Z') })]; },
      () => { mockTables.customers = [customer()]; }],
    ['estimate hot view, estimate archived', 'estimate_hot_view', `estimate_hot_view:${EST}`, { estimateId: EST, customerId: CUST },
      () => { mockTables.estimates = [{ id: EST, status: 'viewed', archived_at: new Date('2026-09-28T12:00:00Z'), sent_at: null, customer_id: CUST }]; },
      () => { mockTables.estimates[0].archived_at = null; }],
  ])('a re-arm class already moved on writes no row at all, run after run (nothing piles up), and rings once the subject is back: %s', async (_label, category, key, meta, gone, back) => {
    gone();
    const emit = () => NotificationService.notifyAdmin(category, 'Title', 'body', { bell: true, dedupeKey: key, metadata: meta });
    for (let run = 0; run < 3; run += 1) expect(await emit()).toMatchObject({ id: null, suppressed: true, deduped: false });
    expect(mockTables.notifications || []).toHaveLength(0);
    back();
    const rang = await emit();
    expect(rang.deduped).toBe(false);
    expect(mockTables.notifications).toHaveLength(1);
    expect(stored()[0]).toMatchObject({ dedupeKey: key, rungAt: expect.any(String) });
    expect(stored()[0].quiet).toBeUndefined();
  });

  test('ringTimeCheck is null when the switch is off or the row is not in the table', () => {
    expect(ringTimeCheck({ category: 'inbound_sms', metadata: {} })).toBeNull();
    process.env.ADMIN_ALERT_RELEVANCE = '0';
    expect(ringTimeCheck({ category: 'billing', metadata: { dedupeKey: 'first_application_sibling_divergence:x' } })).toBeNull();
  });

  // Interplay with the first-application sweep (owner-lane requirement): the
  // sweep re-raises every still-diverged group through notifyAdmin; only
  // metadata.autoCleared counts as resolved there, so a relevance retire must
  // read like a plain dismissal and change none of its keys.
  test('after a retire, a re-raise with the SAME dedupeKey + version stays read; a NEW dedupeKey lands quiet', async () => {
    mockTables.invoices = [invoice()];
    await raise();
    expect(stored()[0].rungAt).toEqual(expect.any(String));
    const original = mockTables.notifications[0];
    const before = JSON.parse(original.metadata);

    mockTables.customers = [customer({ churned_at: new Date('2026-09-21T12:00:00Z') })];
    const sweep = await runAdminAlertRelevanceSweep({ now: NOW });
    expect(sweep.byClass).toEqual({ first_application_divergence: 1 });
    expect(original.read_at).toBeInstanceOf(Date);
    const after = JSON.parse(original.metadata);
    const { retired, ...rest } = after;
    expect(retired.by).toBe('alert-relevance');
    expect(rest).toEqual(before);
    for (const key of ['dedupeKey', 'dedupeVersion', 'autoCleared', 'recurrenceGeneration', 'invoiceId', 'stampedInvoiceId']) expect(after[key]).toEqual(before[key]);

    // Same group, same state: notifyAdmin dedupes onto the retired row, which stays read.
    const again = await raise();
    expect(again.deduped).toBe(true);
    expect(again.refreshed).toBeUndefined();
    expect(mockTables.notifications).toHaveLength(1);
    expect(original.read_at).toBeInstanceOf(Date);

    // The diverging set changed (new dedupeKey): a fresh row, quiet because the customer left and the invoice is a draft.
    const changed = await raise({}, { divergingSiblingIds: [VISIT, PARENT] }, `first_application_sibling_divergence:${EST}:${INV}:${VISIT},${PARENT}`);
    expect(changed.deduped).toBe(false);
    expect(mockTables.notifications).toHaveLength(2);
    expect(JSON.parse(mockTables.notifications[1].metadata)).toMatchObject({ quiet: true, feed: 'activity', retired: { by: 'alert-relevance' } });
  });
});
