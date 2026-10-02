/**
 * Synthetic fixture for the rate review ranking backend — a scripted knex
 * stand-in (no Postgres) plus a small fake book that covers every band and
 * the main exception rules. Every id, name and number here is invented.
 *
 * Shared by server/tests/rate-review.test.js and the PR-body sample runner.
 */
'use strict';

const CUSTOMER = (n) => `00000000-0000-4000-8000-00000000000${n}`;
const ESTIMATE = (n) => `10000000-0000-4000-8000-00000000000${n}`;
const TERM = (n) => `20000000-0000-4000-8000-00000000000${n}`;

// Chainable query stub. Every builder method records its args and returns
// the chain; awaiting resolves `rows(q)`, first() resolves `first(q)` (or
// `count(q)` once .count()/.sum()/.max() was called on the chain).
function chain({ rows = () => [], first = (q) => (rows(q) || [])[0] || null, count = () => ({ n: 0 }), onInsert = null, onDelete = null, onUpdate = null, updateRows = () => 1 } = {}) {
  const q = { calls: [], customerId: null, whereArgs: [], counted: false };
  const record = (name) => (...args) => {
    q.calls.push([name, args]);
    if (name === 'where' && args[0] && typeof args[0] === 'object' && args[0].customer_id) q.customerId = args[0].customer_id;
    if (name === 'where' && typeof args[0] === 'string' && /customer_id$/.test(args[0]) && args.length >= 2) q.customerId = args[args.length - 1];
    if (name === 'whereIn' && /customer_id$/.test(String(args[0]))) q.customerIds = args[1];
    if (name === 'where') q.whereArgs.push(args);
    if (['count', 'sum', 'max', 'countDistinct'].includes(name)) q.counted = true;
    if (name === 'insert') q.inserted = args[0];
    return q;
  };
  for (const name of ['where', 'whereIn', 'whereNot', 'whereNull', 'whereNotNull', 'whereRaw', 'whereNotIn', 'orWhere', 'orWhereRaw', 'orWhereIn', 'leftJoin', 'join',
    'select', 'orderBy', 'orderByRaw', 'groupBy', 'limit', 'count', 'sum', 'max', 'countDistinct', 'modify', 'forUpdate']) {
    q[name] = record(name);
  }
  q.insert = (...args) => { record('insert')(...args); if (onInsert) onInsert(args[0], q); return q; };
  q.onConflict = record('onConflict');
  q.merge = (...args) => { record('merge')(...args); return Promise.resolve(1); };
  q.ignore = record('ignore');
  q.returning = async () => [];
  q.delete = async (...args) => { record('delete')(...args); if (onDelete) onDelete(q); return 1; };
  q.update = async (...args) => { record('update')(...args); if (onUpdate) onUpdate(args[0], q); return updateRows(q); };
  q.first = async (...args) => { record('first')(...args); return q.counted ? count(q) : first(q); };
  q.then = (resolve, reject) => Promise.resolve().then(() => rows(q)).then(resolve, reject);
  q.catch = (fn) => Promise.resolve(rows(q)).catch(fn);
  return q;
}

