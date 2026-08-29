// Next-appointment payload on the customer service report (owner ask
// 2026-07-05): buildReportV1Data surfaces the customer's next upcoming
// scheduled_services row OF THE REPORT'S SERVICE LINE (a pest report shows
// the next pest visit — candidates are classified via detectServiceLine) as
// nextAppointment { serviceType, scheduledDate, windowStart } — window_end
// deliberately never rides the payload (the customer-facing arrival window is
// always window_start + 2 hours; window_end is the internal job block). The
// visit the report covers is excluded by id.

const { buildReportV1Data } = require('../services/service-report/report-data');

// Fake knex that supports the chain the next-appointment lookup uses
// (where/andWhere/whereIn/whereNot via modify/orderBy/first) on top of the
// object-criteria `where` the rest of the builder calls.
function makeKnex(fixtures) {
  const knex = (table) => {
    let rows = [...(fixtures[table] || [])];
    const sortKeys = [];
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
      // service-completion-profiles' canonical resolver matches catalog
      // names case-insensitively: `lower(<col>) = lower(?)`.
      whereRaw(sql, bindings) {
        const m = /lower\((\w+)\)\s*=\s*lower\(\?\)/.exec(String(sql));
        if (m) {
          const wanted = String(bindings?.[0] ?? '').toLowerCase();
          rows = rows.filter((row) => String(row[m[1]] || '').toLowerCase() === wanted);
        }
        return query;
      },
      modify(fn) { fn(query); return query; },
      limit: () => query,
      orderBy(column) {
        // real knex chains orderBy calls as primary-then-tiebreak keys; a
        // per-call re-sort would let the LAST key win instead
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
      select: () => query,
      first: () => Promise.resolve(rows[0] || null),
      catch: () => Promise.resolve(rows),
      then: (resolve) => Promise.resolve(rows).then(resolve),
    };
    return query;
  };
  // the profile resolver probes the table before reading it
  knex.schema = { hasTable: async () => true };
  return knex;
}

const BASE_SERVICE = {
  id: 'service-next-appt',
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
};

const BASE_FIXTURES = {
  service_products: [],
  property_geometries: [],
  property_zones: [],
  service_findings: [],
  service_photos: [],
};

test('payload surfaces the next same-line appointment without window_end', async () => {
  const farFuture = '2999-01-02';
  const knex = makeKnex({
    ...BASE_FIXTURES,
    scheduled_services: [
      // the visit this report covers — must never be reported as "next"
      { id: 'scheduled-current', customer_id: 'customer-1', scheduled_date: farFuture, status: 'pending', service_type: 'Quarterly Pest Control Service', window_start: '08:00:00', window_end: '12:00:00' },
      { id: 'scheduled-cancelled', customer_id: 'customer-1', scheduled_date: farFuture, status: 'cancelled', service_type: 'Mosquito Service', window_start: '09:00:00' },
      // earlier than the pest row, but a different service line — a pest
      // report must skip it (owner 2026-07-05: next visit of THIS line)
      { id: 'scheduled-lawn', customer_id: 'customer-1', scheduled_date: farFuture, status: 'confirmed', service_type: 'Lawn Care Treatment', window_start: '08:00:00' },
      // 'rescheduled' phantom placeholder holding the OLD date/window until
      // the office rebooks — must never publish as the next appointment
      { id: 'scheduled-phantom', customer_id: 'customer-1', scheduled_date: farFuture, status: 'rescheduled', service_type: 'Quarterly Pest Control Service', window_start: '07:00:00' },
      { id: 'scheduled-next', customer_id: 'customer-1', scheduled_date: '2999-01-03', status: 'confirmed', service_type: 'Quarterly Pest Control Service', window_start: '09:00:00', window_end: '13:00:00' },
    ],
  });

  const data = await buildReportV1Data(BASE_SERVICE, 'token-next-appt', knex);

  expect(data.nextAppointment).toEqual({
    serviceType: 'Quarterly Pest Control Service',
    scheduledDate: '2999-01-03',
    windowStart: '09:00:00',
  });
  expect(data.nextAppointment.windowEnd).toBeUndefined();
});

