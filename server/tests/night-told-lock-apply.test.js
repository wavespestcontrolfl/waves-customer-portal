// Night told-lock (owner 2026-11-05, "D1 a") at the apply-time grouped-sibling
// guards: with lock24h (the run always passes it), the tiers and flex sibling
// freeze reads pass { lock24h: true, toldLock: true } to loadReminderFreeze, and
// a sibling the customer was already told a time for refuses the move. Without
// lock24h the helpers make the plain 72-hour calls. Synthetic ids only.
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
  test('passes { lock24h, toldLock } and refuses a frozen sibling with a text that says the customer was already told', async () => {
    routeTiers.loadReminderFreeze.mockResolvedValue(FROZEN);
    const trx = jest.fn();
    await expect(checkTiersSiblingBounds(trx, [sib], [sib], { date: dayOffset(6) }, TODAY, refuse, true))
      .rejects.toMatchObject({ id: 's2', why: expect.stringContaining('already told its time') });
    expect(routeTiers.loadReminderFreeze).toHaveBeenLastCalledWith(trx, ['s2'], expect.any(Date), undefined, { lock24h: true, toldLock: true });
  });

  test('without lock24h the call is the plain 72-hour one', async () => {
    routeTiers.loadReminderFreeze.mockResolvedValue(FROZEN);
    const trx = jest.fn();
    await expect(checkTiersSiblingBounds(trx, [sib], [sib], { date: dayOffset(6) }, TODAY, refuse))
      .rejects.toMatchObject({ why: 'is inside its 72-hour reminder window (frozen)' });
    expect(routeTiers.loadReminderFreeze).toHaveBeenLastCalledWith(trx, ['s2'], expect.any(Date));
  });
});

describe('checkFlexSiblingBounds', () => {
  test('25 h band with { lock24h, toldLock }; without lock24h the plain 73 h call', async () => {
    routeTiers.loadReminderFreeze.mockResolvedValue(FROZEN);
    const trx = jest.fn();
    await expect(checkFlexSiblingBounds(trx, [sib], [sib], { date: dayOffset(6) }, TODAY, refuse, [], true))
      .rejects.toMatchObject({ id: 's2' });
    expect(routeTiers.loadReminderFreeze).toHaveBeenLastCalledWith(trx, ['s2'], expect.any(Date), 25, { lock24h: true, toldLock: true });
    await expect(checkFlexSiblingBounds(trx, [sib], [sib], { date: dayOffset(6) }, TODAY, refuse, [])).rejects.toBeTruthy();
    expect(routeTiers.loadReminderFreeze).toHaveBeenLastCalledWith(trx, ['s2'], expect.any(Date), 73);
  });
});

// The moving visit's OWN told-time check inside its move transaction (pre-push P1: a promise delivered while the run
// scored the move, after the pass-1 re-check, must still stop it; makeMemberGuard covers siblings only).
describe('assertNotToldOnMove (the primary visit, on the move transaction)', () => {
  const config = {};
  const row = { id: 'v1' };

  test('a visit told its time meanwhile is refused', async () => {
    toldVisits.loadToldVisitIds.mockResolvedValue(new Set(['v1']));
    const trx = jest.fn();
    await expect(assertNotToldOnMove(trx, row, config, refuse))
      .rejects.toMatchObject({ id: 'v1', why: 'has a time the customer was already told (frozen)' });
    expect(toldVisits.loadToldVisitIds).toHaveBeenCalledWith(trx, ['v1'], expect.any(Date));
  });

  test('no promise with a known slot lets the move go on', async () => {
    toldVisits.loadToldVisitIds.mockResolvedValue(new Set());
    await expect(assertNotToldOnMove(jest.fn(), row, config, refuse)).resolves.toBeUndefined();
  });

  test('a failed promise read throws, so nothing moves (fail closed)', async () => {
    toldVisits.loadToldVisitIds.mockRejectedValue(new Error('read failed'));
    await expect(assertNotToldOnMove(jest.fn(), row, config, refuse)).rejects.toThrow('read failed');
  });
});
