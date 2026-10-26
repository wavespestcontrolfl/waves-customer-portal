// Unit tests for setup-fee-alert-reconcile — the transactional,
// dedupe-locked reconciliation of the estimate-wide unminted-setup-fee
// manual-billing alert. The load-bearing pin (Codex P0, final round): a
// REFUNDED fee-carrying invoice is fee-RESOLUTION evidence, never a
// reopened debt — a resolved alert must NOT be rewritten to demand the
// fee again when its fee invoice is refunded.

let mockTables = {};
let mockUpdates = [];
let mockCounters = {};
let mockInvoiceNotePredicates = [];

jest.mock('../models/db', () => {
  // ONE shared per-test counter map: the pre-read (direct db) and the
  // transaction reads advance the same sequence.
  const handler = (table) => {
    mockCounters[table] = (mockCounters[table] || 0) + 1;
    const spec = mockTables[table];
    const val = typeof spec === 'function' ? spec(mockCounters[table]) : spec;
    const chain = {};
    const self = () => chain;
    ['where', 'whereRaw', 'whereIn', 'whereNot', 'whereNull', 'whereNotNull', 'orWhere', 'orWhereRaw', 'orWhereIn', 'orderBy', 'forUpdate', 'leftJoin', 'andWhere', 'orWhereNotNull', 'whereNotIn'].forEach((m) => {
      chain[m] = jest.fn((...args) => {
        if (table === 'invoices' && m === 'where' && args[0] === 'notes') mockInvoiceNotePredicates.push(args);
        if (typeof args[0] === 'function') args[0].call(chain, chain);
        return chain;
      });
    });
    chain.first = jest.fn(async () => (Array.isArray(val) ? (val[0] ?? null) : (val ?? null)));
    chain.select = jest.fn(async () => (Array.isArray(val) ? val : (val ? [val] : [])));
    chain.pluck = jest.fn(async () => []);
    chain.update = jest.fn(async (payload) => { mockUpdates.push({ table, payload }); return 1; });
    return chain;
  };
  const mock = jest.fn((table) => handler(table));
  mock.transaction = jest.fn(async (fn) => {
    const trx = (table) => handler(table);
    trx.raw = jest.fn(async () => ({ rows: [] }));
    trx.fn = { now: jest.fn(() => 'NOW') };
    return fn(trx);
  });
  mock.raw = jest.fn((sql) => ({ __raw: sql }));
  mock.fn = { now: jest.fn(() => 'NOW') };
  return mock;
});

const { acceptedEstimateIdFromNotes, reconcileSetupFeeAlert, reconcileSetupFeeAlertForInvoice } = require('../services/setup-fee-alert-reconcile');

const CUST = 'c1000000-0000-0000-0000-000000000001';
const EST = 'e1000000-0000-0000-0000-000000000001';
const FEE_LINE = JSON.stringify([{ description: 'WaveGuard Membership — one-time setup fee', amount: 99 }]);
const APP_LINE = JSON.stringify([{ client_id: 'scheduled_ss-1_primary', description: 'Quarterly Pest Control', amount: 88 }]);

function alertRow(metaOverrides = {}, columns = {}) {
  return {
    id: 'alert-1',
    ...columns,
    metadata: {
      dedupeKey: `unminted_setup_fee_manual_billing:${EST}`,
      customerId: CUST,
      scheduledServiceId: 'ss-1',
      ...metaOverrides,
    },
  };
}

// notifications reads, in order: 1 = pre-lock scan (.select), 2 = in-trx
// lock recheck (.first), 3 = the estate alert (.first), 4 = the
// terminal-registration scan (.select — none in these tests).
function notificationsInOrder(primary) {
  return (n) => (n === 1 ? [primary] : (n === 2 || n === 3 ? primary : []));
}

beforeEach(() => {
  mockUpdates = [];
  mockTables = {};
  mockCounters = {};
  mockInvoiceNotePredicates = [];
});

test('accepted-estimate note linkage normalizes mixed case UUIDs and leaves freeform notes alone', async () => {
  expect(acceptedEstimateIdFromNotes(`ACCEPTED ESTIMATE #${EST.toUpperCase()}.`)).toBe(EST);
  expect(acceptedEstimateIdFromNotes('accepted estimate #freeform.')).toBeNull();
  await reconcileSetupFeeAlertForInvoice({ id: 'inv-freeform', customer_id: CUST, notes: 'accepted estimate #freeform.' });
  expect(mockCounters).toEqual({});
});

