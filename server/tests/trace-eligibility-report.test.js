/**
 * Report-side enforcement of trace eligibility (GATE_TRACE_ELIGIBILITY):
 * the ONE server-side suppression point at payload build. The discriminator
 * lane is termite BAIT — the legacy checks (bed bug, rodent trapping) never
 * covered it, so gate-off renders its saved trace (today's defect) and
 * gate-on suppresses it. Reports recompose at view time, so legacy rows on
 * ineligible services die at render without any data migration.
 */

jest.mock('../config/feature-gates', () => ({
  isEnabled: (key) => key === 'treatmentZoneMap',
}));
jest.mock('../services/photos', () => ({
  getViewUrl: jest.fn(async () => 'https://signed.example/snapshot.png'),
  CUSTOMER_DWELL_TTL_SECONDS: 3600,
}));
jest.mock('../services/service-report/rodent-report-narrative', () => ({
  applyRodentReportNarrative: jest.fn(async () => null),
  applyTypedReportNarrative: jest.fn(async () => null),
}));
jest.mock('../services/termite-stations', () => ({
  ...jest.requireActual('../services/termite-stations'),
  buildStationMapReportContext: jest.fn(() => null),
}));

const { buildReportV1Data } = require('../services/service-report/report-data');

const TRACED_ROW = {
  snapshot_s3_key: 'zones/snap.png',
  mask_s3_key: null,
  capture_mode: 'perimeter',
  path_points: JSON.stringify([{ px: { x: 10, y: 20 } }]),
  closed_loop: true,
  linear_ft: 140,
  updated_at: '2026-08-01T12:00:00Z',
};

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

function serviceRow(serviceType) {
  return {
    id: 'service-trace-1',
    scheduled_service_id: 'sched-trace-1',
    customer_id: 'customer-1',
    service_line: 'pest',
    service_type: serviceType,
    service_date: '2026-08-01',
    first_name: 'Pat',
    last_name: 'Customer',
    areas_serviced: '[]',
    structured_notes: '{}',
    service_data: '{}',
    pressure_index: null,
  };
}

async function tracedFor(serviceType, options = {}) {
  const data = await buildReportV1Data(
    serviceRow(serviceType),
    `token-trace-${serviceType.replace(/\W+/g, '-').toLowerCase()}-${process.env.GATE_TRACE_ELIGIBILITY || 'off'}`,
    stubKnex({ treatment_zone_maps: [TRACED_ROW] }),
    { mode: 'live', ...options },
  );
  return data.treatmentMap?.traced || null;
}

describe('trace suppression at report payload build', () => {
  const prevGate = process.env.GATE_TRACE_ELIGIBILITY;
  afterEach(() => {
    if (prevGate === undefined) delete process.env.GATE_TRACE_ELIGIBILITY;
    else process.env.GATE_TRACE_ELIGIBILITY = prevGate;
  });

  test('gate OFF: a bait-lane trace still renders (the current defect, preserved dark)', async () => {
    delete process.env.GATE_TRACE_ELIGIBILITY;
    const traced = await tracedFor('Termite Bait Quarterly');
    expect(traced).not.toBeNull();
  });

  test('gate OFF: the registry variant stays dark too — payloads render as today (round 11)', async () => {
    delete process.env.GATE_TRACE_ELIGIBILITY;
    const traced = await tracedFor('Quarterly Pest Control');
    expect(traced).not.toBeNull();
    expect(traced.variant).toBeNull();
    expect(traced.captionKey).toBeNull();
  });

  test('gate ON: the same bait-lane trace is suppressed, legacy row untouched', async () => {
    process.env.GATE_TRACE_ELIGIBILITY = 'true';
    expect(await tracedFor('Termite Bait Quarterly')).toBeNull();
    expect(await tracedFor('Termite Inspection')).toBeNull();
  });

  test('gate ON: an eligible spray lane keeps its trace and gains the server variant', async () => {
    process.env.GATE_TRACE_ELIGIBILITY = 'true';
    const traced = await tracedFor('Quarterly Pest Control');
    expect(traced).not.toBeNull();
    expect(traced.variant).toBe('spray');
    expect(traced.captionKey).toBe('sprayPerimeter');
  });

  test('round 15 — completion-frozen identities beat later schedule edits', async () => {
    process.env.GATE_TRACE_ELIGIBILITY = 'true';
    // Frozen ineligible primary + frozen EMPTY add-ons: a pest add-on
    // added to the schedule AFTER completion cannot republish the trace
    const frozenRow = serviceRow('Termite Bait Quarterly');
    frozenRow.service_data = JSON.stringify({
      // an explicitly INELIGIBLE frozen key (the legacy station-install
      // lane) — the pest bundle key would be eligible in its own right
      completedServiceKey: 'termite_installation_setup',
      completedServiceName: 'Termite Bait Station Install',
      completedAddonLines: [],
    });
    const suppressed = await buildReportV1Data(
      frozenRow,
      'token-trace-frozen-suppressed',
      stubKnex({
        treatment_zone_maps: [TRACED_ROW],
        // live rows now claim a pest add-on — must NOT rescue
        scheduled_service_addons: [{ service_id: null, service_name: 'Quarterly Pest Control' }],
      }),
      { mode: 'live' },
    );
    expect(suppressed.treatmentMap?.traced || null).toBeNull();
    // Frozen ELIGIBLE primary beats a live row repointed to bait
    const keptRow = serviceRow('Termite Bait Quarterly');
    keptRow.service_data = JSON.stringify({
      completedServiceKey: 'pest_general_quarterly',
      completedServiceName: 'Quarterly Pest Control',
      completedAddonLines: [],
    });
    const kept = await buildReportV1Data(
      keptRow,
      'token-trace-frozen-kept',
      stubKnex({ treatment_zone_maps: [TRACED_ROW] }),
      { mode: 'live' },
    );
    expect(kept.treatmentMap?.traced || null).not.toBeNull();
  });

  test('gate ON: an eligible add-on line rescues the report map (round 13 — the export bug path)', async () => {
    process.env.GATE_TRACE_ELIGIBILITY = 'true';
    const data = await buildReportV1Data(
      serviceRow('Termite Bait Quarterly'),
      'token-trace-addon-rescue',
      stubKnex({
        treatment_zone_maps: [TRACED_ROW],
        scheduled_service_addons: [{ service_id: null, service_name: 'Quarterly Pest Control' }],
      }),
      { mode: 'live' },
    );
    const traced = data.treatmentMap?.traced || null;
    expect(traced).not.toBeNull();
    expect(traced.variant).toBe('spray');
  });

  test('gate ON: a lawn lane resolves the outline variant', async () => {
    process.env.GATE_TRACE_ELIGIBILITY = 'true';
    const traced = await tracedFor('Lawn Fertilization');
    expect(traced).not.toBeNull();
    expect(traced.variant).toBe('outline');
  });
});

