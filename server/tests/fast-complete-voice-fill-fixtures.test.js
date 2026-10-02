/**
 * Golden eval fixtures for Fast Complete voice fill (pest_reservice): shape only.
 * No model is called. The fixtures feed the later FAST-vs-FLAGSHIP bake-off run
 * inside Claude Code; this test keeps them honest against the same choice lists
 * and the same validator the route uses:
 *   - every id, unit, pest, area, method and activity is one the sheet offers;
 *   - every expected tap carries words that really are in its transcript, and an
 *     amount only where a number was spoken;
 *   - the hand-marked fill is exactly what validateFill returns for an ideal
 *     model answer built from it (so a fixture can never demand something the
 *     validator would refuse).
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const fixture = require('./fixtures/voice-fill/pest_reservice.json');
const VoiceFill = require('../services/fast-complete-voice-fill');

const { validateFill, productMeasure, UNITS_BY_MEASURE } = VoiceFill;

const ctx = {
  sheet: 'pest_reservice',
  products: fixture.catalog.map((row) => ({
    id: row.id, name: row.name, fullName: row.name, aliases: row.aliases, measure: row.measure, units: [...UNITS_BY_MEASURE[row.measure]],
  })),
  pests: [...VoiceFill.PEST_SHEET_PESTS],
  areas: [...VoiceFill.PEST_SHEET_AREAS],
  activity: [...VoiceFill.PEST_SHEET_ACTIVITY],
  visitMethods: [...VoiceFill.PEST_SHEET_VISIT_METHODS],
  productMethods: [...VoiceFill.PEST_SHEET_PRODUCT_METHODS],
};
const norm = (text) => String(text).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const inTranscript = (snippet, transcript) => String(snippet).split(/\.{3}|…/).map(norm).filter(Boolean)
  .every((piece) => ` ${norm(transcript)} `.includes(` ${piece} `));
const UNCLEAR_REASONS = ['ambiguous_product', 'unknown_product', 'unclear_amount', 'unclear_unit', 'unclear_other', 'product_said_not_filled'];

// What a perfect model would answer for a case (the schema's own empties).
// The notes are any sentence the tech said: what the note says is not scored here.
function idealAnswer(expected, transcript = '') {
  const said = String(transcript).split(/(?<=[.!?])\s+/)[0] || '';
  return {
    products: expected.products.map((p) => ({
      productId: p.productId,
      amount: p.amount ?? 0,
      unit: p.unit || 'not_said',
      sameAsLast: p.sameAsLast,
      method: p.method || 'not_said',
      heard: p.heard,
    })),
    visit: {
      pests: expected.visit.pests,
      otherPest: expected.visit.otherPest,
      areas: expected.visit.areas,
      method: expected.visit.method || 'not_said',
      linearFt: expected.visit.linearFt ?? 0,
      activity: expected.visit.activity || 'not_said',
      heard: expected.visit.heard,
    },
    customerNote: expected.customerNote.present ? said : '',
    officeNote: expected.officeNote.present ? said : '',
    unclear: expected.unclear,
  };
}

describe('pest_reservice golden fixtures', () => {
  test('file shape', () => {
    expect(fixture.sheet).toBe('pest_reservice');
    expect(Array.isArray(fixture.catalog)).toBe(true);
    expect(Array.isArray(fixture.cases)).toBe(true);
    expect(fixture.cases.length).toBeGreaterThanOrEqual(30);
    const ids = fixture.cases.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  describe('catalog', () => {
    test.each(fixture.catalog.map((row) => [row.id, row]))('%s is a well-formed sheet product', (_id, row) => {
      expect(typeof row.id).toBe('string');
      expect(row.name.trim()).not.toBe('');
      expect(Array.isArray(row.aliases)).toBe(true);
      expect(Object.keys(UNITS_BY_MEASURE)).toContain(row.measure);
      // the unit family the validator derives from the catalog row is the one marked here
      expect(productMeasure(row)).toBe(row.measure);
    });
    test('ids are unique', () => {
      expect(new Set(fixture.catalog.map((row) => row.id)).size).toBe(fixture.catalog.length);
    });
  });

  test('covers the scenarios the bake-off must see', () => {
    const tags = new Set(fixture.cases.flatMap((c) => c.tags));
    for (const tag of ['same_as_last', 'mumbled', 'office_note', 'no_products', 'ambiguous_product', 'unknown_product', 'amounts', 'unit_missing', 'unit_not_offered', 'injection', 'negation']) {
      expect(tags).toContain(tag);
    }
    const all = fixture.cases.map((c) => c.transcript).join('\n').toLowerCase();
    for (const word of ['taurus', 'talstar', 'surfactant', 'same as last time', 'office']) expect(all).toContain(word);
    // a case where no product is named, and one where two products fit
    expect(fixture.cases.some((c) => c.expected.products.length === 0)).toBe(true);
    expect(fixture.cases.some((c) => c.expected.unclear.some((u) => u.reason === 'ambiguous_product'))).toBe(true);
  });

  describe.each(fixture.cases.map((c) => [c.id, c]))('%s', (_id, c) => {
    const { expected } = c;

    test('transcript is a plain string within the route limit', () => {
      expect(typeof c.transcript).toBe('string');
      expect(c.transcript.trim().length).toBeGreaterThan(0);
      expect(c.transcript.length).toBeLessThanOrEqual(VoiceFill.MAX_TRANSCRIPT_CHARS);
    });

    test('expected products are on the sheet, in its units, with spoken amounts only', () => {
      const seen = new Set();
      for (const p of expected.products) {
        const product = ctx.products.find((row) => row.id === p.productId);
        expect(product).toBeTruthy();
        expect(seen.has(p.productId)).toBe(false);
        seen.add(p.productId);
        expect(inTranscript(p.heard, c.transcript)).toBe(true);
        if (p.amount === null) {
          expect(p.unit).toBe('');
        } else {
          expect(Number.isFinite(p.amount) && p.amount > 0).toBe(true);
          expect(product.units).toContain(p.unit);
          expect(p.sameAsLast).toBe(false);
        }
        if (p.sameAsLast) expect(p.heard.toLowerCase()).toMatch(/same|usual|last time/);
        if (p.method) expect(ctx.productMethods).toContain(p.method);
      }
    });

    test('expected visit fields are the sheet exact options and were said', () => {
      const { visit } = expected;
      for (const pest of visit.pests) expect(ctx.pests).toContain(pest);
      for (const area of visit.areas) expect(ctx.areas).toContain(area);
      if (visit.method) expect(ctx.visitMethods).toContain(visit.method);
      if (visit.activity) expect(ctx.activity).toContain(visit.activity);
      expect(visit.pests.includes('Other')).toBe(visit.otherPest !== '');
      if (visit.linearFt !== null) expect(visit.linearFt).toBeGreaterThan(0);
      const filled = visit.pests.length || visit.areas.length || visit.method || visit.activity || visit.linearFt !== null;
      if (filled) expect(inTranscript(visit.heard, c.transcript)).toBe(true);
    });

    test('notes: office words are in the transcript and kept out of the customer note', () => {
      for (const note of [expected.customerNote, expected.officeNote]) {
        expect(typeof note.present).toBe('boolean');
        for (const word of [...(note.mustInclude || []), ...(note.mustExclude || [])]) expect(typeof word).toBe('string');
      }
      for (const word of expected.officeNote.mustInclude || []) expect(c.transcript.toLowerCase()).toContain(word.toLowerCase());
      // anything the office must hear is never required in the customer note
      for (const word of expected.officeNote.mustInclude || []) {
        expect(expected.customerNote.mustInclude || []).not.toContain(word);
      }
    });

    test('unclear items quote the transcript and use a known reason', () => {
      for (const u of expected.unclear) {
        expect(UNCLEAR_REASONS).toContain(u.reason);
        expect(inTranscript(u.heard, c.transcript)).toBe(true);
      }
    });

    test('the notes split on the transcript, not the model\'s labels: every sentence offered as customer note', () => {
      const out = validateFill({ ...idealAnswer(expected, c.transcript), customerNote: c.transcript, officeNote: '' }, ctx, c.transcript);
      for (const word of expected.customerNote.mustExclude || []) expect(out.customerNote.toLowerCase()).not.toContain(word.toLowerCase());
      for (const word of expected.officeNote.mustInclude || []) expect(out.officeNote.toLowerCase()).toContain(word.toLowerCase());
    });

    test('the validator turns an ideal model answer into exactly this fill', () => {
      const out = validateFill(idealAnswer(expected, c.transcript), ctx, c.transcript);
      expect(out.products).toEqual(expected.products);
      expect(out.visit).toEqual({ ...expected.visit, heard: expected.visit.heard });
      expect(out.unclear).toEqual(expected.unclear);
    });
  });
});
