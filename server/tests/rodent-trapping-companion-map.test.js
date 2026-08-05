/**
 * The station map's trap-setup semantics must be readable from a rodent
 * trapping COMPANION, not just the primary snapshot.
 *
 * Round 5 of the #3159 review added a companion arm to that lookup, but it
 * read the projected `companionReports` view — which is assembled from a
 * fixed field list carrying no `values` — so the arm could only ever see
 * `undefined` and the primary alone decided the wording (codex P2 round 8).
 * That is the same defect class as the earlier `stationsLoaded` finding: a
 * fix that cannot fire.
 *
 * These assert on the ARGUMENTS handed to buildStationMapReportContext
 * rather than on rendered output, deliberately. Asserting the rendered map
 * would require station rows to exist in the stub, and a stub returning no
 * stations makes the map null — which passes whether or not the companion is
 * ever consulted. Pinning the call site is the only version of this test that
 * fails when the lookup goes dead again.
 */

jest.mock('../services/termite-stations', () => ({
  ...jest.requireActual('../services/termite-stations'),
  buildStationMapReportContext: jest.fn(() => null),
}));

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

// A rodent trapping snapshot in the shape buildTypedReportSnapshot persists.
function trappingSnapshot(values, overrides = {}) {
  return {
    type: 'rodent_trapping',
    typeLabel: 'Rodent Trapping',
    serviceLabel: 'Rodent Trapping',
    schemaVersion: 2,
    visitSequence: 1,
    values,
    findings: [],
    nextStepChips: [],
    todaysResult: { headline: 'Trapping visit completed.' },
    delivery: 'auto_send',
    ...overrides,
  };
}

// Primary is deliberately NOT a trapping report and carries no trap values,
// so `initialSetup: true` can only come from the companion.
function serviceRowWithTrappingCompanion(companion) {
  return {
    id: 'service-companion-1',
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

async function stationMapArgs(companion, token) {
  buildStationMapReportContext.mockClear();
  await buildReportV1Data(
    serviceRowWithTrappingCompanion(companion),
    token,
    stubKnex(),
  );
  expect(buildStationMapReportContext).toHaveBeenCalled();
  return buildStationMapReportContext.mock.calls[0][0];
}

describe('trap setup semantics resolve from a companion snapshot', () => {
  test('a companion declaring Initial setup drives the map, primary is not trapping', async () => {
    const args = await stationMapArgs(
      trappingSnapshot({ trap_visit_type: 'Initial setup', traps_checked: 8, species: 'Roof rat' }),
      'token-companion-setup',
    );
    expect(args.initialSetup).toBe(true);
    expect(args.typedTrapCount).toBe(8);
  });

  test('a companion declaring a follow-up does not claim setup', async () => {
    const args = await stationMapArgs(
      trappingSnapshot({ trap_visit_type: 'Follow-up check', traps_checked: 6, species: 'Roof rat' }),
      'token-companion-followup',
    );
    expect(args.initialSetup).toBe(false);
    expect(args.typedTrapCount).toBe(6);
  });

  test('a legacy companion with no declaration keeps its original wording', async () => {
    const args = await stationMapArgs(
      trappingSnapshot({ traps_checked: 6, species: 'Roof rat' }),
      'token-companion-legacy',
    );
    expect(args.initialSetup).toBe(false);
  });

  test('an internal-only companion still describes what physically happened', async () => {
    // The delivery flag governs which SECTIONS a viewer sees, not whether the
    // traps went out today — and the map is shared, so it must not be sourced
    // from the delivery-filtered projection.
    const args = await stationMapArgs(
      trappingSnapshot(
        { trap_visit_type: 'Initial setup', traps_checked: 8, species: 'Roof rat' },
        { delivery: 'internal_only' },
      ),
      'token-companion-internal',
    );
    expect(args.initialSetup).toBe(true);
    expect(args.typedTrapCount).toBe(8);
  });
});
