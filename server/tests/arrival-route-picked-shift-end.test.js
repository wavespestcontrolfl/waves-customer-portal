/**
 * GATE_TECH_SHIFT_HOURS (D4): the shift end the route check holds a PICKED block to
 * (services/scheduling/arrival-route.js pickedShiftEnd, read by checkArrivalPlacement).
 * The finders already hand the engine the shift end for each hour they list; this is the
 * same limit for an hour a person or an automatic mover picked.
 *
 * A failure here means one of these. The limit is read with the gate off. A block the shift
 * does not hold on the clock is given the limit (the picked-hour rule already says that one).
 * A failed read fails the check or the save.
 */
const mockDb = jest.fn();
jest.mock('../models/db', () => mockDb);
const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
jest.mock('../services/logger', () => mockLogger);
const mockLoadTechShifts = jest.fn();
jest.mock('../services/technician-eligibility', () => ({ loadTechShifts: (...args) => mockLoadTechShifts(...args) }));

const { pickedShiftEnd } = require('../services/scheduling/arrival-route')._internals;

const DATE = '2097-06-10';
const NOW = new Date('2097-06-01T12:00:00Z');
const SHIFT = { startMin: 8 * 60, endMin: 13 * 60, source: 'roster' };
const context = (technicianId = 'tech-1') => ({ target: { id: 'visit-1', technician_id: technicianId }, now: NOW });
const block = (windowStart, windowEnd, extra = {}) => ({ date: DATE, windowStart, windowEnd, durationMinutes: 60, ...extra });
let shiftOf;

beforeEach(() => {
  jest.clearAllMocks();
  process.env.GATE_TECH_SHIFT_HOURS = 'true';
  shiftOf = jest.fn((id, date) => (id === 'tech-1' && date === DATE ? SHIFT : null));
  mockLoadTechShifts.mockImplementation(async () => shiftOf);
});
afterAll(() => { delete process.env.GATE_TECH_SHIFT_HOURS; });

test('a block the shift holds gets the shift end, read for that technician with the check\'s clock', async () => {
  const conn = jest.fn();
  expect(await pickedShiftEnd(context(), { conn, ...block('12:00', '13:00') })).toBe(13 * 60);
  expect(mockLoadTechShifts).toHaveBeenCalledWith(conn, { technicianIds: ['tech-1'], now: NOW });
  expect(shiftOf).toHaveBeenCalledWith('tech-1', DATE);
  // The exact shift: its first and last minutes.
  expect(await pickedShiftEnd(context(), { conn, ...block('08:00', '13:00') })).toBe(13 * 60);
  // A date with a time part is that date.
  expect(await pickedShiftEnd(context(), { conn, ...block('12:00', '13:00'), date: `${DATE}T00:00:00.000Z` })).toBe(13 * 60);
});

test('with no connection given it reads on the default one', async () => {
  expect(await pickedShiftEnd(context(), block('12:00', '13:00'))).toBe(13 * 60);
  expect(mockLoadTechShifts.mock.calls[0][0]).toBe(mockDb);
});

test('a block the shift does not hold on the clock gets no limit: the picked-hour rule says that one', async () => {
  expect(await pickedShiftEnd(context(), block('07:59', '08:59'))).toBeNull();
  expect(await pickedShiftEnd(context(), block('12:01', '13:01'))).toBeNull();
  expect(await pickedShiftEnd(context(), block('13:00', '14:00'))).toBeNull();
});

test('a block is the longer of its window and its length; with no end it is its length', async () => {
  expect(await pickedShiftEnd(context(), block('12:00', '13:00', { durationMinutes: 61 }))).toBeNull();
  expect(await pickedShiftEnd(context(), block('11:00', '13:00', { durationMinutes: 30 }))).toBe(13 * 60);
  expect(await pickedShiftEnd(context(), block('11:00', '13:01', { durationMinutes: 30 }))).toBeNull();
  expect(await pickedShiftEnd(context(), block('12:00', null))).toBe(13 * 60);
  expect(await pickedShiftEnd(context(), block('12:00', null, { durationMinutes: 61 }))).toBeNull();
  expect(await pickedShiftEnd(context(), block('12:00', '12:00', { durationMinutes: 90 }))).toBeNull();
  // No length either: sixty minutes.
  expect(await pickedShiftEnd(context(), block('12:00', null, { durationMinutes: undefined }))).toBe(13 * 60);
  expect(await pickedShiftEnd(context(), block('12:01', null, { durationMinutes: undefined }))).toBeNull();
  // A start that cannot be read is no block.
  expect(await pickedShiftEnd(context(), block(null, '13:00'))).toBeNull();
});

test('no limit, and no read, with the gate off, with no route, with no technician or with no date', async () => {
  process.env.GATE_TECH_SHIFT_HOURS = 'TRUE';
  expect(await pickedShiftEnd(context(), block('12:00', '13:00'))).toBeNull();
  delete process.env.GATE_TECH_SHIFT_HOURS;
  expect(await pickedShiftEnd(context(), block('12:00', '13:00'))).toBeNull();
  process.env.GATE_TECH_SHIFT_HOURS = 'true';
  expect(await pickedShiftEnd(null, block('12:00', '13:00'))).toBeNull();
  expect(await pickedShiftEnd(context(null), block('12:00', '13:00'))).toBeNull();
  expect(await pickedShiftEnd(context(), { ...block('12:00', '13:00'), date: null })).toBeNull();
  expect(mockLoadTechShifts).not.toHaveBeenCalled();
});

test('a technician with no set hours that day gets no limit', async () => {
  expect(await pickedShiftEnd(context('tech-2'), block('12:00', '13:00'))).toBeNull();
  expect(shiftOf).toHaveBeenCalledWith('tech-2', DATE);
});

test('a failed read is logged and gives no limit: it never fails the check', async () => {
  mockLoadTechShifts.mockRejectedValue(new Error('synthetic read failure'));
  expect(await pickedShiftEnd(context(), block('12:00', '13:00'))).toBeNull();
  expect(mockLogger.warn).toHaveBeenCalledWith(`[arrival-route] shift hours unread for the route check on ${DATE}: synthetic read failure`);
});

test('on a transaction the read runs in its own savepoint, rolled back when it fails', async () => {
  const trx = Object.assign(jest.fn(), { isTransaction: true, raw: jest.fn(async () => {}) });
  expect(await pickedShiftEnd(context(), { conn: trx, ...block('12:00', '13:00') })).toBe(13 * 60);
  const ran = trx.raw.mock.calls.map(([sql]) => sql.replace(/scope_[a-f0-9]+/, 'S'));
  expect(ran).toEqual(['SAVEPOINT S', 'RELEASE SAVEPOINT S']);
  expect(mockLoadTechShifts.mock.calls[0][0]).toBe(trx);
  trx.raw.mockClear();
  mockLoadTechShifts.mockRejectedValue(new Error('synthetic read failure'));
  expect(await pickedShiftEnd(context(), { conn: trx, ...block('12:00', '13:00') })).toBeNull();
  expect(trx.raw.mock.calls.map(([sql]) => sql.replace(/scope_[a-f0-9]+/, 'S'))).toEqual(['SAVEPOINT S', 'ROLLBACK TO SAVEPOINT S', 'RELEASE SAVEPOINT S']);
});
