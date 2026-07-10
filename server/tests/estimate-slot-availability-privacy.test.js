/**
 * getAvailableSlots response privacy — the public slot payload must not echo
 * the estimate's exact coordinates (or address / coords provenance) back out.
 * No client reads them; the token-gated endpoint returning exact lat/lng was
 * a location leak (booking audit P1). Admin diagnostics use getSlotDebug,
 * which carries coords itself behind admin auth.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../services/scheduling/find-time', () => ({
  findAvailableSlots: jest.fn(async () => ({ slots: [], evaluated: 0 })),
}));

const db = require('../models/db');
const { getAvailableSlots } = require('../services/estimate-slot-availability');

describe('getAvailableSlots metadata privacy', () => {
  test('response metadata carries no estimateCoords / coordsSource / estimateAddress', async () => {
    db.mockImplementation((table) => {
      if (table === 'estimates') {
        return {
          where: jest.fn().mockReturnThis(),
          first: jest.fn().mockResolvedValue({
            id: 'est-privacy-1',
            status: 'sent',
            expires_at: null,
            customer_id: 'cust-1',
            address: '123 Test St, Sarasota, FL 34231',
            estimate_data: null,
            service_interest: 'Pest Control',
          }),
        };
      }
      if (table === 'customers') {
        return {
          where: jest.fn().mockReturnThis(),
          first: jest.fn().mockResolvedValue({
            latitude: 27.3364,
            longitude: -82.5307,
            address_line1: '123 Test St',
            city: 'Sarasota',
            state: 'FL',
            zip: '34231',
          }),
        };
      }
      if (table === 'technicians') {
        return {
          where: jest.fn().mockReturnThis(),
          select: jest.fn().mockResolvedValue([]),
        };
      }
      throw new Error(`unexpected table ${table}`);
    });

    const result = await getAvailableSlots('est-privacy-1', {});

    expect(result.metadata).toBeDefined();
    expect(result.metadata).not.toHaveProperty('estimateCoords');
    expect(result.metadata).not.toHaveProperty('coordsSource');
    expect(result.metadata).not.toHaveProperty('estimateAddress');
    // The fields the client DOES read stay present.
    expect(result.metadata).toHaveProperty('firstDayAvailability');
    expect(result.metadata).toHaveProperty('windowDays');
    // And no top-level coord echo either.
    expect(JSON.stringify(result)).not.toContain('27.3364');
  });
});
