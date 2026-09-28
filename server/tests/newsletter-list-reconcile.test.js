/**
 * Newsletter list reconciliation — fully mocked (matches
 * admin-newsletter-import-archived-scope.test.js /
 * newsletter-relink-archived-customer.test.js). A fake `conn` dispatches on
 * each raw query's SQL shape against an in-memory fixture, so the
 * priority-order/filtering logic gets real behavioral coverage.
 */

jest.mock('../services/newsletter-subscribers', () => ({ linkToCustomer: jest.fn(async () => {}) }));
jest.mock('../services/email-template-library', () => ({ activeSuppressionsFor: jest.fn(async () => []) }));
jest.mock('../services/logger', () => ({ error: jest.fn(), info: jest.fn(), warn: jest.fn() }));

const { linkToCustomer } = require('../services/newsletter-subscribers');
const { activeSuppressionsFor } = require('../services/email-template-library');
const { CUSTOMER_STAGES } = require('../services/customer-stages');
const { reconcileCustomers } = require('../services/newsletter-list-reconcile');

const PRIORITY = { active: 0, unsubscribed: 1, pending: 2, inactive: 3, waitlist: 3 };
// Canonical whereLiveCustomer/CUSTOMER_STAGES rule — the SAME "live
// customer" check used everywhere in this file now (candidate scope, zone
// fill, orphan link): active, not deleted, pipeline_stage IN CUSTOMER_STAGES.
// A NULL pipeline_stage does NOT match (owner ruling 2026-09-28).
const isLive = (c) => !c.deleted_at && c.active === true && CUSTOMER_STAGES.includes(c.pipeline_stage);
const isCandidate = (c) => isLive(c) && !!(c.email && c.email.trim());

// Fake knex-like `conn`: table-call handlers for the plain reads/writes,
// `.raw(sql, bindings)` dispatched on SQL shape for everything else.
function makeConn(state) {
  let nextId = 1;
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
              if (cond.status && row.status !== cond.status) return 0;
              if (cond.email && (row.email || '').toLowerCase() !== String(cond.email).toLowerCase()) return 0;
              Object.assign(row, fields);
              return 1;
            },
          };
          return chain;
        },
        insert: (fields) => ({
          onConflict: () => ({
            ignore: () => ({
              returning: async () => {
                const email = String(fields.email).toLowerCase();
                const exists = state.subscribers.some((s) => (s.email || '').toLowerCase() === email);
                if (exists) return [];
                const row = { id: `sub-${nextId++}`, region_zone: null, customer_id: null, ...fields, email };
                state.subscribers.push(row);
                return [{ id: row.id }];
              },
            }),
          }),
        }),
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
    if (sql.includes('WHERE c.id = ?')) {
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
    if (sql.includes('customer_id IS NULL') && sql.includes('SELECT id, email')) {
      return { rows: state.subscribers.filter((s) => s.status === 'active' && s.customer_id == null).map((s) => ({ id: s.id, email: s.email })) };
    }
    if (sql.includes('UPDATE newsletter_subscribers ns')) {
      const [email, , subscriberId, whereEmail] = bindings;
      const matches = state.customers.filter((c) => (c.email || '').trim().toLowerCase() === key(email) && isLive(c));
      const row = state.subscribers.find((s) => s.id === subscriberId);
      if (row && matches.length === 1 && row.status === 'active' && row.customer_id == null
          && (row.email || '').toLowerCase() === key(whereEmail)) {
        row.customer_id = matches[0].id;
        return { rows: [{ id: row.id }] };
      }
      return { rows: [] };
    }
    if (sql.includes('SELECT id FROM customers') || sql.includes('SELECT count(*) FROM customers')) {
      const [email] = bindings;
      const matches = state.customers.filter((c) => (c.email || '').trim().toLowerCase() === key(email) && isLive(c));
      if (sql.includes('count(*)')) return { rows: [{ count: String(matches.length) }] };
      return { rows: matches.map((c) => ({ id: c.id })) };
    }
    throw new Error(`Unhandled raw SQL: ${sql.slice(0, 80)}`);
  });

  return conn;
}

const cust = (o) => ({
  id: 'c1', email: 'a@example.com', first_name: 'F', last_name: 'L', city: 'Venice',
  deleted_at: null, active: true, pipeline_stage: 'active_customer', ...o,
});

beforeEach(() => {
  jest.clearAllMocks();
  activeSuppressionsFor.mockResolvedValue([]);
  linkToCustomer.mockResolvedValue();
});

