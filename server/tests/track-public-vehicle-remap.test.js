/**
 * Public tracker vehicle lookup honors the tracker-remap cutoff (Codex round-34 P2,
 * PR #5334): a cached tech_status fix reported before the technician's tracker
 * mapping last CHANGED (technicians.bouncie_imei_changed_at, set only when bouncie_imei changes) may be the OLD vehicle's, so
 * buildVehicle passes the SAME cutoff the SMS ETA path passes — the text and the
 * tracking page never show different vehicles. Synthetic data only.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/geocoder', () => ({ ensureCustomerGeocoded: jest.fn() }));
jest.mock('../services/photos', () => ({ getViewUrl: jest.fn() }));
jest.mock('../services/tracking-vehicle-location', () => ({ resolveFreshTechPosition: jest.fn() }));
jest.mock('../services/customer-tracking-eta', () => {
  const actual = jest.requireActual('../services/customer-tracking-eta');
  return { ...actual, calculateBoundedTrackingEta: jest.fn() };
});

const { resolveFreshTechPosition } = require('../services/tracking-vehicle-location');
const { calculateBoundedTrackingEta, techMappingCutoff } = require('../services/customer-tracking-eta');
const trackPublicRouter = require('../routes/track-public');

const service = (extra = {}) => ({
  technician_id: 'tech-1', tech_bouncie_imei: 'DEV-A', tech_mapping_changed_at: '2026-09-30T10:00:00.000Z', latitude: 27.4, longitude: -82.5, ...extra,
});

beforeEach(() => {
  resolveFreshTechPosition.mockReset().mockResolvedValue({ lat: 27.1, lng: -82.2, lastReportedAt: new Date().toISOString(), source: 'bouncie_api' });
  calculateBoundedTrackingEta.mockReset().mockResolvedValue({ minutes: 9, source: 'google' });
});

test('buildVehicle passes the technician row\'s mapping timestamp as the cached-fix floor', async () => {
  const v = await trackPublicRouter._test.buildVehicle(service());
  expect(v.etaMinutes).toBe(9);
  expect(resolveFreshTechPosition).toHaveBeenCalledWith(expect.objectContaining({
    techId: 'tech-1', bouncieImei: 'DEV-A', cachedNotBefore: '2026-09-30T10:00:00.000Z',
  }));
});

test('NO remap time (NULL) means no cutoff: an ordinary technician edit leaves the cached fix trusted', async () => {
  await trackPublicRouter._test.buildVehicle(service({ tech_mapping_changed_at: null, tech_updated_at: new Date().toISOString() }));
  expect(resolveFreshTechPosition.mock.calls[0][0].cachedNotBefore).toBeNull();
});

test('a present-but-unreadable remap time bypasses the cache entirely (fails closed to "now")', async () => {
  const before = Date.now();
  await trackPublicRouter._test.buildVehicle(service({ tech_mapping_changed_at: 'not-a-date' }));
  const floor = resolveFreshTechPosition.mock.calls[0][0].cachedNotBefore;
  expect(floor).toBeInstanceOf(Date);
  expect(floor.getTime()).toBeGreaterThanOrEqual(before);
});

test('the SMS path and the public tracker share one cutoff rule', () => {
  expect(techMappingCutoff('2026-09-30T10:00:00.000Z')).toBe('2026-09-30T10:00:00.000Z');
  expect(techMappingCutoff(new Date('2026-09-30T10:00:00.000Z'))).toEqual(new Date('2026-09-30T10:00:00.000Z'));
  for (const none of [null, undefined, '']) expect(techMappingCutoff(none)).toBeNull();
  expect(techMappingCutoff('not-a-date')).toBeInstanceOf(Date);
});

test('the public query selects the technician mapping timestamp', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '../routes/track-public.js'), 'utf8');
  expect(src).toContain("'t.bouncie_imei_changed_at as tech_mapping_changed_at'");
});

test('no technician or no destination pin: no vehicle, no lookup (unchanged)', async () => {
  expect(await trackPublicRouter._test.buildVehicle(service({ technician_id: null }))).toBeNull();
  expect(await trackPublicRouter._test.buildVehicle(service({ latitude: null }))).toBeNull();
  expect(resolveFreshTechPosition).not.toHaveBeenCalled();
});
