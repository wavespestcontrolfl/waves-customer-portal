/**
 * Newsletter list reconciliation — fully mocked (matches
 * admin-newsletter-import-archived-scope.test.js /
 * newsletter-relink-archived-customer.test.js). A fake `conn` dispatches on
 * each raw query's SQL shape against an in-memory fixture, so the
 * priority-order/filtering logic gets real behavioral coverage.
 */

jest.mock('../services/newsletter-subscribers', () => ({ subscribeOrResubscribe: jest.fn() }));
jest.mock('../services/email-template-library', () => ({ activeSuppressionsFor: jest.fn(async () => []) }));
jest.mock('../services/logger', () => ({ error: jest.fn(), info: jest.fn(), warn: jest.fn() }));

const { subscribeOrResubscribe } = require('../services/newsletter-subscribers');
const { activeSuppressionsFor } = require('../services/email-template-library');
const { CUSTOMER_STAGES } = require('../services/customer-stages');
const { reconcileCustomers } = require('../services/newsletter-list-reconcile');

const PRIORITY = { active: 0, unsubscribed: 1, pending: 2, inactive: 3, waitlist: 3 };
const isCandidate = (c) => !c.deleted_at && c.active === true && !c.churned_at
  && (c.pipeline_stage === 'active_customer' || c.pipeline_stage === 'won' || c.pipeline_stage == null)
  && !!(c.email && c.email.trim());
const isLive = (c) => !c.deleted_at && c.active === true && CUSTOMER_STAGES.includes(c.pipeline_stage);

// Fake knex-like `conn`: table-call handlers for the two plain reads/writes,
// `.raw(sql, bindings)` dispatched on SQL shape for everything else.
function makeConn(state) {
  const conn = (table) => {
    if (table === 'notification_prefs') {
      return { where: (cond) => ({ first: async () => state.prefs.find((p) => p.customer_id === cond.customer_id) || null }) };
    }
    if (table === 'newsletter_subscribers') {
      return {
        where: (cond) => {
          const chain = {
            where: () => chain, // a chained second predicate — ignored, always proceeds to update
            whereNull: () => chain,
            update: async (fields) => {
              const row = state.subscribers.find((s) => s.id === cond.id);
              if (!row) return 0;
              Object.assign(row, fields);
              return 1;
            },
          };
          return chain;
        },
      };
    }
    throw new Error(`Unexpected table ${table}`);
  };

  const hasActive = (c) => state.subscribers.some((s) => s.status === 'active'
    && (s.customer_id === c.id || (s.email || '').toLowerCase() === c.email.trim().toLowerCase()));
  const key = (v) => String(v).trim().toLowerCase();

  conn.raw = jest.fn(async (sql, bindings = []) => {
    if (sql.includes('FROM customers c') && sql.includes('NOT EXISTS')) {
      return { rows: state.customers.filter(isCandidate).filter((c) => !hasActive(c)).map((c) => ({ customer_id: c.id, email: c.email, first_name: c.first_name, last_name: c.last_name, city: c.city })) };
    }
    if (sql.includes('WHERE id = ?')) {
      const [customerId] = bindings;
      const c = state.customers.find((x) => x.id === customerId && isCandidate(x));
      return { rows: c ? [{ customer_id: c.id, email: c.email, first_name: c.first_name, last_name: c.last_name, city: c.city }] : [] };
    }
    if (sql.includes('ORDER BY CASE status')) {
      const [customerId, email] = bindings;
      const matches = state.subscribers.filter((s) => s.customer_id === customerId || (s.email || '').toLowerCase() === key(email));
      const best = matches.reduce((acc, m) => {
        const p = PRIORITY[m.status] ?? 4;
        return !acc || p < acc.p ? { status: m.status, p } : acc;
      }, null);
      return { rows: best ? [{ status: best.status }] : [] };
    }
    if (sql.includes('region_zone IS NULL')) {
      return { rows: state.subscribers.filter((s) => s.status === 'active' && (!s.region_zone || !s.region_zone.trim()))
        .map((s) => { const c = state.customers.find((x) => x.id === s.customer_id); return c && isLive(c) ? { subscriber_id: s.id, city: c.city } : null; })
        .filter(Boolean) };
    }
    if (sql.includes('customer_id IS NULL')) {
      return { rows: state.subscribers.filter((s) => s.status === 'active' && s.customer_id == null).map((s) => ({ id: s.id, email: s.email })) };
    }
    if (sql.includes('SELECT id FROM customers')) {
      const [email] = bindings;
      return { rows: state.customers.filter((c) => (c.email || '').trim().toLowerCase() === key(email) && isLive(c)).map((c) => ({ id: c.id })) };
    }
    throw new Error(`Unhandled raw SQL: ${sql.slice(0, 60)}`);
  });

  return conn;
}