test('an in-progress (en_route) same-line visit publishes as the next appointment', async () => {
  const knex = makeKnex({
    ...BASE_FIXTURES,
    scheduled_services: [
      // the customer opens an older report while today's visit is in progress —
      // the active visit IS the next appointment (same disclosable statuses as
      // findReportFollowupAppointment)
      { id: 'scheduled-active', customer_id: 'customer-1', scheduled_date: '2999-01-01', status: 'en_route', service_type: 'Pest Control', window_start: '10:00:00' },
      { id: 'scheduled-later', customer_id: 'customer-1', scheduled_date: '2999-03-01', status: 'confirmed', service_type: 'Quarterly Pest Control Service', window_start: '09:00:00' },
    ],
  });

  const data = await buildReportV1Data(BASE_SERVICE, 'token-next-appt-active', knex);

  expect(data.nextAppointment).toEqual({
    serviceType: 'Pest Control',
    scheduledDate: '2999-01-01',
    windowStart: '10:00:00',
  });
});

// Owner 2026-08-27: with no same-line visit scheduled, the report falls
// back to the customer's next visit of ANY line — the label carries the
// service name, so a lawn visit on a pest report reads unambiguously.
test('payload nextAppointment falls back to the next visit of any line when nothing matches the service line', async () => {
  const knex = makeKnex({
    ...BASE_FIXTURES,
    scheduled_services: [
      { id: 'scheduled-past', customer_id: 'customer-1', scheduled_date: '2020-01-01', status: 'pending', service_type: 'Quarterly Pest Control Service' },
      { id: 'scheduled-done', customer_id: 'customer-1', scheduled_date: '2999-01-05', status: 'completed', service_type: 'Quarterly Pest Control Service' },
      // upcoming, open — but a lawn visit on a pest report: no match
      { id: 'scheduled-otherline', customer_id: 'customer-1', scheduled_date: '2999-01-06', status: 'confirmed', service_type: 'Lawn Care Treatment', window_start: '09:00:00' },
    ],
  });

  const data = await buildReportV1Data(BASE_SERVICE, 'token-next-appt-none', knex);

  expect(data.nextAppointment).toEqual({
    serviceType: 'Lawn Care Treatment',
    scheduledDate: '2999-01-06',
    windowStart: '09:00:00',
  });
});

test('payload nextAppointment is null when nothing at all is upcoming', async () => {
  const knex = makeKnex({
    ...BASE_FIXTURES,
    scheduled_services: [
      { id: 'scheduled-past', customer_id: 'customer-1', scheduled_date: '2020-01-01', status: 'pending', service_type: 'Quarterly Pest Control Service' },
      { id: 'scheduled-done', customer_id: 'customer-1', scheduled_date: '2999-01-05', status: 'completed', service_type: 'Quarterly Pest Control Service' },
    ],
  });

  const data = await buildReportV1Data(BASE_SERVICE, 'token-next-appt-empty', knex);

  expect(data.nextAppointment).toBeNull();
});

// Rodent reports under GATE_RODENT_REPORT_REFRESH widen the match to the
// whole rodent program (owner 2026-07-27: next service date if and only if
// it is rodent-related) — exclusion/sanitation/trapping names carry no
// rodent token and fall to the 'pest' default line, so the strict same-line
// match missed them. The widening is part of the gated refresh: with the
// gate dark, behavior is exactly the pre-refresh strict match (codex
// round-3 P2).
const RODENT_SERVICE = {
  ...BASE_SERVICE,
  id: 'service-rodent-next',
  service_line: 'rodent',
  service_type: 'Rodent Trapping Service',
};

afterEach(() => { delete process.env.GATE_RODENT_REPORT_REFRESH; });

const RODENT_PROGRAM_FIXTURES = {
  ...BASE_FIXTURES,
  // the catalog is the rodent evidence: a widened candidate must be a
  // services row with category 'rodent' — name shape alone is not enough
  // (codex round-4 P2)
  services: [
    { id: 'svc-exclusion', name: 'Exclusion Service', category: 'rodent' },
    { id: 'svc-sanitation', name: 'Sanitation & Cleanup', category: 'rodent' },
  ],
  scheduled_services: [
    // no rodent token, detects as pest — but it IS the rodent program
    { id: 'scheduled-exclusion', customer_id: 'customer-1', scheduled_date: '2999-01-03', status: 'confirmed', service_type: 'Exclusion Service', window_start: '08:00:00' },
    { id: 'scheduled-rodent-later', customer_id: 'customer-1', scheduled_date: '2999-02-01', status: 'confirmed', service_type: 'Rodent Trap Check', window_start: '09:00:00' },
  ],
};