test('invoice transition reconciles an uppercase note stamp and scans coverage case-insensitively', async () => {
  mockTables = {
    notifications: notificationsInOrder(alertRow({ resolvedCovered: true })),
    invoices: (n) => (n === 1 ? [
      { id: 'inv-fee', status: 'paid', line_items: FEE_LINE, notes: `ACCEPTED ESTIMATE #${EST.toUpperCase()}.` },
      { id: 'inv-app', status: 'paid', line_items: APP_LINE, notes: `accepted estimate #${EST}` },
    ] : []),
    scheduled_services: [],
  };
  await reconcileSetupFeeAlertForInvoice({ id: 'inv-fee', customer_id: CUST, notes: `ACCEPTED ESTIMATE #${EST.toUpperCase()}.` });
  expect(mockCounters.notifications).toBeGreaterThan(0);
  expect(mockInvoiceNotePredicates).toEqual([
    ['notes', 'ilike', `%accepted estimate #${EST}%`],
  ]);
  expect(mockUpdates).toEqual([]);
});

test('terminal alert scan recognizes an uppercase note stamp', async () => {
  const terminal = {
    id: 'terminal-alert',
    body: 'Bill the application ALSO: the one-time WaveGuard setup fee is owed.',
    metadata: { setupFeeDedupeKey: `unminted_setup_fee_manual_billing:${EST}`,
      customerId: CUST, setupFeeResolved: false, expectedSetupFeeCents: 9900 },
  };
  mockTables = {
    notifications: (n) => (n === 1 || n === 2 || n === 4 ? [terminal] : []),
    invoices: [{ id: 'inv-fee', status: 'paid', line_items: FEE_LINE,
      notes: `ACCEPTED ESTIMATE #${EST.toUpperCase()}.` }],
  };
  await reconcileSetupFeeAlert({ customerId: CUST, sourceEstimateId: EST });
  expect(mockInvoiceNotePredicates).toEqual([['notes', 'ilike', `%accepted estimate #${EST}%`]]);
  expect(mockUpdates).toHaveLength(1);
  expect(mockUpdates[0].payload.detail || mockUpdates[0].payload.body).toContain('COVERED');
});

test('a terminal alert cut by the brevity guard is rewritten from its full `detail`, and the rewrite stays cut with detail kept', async () => {
  const lead = 'A visit was completed but its invoice is void, so NO new invoice was cut and the customer completion text carried no pay link.';
  const terminal = {
    id: 'terminal-alert',
    body: `${lead.slice(0, 100)}…`,
    detail: `${lead} ALSO: the one-time WaveGuard setup fee is owed.`,
    metadata: { setupFeeDedupeKey: `unminted_setup_fee_manual_billing:${EST}`,
      customerId: CUST, setupFeeResolved: false, expectedSetupFeeCents: 9900 },
  };
  mockTables = {
    notifications: (n) => (n === 1 || n === 2 || n === 4 ? [terminal] : []),
    invoices: [{ id: 'inv-fee', status: 'paid', line_items: FEE_LINE,
      notes: `ACCEPTED ESTIMATE #${EST.toUpperCase()}.` }],
  };
  await reconcileSetupFeeAlert({ customerId: CUST, sourceEstimateId: EST });
  expect(mockUpdates).toHaveLength(1);
  const { body, detail } = mockUpdates[0].payload;
  expect(body.length).toBeLessThanOrEqual(110);
  expect(detail).toContain(lead);
  expect(detail).toContain('COVERED');
  expect(detail).not.toContain('ALSO:');
});