const cust = (o) => ({
  id: 'c1', email: 'a@example.com', first_name: 'F', last_name: 'L', city: 'Venice',
  deleted_at: null, active: true, churned_at: null, pipeline_stage: 'active_customer', ...o,
});

beforeEach(() => {
  jest.clearAllMocks();
  activeSuppressionsFor.mockResolvedValue([]);
});

// Exclusion priority order: one case per reason, each ALSO carrying a
// lower-priority reason that must not win instead (e.g. unsubscribed +
// marketing_offers:true still excludes as previously_unsubscribed).
test.each([
  ['previously_unsubscribed', [{ status: 'unsubscribed' }], [{ marketing_offers: true }], false],
  ['pending_confirmation', [{ status: 'pending' }], [{ marketing_offers: true }], false],
  ['inactive_subscriber', [{ status: 'inactive' }], [{ marketing_offers: true }], false],
  ['suppressed', [], [{ marketing_offers: false }], true],
  ['email_switch_off', [], [{ marketing_offers: true, email_enabled: false }], false],
  ['marketing_flag_not_on', [], [], false],
])('%s wins, and (write mode) is NEVER subscribed', async (reason, subs, prefs, suppressed) => {
  activeSuppressionsFor.mockResolvedValue(suppressed ? [{ suppression_type: 'bounce' }] : []);
  const state = {
    customers: [cust({})],
    subscribers: subs.map((s, i) => ({ id: `s${i}`, customer_id: 'c1', email: 'a@example.com', ...s })),
    prefs: prefs.map((p) => ({ customer_id: 'c1', ...p })),
  };
  const result = await reconcileCustomers({ dryRun: false, conn: makeConn(state) });
  expect(result.excluded[reason]).toBe(1);
  expect(result.imported).toBe(0);
  expect(subscribeOrResubscribe).not.toHaveBeenCalled();
  // Reused verbatim, never re-derived — checked on the one row that expects a suppression lookup.
  if (reason === 'suppressed') expect(activeSuppressionsFor).toHaveBeenCalledWith(null, 'a@example.com', 'marketing_newsletter', expect.anything());
});

test('dry run performs zero writes (importable + byCity still computed); write mode then imports and backfills region_zone via cityToZone', async () => {
  const state = {
    customers: [cust({ id: 'c1', email: 'ok@example.com', city: 'Venice' }), cust({ id: 'c2', email: 'unsub@example.com' })],
    subscribers: [{ id: 's-unsub', customer_id: 'c2', email: 'unsub@example.com', status: 'unsubscribed' }], prefs: [{ customer_id: 'c1', marketing_offers: true }],
  };
  const dry = await reconcileCustomers({ conn: makeConn(state) });
  expect(dry).toMatchObject({ dryRun: true, importable: 1, imported: 0, byCity: [{ city: 'Venice', count: 1 }] });
  expect(subscribeOrResubscribe).not.toHaveBeenCalled();

  // The row doesn't exist yet when the candidate fetch/recheck run (both read BEFORE this is called).
  subscribeOrResubscribe.mockImplementation(async ({ email }) => {
    state.subscribers.push({ id: 'sub-new', customer_id: 'c1', email, status: 'active', region_zone: null });
    return { action: 'created', subscriber: { id: 'sub-new' } };
  });
  const write = await reconcileCustomers({ dryRun: false, conn: makeConn(state) });
  expect(write.imported).toBe(1);
  expect(subscribeOrResubscribe).toHaveBeenCalledWith(expect.objectContaining({
    email: 'ok@example.com', source: 'customer_import', requireConfirmation: false, linkCustomer: true, strict: false,
  }));
  expect(state.subscribers.find((s) => s.id === 'sub-new').region_zone).toBe('south_sarasota');
});

test('re-check before write: a customer who unsubscribes between the read and the write is skipped, not imported', async () => {
  const state = { customers: [cust({ email: 'flips@example.com' })], subscribers: [], prefs: [{ customer_id: 'c1', marketing_offers: true }] };
  const conn = makeConn(state);
  let firstRead = true;
  const rawImpl = conn.raw.getMockImplementation();
  conn.raw = jest.fn(async (sql, bindings) => {
    // Call 1 = batch classification; call 2 = the write-time recheck —
    // insert the mid-flight unsubscribe BEFORE call 2 reads.
    if (sql.includes('ORDER BY CASE status')) {
      if (!firstRead) state.subscribers.push({ id: 's-new', customer_id: 'c1', email: 'flips@example.com', status: 'unsubscribed' });
      firstRead = false;
    }
    return rawImpl(sql, bindings);
  });
  const result = await reconcileCustomers({ dryRun: false, conn });
  expect(result.importable).toBe(1); // the pre-write snapshot still counted it
  expect(result.imported).toBe(0); // the recheck caught the mid-flight unsubscribe
  expect(subscribeOrResubscribe).not.toHaveBeenCalled();
});