test('gated: a rodent report discloses a rodent-adjacent visit (Exclusion Service) as next', async () => {
  process.env.GATE_RODENT_REPORT_REFRESH = 'true';
  const data = await buildReportV1Data(RODENT_SERVICE, 'token-rodent-excl', makeKnex(RODENT_PROGRAM_FIXTURES));

  expect(data.nextAppointment).toEqual({
    serviceType: 'Exclusion Service',
    scheduledDate: '2999-01-03',
    windowStart: '08:00:00',
  });
});

test('gated: a service_id-linked rodent-catalog visit is disclosed even under a customized label', async () => {
  process.env.GATE_RODENT_REPORT_REFRESH = 'true';
  const knex = makeKnex({
    ...BASE_FIXTURES,
    services: [{ id: 'svc-exclusion', name: 'Exclusion Service', category: 'rodent' }],
    scheduled_services: [
      // admin renamed the label; service_id still points at the rodent
      // catalog row — the link is the authority (codex round-5 P2)
      { id: 'scheduled-custom', customer_id: 'customer-1', scheduled_date: '2999-01-03', status: 'confirmed', service_type: 'Custom Attic Program', service_id: 'svc-exclusion', window_start: '08:00:00' },
    ],
  });

  const data = await buildReportV1Data(RODENT_SERVICE, 'token-rodent-linked', knex);

  expect(data.nextAppointment).toEqual({
    serviceType: 'Custom Attic Program',
    scheduledDate: '2999-01-03',
    windowStart: '08:00:00',
  });
});

test('gated: a rodent-sounding label linked to a NON-rodent catalog service is vetoed', async () => {
  process.env.GATE_RODENT_REPORT_REFRESH = 'true';
  const knex = makeKnex({
    ...BASE_FIXTURES,
    services: [
      { id: 'svc-lawn', name: 'Lawn Aeration', category: 'lawn_care' },
      { id: 'svc-trap-check', name: 'Rodent Trap Check', category: 'rodent' },
    ],
    scheduled_services: [
      // stale rodent label, but the catalog link says lawn — the link is
      // authoritative in BOTH directions (codex round-8 P2)
      { id: 'scheduled-stale-label', customer_id: 'customer-1', scheduled_date: '2999-01-03', status: 'confirmed', service_type: 'Rodent Check-Up', service_id: 'svc-lawn', window_start: '08:00:00' },
      { id: 'scheduled-real-rodent', customer_id: 'customer-1', scheduled_date: '2999-02-01', status: 'confirmed', service_type: 'Rodent Trap Check', service_id: 'svc-trap-check', window_start: '09:00:00' },
    ],
  });

  const data = await buildReportV1Data(RODENT_SERVICE, 'token-rodent-veto', knex);

  expect(data.nextAppointment).toEqual({
    serviceType: 'Rodent Trap Check',
    scheduledDate: '2999-02-01',
    windowStart: '09:00:00',
  });
});

test('gate dark: the strict same-line pick is unchanged (kill switch restores old behavior)', async () => {
  const data = await buildReportV1Data(RODENT_SERVICE, 'token-rodent-dark', makeKnex(RODENT_PROGRAM_FIXTURES));

  expect(data.nextAppointment).toEqual({
    serviceType: 'Rodent Trap Check',
    scheduledDate: '2999-02-01',
    windowStart: '09:00:00',
  });
});

test('a rodent report never claims trap-named visits of OTHER detectable lines or outside the rodent catalog', async () => {
  process.env.GATE_RODENT_REPORT_REFRESH = 'true';
  const knex = makeKnex({
    ...BASE_FIXTURES,
    // only Sanitation & Cleanup is a rodent-category catalog service here
    services: [
      { id: 'svc-sanitation', name: 'Sanitation & Cleanup', category: 'rodent' },
      { id: 'svc-wildlife', name: 'Wildlife Trapping', category: 'specialty' },
    ],
    scheduled_services: [
      // "trap" token but detectably mosquito — stays off the rodent report
      { id: 'scheduled-mosq-trap', customer_id: 'customer-1', scheduled_date: '2999-01-03', status: 'confirmed', service_type: 'Mosquito Trap Service', window_start: '08:00:00' },
      // trapping token, pest-default line, but wildlife work — the negative
      // guard AND the catalog keep non-rodent trapping out (codex P1)
      { id: 'scheduled-wildlife', customer_id: 'customer-1', scheduled_date: '2999-01-03', status: 'confirmed', service_type: 'Wildlife Trapping', window_start: '09:00:00' },
      { id: 'scheduled-fly-trap', customer_id: 'customer-1', scheduled_date: '2999-01-03', status: 'confirmed', service_type: 'Fly Trap Service', window_start: '11:00:00' },
      // adjacent-shaped name with NO rodent catalog row — name shape alone
      // is not rodent evidence (codex round-4 P2)
      { id: 'scheduled-postcon', customer_id: 'customer-1', scheduled_date: '2999-01-03', status: 'confirmed', service_type: 'Post-Construction Exclusion', window_start: '12:00:00' },
      // quarterly pest visit: not rodent-related, also skipped
      { id: 'scheduled-pest', customer_id: 'customer-1', scheduled_date: '2999-01-04', status: 'confirmed', service_type: 'Quarterly Pest Control Service', window_start: '08:00:00' },
      { id: 'scheduled-sanitation', customer_id: 'customer-1', scheduled_date: '2999-01-05', status: 'confirmed', service_type: 'Sanitation & Cleanup', window_start: '10:00:00' },
    ],
  });

  const data = await buildReportV1Data(RODENT_SERVICE, 'token-rodent-mosq', knex);

  expect(data.nextAppointment).toEqual({
    serviceType: 'Sanitation & Cleanup',
    scheduledDate: '2999-01-05',
    windowStart: '10:00:00',
  });
});

