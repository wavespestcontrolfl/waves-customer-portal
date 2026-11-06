// GATE_NIGHT_TOLD_LOCK (owner 2026-11-05, "D1 a") at the apply-time grouped-sibling
// guards: with the run's config carrying nightLock24h AND nightToldLock, the
// tiers and flex sibling freeze reads pass { lock24h: true, toldLock: true } to
// loadReminderFreeze, and a sibling the customer was already told a time for refuses the
// move. Gate off or nightLock24h off: the exact calls of today. Synthetic ids only.
jest.mock('../services/auto-dispatch/eligibility', () => ({
  ...jest.requireActual('../services/auto-dispatch/eligibility'),
  isPersonPlacedVisit: jest.fn(async () => ({ placed: false })),
}));
jest.mock('../services/auto-dispatch/route-tiers', () => ({
  ...jest.requireActual('../services/auto-dispatch/route-tiers'),
  loadReminderFreeze: jest.fn(),
}));

jest.mock('../services/auto-dispatch/told-visits', () => ({ loadToldVisitIds: jest.fn() }));

const routeTiers = require('../services/auto-dispatch/route-tiers');
const toldVisits = require('../services/auto-dispatch/told-visits');
const { checkFlexSiblingBounds, checkTiersSiblingBounds, assertNotToldOnMove } = require('../services/auto-dispatch/apply');
const { etDateString, addETDays, parseETDateTime } = require('../utils/datetime-et');

const TODAY = etDateString(new Date());
const dayOffset = (n) => etDateString(addETDays(parseETDateTime(`${TODAY}T12:00`), n));
const refuse = (id, why) => Object.assign(new Error(`refused ${id}: ${why}`), { code: 'TEST_REFUSE', id, why });
const sib = { id: 's2', scheduled_date: dayOffset(2), window_start: '09:00:00', is_recurring: true, recurring_parent_id: 'p1' };
const FROZEN = { failed: false, frozen: new Set(['s2']) };

beforeEach(() => { jest.clearAllMocks(); });

describe('checkTiersSiblingBounds', () => {
  test('told-lock on: passes { lock24h, toldLock } and refuses a frozen sibling with a text that says the customer was already told', async () => {
    routeTiers.loadReminderFreeze.mockResolvedValue(FROZEN);
    const trx = jest.fn();
    await expect(checkTiersSiblingBounds(trx, [sib], [sib], { date: dayOffset(6) }, TODAY, refuse, true, true))
      .rejects.toMatchObject({ id: 's2', why: expect.stringContaining('already told its time') });
    expect(routeTiers.loadReminderFreeze).toHaveBeenLastCalledWith(trx, ['s2'], expect.any(Date), undefined, { lock24h: true, toldLock: true });
  });

  test('told-lock off: the call is exactly today\'s', async () => {
    routeTiers.loadReminderFreeze.mockResolvedValue(FROZEN);
    const trx = jest.fn();
    await expect(checkTiersSiblingBounds(trx, [sib], [sib], { date: dayOffset(6) }, TODAY, refuse, true, false))
      .rejects.toMatchObject({ why: 'is inside its 24-hour reminder window (frozen)' });
    expect(routeTiers.loadReminderFreeze).toHaveBeenLastCalledWith(trx, ['s2'], expect.any(Date), undefined, { lock24h: true });
    await expect(checkTiersSiblingBounds(trx, [sib], [sib], { date: dayOffset(6) }, TODAY, refuse))
      .rejects.toMatchObject({ why: 'is inside its 72-hour reminder window (frozen)' });
    expect(routeTiers.loadReminderFreeze).toHaveBeenLastCalledWith(trx, ['s2'], expect.any(Date));
  });

  test('toldLock without lock24h is ignored (no option at all)', async () => {
    routeTiers.loadReminderFreeze.mockResolvedValue(FROZEN);
    const trx = jest.fn();
    await expect(checkTiersSiblingBounds(trx, [sib], [sib], { date: dayOffset(6) }, TODAY, refuse, false, true)).rejects.toBeTruthy();
    expect(routeTiers.loadReminderFreeze).toHaveBeenLastCalledWith(trx, ['s2'], expect.any(Date));
  });
});

describe('checkFlexSiblingBounds', () => {
  test('told-lock on: 25 h band with { lock24h, toldLock }; off: { lock24h } only', async () => {
    routeTiers.loadReminderFreeze.mockResolvedValue(FROZEN);
    const trx = jest.fn();
    await expect(checkFlexSiblingBounds(trx, [sib], [sib], { date: dayOffset(6) }, TODAY, refuse, [], true, true))
      .rejects.toMatchObject({ id: 's2' });
    expect(routeTiers.loadReminderFreeze).toHaveBeenLastCalledWith(trx, ['s2'], expect.any(Date), 25, { lock24h: true, toldLock: true });
    await expect(checkFlexSiblingBounds(trx, [sib], [sib], { date: dayOffset(6) }, TODAY, refuse, [], true, false)).rejects.toBeTruthy();
    expect(routeTiers.loadReminderFreeze).toHaveBeenLastCalledWith(trx, ['s2'], expect.any(Date), 25, { lock24h: true });
    await expect(checkFlexSiblingBounds(trx, [sib], [sib], { date: dayOffset(6) }, TODAY, refuse, [])).rejects.toBeTruthy();
    expect(routeTiers.loadReminderFreeze).toHaveBeenLastCalledWith(trx, ['s2'], expect.any(Date), 73);
  });
});

// The moving visit's OWN told-time check inside its move transaction (pre-push P1: a promise delivered while the run
// scored the move, after the pass-1 re-check, must still stop it; makeMemberGuard covers siblings only).
describe('assertNotToldOnMove (the primary visit, on the move transaction)', () => {
  const both = { nightLock24h: true, nightToldLock: true };
  const row = { id: 'v1' };

  test('told-lock on: a visit told its time meanwhile is refused', async () => {
    toldVisits.loadToldVisitIds.mockResolvedValue(new Set(['v1']));
    const trx = jest.fn();
    await expect(assertNotToldOnMove(trx, row, both, refuse))
      .rejects.toMatchObject({ id: 'v1', why: 'has a time the customer was already told (frozen)' });
    expect(toldVisits.loadToldVisitIds).toHaveBeenCalledWith(trx, ['v1'], expect.any(Date));
  });

  test('told-lock on: no promise with a known slot lets the move go on', async () => {
    toldVisits.loadToldVisitIds.mockResolvedValue(new Set());
    await expect(assertNotToldOnMove(jest.fn(), row, both, refuse)).resolves.toBeUndefined();
  });

  test('told-lock on: a failed promise read throws, so nothing moves (fail closed)', async () => {
    toldVisits.loadToldVisitIds.mockRejectedValue(new Error('read failed'));
    await expect(assertNotToldOnMove(jest.fn(), row, both, refuse)).rejects.toThrow('read failed');
  });

  test('gate off, or the 24-hour lock off: no promise read at all (today)', async () => {
    await assertNotToldOnMove(jest.fn(), row, { nightLock24h: true, nightToldLock: false }, refuse);
    await assertNotToldOnMove(jest.fn(), row, { nightLock24h: false, nightToldLock: true }, refuse);
    await assertNotToldOnMove(jest.fn(), row, {}, refuse);
    expect(toldVisits.loadToldVisitIds).not.toHaveBeenCalled();
  });
});
