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
    // The upsert writes over a stored row only when its checkedAt is newer, as the SQL does (the Postgres suite runs it).
    q.insert = (row) => ({ onConflict: () => ({ merge: (patch) => ({ whereRaw: async (sql, [checkedAt]) => {
      if (db.failing) throw new Error('db down');
      const old = rows.get(row.key);
      if (!old) rows.set(row.key, row);
      else if (JSON.parse(old.value).checkedAt < checkedAt) rows.set(row.key, { ...old, ...patch });
    } }) }) });
    return q;
  });
  db.rows = rows;
  return db;
});
jest.mock('../services/epa-product-label', () => ({ checkEpaSource: jest.fn() }));

const db = require('../models/db');
const { checkEpaSource } = require('../services/epa-product-label');
const { keptEpaSourceStatus, freshEpaSourceStatus, _test } = require('../services/epa-label-check-keep');

const source = { registration: '91234-401', filename: '091234-00401-20251216.pdf', sha256: 'a'.repeat(64) };
const DAY = 24 * 3600000;
let now;
let clock;
// EPA answers in order, each given at the moment of the call; then no answer.
const answers = (...statuses) => checkEpaSource.mockImplementation(async () => ({ status: statuses.shift() || 'unavailable', checkedAt: Date.now() }));
beforeEach(() => {
  db.rows.clear();
  db.failing = false;
  _test.seen.clear();
  jest.clearAllMocks();
  now = Date.parse('2026-10-30T12:00:00Z');
  clock = jest.spyOn(Date, 'now').mockImplementation(() => now);
});
afterEach(() => clock.mockRestore());

test('a failed check uses the last answer for up to 7 days, then says unavailable', async () => {
  answers('current');
  expect(await keptEpaSourceStatus(source)).toBe('current');
  const [[key, row]] = [...db.rows];
  expect(key.length).toBeLessThanOrEqual(100); // system_settings.key is varchar(100)
  expect(row.category).toBe('epa_label_check');
  expect(JSON.parse(row.value)).toEqual({ ...source, status: 'current', checkedAt: '2026-10-30T12:00:00.000Z' });
  now += 7 * DAY - 60000;
  expect(await keptEpaSourceStatus(source)).toBe('current');
  // A deploy clears memory: the stored row answers.
  _test.seen.clear();
  expect(await keptEpaSourceStatus(source)).toBe('current');
  now += 60000;
  expect(await keptEpaSourceStatus(source)).toBe('unavailable');
});

test('a changed label stays changed; another label file or checksum never borrows the answer', async () => {
  answers('current', 'superseded');
  await keptEpaSourceStatus(source);
  // A new answer is written at once, inside the hour.
  now += 60000;
  expect(await keptEpaSourceStatus(source)).toBe('superseded');
  expect(await keptEpaSourceStatus(source)).toBe('superseded');
  expect(await keptEpaSourceStatus({ ...source, sha256: 'b'.repeat(64) })).toBe('unavailable');
  expect(await keptEpaSourceStatus({ ...source, filename: '091234-00401-20260101.pdf' })).toBe('unavailable');
});

test('a cancelled registration is kept too: current, then cancelled, then an outage reads cancelled (pre-push audit P1)', async () => {
  answers('current', 'inactive');
  expect(await keptEpaSourceStatus(source)).toBe('current');
  now += 60000;
  expect(await keptEpaSourceStatus(source)).toBe('inactive');
  now += DAY;
  expect(await keptEpaSourceStatus(source)).toBe('inactive');
});

test('a cached answer read again keeps the time EPA gave it, so another process\'s newer answer wins (pre-push audit P1)', async () => {
  const at1200 = now;
  checkEpaSource.mockResolvedValue({ status: 'current', checkedAt: at1200 });
  await keptEpaSourceStatus(source);
  // Another process stored 'inactive' 30 seconds later.
  db.rows.set(_test.keyOf(source), { key: _test.keyOf(source), value: JSON.stringify({ ...source, status: 'inactive', checkedAt: new Date(at1200 + 30000).toISOString() }) });
  // This process reads its cached 'current' again at 12:00:50, then EPA stops answering.
  now = at1200 + 50000;
  await keptEpaSourceStatus(source);
  now = at1200 + 90000;
  checkEpaSource.mockResolvedValue({ status: 'unavailable', checkedAt: now });
  expect(await keptEpaSourceStatus(source)).toBe('inactive');
});