test('non-rodent reports keep the strict same-line pick first, then fall back to the next visit of any line', async () => {
  const knex = makeKnex({
    ...BASE_FIXTURES,
    scheduled_services: [
      // pest report + rodent-adjacent name that detects pest: still matches
      // (unchanged pest behavior), so assert with a LAWN report instead
      { id: 'scheduled-exclusion', customer_id: 'customer-1', scheduled_date: '2999-01-03', status: 'confirmed', service_type: 'Exclusion Service', window_start: '08:00:00' },
    ],
  });

  const data = await buildReportV1Data(
    { ...BASE_SERVICE, id: 'service-lawn-next', service_line: 'lawn', service_type: 'Lawn Care Treatment' },
    'token-lawn-none',
    knex,
  );

  // No lawn visit is scheduled, so the lawn report discloses the next
  // visit of any line (the rodent-adjacent exclusion visit), named.
  expect(data.nextAppointment).toEqual({
    serviceType: 'Exclusion Service',
    scheduledDate: '2999-01-03',
    windowStart: '08:00:00',
  });
});

// Termite bait-station reports (#3600): the dashboard's "next monitoring
// visit" is the first upcoming BAIT-STATION appointment, picked over the
// whole candidate window — not the collapsed same-line pick, which may be an
// earlier liquid/trench/inspection visit. Catalog completion profile
// (project_type termite_bait_station) is the authority via
// service_key_snapshot / service_id; name tokens judge only unlinked rows.
const TERMITE_SERVICE = {
  ...BASE_SERVICE,
  id: 'service-termite',
  service_line: 'termite',
  service_type: 'Termite Bait Station Service',
  service_data: JSON.stringify({ typedReportSnapshot: { type: 'termite_bait_station', values: { stations_checked: 12, termite_activity: 'None observed', bait_consumption: 'None — bait intact' } } }),
};
// The lookup runs only where its value can render: live view + gate on +
// bait-station typed visit (pdf/static strip the field; other termite
// forms never render it) — no catalog reads elsewhere.
const LIVE_V2 = { mode: 'live' };
const originalGate = process.env.TERMITE_REPORT_V2;
beforeEach(() => { process.env.TERMITE_REPORT_V2 = 'true'; });
afterAll(() => {
  if (originalGate === undefined) delete process.env.TERMITE_REPORT_V2;
  else process.env.TERMITE_REPORT_V2 = originalGate;
});

test('termite report: next monitoring visit skips an earlier liquid visit for the later bait-station row', async () => {
  const knex = makeKnex({
    ...BASE_FIXTURES,
    scheduled_services: [
      { id: 'scheduled-liquid', customer_id: 'customer-1', scheduled_date: '2999-01-03', status: 'confirmed', service_type: 'Termite Liquid Treatment', window_start: '09:00:00' },
      { id: 'scheduled-bait', customer_id: 'customer-1', scheduled_date: '2999-04-03', status: 'confirmed', service_type: 'Termite Bait Station Service', window_start: '10:00:00' },
    ],
  });
  const data = await buildReportV1Data(TERMITE_SERVICE, 'token-termite-next', knex, LIVE_V2);
  // same-line pick is unchanged (the liquid visit IS the next termite visit)
  expect(data.nextAppointment.serviceType).toBe('Termite Liquid Treatment');
  expect(data.termiteNextMonitoringVisit).toEqual({
    serviceType: 'Termite Bait Station Service',
    scheduledDate: '2999-04-03',
    windowStart: '10:00:00',
  });
});