// Build the scripted db for a scenario. `scenario` keys: config, planLines,
// customers, firstVisits, completedVisits, estimates, terms, ledger,
// priorReviews, latestSnapshots, sentRowCount, batchRow, settledDues,
// signals { [customerId]: { callbacks, cancellationCases, retentionOffers, holds } }.
function scriptedDb(scenario) {
  const writes = { snapshotInserts: [], snapshotDeletes: 0, batchUpserts: [], batchUpdates: [] };
  // every batch row carries its version (buildBatch stamps computed_at; the digest stamp is conditioned on it)
  const withVersion = (row) => ({ computed_at: new Date('2026-11-01T11:20:00Z'), ...row });
  const signalsFor = (id) => (scenario.signals && scenario.signals[id]) || {};
  const db = jest.fn((table) => {
    switch (table) {
      case 'rate_review_config':
        return chain({ first: () => { if (scenario.configError) throw scenario.configError; return scenario.config || null; } });
      case 'rate_review_snapshots':
      case 'rate_review_snapshots as r':
        return chain({
          // four reads share this table: prior reviews (customer_id, family_key),
          // latest snapshots (… status, review_date …), the owner-decision check
          // (status, flags — scripted as a QUEUE, one answer per read, so a test
          // can land a decision between two reads) and the batch page (r.*)
          rows: (q) => {
            const selected = q.calls.filter(([name]) => name === 'select').flatMap(([, args]) => args);
            if (selected.includes('review_date')) return scenario.latestSnapshots || [];
            if (selected.includes('flags')) return (scenario.ownerDecisionReads || []).shift() || [];
            return scenario.priorReviews || [];
          },
          // the sent / approved counts of the rebuild refusal — scripted as a QUEUE
          // (one answer per count) when a test lands an approval mid-build
          count: () => ({ n: scenario.refusalCounts && scenario.refusalCounts.length ? scenario.refusalCounts.shift() : (scenario.sentRowCount || 0) }),
          onInsert: (rows) => writes.snapshotInserts.push(...(Array.isArray(rows) ? rows : [rows])),
          onDelete: () => { writes.snapshotDeletes += 1; },
        });
      case 'rate_review_batches':
        return chain({
          rows: () => (scenario.batchRow ? [withVersion(scenario.batchRow)] : []),
          // the digest's whole-row read (`.first()`, no columns) sees the row the build just upserted
          // when the scenario pins none; the column reads (existing window, delivery marker) do not
          first: (q) => {
            if (scenario.batchRow) return withVersion(scenario.batchRow);
            const wholeRow = q.calls.some(([name, args]) => name === 'first' && args.length === 0);
            return wholeRow && writes.batchUpserts.length ? withVersion(writes.batchUpserts[writes.batchUpserts.length - 1]) : null;
          },
          onInsert: (row) => writes.batchUpserts.push(row),
          onUpdate: (patch) => writes.batchUpdates.push(patch),
          // the delivery stamp's row count (0 = the batch was rebuilt between composing and stamping)
          updateRows: () => (scenario.batchStampRows == null ? 1 : scenario.batchStampRows),
        });
      case 'customers':
        return chain({ rows: () => scenario.customers || [] });
      case 'estimates':
        return chain({ rows: () => scenario.estimates || [] });
      case 'customer_plan_rates':
        return chain({ rows: () => scenario.ledger || [] });
      case 'cancellation_cases':
        return chain({ rows: (q) => (signalsFor(q.customerId).cancellationCaseScopes || []).map((scope) => ({ scope })) });
      case 'retention_offers':
        return chain({ rows: (q) => (signalsFor(q.customerId).retentionOfferFamilies || []).map((family_key) => ({ family_key })) });
      case 'plan_holds':
        return chain({ rows: (q) => (signalsFor(q.customerId).holds || []).map((family_key) => ({ family_key })) });
      default:
        throw new Error(`rate-review fixture: unexpected table ${table}`);
    }
  });
  db.raw = jest.fn(async (sql, bindings = []) => {
    if (/WITH ov AS/.test(sql)) return { rows: scenario.planLines || [] };
    if (/AS first_visit/.test(sql)) return { rows: scenario.firstVisits || [] };
    if (/WITH te AS/.test(sql)) return { rows: scenario.completedVisits || [] };
    if (/is_callback = true/.test(sql)) return { rows: (signalsFor(bindings[0]).callbacks || []).map((line) => ({ line, n: 1 })) };
    if (/WaveGuard Monthly/.test(sql)) return { rows: Object.entries(scenario.settledDues || {}).map(([customer_id, settled]) => ({ customer_id, settled })) };
    if (/pg_advisory_xact_lock/.test(sql)) return { rows: [] };
    if (/^\?$/.test(sql.trim())) return bindings[0];
    if (/pg_advisory_xact_lock/.test(sql)) return { rows: [] }; // the per-batch rebuild/schedule lock (lockBatch)
    throw new Error(`rate-review fixture: unexpected raw SQL ${sql.slice(0, 60)}`);
  });
  db.transaction = jest.fn(async (fn) => fn(db));
  db.fn = { now: () => new Date() };
  db.writes = writes;
  return db;
}