// Candidate scope now reuses the canonical whereLiveCustomer/CUSTOMER_STAGES
// rule verbatim (owner ruling 2026-09-28): active_customer/won/at_risk are
// candidates, a NULL pipeline_stage is NOT (it used to count as
// active_customer under this build's earlier, narrower definition).
test.each([
  ['active_customer', true], ['won', true], ['at_risk', true],
  [null, false], ['new_lead', false], ['churned', false],
])('pipeline_stage %s -> candidate: %s', async (stage, expected) => {
  const state = { customers: [cust({ pipeline_stage: stage })], subscribers: [], prefs: [{ customer_id: 'c1', marketing_offers: true }] };
  const result = await reconcileCustomers({ conn: makeConn(state) });
  expect(result.candidates).toBe(expected ? 1 : 0);
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
  expect(result.excluded.row_appeared).toBe(0);
  expect(linkToCustomer).not.toHaveBeenCalled();
  // Reused verbatim, never re-derived — checked on the one row that expects a suppression lookup.
  if (reason === 'suppressed') expect(activeSuppressionsFor).toHaveBeenCalledWith(null, 'a@example.com', 'marketing_newsletter', expect.anything());
});

test('dry run performs zero writes (importable + byCity still computed); write mode then INSERTs and backfills region_zone via cityToZone', async () => {
  const state = {
    customers: [cust({ id: 'c1', email: 'ok@example.com', city: 'Venice' }), cust({ id: 'c2', email: 'unsub@example.com' })],
    subscribers: [{ id: 's-unsub', customer_id: 'c2', email: 'unsub@example.com', status: 'unsubscribed' }],
    prefs: [{ customer_id: 'c1', marketing_offers: true }],
  };
  const dry = await reconcileCustomers({ conn: makeConn(state) });
  expect(dry).toMatchObject({ dryRun: true, importable: 1, imported: 0, byCity: [{ city: 'Venice', count: 1 }] });
  expect(state.subscribers).toHaveLength(1); // dry run inserted nothing

  const write = await reconcileCustomers({ dryRun: false, conn: makeConn(state) });
  expect(write.imported).toBe(1);
  const created = state.subscribers.find((s) => s.email === 'ok@example.com');
  expect(created).toMatchObject({ status: 'active', source: 'customer_import', first_name: 'F', last_name: 'L', region_zone: 'south_sarasota' });
  expect(created.confirmed_at).toBeInstanceOf(Date);
  expect(linkToCustomer).toHaveBeenCalledWith('ok@example.com');
});

test.each(['unsubscribed', 'pending', 'inactive'])(
  'a previously %s address is NEVER (re)subscribed even when marketing_offers is true — the INSERT has no UPDATE branch to take',
  async (status) => {
    const state = {
      customers: [cust({ email: 'a@example.com' })],
      subscribers: [{ id: 's0', customer_id: 'c1', email: 'a@example.com', status, source: 'public_form', first_name: null }],
      prefs: [{ customer_id: 'c1', marketing_offers: true }],
    };
    const result = await reconcileCustomers({ dryRun: false, conn: makeConn(state) });
    expect(result.imported).toBe(0);
    expect(linkToCustomer).not.toHaveBeenCalled();
    const row = state.subscribers.find((s) => s.id === 's0');
    expect(row.status).toBe(status); // byte-for-byte unchanged
    expect(row.source).toBe('public_form');
    expect(row.first_name).toBeNull();
  },
);

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
  expect(linkToCustomer).not.toHaveBeenCalled();
});

test('re-check reloads the customer: one archived between the read and the write is skipped, not imported', async () => {
  const state = { customers: [cust({ id: 'c1', email: 'gone@example.com' })], subscribers: [], prefs: [{ customer_id: 'c1', marketing_offers: true }] };
  const conn = makeConn(state);
  const rawImpl = conn.raw.getMockImplementation();
  conn.raw = jest.fn(async (sql, bindings) => {
    // Archive the customer right before the write-time reload reads it (the
    // batch classification loop never calls this query at all).
    if (sql.includes('WHERE c.id = ?')) state.customers[0].deleted_at = new Date();
    return rawImpl(sql, bindings);
  });
  const result = await reconcileCustomers({ dryRun: false, conn });
  expect(result.importable).toBe(1); // the pre-write snapshot still counted it
  expect(result.imported).toBe(0);
  expect(linkToCustomer).not.toHaveBeenCalled();
});