test('upcoming installation and detection-only (termite_monitoring) appointments are skipped when searching for the next monitoring visit', async () => {
  const knex = makeKnex({
    ...BASE_FIXTURES,
    services: [
      { id: 'svc-install', service_key: 'termite_installation_setup', name: 'Termite Bait Station Installation', short_name: 'Install', category: 'termite' },
      { id: 'svc-detect', service_key: 'termite_monitoring', name: 'Termite Monitoring Service', short_name: 'Termite Monitor', category: 'termite' },
      { id: 'svc-monitor', service_key: 'termite_bait', name: 'Termite Bait Station Service', short_name: 'Bait', category: 'termite' },
    ],
    service_completion_profiles: [
      { service_key: 'termite_installation_setup', active: true, completion_mode: 'service_report', project_type: 'termite_bait_station' },
      { service_key: 'termite_monitoring', active: true, completion_mode: 'service_report', project_type: 'termite_bait_station' },
      { service_key: 'termite_bait', active: true, completion_mode: 'service_report', project_type: 'termite_bait_station' },
    ],
    scheduled_services: [
      { id: 'scheduled-install', customer_id: 'customer-1', scheduled_date: '2999-01-03', status: 'confirmed', service_type: 'Termite Bait Station Installation', window_start: '09:00:00', service_id: 'svc-install' },
      { id: 'scheduled-detect', customer_id: 'customer-1', scheduled_date: '2999-02-03', status: 'confirmed', service_type: 'Termite Monitoring Service', window_start: '09:00:00', service_id: 'svc-detect' },
      // unlinked legacy detection-only label — the name fallback rejects it too
      { id: 'scheduled-detect-legacy', customer_id: 'customer-1', scheduled_date: '2999-03-03', status: 'confirmed', service_type: 'Termite Monitoring Check', window_start: '09:00:00' },
      { id: 'scheduled-check', customer_id: 'customer-1', scheduled_date: '2999-04-03', status: 'confirmed', service_type: 'Termite Bait Station Service', window_start: '10:00:00', service_id: 'svc-monitor' },
    ],
  });
  const data = await buildReportV1Data(TERMITE_SERVICE, 'token-skip-install', knex, LIVE_V2);
  expect(data.termiteNextMonitoringVisit?.scheduledDate).toBe('2999-04-03');
});

test('termite report: the canonical completion-profile resolver is authoritative in both directions', async () => {
  const knex = makeKnex({
    ...BASE_FIXTURES,
    services: [
      { id: 'svc-custom', service_key: 'termite_bait_quarterly', name: 'Custom Termite Plan', short_name: 'Custom Plan', category: 'termite' },
      { id: 'svc-annual', service_key: 'termite_active_annual', name: 'Termite Active Annual Program', short_name: 'Bait Annual', category: 'termite' },
      { id: 'svc-liquid', service_key: 'termite_liquid', name: 'Termite Liquid Treatment', short_name: 'Liquid', category: 'termite' },
    ],
    service_completion_profiles: [
      { service_key: 'termite_bait_quarterly', active: true, completion_mode: 'service_report', project_type: 'termite_bait_station' },
      { service_key: 'termite_active_annual', active: true, completion_mode: 'service_report', project_type: 'termite_bait_station' },
      { service_key: 'termite_liquid', active: true, completion_mode: 'service_report', project_type: 'termite_liquid' },
    ],
    scheduled_services: [
      // bait-sounding label but linked (service_id) to the liquid profile → vetoed
      { id: 'scheduled-veto', customer_id: 'customer-1', scheduled_date: '2999-01-03', status: 'confirmed', service_type: 'Termite Station Follow-up', window_start: '09:00:00', service_id: 'svc-liquid' },
      // unlinked legacy row whose label is a unique catalog SHORT NAME with
      // no bait/station token — the canonical resolver's short-name path
      // finds the bait profile (an exact-key-plus-regex path missed it)
      { id: 'scheduled-annual', customer_id: 'customer-1', scheduled_date: '2999-02-03', status: 'confirmed', service_type: 'Bait Annual', window_start: '11:00:00' },
      // renamed plan via service_key_snapshot, later — never reached
      { id: 'scheduled-custom', customer_id: 'customer-1', scheduled_date: '2999-03-03', status: 'confirmed', service_type: 'Custom Termite Plan', window_start: '11:00:00', service_key_snapshot: 'termite_bait_quarterly' },
    ],
  });
  const data = await buildReportV1Data(TERMITE_SERVICE, 'token-termite-profile', knex, LIVE_V2);
  expect(data.termiteNextMonitoringVisit).toEqual({
    serviceType: 'Bait Annual',
    scheduledDate: '2999-02-03',
    windowStart: '11:00:00',
  });
});

