/**
 * The last EPA label check that got an answer is kept for 7 days (owner 2026-10-30: "keep the last good label check for
 * 7 days"). A failed check uses it, for the same label file and checksum only; a database error never fails the check.
 */
jest.mock('../models/db', () => {
  const rows = new Map();
  const db = jest.fn(() => {
    const q = {};
    q.where = (match) => { q.match = match; return q; };
    q.first = async () => { if (db.failing) throw new Error('db down'); return rows.get(q.match.key); };
    q.insert = (row) => ({ onConflict: () => ({ merge: async (patch) => { if (db.failing) throw new Error('db down'); rows.set(row.key, rows.has(row.key) ? { ...rows.get(row.key), ...patch } : row); } }) });
    return q;
  });
  db.rows = rows;
  return db;
});
jest.mock('../services/epa-product-label', () => ({ currentEpaSourceStatus: jest.fn() }));

const db = require('../models/db');
const { currentEpaSourceStatus } = require('../services/epa-product-label');
const { keptEpaSourceStatus, _test } = require('../services/epa-label-check-keep');

const source = { registration: '91234-401', filename: '091234-00401-20251216.pdf', sha256: 'a'.repeat(64) };
const DAY = 24 * 3600000;
let now;
let clock;
beforeEach(() => {
  db.rows.clear();
  db.failing = false;
  _test.saved.clear();
  jest.clearAllMocks();
  now = Date.parse('2026-10-30T12:00:00Z');
  clock = jest.spyOn(Date, 'now').mockImplementation(() => now);
});
afterEach(() => clock.mockRestore());

test('a failed check uses the last answer for up to 7 days, then says unavailable', async () => {
  currentEpaSourceStatus.mockResolvedValueOnce('current').mockResolvedValue('unavailable');
  expect(await keptEpaSourceStatus(source)).toBe('current');
  const [[key, row]] = [...db.rows];
  expect(key.length).toBeLessThanOrEqual(100); // system_settings.key is varchar(100)
  expect(row.category).toBe('epa_label_check');
  expect(JSON.parse(row.value)).toEqual({ ...source, status: 'current', checkedAt: '2026-10-30T12:00:00.000Z' });
  now += 7 * DAY - 60000;
  expect(await keptEpaSourceStatus(source)).toBe('current');
  now += 60000;
  expect(await keptEpaSourceStatus(source)).toBe('unavailable');
});

test('a changed label stays changed; another label file or checksum never borrows the answer', async () => {
  currentEpaSourceStatus.mockResolvedValueOnce('current').mockResolvedValueOnce('superseded').mockResolvedValue('unavailable');
  await keptEpaSourceStatus(source);
  // A new answer is written at once, inside the hour.
  now += 60000;
  expect(await keptEpaSourceStatus(source)).toBe('superseded');
  expect(await keptEpaSourceStatus(source)).toBe('superseded');
  expect(await keptEpaSourceStatus({ ...source, sha256: 'b'.repeat(64) })).toBe('unavailable');
  expect(await keptEpaSourceStatus({ ...source, filename: '091234-00401-20260101.pdf' })).toBe('unavailable');
});

test('a cancelled registration is kept too: current, then cancelled, then an outage reads cancelled (pre-push audit P1)', async () => {
  currentEpaSourceStatus.mockResolvedValueOnce('current').mockResolvedValueOnce('inactive').mockResolvedValue('unavailable');
  expect(await keptEpaSourceStatus(source)).toBe('current');
  now += 60000;
  expect(await keptEpaSourceStatus(source)).toBe('inactive');
  now += DAY;
  expect(await keptEpaSourceStatus(source)).toBe('inactive');
});

test('the same answer is written at most once an hour', async () => {
  currentEpaSourceStatus.mockResolvedValue('current');
  await keptEpaSourceStatus(source);
  await keptEpaSourceStatus(source);
  expect(db).toHaveBeenCalledTimes(1);
  now += 3600000;
  await keptEpaSourceStatus(source);
  expect(db).toHaveBeenCalledTimes(2);
  expect(JSON.parse(db.rows.values().next().value.value).checkedAt).toBe('2026-10-30T13:00:00.000Z');
});

test('a database error or a source with no checksum leaves the fresh answer', async () => {
  db.failing = true;
  currentEpaSourceStatus.mockResolvedValueOnce('current').mockResolvedValueOnce('unavailable');
  expect(await keptEpaSourceStatus(source)).toBe('current');
  expect(await keptEpaSourceStatus(source)).toBe('unavailable');
  db.failing = false;
  db.mockClear();
  currentEpaSourceStatus.mockResolvedValue('current');
  expect(await keptEpaSourceStatus({ registration: '91234-401' })).toBe('current');
  expect(db).not.toHaveBeenCalled();
});

// Approval still checks fresh (product-label-review.test.js: { refresh: true }).
test('the job card weather check and the rate check both use it', async () => {
  process.env.GATE_LABEL_PIPELINE = 'true';
  process.env.GATE_LABEL_RATE_REVIEW = 'true';
  try {
    const { labelProductSnapshot, checkReviewedWeatherSources } = require('../services/product-label-weather');
    const { rateProductSnapshot, checkReviewedRateSources } = require('../services/product-label-rates');
    const product = { id: 'x', name: 'Synthetic WSG', epa_reg_number: '91234-401', formulation: 'WSG' };
    product.label_weather_review = { active: { status: 'approved', productSnapshot: labelProductSnapshot(product), source } };
    product.label_rate_review = { active: { status: 'approved', productSnapshot: rateProductSnapshot(product), source } };
    currentEpaSourceStatus.mockResolvedValueOnce('current').mockResolvedValue('unavailable');
    expect(await checkReviewedWeatherSources([product])).toEqual({ x: 'current' });
    expect(await checkReviewedRateSources([product])).toEqual({ x: 'current' });
    expect(currentEpaSourceStatus).toHaveBeenCalledWith(source);
  } finally {
    delete process.env.GATE_LABEL_PIPELINE;
    delete process.env.GATE_LABEL_RATE_REVIEW;
  }
});
