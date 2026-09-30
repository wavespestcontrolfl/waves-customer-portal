// Cancel-flow holds tell the moved visits' techs only once the WHOLE
// accepted action stands (Codex #3887 r7 P1): a later family's failure or
// a failed Away Mode write compensates every hold this accept made, and
// those compensating moves are silent — so a card emitted per hold would
// describe a move that was reverted. The same holds for the visits inside the
// pause (owner rulings 2026-09-29): a skip is one-way, so it runs only after
// every family and the paired Away Mode write stand.
const mockStartHold = jest.fn();
const mockCancelHold = jest.fn().mockResolvedValue(true);
const mockStartAwayMode = jest.fn();
const mockEmit = jest.fn();
const mockSkips = jest.fn().mockResolvedValue(undefined);

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/cancellation-resolution/holds', () => ({
  startHold: (...a) => mockStartHold(...a),
  cancelHold: (...a) => mockCancelHold(...a),
  startAwayMode: (...a) => mockStartAwayMode(...a),
  emitHoldTechNotices: (...a) => mockEmit(...a),
  applyHoldSkips: (...a) => mockSkips(...a),
}));

const { executeAcceptedAction } = require('../services/cancellation-resolution/actions');

const caseRow = { id: 'case-1' };
const notice = (visitId) => ({ visitId, technicianId: 'tech-1', actorId: 'customer', previous: {}, snapshot: {} });
const hold = (familyKey, visits) => ({ holdId: `h-${familyKey}`, familyKey, resumeOn: '2026-11-01', resumeDisplay: 'Nov 1', moved: visits.length, pendingSkips: [{ id: `skip-${familyKey}`, status: 'confirmed', from: '2026-10-10' }], techNotices: visits.map(notice) });
const notNeeded = (familyKey, nextVisitDisplay = null) => ({ notNeeded: true, familyKey, nextVisitOn: nextVisitDisplay ? '2026-11-05' : null, nextVisitDisplay });

beforeEach(() => {
  jest.clearAllMocks();
  mockCancelHold.mockResolvedValue(true);
  mockSkips.mockResolvedValue(undefined);
});

test('multi-family hold: every family\'s notices go out together, after the last hold committed', async () => {
  mockStartHold
    .mockResolvedValueOnce(hold('lawn_care', ['v1', 'v2']))
    .mockResolvedValueOnce(hold('mosquito', ['v3']));
  const out = await executeAcceptedAction({
    customerId: 'c1', caseRow, action: { type: 'hold' }, params: { resumeDate: '2026-11-01' }, families: ['lawn_care', 'mosquito'],
  });
  expect(mockEmit).toHaveBeenCalledTimes(1);
  expect(mockEmit).toHaveBeenCalledWith([notice('v1'), notice('v2'), notice('v3')]);
  expect(mockEmit.mock.invocationCallOrder[0]).toBeGreaterThan(mockStartHold.mock.invocationCallOrder[1]);
  // Every family's in-pause visits are skipped in one pass, only after the last hold stands.
  expect(mockSkips).toHaveBeenCalledTimes(1);
  expect(mockSkips.mock.calls[0][0].map((h) => h.holdId)).toEqual(['h-lawn_care', 'h-mosquito']);
  expect(mockSkips.mock.invocationCallOrder[0]).toBeGreaterThan(mockStartHold.mock.invocationCallOrder[1]);
  // The notices never leak into the accept response.
  expect(out).not.toHaveProperty('techNotices');
  expect(out).not.toHaveProperty('holdResults');
  expect(out.holds).toEqual(['h-lawn_care', 'h-mosquito']);
});

test('a later family\'s failure compensates the earlier hold and tells NOBODY', async () => {
  mockStartHold
    .mockResolvedValueOnce(hold('lawn_care', ['v1']))
    .mockRejectedValueOnce(Object.assign(new Error('unmovable'), { code: 'hold_visits_unmovable' }));
  await expect(executeAcceptedAction({
    customerId: 'c1', caseRow, action: { type: 'hold' }, params: {}, families: ['lawn_care', 'mosquito'],
  })).rejects.toMatchObject({ code: 'hold_visits_unmovable' });
  expect(mockCancelHold).toHaveBeenCalledWith('h-lawn_care', { compensateVisits: true });
  expect(mockEmit).not.toHaveBeenCalled();
  expect(mockSkips).not.toHaveBeenCalled();
});

test('a hold that finds nothing inside the pause is refused; in a multi-family accept the other family is still held and the customer is told nothing changes for it', async () => {
  mockStartHold.mockResolvedValueOnce(notNeeded('lawn_care', 'November 5, 2026'));
  await expect(executeAcceptedAction({
    customerId: 'c1', caseRow, action: { type: 'hold' }, params: {}, families: ['lawn_care'],
  })).rejects.toMatchObject({ code: 'hold_not_needed', message: expect.stringContaining('November 5, 2026') });
  expect(mockCancelHold).not.toHaveBeenCalled();
  expect(mockEmit).not.toHaveBeenCalled();
  expect(mockSkips).not.toHaveBeenCalled();

  jest.clearAllMocks();
  mockStartHold
    .mockResolvedValueOnce(notNeeded('lawn_care', 'November 5, 2026'))
    .mockResolvedValueOnce(hold('mosquito', []));
  const out = await executeAcceptedAction({
    customerId: 'c1', caseRow, action: { type: 'hold' }, params: { resumeDate: '2026-11-01' }, families: ['lawn_care', 'mosquito'],
  });
  expect(out.holds).toEqual(['h-mosquito']);
  expect(out.effects.join(' ')).toContain('visit is November 5, 2026, after you are back, so nothing changes for it');
  expect(mockSkips.mock.calls[0][0].map((h) => h.holdId)).toEqual(['h-mosquito']);
});

test('away pairing: the hold notices wait for Away Mode; a failed Away Mode compensates the holds and tells nobody', async () => {
  mockStartHold.mockResolvedValueOnce(hold('lawn_care', ['v1']));
  mockStartAwayMode.mockResolvedValueOnce({ until: null, effects: [] });
  const out = await executeAcceptedAction({
    customerId: 'c1', caseRow, action: { type: 'away_pairing' }, params: {}, families: ['lawn_care'],
  });
  expect(mockEmit).toHaveBeenCalledTimes(1);
  expect(mockEmit).toHaveBeenCalledWith([notice('v1')]);
  expect(mockEmit.mock.invocationCallOrder[0]).toBeGreaterThan(mockStartAwayMode.mock.invocationCallOrder[0]);
  // The skips wait for Away Mode too.
  expect(mockSkips).toHaveBeenCalledTimes(1);
  expect(mockSkips.mock.invocationCallOrder[0]).toBeGreaterThan(mockStartAwayMode.mock.invocationCallOrder[0]);
  expect(out).not.toHaveProperty('techNotices');
  expect(out).not.toHaveProperty('holdResults');

  jest.clearAllMocks();
  mockStartHold.mockResolvedValueOnce(hold('lawn_care', ['v1']));
  mockStartAwayMode.mockRejectedValueOnce(new Error('away write failed'));
  await expect(executeAcceptedAction({
    customerId: 'c1', caseRow, action: { type: 'away_pairing' }, params: {}, families: ['lawn_care'],
  })).rejects.toThrow('away write failed');
  expect(mockCancelHold).toHaveBeenCalledWith('h-lawn_care', { compensateVisits: true });
  expect(mockEmit).not.toHaveBeenCalled();
  expect(mockSkips).not.toHaveBeenCalled();
});