test('a "Bait Annual" report (name detects as pest, snapshot is bait-station) still gets its next monitoring visit', async () => {
  const knex = makeKnex({
    ...BASE_FIXTURES,
    scheduled_services: [
      { id: 'scheduled-bait', customer_id: 'customer-1', scheduled_date: '2999-04-03', status: 'confirmed', service_type: 'Termite Bait Station Service', window_start: '10:00:00' },
    ],
  });
  const data = await buildReportV1Data({ ...TERMITE_SERVICE, service_line: null, service_type: 'Bait Annual' }, 'token-bait-annual', knex, LIVE_V2);
  expect(data.termiteNextMonitoringVisit?.scheduledDate).toBe('2999-04-03');
});

test('a combined visit whose bait-station snapshot is an auto_send COMPANION still gets its next monitoring visit', async () => {
  const knex = makeKnex({
    ...BASE_FIXTURES,
    scheduled_services: [
      { id: 'scheduled-bait', customer_id: 'customer-1', scheduled_date: '2999-04-03', status: 'confirmed', service_type: 'Termite Bait Station Service', window_start: '10:00:00' },
    ],
  });
  const combined = {
    ...BASE_SERVICE,
    id: 'service-combined',
    service_data: JSON.stringify({
      typedReportSnapshot: { type: 'cockroach', values: {} },
      companionReportSnapshots: [{ type: 'termite_bait_station', delivery: 'auto_send', values: { stations_checked: 12 } }],
    }),
  };
  const data = await buildReportV1Data(combined, 'token-combined', knex, LIVE_V2);
  expect(data.termiteNextMonitoringVisit?.scheduledDate).toBe('2999-04-03');
});

test('the live termite bond lookup runs for a combined visit whose bait snapshot is a companion (serviceLine stays pest)', async () => {
  const reads = [];
  const base = makeKnex({ ...BASE_FIXTURES, scheduled_services: [] });
  const spy = (table) => { reads.push(table); return base(table); };
  spy.schema = base.schema;
  const combined = {
    ...BASE_SERVICE,
    id: 'service-combined-bond',
    service_data: JSON.stringify({
      typedReportSnapshot: { type: 'cockroach', values: {} },
      companionReportSnapshots: [{ type: 'termite_bait_station', delivery: 'auto_send', values: { stations_checked: 12 } }],
    }),
  };
  // the bond lookup rides the portal card's gate (termite-bonds.js)
  const originalBondGate = process.env.GATE_PORTAL_TERMITE_BOND;
  process.env.GATE_PORTAL_TERMITE_BOND = 'true';
  try {
    await buildReportV1Data(combined, 'token-combined-bond', spy, LIVE_V2);
    expect(reads).toContain('termite_bonds');
    const pestOnlyReads = [];
    const spy2 = (table) => { pestOnlyReads.push(table); return base(table); };
    spy2.schema = base.schema;
    await buildReportV1Data(BASE_SERVICE, 'token-pest-bond', spy2, LIVE_V2);
    expect(pestOnlyReads).not.toContain('termite_bonds');
  } finally {
    if (originalBondGate === undefined) delete process.env.GATE_PORTAL_TERMITE_BOND;
    else process.env.GATE_PORTAL_TERMITE_BOND = originalBondGate;
  }
});

