/**
 * The van's departure time (owner 2026-10-24: leave at 7:30 so a first visit
 * 30 minutes out still starts at 8:00, editable in Settings). Every reader
 * keeps 08:00 with GATE_AUTO_DISPATCH_DAY_RULES off, and on a broken read.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const logger = require('../services/logger');
const departure = require('../services/scheduling/departure-time');

const GATE = 'GATE_AUTO_DISPATCH_DAY_RULES';
const saved = process.env[GATE];
afterEach(() => {
  if (saved === undefined) delete process.env[GATE]; else process.env[GATE] = saved;
  jest.clearAllMocks();
});

// system_settings with one optional stored value; `fails` makes the read throw.
function settings({ value, fails = false } = {}) {
  const first = jest.fn(async () => {
    if (fails) throw new Error('db down');
    return value === undefined ? null : { value };
  });
  const conn = jest.fn(() => ({ where: () => ({ first }) }));
  return { conn, first };
}

describe('parseDepartureTime: 06:00 to 08:00 in 15-minute steps', () => {
  test.each([
    ['07:30', 450], ['7:30', 450], ['"07:00"', 420], ['06:00', 360], ['08:00', 480],
  ])('%s is %i minutes', (value, minutes) => {
    expect(departure.parseDepartureTime(value)).toBe(minutes);
  });

  test.each([['07:10'], ['05:45'], ['08:15'], ['7:60'], [''], ['seven'], [null], [700], [['07:00']]])('%p is refused', (value) => {
    expect(departure.parseDepartureTime(value)).toBeNull();
  });

  test('formatDepartureTime writes HH:MM', () => {
    expect(departure.formatDepartureTime(450)).toBe('07:30');
    expect(departure.formatDepartureTime(360)).toBe('06:00');
  });
});

describe('dayDepartureMinutes', () => {
  test('gate off: 08:00 and no read at all', async () => {
    delete process.env[GATE];
    const { conn } = settings({ value: '"07:00"' });
    expect(await departure.dayDepartureMinutes(conn)).toBe(480);
    expect(conn).not.toHaveBeenCalled();
  });

  test('gate on, nothing saved yet: the owner\'s 07:30', async () => {
    process.env[GATE] = 'true';
    expect(await departure.dayDepartureMinutes(settings().conn)).toBe(450);
  });

  test('gate on: the saved time', async () => {
    process.env[GATE] = 'true';
    expect(await departure.dayDepartureMinutes(settings({ value: '"07:00"' }).conn)).toBe(420);
  });

  test('a broken saved value or a failed read gives 08:00 and a warning, never a throw', async () => {
    process.env[GATE] = 'true';
    expect(await departure.dayDepartureMinutes(settings({ value: '"05:00"' }).conn)).toBe(480);
    expect(await departure.dayDepartureMinutes(settings({ fails: true }).conn)).toBe(480);
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  test('the night tool passes its own run answer: enabled reads even with the env gate off', async () => {
    delete process.env[GATE];
    expect(await departure.dayDepartureMinutes(settings({ value: '"06:45"' }).conn, { enabled: true })).toBe(405);
    process.env[GATE] = 'true';
    expect(await departure.dayDepartureMinutes(settings({ value: '"06:45"' }).conn, { enabled: false })).toBe(480);
  });

  test('inside a caller\'s transaction the read runs in a savepoint, so a failure cannot abort it', async () => {
    process.env[GATE] = 'true';
    const { conn: inner } = settings({ value: '"07:15"' });
    const trx = Object.assign(jest.fn(() => { throw new Error('read on the outer transaction'); }), {
      isTransaction: true,
      transaction: jest.fn(async (fn) => fn(inner)),
    });
    expect(await departure.dayDepartureMinutes(trx)).toBe(435);
    expect(trx.transaction).toHaveBeenCalledTimes(1);
    expect(trx).not.toHaveBeenCalled();
  });
});
