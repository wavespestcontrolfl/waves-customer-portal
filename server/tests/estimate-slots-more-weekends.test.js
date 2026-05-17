const { _internals: findTimeInternals } = require('../services/scheduling/find-time');
const { _internals: slotAvailabilityInternals } = require('../services/estimate-slot-availability');

describe('estimate slot weekend and expander behavior', () => {
  test('find-time keeps legacy Sunday skip unless includeWeekends is enabled', () => {
    expect(findTimeInternals.enumerateDates('2026-05-16', '2026-05-18')).toEqual([
      '2026-05-16',
      '2026-05-18',
    ]);

    expect(findTimeInternals.enumerateDates('2026-05-16', '2026-05-18', { includeWeekends: true })).toEqual([
      '2026-05-16',
      '2026-05-17',
      '2026-05-18',
    ]);
  });

  test('estimate availability returns three visible slots plus three more slots', () => {
    const slots = Array.from({ length: 8 }, (_, idx) => ({ slotId: `slot-${idx + 1}` }));

    expect(slotAvailabilityInternals.splitSlotResults(slots, 3, 3)).toEqual({
      primary: [{ slotId: 'slot-1' }, { slotId: 'slot-2' }, { slotId: 'slot-3' }],
      expander: [{ slotId: 'slot-4' }, { slotId: 'slot-5' }, { slotId: 'slot-6' }],
    });
  });
});
