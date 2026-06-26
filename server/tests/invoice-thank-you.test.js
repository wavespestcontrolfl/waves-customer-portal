/**
 * AI thank-you message generator (invoice email body, separate from the
 * service summary). Pure prompt-builder + the no-context / no-key guard rails
 * are unit-tested here; the live Claude call is covered in CI where the SDK +
 * key exist.
 */

const {
  buildThankYouPrompt,
  generateThankYouMessage,
} = require('../services/invoice-ai-summary');

describe('invoice AI thank-you message', () => {
  test('prompt enforces guardrails: no greeting, no products/prices, no overpromising', () => {
    const prompt = buildThankYouPrompt({
      customerName: 'Jane Smith',
      serviceType: 'Quarterly Pest Control',
    });
    expect(prompt).toContain('1 to 2 sentences');
    expect(prompt).toContain('Do NOT include a greeting');
    expect(prompt).toContain('prices');
    expect(prompt).toContain('eliminated, guaranteed, pest-free');
    // Context is surfaced for grounding.
    expect(prompt).toContain('Customer: Jane Smith');
    expect(prompt).toContain('Service: Quarterly Pest Control');
  });

  test('prompt folds the operator emphasis hint in and omits empty context', () => {
    const withHint = buildThankYouPrompt({ input: 'thank them for being a long-time customer' });
    expect(withHint).toContain('What to emphasize: thank them for being a long-time customer');
    expect(withHint).not.toContain('Customer:');
    expect(withHint).not.toContain('Service:');

    const empty = buildThankYouPrompt({});
    expect(empty).toContain('[no extra context]');
  });

  test('generateThankYouMessage refuses when there is nothing to work from', async () => {
    const result = await generateThankYouMessage({});
    expect(result).toEqual({ error: 'Select a customer or add a note first' });
  });

  test('generateThankYouMessage surfaces a clear error when AI is unavailable', async () => {
    // No ANTHROPIC_API_KEY in the unit env → aiSummary returns null rather than
    // throwing, so the caller gets a friendly error, not a 500.
    const prevKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const result = await generateThankYouMessage({ customerName: 'Jane Smith' });
      expect(result).toEqual({ error: 'AI did not return a message' });
    } finally {
      if (prevKey !== undefined) process.env.ANTHROPIC_API_KEY = prevKey;
    }
  });
});