test('approval checks fresh and never takes the kept answer, but its answer is kept for later reads (pre-push audit P1)', async () => {
  answers('current', 'inactive');
  expect(await keptEpaSourceStatus(source)).toBe('current');
  now += 60000;
  expect(await freshEpaSourceStatus(source)).toBe('inactive');
  expect(checkEpaSource).toHaveBeenLastCalledWith(source, { refresh: true });
  // The 60-second cache has expired and EPA does not answer: the read says cancelled, not the older current.
  now += 120000;
  expect(await keptEpaSourceStatus(source)).toBe('inactive');
  expect(JSON.parse(db.rows.values().next().value.value).status).toBe('inactive');
  // An outage at approval is an outage, whatever is kept.
  expect(await freshEpaSourceStatus(source)).toBe('unavailable');
});

test('the same answer is written at most once an hour', async () => {
  checkEpaSource.mockImplementation(async () => ({ status: 'current', checkedAt: Date.now() }));
  await keptEpaSourceStatus(source);
  await keptEpaSourceStatus(source);
  expect(db).toHaveBeenCalledTimes(1);
  now += 3600000;
  await keptEpaSourceStatus(source);
  expect(db).toHaveBeenCalledTimes(2);
  expect(JSON.parse(db.rows.values().next().value.value).checkedAt).toBe('2026-10-30T13:00:00.000Z');
});

test('a newer answer that failed to save still beats the stored older one, and is saved on a later call (pre-push audit P1)', async () => {
  answers('current', 'inactive');
  await keptEpaSourceStatus(source);
  db.failing = true;
  now += 60000;
  expect(await keptEpaSourceStatus(source)).toBe('inactive');
  now += 60000;
  expect(await keptEpaSourceStatus(source)).toBe('inactive');
  db.failing = false;
  now += 60000;
  expect(await keptEpaSourceStatus(source)).toBe('inactive');
  expect(JSON.parse(db.rows.values().next().value.value).status).toBe('inactive');
  _test.seen.clear();
  expect(await keptEpaSourceStatus(source)).toBe('inactive');
});

test('a newer "changed" or "cancelled" answer is written at once; a cached one read again is not written twice', async () => {
  checkEpaSource.mockImplementation(async () => ({ status: 'inactive', checkedAt: Date.now() }));
  await keptEpaSourceStatus(source);
  now += 60000;
  await keptEpaSourceStatus(source);
  expect(db).toHaveBeenCalledTimes(2);
  expect(JSON.parse(db.rows.values().next().value.value).checkedAt).toBe('2026-10-30T12:01:00.000Z');
  // The same cached answer (same EPA time) read again writes nothing.
  checkEpaSource.mockResolvedValue({ status: 'inactive', checkedAt: now });
  await keptEpaSourceStatus(source);
  expect(db).toHaveBeenCalledTimes(2);
});

test('a database error never fails the check; a source with no checksum is never kept', async () => {
  db.failing = true;
  answers('current');
  expect(await keptEpaSourceStatus(source)).toBe('current');
  // This process still has the answer.
  expect(await keptEpaSourceStatus(source)).toBe('current');
  db.failing = false;
  db.mockClear();
  checkEpaSource.mockImplementation(async () => ({ status: 'current', checkedAt: Date.now() }));
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
    answers('current');
    expect(await checkReviewedWeatherSources([product])).toEqual({ x: 'current' });
    expect(await checkReviewedRateSources([product])).toEqual({ x: 'current' });
    expect(checkEpaSource).toHaveBeenCalledWith(source);
  } finally {
    delete process.env.GATE_LABEL_PIPELINE;
    delete process.env.GATE_LABEL_RATE_REVIEW;
  }
});
