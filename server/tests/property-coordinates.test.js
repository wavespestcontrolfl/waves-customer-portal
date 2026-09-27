jest.mock('../models/db', () => jest.fn());
const db = require('../models/db');
const { coordinatesOf, resolvePropertyCoordinates } = require('../services/property-coordinates');

beforeEach(() => jest.clearAllMocks());

test('an owned saved property supplies both coordinates, even after retirement', async () => {
  const first = jest.fn().mockResolvedValue({ latitude: '27.22', longitude: '-81.84' });
  const where = jest.fn(() => ({ first }));
  db.mockReturnValue({ where });
  await expect(resolvePropertyCoordinates('customer', 'secondary')).resolves.toEqual({ latitude: 27.22, longitude: -81.84 });
  expect(db).toHaveBeenCalledTimes(1);
  expect(db).toHaveBeenCalledWith('customer_properties');
  expect(where).toHaveBeenCalledWith({ id: 'secondary', customer_id: 'customer' });
});

test.each([null, { latitude: null, longitude: -81.84 }, { latitude: 27.22, longitude: '' }])(
  'a missing or ungeocoded property never inherits the customer pin: %p', async (property) => {
    db.mockReturnValue({ where: () => ({ first: async () => property }) });
    await expect(resolvePropertyCoordinates('customer', 'secondary', {
      customer: { id: 'customer', latitude: 27.14, longitude: -82.34 },
    })).resolves.toBeNull();
    expect(db).toHaveBeenCalledTimes(1);
    expect(db).toHaveBeenCalledWith('customer_properties');
  },
);

test('legacy customer coordinates need no property lookup', async () => {
  await expect(resolvePropertyCoordinates('customer', null, {
    customer: { id: 'customer', latitude: '27.14', longitude: '-82.34' },
  })).resolves.toEqual({ latitude: 27.14, longitude: -82.34 });
  expect(db).not.toHaveBeenCalled();
});

test('a supplied customer from another account is ignored', async () => {
  const where = jest.fn(() => ({ first: async () => ({ latitude: 27.14, longitude: -82.34 }) }));
  db.mockReturnValue({ where });
  await expect(resolvePropertyCoordinates('customer', undefined, {
    customer: { id: 'foreign', latitude: 27.22, longitude: -81.84 },
  })).resolves.toEqual({ latitude: 27.14, longitude: -82.34 });
  expect(where).toHaveBeenCalledWith({ id: 'customer' });
});

test.each([undefined, null, '', ' ', false, 'invalid', Infinity, 91])('rejects invalid latitude %p', (latitude) => {
  expect(coordinatesOf({ latitude, longitude: -82.34 })).toBeNull();
});
test('rejects longitude outside the coordinate range', () => {
  expect(coordinatesOf({ latitude: 27.14, longitude: -181 })).toBeNull();
});