test('a RESOLVED alert whose fee invoice becomes REFUNDED stays settled — never rewritten to demand the fee again', async () => {
  mockTables = {
    notifications: notificationsInOrder(alertRow({ resolvedCovered: true })),
    // Call 1 = stamped scan, call 2 = on-visit scan.
    invoices: (n) => (n === 1
      ? [
        { id: 'inv-fee', status: 'refunded', line_items: FEE_LINE, notes: `accepted estimate #${EST} — $99 setup fee` },
        { id: 'inv-app', status: 'paid', line_items: APP_LINE, notes: `accepted estimate #${EST}` },
      ]
      : []),
    scheduled_services: [],
  };
  await reconcileSetupFeeAlert({ customerId: CUST, sourceEstimateId: EST });
  expect(mockUpdates).toEqual([]); // idempotent — no rewrite, no reopened debt
});

test('a VOID (not refunded) fee invoice beside a live application DOES rewrite to a fee-only instruction', async () => {
  mockTables = {
    notifications: notificationsInOrder(alertRow({ resolvedCovered: true })),
    invoices: (n) => (n === 1
      ? [
        { id: 'inv-fee', status: 'void', line_items: FEE_LINE, notes: `accepted estimate #${EST}` },
        { id: 'inv-app', status: 'paid', line_items: APP_LINE, notes: `accepted estimate #${EST}` },
      ]
      : []),
    scheduled_services: [],
  };
  await reconcileSetupFeeAlert({ customerId: CUST, sourceEstimateId: EST });
  expect(mockUpdates).toHaveLength(1);
  expect(mockUpdates[0].payload.detail || mockUpdates[0].payload.body).toContain('do NOT bill an application again');
  expect(mockUpdates[0].payload.detail || mockUpdates[0].payload.body).toContain('one-time setup fee');
  expect(mockUpdates[0].payload.read_at).toBe(null); // newly actionable — rings
});

test('a PARTIAL fee amount ($9.90 vs expected $99) never resolves the fee — cents-exact against persisted expectation', async () => {
  mockTables = {
    notifications: notificationsInOrder(alertRow({ resolvedCovered: false, expectedSetupFeeCents: 9900 })),
    invoices: (n) => (n === 1
      ? [
        { id: 'inv-fee', status: 'paid', line_items: JSON.stringify([{ description: 'WaveGuard Membership — one-time setup fee', amount: 9.90 }]), notes: `accepted estimate #${EST}` },
        { id: 'inv-app', status: 'paid', line_items: APP_LINE, notes: `accepted estimate #${EST}` },
      ]
      : []),
    scheduled_services: [],
  };
  await reconcileSetupFeeAlert({ customerId: CUST, sourceEstimateId: EST });
  // Application covered, fee NOT (partial) → fee-only instruction, never resolved.
  expect(mockUpdates).toHaveLength(1);
  expect(mockUpdates[0].payload.detail || mockUpdates[0].payload.body).toContain('one-time setup fee');
  expect(mockUpdates[0].payload.detail || mockUpdates[0].payload.body).not.toContain('RESOLVED');
});

test('a covered annual-prepay term WAIVES the estate fee — a fee-owed alert resolves instead of instructing $99', async () => {
  mockTables = {
    notifications: notificationsInOrder(alertRow({ resolvedCovered: false })),
    'annual_prepay_terms as t': { id: 'term-1' }, // coveredTermsAsOf hit
    scheduled_services: {}, // no annual stamp on the visit row
    invoices: (n) => (n === 1
      ? []
      : [{ id: 'inv-app', status: 'paid', scheduled_service_id: 'ss-1', line_items: APP_LINE }]),
  };
  await reconcileSetupFeeAlert({ customerId: CUST, sourceEstimateId: EST });
  expect(mockUpdates).toHaveLength(1);
  expect(mockUpdates[0].payload.detail || mockUpdates[0].payload.body).toContain('RESOLVED');
  expect(mockUpdates[0].payload.detail || mockUpdates[0].payload.body).not.toContain('Still owed');
});

test('a foreign re-linked visit never reconciles another customer\'s alert', async () => {
  mockTables = {
    notifications: notificationsInOrder(alertRow({ resolvedCovered: false })),
    invoices: () => [],
    scheduled_services: [],
  };
  await reconcileSetupFeeAlert({ customerId: 'c2000000-0000-0000-0000-000000000002', sourceEstimateId: EST });
  expect(mockUpdates).toEqual([]);
});

