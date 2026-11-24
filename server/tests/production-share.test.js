// Production share, the pure calculation (production-share.js): rate x the amount above the bar, never below $0, with the
// bar per shift or once a week, in whole cents. The reads (weekCredits, the routes) are in production-share-postgres.test.js.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { shareForWeek, jobPartCents, shiftDays } = require('../services/production-share');

const perShift = { rateBps: 1500, barType: 'per_shift', barCents: 90000 };
const weekly = { rateBps: 1500, barType: 'weekly', barCents: 270000 };

describe('shareForWeek', () => {
  it('pays nothing at or below the bar, whatever the week was', () => {
    expect(shareForWeek({ credits: [100000, 70000], shifts: 2, settings: perShift }))
      .toMatchObject({ creditedCents: 170000, barCents: 180000, aboveBarCents: 0, shareCents: 0, configured: true });
    expect(shareForWeek({ credits: [180000], shifts: 2, settings: perShift }).shareCents).toBe(0);
    expect(shareForWeek({ credits: [], shifts: 0, settings: perShift }).shareCents).toBe(0);
  });

  it('takes the rate of the amount above a per-shift bar, the bar growing with each shift', () => {
    const credits = [120000, 90000, 80000]; // $2,900
    expect(shareForWeek({ credits, shifts: 3, settings: perShift }))
      .toMatchObject({ barCents: 270000, aboveBarCents: 20000, shareCents: 3000 });
    expect(shareForWeek({ credits, shifts: 2, settings: perShift }))
      .toMatchObject({ barCents: 180000, aboveBarCents: 110000, shareCents: 16500 });
  });

  it('uses one weekly bar whatever the shifts', () => {
    const credits = [150000, 150000];
    expect(shareForWeek({ credits, shifts: 1, settings: weekly })).toMatchObject({ barCents: 270000, shareCents: 4500 });
    expect(shareForWeek({ credits, shifts: 5, settings: weekly })).toMatchObject({ barCents: 270000, shareCents: 4500 });
  });

  it('rounds half a cent up and works in whole cents', () => {
    const at = (above) => shareForWeek({ credits: [90000 + above], shifts: 1, settings: perShift }).shareCents;
    expect(at(10)).toBe(2); // 1.5 cents
    expect(at(9)).toBe(1); // 1.35
    expect(at(1003)).toBe(150); // 150.45
    expect(at(1004)).toBe(151); // 150.6
    expect(at(0)).toBe(0);
  });

  it('reads credit rows as well as plain numbers', () => {
    const rows = [{ creditCents: 100000, visitId: 'a' }, { creditCents: 50000, visitId: 'b' }];
    expect(shareForWeek({ credits: rows, shifts: 1, settings: perShift })).toMatchObject({ creditedCents: 150000, shareCents: 9000 });
  });

  it('is $0 and says it is not configured when no setting is on file', () => {
    expect(shareForWeek({ credits: [500000], shifts: 2, settings: null }))
      .toMatchObject({ creditedCents: 500000, barCents: null, shareCents: 0, configured: false });
  });

  it('refuses amounts that are not whole cents', () => {
    expect(() => shareForWeek({ credits: [10.5], shifts: 1, settings: perShift })).toThrow(/whole number of cents/);
    expect(() => shareForWeek({ credits: [-1], shifts: 1, settings: perShift })).toThrow();
    expect(() => shareForWeek({ credits: [1], shifts: 1.5, settings: perShift })).toThrow(/Shifts/);
    expect(() => shareForWeek({ credits: [1], shifts: 1, settings: { ...perShift, barType: 'daily' } })).toThrow(/bar type/);
    expect(() => shareForWeek({ credits: [1], shifts: 1, settings: { ...perShift, rateBps: 10001 } })).toThrow(/100%/);
  });
});

describe('jobPartCents', () => {
  it('splits a job price across its planned visits and the parts add up to the price', () => {
    for (const [price, visits] of [[30000, 3], [10000, 3], [99999, 4], [1, 3], [45050, 2]]) {
      const parts = Array.from({ length: visits }, (_, i) => jobPartCents(price, visits, i + 1));
      expect(parts.reduce((a, b) => a + b, 0)).toBe(price);
      expect(Math.max(...parts) - Math.min(...parts)).toBeLessThanOrEqual(1);
    }
    expect(jobPartCents(30000, 3, 2)).toBe(10000);
  });
});

describe('shiftDays', () => {
  it('counts each work date once, whatever the number of stops', () => {
    expect(shiftDays([{ workDate: '2026-11-17' }, { workDate: '2026-11-16' }, { workDate: '2026-11-17' }])).toEqual(['2026-11-16', '2026-11-17']);
  });
});
