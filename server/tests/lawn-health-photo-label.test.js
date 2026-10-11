// Customer portal lawn health photos under GATE_LAWN_PHOTO_LABEL_PICK: the gallery (dashboard) and the
// per-visit photo list carry the label the technician chose, resolved by photo_order from the metadata
// stored beside the photos at capture. Gate off, or no pick, or a stored value that is not a shot key:
// no `labelPicked` key and the payload is what it was. Synthetic ids only.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/lawn-assessment-history', () => ({
  visitEligibility: jest.fn().mockResolvedValue({ propertyId: 'fixture-property' }),
  eligibleVisitIds: jest.fn().mockResolvedValue(['fixture-visit']),
  latestForCustomer: jest.fn(),
}));
jest.mock('../services/turf-height-service', () => ({
  getLatestTurfHeight: jest.fn().mockResolvedValue(null),
  getTurfHeightTrend: jest.fn().mockResolvedValue([]),
}));
jest.mock('../services/lawn-intelligence', () => ({ getCustomerPercentile: jest.fn().mockResolvedValue(null) }));
jest.mock('../services/photos', () => ({ getViewUrl: jest.fn() }));
jest.mock('../services/fawn-weather', () => ({
  getSeasonalContext: jest.fn(() => ({})), getPressureSignals: jest.fn(() => []),
}));

const db = require('../models/db');
const history = require('../services/lawn-assessment-history');
const router = require('../routes/lawn-health');
const handlerFor = (path) => router.stack.find((layer) => layer.route?.path === path).route.stack[0].handle;
const dashboard = handlerFor('/:customerId');
const visitPhotos = handlerFor('/:customerId/photos/:assessmentId');

const NAMES = ['GATE_LAWN_PROPERTY_HISTORY', 'GATE_LAWN_PHOTO_LABEL_PICK'];
const saved = {};
beforeEach(() => { NAMES.forEach((k) => { saved[k] = process.env[k]; delete process.env[k]; }); process.env.GATE_LAWN_PROPERTY_HISTORY = 'true'; });
afterEach(() => { NAMES.forEach((k) => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }); });

// Photo 1 (the shade slot) was relabeled Close-up; photo 2 holds a stored value that is not a shot key.
const META = JSON.stringify([{ filename: 'a' }, { filename: 'b', labelKey: 'close_up' }, { filename: 'c', labelKey: 'garage' }]);
const PHOTO_ROWS = [
  { id: 'p0', assessment_id: 'last', s3_key: 'k0', zone: 'front', photo_type: 'front_yard', photo_order: 0, customer_visible: true },
  { id: 'p1', assessment_id: 'last', s3_key: 'k1', zone: 'shade', photo_type: 'shade_area', photo_order: 1, customer_visible: true },
  { id: 'p2', assessment_id: 'last', s3_key: 'k2', zone: 'trouble', photo_type: 'trouble_spot', photo_order: 2, customer_visible: true },
];

function dbFor({ assessment }) {
  db.mockImplementation((table) => {
    const query = {
      where: () => query, whereIn: () => query, orderByRaw: () => query,
      limit: async () => (table === 'lawn_assessment_photos' ? PHOTO_ROWS : []),
      first: async () => (table === 'lawn_assessments' ? assessment : null),
      select: async () => [],
      then: (resolve, reject) => Promise.resolve(table === 'lawn_assessment_photos' ? PHOTO_ROWS : []).then(resolve, reject),
    };
    return query;
  });
}
const rowsFor = () => ['first', 'last'].map((id, i) => ({
  id, visit_date: `2026-0${i + 1}-01`, service_date: `2026-0${i + 1}-01`, turf_density: 70, weed_suppression: 60, color_health: 70, stress_damage: 50, fawn_temp_f: 75,
  ...(id === 'last' ? { photos: META } : {}),
}));

async function dashboardPhotos() {
  history.latestForCustomer.mockResolvedValue(rowsFor());
  dbFor({ assessment: null });
  const res = { json: jest.fn() };
  const next = jest.fn();
  await dashboard({ params: { customerId: 'cust-1' }, customerId: 'cust-1' }, res, next);
  expect(next).not.toHaveBeenCalled();
  return res.json.mock.calls[0][0].photos;
}
async function visitList() {
  dbFor({ assessment: { id: 'last', customer_id: 'cust-1', photos: META } });
  const res = { json: jest.fn(), status: jest.fn().mockReturnThis() };
  const next = jest.fn();
  await visitPhotos({ params: { customerId: 'cust-1', assessmentId: 'last' }, customerId: 'cust-1' }, res, next);
  expect(next).not.toHaveBeenCalled();
  return res.json.mock.calls[0][0].photos;
}
const picks = (photos) => Object.fromEntries(photos.map((p) => [p.id, p.labelPicked ?? null]));

test.each([['dashboard gallery', dashboardPhotos], ['visit photo list', visitList]])('%s, gate off: no labelPicked key, whatever was stored', async (_name, read) => {
  const photos = await read();
  expect(photos).toHaveLength(3);
  for (const photo of photos) expect(Object.prototype.hasOwnProperty.call(photo, 'labelPicked')).toBe(false);
});

test.each([['dashboard gallery', dashboardPhotos], ['visit photo list', visitList]])('%s, gate on: the pick is resolved by photo_order; an unknown stored value and an unpicked photo carry none', async (_name, read) => {
  process.env.GATE_LAWN_PHOTO_LABEL_PICK = 'true';
  const photos = await read();
  expect(picks(photos)).toEqual({ p0: null, p1: 'Close-up', p2: null });
  expect(photos.find((p) => p.id === 'p1')).toMatchObject({ zone: 'shade', type: 'shade_area' });
});
