// GATE_PORTAL_BOOKING_ITEMS: the words of an unfinished-booking bell and the off switch. The detection SQL, the bell
// write, the Portal tab listing and the close rules run against Postgres in portal-unfinished-bookings-postgres.test.js.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const mod = require('../services/portal-unfinished-bookings');

describe('unfinished-booking bell words', () => {
  test.each([
    [{ date: '2026-11-24', start: '13:00', end: '14:00' }, 'Tue Nov 24, 1-2 PM'],
    [{ date: '2026-09-19', start: '10:00', end: '12:00' }, 'Sat Sep 19, 10 AM-12 PM'],
    [{ date: '2026-09-19', start: '11:30', end: '13:00' }, 'Sat Sep 19, 11:30 AM-1 PM'],
    [{ date: '2026-09-19', start: '09:00', end: null }, 'Sat Sep 19, 9 AM'],
    [{ date: '2026-09-19', start: null, end: null }, 'Sat Sep 19'],
    [{ date: 'Sep 19', start: '09:00', end: '10:00' }, ''],
    [null, ''],
  ])('slotWords(%j) = %j', (slot, words) => {
    expect(mod.slotWords(slot)).toBe(words);
  });

  const item = (over = {}) => ({
    source: mod.SOURCE_BOOKING_PAGE, name: 'Pat Synthetic', service: 'Mosquito Control',
    slot: { date: '2026-11-24', start: '13:00', end: '14:00' }, ...over,
  });

  test('a booking-page drop-off says what they picked and for what', () => {
    const { why, action } = mod.composeWords(item());
    expect(why).toBe('Pat Synthetic picked Tue Nov 24, 1-2 PM for Mosquito Control and did not finish');
    expect(action).toMatch(/^Call Pat Synthetic/);
  });

  test('a card-step drop-off names the estimate\'s service; no service still reads', () => {
    expect(mod.composeWords(item({ source: mod.SOURCE_ESTIMATE_CARD, service: 'Quarterly Pest Control', slot: null })).why)
      .toBe('Pat Synthetic opened the card step on a Quarterly Pest Control estimate and did not finish');
    expect(mod.composeWords(item({ source: mod.SOURCE_ESTIMATE_CARD, service: '', slot: null })).why)
      .toBe('Pat Synthetic opened the card step on an estimate and did not finish');
  });

  test('no name on file: the bell still rings, about a visitor', () => {
    const { why, action } = mod.composeWords(item({ name: '', slot: null }));
    expect(why).toBe('A visitor started booking for Mosquito Control and did not finish');
    expect(action).toBe('Call a visitor: booking not finished');
  });
});

describe('the day\'s summary bell (past MAX_BELLS_PER_DAY)', () => {
  test('passes the alert rules, and its key is never a drop-off\'s (not listed, not counted, not classed)', () => {
    const { composeAdminAlert } = require('../services/admin-alert-compose');
    expect(() => composeAdminAlert(mod.burstAlertSpec('2026-11-02'))).not.toThrow();
    expect(mod.BURST_KEY_PREFIX.startsWith(mod.KEY_PREFIX)).toBe(false);
    expect(mod.burstAlertSpec('2026-11-02').doneWhen).not.toBe('customer_answered');
  });

  test('the estimate card step is read before the booking page', () => {
    expect(mod.SOURCES.map((source) => source.name)).toEqual([mod.SOURCE_ESTIMATE_CARD, mod.SOURCE_BOOKING_PAGE]);
  });

  test('the held list: newest first, one line each, at most ten and a count of the rest', () => {
    const at = (minutes) => new Date(Date.parse('2026-11-02T15:00:00Z') - minutes * 60 * 1000);
    const held = Array.from({ length: 12 }, (_, k) => ({
      name: k === 0 ? '' : `Sam V${k}`, service: k === 1 ? '' : 'Mosquito Control', phone: '9415550142', dropOffAt: at(k),
      slot: k === 0 ? { date: '2026-11-24', start: '13:00', end: '14:00' } : null,
    }));
    const lines = mod.heldLines([...held].reverse()).split('\n');
    expect(lines).toHaveLength(11);
    expect(lines[0]).toBe('A visitor, Mosquito Control, Tue Nov 24, 1-2 PM, 9415550142');
    expect(lines[1]).toBe('Sam V1, a booking, 9415550142');
    expect(lines[10]).toBe('and 2 more');
  });
});

describe('the off switch', () => {
  afterEach(() => { delete process.env.GATE_PORTAL_BOOKING_ITEMS; });

  test('gate off: nothing is read or written', async () => {
    const db = require('../models/db');
    expect(await mod.runPortalUnfinishedBookings({ now: new Date(), conn: db })).toEqual({ skipped: true, reason: 'gate_off' });
    expect(db).not.toHaveBeenCalled();
  });
});