// Live prepay terms per customer (annual-prepay-renewals.coveredTermsAsOf stand-in).
function coveredTermsStub(scenario) {
  return () => chain({ rows: (q) => (scenario.terms || []).filter((t) => !q.customerIds || q.customerIds.includes(t.customer_id)) });
}

// ── the fake book ───────────────────────────────────────────────────────

const NOW = new Date('2026-11-01T11:20:00Z'); // 2026-11-01 06:20 ET — the cron tick building the December batch

function planLine(customerId, familyKey, cadence, medianPrice, extra = {}) {
  return {
    customer_id: customerId, family_key: familyKey, cadence, open_visits: 3, next_visit: '2026-12-10',
    median_price: medianPrice, priced_visits: medianPrice ? 3 : 0, zero_priced_visits: 0, zero_with_base_visits: 0, prepay_linked: false, prepay_term_ids: [], catalog_vpy: null,
    source_estimate_ids: [], service_keys: [familyKey], account_lines: 1, ...extra,
  };
}

function customer(n, overrides = {}) {
  return {
    id: CUSTOMER(n), first_name: 'Fixture', last_name: `Account ${n}`, member_since: '2025-12-05', created_at: '2025-12-05T15:00:00Z',
    billing_mode: 'per_application', per_application_fee: null, monthly_rate: null, waveguard_tier: 'Bronze', waveguard_tier_source: null,
    property_type: 'single_family', tier_protected_until: null, city: 'Bradenton', property_sqft: null, ...overrides,
  };
}

// A completed visit: wall minutes via arrived_at → completed_at, the
// interaction flag, a paid invoice total, or a prepay term's settled share.
function visit(customerId, line, { minutes, interaction = null, revenue = null, date = '2026-06-15', prepay = null, composite = false } = {}) {
  const arrived = new Date(`${date}T14:00:00Z`);
  return {
    id: `${customerId}-${date}-${line}`, customer_id: customerId, scheduled_date: date, line, cadence: 'quarterly',
    service_time_minutes: null, actual_duration_minutes: null, actual_start_time: null, actual_end_time: null, check_in_time: null, check_out_time: null,
    arrived_at: arrived.toISOString(), completed_at: new Date(arrived.getTime() + minutes * 60000).toISOString(),
    // prepay: { id, settled, visits } — `settled` is the term's prepay invoice net of refunds (null = unpaid / reversed / no invoice)
    annual_prepay_term_id: prepay ? prepay.id : null, term_settled_amount: prepay && prepay.settled != null ? prepay.settled : null, term_visit_count: prepay ? prepay.visits : null,
    time_entry_minutes: null, time_entry_clock_in: null, time_entry_clock_out: null,
    service_record_started_at: null, service_record_ended_at: null, service_record_structured_notes: null,
    customer_interaction: interaction, paid_revenue: revenue,
    composite_visit: composite, // add-ons performed in the same stop (scheduled_service_addons)
  };
}

function facts(overrides = {}) {
  return {
    accountCurrent: true, openComplaint: false, openCallbackLanes: [], priorRetentionOfferAt: null, manualPriceOverrideAt: null,
    moneyFactsDegraded: false, termiteRental: false, multiProperty: false, prepay: false, ...overrides,
  };
}

