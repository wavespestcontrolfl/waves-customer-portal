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

  test('gate ON: a lawn lane resolves the outline variant', async () => {
    process.env.GATE_TRACE_ELIGIBILITY = 'true';
    const traced = await tracedFor('Lawn Fertilization');
    expect(traced).not.toBeNull();
    expect(traced.variant).toBe('outline');
  });
});
