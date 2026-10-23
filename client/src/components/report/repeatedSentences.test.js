import { describe, expect, it } from 'vitest';
import { withoutRepeatedSentences, statusCardWords } from './repeatedSentences';

// The live cards of 2026-10-23 (customer details left out).
const TERMITE = {
  status: { label: 'No termite activity observed' },
  statusSummary: 'We inspected all 22 bait stations around the property today. No termite activity was observed at the stations inspected.',
  metrics: [
    { label: 'Stations inspected', value: '22 of 22' },
    { label: 'Termite activity', value: 'None observed' },
    { label: 'Stations serviced', value: '0' },
    { label: 'Bait condition', value: 'Intact' },
  ],
};
const ROACH = {
  status: { label: 'High cockroach activity' },
  statusSummary: 'We applied an insect growth regulator, treated cracks and crevices and completed a flush-out treatment today.',
  metrics: [{ label: 'Activity today', value: 'Heavy' }],
};

describe('withoutRepeatedSentences', () => {
  it('drops the termite narrative that restates the status line and the rows three times', () => {
    const narrative = 'No termite activity was observed in the accessible bait stations today. We inspected 22 termite bait stations around the exterior perimeter today. 22 of 22 stations were inspected.';
    expect(withoutRepeatedSentences(narrative, statusCardWords(TERMITE))).toBeNull();
  });

  it('keeps the cockroach sentence that adds a recommendation, drops the word-for-word repeat', () => {
    const narrative = 'Cockroach activity was high today. We applied an insect growth regulator, treated cracks and crevices and completed a flush-out treatment today. A follow-up visit in 10–14 days is recommended to stay ahead of newly hatching activity.';
    expect(withoutRepeatedSentences(narrative, statusCardWords(ROACH)))
      .toBe('A follow-up visit in 10–14 days is recommended to stay ahead of newly hatching activity.');
  });

  it('keeps a written report that adds facts', () => {
    const narrative = 'We found droppings behind the refrigerator and under the sink. We placed gel bait in both spots and sealed the gap at the dishwasher line.';
    expect(withoutRepeatedSentences(narrative, statusCardWords(ROACH))).toBe(narrative);
  });

  it('keeps every word of a four-section report the page shows with titles', () => {
    const text = 'We applied an insect growth regulator, treated cracks and crevices and completed a flush-out treatment today.';
    const sections = [{ key: 'whatWeDid', title: 'What we did', paragraphs: [text] }];
    expect(withoutRepeatedSentences(text, statusCardWords(ROACH), sections)).toBe(text);
  });

  it('returns the text unchanged when the card prints nothing to compare with', () => {
    expect(withoutRepeatedSentences('Some text.', [])).toBe('Some text.');
    expect(withoutRepeatedSentences('', statusCardWords(ROACH))).toBeNull();
  });
});
