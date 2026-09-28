// "Your upcoming visits" card (owner-approved 2026-09-27,
// GATE_REPORT_UPCOMING_VISITS): buildReportV1Data surfaces ALL of the
// customer's upcoming scheduled visits across every program, for THIS
// report's property, for the next 90 days, capped at 6, as
// upcomingVisitsCard.visits[]: { serviceType, scheduledDate, windowStart }.
// Distinct from nextAppointment (report's own service line only, unchanged).
// Live-view only; stripped from pdf/static by stripLiveOnlyScheduleFields.

const { buildReportV1Data, stripLiveOnlyScheduleFields } = require('../services/service-report/report-data');

// Relative to the real clock (the implementation's 90-day window is
// Date.now()-based, not injectable) — never a hardcoded calendar date, which
// ages past "today" the moment the test suite outlives it. '2999-*' is used
// instead wherever a date only needs to be UNAMBIGUOUSLY beyond the 90-day
// window (same convention report-next-appointment.test.js uses).
function todayPlus(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

// Fake knex supporting the chain the upcoming-visits lookup uses, extending
// report-next-appointment.test.js's pattern with '<=' (the 90-day cutoff)
// and object-criteria where() on customer_properties / customers.
function makeKnex(fixtures) {
  const knex = (table) => {
    let rows = [...(fixtures[table] || [])];
    const sortKeys = [];
    // limit/offset are applied lazily at materialization (real SQL/knex
    // semantics — LIMIT/OFFSET apply together regardless which is called
    // first in the chain), not as an immediate `rows` mutation like the
    // filters above: the upcoming-visits pagination fix calls
    // .limit(PAGE_SIZE).offset(page * PAGE_SIZE), and slicing `rows`
    // eagerly in call order would apply the offset WITHIN an
    // already-limited slice instead of against the full sorted set.
    let limitN = null;
    let offsetN = 0;
    const materialize = () => {
      let out = rows;
      if (offsetN) out = out.slice(offsetN);
      if (limitN != null) out = out.slice(0, limitN);
      return out;
    };
    const query = {
      where(criteria, value) {
        if (criteria && typeof criteria === 'object') {
          rows = rows.filter((row) => Object.entries(criteria)
            .every(([key, val]) => row[key] === val));
        } else if (typeof criteria === 'string' && arguments.length === 2) {
          rows = rows.filter((row) => row[criteria] === value);
        }
        return query;
      },
      andWhere(column, op, value) {
        if (op === '>=') rows = rows.filter((row) => String(row[column]) >= String(value));
        if (op === '<=') rows = rows.filter((row) => String(row[column]) <= String(value));
        if (op === '<') rows = rows.filter((row) => String(row[column]) < String(value));
        if (op === '>') rows = rows.filter((row) => String(row[column]) > String(value));
        return query;
      },
      whereIn(column, values) {
        rows = rows.filter((row) => values.includes(row[column]));
        return query;
      },
      whereNot(column, value) {
        rows = rows.filter((row) => row[column] !== value);
        return query;
      },
      whereRaw(sql, bindings) {
        const m = /lower\((\w+)\)\s*=\s*lower\(\?\)/.exec(String(sql));
        if (m) {
          const wanted = String(bindings?.[0] ?? '').toLowerCase();
          rows = rows.filter((row) => String(row[m[1]] || '').toLowerCase() === wanted);
        }
        return query;
      },
      modify(fn) { fn(query); return query; },
      limit(n) { limitN = n; return query; },
      offset(n) { offsetN = n; return query; },
      orderBy(column) {
        sortKeys.push(column);
        rows = [...rows].sort((a, b) => {
          for (const key of sortKeys) {
            const cmp = String(a[key] || '').localeCompare(String(b[key] || ''));
            if (cmp !== 0) return cmp;
          }
          return 0;
        });
        return query;
      },
      leftJoin: () => query,
      select: () => Promise.resolve(materialize()),
      first: () => Promise.resolve(materialize()[0] || null),
      catch: () => Promise.resolve(materialize()),
      then: (resolve) => Promise.resolve(materialize()).then(resolve),
    };
    return query;
  };
  knex.schema = { hasTable: async () => true };
  return knex;
}

// Wraps makeKnex so the ONE lookup that resolves THIS report's own linked
// scheduled_services row (`.where({ id: failingId })`, unique to that
// query — the candidate-visits scan always filters by `customer_id`
// instead) rejects, simulating a transient read failure rather than a
// genuinely missing/deleted row. Every other query on every other table
// (including other `scheduled_services` reads) passes through unchanged.
function makeKnexWithFailingReportLookup(fixtures, failingId) {
  const base = makeKnex(fixtures);
  return (table) => {
    const real = base(table);
    if (table !== 'scheduled_services') return real;
    let targetsFailingRow = false;
    const wrapped = {
      ...real,
      where(criteria, value) {
        if (criteria && typeof criteria === 'object' && Object.keys(criteria).length === 1 && criteria.id === failingId) {
          targetsFailingRow = true;
          return wrapped;
        }
        real.where(criteria, value);
        return wrapped;
      },
      first(...args) {
        if (targetsFailingRow) return Promise.reject(new Error('simulated transient read failure'));
        return real.first(...args);
      },
    };
    return wrapped;
  };
}

const BASE_SERVICE = {
  id: 'service-upcoming',
  scheduled_service_id: 'scheduled-current',
  customer_id: 'customer-1',
  service_line: 'pest',
  service_type: 'Quarterly Pest Control Service',
  service_date: '2026-05-16',
  first_name: 'Van',
  last_name: 'Lee',
  areas_serviced: JSON.stringify(['Perimeter']),
  structured_notes: '{}',
  service_data: '{}',
  pressure_index: 0,
  // Already-COALESCEd mirror address, as the reports-public.js SELECT
  // resolves it — matches the customers row below for the unlinked-report
  // fallback tests.
  address_line1: '100 Sample Trail',
  city: 'Bradenton',
  zip: '34211',
};

const BASE_FIXTURES = {
  service_products: [],
  property_geometries: [],
  property_zones: [],
  service_findings: [],
  service_photos: [],
  customers: [{ id: 'customer-1', address_line1: '100 Sample Trail', address_line2: null, city: 'Bradenton', zip: '34211' }],
  customer_properties: [],
};

const LIVE = { mode: 'live' };

afterEach(() => { delete process.env.GATE_REPORT_UPCOMING_VISITS; });

// P0 fix (codex round-2): the KEY itself, not just its value, must be
// absent while the gate is dark — a null-valued key still changes every
// live payload's shape while GATE_REPORT_UPCOMING_VISITS is unset,
// contradicting the documented "gate off: the field is absent" contract.
test('gate off: upcomingVisitsCard KEY is absent from the payload entirely, even with matching upcoming visits', async () => {
  const knex = makeKnex({
    ...BASE_FIXTURES,
    scheduled_services: [
      { id: 'scheduled-current', customer_id: 'customer-1', scheduled_date: '2026-05-16', status: 'completed', service_type: 'Quarterly Pest Control Service' },
      { id: 'scheduled-lawn', customer_id: 'customer-1', scheduled_date: todayPlus(5), status: 'confirmed', service_type: 'Lawn Care Treatment', window_start: '09:00:00' },
    ],
  });
  const data = await buildReportV1Data(BASE_SERVICE, 'token-off', knex, LIVE);
  expect(data).not.toHaveProperty('upcomingVisitsCard');
});

test('gate on but not live mode: upcomingVisitsCard stays null (pdf/static builds)', async () => {
  process.env.GATE_REPORT_UPCOMING_VISITS = 'true';
  const knex = makeKnex({
    ...BASE_FIXTURES,
    scheduled_services: [
      { id: 'scheduled-current', customer_id: 'customer-1', scheduled_date: '2026-05-16', status: 'completed', service_type: 'Quarterly Pest Control Service' },
      { id: 'scheduled-lawn', customer_id: 'customer-1', scheduled_date: todayPlus(5), status: 'confirmed', service_type: 'Lawn Care Treatment', window_start: '09:00:00' },
    ],
  });
  const data = await buildReportV1Data(BASE_SERVICE, 'token-static', knex, { mode: 'static' });
  expect(data.upcomingVisitsCard).toBeNull();
});

test('gated + live: lists multi-program upcoming visits (pest, lawn, termite) for the unlinked report\'s mirror property, sorted, excluding cancelled/completed/rescheduled', async () => {
  process.env.GATE_REPORT_UPCOMING_VISITS = 'true';
  const knex = makeKnex({
    ...BASE_FIXTURES,
    scheduled_services: [
      { id: 'scheduled-current', customer_id: 'customer-1', scheduled_date: '2026-05-16', status: 'completed', service_type: 'Quarterly Pest Control Service' },
      { id: 'scheduled-cancelled', customer_id: 'customer-1', scheduled_date: todayPlus(3), status: 'cancelled', service_type: 'Mosquito Service', window_start: '09:00:00' },
      { id: 'scheduled-lawn', customer_id: 'customer-1', scheduled_date: todayPlus(5), status: 'confirmed', service_type: 'Lawn Care Treatment', window_start: '08:00:00' },
      { id: 'scheduled-termite', customer_id: 'customer-1', scheduled_date: todayPlus(10), status: 'pending', service_type: 'Termite Bait Station Service', window_start: '10:00:00' },
      { id: 'scheduled-pest', customer_id: 'customer-1', scheduled_date: todayPlus(30), status: 'confirmed', service_type: 'Quarterly Pest Control Service', window_start: '09:00:00' },
      // rescheduled phantom placeholder — never disclosed
      { id: 'scheduled-phantom', customer_id: 'customer-1', scheduled_date: todayPlus(1), status: 'rescheduled', service_type: 'Should never appear', window_start: '07:00:00' },
    ],
  });

  const data = await buildReportV1Data(BASE_SERVICE, 'token-multi', knex, LIVE);

  expect(data.upcomingVisitsCard.visits.map((v) => v.serviceType)).toEqual([
    'Lawn Care Treatment',
    'Termite Bait Station Service',
    'Quarterly Pest Control Service',
  ]);
  expect(data.upcomingVisitsCard.visits[0]).toEqual({
    serviceType: 'Lawn Care Treatment',
    scheduledDate: todayPlus(5),
    windowStart: '08:00:00',
  });
});

test('excludes visits more than 90 days out', async () => {
  process.env.GATE_REPORT_UPCOMING_VISITS = 'true';
  const knex = makeKnex({
    ...BASE_FIXTURES,
    scheduled_services: [
      { id: 'scheduled-far', customer_id: 'customer-1', scheduled_date: '2999-01-01', status: 'confirmed', service_type: 'Lawn Care Treatment', window_start: '09:00:00' },
    ],
  });
  const data = await buildReportV1Data(BASE_SERVICE, 'token-far', knex, LIVE);
  expect(data.upcomingVisitsCard).toBeNull();
});

test('caps at 6 visits', async () => {
  process.env.GATE_REPORT_UPCOMING_VISITS = 'true';
  const rows = Array.from({ length: 8 }, (_, i) => ({
    id: `scheduled-${i}`,
    customer_id: 'customer-1',
    scheduled_date: todayPlus(2 + i),
    status: 'confirmed',
    service_type: `Visit ${i}`,
    window_start: '09:00:00',
  }));
  const knex = makeKnex({
    ...BASE_FIXTURES,
    scheduled_services: [
      // the report's own (unlinked, unstamped) row — must resolve so the
      // report's identity isn't mistaken for an unresolvable link.
      { id: 'scheduled-current', customer_id: 'customer-1', scheduled_date: '2026-05-16', status: 'completed', service_type: 'Quarterly Pest Control Service' },
      ...rows,
    ],
  });
  const data = await buildReportV1Data(BASE_SERVICE, 'token-cap', knex, LIVE);
  expect(data.upcomingVisitsCard.visits).toHaveLength(6);
  expect(data.upcomingVisitsCard.visits[0].serviceType).toBe('Visit 0');
});

// P2 fix (codex round-2): scheduled_date + window_start alone is not a
// TOTAL order — two rows tied on both give the paged LIMIT/OFFSET scan no
// stable ordering to page over. `id` breaks the tie. The fixture inserts
// 'scheduled-b' before 'scheduled-a' (same date/window) so this only
// passes when the query's own ORDER BY actually includes `id` — insertion
// order alone would keep b before a.
test('rows tied on scheduled_date + window_start still order deterministically, by id', async () => {
  process.env.GATE_REPORT_UPCOMING_VISITS = 'true';
  const knex = makeKnex({
    ...BASE_FIXTURES,
    scheduled_services: [
      { id: 'scheduled-current', customer_id: 'customer-1', scheduled_date: '2026-05-16', status: 'completed', service_type: 'Quarterly Pest Control Service' },
      { id: 'scheduled-b', customer_id: 'customer-1', scheduled_date: todayPlus(5), status: 'confirmed', service_type: 'Visit B', window_start: '09:00:00' },
      { id: 'scheduled-a', customer_id: 'customer-1', scheduled_date: todayPlus(5), status: 'confirmed', service_type: 'Visit A', window_start: '09:00:00' },
    ],
  });
  const data = await buildReportV1Data(BASE_SERVICE, 'token-tiebreak', knex, LIVE);
  expect(data.upcomingVisitsCard.visits.map((v) => v.serviceType)).toEqual(['Visit A', 'Visit B']);
});

describe('multi-property scoping', () => {
  const PROP_A = { id: 'prop-a', address_line1: '100 Sample Trail', address_line2: null, city: 'Bradenton', zip: '34211' };
  const PROP_B = { id: 'prop-b', address_line1: '20 Duplicate Way', address_line2: null, city: 'Nokomis', zip: '34275' };

  test('linked report: property_id match includes a same-property visit and excludes a different property\'s and a different customer\'s', async () => {
    process.env.GATE_REPORT_UPCOMING_VISITS = 'true';
    const knex = makeKnex({
      ...BASE_FIXTURES,
      customer_properties: [PROP_A, PROP_B],
      scheduled_services: [
        { id: 'scheduled-current', customer_id: 'customer-1', scheduled_date: '2026-05-16', status: 'completed', service_type: 'Quarterly Pest Control Service', property_id: 'prop-a' },
        // same property (prop-a) — included
        { id: 'scheduled-same-prop', customer_id: 'customer-1', scheduled_date: todayPlus(5), status: 'confirmed', service_type: 'Lawn Care Treatment', window_start: '08:00:00', property_id: 'prop-a' },
        // OTHER property on the SAME customer (prop-b, a rental) — excluded
        { id: 'scheduled-other-prop', customer_id: 'customer-1', scheduled_date: todayPlus(6), status: 'confirmed', service_type: 'Should never appear (other property)', window_start: '09:00:00', property_id: 'prop-b' },
        // OTHER CUSTOMER entirely, even same property id by coincidence — excluded (customer_id scoping)
        { id: 'scheduled-other-customer', customer_id: 'customer-2', scheduled_date: todayPlus(7), status: 'confirmed', service_type: 'Should never appear (other customer)', window_start: '09:00:00', property_id: 'prop-a' },
      ],
    });
    const data = await buildReportV1Data(
      { ...BASE_SERVICE, service_date: '2026-05-16' },
      'token-scope',
      knex,
      LIVE,
    );
    expect(data.upcomingVisitsCard.visits.map((v) => v.serviceType)).toEqual(['Lawn Care Treatment']);
  });

  // P1 fix (codex round-1): a candidate's immutable service_address_*
  // stamp must win over a matching property_id — stamps intentionally
  // survive a later property edit/merge, so a row whose property_id now
  // points at the report's property but whose stamp names a DIFFERENT
  // premises (the one actually serviced) must be excluded, not waved
  // through on the id alone.
  test('candidate shares the report\'s property_id but its stamp names a different premises → excluded (stamp wins over property_id)', async () => {
    process.env.GATE_REPORT_UPCOMING_VISITS = 'true';
    const knex = makeKnex({
      ...BASE_FIXTURES,
      customer_properties: [PROP_A, PROP_B],
      scheduled_services: [
        { id: 'scheduled-current', customer_id: 'customer-1', scheduled_date: '2026-05-16', status: 'completed', service_type: 'Quarterly Pest Control Service', property_id: 'prop-a' },
        // SAME property_id as the report (prop-a), but its own immutable
        // stamp names prop-b's address — the premises actually serviced
        // does not match the report's, so this must be excluded even
        // though property_id equality alone would say "match".
        {
          id: 'scheduled-stamp-mismatch',
          customer_id: 'customer-1',
          scheduled_date: todayPlus(5),
          status: 'confirmed',
          service_type: 'Should never appear (stamp names a different premises)',
          window_start: '09:00:00',
          property_id: 'prop-a',
          service_address_line1: PROP_B.address_line1,
          service_address_city: PROP_B.city,
          service_address_zip: PROP_B.zip,
        },
        // SAME property_id AND a stamp that matches the report's own
        // resolved address — included.
        {
          id: 'scheduled-stamp-match',
          customer_id: 'customer-1',
          scheduled_date: todayPlus(6),
          status: 'confirmed',
          service_type: 'Lawn Care Treatment',
          window_start: '08:00:00',
          property_id: 'prop-a',
          service_address_line1: PROP_A.address_line1,
          service_address_city: PROP_A.city,
          service_address_zip: PROP_A.zip,
        },
      ],
    });
    const data = await buildReportV1Data(
      { ...BASE_SERVICE, service_date: '2026-05-16' },
      'token-stamp-wins',
      knex,
      LIVE,
    );
    expect(data.upcomingVisitsCard.visits.map((v) => v.serviceType)).toEqual(['Lawn Care Treatment']);
  });

  // P1 fix (codex round-1, second finding on the same function): a shared
  // property_id must never stand in for an address match on its own — a
  // property record's address can change (an edit, or a merge) AFTER an
  // older report stamped its OLD address, so an unstamped candidate on
  // that SAME property_id must resolve through the property's CURRENT
  // address (propertyKeyById), not through id equality, which would wave
  // it through even though the two premises no longer agree.
  test('candidate shares the report\'s property_id, but that property\'s address has since changed — an unstamped candidate resolves through the CURRENT address and is excluded', async () => {
    process.env.GATE_REPORT_UPCOMING_VISITS = 'true';
    const knex = makeKnex({
      ...BASE_FIXTURES,
      // 'prop-a' has since been edited/merged onto a NEW address (prop-b's
      // address, reused here only as a convenient "some other address").
      // The report's own stamp still names the OLD address (A) — stamps
      // are immutable — but the property ROW itself now resolves to B.
      customer_properties: [{ id: 'prop-a', address_line1: PROP_B.address_line1, address_line2: null, city: PROP_B.city, zip: PROP_B.zip }],
      scheduled_services: [
        // report's own visit: stamped at the OLD address (A), linked to prop-a.
        {
          id: 'scheduled-current', customer_id: 'customer-1', scheduled_date: '2026-05-16', status: 'completed', service_type: 'Quarterly Pest Control Service',
          property_id: 'prop-a', service_address_line1: PROP_A.address_line1, service_address_city: PROP_A.city, service_address_zip: PROP_A.zip,
        },
        // SAME property_id, but UNSTAMPED — must resolve through prop-a's
        // CURRENT address (B), not through the id, and so must NOT match
        // the report's stamped A.
        {
          id: 'scheduled-unstamped-after-change', customer_id: 'customer-1', scheduled_date: todayPlus(5), status: 'confirmed',
          service_type: 'Should never appear (property now resolves to a different address)', window_start: '09:00:00', property_id: 'prop-a',
        },
      ],
    });
    const data = await buildReportV1Data(
      { ...BASE_SERVICE, service_date: '2026-05-16' },
      'token-property-address-changed',
      knex,
      LIVE,
    );
    expect(data.upcomingVisitsCard).toBeNull();
  });

  // Positive counterpart: same shared property_id, but the property's
  // address is UNCHANGED — the unstamped candidate's resolved address still
  // agrees with the report's, so it is included.
  test('candidate shares the report\'s property_id and that property\'s address is UNCHANGED — an unstamped candidate is included', async () => {
    process.env.GATE_REPORT_UPCOMING_VISITS = 'true';
    const knex = makeKnex({
      ...BASE_FIXTURES,
      customer_properties: [PROP_A],
      scheduled_services: [
        {
          id: 'scheduled-current', customer_id: 'customer-1', scheduled_date: '2026-05-16', status: 'completed', service_type: 'Quarterly Pest Control Service',
          property_id: 'prop-a', service_address_line1: PROP_A.address_line1, service_address_city: PROP_A.city, service_address_zip: PROP_A.zip,
        },
        {
          id: 'scheduled-unstamped-unchanged', customer_id: 'customer-1', scheduled_date: todayPlus(5), status: 'confirmed',
          service_type: 'Lawn Care Treatment', window_start: '08:00:00', property_id: 'prop-a',
        },
      ],
    });
    const data = await buildReportV1Data(
      { ...BASE_SERVICE, service_date: '2026-05-16' },
      'token-property-address-unchanged',
      knex,
      LIVE,
    );
    expect(data.upcomingVisitsCard.visits.map((v) => v.serviceType)).toEqual(['Lawn Care Treatment']);
  });

  // P2 fix (codex round-1): the visit cap must apply AFTER property
  // scoping, not before it. Property scoping runs in JS, so a flat
  // LIMIT ahead of it can truncate the candidate set before this
  // property's own visits are ever reached. Built with >PAGE_SIZE (60)
  // other-property rows dated earlier, forcing this property's matches
  // into a later page — a bug that applies the cap before scoping finds
  // zero visits here; the fix's pagination still finds them.
  test('a multi-property customer with >60 OTHER-property visits still surfaces this property\'s own visits (cap applies after scoping, not before)', async () => {
    process.env.GATE_REPORT_UPCOMING_VISITS = 'true';
    const otherPropertyRows = Array.from({ length: 65 }, (_, i) => ({
      id: `scheduled-other-${i}`,
      customer_id: 'customer-1',
      scheduled_date: todayPlus(2 + i),
      status: 'confirmed',
      service_type: `Other property visit ${i}`,
      window_start: '09:00:00',
      property_id: 'prop-b',
    }));
    const thisPropertyRows = [
      { id: 'scheduled-this-1', customer_id: 'customer-1', scheduled_date: todayPlus(70), status: 'confirmed', service_type: 'Lawn Care Treatment', window_start: '08:00:00', property_id: 'prop-a' },
      { id: 'scheduled-this-2', customer_id: 'customer-1', scheduled_date: todayPlus(71), status: 'confirmed', service_type: 'Termite Bait Station Service', window_start: '08:00:00', property_id: 'prop-a' },
      { id: 'scheduled-this-3', customer_id: 'customer-1', scheduled_date: todayPlus(72), status: 'confirmed', service_type: 'Quarterly Pest Control Service', window_start: '08:00:00', property_id: 'prop-a' },
    ];
    const knex = makeKnex({
      ...BASE_FIXTURES,
      customer_properties: [PROP_A, PROP_B],
      scheduled_services: [
        { id: 'scheduled-current', customer_id: 'customer-1', scheduled_date: '2026-05-16', status: 'completed', service_type: 'Quarterly Pest Control Service', property_id: 'prop-a' },
        ...otherPropertyRows,
        ...thisPropertyRows,
      ],
    });
    const data = await buildReportV1Data(
      { ...BASE_SERVICE, service_date: '2026-05-16' },
      'token-page-cap',
      knex,
      LIVE,
    );
    expect(data.upcomingVisitsCard.visits.map((v) => v.serviceType)).toEqual([
      'Lawn Care Treatment',
      'Termite Bait Station Service',
      'Quarterly Pest Control Service',
    ]);
  });

  test('linked report for a SECONDARY property (no stamp on the report row): an unstamped candidate falls back to the primary mirror, not the secondary property, and is excluded', async () => {
    process.env.GATE_REPORT_UPCOMING_VISITS = 'true';
    const knex = makeKnex({
      ...BASE_FIXTURES,
      customer_properties: [PROP_A, PROP_B],
      scheduled_services: [
        // the report's own visit is linked to the SECONDARY property (prop-b), no stamp text
        { id: 'scheduled-current', customer_id: 'customer-1', scheduled_date: '2026-05-16', status: 'completed', service_type: 'Pest Control at rental', property_id: 'prop-b' },
        // unstamped, unlinked candidate — COALESCEs to the customer mirror (prop-a's address) everywhere else, so it is NOT prop-b's visit
        { id: 'scheduled-unstamped', customer_id: 'customer-1', scheduled_date: todayPlus(5), status: 'confirmed', service_type: 'Should never appear (belongs to the primary, not this rental)', window_start: '09:00:00' },
        // a stamped visit at the SAME secondary address as the report — included
        { id: 'scheduled-same-secondary', customer_id: 'customer-1', scheduled_date: todayPlus(9), status: 'confirmed', service_type: 'Pest Control at rental follow-up', window_start: '10:00:00', service_address_line1: PROP_B.address_line1, service_address_city: PROP_B.city, service_address_zip: PROP_B.zip },
      ],
    });
    const data = await buildReportV1Data(
      { ...BASE_SERVICE, service_date: '2026-05-16' },
      'token-secondary',
      knex,
      LIVE,
    );
    expect(data.upcomingVisitsCard.visits.map((v) => v.serviceType)).toEqual(['Pest Control at rental follow-up']);
  });

  // P1 privacy fix (2026-09-28): a linked report whose property_id cannot
  // be RESOLVED (the customer_properties row is gone — deleted, or a bad
  // link) must fail closed and show NOTHING — never fall back to the
  // customer mirror, which names a different property for a multi-property
  // account. Only a report with NO property link at all (the ordinary
  // single-property case, covered by the next test) may use the mirror.
  test('linked report whose property_id does not resolve (unstamped, deleted property row) → no card at all, even with an otherwise-matching mirror candidate', async () => {
    process.env.GATE_REPORT_UPCOMING_VISITS = 'true';
    const knex = makeKnex({
      ...BASE_FIXTURES,
      // 'prop-gone' deliberately absent from customer_properties — the
      // report's OWN link is unresolvable.
      customer_properties: [],
      scheduled_services: [
        { id: 'scheduled-current', customer_id: 'customer-1', scheduled_date: '2026-05-16', status: 'completed', service_type: 'Pest Control', property_id: 'prop-gone' },
        // Unstamped, unlinked — would COALESCE to the customer mirror
        // everywhere else, and the mirror fixture address matches
        // BASE_SERVICE's. Must still be excluded: the report's own
        // property is unresolvable, so nothing may be shown.
        { id: 'scheduled-mirror-match', customer_id: 'customer-1', scheduled_date: todayPlus(5), status: 'confirmed', service_type: 'Should never appear (unresolvable linked property)', window_start: '09:00:00' },
      ],
    });
    const data = await buildReportV1Data(
      { ...BASE_SERVICE, service_date: '2026-05-16' },
      'token-unresolvable',
      knex,
      LIVE,
    );
    expect(data.upcomingVisitsCard).toBeNull();
  });

  // P1 fix (codex round-2): a transient error reading the report's OWN
  // linked scheduled_services row must fail closed exactly like a
  // genuinely unresolvable property_id above — NEVER fall back to
  // "genuinely unlinked" (which would use the customer mirror and could
  // expose a different, primary property's visits on this token).
  test('linked report whose OWN scheduled_services row read THROWS (transient failure) → card omitted, never falls back to the customer mirror', async () => {
    process.env.GATE_REPORT_UPCOMING_VISITS = 'true';
    const knex = makeKnexWithFailingReportLookup({
      ...BASE_FIXTURES,
      scheduled_services: [
        // Unstamped, unlinked — would COALESCE to the customer mirror
        // everywhere else, and the mirror fixture address matches
        // BASE_SERVICE's. Must still be excluded: the report's own link
        // read failed, so nothing may be shown.
        { id: 'scheduled-mirror-match', customer_id: 'customer-1', scheduled_date: todayPlus(5), status: 'confirmed', service_type: 'Should never appear (no fallback to mirror on a read failure)', window_start: '09:00:00' },
      ],
    }, BASE_SERVICE.scheduled_service_id);
    const data = await buildReportV1Data(
      { ...BASE_SERVICE, service_date: '2026-05-16' },
      'token-report-lookup-throws',
      knex,
      LIVE,
    );
    expect(data.upcomingVisitsCard).toBeNull();
  });

  test('unlinked report (no scheduled_service_id link at all): the mirror fallback still works — the ordinary single-property case', async () => {
    process.env.GATE_REPORT_UPCOMING_VISITS = 'true';
    const knex = makeKnex({
      ...BASE_FIXTURES,
      customer_properties: [],
      scheduled_services: [
        // unstamped, unlinked candidate — COALESCEs to the customer
        // mirror, which matches BASE_SERVICE's own (already-COALESCEd)
        // address — included.
        { id: 'scheduled-mirror', customer_id: 'customer-1', scheduled_date: todayPlus(5), status: 'confirmed', service_type: 'Lawn Care Treatment', window_start: '09:00:00' },
      ],
    });
    const data = await buildReportV1Data(
      // No scheduled_service_id at all — a genuinely unlinked/legacy report.
      { ...BASE_SERVICE, scheduled_service_id: null, service_date: '2026-05-16' },
      'token-unlinked-mirror',
      knex,
      LIVE,
    );
    expect(data.upcomingVisitsCard.visits.map((v) => v.serviceType)).toEqual(['Lawn Care Treatment']);
  });

  // P1 privacy fix (2026-09-28): every address-key comparison in the
  // upcoming-visits scoping must include the normalized unit (address_line2,
  // or a unit token embedded in line1) — dropping it let a condo/apartment
  // building's units compare as the SAME property, so one unit's report
  // could list another unit's visits. property_id equality (tested above)
  // stays the primary rule; this covers the address-key fallback path a
  // stamped-but-unlinked (or differently-linked) visit takes.
  describe('unit-aware address scoping (condo/apartment privacy)', () => {
    const UNIT_7 = { address_line1: '300 Condo Blvd', city: 'Sarasota', zip: '34236' };

    test('same street, DIFFERENT unit → excluded', async () => {
      process.env.GATE_REPORT_UPCOMING_VISITS = 'true';
      const knex = makeKnex({
        ...BASE_FIXTURES,
        scheduled_services: [
          { id: 'scheduled-current', customer_id: 'customer-1', scheduled_date: '2026-05-16', status: 'completed', service_type: 'Pest Control', ...UNIT_7, service_address_line1: UNIT_7.address_line1, service_address_line2: 'Unit 7', service_address_city: UNIT_7.city, service_address_zip: UNIT_7.zip },
          { id: 'scheduled-other-unit', customer_id: 'customer-1', scheduled_date: todayPlus(5), status: 'confirmed', service_type: 'Should never appear (different unit, same street)', window_start: '09:00:00', service_address_line1: UNIT_7.address_line1, service_address_line2: 'Unit 8', service_address_city: UNIT_7.city, service_address_zip: UNIT_7.zip },
        ],
      });
      const data = await buildReportV1Data({ ...BASE_SERVICE, service_date: '2026-05-16' }, 'token-unit-diff', knex, LIVE);
      expect(data.upcomingVisitsCard).toBeNull();
    });

    test('same street, one side unit-less → excluded (fail closed)', async () => {
      process.env.GATE_REPORT_UPCOMING_VISITS = 'true';
      const knex = makeKnex({
        ...BASE_FIXTURES,
        scheduled_services: [
          { id: 'scheduled-current', customer_id: 'customer-1', scheduled_date: '2026-05-16', status: 'completed', service_type: 'Pest Control', service_address_line1: UNIT_7.address_line1, service_address_line2: 'Unit 7', service_address_city: UNIT_7.city, service_address_zip: UNIT_7.zip },
          // same street stamp, but NO unit at all — a different, unprovable premises
          { id: 'scheduled-no-unit', customer_id: 'customer-1', scheduled_date: todayPlus(5), status: 'confirmed', service_type: 'Should never appear (no unit on this stamp)', window_start: '09:00:00', service_address_line1: UNIT_7.address_line1, service_address_city: UNIT_7.city, service_address_zip: UNIT_7.zip },
        ],
      });
      const data = await buildReportV1Data({ ...BASE_SERVICE, service_date: '2026-05-16' }, 'token-unit-oneless', knex, LIVE);
      expect(data.upcomingVisitsCard).toBeNull();
    });

    test('the report itself unit-less, candidate has a unit → also excluded (fail closed both directions)', async () => {
      process.env.GATE_REPORT_UPCOMING_VISITS = 'true';
      const knex = makeKnex({
        ...BASE_FIXTURES,
        scheduled_services: [
          { id: 'scheduled-current', customer_id: 'customer-1', scheduled_date: '2026-05-16', status: 'completed', service_type: 'Pest Control', service_address_line1: UNIT_7.address_line1, service_address_city: UNIT_7.city, service_address_zip: UNIT_7.zip },
          { id: 'scheduled-with-unit', customer_id: 'customer-1', scheduled_date: todayPlus(5), status: 'confirmed', service_type: 'Should never appear (report has no unit, candidate does)', window_start: '09:00:00', service_address_line1: UNIT_7.address_line1, service_address_line2: 'Unit 7', service_address_city: UNIT_7.city, service_address_zip: UNIT_7.zip },
        ],
      });
      const data = await buildReportV1Data({ ...BASE_SERVICE, service_date: '2026-05-16' }, 'token-unit-report-less', knex, LIVE);
      expect(data.upcomingVisitsCard).toBeNull();
    });

    test('same street + SAME unit → included', async () => {
      process.env.GATE_REPORT_UPCOMING_VISITS = 'true';
      const knex = makeKnex({
        ...BASE_FIXTURES,
        scheduled_services: [
          { id: 'scheduled-current', customer_id: 'customer-1', scheduled_date: '2026-05-16', status: 'completed', service_type: 'Pest Control', service_address_line1: UNIT_7.address_line1, service_address_line2: 'Unit 7', service_address_city: UNIT_7.city, service_address_zip: UNIT_7.zip },
          { id: 'scheduled-same-unit', customer_id: 'customer-1', scheduled_date: todayPlus(5), status: 'confirmed', service_type: 'Lawn Care Treatment', window_start: '09:00:00', service_address_line1: UNIT_7.address_line1, service_address_line2: 'Unit 7', service_address_city: UNIT_7.city, service_address_zip: UNIT_7.zip },
        ],
      });
      const data = await buildReportV1Data({ ...BASE_SERVICE, service_date: '2026-05-16' }, 'token-unit-same', knex, LIVE);
      expect(data.upcomingVisitsCard.visits.map((v) => v.serviceType)).toEqual(['Lawn Care Treatment']);
    });

    test('unit variants normalize equal: "Apt 4B" (report) vs "#4B" (candidate)', async () => {
      process.env.GATE_REPORT_UPCOMING_VISITS = 'true';
      const knex = makeKnex({
        ...BASE_FIXTURES,
        scheduled_services: [
          { id: 'scheduled-current', customer_id: 'customer-1', scheduled_date: '2026-05-16', status: 'completed', service_type: 'Pest Control', service_address_line1: UNIT_7.address_line1, service_address_line2: 'Apt 4B', service_address_city: UNIT_7.city, service_address_zip: UNIT_7.zip },
          { id: 'scheduled-hash-unit', customer_id: 'customer-1', scheduled_date: todayPlus(5), status: 'confirmed', service_type: 'Lawn Care Treatment', window_start: '09:00:00', service_address_line1: UNIT_7.address_line1, service_address_line2: '#4B', service_address_city: UNIT_7.city, service_address_zip: UNIT_7.zip },
        ],
      });
      const data = await buildReportV1Data({ ...BASE_SERVICE, service_date: '2026-05-16' }, 'token-unit-variant', knex, LIVE);
      expect(data.upcomingVisitsCard.visits.map((v) => v.serviceType)).toEqual(['Lawn Care Treatment']);
    });

    test('unit embedded in line1 normalizes the same as a split address_line2', async () => {
      process.env.GATE_REPORT_UPCOMING_VISITS = 'true';
      const knex = makeKnex({
        ...BASE_FIXTURES,
        scheduled_services: [
          { id: 'scheduled-current', customer_id: 'customer-1', scheduled_date: '2026-05-16', status: 'completed', service_type: 'Pest Control', service_address_line1: `${UNIT_7.address_line1} Unit 7`, service_address_city: UNIT_7.city, service_address_zip: UNIT_7.zip },
          { id: 'scheduled-split', customer_id: 'customer-1', scheduled_date: todayPlus(5), status: 'confirmed', service_type: 'Lawn Care Treatment', window_start: '09:00:00', service_address_line1: UNIT_7.address_line1, service_address_line2: 'Unit 7', service_address_city: UNIT_7.city, service_address_zip: UNIT_7.zip },
        ],
      });
      const data = await buildReportV1Data({ ...BASE_SERVICE, service_date: '2026-05-16' }, 'token-unit-embedded', knex, LIVE);
      expect(data.upcomingVisitsCard.visits.map((v) => v.serviceType)).toEqual(['Lawn Care Treatment']);
    });
  });

  // P1 fix (codex round-2): reuses estimate-property-linkage.js's
  // scopeKeyLacksLocality rule (the SAME standard cross-sell's own property
  // scoping already applies) — a street-only stamp with neither city nor
  // zip is UNPROVABLE, since two genuinely different premises sharing a
  // street/unit name collapse to the same opaque addressKey once locality
  // is stripped out of it. Either city or zip alone is enough evidence;
  // only BOTH missing fails closed.
  describe('locality guard (street-only stamps are unprovable)', () => {
    const NO_LOCALITY_STREET = '500 Anywhere Rd';

    test('same street, NEITHER side has city or zip → excluded (fail closed)', async () => {
      process.env.GATE_REPORT_UPCOMING_VISITS = 'true';
      const knex = makeKnex({
        ...BASE_FIXTURES,
        scheduled_services: [
          { id: 'scheduled-current', customer_id: 'customer-1', scheduled_date: '2026-05-16', status: 'completed', service_type: 'Pest Control', service_address_line1: NO_LOCALITY_STREET },
          { id: 'scheduled-no-locality', customer_id: 'customer-1', scheduled_date: todayPlus(5), status: 'confirmed', service_type: 'Should never appear (neither side has city or zip)', window_start: '09:00:00', service_address_line1: NO_LOCALITY_STREET },
        ],
      });
      const data = await buildReportV1Data({ ...BASE_SERVICE, service_date: '2026-05-16' }, 'token-locality-none', knex, LIVE);
      expect(data.upcomingVisitsCard).toBeNull();
    });

    test('same street + SAME zip (no city needed) → included', async () => {
      process.env.GATE_REPORT_UPCOMING_VISITS = 'true';
      const knex = makeKnex({
        ...BASE_FIXTURES,
        scheduled_services: [
          { id: 'scheduled-current', customer_id: 'customer-1', scheduled_date: '2026-05-16', status: 'completed', service_type: 'Pest Control', service_address_line1: NO_LOCALITY_STREET, service_address_zip: '34211' },
          { id: 'scheduled-with-zip', customer_id: 'customer-1', scheduled_date: todayPlus(5), status: 'confirmed', service_type: 'Lawn Care Treatment', window_start: '09:00:00', service_address_line1: NO_LOCALITY_STREET, service_address_zip: '34211' },
        ],
      });
      const data = await buildReportV1Data({ ...BASE_SERVICE, service_date: '2026-05-16' }, 'token-locality-zip', knex, LIVE);
      expect(data.upcomingVisitsCard.visits.map((v) => v.serviceType)).toEqual(['Lawn Care Treatment']);
    });
  });
});

test('stripLiveOnlyScheduleFields removes upcomingVisitsCard for pdf/static renders', () => {
  const data = { upcomingVisitsCard: { visits: [{ serviceType: 'Lawn Care Treatment', scheduledDate: todayPlus(5), windowStart: '08:00:00' }] }, other: 1 };
  stripLiveOnlyScheduleFields(data);
  expect(data).not.toHaveProperty('upcomingVisitsCard');
  expect(data.other).toBe(1);
});
