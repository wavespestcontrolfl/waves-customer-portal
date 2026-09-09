jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
const { staffedDeadline } = require('../services/callback-cards');

describe('callback working deadlines', () => {
  test('carries the remaining staffed hours over a weekend and a closure', () => {
    const calendar = { start: '08:00', end: '17:00', closed: new Set(['2026-09-12', '2026-09-13', '2026-09-14']) };
    expect(staffedDeadline(new Date('2026-09-11T15:00:00-04:00'), calendar).toISOString()).toBe('2026-09-15T14:00:00.000Z');
  });
  test('uses Eastern wall time across the fall DST change', () => {
    const calendar = { start: '08:00', end: '17:00', closed: new Set(['2026-10-31', '2026-11-01']) };
    expect(staffedDeadline(new Date('2026-10-30T16:00:00-04:00'), calendar).toISOString()).toBe('2026-11-02T16:00:00.000Z');
  });
});