// Engine stand-in: prices every replay at $117/application pest at the
// requested frequency (quarterly 4 / bimonthly 6 / monthly 12 visits) and
// $65/application lawn at the requested tier (standard 6 / enhanced 9 /
// premium 12), bronze tier unless `tier` is given.
// `tier: 'derive'` mimics the engine's own rule: the tier follows the count
// of qualifying services priced plus priorQualifyingServices (1 bronze, 2
// silver, 3 gold, 4+ platinum).
function fakePricingEngine({ tier = 'bronze' } = {}) {
  const PEST_VISITS = { quarterly: 4, bimonthly: 6, monthly: 12 };
  const LAWN_VISITS = { standard: 6, enhanced: 9, premium: 12 };
  const MOSQUITO_VISITS = { seasonal: 9, monthly: 12 };
  return {
    needsSync: () => false,
    syncConstantsFromDB: async () => true,
    generateEstimate: jest.fn((inputs) => {
      const pest = inputs.services && inputs.services.pest;
      const lawn = inputs.services && inputs.services.lawn;
      const mosquito = inputs.services && inputs.services.mosquito;
      const pestVisits = pest ? (PEST_VISITS[pest.frequency] || 4) : 0;
      const lawnVisits = lawn ? (LAWN_VISITS[lawn.tier] || 9) : 0;
      const mosquitoVisits = mosquito ? (MOSQUITO_VISITS[mosquito.tier] || 12) : 0;
      const count = [pest, lawn, mosquito].filter(Boolean).length + (Array.isArray(inputs.priorQualifyingServices) ? inputs.priorQualifyingServices.length : 0);
      const derived = count >= 4 ? 'platinum' : count === 3 ? 'gold' : count === 2 ? 'silver' : 'bronze';
      return {
        lineItems: [
          ...(pest ? [{ service: 'pest_control', annual: 117 * pestVisits, annualAfterDiscount: 117 * pestVisits, visitsPerYear: pestVisits }] : []),
          ...(lawn ? [{ service: 'lawn_care', annual: 65 * lawnVisits, annualAfterDiscount: 65 * lawnVisits, frequency: lawnVisits }] : []),
          ...(mosquito ? [{ service: 'mosquito', annual: 80 * mosquitoVisits, annualAfterDiscount: 80 * mosquitoVisits, visits: mosquitoVisits }] : []),
        ],
        waveGuard: { tier: tier === 'derive' ? derived : tier },
      };
    }),
  };
}

function estimate(n, customerId, { homeSqFt = 2100, services = { pest: { frequency: 'quarterly' } }, tier = 'Bronze', acceptedAt = '2025-12-05T16:00:00Z' } = {}) {
  return { id: ESTIMATE(n), customer_id: customerId, accepted_at: acceptedAt, waveguard_tier: tier, estimate_data: { inputs: { homeSqFt, services } } };
}

