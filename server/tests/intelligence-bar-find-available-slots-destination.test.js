/**
 * find_available_slots executor: an explicit address is the destination.
 * The customer's primary coordinates are used only when the call carries no
 * address and no coordinates, so a search bound to a customer's secondary
 * property (task-context binds the saved address, and its stored coordinates
 * when it has them) is run around that property, never the primary one.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/scheduling/find-time', () => ({ findAvailableSlots: jest.fn(async () => ({ slots: [] })) }));

const db = require('../models/db');
const { findAvailableSlots } = require('../services/scheduling/find-time');
const { executeScheduleTool } = require('../services/intelligence-bar/schedule-tools');

const CUSTOMER = '10000000-0000-4000-8000-000000000001';
const customerRow = { latitude: '27.4989000', longitude: '-82.5748000', address_line1: '1234 Main St', city: 'Bradenton', state: 'FL', zip: '34203' };

beforeEach(() => {
  findAvailableSlots.mockClear();
  db.mockReset().mockImplementation(table => {
    const q = { where: () => q, whereILike: () => q, select: () => q, first: async () => (table === 'customers' ? customerRow : null) };
    return q;
  });
  process.env.GOOGLE_MAPS_API_KEY = 'test-key';
  global.fetch = jest.fn(async url => ({
    json: async () => ({ status: 'OK', results: [{ geometry: { location: { lat: 27.0998, lng: -82.4543 } } }], url }),
  }));
});
afterEach(() => { delete process.env.GOOGLE_MAPS_API_KEY; delete global.fetch; });

const destination = () => { const call = findAvailableSlots.mock.calls[0][0]; return { lat: call.lat, lng: call.lng }; };

test('customer_id alone searches around the customer\'s stored coordinates', async () => {
  await executeScheduleTool('find_available_slots', { customer_id: CUSTOMER });
  expect(destination()).toEqual({ lat: 27.4989, lng: -82.5748 });
  expect(global.fetch).not.toHaveBeenCalled();
});

test('bound coordinates from a saved property win over the customer\'s primary coordinates', async () => {
  await executeScheduleTool('find_available_slots', { customer_id: CUSTOMER, address: '99 Beach Rd, Venice, FL 34285', lat: 27.2, lng: -82.3 });
  expect(destination()).toEqual({ lat: 27.2, lng: -82.3 });
  expect(global.fetch).not.toHaveBeenCalled();
});

test('an explicit address with no coordinates is geocoded instead of falling back to the primary coordinates', async () => {
  await executeScheduleTool('find_available_slots', { customer_id: CUSTOMER, address: '5 Pier Ln, Venice, FL 34285' });
  expect(global.fetch).toHaveBeenCalledTimes(1);
  expect(String(global.fetch.mock.calls[0][0])).toContain(encodeURIComponent('5 Pier Ln, Venice, FL 34285'));
  expect(destination()).toEqual({ lat: 27.0998, lng: -82.4543 });
});
