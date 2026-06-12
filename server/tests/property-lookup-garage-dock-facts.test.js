/**
 * County garage/dock facts (estimator backlog: garage/dock rows from the
 * improvement tables).
 *
 * Same assessed extra-feature rows the pool/impervious extractors consume.
 * A GARAGE row in the features roll is the DETACHED kind (attached garages
 * live in building data) — an entry-point surface the building record can't
 * see. A dock/boat-lift/davit row is positive water-adjacency evidence.
 * Tri-state like hasPool. Evidence-only on the profile: pricing modifiers
 * (pestGarageAdj, mosquitoWaterMult) are untouched — pinned below.
 *
 * Also pins the impervious keyword widening that rides along: detached
 * structures (GARAGE/SHED) now count for the keyword counties, matching
 * what Manatee's explicit Impervious flag already does.
 */

jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const { _private: aiPrivate } = require('../services/property-lookup/ai-property-lookup');
const { buildEnrichedProfile } = require('../routes/property-lookup-v2');

const {
  garageDockFactsFromFeatures,
  imperviousFactsFromFeatures,
  charlottePoolFeatures,
  manateePoolFeatures,
  shapeAsPropertyRecord,
} = aiPrivate;

describe('garageDockFactsFromFeatures', () => {
  test('detached garage row sets the flag and keeps the largest sqft', () => {
    const facts = garageDockFactsFromFeatures([
      { description: 'GARAGE DET 1 STORY', sqft: '440' },
      { description: 'DETACHED GARAGE - FRAME', sqft: '576' },
      { description: 'RESIDENTIAL POOL', sqft: '288' },
    ]);
    expect(facts).toEqual({ hasDetachedGarage: true, detachedGarageSqft: 576, hasDock: false });
  });

  test('dock, boat lift, and davit rows all read as water-adjacency evidence', () => {
    for (const description of ['Boat Dock (sq. Ft.)', 'BOAT LIFT', 'BOATLIFT W/ROOF', 'DAVIT - 2 ARM']) {
      expect(garageDockFactsFromFeatures([{ description, sqft: '120' }]).hasDock).toBe(true);
    }
  });

  test('parsed table without garage/dock rows is a meaningful false', () => {
    expect(garageDockFactsFromFeatures([
      { description: 'PATIO', sqft: '500' },
    ])).toEqual({ hasDetachedGarage: false, detachedGarageSqft: null, hasDock: false });
  });

  test('non-array input returns {} (table never parsed → null on the record)', () => {
    expect(garageDockFactsFromFeatures(null)).toEqual({});
    expect(garageDockFactsFromFeatures(undefined)).toEqual({});
  });
});

describe('impervious widening: detached structures count in keyword counties', () => {
  test('garage and shed rows add to imperviousAreaSf (no flag)', () => {
    expect(imperviousFactsFromFeatures([
      { description: 'GARAGE DET 1 STORY', sqft: '440' },
      { description: 'UTILITY SHED', sqft: '80' },
    ])).toEqual({ imperviousAreaSf: 520 });
  });

  test('Manatee flag still wins: a NO-flagged garage row does not count', () => {
    expect(imperviousFactsFromFeatures([
      { description: 'GARAGE DET 1 STORY', sqft: '440', impervious: 'NO' },
    ])).toEqual({ imperviousAreaSf: 0 });
  });
});

describe('county wrappers carry the new facts', () => {
  test('Manatee features model with a detached garage and no dock', () => {
    const facts = manateePoolFeatures({
      cols: [
        { title: 'Description' }, { title: 'Area' }, { title: 'Impervious' },
      ],
      rows: [
        ['GARAGE DET 1 STORY', '440', 'YES'],
        ['RESIDENTIAL POOL', '288', 'YES'],
      ],
    });
    expect(facts.hasDetachedGarage).toBe(true);
    expect(facts.detachedGarageSqft).toBe(440);
    expect(facts.hasDock).toBe(false);
    expect(facts.hasPool).toBe(true);
    expect(facts.imperviousAreaSf).toBe(440 + 288);
  });

  test('Charlotte land-improvement table with a boat dock', () => {
    const html = `
<table class="prctable"><caption class="blockcaption">Land Improvement Information</caption>
<thead><tr><th><strong>Code</strong></th><th><strong>Description</strong></th><th><strong>Size</strong></th><th><strong>Year Built</strong></th></tr></thead>
<tr><td>0801&nbsp;</td><td>Boat Dock (sq. Ft.)&nbsp;</td><td>240&nbsp;</td><td>1995&nbsp;</td></tr>
<tr><td>0510&nbsp;</td><td>Pool - Gunite (sq. Ft.)&nbsp;</td><td>392&nbsp;</td><td>1995&nbsp;</td></tr>
</table>`;
    const facts = charlottePoolFeatures(html);
    expect(facts.hasDock).toBe(true);
    expect(facts.hasDetachedGarage).toBe(false);
    expect(facts.hasPool).toBe(true);
    // Dock is over water — excluded from impervious (DOCK in the exclude set).
    expect(facts.imperviousAreaSf).toBe(392);
  });
});

describe('record shape + profile (tri-state, evidence-only)', () => {
  const countyParsed = (overrides = {}) => ({
    squareFootage: 1800,
    lotSize: 9000,
    confidence: 'high',
    county: 'Manatee',
    formattedAddress: '123 Test St, Bradenton, FL',
    source: 'https://example.test',
    ...overrides,
  });

  test('tri-state on the shaped record', () => {
    expect(shapeAsPropertyRecord(countyParsed(), 'x', 'manatee_pao').hasDetachedGarage).toBeNull();
    expect(shapeAsPropertyRecord(countyParsed(), 'x', 'manatee_pao').hasDock).toBeNull();
    const withFacts = shapeAsPropertyRecord(
      countyParsed({ hasDetachedGarage: true, detachedGarageSqft: 440, hasDock: false }),
      'x', 'manatee_pao',
    );
    expect(withFacts.hasDetachedGarage).toBe(true);
    expect(withFacts.detachedGarageSqft).toBe(440);
    expect(withFacts.hasDock).toBe(false);
  });

  test('profile surfaces the facts without touching the garage/water modifiers', () => {
    const rc = shapeAsPropertyRecord(
      countyParsed({ hasDetachedGarage: true, detachedGarageSqft: 440, hasDock: true }),
      'x', 'manatee_pao',
    );
    const withFacts = buildEnrichedProfile(rc, {}, 27.4, -82.4, null);
    const without = buildEnrichedProfile(
      shapeAsPropertyRecord(countyParsed(), 'x', 'manatee_pao'), {}, 27.4, -82.4, null,
    );

    expect(withFacts.hasDetachedGarage).toBe(true);
    expect(withFacts.detachedGarageSqft).toBe(440);
    expect(withFacts.hasDock).toBe(true);
    expect(without.hasDetachedGarage).toBeNull();
    expect(without.hasDock).toBeNull();

    // Evidence-only: identical modifiers with and without the new facts —
    // pestGarageAdj keys on ATTACHED-garage detection, mosquitoWaterMult on
    // vision water proximity; neither may move on county detached/dock rows.
    expect(withFacts.modifiers).toEqual(without.modifiers);
    expect(withFacts.hasAttachedGarage).toBe(without.hasAttachedGarage);
  });
});
