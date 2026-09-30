/**
 * Newsletter list reconciliation — fully mocked (matches
 * admin-newsletter-import-archived-scope.test.js /
 * newsletter-relink-archived-customer.test.js). A fake `conn` dispatches on
 * each raw query's SQL shape against an in-memory fixture, so the
 * priority-order/filtering logic gets real behavioral coverage.
 */

// linkToCustomer is faked against the fixture (makeConn); the twin picker's
// SQL fragment (liveTwinSubselect) is the REAL one — the module embeds it.
jest.mock('../services/newsletter-subscribers', () => ({
  linkToCustomer: jest.fn(async () => {}),
  liveTwinSubselect: jest.requireActual('../services/newsletter-subscribers').liveTwinSubselect,
}));
jest.mock('../services/email-template-library', () => ({ activeSuppressionsFor: jest.fn(async () => []) }));
jest.mock('../services/logger', () => ({ error: jest.fn(), info: jest.fn(), warn: jest.fn() }));
// The comms/email advisory locks are real Postgres behavior (proven against
// real Postgres in newsletter-list-reconcile-postgres.test.js) — no-op here
// so the fully-mocked conn doesn't need to fake pg_advisory_xact_lock SQL.
// The mailbox identity (googleMailboxIdentity / GOOGLE_MAILBOX_SQL) is the
// REAL one — the module embeds it in its exclusion SQL.
jest.mock('../utils/customer-comms-lock', () => ({
  lockCustomerComms: jest.fn(async () => {}),
  lockCustomerEmail: jest.fn(async () => {}),
  googleMailboxIdentity: jest.requireActual('../utils/customer-comms-lock').googleMailboxIdentity,
  GOOGLE_MAILBOX_SQL: jest.requireActual('../utils/customer-comms-lock').GOOGLE_MAILBOX_SQL,
}));

const { linkToCustomer } = require('../services/newsletter-subscribers');
const { googleMailboxIdentity } = jest.requireActual('../utils/customer-comms-lock');
const { activeSuppressionsFor } = require('../services/email-template-library');
const { CUSTOMER_STAGES } = require('../services/customer-stages');
const { reconcileCustomers } = require('../services/newsletter-list-reconcile');

const PRIORITY = { active: 0, unsubscribed: 1, pending: 2, inactive: 3, waitlist: 3 };
// Canonical whereLiveCustomer/CUSTOMER_STAGES rule — the "live customer"
// check for candidate scope and zone fill: active, not deleted,
// pipeline_stage IN CUSTOMER_STAGES. A NULL pipeline_stage does NOT match
// (owner ruling 2026-09-28). The orphan LINK is not lifecycle-scoped: it
// uses the canonical twin picker (canonicalPick below), like every linker.
const isLive = (c) => !c.deleted_at && c.active === true && CUSTOMER_STAGES.includes(c.pipeline_stage);
// Matches subscribeOrResubscribe's own strict:false floor ("@" present) —
// mirrors the production HAS_AT SQL filter added to every candidate query.
const hasValidEmail = (c) => !!(c.email && c.email.trim()) && c.email.includes('@');
const isCandidate = (c) => isLive(c) && hasValidEmail(c);

