/**
 * The initial en-route notification's ETA (track-transitions.resolveEnRouteEtaMinutes)
 * reads the technician's position through the SHARED remap-aware lookup — the same one
 * the public tracker and the AI ETA use (Codex round-40 P2, PR #5334) — so a technician
 * just pointed at a different vehicle never gets an ETA text from the OLD vehicle's
 * cached tech_status point. Synthetic data only.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/twilio', () => ({ sendTechEnRoute: jest.fn(), sendTechArrived: jest.fn() }));
jest.mock('../services/tech-status', () => ({
  setTechJobStatus: jest.fn().mockResolvedValue({}),
  clearTechCurrentJob: jest.fn().mockResolvedValue({}),
}));
jest.mock('../services/job-status', () => ({ transitionJobStatus: jest.fn().mockResolvedValue({}) }));
jest.mock('../sockets', () => ({ getIo: jest.fn(() => null) }));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => true) }));
jest.mock('../services/geocoder', () => ({ ensureCustomerGeocoded: jest.fn() }));
jest.mock('../services/tracking-vehicle-location', () => ({ resolveFreshTechPosition: jest.fn() }));
jest.mock('../services/customer-tracking-eta', () => {
  const actual = jest.requireActual('../services/customer-tracking-eta');
  return { ...actual, calculateBoundedTrackingEta: jest.fn() };
});

const db = require('../models/db');
const { resolveFreshTechPosition } = require('../services/tracking-vehicle-location');
const { calculateBoundedTrackingEta } = require('../services/customer-tracking-eta');
const { resolveEnRouteEtaMinutes } = require('../services/track-transitions')._test;

function installDb({ tech }) {
  db.mockImplementation((table) => {
    if (table === 'technicians') return { where: () => ({ first: async () => tech }) };
    if (table === 'scheduled_services as s') {
      return { leftJoin: () => ({ where: () => ({ first: async () => ({ service_lat: 27.4, service_lng: -82.5, latitude: null, longitude: null }) }) }) };
    }
    throw new Error(`unexpected table ${table}`);
  });
}

beforeEach(() => {
  db.mockReset();
  resolveFreshTechPosition.mockReset().mockResolvedValue({ lat: 27.1, lng: -82.2, lastReportedAt: new Date().toISOString(), source: 'tech_status' });
  calculateBoundedTrackingEta.mockReset().mockResolvedValue({ minutes: 11, source: 'google' });
});

test('the position comes from the shared lookup with the technician\'s IMEI and remap cutoff', async () => {
  installDb({ tech: { bouncie_imei: 'DEV-A', bouncie_imei_changed_at: '2026-09-30T10:00:00.000Z' } });
  expect(await resolveEnRouteEtaMinutes({ technicianId: 'tech-1', customerId: 'cust-1', serviceId: 'svc-1' })).toBe(11);
  expect(resolveFreshTechPosition).toHaveBeenCalledWith(expect.objectContaining({
    techId: 'tech-1', bouncieImei: 'DEV-A', cachedNotBefore: '2026-09-30T10:00:00.000Z',
  }));
  expect(calculateBoundedTrackingEta).toHaveBeenCalledWith(expect.objectContaining({ techLat: 27.1, techLng: -82.2, customerLat: 27.4, customerLng: -82.5 }));
});

test('no remap time (an ordinary technician edit) means no cutoff: the cache is trusted', async () => {
  installDb({ tech: { bouncie_imei: 'DEV-A', bouncie_imei_changed_at: null } });
  await resolveEnRouteEtaMinutes({ technicianId: 'tech-1', customerId: 'cust-1', serviceId: 'svc-1' });
  expect(resolveFreshTechPosition.mock.calls[0][0].cachedNotBefore).toBeNull();
});

test('an old-vehicle cached point that the lookup rejects yields NO ETA (the text goes without the ETA line), never a stale one', async () => {
  installDb({ tech: { bouncie_imei: 'DEV-B', bouncie_imei_changed_at: new Date().toISOString() } });
  resolveFreshTechPosition.mockResolvedValue(null);
  expect(await resolveEnRouteEtaMinutes({ technicianId: 'tech-1', customerId: 'cust-1', serviceId: 'svc-1' })).toBeNull();
  expect(calculateBoundedTrackingEta).not.toHaveBeenCalled();
});

test('the technician row unreadable: no ETA, no throw', async () => {
  db.mockImplementation(() => { throw new Error('db down'); });
  expect(await resolveEnRouteEtaMinutes({ technicianId: 'tech-1', customerId: 'cust-1', serviceId: 'svc-1' })).toBeNull();
});

test('missing ids are skipped without touching the database', async () => {
  expect(await resolveEnRouteEtaMinutes({ technicianId: null, customerId: 'cust-1', serviceId: 'svc-1' })).toBeNull();
  expect(db).not.toHaveBeenCalled();
});
