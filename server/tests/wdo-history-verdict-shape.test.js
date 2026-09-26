// Codex r11 on #4884: an answer without the contract's verdict fields (e.g. {})
// used to normalize into an all-unknown "resolved" history that was cached and
// left the wdo_history ledger row successful. It must be a failed lookup.
const { _private: { normalizeHistory, parseJson } } = require('../services/property-lookup/wdo-history-lookup');

describe('wdo history — verdict fields are required', () => {
  test.each([
    ['{}', {}],
    ['missing confidence', { previousTreatment: 'unknown' }],
    ['missing previousTreatment', { confidence: 'low' }],
    ['off-contract previousTreatment', { previousTreatment: 'maybe', confidence: 'low' }],
    ['off-contract confidence', { previousTreatment: 'no', confidence: 'certain' }],
  ])('%s is not a usable history', (_label, parsed) => {
    expect(normalizeHistory(parsed)).toBeNull();
  });

  test('null stays null', () => {
    expect(normalizeHistory(parseJson('not json'))).toBeNull();
  });

  test('a contract answer — including an honest "unknown / low" — normalizes', () => {
    expect(normalizeHistory({ previousTreatment: 'unknown', confidence: 'low' })).toMatchObject({ previousTreatment: 'unknown', confidence: 'low', permits: [], sources: [] });
    expect(normalizeHistory({ previousTreatment: ' Yes ', confidence: 'HIGH', sources: ['https://example.com'] })).toMatchObject({ previousTreatment: 'yes', confidence: 'high' });
  });
});

// The prompt allows "yes" ONLY with a concrete source; an uncited "yes" would
// pre-fill a legal FDACS-13645 filing.
describe('wdo history — a "yes" verdict needs a cited source', () => {
  test('"yes" with no http(s) source is not a usable history', () => {
    expect(normalizeHistory({ previousTreatment: 'yes', confidence: 'high' })).toBeNull();
    expect(normalizeHistory({ previousTreatment: 'yes', confidence: 'high', sources: [] })).toBeNull();
    expect(normalizeHistory({ previousTreatment: 'yes', confidence: 'high', sources: ['county permit #123', 'javascript:alert(1)'] })).toBeNull();
  });

  test('"yes" with a cited URL, and "no"/"unknown" without one, normalize', () => {
    expect(normalizeHistory({ previousTreatment: 'yes', confidence: 'medium', sources: ['https://www.manateepao.gov/permit/123'] }))
      .toMatchObject({ previousTreatment: 'yes', sources: ['https://www.manateepao.gov/permit/123'] });
    expect(normalizeHistory({ previousTreatment: 'unknown', confidence: 'low', sources: [] })).toMatchObject({ previousTreatment: 'unknown' });
  });
});