test('re-check reloads the customer: one archived between the read and the write is skipped, not imported', async () => {
  const state = { customers: [cust({ id: 'c1', email: 'gone@example.com' })], subscribers: [], prefs: [{ customer_id: 'c1', marketing_offers: true }] };
  subscribeOrResubscribe.mockImplementation(async () => { throw new Error('must not be called'); });
  const conn = makeConn(state);
  const rawImpl = conn.raw.getMockImplementation();
  conn.raw = jest.fn(async (sql, bindings) => {
    // Archive the customer right before the write-time reload reads it (the
    // batch classification loop never calls this query at all).
    if (sql.includes('WHERE id = ?')) state.customers[0].deleted_at = new Date();
    return rawImpl(sql, bindings);
  });
  const result = await reconcileCustomers({ dryRun: false, conn });
  expect(result.importable).toBe(1); // the pre-write snapshot still counted it
  expect(result.imported).toBe(0);
  expect(subscribeOrResubscribe).not.toHaveBeenCalled();
});

test('zone fill (write mode only): fills a null/blank region_zone from a live customer city that maps to a zone; a non-mapping city is left alone', async () => {
  const state = {
    customers: [cust({ id: 'c1', email: 'z1@e.com', city: 'Venice' }), cust({ id: 'c2', email: 'z2@e.com', city: 'Nowhere' })],
    subscribers: [{ id: 's1', customer_id: 'c1', email: 'z1@e.com', status: 'active', region_zone: null },
      { id: 's2', customer_id: 'c2', email: 'z2@e.com', status: 'active', region_zone: '' }],
    prefs: [],
  };
  const dry = await reconcileCustomers({ conn: makeConn(state) });
  expect(dry.zoneFills).toBe(1); // only the mappable city counts
  expect(state.subscribers[0].region_zone).toBeNull(); // dry run touches nothing

  const write = await reconcileCustomers({ dryRun: false, conn: makeConn(state) });
  expect(write.zoneFills).toBe(1);
  expect(state.subscribers[0].region_zone).toBe('south_sarasota');
  expect(state.subscribers[1].region_zone).toBe(''); // 'Nowhere' never maps — untouched
});

// Orphan link (write mode only) — exact-match only.
test.each([
  ['exactly one live customer -> linked', [cust({ id: 'c1', email: 'orphan@e.com' })], 'c1'],
  ['two live customers sharing the email -> never guesses, stays unlinked', [cust({ id: 'c1', email: 'orphan@e.com' }), cust({ id: 'c2', email: 'orphan@e.com' })], null],
  ['zero live customers -> stays unlinked', [], null],
])('%s', async (_label, customers, expected) => {
  const state = { customers, subscribers: [{ id: 's1', customer_id: null, email: 'orphan@e.com', status: 'active' }], prefs: [] };
  const result = await reconcileCustomers({ dryRun: false, conn: makeConn(state) });
  expect(result.orphanLinks).toBe(expected ? 1 : 0);
  expect(state.subscribers[0].customer_id).toBe(expected);
});

test('orphan link re-derives the match fresh: a second live customer sharing the email appearing mid-batch drops the link', async () => {
  const state = { customers: [cust({ id: 'c1', email: 'orphan@e.com' })], subscribers: [{ id: 's1', customer_id: null, email: 'orphan@e.com', status: 'active' }], prefs: [] };
  const conn = makeConn(state);
  let firstRead = true;
  const rawImpl = conn.raw.getMockImplementation();
  conn.raw = jest.fn(async (sql, bindings) => {
    // Call 1 = the read-phase count (sees exactly one match); call 2 = the
    // write-phase re-derivation — add a second live customer before it reads.
    if (sql.includes('SELECT id FROM customers')) {
      if (!firstRead) state.customers.push(cust({ id: 'c2', email: 'orphan@e.com' }));
      firstRead = false;
    }
    return rawImpl(sql, bindings);
  });
  const result = await reconcileCustomers({ dryRun: false, conn });
  expect(result.orphanLinks).toBe(1); // the read-phase snapshot still counted it
  expect(state.subscribers[0].customer_id).toBeNull(); // the write-phase recheck found it now ambiguous
});