// Fake knex-like `conn`: table-call handlers for the plain reads/writes,
// `.raw(sql, bindings)` dispatched on SQL shape for everything else.
function makeConn(state) {
  let nextId = 1;
  const conn = (table) => {
    if (table === 'notification_prefs') {
      return {
        where: () => ({
          // decideAddress takes each sharing profile's row FOR SHARE and
          // never reads the result — a no-op here is faithful (the row-lock
          // itself is real Postgres behavior, proved in the Postgres suite).
          forShare: async () => {},
        }),
        // classifyAddress's ONE prefs read, across every sharing profile.
        // `state.onPrefsRead(n)` lets a test act right after the Nth read.
        whereIn: async (column, ids) => {
          const rows = state.prefs.filter((p) => ids.includes(p.customer_id));
          state.prefsReads = (state.prefsReads || 0) + 1;
          if (state.onPrefsRead) state.onPrefsRead(state.prefsReads);
          return rows;
        },
      };
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
    && (s.customer_id === c.id || (s.email || '').trim().toLowerCase() === c.email.trim().toLowerCase()));
  const key = (v) => String(v).trim().toLowerCase();
  // sameMailboxSql's semantics: exact LOWER(TRIM), or one Google mailbox.
  const sameMailbox = (a, b) => key(a) === key(b)
    || (!!googleMailboxIdentity(key(a)) && googleMailboxIdentity(key(a)) === googleMailboxIdentity(key(b)));

  // THE canonical twin picker (liveTwinSubselect, newsletter-subscribers.js):
  // every NON-ARCHIVED profile on the normalized address, any stage, ordered
  // is_primary_profile DESC NULLS LAST, created_at ASC, id ASC.
  const primaryRank = (v) => (v === true ? 0 : v === false ? 1 : 2);
  // THE SAME tie-break, applied globally to fetchCandidateRows' ORDER BY
  // (production SQL) — ties a mailbox-sharing group's iteration order to the
  // picker's own ranking, so whichever candidate is processed first (and
  // therefore kept — see `projectedAddresses` in the module under test) is
  // never an artifact of insertion order.
  const candidateOrder = (a, b) => primaryRank(a.is_primary_profile) - primaryRank(b.is_primary_profile)
    || String(a.created_at || '').localeCompare(String(b.created_at || ''))
    || String(a.id).localeCompare(String(b.id));
  const canonicalPick = (email) => state.customers
    .filter((c) => !c.deleted_at && key(c.email || '') === key(email))
    .sort((a, b) => primaryRank(a.is_primary_profile) - primaryRank(b.is_primary_profile)
      || String(a.created_at || '').localeCompare(String(b.created_at || ''))
      || String(a.id).localeCompare(String(b.id)))[0] || null;

  // The real linkToCustomer's behavior against this fixture: rows whose
  // email equals the lowercased input and are still unlinked get the
  // canonical pick for the trimmed address.
  linkToCustomer.mockImplementation(async (email) => {
    const lc = String(email).toLowerCase();
    const twin = canonicalPick(lc.trim());
    if (!twin) return;
    for (const s of state.subscribers) if (s.email === lc && s.customer_id == null) s.customer_id = twin.id;
  });

  // THE orphan-link predicate (orphanTargetSql): the canonical twin of a
  // still-active unlinked orphan, refused (never redirected) when that twin
  // already owns an active subscriber.
  const orphanTarget = (subscriberId) => {
    const orphan = state.subscribers.find((s) => s.id === subscriberId);
    if (!orphan || orphan.status !== 'active' || orphan.customer_id != null) return null;
    const twin = canonicalPick(orphan.email);
    if (!twin) return null;
    if (state.subscribers.some((s) => s.customer_id === twin.id && s.status === 'active')) return null;
    return twin.id;
  };

  conn.raw = jest.fn(async (sql, bindings = []) => {
    // Checked FIRST: the orphan SQL embeds the twin picker (and with it
    // "FROM customers c" and "NOT EXISTS"), so the more generic branches
    // below would otherwise mis-route it.
    if (sql.includes('SET customer_id = t.id')) {
      const subscriberId = bindings[0];
      const lockedTarget = bindings[bindings.length - 1];
      const target = orphanTarget(subscriberId);
      if (target && target === lockedTarget) {
        state.subscribers.find((s) => s.id === subscriberId).customer_id = target;
        return { rows: [{ id: subscriberId }] };
      }
      return { rows: [] };
    }
    if (sql.includes('SELECT pick.twin_id')) {
      const target = orphanTarget(bindings[bindings.length - 1]);
      return { rows: target ? [{ id: target }] : [] };
    }
    // canonicalProfile — the decision's canonical identity pick.
    if (sql.includes('AS canonical_id')) {
      const c = canonicalPick(bindings[0]);
      return { rows: c ? [{ canonical_id: c.id, first_name: c.first_name, last_name: c.last_name, city: c.city }] : [] };
    }
    // Identity refresh from the profile the link actually landed on —
    // RETURNING its CURRENT city too (the applied-city accounting reads
    // this, never the pre-insert decision.canonical.city).
    if (sql.includes('SET first_name = linked.first_name')) {
      const row = state.subscribers.find((s) => s.id === bindings[0]);
      const linked = row && state.customers.find((c) => c.id === row.customer_id);
      if (linked) Object.assign(row, { first_name: linked.first_name, last_name: linked.last_name });
      return { rows: linked ? [{ city: linked.city }] : [] };
    }
    // decideAddress's FOR SHARE on every sharing profile's customers row —
    // a real row lock (proved in the Postgres suite); a no-op here.
    if (sql.includes('FROM customers WHERE id = ANY')) return { rows: [] };
    // fillZoneForSubscriber: peek the link, lock the customer row FIRST (its
    // own statement — codex P1: customer-before-subscriber lock order, never
    // combined with the subscriber lock below in one statement), then the
    // locked subscriber re-read, then the write — checked BEFORE the generic
    // zone-candidate branch below.
    if (sql.includes('SELECT customer_id FROM newsletter_subscribers WHERE id = ?')) {
      const row = state.subscribers.find((s) => s.id === bindings[0]);
      return { rows: row ? [{ customer_id: row.customer_id ?? null }] : [] };
    }
    if (sql.includes('FROM customers WHERE id = ? FOR SHARE')) return { rows: [] };
    if (sql.includes('FOR UPDATE OF ns')) {
      const [, subscriberId, customerId] = bindings;
      const row = state.subscribers.find((s) => s.id === subscriberId);
      const c = state.customers.find((x) => x.id === customerId);
      const ok = row && row.status === 'active' && (!row.region_zone || !row.region_zone.trim())
        && row.customer_id === customerId && c && isLive(c);
      return { rows: ok ? [{ subscriber_id: row.id, city: c.city }] : [] };
    }
    if (sql.includes('UPDATE newsletter_subscribers SET region_zone')) {
      const [zone, subscriberId] = bindings;
      state.subscribers.find((s) => s.id === subscriberId).region_zone = zone;
      return { rows: [] };
    }
    // countInvalidEmailCandidates — checked BEFORE the generic
    // "FROM customers c ... NOT EXISTS" branch below, since its SQL text
    // also contains both those substrings.
    if (sql.includes('count(*) AS n')) {
      const n = state.customers.filter((c) => isLive(c) && c.email && c.email.trim() && !c.email.includes('@') && !hasActive(c)).length;
      return { rows: [{ n: String(n) }] };
    }
    // profilesSharingAddress — every NON-ARCHIVED profile on the address,
    // any stage (the same population linkToCustomer's picker chooses from).
    if (sql.includes('AS profile_id')) {
      const [email] = bindings;
      return { rows: state.customers.filter((c) => !c.deleted_at && c.email && sameMailbox(c.email, email)).map((c) => ({ profile_id: c.id })) };
    }
    // mailboxSuppressions: every stored spelling of the same mailbox.
    if (sql.includes('FROM email_suppressions')) {
      const [email] = bindings;
      return { rows: [...new Set((state.suppressions || []).filter((e) => sameMailbox(e, email)).map(key))].map((e) => ({ email: e })) };
    }
    // projectedOrphanZoneFill — the zone-fill predicate read against the
    // link target (checked BEFORE the generic zone-candidate branch).
    if (sql.includes('JOIN customers c ON c.id = ?')) {
      const [customerId, , subscriberId] = bindings;
      const row = state.subscribers.find((s) => s.id === subscriberId);
      const c = state.customers.find((x) => x.id === customerId);
      const ok = row && row.status === 'active' && (!row.region_zone || !row.region_zone.trim()) && c && isLive(c);
      return { rows: ok ? [{ city: c.city }] : [] };
    }
    if (sql.includes('FROM customers c') && sql.includes('NOT EXISTS')) {
      // Mirrors the production ORDER BY verbatim — see candidateOrder above.
      return { rows: state.customers.filter(isCandidate).filter((c) => !hasActive(c)).sort(candidateOrder)
        .map((c) => ({ customer_id: c.id, email: c.email, first_name: c.first_name, last_name: c.last_name, city: c.city })) };
    }
    if (sql.includes('WHERE c.id = ?')) {
      const [customerId] = bindings;
      const c = state.customers.find((x) => x.id === customerId && isCandidate(x));
      return { rows: c ? [{ customer_id: c.id, email: c.email, first_name: c.first_name, last_name: c.last_name, city: c.city }] : [] };
    }
    if (sql.includes('ORDER BY CASE status')) {
      const [profileIds, email] = bindings;
      const matches = state.subscribers.filter((s) => profileIds.includes(s.customer_id) || (s.email && sameMailbox(s.email, email)));
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
    throw new Error(`Unhandled raw SQL: ${sql.slice(0, 80)}`);
  });

  // importOneCustomer opens its own transaction per import — the fake conn
  // has no real connection/savepoint to open, so trx IS conn: every table
  // call and .raw dispatch inside the callback runs against this same
  // in-memory state, which is exactly how the real nested-transaction
  // (savepoint) behavior reads from the caller's point of view.
  conn.transaction = jest.fn(async (cb) => cb(conn));

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
  // OPT-OUT gate, never opt-in (owner-approved plan — see module header
  // "CONSENT BASIS"): only an EXPLICIT false excludes.
  ['marketing_opted_out', [], [{ marketing_offers: false }], false],
  // channelFor (the SAME resolution email-division/eligibility.js uses):
  // only a RESOLVED 'sms' excludes — marketing_offers is true here, so this
  // proves the channel check is independent of the opt-out check above.
  ['marketing_sms_only', [], [{ marketing_offers: true, marketing_channel: 'sms' }], false],
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
  // Called on the SAME connection importOneCustomer opened its transaction
  // on — never a second linker, never crosses a connection boundary.
  expect(linkToCustomer).toHaveBeenCalledWith('ok@example.com', expect.anything());
});

test('a malformed email ("@" missing) is never a candidate, and is counted under excluded.invalid_email — not silently dropped', async () => {
  const state = {
    customers: [cust({ id: 'c1', email: 'ok@example.com', city: 'Venice' }), cust({ id: 'c2', email: 'noatsign.example.com' })],
    subscribers: [],
    prefs: [{ customer_id: 'c1', marketing_offers: true }, { customer_id: 'c2', marketing_offers: true }],
  };
  const result = await reconcileCustomers({ conn: makeConn(state) });
  expect(result.candidates).toBe(1); // only the well-formed address
  expect(result.excluded.invalid_email).toBe(1);
});

// Regression guard for the exact behavior commit 547e380767 ("make the
// import write provably unable to resubscribe anyone") introduced: an
// archived customer (deleted_at set, active still true) must never be a
// candidate and must never be (re)subscribed, even mid-batch.
test('an archived customer (deleted_at set) is never a candidate and is never (re)subscribed', async () => {
  const state = {
    customers: [cust({ id: 'c1', email: 'archived@example.com', deleted_at: new Date() })],
    subscribers: [],
    prefs: [{ customer_id: 'c1', marketing_offers: true }],
  };
  const dry = await reconcileCustomers({ conn: makeConn(state) });
  expect(dry.candidates).toBe(0); // deleted_at excludes it before it's ever classified
  const write = await reconcileCustomers({ dryRun: false, conn: makeConn(state) });
  expect(write.imported).toBe(0);
  expect(linkToCustomer).not.toHaveBeenCalled();
  expect(state.subscribers).toHaveLength(0);
});

// CONSENT BASIS regression guard (owner-approved plan rows 2 & 11, module
// header): marketing_offers is an OPT-OUT gate, never an opt-in
// requirement, for THIS import specifically. A customer with no prefs row
// at all — the common case for the plan's "305 active customers who are
// not subscribed" — has no opt-out on file and IS imported.
test('a customer with NO notification_prefs row at all has no opt-out on file and IS imported (opt-out gate, not opt-in requirement)', async () => {
  const state = {
    customers: [cust({ id: 'c1', email: 'never-asked@example.com', city: 'Venice' })],
    subscribers: [],
    prefs: [], // no row — NOT the same as marketing_offers: false
  };
  const dry = await reconcileCustomers({ conn: makeConn(state) });
  expect(dry.importable).toBe(1);
  expect(dry.excluded.marketing_opted_out).toBe(0);
  expect(dry.excluded.marketing_sms_only).toBe(0);

  const write = await reconcileCustomers({ dryRun: false, conn: makeConn(state) });
  expect(write.imported).toBe(1);
  const created = state.subscribers.find((s) => s.email === 'never-asked@example.com');
  expect(created).toMatchObject({ status: 'active', source: 'customer_import' });
});

// Finding #4 regression guard: the canonical link/relink queries already
// normalize both sides (LOWER(TRIM(...))); existingSubscriberStatus and the
// candidate NOT EXISTS check must match, or a padded legacy row's
// unsubscribe silently stops blocking a re-import.
test('a padded legacy unsubscribed row (" user@example.com ") still blocks a new active row for the same address', async () => {
  const state = {
    customers: [cust({ id: 'c1', email: 'user@example.com' })],
    subscribers: [{ id: 's0', customer_id: null, email: ' user@example.com ', status: 'unsubscribed' }],
    prefs: [{ customer_id: 'c1', marketing_offers: true }],
  };
  const dry = await reconcileCustomers({ conn: makeConn(state) });
  // The padded row isn't ACTIVE, so it's still a fetchCandidateRows
  // candidate — the normalization fix matters at CLASSIFICATION, where the
  // unsubscribed status must be found despite the whitespace.
  expect(dry.candidates).toBe(1);
  expect(dry.importable).toBe(0);
  expect(dry.excluded.previously_unsubscribed).toBe(1);
  const write = await reconcileCustomers({ dryRun: false, conn: makeConn(state) });
  expect(write.imported).toBe(0);
  expect(linkToCustomer).not.toHaveBeenCalled();
  expect(state.subscribers).toHaveLength(1); // nothing new inserted
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
  // Codex #5165 (:717): importable/byCity describe what was ACTUALLY
  // applied in write mode — a write-time exclusion must not leave the
  // rejected candidate counted as importable while imported stays 0.
  expect(result.importable).toBe(0);
  expect(result.imported).toBe(0); // the recheck caught the mid-flight unsubscribe
  expect(result.projected.importable).toBe(1); // the pre-write snapshot, exposed separately
  expect(linkToCustomer).not.toHaveBeenCalled();
});

test('re-check reloads the customer: one archived between the read and the write is skipped, not imported', async () => {
  const state = { customers: [cust({ id: 'c1', email: 'gone@example.com' })], subscribers: [], prefs: [{ customer_id: 'c1', marketing_offers: true }] };
  const conn = makeConn(state);
  const rawImpl = conn.raw.getMockImplementation();
  let reloads = 0;
  conn.raw = jest.fn(async (sql, bindings) => {
    // The projection's decision reloads the customer twice (the unlocked
    // peek, then FOR SHARE); archive it right before the WRITE-time
    // decision's first reload.
    if (sql.includes('WHERE c.id = ?') && ++reloads === 3) state.customers[0].deleted_at = new Date();
    return rawImpl(sql, bindings);
  });
  const result = await reconcileCustomers({ dryRun: false, conn });
  expect(result.importable).toBe(0); // ACTUALLY applied — the recheck excluded it
  expect(result.imported).toBe(0);
  expect(result.projected.importable).toBe(1); // the pre-write snapshot, exposed separately
  expect(linkToCustomer).not.toHaveBeenCalled();
});

test('a row that appears for the same email in the instant between the recheck and the INSERT is left byte-for-byte unchanged, and counted as row_appeared', async () => {
  const state = { customers: [cust({ email: 'race@example.com' })], subscribers: [], prefs: [{ customer_id: 'c1', marketing_offers: true }] };
  // The prefs read is classifyAddress's LAST read, on both the projection
  // (read 1) and the write-time decision (read 2) — land the race right
  // after read 2, so the decision still says "importable" but the row
  // exists by the time the INSERT's own ON CONFLICT runs.
  state.onPrefsRead = (n) => {
    if (n === 2) state.subscribers.push({ id: 's-race', customer_id: null, email: 'race@example.com', status: 'active', source: 'other_flow', region_zone: null });
  };
  const result = await reconcileCustomers({ dryRun: false, conn: makeConn(state) });
  expect(result.imported).toBe(0);
  expect(result.excluded.row_appeared).toBe(1);
  expect(linkToCustomer).not.toHaveBeenCalled();
  const row = state.subscribers.find((s) => s.id === 's-race');
  expect(row.source).toBe('other_flow'); // untouched by the import
});

// Codex P1 (this round): a raw driver error's own message/detail can embed
// the actual row value (a real Postgres unique-violation's DETAIL reads
// "Key (email)=(x@y.com) already exists."). Neither the errors array nor
// the log line may ever carry that — only an id-only descriptor plus the
// driver's error CODE.
test('a thrown DB-style error during classification never leaks the customer email into errors[] or the log — only an id + error code', async () => {
  const state = { customers: [cust({ id: 'c1', email: 'secret-pii@example.com' })], subscribers: [], prefs: [{ customer_id: 'c1', marketing_offers: true }] };
  const conn = makeConn(state);
  const rawImpl = conn.raw.getMockImplementation();
  conn.raw = jest.fn(async (sql, bindings) => {
    if (sql.includes('WHERE c.id = ?')) {
      const err = Object.assign(
        new Error('duplicate key value violates unique constraint "x" - Key (email)=(secret-pii@example.com) already exists.'),
        { code: '23505', detail: 'Key (email)=(secret-pii@example.com) already exists.' },
      );
      throw err;
    }
    return rawImpl(sql, bindings);
  });
  const result = await reconcileCustomers({ conn });
  expect(result.errors).toEqual([{ customerId: 'c1', error: 'db_error_23505' }]);
  expect(JSON.stringify(result.errors)).not.toContain('secret-pii');
  const logger = require('../services/logger');
  for (const call of logger.error.mock.calls) expect(call.join(' ')).not.toContain('secret-pii');
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

// Orphan link (write mode only) — the target is THE canonical twin picker's
// (liveTwinSubselect: the profile linkToCustomer / linkManyToCustomers would
// choose — any non-archived stage, is_primary_profile / created_at / id);
// the check and the write are ONE atomic statement (applyOrphanLink).
test.each([
  ['exactly one live customer -> linked', [cust({ id: 'c1', email: 'orphan@e.com' })], 'c1'],
  ['two live customers sharing the email -> the canonical twin (is_primary_profile), never whichever matched', [cust({ id: 'c1', email: 'orphan@e.com' }), cust({ id: 'c2', email: 'orphan@e.com', is_primary_profile: true })], 'c2'],
  ['a live customer and a primary LEAD profile -> the lead, exactly as linkToCustomer would link it (link scope, not lifecycle scope)', [cust({ id: 'c1', email: 'orphan@e.com' }), cust({ id: 'c2', email: 'Orphan@E.com ', pipeline_stage: 'new_lead', is_primary_profile: true })], 'c2'],
  ['a live customer and an OLDER inactive profile -> the older one (created_at ASC)', [cust({ id: 'c1', email: 'orphan@e.com', created_at: '2026-02-01' }), cust({ id: 'c2', email: 'orphan@e.com', active: false, created_at: '2025-01-01' })], 'c2'],
  ['only an archived profile -> stays unlinked', [cust({ id: 'c1', email: 'orphan@e.com', deleted_at: new Date() })], null],
  ['zero customers -> stays unlinked', [], null],
])('%s', async (_label, customers, expected) => {
  const state = { customers, subscribers: [{ id: 's1', customer_id: null, email: 'orphan@e.com', status: 'active' }], prefs: [] };
  const dry = await reconcileCustomers({ conn: makeConn(state) });
  expect(dry.orphanLinks).toBe(expected ? 1 : 0); // read-phase candidate count
  const write = await reconcileCustomers({ dryRun: false, conn: makeConn(state) });
  expect(write.orphanLinks).toBe(expected ? 1 : 0); // write-mode: actually applied
  expect(state.subscribers[0].customer_id).toBe(expected);
});

test('orphan link is atomic with the canonical pick: a new primary profile appearing mid-batch refuses the stale target (reported count reflects what was ACTUALLY applied, not the read-phase snapshot)', async () => {
  const state = { customers: [cust({ id: 'c1', email: 'orphan@e.com' })], subscribers: [{ id: 's1', customer_id: null, email: 'orphan@e.com', status: 'active' }], prefs: [] };
  const conn = makeConn(state);
  const rawImpl = conn.raw.getMockImplementation();
  conn.raw = jest.fn(async (sql, bindings) => {
    // The projection and the write's resolve both picked c1; a new primary
    // profile lands just before the UPDATE re-runs the picker in its own
    // statement — the UPDATE never writes the target it resolved earlier.
    if (sql.includes('SET customer_id = t.id')) state.customers.push(cust({ id: 'c2', email: 'orphan@e.com', is_primary_profile: true }));
    return rawImpl(sql, bindings);
  });
  const result = await reconcileCustomers({ dryRun: false, conn });
  expect(result.orphanLinks).toBe(0); // NOT the read-phase snapshot — what was actually applied
  expect(state.subscribers[0].customer_id).toBeNull(); // the atomic write saw the pick move
});

test('an imported row takes its name from the CANONICAL profile (the one it links to), never whichever sharing profile the candidate scan returned first', async () => {
  const state = {
    customers: [
      // Listed first, so the (unordered) candidate scan returns it first.
      cust({ id: 'c1', email: 'shared@example.com', first_name: 'Second', last_name: 'Profile', city: 'Nowhere' }),
      cust({ id: 'c2', email: 'Shared@example.com', first_name: 'Primary', last_name: 'Holder', city: 'Venice', is_primary_profile: true }),
    ],
    subscribers: [],
    prefs: [],
  };
  const dry = await reconcileCustomers({ conn: makeConn(state) });
  expect(dry).toMatchObject({ importable: 1, byCity: [{ city: 'Venice', count: 1 }] });
  const write = await reconcileCustomers({ dryRun: false, conn: makeConn(state) });
  expect(write.imported).toBe(1);
  expect(state.subscribers).toHaveLength(1);
  expect(state.subscribers[0]).toMatchObject({ customer_id: 'c2', first_name: 'Primary', last_name: 'Holder', region_zone: 'south_sarasota' });
});

test('zone fill re-reads the linked customer at write time: a city changed after the projection is the one used, and a customer archived mid-batch gets no zone', async () => {
  const state = {
    customers: [cust({ id: 'c1', email: 'z1@e.com', city: 'Venice' }), cust({ id: 'c2', email: 'z2@e.com', city: 'Venice' })],
    subscribers: [{ id: 's1', customer_id: 'c1', email: 'z1@e.com', status: 'active', region_zone: null },
      { id: 's2', customer_id: 'c2', email: 'z2@e.com', status: 'active', region_zone: null }],
    prefs: [],
  };
  const conn = makeConn(state);
  const rawImpl = conn.raw.getMockImplementation();
  let projected = false;
  conn.raw = jest.fn(async (sql, bindings) => {
    const out = await rawImpl(sql, bindings);
    // Right after the projection read both as Venice (south_sarasota): c1
    // moves to Bradenton (manatee), c2 is archived.
    if (!projected && sql.includes('region_zone IS NULL') && !sql.includes('FOR UPDATE OF ns')) {
      projected = true;
      state.customers[0].city = 'Bradenton';
      state.customers[1].deleted_at = new Date();
    }
    return out;
  });
  const write = await reconcileCustomers({ dryRun: false, conn });
  expect(state.subscribers[0].region_zone).toBe('manatee'); // the CURRENT city, never the projected zone
  expect(state.subscribers[1].region_zone).toBeNull(); // no longer linked to a live customer
  expect(write.zoneFills).toBe(1);
});

test('orphan link NEVER attaches a second active subscriber to one customer — a customer already linked to an active subscriber stays unlinked from a second orphan sharing its email', async () => {
  const state = {
    customers: [cust({ id: 'c1', email: 'orphan@e.com' })],
    subscribers: [
      { id: 's-already', customer_id: 'c1', email: 'other@e.com', status: 'active' }, // already the customer's one active subscriber
      { id: 's-orphan', customer_id: null, email: 'orphan@e.com', status: 'active' },
    ],
    prefs: [],
  };
  // The dry run runs the SAME predicate the write's UPDATE embeds, so it
  // never promises the link the confirmed run refuses.
  const dry = await reconcileCustomers({ conn: makeConn(state) });
  expect(dry.orphanLinks).toBe(0);
  const result = await reconcileCustomers({ dryRun: false, conn: makeConn(state) });
  expect(result.orphanLinks).toBe(0);
  expect(state.subscribers.find((s) => s.id === 's-orphan').customer_id).toBeNull();
});

test('write-time recheck rejections keep their specific reason and are counted — never dropped as importable-with-imported:0', async () => {
  const state = { customers: [cust({ email: 'flips@example.com' })], subscribers: [], prefs: [{ customer_id: 'c1', marketing_offers: true }] };
  const conn = makeConn(state);
  let firstRead = true;
  const rawImpl = conn.raw.getMockImplementation();
  conn.raw = jest.fn(async (sql, bindings) => {
    if (sql.includes('ORDER BY CASE status')) {
      if (!firstRead) state.subscribers.push({ id: 's-new', customer_id: 'c1', email: 'flips@example.com', status: 'unsubscribed' });
      firstRead = false;
    }
    return rawImpl(sql, bindings);
  });
  const result = await reconcileCustomers({ dryRun: false, conn });
  // Codex #5165 (:717) regression: this is the exact "candidates:1,
  // importable:1, imported:0, one exclusion, byCity still shows the
  // never-happened import" inconsistency — importable/byCity in write mode
  // must now describe ONLY what was actually applied (nothing).
  expect(result.importable).toBe(0);
  expect(result.imported).toBe(0);
  expect(result.byCity).toEqual([]);
  expect(result.projected).toMatchObject({ importable: 1, byCity: [{ city: 'Venice', count: 1 }] });
  // The rejection reason from the SECOND (write-time) classification is
  // the one that's counted — never silently absorbed into imported:0 with
  // no reason anywhere in the response.
  expect(result.excluded.previously_unsubscribed).toBe(1);
  expect(Object.values(result.excluded).reduce((a, b) => a + b, 0)).toBe(1); // exactly one exclusion, nowhere else
});

// Address-level eligibility (Codex P1, shared address): one mailbox shared
// by two profiles is ONE subscriber — an explicit opt-out on ANY sharing
// profile excludes the address, even when the profile being imported has
// none, and even when the opted-out sharer is not itself a candidate (a
// lead-stage or inactive profile, which linkToCustomer's picker can still
// choose). Only an archived sharer is left out, exactly as the picker does.
test.each([
  ['marketing_opted_out', { marketing_offers: false }, {}],
  ['email_switch_off', { email_enabled: false }, {}],
  ['marketing_sms_only', { marketing_channel: 'sms' }, {}],
  ['marketing_opted_out', { marketing_offers: false }, { pipeline_stage: 'new_lead' }],
  ['marketing_opted_out', { marketing_offers: false }, { active: false }],
])('a sharing profile\'s %s excludes the shared address (sharer %j / %j) — dry run and write agree, nothing inserted', async (reason, sharerPrefs, sharerOverrides) => {
  const state = {
    customers: [
      cust({ id: 'c1', email: 'Shared@Example.com ' }),
      cust({ id: 'c2', email: 'shared@example.com', ...sharerOverrides }),
    ],
    subscribers: [],
    prefs: [{ customer_id: 'c1', marketing_offers: true }, { customer_id: 'c2', ...sharerPrefs }],
  };
  const dry = await reconcileCustomers({ conn: makeConn(state) });
  expect(dry.importable).toBe(0);
  expect(dry.excluded[reason]).toBe(dry.candidates); // every candidate on the address, under the sharer's reason
  const write = await reconcileCustomers({ dryRun: false, conn: makeConn(state) });
  expect(write.imported).toBe(0);
  expect(state.subscribers).toHaveLength(0);
  expect(linkToCustomer).not.toHaveBeenCalled();
});

test('an ARCHIVED sharer\'s opt-out does not block the address (the same population linkToCustomer can attach to)', async () => {
  const state = {
    customers: [cust({ id: 'c1', email: 'a@example.com' }), cust({ id: 'c2', email: 'a@example.com', deleted_at: new Date() })],
    subscribers: [],
    prefs: [{ customer_id: 'c2', marketing_offers: false }],
  };
  const write = await reconcileCustomers({ dryRun: false, conn: makeConn(state) });
  expect(write.imported).toBe(1);
});

test('an unsubscribed row linked to a sharing profile (at another address) excludes the shared address too', async () => {
  const state = {
    customers: [cust({ id: 'c1', email: 'a@example.com' }), cust({ id: 'c2', email: 'a@example.com', pipeline_stage: 'new_lead' })],
    subscribers: [{ id: 's0', customer_id: 'c2', email: 'old@example.com', status: 'unsubscribed' }],
    prefs: [],
  };
  const write = await reconcileCustomers({ dryRun: false, conn: makeConn(state) });
  expect(write.excluded.previously_unsubscribed).toBe(1);
  expect(write.imported).toBe(0);
});

test('every sharing profile is comms-locked before the decision reads its preferences', async () => {
  const { lockCustomerComms } = require('../utils/customer-comms-lock');
  const state = {
    customers: [cust({ id: 'c1', email: 'a@example.com' }), cust({ id: 'c2', email: 'a@example.com', pipeline_stage: 'new_lead' })],
    subscribers: [],
    prefs: [],
  };
  const locked = [];
  lockCustomerComms.mockImplementation(async (_trx, id) => { locked.push(id); });
  const lockedAtRead = [];
  state.onPrefsRead = () => { lockedAtRead.push([...locked]); };
  await reconcileCustomers({ conn: makeConn(state) });
  expect(lockedAtRead.length).toBeGreaterThan(0);
  for (const snapshot of lockedAtRead) expect(snapshot).toEqual(expect.arrayContaining(['c1', 'c2']));
  lockCustomerComms.mockImplementation(async () => {});
});

test('two candidate profiles sharing one address: projected ONCE (duplicate_address), and the write imports exactly one row', async () => {
  const state = {
    customers: [cust({ id: 'c1', email: 'a@example.com' }), cust({ id: 'c2', email: ' A@example.com' })],
    subscribers: [],
    prefs: [],
  };
  const dry = await reconcileCustomers({ conn: makeConn(state) });
  expect(dry).toMatchObject({ candidates: 2, importable: 1 });
  expect(dry.excluded.duplicate_address).toBe(1);
  const write = await reconcileCustomers({ dryRun: false, conn: makeConn(state) });
  expect(write.imported).toBe(1);
  expect(write.excluded.row_appeared).toBe(0); // the projection's count matched what the write applied
  expect(state.subscribers).toHaveLength(1);
});

// Codex P2 (:699) — "Retry a surviving profile after the projected winner
// disappears": the kept candidate for a mailbox (c1, is_primary_profile —
// the canonical pick) is archived AFTER the projection but BEFORE its own
// write-time recheck; the OTHER live candidate sharing the same mailbox
// (c2, the fallback the projection counted as duplicate_address) is still
// eligible, so the write must retry it rather than dropping the whole
// mailbox as no_longer_live.
test('when the kept mailbox candidate is archived before its write-time recheck, the write retries the next live candidate for the SAME mailbox', async () => {
  const state = {
    customers: [
      cust({ id: 'c1', email: 'fallback@example.com', is_primary_profile: true, created_at: '2026-01-01', first_name: 'Primary' }),
      cust({ id: 'c2', email: 'fallback@example.com', created_at: '2026-02-01', first_name: 'Secondary' }),
    ],
    subscribers: [],
    prefs: [],
  };
  const conn = makeConn(state);
  const rawImpl = conn.raw.getMockImplementation();
  let reads = 0;
  conn.raw = jest.fn(async (sql, bindings) => {
    // Projection processes c1 then c2 (canonical order): 2 reads each (peek +
    // FOR SHARE) = reads #1-4. c1's write-time decision's OWN first read is
    // #5 — archive it right there, simulating the race.
    if (sql.includes('WHERE c.id = ?') && ++reads === 5) state.customers[0].deleted_at = new Date();
    return rawImpl(sql, bindings);
  });
  const write = await reconcileCustomers({ dryRun: false, conn });
  expect(write.imported).toBe(1);
  expect(write.excluded.no_longer_live).toBe(0); // the fallback succeeded — never counted as dropped
  expect(state.subscribers).toHaveLength(1);
  expect(state.subscribers[0].customer_id).toBe('c2'); // the surviving candidate, not the archived one
});

// The same race, but EVERY sharing candidate is archived before its own
// write-time recheck runs — the mailbox is genuinely gone, and the outcome
// (no_longer_live) is counted exactly ONCE, never once per attempt.
test('when every mailbox candidate is archived before its write-time recheck, no_longer_live is counted exactly once, not once per fallback attempt', async () => {
  const state = {
    customers: [
      cust({ id: 'c1', email: 'allgone@example.com', is_primary_profile: true, created_at: '2026-01-01' }),
      cust({ id: 'c2', email: 'allgone@example.com', created_at: '2026-02-01' }),
    ],
    subscribers: [],
    prefs: [],
  };
  const conn = makeConn(state);
  const rawImpl = conn.raw.getMockImplementation();
  let reads = 0;
  conn.raw = jest.fn(async (sql, bindings) => {
    // Archive BOTH customers right before c1's write-time recheck (read #5)
    // — c2's own retry (reads #7-8) then also finds nothing live.
    if (sql.includes('WHERE c.id = ?') && ++reads === 5) {
      state.customers[0].deleted_at = new Date();
      state.customers[1].deleted_at = new Date();
    }
    return rawImpl(sql, bindings);
  });
  const write = await reconcileCustomers({ dryRun: false, conn });
  expect(write.imported).toBe(0);
  expect(write.excluded.no_longer_live).toBe(1); // exactly once — never once per attempt (2 fallback attempts made)
  // The ONLY other exclusion is duplicate_address (1), from the projection
  // phase counting c2 as the mailbox's second candidate — unrelated to the
  // write-time retry count. No exclusion bucket is double-counted.
  expect(write.excluded.duplicate_address).toBe(1);
  expect(Object.values(write.excluded).reduce((a, b) => a + b, 0)).toBe(2);
  expect(state.subscribers).toHaveLength(0);
});

// Codex P2 (:795) — "Retry fallbacks when the selected profile changes
// address": the projected/kept candidate (c1) moves to an ENTIRELY
// DIFFERENT mailbox between the projection and its write-time attempt. The
// old outcome-code judgment let importOneCustomer classify and import c1's
// NEW address (it's still live, so the outcome is never 'no_longer_live')
// and never tried c2, the fallback that still holds the ORIGINAL mailbox.
// The fix judges by mailbox, not outcome code: c1's re-addressed profile is
// skipped WITHOUT ever being imported here, and c2 — still in the
// projected mailbox — is tried and imported instead.
test('when the selected profile moves to a DIFFERENT mailbox before its write-time attempt, the fallback imports the ORIGINAL mailbox and the moved profile is never imported here', async () => {
  const state = {
    customers: [
      cust({ id: 'c1', email: 'moved@example.com', is_primary_profile: true, created_at: '2026-01-01', first_name: 'Primary' }),
      cust({ id: 'c2', email: 'moved@example.com', created_at: '2026-02-01', first_name: 'Secondary' }),
    ],
    subscribers: [],
    prefs: [],
  };
  const conn = makeConn(state);
  const rawImpl = conn.raw.getMockImplementation();
  let reads = 0;
  conn.raw = jest.fn(async (sql, bindings) => {
    // Projection processes c1 then c2 (canonical order): 2 reads each (peek
    // + FOR SHARE) = reads #1-4. c1's write-time attempt's OWN first read —
    // the fix's new pre-check peek — is #5: move c1 to a totally different
    // mailbox right there, simulating the race the finding describes.
    if (sql.includes('WHERE c.id = ?') && ++reads === 5) state.customers[0].email = 'elsewhere@example.com';
    return rawImpl(sql, bindings);
  });
  const write = await reconcileCustomers({ dryRun: false, conn });
  expect(write.imported).toBe(1);
  expect(write.excluded.no_longer_live).toBe(0);
  expect(write.excluded.duplicate_address).toBe(1); // from the projection, unaffected by the later mutation
  expect(state.subscribers).toHaveLength(1);
  // The ORIGINAL mailbox's fallback (c2) was imported — never c1's new address.
  expect(state.subscribers[0].email).toBe('moved@example.com');
  expect(state.subscribers[0].customer_id).toBe('c2');
});

// The same race, but the selected profile's address changes to a DIFFERENT
// SPELLING of the SAME mailbox (a Google dot/tag alias) — the mailbox key
// still matches, so the attempt itself settles it and no fallback is ever
// tried.
test('when the selected profile is re-addressed to an ALIAS SPELLING of the same mailbox, the attempt settles it without trying a fallback', async () => {
  const state = {
    customers: [
      cust({ id: 'c1', email: 'johndoe@gmail.com', is_primary_profile: true, created_at: '2026-01-01', first_name: 'Primary' }),
      cust({ id: 'c2', email: 'johndoe@gmail.com', created_at: '2026-02-01', first_name: 'Secondary' }),
    ],
    subscribers: [],
    prefs: [],
  };
  const conn = makeConn(state);
  const rawImpl = conn.raw.getMockImplementation();
  let reads = 0;
  conn.raw = jest.fn(async (sql, bindings) => {
    if (sql.includes('WHERE c.id = ?') && ++reads === 5) state.customers[0].email = 'j.o.h.n.d.o.e+work@gmail.com';
    return rawImpl(sql, bindings);
  });
  const write = await reconcileCustomers({ dryRun: false, conn });
  expect(write.imported).toBe(1);
  expect(write.excluded.no_longer_live).toBe(0);
  expect(state.subscribers).toHaveLength(1);
  // Settled by the FIRST attempt (c1, still the same mailbox) — never fell
  // through to c2.
  expect(state.subscribers[0].email).toBe('j.o.h.n.d.o.e+work@gmail.com');
  expect(state.subscribers[0].customer_id).toBe('c1');
});

// Codex P2 (:817) — "Recheck the expected mailbox inside the import
// transaction": the mutation lands strictly AFTER importAddressWithFallback's
// OWN pre-filter peek (read #5, which sees the ORIGINAL, still-matching
// mailbox and does not skip the attempt) but BEFORE decideAddress's own
// reads (#6 peek, #7 FOR SHARE fresh) — proving the SECOND, authoritative
// check (under the lock, via `expectedMailbox`) is what actually catches a
// mismatch the pre-filter alone missed.
test('when the selected profile moves to a DIFFERENT mailbox strictly AFTER the fallback loop\'s own pre-filter peek, the locked recheck still catches it and the fallback imports the ORIGINAL mailbox', async () => {
  const state = {
    customers: [
      cust({ id: 'c1', email: 'lockrace@example.com', is_primary_profile: true, created_at: '2026-01-01', first_name: 'Primary' }),
      cust({ id: 'c2', email: 'lockrace@example.com', created_at: '2026-02-01', first_name: 'Secondary' }),
    ],
    subscribers: [],
    prefs: [],
  };
  const conn = makeConn(state);
  const rawImpl = conn.raw.getMockImplementation();
  let reads = 0;
  conn.raw = jest.fn(async (sql, bindings) => {
    // Read #5 (the pre-filter peek) runs UNCHANGED — c1's mailbox still
    // matches there. Move it right after, at read #6 — decideAddress's OWN
    // first read for this attempt — so the pre-filter's own check could
    // never have caught it.
    if (sql.includes('WHERE c.id = ?') && ++reads === 6) state.customers[0].email = 'lockraceelsewhere@example.com';
    return rawImpl(sql, bindings);
  });
  const write = await reconcileCustomers({ dryRun: false, conn });
  expect(write.imported).toBe(1);
  expect(write.excluded.no_longer_live).toBe(0);
  expect(state.subscribers).toHaveLength(1);
  // c2's (original) mailbox — never c1's new address.
  expect(state.subscribers[0].email).toBe('lockrace@example.com');
  expect(state.subscribers[0].customer_id).toBe('c2');
});

test('the dry run keys duplicates by mailbox identity: equivalent Google spellings are projected once', async () => {
  const state = {
    customers: [cust({ id: 'c1', email: 'john.doe+work@gmail.com' }), cust({ id: 'c2', email: 'johndoe@gmail.com' })],
    subscribers: [],
    prefs: [],
  };
  const dry = await reconcileCustomers({ conn: makeConn(state) });
  expect(dry.importable).toBe(1);
  expect(dry.excluded.duplicate_address).toBe(1);
});

// Codex P2 (:673) — two live profiles sharing a Google mailbox under
// DIFFERENT spellings must resolve to the SAME canonical profile every run,
// never whichever spelling the (unordered) database scan happened to return
// first. fetchCandidateRows now orders candidates by the picker's own
// tie-break (is_primary_profile DESC NULLS LAST, created_at ASC, id ASC),
// so the canonical one is always iterated first and wins the mailbox-level
// dedup — proven here by listing the NON-canonical spelling FIRST in the
// fixture (insertion order alone would pick the wrong one) and asserting
// the canonical profile's name/city/email spelling is what's kept, on both
// the dry run and the write, and stably across repeated runs.
test('two live profiles sharing a Google mailbox under different spellings resolve to the SAME canonical profile, deterministically — never whichever spelling the scan returns first', async () => {
  const state = {
    customers: [
      // Listed FIRST (non-canonical): relying on scan/insertion order alone
      // would wrongly keep this one.
      cust({
        id: 'c1', email: 'john.doe+work@gmail.com', first_name: 'Alias', last_name: 'Spelling', city: 'Nowhere',
        created_at: '2026-01-01',
      }),
      // The picker's own pick: is_primary_profile wins the tie-break.
      cust({
        id: 'c2', email: 'johndoe@gmail.com', first_name: 'Canonical', last_name: 'Holder', city: 'Venice',
        is_primary_profile: true, created_at: '2026-02-01',
      }),
    ],
    subscribers: [],
    prefs: [],
  };
  const dry = await reconcileCustomers({ conn: makeConn(state) });
  expect(dry).toMatchObject({ importable: 1, byCity: [{ city: 'Venice', count: 1 }] });
  expect(dry.excluded.duplicate_address).toBe(1);

  const write = await reconcileCustomers({ dryRun: false, conn: makeConn(state) });
  expect(write.imported).toBe(1);
  expect(state.subscribers).toHaveLength(1);
  // The CANONICAL spelling was kept and inserted — never the alias's.
  expect(state.subscribers[0]).toMatchObject({
    email: 'johndoe@gmail.com', customer_id: 'c2', first_name: 'Canonical', last_name: 'Holder',
  });

  // Re-run against a fresh copy of the SAME fixture: the same profile wins
  // every time — deterministic, not a lucky draw on this one run's order.
  const rerunState = { customers: state.customers.map((c) => ({ ...c })), subscribers: [], prefs: [] };
  const again = await reconcileCustomers({ conn: makeConn(rerunState) });
  expect(again.byCity).toEqual([{ city: 'Venice', count: 1 }]);
});

test('a profile that joins the address after its comms locks were chosen forces a fresh attempt, and its opt-out is honoured', async () => {
  const state = { customers: [cust({ id: 'c1', email: 'a@example.com' })], subscribers: [], prefs: [] };
  const conn = makeConn(state);
  const rawImpl = conn.raw.getMockImplementation();
  let sharerReads = 0;
  conn.raw = jest.fn(async (sql, bindings) => {
    // The first decision's SECOND sharer read (after the email lock) finds
    // a newcomer that was never comms-locked — an opted-out one.
    if (sql.includes('AS profile_id') && ++sharerReads === 2) {
      state.customers.push(cust({ id: 'c2', email: 'a@example.com', pipeline_stage: 'new_lead' }));
      state.prefs.push({ customer_id: 'c2', marketing_offers: false });
    }
    return rawImpl(sql, bindings);
  });
  const dry = await reconcileCustomers({ conn });
  expect(dry.errors).toEqual([]);
  expect(dry.importable).toBe(0);
  expect(dry.excluded.marketing_opted_out).toBe(1);
  expect(conn.transaction).toHaveBeenCalledTimes(2); // rolled back and decided again, never classified on the stale set
});

test('two orphans resolving to one customer: the dry run projects ONE link, matching what the write applies', async () => {
  const state = {
    customers: [cust({ id: 'c1', email: 'orphan@e.com' })],
    subscribers: [
      { id: 's1', customer_id: null, email: 'orphan@e.com', status: 'active' },
      { id: 's2', customer_id: null, email: ' orphan@e.com ', status: 'active' }, // padded legacy twin row
    ],
    prefs: [],
  };
  const dry = await reconcileCustomers({ conn: makeConn(state) });
  expect(dry.orphanLinks).toBe(1);
  const write = await reconcileCustomers({ dryRun: false, conn: makeConn(state) });
  expect(write.orphanLinks).toBe(1);
  expect(state.subscribers.filter((s) => s.customer_id === 'c1')).toHaveLength(1);
});

// Codex #5165 (Gmail aliases): Google ignores local-part dots and '+tags'
// and googlemail.com is gmail.com, so an unsubscribe, suppression, or opt-out
// recorded under ANY spelling of one Google mailbox excludes every other
// spelling — in both directions. Non-Google addresses keep exact matching.
test.each([
  ['an unsubscribed alias row blocks the plain address', 'john@gmail.com', 'j.o.h.n+news@gmail.com'],
  ['an unsubscribed plain row blocks a dotted/tagged googlemail alias', 'J.O.H.N+promo@googlemail.com', 'john@gmail.com'],
])('%s', async (_label, customerEmail, unsubscribedEmail) => {
  const state = {
    customers: [cust({ email: customerEmail })],
    subscribers: [{ id: 's1', customer_id: null, email: unsubscribedEmail, status: 'unsubscribed' }],
    prefs: [],
  };
  const dry = await reconcileCustomers({ conn: makeConn(state) });
  expect(dry.importable).toBe(0);
  expect(dry.excluded.previously_unsubscribed).toBe(1);
  const write = await reconcileCustomers({ dryRun: false, conn: makeConn(state) });
  expect(write.imported).toBe(0);
  expect(state.subscribers).toHaveLength(1);
  expect(state.subscribers[0].status).toBe('unsubscribed'); // never resubscribed
});

test('a suppression recorded under a Google alias suppresses the address (activeSuppressionsFor still decides which rows count)', async () => {
  const state = { customers: [cust({ email: 'johndoe@gmail.com' })], subscribers: [], prefs: [], suppressions: ['john.doe+x@gmail.com'] };
  activeSuppressionsFor.mockImplementation(async (_t, email) => (email === 'john.doe+x@gmail.com' ? [{ id: 'sup1' }] : []));
  const dry = await reconcileCustomers({ conn: makeConn(state) });
  expect(dry.excluded.suppressed).toBe(1);
  expect(activeSuppressionsFor).toHaveBeenCalledWith(null, 'john.doe+x@gmail.com', 'marketing_newsletter', expect.anything());
  const write = await reconcileCustomers({ dryRun: false, conn: makeConn(state) });
  expect(write.imported).toBe(0);
  expect(state.subscribers).toHaveLength(0);
});

test('an explicit opt-out on a profile holding a Google alias of the address excludes it', async () => {
  const state = {
    customers: [cust({ id: 'c1', email: 'johndoe@gmail.com' }), cust({ id: 'c2', email: 'John.Doe+work@gmail.com', pipeline_stage: 'new_lead' })],
    subscribers: [],
    prefs: [{ customer_id: 'c2', marketing_offers: false }],
  };
  const dry = await reconcileCustomers({ conn: makeConn(state) });
  expect(dry.excluded.marketing_opted_out).toBe(1);
  const write = await reconcileCustomers({ dryRun: false, conn: makeConn(state) });
  expect(write.imported).toBe(0);
});

test('non-Google addresses keep exact matching: an unsubscribed john+news@example.com does not block john@example.com', async () => {
  const state = {
    customers: [cust({ email: 'john@example.com' })],
    subscribers: [{ id: 's1', customer_id: null, email: 'john+news@example.com', status: 'unsubscribed' }],
    prefs: [],
  };
  const write = await reconcileCustomers({ dryRun: false, conn: makeConn(state) });
  expect(write.imported).toBe(1);
});

// Codex #5165 (orphan zone): the fill sweep joins through customer_id, so a
// just-linked orphan was never in it — the link now runs the same locked
// zone fill, and the dry run projects that fill too.
test('a linked orphan gets its zone in the same run, and the dry run counts that fill', async () => {
  const state = {
    customers: [cust({ id: 'c1', email: 'orphan@e.com', city: 'Venice' })],
    subscribers: [{ id: 's1', customer_id: null, email: 'orphan@e.com', status: 'active', region_zone: null }],
    prefs: [],
  };
  const dry = await reconcileCustomers({ conn: makeConn(state) });
  expect(dry).toMatchObject({ orphanLinks: 1, zoneFills: 1 });
  const write = await reconcileCustomers({ dryRun: false, conn: makeConn(state) });
  expect(write).toMatchObject({ orphanLinks: 1, zoneFills: 1 });
  expect(state.subscribers[0]).toMatchObject({ customer_id: 'c1', region_zone: 'south_sarasota' });
});

test('an unrecognised subscriber status on the same mailbox fails closed (no CHECK constraint on status)', async () => {
  const state = {
    customers: [cust({ email: 'johndoe@gmail.com' })],
    subscribers: [{ id: 's1', customer_id: null, email: 'john.doe+x@gmail.com', status: 'bounced' }],
    prefs: [],
  };
  const dry = await reconcileCustomers({ conn: makeConn(state) });
  expect(dry.excluded.inactive_subscriber).toBe(1);
  const write = await reconcileCustomers({ dryRun: false, conn: makeConn(state) });
  expect(write.imported).toBe(0);
  expect(state.subscribers).toHaveLength(1);
});

// Codex P1 (:281) — "Distinguish a NULL subscriber status from an absent
// subscriber": existingAddressStatus used to return `status || null`,
// which reads a FOUND row whose own status is NULL or '' exactly like NO
// row at all — classifyAddress would then fall through every exclusion and
// let a second, active row into the SAME mailbox. Same fixture shape as
// the 'bounced' case above (a differently-spelled row on the mailbox), just
// with a falsy-but-real status.
test.each([[null], ['']])('an existing subscriber row with status %p is a REAL row, not "no row" — fails closed as inactive_subscriber', async (status) => {
  const state = {
    customers: [cust({ email: 'johndoe@gmail.com' })],
    subscribers: [{ id: 's1', customer_id: null, email: 'john.doe+x@gmail.com', status }],
    prefs: [],
  };
  const dry = await reconcileCustomers({ conn: makeConn(state) });
  expect(dry.excluded.inactive_subscriber).toBe(1);
  expect(dry.importable).toBe(0);
  const write = await reconcileCustomers({ dryRun: false, conn: makeConn(state) });
  expect(write.imported).toBe(0);
  expect(state.subscribers).toHaveLength(1); // no second row ever inserted for this mailbox
});
