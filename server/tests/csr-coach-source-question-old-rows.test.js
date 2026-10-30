// source_question ("How did you hear about us?") joined the core points on
// 2026-10-30. A row scored before then has no key for it and was out of 15.
// - The weekly team tip leaves such a row out for that point: counting it as
//   a miss made the new point look missed on every older call.
// - The dashboard averages (and the Best Script Score bonus pick) put each row
//   on the 16-point scale by its own maximum: a CSR with more older calls is
//   not ranked down for a point those calls could not earn.
const mockRows = [];
jest.mock('../models/db', () => jest.fn((table) => ({
  where: jest.fn(() => Promise.resolve(table === 'csr_call_scores' ? mockRows : [])),
})));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const CSRCoach = require('../services/csr/csr-coach');

const OTHER_CORE = ['greeting', 'empathy', 'problem_capture', 'address', 'time_options', 'fee_confirmation', 'name_confirmation', 'callback_number', 'set_expectations', 'strong_close'];
const RESCUE = ['objection_save', 'upsell_attempt', 'urgency_creation', 'referral_mention', 'follow_up_offer'];
const setRows = (rows) => { mockRows.length = 0; mockRows.push(...rows); };

describe('weekly team tip', () => {
  const row = (sourceQuestion, outcome) => {
    const details = Object.fromEntries(OTHER_CORE.map((k) => [k, 1]));
    if (sourceQuestion !== undefined) details.source_question = sourceQuestion;
    return { point_details: details, call_outcome: outcome };
  };
  const olderRows = (n) => Array.from({ length: n }, () => row(undefined, 'not_booked'));

  test('rows scored before source_question existed are not counted as misses', async () => {
    setRows([row(1, 'booked'), row(1, 'booked'), ...olderRows(5)]);
    const rec = await CSRCoach.generateWeeklyTeamRecommendation();
    expect(rec.point).toBeUndefined();
    expect(rec.recommendation).toBe('All script points performing similarly this week.');
  });

  test('the miss rate for source_question counts only rows that were scored on it', async () => {
    setRows([row(1, 'booked'), row(1, 'booked'), row(0, 'not_booked'), row(0, 'not_booked'), ...olderRows(5)]);
    const rec = await CSRCoach.generateWeeklyTeamRecommendation();
    expect(rec.point).toBe('source_question');
    expect(rec.stats).toMatchObject({ bookingRateWith: 100, bookingRateWithout: 0, missRate: 50 });
    expect(rec.recommendation).toMatch(/how did you hear about us/i);
  });
});

describe('dashboard averages and the Best Script Score pick', () => {
  // Every point earned: 15 of 15 before the change, 16 of 16 after it.
  const olderPerfect = (csr) => ({
    csr_name: csr, call_outcome: 'booked', total_score: 15,
    point_details: Object.fromEntries([...OTHER_CORE, ...RESCUE].map((k) => [k, 1])),
  });
  const newerPerfect = (csr) => ({
    csr_name: csr, call_outcome: 'booked', total_score: 16,
    point_details: Object.fromEntries([...OTHER_CORE, 'source_question', ...RESCUE].map((k) => [k, 1])),
  });

  test('a perfect older call and a perfect newer call both average 16 of 16', async () => {
    setRows([olderPerfect('Avery'), newerPerfect('Blake')]);
    const overview = await CSRCoach.getTeamOverview(30);
    const avgByName = Object.fromEntries(overview.csrStats.map((c) => [c.name, c.avgScore]));
    expect(avgByName).toEqual({ Avery: 16, Blake: 16 });
    expect(overview.teamTotals.avgScore).toBe(16);
  });

  test('an older row is scaled by its own maximum: 12 of 15 reads as 12.8 of 16', async () => {
    setRows([{ ...olderPerfect('Avery'), total_score: 12 }]);
    const overview = await CSRCoach.getTeamOverview(30);
    expect(overview.csrStats[0].avgScore).toBe(12.8);
  });

  test('a CSR with only older calls is not ranked below an equal CSR with newer calls', async () => {
    // Blake comes first: on a tie the pick keeps the first CSR, so without the
    // scaling Blake (15 of 16) would tie Avery (15 of 15) and win.
    setRows([{ ...newerPerfect('Blake'), total_score: 15, point_details: { ...newerPerfect('Blake').point_details, follow_up_offer: 0 } }, olderPerfect('Avery')]);
    const board = await CSRCoach.getLeaderboard();
    const best = board.categories.find((c) => c.category === 'Best Script Score');
    expect(best.winner).toBe('Avery');
    expect(best.value).toBe('16/16');
  });
});
