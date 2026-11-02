// GATE_PORTAL_BOOKING_ITEMS: the words of an unfinished-booking bell and the off switch. The detection SQL, the bell
// write, the Portal tab listing and the close rules run against Postgres in portal-unfinished-bookings-postgres.test.js.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const mod = require('../services/portal-unfinished-bookings');

describe('unfinished-booking bell words', () => {
  const item = (over = {}) => ({ source: mod.SOURCE_ESTIMATE_CARD, name: 'Pat Synthetic', service: 'Quarterly Pest Control', ...over });

  test('a card-step drop-off names the estimate\'s service', () => {
    const { why, action } = mod.composeWords(item());
    expect(why).toBe('Pat Synthetic opened the card step on a Quarterly Pest Control estimate and did not finish');
    expect(action).toMatch(/^Call Pat Synthetic/);
  });

  test('no service still reads', () => {
    expect(mod.composeWords(item({ service: '' })).why).toBe('Pat Synthetic opened the card step on an estimate and did not finish');
  });

  test('no name on file: the bell still rings, about a visitor', () => {
    const { why, action } = mod.composeWords(item({ name: '' }));
    expect(why).toBe('A visitor opened the card step on a Quarterly Pest Control estimate and did not finish');
    expect(action).toBe('Call a visitor: booking not finished');
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
