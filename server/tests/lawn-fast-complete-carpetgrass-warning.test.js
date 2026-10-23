// GATE_ESTIMATE_LAWN_LIMITS on the lawn Fast Complete context: with carpetgrass on the
// customer's turf profile the context carries `carpetgrassCelsiusWarning` (the line a Celsius
// WG row shows on the sheet). Absent with the gate off, with no carpetgrass, or on a read
// failure: the context is then byte-identical to before. Synthetic data only.
const fs = require('fs');
const path = require('path');

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/waveguard-plan-engine', () => ({ buildPlanForService: jest.fn() }));
jest.mock('../models/db', () => jest.fn());

const { buildLawnFastContext } = require('../services/lawn-fast-complete');
const { CARPETGRASS_CELSIUS_WARNING } = require('../services/estimate-lawn-limits');

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const VISIT = uuid(1);
const ASSESSMENT = uuid(2);
const CATALOG = uuid(3);
const CUSTOMER = uuid(30);

function fakeKnex(tables) {
  const knex = jest.fn((table) => {
    const data = tables[table];
    const chain = {};
    for (const m of ['where', 'whereIn', 'whereNot', 'leftJoin', 'join', 'orderBy', 'select']) chain[m] = () => chain;
    chain.first = async () => (Array.isArray(data) ? data[0] : data);
    const settle = () => Promise.resolve(Array.isArray(data) ? data : []);
    chain.then = (resolve, reject) => settle().then(resolve, reject);
    chain.catch = (reject) => settle().catch(reject);
    return chain;
  });
  knex.raw = (sql) => ({ sql });
  knex.schema = { hasTable: async () => true };
  return knex;
}

const visit = {
  id: VISIT, customer_id: CUSTOMER, property_id: null, service_type: 'Lawn Care', service_id: CATALOG,
  scheduled_date: '2026-10-05', status: 'confirmed', visit_id: null, technician_id: null,
};
const world = ({ assessment, photos = [], turf } = {}) => fakeKnex({
  scheduled_services: visit,
  services: { service_key: 'lawn_care_monthly', name: 'Lawn Care', category: 'lawn_care', billing_type: 'recurring' },
  service_completion_profiles: {
    service_key: 'lawn_care_monthly', category: 'lawn_care', billing_type: 'recurring', completion_mode: 'service_report',
    project_type: null, companion_types: null, active: true,
  },
  customers: { billing_mode: null },
  lawn_assessments: assessment === undefined ? undefined : { id: ASSESSMENT, confirmed_by_tech: true, service_date: '2026-10-05', ...assessment },
  lawn_assessment_photos: photos,
  customer_turf_profiles: turf,
});


const context = async (turf) => buildLawnFastContext(VISIT, { knex: world({ assessment: {}, turf }) });
const SAVED = process.env.GATE_ESTIMATE_LAWN_LIMITS;
afterEach(() => {
  if (SAVED === undefined) delete process.env.GATE_ESTIMATE_LAWN_LIMITS; else process.env.GATE_ESTIMATE_LAWN_LIMITS = SAVED;
});

describe('carpetgrassCelsiusWarning on the lawn Fast Complete context', () => {
  test('gate off: no key, even with carpetgrass on the profile', async () => {
    delete process.env.GATE_ESTIMATE_LAWN_LIMITS;
    const ctx = await context({ id: 'tp1', active: true, other_grasses: ['carpetgrass'] });
    expect(ctx.ok).toBe(true);
    expect(ctx).not.toHaveProperty('carpetgrassCelsiusWarning');
  });

  test('gate on, carpetgrass flagged: the owner line', async () => {
    process.env.GATE_ESTIMATE_LAWN_LIMITS = 'true';
    const ctx = await context({ id: 'tp1', active: true, other_grasses: ['bahiagrass', 'carpetgrass'] });
    expect(ctx.carpetgrassCelsiusWarning).toBe('Carpetgrass on this lawn: Celsius kills it. Spot only, off the carpetgrass.');
    expect(ctx.carpetgrassCelsiusWarning).toBe(CARPETGRASS_CELSIUS_WARNING);
  });

  test.each([
    ['no profile', undefined],
    ['NULL flags', { id: 'tp1', active: true, other_grasses: null }],
    ['other grasses only', { id: 'tp1', active: true, other_grasses: ['bahiagrass', 'torpedograss'] }],
    ['virus only', { id: 'tp1', active: true, other_grasses: null, virus_streaks_suspected: true }],
  ])('gate on, %s: no key', async (_name, turf) => {
    process.env.GATE_ESTIMATE_LAWN_LIMITS = 'true';
    const ctx = await context(turf);
    expect(ctx.ok).toBe(true);
    expect(ctx).not.toHaveProperty('carpetgrassCelsiusWarning');
  });

  test('the warning is text for a row, never a refusal: the visit stays eligible', async () => {
    process.env.GATE_ESTIMATE_LAWN_LIMITS = 'true';
    const off = await context({ id: 'tp1', active: true, other_grasses: null });
    const on = await context({ id: 'tp1', active: true, other_grasses: ['carpetgrass'] });
    expect(on.eligible).toBe(off.eligible);
    expect(on.reason).toBe(off.reason);
  });
});
