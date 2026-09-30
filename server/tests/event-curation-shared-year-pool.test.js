/**
 * Codex P2 (2026-09-27), event-curation.js:195 "Reuse the calendar-year pool
 * across eligibility filters" — covered by the STRUCTURAL consolidation:
 * runCurationEligibilityPipeline now loads ONE calendar-year identity pool
 * per pipeline run (newsletter-event-selection.js's loadSharedYearPool) and
 * threads it into BOTH filterRepeatedDateIdentities and
 * filterPreviouslyFeaturedIdentities via their `yearPool` option, instead of
 * each loading (and paying for) its own copy.
 *
 * newsletter-event-selection.js is mocked entirely so this isolates the
 * ORCHESTRATION in event-curation.js — how many times the pool loader is
 * called, and whether both filters actually receive the SAME pool — from
 * the filters' own internal logic (covered elsewhere).
 */

jest.mock('../services/newsletter-event-selection', () => ({
  filterRepeatedDateIdentities: jest.fn(),
  filterPreviouslyFeaturedIdentities: jest.fn(),
  loadSharedYearPool: jest.fn(),
}));

const {
  filterRepeatedDateIdentities,
  filterPreviouslyFeaturedIdentities,
  loadSharedYearPool,
} = require('../services/newsletter-event-selection');
const { runCurationEligibilityPipeline } = require('../services/event-curation');

beforeEach(() => jest.clearAllMocks());

describe('runCurationEligibilityPipeline shares ONE year identity pool per run', () => {
  test('loadSharedYearPool is called exactly once, and both filters receive the SAME pool instance', async () => {
    const rows = [{ id: 'a' }, { id: 'b' }];
    const yearPool = [{ id: 'evidence-row' }];
    const reference = new Date('2026-09-27T12:00:00Z');

    loadSharedYearPool.mockResolvedValue(yearPool);
    filterRepeatedDateIdentities.mockResolvedValue([{ id: 'a' }]);
    filterPreviouslyFeaturedIdentities.mockResolvedValue([{ id: 'a' }]);

    await runCurationEligibilityPipeline(rows, { reference });

    expect(loadSharedYearPool).toHaveBeenCalledTimes(1);
    expect(loadSharedYearPool).toHaveBeenCalledWith(expect.anything(), rows, reference);

    expect(filterRepeatedDateIdentities).toHaveBeenCalledTimes(1);
    expect(filterRepeatedDateIdentities.mock.calls[0][1].yearPool).toBe(yearPool);

    expect(filterPreviouslyFeaturedIdentities).toHaveBeenCalledTimes(1);
    expect(filterPreviouslyFeaturedIdentities.mock.calls[0][1].yearPool).toBe(yearPool);
  });

  test('a custom knex handle is threaded through to the pool loader and both filters', async () => {
    const rows = [{ id: 'a' }];
    const yearPool = [];
    const customKnex = jest.fn();
    loadSharedYearPool.mockResolvedValue(yearPool);
    filterRepeatedDateIdentities.mockResolvedValue([]);
    filterPreviouslyFeaturedIdentities.mockResolvedValue([]);

    await runCurationEligibilityPipeline(rows, { knex: customKnex });

    expect(loadSharedYearPool).toHaveBeenCalledWith(customKnex, rows, expect.any(Date));
    expect(filterRepeatedDateIdentities.mock.calls[0][1].knex).toBe(customKnex);
    expect(filterPreviouslyFeaturedIdentities.mock.calls[0][1].knex).toBe(customKnex);
  });
});