test('termiteBaitStage: the completion profile decides installation vs monitoring; name tokens only without a profile', async () => {
  const fixtures = {
    ...BASE_FIXTURES,
    services: [
      { id: 'svc-install', service_key: 'termite_installation_setup', name: 'Termite Bait Station Installation', short_name: 'Install', category: 'termite' },
      { id: 'svc-monitor', service_key: 'termite_bait', name: 'Termite Bait Station Service', short_name: 'Bait', category: 'termite' },
    ],
    service_completion_profiles: [
      { service_key: 'termite_installation_setup', active: true, completion_mode: 'service_report', project_type: 'termite_bait_station' },
      { service_key: 'termite_bait', active: true, completion_mode: 'service_report', project_type: 'termite_bait_station' },
    ],
  };
  const install = await buildReportV1Data(
    { ...TERMITE_SERVICE, scheduled_service_id: 'sched-install' },
    'token-stage-install',
    makeKnex({ ...fixtures, scheduled_services: [{ id: 'sched-install', customer_id: 'customer-1', service_id: 'svc-install', service_type: 'Termite Bait Station Installation', scheduled_date: '2026-08-27', status: 'completed' }] }),
    LIVE_V2,
  );
  expect(install.termiteBaitStage).toBe('installation');
  const monitor = await buildReportV1Data(
    { ...TERMITE_SERVICE, scheduled_service_id: 'sched-monitor' },
    'token-stage-monitor',
    makeKnex({ ...fixtures, scheduled_services: [{ id: 'sched-monitor', customer_id: 'customer-1', service_id: 'svc-monitor', service_type: 'Termite Bait Station Service', scheduled_date: '2026-08-27', status: 'completed' }] }),
    LIVE_V2,
  );
  expect(monitor.termiteBaitStage).toBe('monitoring');
  // the seeded detection-only program (no active bait) → 'detection'
  const detectFixtures = {
    ...fixtures,
    services: [...fixtures.services, { id: 'svc-detect', service_key: 'termite_monitoring', name: 'Termite Monitoring Service', short_name: 'Termite Monitor', category: 'termite' }],
    service_completion_profiles: [...fixtures.service_completion_profiles, { service_key: 'termite_monitoring', active: true, completion_mode: 'service_report', project_type: 'termite_bait_station' }],
  };
  const detect = await buildReportV1Data(
    { ...TERMITE_SERVICE, scheduled_service_id: 'sched-detect' },
    'token-stage-detect',
    makeKnex({ ...detectFixtures, scheduled_services: [{ id: 'sched-detect', customer_id: 'customer-1', service_id: 'svc-detect', service_type: 'Termite Monitoring Service', scheduled_date: '2026-08-27', status: 'completed' }] }),
    LIVE_V2,
  );
  expect(detect.termiteBaitStage).toBe('detection');
  // the completion-FROZEN key wins over a repointed live profile
  const frozen = await buildReportV1Data(
    {
      ...TERMITE_SERVICE,
      scheduled_service_id: 'sched-monitor',
      service_data: JSON.stringify({ completedServiceKey: 'termite_installation_setup', typedReportSnapshot: { type: 'termite_bait_station', values: { stations_checked: 12 } } }),
    },
    'token-stage-frozen',
    makeKnex({ ...fixtures, scheduled_services: [{ id: 'sched-monitor', customer_id: 'customer-1', service_id: 'svc-monitor', service_type: 'Termite Bait Station Service', scheduled_date: '2026-08-27', status: 'completed' }] }),
    LIVE_V2,
  );
  expect(frozen.termiteBaitStage).toBe('installation');
  // no top-level freeze: the snapshot's own immutable serviceKey wins over a repointed live profile
  const snapshotKey = await buildReportV1Data(
    {
      ...TERMITE_SERVICE,
      scheduled_service_id: 'sched-monitor',
      service_data: JSON.stringify({ typedReportSnapshot: { type: 'termite_bait_station', serviceKey: 'termite_monitoring', values: { stations_checked: 12 } } }),
    },
    'token-stage-snapshot-key',
    makeKnex({ ...fixtures, scheduled_services: [{ id: 'sched-monitor', customer_id: 'customer-1', service_id: 'svc-monitor', service_type: 'Termite Bait Station Service', scheduled_date: '2026-08-27', status: 'completed' }] }),
    LIVE_V2,
  );
  expect(snapshotKey.termiteBaitStage).toBe('detection');
  // a non-bait record carries no stage at all
  const pest = await buildReportV1Data(BASE_SERVICE, 'token-stage-pest', makeKnex({ ...fixtures, scheduled_services: [] }), LIVE_V2);
  expect(pest.termiteBaitStage).toBeNull();
});

test('a FAILED profile resolution fails closed — a bait-sounding label never advertises a next monitoring visit', async () => {
  const base = makeKnex({
    ...BASE_FIXTURES,
    scheduled_services: [
      // linked row (service_id) whose catalog lookup throws during this build
      { id: 'scheduled-broken', customer_id: 'customer-1', scheduled_date: '2999-01-03', status: 'confirmed', service_type: 'Termite Bait Station Follow-up', window_start: '09:00:00', service_id: 'svc-liquid' },
    ],
  });
  const throwing = (table) => {
    const query = base(table);
    if (table === 'services') {
      query.first = () => Promise.reject(new Error('catalog unavailable'));
      query.then = (_resolve, reject) => Promise.reject(new Error('catalog unavailable')).catch(reject);
    }
    return query;
  };
  throwing.schema = base.schema;
  const data = await buildReportV1Data(TERMITE_SERVICE, 'token-resolver-fails', throwing, LIVE_V2);
  expect(data.termiteNextMonitoringVisit).toBeNull();
});

