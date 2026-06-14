const {
  buildPrompt,
  composeCompletionSmsPreview,
  deterministicRecap,
  generateRecap,
  normalizeOutcome,
  sanitizeRecap,
  smsRecap,
  SMS_RECAP_MAX_CHARS,
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

  test('customer_concern recap does not claim service was completed', () => {
    const recap = deterministicRecap({
      visitOutcome: 'customer_concern',
      serviceType: 'Quarterly Pest Control',
      notes: 'Customer asked about activity near the patio.',
    });

    expect(recap).not.toMatch(/we completed your/i);
    expect(recap).toMatch(/concern/i);
    expect(recap).not.toContain('Customer asked about activity near the patio.');
  });

  test('incomplete recap does not claim service was completed', () => {
    const recap = deterministicRecap({
      visitOutcome: 'incomplete',
      serviceType: 'Lawn Care',
      areasTreated: ['Front yard'],
    });

    expect(recap).not.toMatch(/we completed your/i);
    expect(recap).toMatch(/not able to finish|remaining work/i);
  });

  test('sanitizeRecap normalizes punctuation and enforces Waves signoff', () => {
    const recap = sanitizeRecap('“We checked the garage and entry points today.” — Waves');

    expect(recap).toBe('"We checked the garage and entry points today." - Waves');
  });

  // Regression: sanitizeRecap used to hard-truncate at 232 chars UNCONDITIONALLY,
  // chopping the stored recap mid-sentence ("...we also noticed some.") — which
  // then surfaced on the full-page service report. The stored/report recap must
  // now be the COMPLETE text; only the SMS variant is capped.
  const longRecap = "Today's lawn visit focused on treating nutsedge across the front, back, and side yards as well as the landscape beds. You should start to see the sedge yellow and decline over the next couple of weeks. We also noticed some thinning near the driveway that we will keep an eye on.";

  test('sanitizeRecap keeps the full recap (no length cap) by default', () => {
    const recap = sanitizeRecap(longRecap);
    expect(recap.length).toBeGreaterThan(SMS_RECAP_MAX_CHARS);
    expect(recap).toContain('thinning near the driveway');
    expect(recap.endsWith(' - Waves')).toBe(true);
    expect(recap).not.toMatch(/noticed some\. - Waves$/); // not the old mid-sentence cut
  });

  test('smsRecap caps to SMS size on a sentence boundary (no mid-word cut)', () => {
    const sms = smsRecap(longRecap);
    const body = sms.replace(/ - Waves$/, '');
    expect(body.length).toBeLessThanOrEqual(SMS_RECAP_MAX_CHARS);
    expect(/[.!?]$/.test(body)).toBe(true);        // ends on a complete sentence
    expect(body).not.toMatch(/\bsom$|\bnotice$/);  // never a dangling fragment
    expect(sms.endsWith(' - Waves')).toBe(true);
  });

  test('smsRecap is idempotent on an already-signed full recap', () => {
    expect(smsRecap(sanitizeRecap(longRecap))).toBe(smsRecap(longRecap));
  });

  // Regression (Codex P3): a pasted recap that is already quoted AND signed must
  // not leave a dangling quote once the signoff is stripped.
  test('sanitizeRecap unwraps quotes around a signed recap without a dangling quote', () => {
    expect(sanitizeRecap('"We checked the garage." - Waves')).toBe('We checked the garage. - Waves');
    expect(sanitizeRecap("'We treated the lawn today.' - Waves")).toBe('We treated the lawn today. - Waves');
    // Signoff wrapped INSIDE the quotes must not double-sign.
    expect(sanitizeRecap('"We treated the lawn today. - Waves"')).toBe('We treated the lawn today. - Waves');
    // A genuine inner quote (not a wrapper) is preserved.
    expect(sanitizeRecap('We noted "minor" weed pressure. - Waves')).toBe('We noted "minor" weed pressure. - Waves');
  });

  test('generated deterministic recap includes signoff without exposing technician notes', async () => {
    const result = await generateRecap({
      visitOutcome: 'customer_declined',
      serviceType: 'Quarterly Pest Control',
      notes: 'Customer declined because of price discussion about $89 and product Talstar.',
    });

    expect(result.source).toBe('deterministic');
    expect(result.recap).toMatch(/ - Waves$/);
    expect(result.recap).not.toMatch(/Talstar|\$89|Technician note/i);
  });
});