// The December-2026 batch fixture, built at the 2026-11-01 tick. Six lines
// have a December anniversary (accounts 1, 2, 3 portal-sold in Dec 2025 →
// exactly 12 months at their review date; 6, 7, 8 imported Dec 2024);
// accounts 4 (June 2026), 5 (May 2026), 9 (May 2025) and 10 (June 2025)
// fall outside the window and only join a year-long catch-up build, where
// 4 and 5 are under the 12-month lock. Quarterly pest mode of the book =
// $117 (accounts 4 and 5); every-6-weeks lawn mode = $61 (accounts 9, 10).
function decemberBook() {
  const pestHome = (id, m, rev, date) => visit(id, 'pest_control', { minutes: m, interaction: 'tech_home_spoke_with_them', revenue: rev, date });
  const pestAway = (id, m, rev, date) => visit(id, 'pest_control', { minutes: m, interaction: 'not_home_full_access', revenue: rev, date });
  const c = {
    belowList: customer(1, { member_since: '2025-01-10', last_name: 'Below List' }), // band D — $104 vs $117 list (11.1% under)
    atList: customer(2, { member_since: '2025-02-14', last_name: 'At List' }), // band B — $113 vs $117 (3.4% under)
    wellPriced: customer(3, { member_since: '2025-03-20', last_name: 'Well Priced' }), // band A — $125 vs $117
    offWindow: customer(4, { member_since: '2026-06-20', last_name: 'Off Window' }), // June anniversary → not in the batch
    locked: customer(5, { member_since: '2026-05-01', last_name: 'Locked', created_at: '2026-05-01T12:00:00Z' }), // 6 months in → tenure_under_lock
    prepaid: customer(6, { member_since: '2024-12-11', billing_mode: 'annual_prepay', last_name: 'Prepaid' }), // live term → prepay_mid_term
    perVisit: customer(7, { member_since: '2024-12-02', billing_mode: 'per_visit', last_name: 'Per Visit' }), // lane_cleanup
    lawnUnder: customer(8, { member_since: '2024-12-20', last_name: 'Lawn Under' }), // imported lawn line, no estimate → cadence mode $61, band C
    lawnAt1: customer(9, { member_since: '2025-05-09', last_name: 'Lawn At 1' }),
    lawnAt2: customer(10, { member_since: '2025-06-09', last_name: 'Lawn At 2' }),
  };
  const planLines = [
    planLine(c.belowList.id, 'pest_control', 'quarterly', 104, { source_estimate_ids: [ESTIMATE(1)] }),
    planLine(c.atList.id, 'pest_control', 'quarterly', 113, { source_estimate_ids: [ESTIMATE(2)] }),
    planLine(c.wellPriced.id, 'pest_control', 'quarterly', 125, { source_estimate_ids: [ESTIMATE(3)] }),
    planLine(c.offWindow.id, 'pest_control', 'quarterly', 117, { source_estimate_ids: [ESTIMATE(4)] }),
    planLine(c.locked.id, 'pest_control', 'quarterly', 117, { source_estimate_ids: [ESTIMATE(5)] }),
    planLine(c.prepaid.id, 'pest_control', 'quarterly', null, { prepay_linked: true, prepay_term_ids: [TERM(1)], priced_visits: 0 }),
    planLine(c.perVisit.id, 'pest_control', 'quarterly', 95),
    planLine(c.lawnUnder.id, 'lawn_care', 'every_6_weeks', 55),
    planLine(c.lawnAt1.id, 'lawn_care', 'every_6_weeks', 61),
    planLine(c.lawnAt2.id, 'lawn_care', 'every_6_weeks', 61),
  ];
  const firstVisits = [
    { customer_id: c.belowList.id, line: 'pest_control', first_visit: '2025-12-05', completed_visits: 4 },
    { customer_id: c.atList.id, line: 'pest_control', first_visit: '2025-12-12', completed_visits: 4 },
    { customer_id: c.wellPriced.id, line: 'pest_control', first_visit: '2025-12-19', completed_visits: 4 },
    { customer_id: c.offWindow.id, line: 'pest_control', first_visit: '2026-06-20', completed_visits: 1 },
    { customer_id: c.locked.id, line: 'pest_control', first_visit: '2026-05-03', completed_visits: 2 },
    { customer_id: c.prepaid.id, line: 'pest_control', first_visit: '2026-06-01', completed_visits: 2 },
    { customer_id: c.perVisit.id, line: 'pest_control', first_visit: '2026-05-10', completed_visits: 2 },
    { customer_id: c.lawnUnder.id, line: 'lawn_care', first_visit: '2026-05-20', completed_visits: 3 },
    { customer_id: c.lawnAt1.id, line: 'lawn_care', first_visit: '2026-05-21', completed_visits: 3 },
    { customer_id: c.lawnAt2.id, line: 'lawn_care', first_visit: '2026-05-22', completed_visits: 3 },
  ];
  const completedVisits = [
    // belowList: 2 home (55, 60) + 2 not-home (35, 38), $104 each
    pestHome(c.belowList.id, 55, 104, '2026-01-10'), pestHome(c.belowList.id, 60, 104, '2026-04-10'),
    pestAway(c.belowList.id, 35, 104, '2026-07-10'), pestAway(c.belowList.id, 38, 104, '2026-10-10'),
    // atList: 3 not-home visits (40, 42, 44) at $113 → rph from not-home only
    pestAway(c.atList.id, 40, 113, '2026-02-01'), pestAway(c.atList.id, 42, 113, '2026-05-01'), pestAway(c.atList.id, 44, 113, '2026-08-01'),
    pestHome(c.atList.id, 70, 113, '2026-10-20'),
    // wellPriced: 2 home (50, 58) + 1 not-home (40), $125 each
    pestHome(c.wellPriced.id, 50, 125, '2026-03-01'), pestHome(c.wellPriced.id, 58, 125, '2026-06-01'), pestAway(c.wellPriced.id, 40, 125, '2026-09-01'),
    // locked / perVisit / offWindow: a couple of visits each so the line medians have bodies
    pestHome(c.locked.id, 62, 117, '2026-08-01'), pestAway(c.locked.id, 36, 117, '2026-10-01'),
    pestHome(c.perVisit.id, 45, 95, '2026-07-01'), pestAway(c.perVisit.id, 33, 95, '2026-10-05'),
    pestHome(c.offWindow.id, 300, 117, '2026-06-20'), // > 240 minutes → unusable
    // lawn: home 50/52/48, not-home 38/39/40
    visit(c.lawnUnder.id, 'lawn_care', { minutes: 50, interaction: 'tech_home_spoke_with_them', revenue: 55, date: '2026-06-01' }),
    visit(c.lawnUnder.id, 'lawn_care', { minutes: 38, interaction: 'not_home_full_access', revenue: 55, date: '2026-07-15' }),
    visit(c.lawnUnder.id, 'lawn_care', { minutes: 39, interaction: null, revenue: 55, date: '2026-09-01' }),
    visit(c.lawnAt1.id, 'lawn_care', { minutes: 52, interaction: 'tech_home_spoke_with_them', revenue: 61, date: '2026-06-02' }),
    visit(c.lawnAt1.id, 'lawn_care', { minutes: 39, interaction: 'not_home_full_access', revenue: 61, date: '2026-07-16' }),
    visit(c.lawnAt2.id, 'lawn_care', { minutes: 48, interaction: 'tech_home_spoke_with_them', revenue: 61, date: '2026-06-03' }),
    visit(c.lawnAt2.id, 'lawn_care', { minutes: 40, interaction: 'not_home_full_access', revenue: 61, date: '2026-07-17' }),
  ];
  const estimates = [
    estimate(1, c.belowList.id, { acceptedAt: '2025-11-28T16:00:00Z' }),
    estimate(2, c.atList.id, { acceptedAt: '2025-12-01T16:00:00Z' }),
    estimate(3, c.wellPriced.id, { acceptedAt: '2025-12-10T16:00:00Z' }),
    estimate(4, c.offWindow.id, { acceptedAt: '2026-06-15T16:00:00Z' }),
    estimate(5, c.locked.id, { acceptedAt: '2026-04-28T16:00:00Z' }),
  ];
  const terms = [
    { id: TERM(1), customer_id: c.prepaid.id, prepay_amount: 404, coverage_visit_count: 4, coverage_service_type: 'Pest Control', coverage_cadence: 'quarterly', term_start: '2026-05-15', term_end: '2027-05-14', status: 'active', monthly_rate: 33.67 },
  ];
  const factsByCustomer = Object.fromEntries(Object.values(c).map((cust) => [cust.id, facts()]));
  return { customers: c, planLines, customerRows: Object.values(c), firstVisits, completedVisits, estimates, terms, factsByCustomer };
}

module.exports = { CUSTOMER, ESTIMATE, TERM, NOW, chain, scriptedDb, coveredTermsStub, planLine, customer, visit, facts, estimate, fakePricingEngine, decemberBook };
