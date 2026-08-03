/**
 * The narrative lanes tell the CUSTOMER the traps went out today, so their
 * visitStage must resolve only from snapshots this viewer is allowed to see.
 *
 * Round 12: the stage was read off the RAW companion snapshots — which is
 * correct for the shared MAP's wording (pinned by
 * rodent-trapping-companion-map.test.js) but not for the narrative: an
 * internal_only rodent-trapping setup companion on an auto-sent primary
 * leaked "your traps were placed" into a customer summary whose own section
 * is delivery-suppressed. Staff viewers see internal sections flagged, so
 * their narrative may still name the stage.
 *
 * Same approach as the companion-map suite: assert on the ARGUMENTS handed
 * to applyTypedReportNarrative — the only version of this test that fails
 * when the lookup reverts to the raw array.
 */

jest.mock('../services/service-report/rodent-report-narrative', () => ({
  applyRodentReportNarrative: jest.fn(async () => null),
  applyTypedReportNarrative: jest.fn(async () => null),
}));
jest.mock('../services/termite-stations', () => ({
  ...jest.requireActual('../services/termite-stations'),
  buildStationMapReportContext: jest.fn(() => null),
}));

const { applyTypedReportNarrative } = require('../services/service-report/rodent-report-narrative');
const { buildStationMapReportContext } = require('../services/termite-stations');
const { buildReportV1Data } = require('../services/service-report/report-data');

function stubKnex(fixtures = {}) {
  const knex = (table) => {
    const rows = fixtures[table] || [];
    const query = {
      where: () => query,
      whereIn: () => query,
      orderBy: () => query,
      modify: () => query,
      limit: () => query,
      select: () => Promise.resolve(rows),
      first: () => Promise.resolve(rows[0] || null),
      catch: () => Promise.resolve(rows),
      then: (resolve) => Promise.resolve(rows).then(resolve),
    };
    return query;
  };
  return knex;
}

function trappingCompanion(delivery) {
  return {
    type: 'rodent_trapping',
    typeLabel: 'Rodent Trapping',
    serviceLabel: 'Rodent Trapping',
    schemaVersion: 2,
    visitSequence: 1,
    values: { trap_visit_type: 'Initial setup', traps_checked: 8, species: 'Roof rat' },
    findings: [],
    nextStepChips: [],
    todaysResult: { headline: 'Trapping visit completed.' },
    delivery,
  };
}

// Primary is deliberately NOT a trapping report, so the stage can only come
// from the companion.
function serviceRow(companion) {
  return {
    id: 'service-narrative-stage-1',
    customer_id: 'customer-1',
    service_line: 'pest',
    service_type: 'Quarterly Pest Control',
    service_date: '2026-06-11',
    first_name: 'Pat',
    last_name: 'Customer',
    areas_serviced: '[]',
    structured_notes: '{}',
    pressure_index: null,
    service_data: JSON.stringify({
      typedReportSnapshot: {
        type: 'one_time_pest',
        typeLabel: 'One-Time Pest',
        serviceLabel: 'One-Time Pest',
        schemaVersion: 2,
        visitSequence: 1,
        values: { target_pest: 'Ants' },
        findings: [],
        nextStepChips: [],
        todaysResult: { headline: 'Service completed.' },
      },
      companionReportSnapshots: [companion],
    }),
  };
}

async function narrativeStage(companion, token, options = {}) {
  applyTypedReportNarrative.mockClear();
  await buildReportV1Data(
    serviceRow(companion),
    token,
    stubKnex(),
    { mode: 'live', ...options },
  );
  expect(applyTypedReportNarrative).toHaveBeenCalled();
  return applyTypedReportNarrative.mock.calls[0][0].visitStage;
}

