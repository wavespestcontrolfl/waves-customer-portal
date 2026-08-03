/**
 * Round 18 (codex P1): the technician-report body wins the Visit Summary
 * whenever the PRIMARY snapshot accepted it — but that snapshot can be a
 * different findings type entirely, so its acceptance never ran the trap
 * setup guard. A body generated before the trapping COMPANION's selector
 * changed to "Initial setup" could still say the traps were checked, and
 * it won the summary beside the companion's frozen "Traps set" result.
 *
 * The screen runs BEFORE technician-report precedence, from the same
 * viewer-visible snapshot the narrative stage uses (narrativeTrapSetupSnapshot,
 * round 12) — so an internal_only companion does not screen a customer
 * view, and a staff viewer's does.
 */

jest.mock('../services/service-report/rodent-report-narrative', () => ({
  applyRodentReportNarrative: jest.fn(async () => null),
  applyTypedReportNarrative: jest.fn(async () => null),
}));
jest.mock('../services/termite-stations', () => ({
  ...jest.requireActual('../services/termite-stations'),
  buildStationMapReportContext: jest.fn(() => null),
}));

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

// Parses as reviewed customer copy, and contradicts a declared setup: the
// body claims the traps were checked.
const CONTRADICTING_NOTES = [
  'WHAT WE DID',
  'We checked the traps in the attic and refreshed the bait at each one.',
  'WHAT WE FOUND',
  'Rodent droppings were present along the north runway.',
].join('\n');
const CONTRADICTING_BODY = 'We checked the traps in the attic and refreshed the bait at each one. Rodent droppings were present along the north runway.';

// Parses as reviewed customer copy, and is exactly what a setup should
// say — the promise form the guard must keep legal.
const SETUP_NOTES = [
  'WHAT WE DID',
  'We set eight traps along the attic runways and baited each one.',
  'WHAT WE FOUND',
  'Rodent droppings were present, and we will return for the scheduled trap check.',
].join('\n');

function trappingCompanion(delivery, values = {}) {
  return {
    type: 'rodent_trapping',
    typeLabel: 'Rodent Trapping',
    serviceLabel: 'Rodent Trapping',
    schemaVersion: 2,
    visitSequence: 1,
    values: { trap_visit_type: 'Initial setup', traps_checked: 8, species: 'Roof rat', ...values },
    findings: [],
    nextStepChips: [],
    todaysResult: { headline: 'Trapping visit completed.' },
    delivery,
  };
}

// Primary is deliberately NOT a trapping report: its snapshot accepted the
// technician body under its own rules, which never ran the setup guard.
function serviceRow(companion, notes) {
  return {
    id: 'service-summary-screen-1',
    customer_id: 'customer-1',
    service_line: 'pest',
    service_type: 'Quarterly Pest Control',
    service_date: '2026-06-11',
    first_name: 'Pat',
    last_name: 'Customer',
    areas_serviced: '[]',
    structured_notes: '{}',
    technician_notes: notes,
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
        todaysResult: { headline: 'Service completed.', bodySource: 'technician_report' },
      },
      companionReportSnapshots: [companion],
    }),
  };
}

async function summaryFor(companion, notes, token, options = {}) {
  const data = await buildReportV1Data(
    serviceRow(companion, notes),
    token,
    stubKnex(),
    { mode: 'live', ...options },
  );
  return { summary: data.summary, source: data.summarySource };
}

describe('technician summaries screen against visible companion setup stages (round 18)', () => {
  test('a contradicting body loses the summary when a visible companion declares a setup', async () => {
    const { summary, source } = await summaryFor(
      trappingCompanion('auto_send'), CONTRADICTING_NOTES, 'token-screen-reject',
    );
    expect(source).not.toBe('technician_report');
    expect(summary).not.toBe(CONTRADICTING_BODY);
  });

  test('the same body wins the summary on a follow-up declaration', async () => {
    const { summary, source } = await summaryFor(
      trappingCompanion('auto_send', { trap_visit_type: 'Follow-up check' }),
      CONTRADICTING_NOTES,
      'token-screen-followup',
    );
    expect(source).toBe('technician_report');
    expect(summary).toBe(CONTRADICTING_BODY);
  });

  test('a clean setup body — set today, promise to check — still wins the summary', async () => {
    const { source } = await summaryFor(
      trappingCompanion('auto_send'), SETUP_NOTES, 'token-screen-clean',
    );
    expect(source).toBe('technician_report');
  });

  test('an internal-only companion does not screen a customer view (round-12 visibility)', async () => {
    const { source } = await summaryFor(
      trappingCompanion('internal_only'), CONTRADICTING_NOTES, 'token-screen-internal',
    );
    expect(source).toBe('technician_report');
  });

  test('a staff viewer sees the internal section, so their summary IS screened', async () => {
    const { source } = await summaryFor(
      trappingCompanion('internal_only'), CONTRADICTING_NOTES, 'token-screen-staff',
      { staffViewer: true },
    );
    expect(source).not.toBe('technician_report');
  });
});
