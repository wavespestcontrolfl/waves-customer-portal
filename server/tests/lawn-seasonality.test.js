// Seasonality + dormancy logic. Two things must hold: (1) the weather-aware adjustment
// is a strict superset — with NO temp it reproduces the legacy month-bucket multipliers
// exactly (no silent score drift); (2) with real low temps it MEASURES dormancy instead
// of guessing by the calendar.

const {
  getSeason, dormancyPressure, seasonAwareAdjustment, dormancyLikely,
  crossSeasonNote, crossSeasonNoteFromSeasons,
} = require('../services/service-report/lawn-seasonality');
const { applySeasonalAdjustment } = require('../services/lawn-assessment');

describe('lawn-seasonality', () => {
  describe('seasonAwareAdjustment — calendar fallback matches legacy exactly', () => {
    const SCORES = { turf_density: 70, color_health: 64, weed_suppression: 80 };
    for (const month of [1, 2, 3, 4, 5, 6, 9, 10, 11, 12]) {
      test(`month ${month} (${getSeason(month)})`, () => {
        const legacy = applySeasonalAdjustment(SCORES, month);
        const next = seasonAwareAdjustment(SCORES, { month });
        expect(next.turf_density).toBe(legacy.turf_density);
        expect(next.color_health).toBe(legacy.color_health);
        expect(next.weed_suppression).toBe(legacy.weed_suppression); // untouched key preserved
      });
    }
  });

  describe('dormancyPressure — weather beats the calendar', () => {
    test('warm nights in calendar winter → no dormancy', () => {
      expect(dormancyPressure({ month: 1, recentMinTempF: 68 })).toBe('none');
    });
    test('cold snap in shoulder season → strong dormancy', () => {
      expect(dormancyPressure({ month: 11, recentMinTempF: 46 })).toBe('strong');
    });
    test('mild band', () => {
      expect(dormancyPressure({ month: 12, recentMinTempF: 55 })).toBe('mild');
    });
    test('no temp → calendar', () => {
      expect(dormancyPressure({ month: 1 })).toBe('strong');
      expect(dormancyPressure({ month: 6 })).toBe('none');
    });
  });

  test('weather-driven adjustment: a warm December does NOT inflate a low color score', () => {
    const scores = { turf_density: 60, color_health: 50 };
    const calendar = seasonAwareAdjustment(scores, { month: 12 }); // strong → ×1.25 color
    const warm = seasonAwareAdjustment(scores, { month: 12, recentMinTempF: 70 }); // none → ×1
    expect(calendar.color_health).toBe(63); // 50*1.25
    expect(warm.color_health).toBe(50); // measured warm → no boost; low color is a REAL signal
  });

  describe('dormancyLikely', () => {
    test('cool season + low color + no other stress → seasonal', () => {
      expect(dormancyLikely({ colorHealth: 60, stressDamage: 80, month: 1 }).likely).toBe(true);
    });
    test('warm + low color → NOT seasonal (real issue)', () => {
      expect(dormancyLikely({ colorHealth: 60, stressDamage: 80, month: 1, recentMinTempF: 72 }).likely).toBe(false);
    });
    test('cool + low color + real stress present → NOT just dormancy', () => {
      expect(dormancyLikely({ colorHealth: 60, stressDamage: 30, month: 1 }).likely).toBe(false);
    });
    test('peak season healthy color → not flagged', () => {
      expect(dormancyLikely({ colorHealth: 82, stressDamage: 80, month: 6 }).likely).toBe(false);
    });
  });

  describe('crossSeasonNote', () => {
    test('summer → winter flags a seasonal note', () => {
      expect(crossSeasonNote('2026-07-01', '2026-01-10')).toMatch(/seasonal/i);
    });
    test('same season → no note', () => {
      expect(crossSeasonNote('2026-06-01', '2026-07-01')).toBeNull();
    });
    test('from season strings', () => {
      expect(crossSeasonNoteFromSeasons('peak', 'dormant')).toMatch(/seasonal/i);
      expect(crossSeasonNoteFromSeasons('peak', 'peak')).toBeNull();
    });
  });
});
