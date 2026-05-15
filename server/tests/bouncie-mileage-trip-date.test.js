jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const { classifyTrip, tripDateForBouncieStart } = require('../services/bouncie-mileage');

describe('Bouncie mileage trip date', () => {
  test('uses America/New_York business date for UTC evening-boundary starts', () => {
    expect(tripDateForBouncieStart('2026-05-06T01:30:00.000Z')).toBe('2026-05-05');
  });

  test('keeps same ET date for daytime UTC starts', () => {
    expect(tripDateForBouncieStart('2026-05-05T16:30:00.000Z')).toBe('2026-05-05');
  });

  test('does not classify missing-coordinate trips as business by default', async () => {
    await expect(classifyTrip(null, null, null, null)).resolves.toMatchObject({
      is_business: false,
      method: 'needs_review',
    });
  });
});
