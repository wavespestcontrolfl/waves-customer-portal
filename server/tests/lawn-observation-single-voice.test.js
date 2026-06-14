const { singleVoiceObservation } = require('../services/service-report/report-data');

// Legacy lawn assessments (pre single-voice fix) stored each photo's/model's
// observations joined with ' | ', which rendered as contradictory run-on prose
// on the customer report. The report now collapses any legacy join to its first
// (primary) segment at read time, so old reports read as one voice without a
// data migration. New assessments already store a single voice and pass through.
describe('singleVoiceObservation', () => {
  test('collapses a legacy " | "-joined narrative to its first segment', () => {
    const joined = 'Lawn shows a mix of St. Augustine with weed intrusion. | St. Augustine shows good density. | Lawn appears healthy with minor weeds.';
    expect(singleVoiceObservation(joined)).toBe('Lawn shows a mix of St. Augustine with weed intrusion.');
  });

  test('passes a single-voice observation through unchanged', () => {
    const single = 'St. Augustine turf with good density and a few weeds near the driveway.';
    expect(singleVoiceObservation(single)).toBe(single);
  });

  test('does not split on a bare pipe without surrounding spaces', () => {
    // The join separator is specifically " | "; a stray pipe is left intact.
    expect(singleVoiceObservation('Zone A|B treated')).toBe('Zone A|B treated');
  });

  test('handles null/empty safely', () => {
    expect(singleVoiceObservation(null)).toBe('');
    expect(singleVoiceObservation('')).toBe('');
  });
});