describe('narrative visitStage resolves from viewer-visible snapshots only', () => {
  const prevGate = process.env.GATE_TYPED_REPORT_NARRATIVE;
  beforeAll(() => { process.env.GATE_TYPED_REPORT_NARRATIVE = 'true'; });
  afterAll(() => {
    if (prevGate === undefined) delete process.env.GATE_TYPED_REPORT_NARRATIVE;
    else process.env.GATE_TYPED_REPORT_NARRATIVE = prevGate;
  });

  test('an auto-sent setup companion names the stage for the customer', async () => {
    expect(await narrativeStage(trappingCompanion('auto_send'), 'token-stage-autosend'))
      .toBe('initial_trap_setup');
  });

  test('an internal-only setup companion does NOT reach the customer narrative', async () => {
    expect(await narrativeStage(trappingCompanion('internal_only'), 'token-stage-internal'))
      .toBeNull();
  });

  test('a staff viewer sees internal sections, so their narrative keeps the stage', async () => {
    expect(await narrativeStage(
      trappingCompanion('internal_only'),
      'token-stage-staff',
      { staffViewer: true },
    )).toBe('initial_trap_setup');
  });
});

// Round 15: the map only emits setupCountVerified when a pin carries a
// per-visit status. The station sync is fail-soft, so a declared setup
// whose check rows never landed produced NO dispute flag — and for an
// auto-sent trapping companion the facts carry the primary's findings, so
// the typed count never reached the grounded number set either. A typed 6
// beside an 8-pin fallback map licensed "8 traps were set".
describe('count disputes survive a fail-soft station sync', () => {
  const prevGate = process.env.GATE_TYPED_REPORT_NARRATIVE;
  beforeAll(() => { process.env.GATE_TYPED_REPORT_NARRATIVE = 'true'; });
  afterAll(() => {
    if (prevGate === undefined) delete process.env.GATE_TYPED_REPORT_NARRATIVE;
    else process.env.GATE_TYPED_REPORT_NARRATIVE = prevGate;
  });

  async function disputeFor(mapContext, values = { trap_visit_type: 'Initial setup', traps_checked: 6 }) {
    buildStationMapReportContext.mockReturnValueOnce(mapContext);
    applyTypedReportNarrative.mockClear();
    await buildReportV1Data(
      serviceRow({ ...trappingCompanion('auto_send'), values }),
      `token-dispute-${Math.abs(JSON.stringify({ mapContext, values }).length)}-${values.traps_checked}`,
      stubKnex(),
      { mode: 'live' },
    );
    expect(applyTypedReportNarrative).toHaveBeenCalled();
    return applyTypedReportNarrative.mock.calls[0][0].stationCountDisputed;
  }

  // An unsynced setup: pins from the standing registry, no per-visit
  // statuses, so the map emits neither initialSetup nor setupCountVerified.
  const unsyncedMap = {
    available: true,
    program: 'trapping',
    summary: { total: 8, checked: 0, activity: 0, serviced: 0, inaccessible: 0 },
  };

  test('a typed count disagreeing with an unsynced map is disputed', async () => {
    expect(await disputeFor(unsyncedMap)).toBe(true);
  });

  test('a typed count matching the standing roster is not disputed', async () => {
    expect(await disputeFor(unsyncedMap, { trap_visit_type: 'Initial setup', traps_checked: 8 }))
      .toBe(false);
  });

  test('a synced setup agreeing with the checked count is not disputed', async () => {
    const synced = {
      available: true,
      program: 'trapping',
      initialSetup: true,
      setupCountVerified: true,
      summary: { total: 8, checked: 6, activity: 0, serviced: 0, inaccessible: 2 },
    };
    expect(await disputeFor(synced)).toBe(false);
  });

  test('the map’s own explicit dispute flag still wins', async () => {
    const flagged = {
      available: true,
      program: 'trapping',
      initialSetup: true,
      setupCountVerified: false,
      summary: { total: 8, checked: 8, activity: 0, serviced: 0, inaccessible: 0 },
    };
    expect(await disputeFor(flagged, { trap_visit_type: 'Initial setup', traps_checked: 8 }))
      .toBe(true);
  });
});
