/**
 * AI photo analysis (owner spec 2026-06-12): prompt construction and
 * response parsing/validation for the customer-facing photo summary +
 * per-photo captions. The Anthropic call itself is not under test — this
 * is the validation layer that decides what may reach a customer report.
 */
const {
  buildPhotoAnalysisPrompt,
  parsePhotoAnalysisResponse,
  MAX_PHOTO_SUMMARY_CHARS,
} = require('../services/service-report/photo-analysis');
const {
  buildTypedReportSnapshot,
  findingsSchemaForType,
  findBannedCustomerCopy,
} = require('../services/service-report/activity-indicators');

describe('buildPhotoAnalysisPrompt', () => {
  test('includes findings context, photo count, and the banned-word rules', () => {
    const schema = findingsSchemaForType('rodent_trapping');
    const prompt = buildPhotoAnalysisPrompt({
      schema,
      values: { species: 'Roof rat', evidence_observed: 'Droppings, Gnaw marks' },
      photoCount: 3,
      serviceType: 'Rodent Trapping',
    });
    expect(prompt).toContain('3 field photos');
    expect(prompt).toContain('Species: Roof rat');
    expect(prompt).toContain('"captions": exactly 3 entries');
    expect(prompt).toContain('NEVER use these words');
    expect(prompt).toContain('pest-proof/rodent-proof');
  });
});

describe('parsePhotoAnalysisResponse', () => {
  const VALID = JSON.stringify({
    photoSummary: 'The photos document droppings along the garage sill and the trap placements in the attic.',
    captions: ['Droppings along the garage sill plate', 'Snap trap placed near the A/C plenum'],
  });

  test('parses plain JSON and code-fenced JSON', () => {
    for (const text of [VALID, '```json\n' + VALID + '\n```']) {
      const result = parsePhotoAnalysisResponse(text, { photoCount: 2 });
      expect(result.ok).toBe(true);
      expect(result.captions).toHaveLength(2);
      expect(result.photoSummary).toContain('droppings along the garage sill');
    }
  });

  test('pads missing captions and truncates extras to the photo count', () => {
    const short = parsePhotoAnalysisResponse(
      JSON.stringify({ photoSummary: 'One photo documented.', captions: ['Only one'] }),
      { photoCount: 3 },
    );
    expect(short.ok).toBe(true);
    expect(short.captions).toEqual(['Only one', '', '']);

    const long = parsePhotoAnalysisResponse(
      JSON.stringify({ photoSummary: 'Summary.', captions: ['a', 'b', 'c', 'd'] }),
      { photoCount: 2 },
    );
    expect(long.captions).toHaveLength(2);
  });

  test('rejects banned customer copy in summary or any caption', () => {
    const dirtySummary = parsePhotoAnalysisResponse(
      JSON.stringify({ photoSummary: 'The infestation is now gone.', captions: ['Photo'] }),
      { photoCount: 1 },
    );
    expect(dirtySummary.ok).toBe(false);
    expect(dirtySummary.error).toBe('banned_copy');

    const dirtyCaption = parsePhotoAnalysisResponse(
      JSON.stringify({ photoSummary: 'Photos document the sealed gap.', captions: ['Home is now rodent-proof'] }),
      { photoCount: 1 },
    );
    expect(dirtyCaption.ok).toBe(false);
    expect(dirtyCaption.violations.join(' ')).toMatch(/rodent-proof/i);
  });

  test('rejects unparseable and empty responses', () => {
    expect(parsePhotoAnalysisResponse('not json at all', { photoCount: 1 }).ok).toBe(false);
    expect(parsePhotoAnalysisResponse(JSON.stringify({ captions: ['x'] }), { photoCount: 1 }).ok).toBe(false);
  });

  test('clamps an oversize summary to the budget', () => {
    const result = parsePhotoAnalysisResponse(
      JSON.stringify({ photoSummary: 'a'.repeat(2000), captions: ['ok'] }),
      { photoCount: 1 },
    );
    expect(result.ok).toBe(true);
    expect(result.photoSummary.length).toBeLessThanOrEqual(MAX_PHOTO_SUMMARY_CHARS);
  });
});

describe('snapshot photoSummary', () => {
  test('persists the reviewed summary and survives banned-copy sweep', () => {
    const snapshot = buildTypedReportSnapshot({
      projectType: 'rodent_trapping',
      serviceKey: 'rodent_trapping_check',
      serviceLabel: 'Rodent Trapping',
      values: { species: 'Roof rat', traps_checked: '4', captures: '1' },
      nextStepChips: ['Continue trapping'],
      visitSequence: 2,
      activity: {
        indicatorKey: 'rodent_activity', label: 'Rodent Activity', score: 2,
        source: 'tech', trend: 'improving', trendWord: 'decreased',
      },
      photoSummary: 'The photos document the trap placements in the attic and the entry gap at the roof return.',
    });
    expect(snapshot.photoSummary).toContain('trap placements in the attic');
    expect(findBannedCustomerCopy(snapshot.photoSummary)).toEqual([]);

    const without = buildTypedReportSnapshot({
      projectType: 'rodent_trapping',
      serviceKey: 'rodent_trapping_check',
      serviceLabel: 'Rodent Trapping',
      values: { species: 'Roof rat' },
      nextStepChips: ['Continue trapping'],
      visitSequence: 1,
      activity: null,
    });
    expect(without.photoSummary).toBeNull();
  });
});

describe('parsePhotoAnalysisResponse shape strictness', () => {
  test('rejects non-string photoSummary and non-string captions', () => {
    const objSummary = parsePhotoAnalysisResponse(
      JSON.stringify({ photoSummary: { text: 'nested' }, captions: ['ok'] }),
      { photoCount: 1 },
    );
    expect(objSummary.ok).toBe(false);
    expect(objSummary.error).toBe('invalid_shape');

    const objCaption = parsePhotoAnalysisResponse(
      JSON.stringify({ photoSummary: 'Fine summary.', captions: [{ text: 'nested' }] }),
      { photoCount: 1 },
    );
    expect(objCaption.ok).toBe(false);
    expect(objCaption.error).toBe('invalid_shape');

    const numericCaption = parsePhotoAnalysisResponse(
      JSON.stringify({ photoSummary: 'Fine summary.', captions: [42] }),
      { photoCount: 1 },
    );
    expect(numericCaption.ok).toBe(false);
  });

  test('null captions are tolerated as empty', () => {
    const result = parsePhotoAnalysisResponse(
      JSON.stringify({ photoSummary: 'Fine summary.', captions: [null, 'Trap photo'] }),
      { photoCount: 2 },
    );
    expect(result.ok).toBe(true);
    expect(result.captions).toEqual(['', 'Trap photo']);
  });
});
