 
jest.mock('../models/db', () => jest.fn());
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (_req, _res, next) => next(),
  requireAdmin: (_req, _res, next) => next(),
  requireTechOrAdmin: (_req, _res, next) => next(),
}));
jest.mock('../services/discount-engine', () => ({
  manualEligibilityFailures: jest.fn(),
  clearCache: jest.fn(),
}));

const { buildAppointmentPricing } = require('../routes/admin-schedule')._test;
const { priceOneTimeMosquito } = require('../services/pricing-engine');

describe('hand-scheduled one-time mosquito lot-ladder default', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const mosquitoService = { service_key: 'mosquito_one_time', category: 'mosquito', base_price: 149 };

  test('defaults to the engine ladder price from the customer lot size', async () => {
    const lotSqFt = 12000;
    const pricing = await buildAppointmentPricing({
      serviceRecord: mosquitoService,
      estimatedPrice: null,
      primaryLinePrice: null,
      serviceAddons: [],
      customer: { id: 'customer-1', lot_sqft: lotSqFt },
    });

    const expected = priceOneTimeMosquito({ lotSqFt }).price;
    expect(expected).toBeGreaterThan(149); // sanity: mid-ladder, not the SMALL entry
    expect(pricing.finalPrice).toBe(expected);
  });

  test('an explicitly typed price still wins over the ladder', async () => {
    const pricing = await buildAppointmentPricing({
      serviceRecord: mosquitoService,
      estimatedPrice: null,
      primaryLinePrice: 200,
      serviceAddons: [],
      customer: { id: 'customer-1', lot_sqft: 40000 },
    });

    expect(pricing.finalPrice).toBe(200);
  });

  test('falls back to the catalog base price when the customer has no lot size', async () => {
    const pricing = await buildAppointmentPricing({
      serviceRecord: mosquitoService,
      estimatedPrice: null,
      primaryLinePrice: null,
      serviceAddons: [],
      customer: { id: 'customer-1', lot_sqft: null },
    });

    expect(pricing.finalPrice).toBe(149);
  });

  test('blank-priced mosquito ADD-ON line gets the ladder, never $0', async () => {
    const lotSqFt = 12000;
    const db = require('../models/db');
    db.mockReturnValueOnce({
      where: jest.fn().mockReturnThis(),
      first: jest.fn().mockResolvedValue({ service_key: 'mosquito_one_time', category: 'mosquito', base_price: 149 }),
    });

    const pricing = await buildAppointmentPricing({
      serviceRecord: { service_key: 'general_pest', category: 'pest_control', base_price: 150 },
      estimatedPrice: null,
      primaryLinePrice: 150,
      serviceAddons: [{ serviceId: 'svc-mosquito', name: 'One-Time Mosquito Treatment', basePrice: null, price: null }],
      customer: { id: 'customer-1', lot_sqft: lotSqFt },
    });

    const expected = priceOneTimeMosquito({ lotSqFt }).price;
    expect(pricing.addonLines[0].base).toBe(expected);
    expect(pricing.finalPrice).toBe(150 + expected);
  });

  test('blank-priced mosquito add-on with no lot data falls back to catalog base, never $0', async () => {
    const db = require('../models/db');
    db.mockReturnValueOnce({
      where: jest.fn().mockReturnThis(),
      first: jest.fn().mockResolvedValue({ service_key: 'mosquito_one_time', category: 'mosquito', base_price: 149 }),
    });

    const pricing = await buildAppointmentPricing({
      serviceRecord: { service_key: 'general_pest', category: 'pest_control', base_price: 150 },
      estimatedPrice: null,
      primaryLinePrice: 150,
      serviceAddons: [{ serviceId: 'svc-mosquito', name: 'One-Time Mosquito Treatment', basePrice: null, price: null }],
      customer: { id: 'customer-1', lot_sqft: null },
    });

    expect(pricing.addonLines[0].base).toBe(149);
    expect(pricing.finalPrice).toBe(299);
  });

  test('mosquito primary with a priced add-on in the group still gets the ladder (client sends null)', async () => {
    const lotSqFt = 40000;
    const db = require('../models/db');
    db.mockReturnValueOnce({
      where: jest.fn().mockReturnThis(),
      first: jest.fn().mockResolvedValue({ service_key: 'general_pest', category: 'pest_control', base_price: 150 }),
    });

    const pricing = await buildAppointmentPricing({
      serviceRecord: mosquitoService,
      estimatedPrice: null,
      primaryLinePrice: null,
      serviceAddons: [{ serviceId: 'svc-pest', name: 'One-Time Pest', basePrice: 150, price: 150 }],
      customer: { id: 'customer-1', lot_sqft: lotSqFt },
    });

    const expected = priceOneTimeMosquito({ lotSqFt }).price;
    expect(pricing.finalPrice).toBe(expected + 150);
  });

  test('treated-lawn property_sqft is NEVER subtracted as a footprint (arbitration contract)', async () => {
    const lotSqFt = 12000;
    const pricing = await buildAppointmentPricing({
      serviceRecord: mosquitoService,
      estimatedPrice: null,
      primaryLinePrice: null,
      serviceAddons: [],
      customer: { id: 'customer-1', lot_sqft: lotSqFt, property_sqft: 8000 },
    });

    expect(pricing.finalPrice).toBe(priceOneTimeMosquito({ lotSqFt }).price);
  });

  test('recurring-plan member with no lot data gets the perk applied to the catalog base', async () => {
    const pricing = await buildAppointmentPricing({
      serviceRecord: mosquitoService,
      estimatedPrice: null,
      primaryLinePrice: null,
      serviceAddons: [],
      customer: { id: 'customer-1', lot_sqft: null, waveguard_tier: 'Gold' },
    });

    expect(pricing.finalPrice).toBe(Math.round(149 * 0.85));
  });

  test('recurring-plan customers get the canonical 15% one-time perk on the ladder default', async () => {
    const lotSqFt = 12000;
    const pricing = await buildAppointmentPricing({
      serviceRecord: mosquitoService,
      estimatedPrice: null,
      primaryLinePrice: null,
      serviceAddons: [],
      customer: { id: 'customer-1', lot_sqft: lotSqFt, waveguard_tier: 'Gold' },
    });

    const expected = priceOneTimeMosquito({ lotSqFt }, { isRecurringCustomer: true }).price;
    expect(expected).toBeLessThan(priceOneTimeMosquito({ lotSqFt }).price);
    expect(pricing.finalPrice).toBe(expected);
  });

  test('non-mosquito services keep the catalog base fallback untouched', async () => {
    const pricing = await buildAppointmentPricing({
      serviceRecord: { service_key: 'general_pest', category: 'pest_control', base_price: 150 },
      estimatedPrice: null,
      primaryLinePrice: null,
      serviceAddons: [],
      customer: { id: 'customer-1', lot_sqft: 40000 },
    });

    expect(pricing.finalPrice).toBe(150);
  });
});
