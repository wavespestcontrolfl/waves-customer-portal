/**
 * GATE_MULTI_TECH_TEXT_TIMES, text drafter half (multi-technician booking PR 4,
 * owner "go PR 4" 2026-10-06). With no scheduler picker for the text, the
 * drafter's city-based OPEN TIMES fallback asks the website booking engine
 * through text-offer-times.js, as one more offer source ('website_engine') on the
 * scheduler plumbing. The end-to-end draft + snapshot + recheck cases live in
 * sms-offers-scheduler.test.js; this file pins the pieces: the offer a text gets
 * (websiteOfferFor), the render, and gate-off parity.
 *
 * No DB, no network: both engines and the estimate reader are mocked.
 */
const REAL_ANSWERS = 'GATE_SMS_REAL_ANSWERS';
const SCHEDULER = 'GATE_SMS_OFFERS_SCHEDULER';
const TEXT_TIMES = 'GATE_MULTI_TECH_TEXT_TIMES';
const ALL = [REAL_ANSWERS, SCHEDULER, TEXT_TIMES];
const prior = Object.fromEntries(ALL.map((g) => [g, process.env[g]]));

// The website engine lists every feasible start, often 15 minutes apart.
const BOOK_DAYS = [
  { date: '2026-10-08', slots: [{ startTime24: '09:00' }, { startTime24: '09:15' }, { startTime24: '09:30' }, { startTime24: '11:00' }, { startTime24: '13:00' }, { startTime24: '15:00' }] },
  { date: '2026-10-09', slots: [{ startTime24: '08:00' }] },
  { date: '2026-10-10', slots: [] },
  { date: '2026-10-12', slots: [{ startTime24: '10:00' }] },
  { date: '2026-10-13', slots: [{ startTime24: '10:00' }] },
];
const OLD_DAYS = [{ date: '2026-10-07', fullDate: 'Wednesday, October 7', slots: [{ startTime24: '09:00' }, { startTime24: '10:00' }] }];

let oldFinder;
let textOfferDays;
let funnelKeyForEstimateId;
let drafter;

beforeEach(() => {
  ALL.forEach((g) => delete process.env[g]);
  process.env[REAL_ANSWERS] = 'true';
  jest.resetModules();
  oldFinder = jest.fn().mockResolvedValue({ zone: 'Old Zone', days: OLD_DAYS });
  textOfferDays = jest.fn().mockResolvedValue({ days: BOOK_DAYS, pinSource: 'city_table' });
  funnelKeyForEstimateId = jest.fn().mockResolvedValue('lawn_care');
  jest.doMock('../services/availability', () => ({ getAvailableSlots: oldFinder }));
  jest.doMock('../services/scheduling/text-offer-times', () => ({ textOfferDays }));
  jest.doMock('../services/estimate-converter', () => ({ funnelKeyForEstimateId }));
  // No catalog rows: a name the explicit funnel table does not know stays unmapped.
  jest.doMock('../services/call-booking-catalog', () => ({ loadBookableCallServices: async () => [] }));
  drafter = require('../services/sms-shadow-drafter');
});
afterEach(() => {
  ['../services/availability', '../services/scheduling/text-offer-times', '../services/estimate-converter', '../services/call-booking-catalog'].forEach((m) => jest.dontMock(m));
  jest.resetModules();
});
afterAll(() => ALL.forEach((g) => { if (prior[g] === undefined) delete process.env[g]; else process.env[g] = prior[g]; }));

describe('websiteOfferFor — the offer a text with no scheduler picker gets', () => {
  const base = { city: 'Venice' };

  test('a text naming no service gets general pest times; a named funnel service its own key', async () => {
    await expect(drafter.websiteOfferFor({ ...base, serviceType: '' })).resolves.toEqual({ source: 'website_engine', serviceKey: 'pest_control', city: 'Venice' });
    await expect(drafter.websiteOfferFor({ ...base, serviceType: 'Lawn Care' })).resolves.toMatchObject({ serviceKey: 'lawn_care' });
  });

  test('a named service /book does not book has an EMPTY key: the renderer withholds, it never defaults to pest', async () => {
    await expect(drafter.websiteOfferFor({ ...base, serviceType: 'Actual Bait Station Visit' })).resolves.toMatchObject({ source: 'website_engine', serviceKey: '' });
  });

  // Codex r2 P1-1 on #6073.
  test('an estimate-linked text takes the service from the LINKED ESTIMATE through funnelKeyForEstimate, whatever service the customer\'s visit history says', async () => {
    const offer = await drafter.websiteOfferFor({ ...base, serviceType: 'General Pest Control (Quarterly)', estimateId: 'est-1' });
    expect(funnelKeyForEstimateId).toHaveBeenCalledWith('est-1');
    expect(offer).toEqual({ source: 'website_engine', serviceKey: 'lawn_care', city: 'Venice', estimateId: 'est-1' });
  });

  test('an estimate the website engine cannot represent returns null (the old finder keeps it); a read failure withholds', async () => {
    funnelKeyForEstimateId.mockResolvedValue('');
    await expect(drafter.websiteOfferFor({ ...base, estimateId: 'est-1' })).resolves.toBeNull();
    funnelKeyForEstimateId.mockRejectedValue(new Error('db down'));
    await expect(drafter.websiteOfferFor({ ...base, estimateId: 'est-1' })).resolves.toMatchObject({ serviceKey: '' });
  });
});

