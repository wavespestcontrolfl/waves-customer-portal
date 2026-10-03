// Lawn Fast Complete photo status is ADVISORY and single-sourced: an assessment
// captured under the shot list is judged by the shared minimum
// (shared/lawn-photo-shots.json via services/lawn-photo-shots), the way the photo
// step's own hint judges it; a legacy capture keeps the interim rule. Nothing here
// refuses anything. Synthetic data only.
const fs = require('fs');
const path = require('path');

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/waveguard-plan-engine', () => ({ buildPlanForService: jest.fn() }));
jest.mock('../models/db', () => jest.fn());

const { buildLawnFastContext, evaluatePhotoFloor, preflightLawnFastCompletion } = require('../services/lawn-fast-complete');
const shots = require('../services/lawn-photo-shots');

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
const world = ({ assessment, photos = [] } = {}) => fakeKnex({
  scheduled_services: visit,
  services: { service_key: 'lawn_care_monthly', name: 'Lawn Care', category: 'lawn_care', billing_type: 'recurring' },
  service_completion_profiles: {
    service_key: 'lawn_care_monthly', category: 'lawn_care', billing_type: 'recurring', completion_mode: 'service_report',
    project_type: null, companion_types: null, active: true,
  },
  customers: { billing_mode: null },
  lawn_assessments: assessment === undefined ? undefined : { id: ASSESSMENT, confirmed_by_tech: true, service_date: '2026-10-05', ...assessment },
  lawn_assessment_photos: photos,
});
const photoStatus = async (options) => (await buildLawnFastContext(VISIT, { knex: world(options) })).photoStatus;
const zones = (...list) => list.map((zone) => ({ zone }));
const MARKED = { photos: JSON.stringify([{ photoVocabulary: shots.PHOTO_VOCABULARY }]) };

const savedList = process.env.GATE_LAWN_SHOT_LIST;
const savedHistory = process.env.GATE_LAWN_PROPERTY_HISTORY;
beforeEach(() => {
  delete process.env.GATE_LAWN_SHOT_LIST;
  delete process.env.GATE_LAWN_PROPERTY_HISTORY;
});
afterAll(() => {
  if (savedList === undefined) delete process.env.GATE_LAWN_SHOT_LIST; else process.env.GATE_LAWN_SHOT_LIST = savedList;
  if (savedHistory === undefined) delete process.env.GATE_LAWN_PROPERTY_HISTORY; else process.env.GATE_LAWN_PROPERTY_HISTORY = savedHistory;
});

describe('captured under the shot list (stored marker): the shared minimum', () => {
  test('all four minimum shots: meets the floor, no warning', async () => {
    const status = await photoStatus({ assessment: MARKED, photos: zones('front', 'back', 'close_up', 'blade_crown') });
    expect(status).toMatchObject({ soft: true, basis: 'shot_list', count: 4, minPhotos: shots.SHOT_MINIMUM, meetsFloor: true, missing: [], warning: null });
  });

  test('a side overview stands in for the back overview (the shared slot)', async () => {
    const status = await photoStatus({ assessment: MARKED, photos: zones('front', 'side', 'close_up', 'blade_crown') });
    expect(status.meetsFloor).toBe(true);
  });

  test('blade and crown missing is named by its shared label', async () => {
    const status = await photoStatus({ assessment: MARKED, photos: zones('front', 'back', 'close_up', 'trouble') });
    expect(status).toMatchObject({ basis: 'shot_list', meetsFloor: false, missing: ['Blade and crown'] });
    expect(status.warning).toContain('Still needed: Blade and crown.');
  });

  test('the missing labels are the shared helper\'s, in its order, with "or" slots', async () => {
    const status = await photoStatus({ assessment: MARKED, photos: zones('trouble') });
    expect(status.missing).toEqual(shots.missingMinimumSlots(['trouble']));
    expect(status.missing).toEqual(['Front overview', 'Back overview or Side overview', 'Canopy close-up', 'Blade and crown']);
  });

  test('photos that failed the quality gate do not count toward the minimum', async () => {
    const status = await photoStatus({
      assessment: MARKED,
      photos: [{ zone: 'front' }, { zone: 'back' }, { zone: 'close_up' }, { zone: 'blade_crown', quality_gate_passed: false }],
    });
    expect(status).toMatchObject({ meetsFloor: false, missing: ['Blade and crown'], count: 3 });
  });

  test('a row captured before the marker, holding a shot-list-only zone, still judges as the shot list', async () => {
    const status = await photoStatus({ assessment: {}, photos: zones('front', 'blade_crown') });
    expect(status.basis).toBe('shot_list');
  });
});