// ── Idempotent partial branches (daily sweep must not re-open a "Done" alert) ──
// Each case runs the reconcile once to learn the exact body the branch writes,
// stores that body + the matching metadata on a done/read alert, and runs again.
const DONE_COLUMNS = { read_at: 'T0', done_at: 'T1', done_by: 'staff', resolution: 'handled' };
const stampedNote = `accepted estimate #${EST}`;
const feePaid = { id: 'inv-fee', status: 'paid', line_items: FEE_LINE, notes: stampedNote };
const appPaid = { id: 'inv-app', status: 'paid', line_items: APP_LINE, notes: stampedNote };

const PARTIAL_CASES = [
  {
    name: 'fee covered, application owed',
    baseMeta: {},
    invoices: [feePaid],
    state: { feeCovered: true, applicationCovered: false, coveredFeeCents: null, uncoveredVisitIds: ['ss-1'] },
    changed: { uncoveredVisitIds: ['ss-1', 'ss-9'] },
  },
  {
    name: 'application covered, fee owed',
    baseMeta: { expectedSetupFeeCents: 9900 },
    invoices: [appPaid],
    state: { feeCovered: false, applicationCovered: true, coveredFeeCents: 0, uncoveredVisitIds: [] },
    changed: { coveredFeeCents: 500 },
  },
  {
    name: 'fee owed, one of two applications still owed',
    baseMeta: { parkedVisitIds: ['ss-1', 'ss-2'] },
    invoices: [appPaid],
    state: { feeCovered: false, applicationCovered: false, coveredFeeCents: null, uncoveredVisitIds: ['ss-2'] },
    changed: { uncoveredVisitIds: ['ss-1', 'ss-2'] },
  },
];

function runPartial(c, { meta = {}, columns = {} } = {}) {
  mockUpdates = [];
  mockCounters = {};
  mockTables = {
    notifications: notificationsInOrder(alertRow({ resolvedCovered: false, ...c.baseMeta, ...meta }, columns)),
    invoices: (n) => (n === 1 ? c.invoices : []),
    scheduled_services: [],
  };
  return reconcileSetupFeeAlert({ customerId: CUST, sourceEstimateId: EST });
}

describe.each(PARTIAL_CASES)('partial branch idempotence: $name', (c) => {
  async function learnBody() {
    await runPartial(c, { meta: { resolvedCovered: false } });
    expect(mockUpdates).toHaveLength(1);
    const { body, detail = null } = mockUpdates[0].payload;
    return { body, detail };
  }

  test('a second run with unchanged inputs leaves a done alert done and writes nothing', async () => {
    const stored = await learnBody();
    await runPartial(c, { meta: { resolvedCovered: false, ...c.state }, columns: { ...stored, ...DONE_COLUMNS } });
    expect(mockUpdates).toEqual([]);
  });

  test('a changed stored state still rewrites and re-opens the alert', async () => {
    const stored = await learnBody();
    await runPartial(c, { meta: { resolvedCovered: false, ...c.state, ...c.changed }, columns: { ...stored, ...DONE_COLUMNS } });
    expect(mockUpdates).toHaveLength(1);
    expect(mockUpdates[0].payload).toMatchObject({ read_at: null, done_at: null, done_by: null, resolution: null });
  });

  test('a regression from resolved still rewrites and re-opens the alert', async () => {
    const stored = await learnBody();
    await runPartial(c, { meta: { ...c.state, resolvedCovered: true }, columns: { ...stored, ...DONE_COLUMNS } });
    expect(mockUpdates).toHaveLength(1);
    expect(mockUpdates[0].payload).toMatchObject({ read_at: null, done_at: null, done_by: null, resolution: null });
  });

  test('an alert stored with an old body but the same state is rewritten once', async () => {
    const stored = await learnBody();
    await runPartial(c, { meta: { resolvedCovered: false, ...c.state }, columns: { body: 'OLD COPY', detail: null, ...DONE_COLUMNS } });
    expect(mockUpdates).toHaveLength(1);
    expect(mockUpdates[0].payload.body).toBe(stored.body);
    expect(mockUpdates[0].payload.read_at).toBe(null);
    // The rewrite is stable: a run on the rewritten alert writes nothing more.
    await runPartial(c, { meta: { resolvedCovered: false, ...c.state }, columns: { ...stored, ...DONE_COLUMNS } });
    expect(mockUpdates).toEqual([]);
  });
});
