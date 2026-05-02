const {
  buildPrompt,
  composeCompletionSmsPreview,
  deterministicRecap,
  normalizeOutcome,
} = require('../services/completion-recap');

describe('completion recap', () => {
  test('deterministic inspection-only recap avoids treatment claims', () => {
    const recap = deterministicRecap({
      visitOutcome: 'inspection_only',
      serviceType: 'Quarterly Pest Control',
      areasTreated: ['Garage', 'Entry points'],
    });

    expect(recap).toContain('inspection');
    expect(recap).toContain('Garage, Entry points');
    expect(recap).not.toMatch(/treated|applied/i);
  });

  test('prompt includes areas but prohibits product and pricing details', () => {
    const prompt = buildPrompt({
      serviceType: 'Lawn Care',
      notes: 'Applied product around front yard and checked irrigation.',
      areasTreated: ['Front yard', 'Irrigation zone'],
    });

    expect(prompt).toContain('Front yard, Irrigation zone');
    expect(prompt).toContain('Never mention product names');
    expect(prompt).toContain('prices');
  });

  test('sms preview suppresses review placeholder when invoice is present', () => {
    const preview = composeCompletionSmsPreview({
      recap: 'Today we completed your service.',
      willInvoice: true,
      willReview: true,
    });

    expect(preview).toContain('[pay link inserted]');
    expect(preview).not.toContain('[review link inserted]');
  });

  test('normalizes empty outcome to completed', () => {
    expect(normalizeOutcome('')).toBe('completed');
  });
});