// Owner ruling (b): stale cached PDFs invalidate on next open. The PDF
// cache key's treatment-zone component must change when the gate flips or
// the verdict differs — otherwise cached PDFs keep publishing the old
// spray map forever (codex P1 r1).
describe('PDF signature varies with the eligibility verdict', () => {
  const { treatmentZonePdfSignature } = require('../services/treatment-zone-maps');
  const prevGate = process.env.GATE_TRACE_ELIGIBILITY;
  afterEach(() => {
    if (prevGate === undefined) delete process.env.GATE_TRACE_ELIGIBILITY;
    else process.env.GATE_TRACE_ELIGIBILITY = prevGate;
  });

  const signatureFor = (serviceType) => treatmentZonePdfSignature(
    { scheduled_service_id: 'sched-trace-1', service_type: serviceType, service_data: '{}' },
    stubKnex({
      treatment_zone_maps: [TRACED_ROW],
      scheduled_services: [{ id: 'sched-trace-1', service_id: null, service_type: serviceType }],
    }),
  );

  test('gate off: pre-flip keys are untouched', async () => {
    delete process.env.GATE_TRACE_ELIGIBILITY;
    expect(await signatureFor('Termite Bait Quarterly')).toMatch(/^-tz\d+$/);
  });

  test('gate on: suppressed and eligible verdicts key differently', async () => {
    process.env.GATE_TRACE_ELIGIBILITY = 'true';
    const bait = await signatureFor('Termite Bait Quarterly');
    const pest = await signatureFor('Quarterly Pest Control');
    expect(bait).toMatch(/-te0$/);
    expect(pest).toMatch(/-te1spray$/);
    expect(bait).not.toBe(pest);
  });
});

// Codex P1 r2: reports-public and email-delivery build the re-entry
// context through resolveTracedExteriorZone independently of the report
// payload, so the verdict must live INSIDE that shared resolver — an
// ineligible visit losing its map must lose the exterior ready-time
// claim on every surface, not just the one call site.
describe('the shared exterior-zone resolver honors the verdict', () => {
  const { resolveTracedExteriorZone } = require('../services/service-report/report-data');
  const prevGate = process.env.GATE_TRACE_ELIGIBILITY;
  afterEach(() => {
    if (prevGate === undefined) delete process.env.GATE_TRACE_ELIGIBILITY;
    else process.env.GATE_TRACE_ELIGIBILITY = prevGate;
  });

  const zoneFor = (serviceType) => resolveTracedExteriorZone(
    { scheduled_service_id: 'sched-trace-1', service_type: serviceType, service_data: '{}' },
    stubKnex({
      treatment_zone_maps: [TRACED_ROW],
      scheduled_services: [{ id: 'sched-trace-1', service_id: null, service_type: serviceType }],
    }),
  );

  test('gate off: a saved trace still asserts the exterior zone (current behavior)', async () => {
    delete process.env.GATE_TRACE_ELIGIBILITY;
    expect(await zoneFor('Termite Bait Quarterly')).toBe(true);
  });

  test('gate on: ineligible lanes lose the exterior claim, eligible lanes keep it', async () => {
    process.env.GATE_TRACE_ELIGIBILITY = 'true';
    expect(await zoneFor('Termite Bait Quarterly')).toBe(false);
    expect(await zoneFor('Termite Inspection')).toBe(false);
    expect(await zoneFor('Quarterly Pest Control')).toBe(true);
  });
});