describe('not captured under the shot list: today\'s interim rule, unchanged', () => {
  test('a legacy set that covers it', async () => {
    expect(await photoStatus({ assessment: {}, photos: zones('front', 'close_up', 'trouble') }))
      .toEqual({ soft: true, basis: 'legacy', count: 3, minPhotos: 3, meetsFloor: true, missing: [], warning: null });
  });

  test('a light legacy set warns exactly as before', async () => {
    const status = await photoStatus({ assessment: {}, photos: zones('front') });
    expect(status).toMatchObject({ basis: 'legacy', meetsFloor: false, missing: ['photos', 'close_up'] });
    expect(status.warning).toBe('Photo set is light (1 of 3 photos, no close-up). You can still finish; more photos make a stronger read.');
  });

  test('legacy back/side count as wide shots and trouble as a close-up', async () => {
    expect(evaluatePhotoFloor(zones('back', 'side', 'trouble')).meetsFloor).toBe(true);
  });

  test('an unmarked legacy capture is judged legacy even with the gate on now', async () => {
    process.env.GATE_LAWN_SHOT_LIST = 'true';
    expect((await photoStatus({ assessment: {}, photos: zones('front', 'close_up') })).basis).toBe('legacy');
  });
});

describe('no assessment yet: the gate decides', () => {
  test('shot list on: the shared minimum is the target, all of it still needed', async () => {
    process.env.GATE_LAWN_SHOT_LIST = 'true';
    const status = await photoStatus({ assessment: undefined });
    expect(status).toMatchObject({ basis: 'shot_list', count: 0, minPhotos: shots.SHOT_MINIMUM, meetsFloor: false });
    expect(status.missing).toEqual(shots.missingMinimumSlots([]));
  });

  test('shot list off: no status, as before', async () => {
    expect(await photoStatus({ assessment: undefined })).toBeNull();
  });
});

describe('the wording is pinned to the photo step\'s hint', () => {
  test('the warning is the client\'s shotListHint sentence, built from the same minimum and labels', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', '..', 'client', 'src', 'lib', 'lawn-photo-shots.js'), 'utf8');
    const body = source.slice(source.indexOf('export function shotListHint'));
    const template = body.match(/return `([^`]*)`;/)[1];
    expect(template).toContain('${SHOT_MINIMUM}');
    expect(template).toContain('${missing.join(", ")}');
    for (const present of [[], ['front'], ['front', 'back', 'close_up']]) {
      const missing = shots.missingMinimumSlots(present);
      const clientHint = template.replace('${SHOT_MINIMUM}', String(shots.SHOT_MINIMUM)).replace('${missing.join(", ")}', missing.join(', '));
      expect(evaluatePhotoFloor(present.map((zone) => ({ zone })), { shotList: true }).warning).toBe(clientHint);
    }
  });

  test('the client\'s missing-slot labels equal the shared helper\'s (same JSON, same join)', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', '..', 'client', 'src', 'lib', 'lawn-photo-shots.js'), 'utf8');
    expect(source).toContain('slot.map(shotLabel).join(" or ")');
    expect(shots.missingMinimumSlots([])).toEqual(shots.MINIMUM_SLOTS.map((slot) => slot.map((key) => shots.SHOTS.find((s) => s.key === key).label).join(' or ')));
  });
});

describe('advisory only', () => {
  test('a light set never refuses the submit', async () => {
    const knex = fakeKnex({
      scheduled_services: visit,
      services: { service_key: 'lawn_care_monthly', name: 'Lawn Care', category: 'lawn_care', billing_type: 'recurring' },
      service_completion_profiles: { service_key: 'lawn_care_monthly', category: 'lawn_care', billing_type: 'recurring', completion_mode: 'service_report', project_type: null, companion_types: null, active: true },
      lawn_assessments: { id: ASSESSMENT, confirmed_by_tech: true },
      lawn_assessment_photos: [],
    });
    process.env.GATE_LAWN_FAST_COMPLETE = 'true';
    const expectedVisit = {
      propertyId: null, customerId: CUSTOMER, catalogServiceId: CATALOG, serviceType: 'Lawn Care', scheduledDate: '2026-10-05',
      isCallback: false, address: {}, technicianId: null,
    };
    expect(await preflightLawnFastCompletion({ knex, svc: { id: VISIT, customer_id: CUSTOMER }, lawnAssessmentId: ASSESSMENT, expectedVisit })).toBeNull();
    delete process.env.GATE_LAWN_FAST_COMPLETE;
  });
});
