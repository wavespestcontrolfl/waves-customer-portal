const {
  buildSummaryPrompt,
  formatServiceLines,
  formatObservations,
  normalizeSources,
  hasUsableContext,
  generateInvoiceSummary,
} = require('../services/invoice-ai-summary');

describe('invoice AI summary', () => {
  test('normalizeSources defaults every source on, honors explicit false', () => {
    expect(normalizeSources()).toEqual({ jobSummary: true, forms: true, lineItems: true });
    expect(normalizeSources({ forms: false })).toEqual({
      jobSummary: true,
      forms: false,
      lineItems: true,
    });
  });

  test('formatServiceLines renders descriptions with quantity and caps the list', () => {
    const lines = formatServiceLines([
      { description: 'Quarterly pest service', quantity: 1 },
      { description: 'Exterior treatment', quantity: 2 },
      { description: '', quantity: 3 },
    ]);
    expect(lines).toEqual(['- Quarterly pest service', '- Exterior treatment x2']);

    const many = Array.from({ length: 20 }, (_, i) => ({ description: `Item ${i}` }));
    expect(formatServiceLines(many)).toHaveLength(12);
  });

  test('formatObservations translates readings, skips empty fields', () => {
    expect(
      formatObservations({ soil_temp: 78, soil_moisture: 'adequate', soil_ph: null }),
    ).toEqual(['Soil temperature: 78°F', 'Soil moisture: adequate']);
    expect(formatObservations({})).toEqual([]);
  });

  test('prompt enforces guardrails: no products, prices, or overpromising', () => {
    const prompt = buildSummaryPrompt({
      customerName: 'Jane Smith',
      serviceLines: ['- Quarterly pest service'],
      context: { found: true, serviceType: 'Quarterly Pest Control', jobSummary: 'Treated perimeter' },
    });
    expect(prompt).toContain('Never mention product names');
    expect(prompt).toContain('prices');
    expect(prompt).toContain('eliminated, guaranteed, pest-free');
    expect(prompt).toContain('Jane Smith');
  });

  test('prompt includes only the enabled sources', () => {
    const context = {
      found: true,
      serviceType: 'Lawn Care',
      jobSummary: 'Mowed and edged; checked irrigation.',
      observations: ['Soil pH: 6.5'],
    };
    const full = buildSummaryPrompt({
      serviceLines: ['- Lawn visit'],
      context,
      sources: { jobSummary: true, forms: true, lineItems: true },
    });
    expect(full).toContain('Job summary (technician notes):');
    expect(full).toContain('Field observations:');
    expect(full).toContain('Service lines:');

    const trimmed = buildSummaryPrompt({
      serviceLines: ['- Lawn visit'],
      context,
      sources: { jobSummary: false, forms: false, lineItems: true },
    });
    expect(trimmed).not.toContain('Job summary (technician notes):');
    expect(trimmed).not.toContain('Field observations:');
    expect(trimmed).toContain('Service lines:');
  });

  test('hasUsableContext requires at least one enabled source with data', () => {
    expect(hasUsableContext({ input: '', serviceLines: [], context: { found: false } })).toBe(false);
    expect(hasUsableContext({ input: 'tech notes', serviceLines: [], context: { found: false } })).toBe(true);
    expect(
      hasUsableContext({
        serviceLines: ['- Visit'],
        context: { found: false },
        sources: { lineItems: false },
      }),
    ).toBe(false);
    expect(
      hasUsableContext({
        serviceLines: [],
        context: { found: true, jobSummary: 'did work' },
        sources: { jobSummary: true },
      }),
    ).toBe(true);
  });

  test('generateInvoiceSummary returns an error when there is nothing to summarize', async () => {
    const result = await generateInvoiceSummary({ input: '', services: [] });
    expect(result).toEqual({ error: 'Add notes, service lines, or link a completed visit first' });
  });
});