test('a row that appears for the same email in the instant between the recheck and the INSERT is left byte-for-byte unchanged, and counted as row_appeared', async () => {
  const state = { customers: [cust({ email: 'race@example.com' })], subscribers: [], prefs: [{ customer_id: 'c1', marketing_offers: true }] };
  const conn = makeConn(state);
  // notification_prefs is classifyCustomer's LAST read, on both the batch
  // pass (call 1) and the write-time recheck (call 2) — mutate right after
  // call 2 finishes reading, so classifyCustomer still reports "importable"
  // but the row exists by the time the INSERT's own ON CONFLICT runs.
  let prefsReads = 0;
  const originalPrefsTable = conn('notification_prefs');
  const realConnFn = conn;
  const wrapped = (table) => {
    if (table !== 'notification_prefs') return realConnFn(table);
    return {
      where: (cond) => ({
        first: async () => {
          prefsReads += 1;
          const result = await originalPrefsTable.where(cond).first();
          if (prefsReads === 2) {
            state.subscribers.push({ id: 's-race', customer_id: null, email: 'race@example.com', status: 'active', source: 'other_flow', region_zone: null });
          }
          return result;
        },
      }),
    };
  };
  wrapped.raw = conn.raw;
  const result = await reconcileCustomers({ dryRun: false, conn: wrapped });
  expect(result.imported).toBe(0);
  expect(result.excluded.row_appeared).toBe(1);
  expect(linkToCustomer).not.toHaveBeenCalled();
  const row = state.subscribers.find((s) => s.id === 's-race');
  expect(row.source).toBe('other_flow'); // untouched by the import
});

test('zone fill (write mode only): fills a null/blank region_zone from a live customer city that maps to a zone; a non-mapping city is left alone; reports ACTUALLY applied', async () => {
  const state = {
    customers: [cust({ id: 'c1', email: 'z1@e.com', city: 'Venice' }), cust({ id: 'c2', email: 'z2@e.com', city: 'Nowhere' })],
    subscribers: [{ id: 's1', customer_id: 'c1', email: 'z1@e.com', status: 'active', region_zone: null },
      { id: 's2', customer_id: 'c2', email: 'z2@e.com', status: 'active', region_zone: '' }],
    prefs: [],
  };
  const dry = await reconcileCustomers({ conn: makeConn(state) });
  expect(dry.zoneFills).toBe(1); // only the mappable city counts (read-phase candidate count)
  expect(state.subscribers[0].region_zone).toBeNull(); // dry run touches nothing

  const write = await reconcileCustomers({ dryRun: false, conn: makeConn(state) });
  expect(write.zoneFills).toBe(1); // write-mode reports ACTUALLY applied
  expect(state.subscribers[0].region_zone).toBe('south_sarasota');
  expect(state.subscribers[1].region_zone).toBe(''); // 'Nowhere' never maps — untouched
});

// Orphan link (write mode only) — exact-match only; the check and the write
// are ONE atomic statement (applyOrphanLink), not a separate read + write.
test.each([
  ['exactly one live customer -> linked', [cust({ id: 'c1', email: 'orphan@e.com' })], 'c1'],
  ['two live customers sharing the email -> never guesses, stays unlinked', [cust({ id: 'c1', email: 'orphan@e.com' }), cust({ id: 'c2', email: 'orphan@e.com' })], null],
  ['zero live customers -> stays unlinked', [], null],
])('%s', async (_label, customers, expected) => {
  const state = { customers, subscribers: [{ id: 's1', customer_id: null, email: 'orphan@e.com', status: 'active' }], prefs: [] };
  const dry = await reconcileCustomers({ conn: makeConn(state) });
  expect(dry.orphanLinks).toBe(expected ? 1 : 0); // read-phase candidate count
  const write = await reconcileCustomers({ dryRun: false, conn: makeConn(state) });
  expect(write.orphanLinks).toBe(expected ? 1 : 0); // write-mode: actually applied
  expect(state.subscribers[0].customer_id).toBe(expected);
});

test('orphan link is atomic with the match check: a second live customer sharing the email appearing mid-batch drops the link (reported count reflects what was ACTUALLY applied, not the read-phase snapshot)', async () => {
  const state = { customers: [cust({ id: 'c1', email: 'orphan@e.com' })], subscribers: [{ id: 's1', customer_id: null, email: 'orphan@e.com', status: 'active' }], prefs: [] };
  const conn = makeConn(state);
  let firstRead = true;
  const rawImpl = conn.raw.getMockImplementation();
  conn.raw = jest.fn(async (sql, bindings) => {
    // Call 1 = the read-phase count (sees exactly one match); call 2 = the
    // atomic UPDATE's own match check — add a second live customer first.
    if ((sql.includes('SELECT id FROM customers') || sql.includes('count(*) FROM customers'))) {
      if (!firstRead) state.customers.push(cust({ id: 'c2', email: 'orphan@e.com' }));
      firstRead = false;
    }
    return rawImpl(sql, bindings);
  });
  const result = await reconcileCustomers({ dryRun: false, conn });
  expect(result.orphanLinks).toBe(0); // NOT the read-phase snapshot — what was actually applied
  expect(state.subscribers[0].customer_id).toBeNull(); // the atomic write found it now ambiguous
});
