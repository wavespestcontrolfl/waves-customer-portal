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