describe('fetchOpenTimesData with a website-engine offer', () => {
  const offer = (extra = {}) => ({ source: 'website_engine', serviceKey: 'pest_control', city: 'Venice', ...extra });
  const args = (extra = {}) => ({ city: 'Venice', customerId: 'cust-1', schedulingIntent: true, schedulerOffer: offer(), ...extra });

  test('the website engine answers (customer pin or city centre) for the offer\'s service; the old finder is never called', async () => {
    const out = await drafter.fetchOpenTimesData(args({ schedulerOffer: offer({ estimateId: 'est-1', serviceKey: 'lawn_care' }) }));
    expect(textOfferDays).toHaveBeenCalledWith({ city: 'Venice', customerId: 'cust-1', estimateId: 'est-1', serviceKey: 'lawn_care' });
    expect(oldFinder).not.toHaveBeenCalled();
    expect(out.block).toContain('Thursday, October 8');
  });

  test('quotes non-overlapping 2-hour windows (not 9:00, 9:15 and 9:30), at most three a day, three days', async () => {
    const { arrivalWindowRange, formatSmsTimeRange } = require('../utils/sms-time-format');
    const w = (hhmm) => formatSmsTimeRange(arrivalWindowRange(hhmm));
    const out = await drafter.fetchOpenTimesData(args());
    expect(out.days).toEqual([
      { date: 'Thursday, October 8', windows: [w('09:00'), w('11:00'), w('13:00')] },
      { date: 'Friday, October 9', windows: [w('08:00')] },
      { date: 'Monday, October 12', windows: [w('10:00')] },
    ]);
    expect(out.block.split('\n')).toHaveLength(3);
  });

  test('an empty service key, nothing offered, or an engine error leaves OPEN TIMES out and never throws', async () => {
    await expect(drafter.fetchOpenTimesData(args({ schedulerOffer: offer({ serviceKey: '' }) }))).resolves.toEqual({ block: null, days: [] });
    expect(textOfferDays).not.toHaveBeenCalled();
    textOfferDays.mockResolvedValueOnce(null);
    await expect(drafter.fetchOpenTimesData(args())).resolves.toEqual({ block: null, days: [] });
    textOfferDays.mockRejectedValueOnce(new Error('engine down'));
    await expect(drafter.fetchOpenTimesData(args())).resolves.toEqual({ block: null, days: [] });
  });
});

describe('gate off / no offer: the old finder, byte-identical', () => {
  test('fetchOpenTimesData with no offer asks the old finder with its original arguments and the original 3-slot rule', async () => {
    const out = await drafter.fetchOpenTimesData({ city: 'Venice', customerId: 'cust-1', schedulingIntent: true });
    expect(oldFinder).toHaveBeenCalledWith('Venice', null, { customerId: 'cust-1' });
    expect(textOfferDays).not.toHaveBeenCalled();
    expect(out.days).toEqual([{ date: 'Wednesday, October 7', windows: expect.any(Array) }]);
  });

  test('a snapshot built by the old finder carries no stamp at all', () => {
    const offered = [{ date: 'Wednesday, October 7', window: '9:00 AM - 11:00 AM' }];
    expect(drafter.computeOpenTimesSnapshot({ openTimesBlock: 'x', offeredTimes: offered, city: 'Venice', customerId: 'c1', estimateId: null, serviceType: 'Pest' }).lookup)
      .toEqual({ city: 'Venice', customerId: 'c1', estimateId: null, serviceType: 'Pest' });
  });
});
