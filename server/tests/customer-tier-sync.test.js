// WaveGuard tier sync from live services (2026-08-05). Born from the
// full-book audit: admin-created recurring series never stamp a tier, so 4
// real single-service members carried NULL and the estimate engine treated
// them as strangers. These tests pin the upgrade-only contract: null →
// computed, invalid legacy values rank as no-tier and correct upward, real
// tiers NEVER downgrade, zero qualifying services never stamps, and errors
// return a result instead of throwing (best-effort by contract).
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/waveguard-existing-services', () => ({
  loadExistingRecurringQualifyingRows: jest.fn(async () => []),
  qualifyingKeysFromRows: jest.fn(() => []),
}));
jest.mock('../services/pricing-engine/discount-engine', () => ({
  determineWaveGuardTier: jest.fn(() => ({ tier: 'bronze' })),
}));

const { loadExistingRecurringQualifyingRows, qualifyingKeysFromRows } = require('../services/waveguard-existing-services');
const { determineWaveGuardTier } = require('../services/pricing-engine/discount-engine');
const { syncCustomerTierFromServices } = require('../services/customer-tier-sync');

function fakeDb({ tier = null, updateSpy = jest.fn(async () => 1) } = {}) {
  const db = jest.fn(() => ({
    where: jest.fn(() => ({
      first: jest.fn(async () => ({ waveguard_tier: tier })),
      update: updateSpy,
    })),
  }));
  return { db, updateSpy };
}

beforeEach(() => {
  jest.clearAllMocks();
  qualifyingKeysFromRows.mockReturnValue(['pest_control']);
  determineWaveGuardTier.mockReturnValue({ tier: 'bronze' });
});

test('a NULL-tier member with one qualifying service gets Bronze with the sync source', async () => {
  const { db, updateSpy } = fakeDb({ tier: null });
  const result = await syncCustomerTierFromServices(db, 'cust-1');
  expect(result).toEqual({ updated: true, from: null, to: 'Bronze' });
  expect(updateSpy).toHaveBeenCalledWith({ waveguard_tier: 'Bronze', waveguard_tier_source: 'admin_booking_sync' });
});

test('an invalid legacy stamp (One-Time) ranks as no-tier and corrects upward', async () => {
  const { db } = fakeDb({ tier: 'One-Time' });
  const result = await syncCustomerTierFromServices(db, 'cust-1');
  expect(result).toEqual({ updated: true, from: 'One-Time', to: 'Bronze' });
});

test('adding a second service upgrades Bronze to Silver', async () => {
  qualifyingKeysFromRows.mockReturnValue(['pest_control', 'lawn_care']);
  determineWaveGuardTier.mockReturnValue({ tier: 'silver' });
  const { db } = fakeDb({ tier: 'Bronze' });
  const result = await syncCustomerTierFromServices(db, 'cust-1');
  expect(result).toEqual({ updated: true, from: 'Bronze', to: 'Silver' });
});

test('NEVER downgrades — a Gold member with one live service keeps Gold', async () => {
  const { db, updateSpy } = fakeDb({ tier: 'Gold' });
  const result = await syncCustomerTierFromServices(db, 'cust-1');
  expect(result).toMatchObject({ updated: false, reason: 'no_upgrade', current: 'Gold' });
  expect(updateSpy).not.toHaveBeenCalled();
});

test('zero qualifying services never stamps — no tier is NOT Bronze', async () => {
  qualifyingKeysFromRows.mockReturnValue([]);
  const { db, updateSpy } = fakeDb({ tier: null });
  const result = await syncCustomerTierFromServices(db, 'cust-1');
  expect(result).toMatchObject({ updated: false, reason: 'no_qualifying_services' });
  expect(updateSpy).not.toHaveBeenCalled();
});

test('errors return a result, never throw — a tier stamp must not fail a booking', async () => {
  loadExistingRecurringQualifyingRows.mockRejectedValueOnce(new Error('db down'));
  const { db } = fakeDb({});
  const result = await syncCustomerTierFromServices(db, 'cust-1');
  expect(result).toMatchObject({ updated: false, reason: 'error' });
});