test('termite report: no bait-station appointment → null (never the cross-line fallback); non-termite reports never carry it', async () => {
  const knex = makeKnex({
    ...BASE_FIXTURES,
    scheduled_services: [
      { id: 'scheduled-pest', customer_id: 'customer-1', scheduled_date: '2999-01-03', status: 'confirmed', service_type: 'Quarterly Pest Control Service', window_start: '09:00:00' },
    ],
  });
  const termite = await buildReportV1Data(TERMITE_SERVICE, 'token-termite-none', knex, LIVE_V2);
  expect(termite.nextAppointment.serviceType).toBe('Quarterly Pest Control Service');
  expect(termite.termiteNextMonitoringVisit).toBeNull();
  const pest = await buildReportV1Data(BASE_SERVICE, 'token-pest-none', knex, LIVE_V2);
  expect(pest.termiteNextMonitoringVisit).toBeNull();
});

test('termite report: the bait row is found behind dozens of earlier non-bait rows, resolving each distinct service once', async () => {
  const weekly = Array.from({ length: 60 }, (_, i) => ({
    id: `scheduled-lawn-${i}`, customer_id: 'customer-1', status: 'confirmed', service_type: 'Lawn Care Treatment', window_start: '08:00:00',
    scheduled_date: `2999-01-${String(1 + (i % 28)).padStart(2, '0')}`,
  }));
  const reads = [];
  const base = makeKnex({
    ...BASE_FIXTURES,
    scheduled_services: [
      ...weekly,
      { id: 'scheduled-bait', customer_id: 'customer-1', scheduled_date: '2999-06-01', status: 'confirmed', service_type: 'Termite Bait Station Service', window_start: '10:00:00' },
    ],
  });
  const spy = (table) => { reads.push(table); return base(table); };
  spy.schema = base.schema;
  const data = await buildReportV1Data(TERMITE_SERVICE, 'token-termite-deep', spy, LIVE_V2);
  expect(data.termiteNextMonitoringVisit?.scheduledDate).toBe('2999-06-01');
  // 60 identical lawn rows + 1 bait row → two identities → two resolutions,
  // each a handful of catalog reads, never one per row
  expect(reads.filter((t) => t === 'services').length).toBeLessThan(20);
});

test('termite report: the lookup never runs (no catalog reads) when the gate is off, in pdf mode, or for a non-bait termite form', async () => {
  const bait = { id: 'scheduled-bait', customer_id: 'customer-1', scheduled_date: '2999-04-03', status: 'confirmed', service_type: 'Termite Bait Station Service', window_start: '10:00:00' };
  const build = (service, opts) => {
    const reads = [];
    const base = makeKnex({ ...BASE_FIXTURES, scheduled_services: [bait] });
    const spy = (table) => { reads.push(table); return base(table); };
    spy.schema = base.schema;
    return buildReportV1Data(service, 'token-termite-gated', spy, opts).then((data) => ({ data, reads }));
  };
  process.env.TERMITE_REPORT_V2 = 'false';
  const gatedOff = await build(TERMITE_SERVICE, LIVE_V2);
  expect(gatedOff.data.termiteNextMonitoringVisit).toBeNull();
  expect(gatedOff.reads).not.toContain('service_completion_profiles');
  process.env.TERMITE_REPORT_V2 = 'true';
  const pdf = await build(TERMITE_SERVICE, { mode: 'pdf' });
  expect(pdf.data.termiteNextMonitoringVisit).toBeNull();
  expect(pdf.reads).not.toContain('service_completion_profiles');
  const liquid = await build({ ...TERMITE_SERVICE, service_type: 'Termite Liquid Treatment', service_data: JSON.stringify({ typedReportSnapshot: { type: 'termite_liquid', values: {} } }) }, LIVE_V2);
  expect(liquid.data.termiteNextMonitoringVisit).toBeNull();
  expect(liquid.reads).not.toContain('service_completion_profiles');
  // and the live bait report DOES resolve through the profile table
  const live = await build(TERMITE_SERVICE, LIVE_V2);
  expect(live.data.termiteNextMonitoringVisit?.serviceType).toBe('Termite Bait Station Service');
});
