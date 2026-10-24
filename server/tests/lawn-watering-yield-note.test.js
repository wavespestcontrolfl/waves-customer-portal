// A bait's no-water hold that gave way to a label water-in leaves one staff
// note on the customer's next live LAWN visit (lawn-watering-yield-note.js).

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const logger = require('../services/logger');
const { etDateString } = require('../utils/datetime-et');
const { storeLawnWateringYieldNote, yieldNoteText } = require('../services/service-report/lawn-watering-yield-note');

const YIELDED = { holds: ['Advion Insect Granule'], waterIns: ['Dylox 6.2 G'] };
const NOTE = 'The customer was told to water Advion Insect Granule in with Dylox 6.2 G, whose label needs it. The bait may need to go down again.';
const TODAY = etDateString();
// Noon UTC keeps the ET calendar day equal to the UTC one.
const day = (n) => new Date(Date.parse(`${TODAY}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

const SVC = { id: 'svc-done', customer_id: 'cust-1', scheduled_date: TODAY };
const visit = (over) => ({
  id: 'v', customer_id: 'cust-1', status: 'scheduled', technician_id: 'tech-1', service_type: 'Lawn Care', scheduled_date: day(14), ...over,
});

// A chainable stand-in for the knex query: it hands back the rows it was given
// (the module re-checks every rule in code), and records the transaction use.
function fakeDb(rows) {
  const trx = { isTransaction: true, raw: jest.fn(async () => {}) };
  const k = jest.fn(() => {
    const q = {};
    for (const m of ['where', 'whereNot', 'whereNotIn', 'orderBy']) q[m] = jest.fn(() => q);
    q.select = jest.fn(async () => rows);
    return q;
  });
  Object.assign(k, trx);
  return { db: { transaction: jest.fn(async (fn) => fn(k)) }, k };
}

describe('lawn watering yield note', () => {
  test('the note lands on the next lawn visit', async () => {
    const { db, k } = fakeDb([visit({ id: 'v-lawn' })]);
    const storeNote = jest.fn(async () => ({ status: 'written', targetId: 'v-lawn' }));
    const out = await storeLawnWateringYieldNote({ svc: SVC, instruction: { yielded: YIELDED } }, { db, storeNote });
    expect(out).toEqual({ status: 'written', targetId: 'v-lawn' });
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(storeNote).toHaveBeenCalledWith(k, {
      completed: { id: 'svc-done', customerId: 'cust-1', date: TODAY },
      note: NOTE,
      nextVisitId: 'v-lawn',
      actor: {},
    });
  });

  test('skips a nearer pest visit and takes the first lawn visit', async () => {
    const { db } = fakeDb([
      visit({ id: 'v-pest', service_type: 'Quarterly Pest Control', scheduled_date: day(7) }),
      visit({ id: 'v-lawn', scheduled_date: day(14) }),
    ]);
    const storeNote = jest.fn(async () => ({ status: 'written' }));
    await storeLawnWateringYieldNote({ svc: SVC, instruction: { yielded: YIELDED } }, { db, storeNote });
    expect(storeNote.mock.calls[0][1].nextVisitId).toBe('v-lawn');
  });

  test('a next visit that is pest only gets nothing', async () => {
    const { db } = fakeDb([visit({ id: 'v-pest', service_type: 'Quarterly Pest Control' })]);
    const storeNote = jest.fn();
    expect(await storeLawnWateringYieldNote({ svc: SVC, instruction: { yielded: YIELDED } }, { db, storeNote })).toEqual({ status: 'no_lawn_visit' });
    expect(storeNote).not.toHaveBeenCalled();
  });

  test.each([
    ['a cancelled lawn visit', { status: 'cancelled' }],
    ['a lawn visit on or before today', { scheduled_date: TODAY }],
    ['another customer\'s lawn visit', { customer_id: 'cust-2' }],
    ['the completed visit itself', { id: 'svc-done' }],
  ])('%s is never the target', async (_, over) => {
    const { db } = fakeDb([visit(over)]);
    const storeNote = jest.fn();
    expect(await storeLawnWateringYieldNote({ svc: SVC, instruction: { yielded: YIELDED } }, { db, storeNote })).toEqual({ status: 'no_lawn_visit' });
    expect(storeNote).not.toHaveBeenCalled();
  });

  test.each([
    ['no yielded field', { state: 'water_in' }],
    ['an empty holds list', { yielded: { holds: [], waterIns: ['Dylox 6.2 G'] } }],
    ['no instruction', null],
  ])('%s: nothing is read or written', async (_, instruction) => {
    const { db } = fakeDb([visit({})]);
    const storeNote = jest.fn();
    expect(await storeLawnWateringYieldNote({ svc: SVC, instruction }, { db, storeNote })).toEqual({ status: 'skipped' });
    expect(db.transaction).not.toHaveBeenCalled();
    expect(storeNote).not.toHaveBeenCalled();
  });

  test('never throws: a database error is logged and swallowed', async () => {
    const db = { transaction: jest.fn(async () => { const e = new Error('SELECT secret'); e.code = '57P01'; throw e; }) };
    expect(await storeLawnWateringYieldNote({ svc: SVC, instruction: { yielded: YIELDED } }, { db, storeNote: jest.fn() })).toEqual({ status: 'error' });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('57P01'));
    expect(logger.warn.mock.calls[0][0]).not.toContain('secret');
  });

  test('text joins several names with " and "', () => {
    expect(yieldNoteText({ holds: ['A', 'B'], waterIns: ['C', 'D'] })).toBe('The customer was told to water A and B in with C and D, whose label needs it. The bait may need to go down again.');
  });
});

// The real producer: the label ladder records which bait gave way, and to what.
describe('the yield note from a real visit', () => {
  const { buildWateringInstruction } = require('../services/service-report/lawn-watering-instruction');
  const { yieldNoteText } = require('../services/service-report/lawn-watering-yield-note');

  test('Advion Insect Granule beside Dylox: the bait gives way and the note names both', () => {
    const rules = [
      { name: 'Dylox 6.2 G', rule: { mode: 'water_in', water_in_inches: 0.25, water_in_by_hours: 24, water_in_same_day: true, source: 'owner' } },
      { name: 'Advion Insect Granule', rule: { mode: 'hold', hold_hours: 72, yields_to_label_water_in: true, source: 'owner' } },
    ];
    const ins = buildWateringInstruction({ rules, completedAt: '2026-10-27T13:00:00Z', plainWhenNoSetup: true, labelFirst: true });
    expect(ins.state).toBe('water_in');
    expect(yieldNoteText(ins.yielded)).toBe('The customer was told to water Advion Insect Granule in with Dylox 6.2 G, whose label needs it. The bait may need to go down again.');
  });
});
