const { _private } = require('../services/agent-estimate-context');

describe('Agent Estimate context helpers', () => {
  test('finds nested quote-form narrative without copying unrelated scalar fields', () => {
    const rows = _private.collectSubmissionText({
      customer: { first_name: 'Synthetic', phone: '9410000000' },
      quote: {
        service: 'lawn',
        details: { message: 'Please price the front and side lawn only.' },
        comments: 'Gate is on the east side.',
      },
    });
    expect(rows).toEqual([
      { field: 'quote.details.message', text: 'Please price the front and side lawn only.' },
      { field: 'quote.comments', text: 'Gate is on the east side.' },
    ]);
    expect(JSON.stringify(rows)).not.toContain('9410000000');
  });

  test('suggested prompt carries the pricing, property, inventory, and no-send boundaries', () => {
    const prompt = _private.suggestedPrompt({ first_name: 'Synthetic', last_name: 'Lead' }, null);
    expect(prompt).toMatch(/home\/building sqft/i);
    expect(prompt).toMatch(/treatable turf/i);
    expect(prompt).toMatch(/\$35 loaded labor rate/i);
    expect(prompt).toMatch(/untracked/i);
    expect(prompt).toMatch(/only compute_estimate for dollars/i);
    expect(prompt).toMatch(/never send automatically/i);
  });

  test('existing draft changes the prompt to revision language', () => {
    const prompt = _private.suggestedPrompt(
      { first_name: 'Synthetic', last_name: 'Lead' },
      { status: 'draft', source: 'estimator_engine' },
    );
    expect(prompt).toMatch(/review and revise/i);
  });

  test('recognized customer prompt preserves current service and quotes only additions', () => {
    const prompt = _private.suggestedPrompt(
      { id: 'lead-1', first_name: 'David', last_name: 'Thomas' },
      null,
      { recognized: true },
    );
    expect(prompt).toMatch(/recognized customer expansion/i);
    expect(prompt).toMatch(/preserve every active current service/i);
    expect(prompt).toMatch(/quote only services.*wants to add/i);
    expect(prompt).toMatch(/selected lead ID to compute_estimate/i);
    expect(prompt).toMatch(/presentation.*newly quoted service mix/i);
  });

  test('oversized extracted data is bounded before entering the model prompt', () => {
    const compact = _private.compactJson({ message: 'x'.repeat(20000) }, 100);
    expect(compact.truncated).toBe(true);
    expect(compact.raw_excerpt.length).toBe(100);
  });
});
