const {
  loadEstimateAiSupportContext,
  loadPublicEstimateSupportSources,
  serviceKeysFromContext,
  serviceFamiliesFromText,
  searchTermsFromContext,
} = require('../services/estimate-ai-context');

function fakeDb(tables = {}) {
  return (table) => ({
    where(arg) {
      if (typeof arg === 'function') {
        arg.call(this);
      }
      return this;
    },
    whereNull() { return this; },
    orWhere() { return this; },
    orWhereNull() { return this; },
    orWhereRaw() { return this; },
    select() { return this; },
    limit(count) { return Promise.resolve((tables[table] || []).slice(0, count)); },
  });
}

describe('estimate AI support context', () => {
  test('infers service keys from estimate context and customer question', () => {
    const context = {
      services: [
        { label: 'Pest Control', detail: 'Exterior perimeter plan' },
        { label: 'Mosquito Control', detail: 'Barrier treatment' },
      ],
    };

    expect(serviceKeysFromContext(context, 'Does the lawn plan include weed control?')).toEqual([
      'lawn_care',
      'pest_control',
      'mosquito',
    ]);
  });

  test('question-family detection requires whole words and returns every named family', () => {
    // "plants" must not substring-match the pest pattern's "ant".
    expect(serviceFamiliesFromText('Can I water my plants after treatment?')).toEqual([]);
    expect(serviceFamiliesFromText('Are the lawn and mosquito treatments safe for pets?')).toEqual(['lawn_care', 'mosquito']);
    expect(serviceFamiliesFromText('Do you treat for ants?')).toEqual(['pest_control']);
    // Customers say "bug spray" for pest control...
    expect(serviceFamiliesFromText('Is the bug spray safe for pets?')).toEqual(['pest_control']);
    // ...but generic bug/insect words must not broaden a family-specific
    // question — chinch bugs and lawn insects are lawn-care targets.
    expect(serviceFamiliesFromText('Is the chinch bug treatment safe for pets?')).toEqual(['lawn_care']);
    expect(serviceFamiliesFromText('Is the lawn insect treatment safe?')).toEqual(['lawn_care']);
    // interior/exterior mirror the force-gate's pest wording.
    expect(serviceFamiliesFromText('Is the exterior spray safe for pets?')).toEqual(['pest_control']);
    // An INDEPENDENT bug mention alongside another family keeps both.
    expect(serviceFamiliesFromText('Are the lawn and bug spray safe for pets?')).toEqual(['lawn_care', 'pest_control']);
    // "the lawn" as the RECIPIENT of a treatment is not a target family.
    expect(serviceFamiliesFromText('Is the mosquito spray safe for the lawn?')).toEqual(['mosquito']);
    expect(serviceFamiliesFromText('Will the pest treatment hurt my shrubs?')).toEqual(['pest_control']);
    // Plain location words are not pest scope without treatment context...
    expect(serviceFamiliesFromText('Can I water my outside plants after treatment?')).toEqual([]);
    // ...but treatment-tied perimeter wording is.
    expect(serviceFamiliesFromText('Do you spray inside the house?')).toEqual(['pest_control']);
    expect(serviceFamiliesFromText('')).toEqual([]);
  });

  test('question naming a product stamps questionNameMatch without leaking the name', async () => {
    const result = await loadEstimateAiSupportContext({
      db: fakeDb({
        products_catalog: [
          {
            name: 'SpeedZone EW',
            category: 'herbicide',
            active_ingredient: 'Carfentrazone + 2,4-D + MCPP + Dicamba',
            active: true,
            label_verified_by: 'waves-admin',
          },
          {
            name: 'Drive XLR8',
            category: 'herbicide',
            active_ingredient: 'Quinclorac',
            active: true,
            label_verified_by: 'waves-admin',
          },
        ],
      }),
      question: 'Is SpeedZone safe for pets?',
      context: { services: [{ label: 'Lawn Care', detail: 'Weed control applications' }] },
    });
    const named = result.productCatalog.find((row) => String(row.activeIngredient || '').includes('Carfentrazone'));
    const other = result.productCatalog.find((row) => row.activeIngredient === 'Quinclorac');
    expect(named.questionNameMatch).toBe(true);
    expect(other.questionNameMatch).toBe(false);
    // Boolean only — the product name itself must never enter the context.
    expect(JSON.stringify(result)).not.toContain('SpeedZone');
  });

  test('question-derived service keys use the whole-word matcher for support loading', () => {
    // "plants" must not add pest_control to the support search (loose label
    // pattern would substring-match "ant").
    expect(serviceKeysFromContext(
      { services: [{ label: 'Lawn Care', detail: 'Weed control applications' }] },
      'Can I water my plants after treatment?',
    )).toEqual(['lawn_care']);
  });

  test('builds compact search terms from services, question, tier, and location context', () => {
    const terms = searchTermsFromContext({
      waveGuardTier: 'WaveGuard Gold',
      services: [{ label: 'Lawn Care', detail: 'Weed and fungus applications' }],
    }, 'Can you explain fungus treatment?');

    expect(terms).toContain('lawn');
    expect(terms).toContain('Lawn Care');
    expect(terms).toContain('WaveGuard Gold');
    expect(terms).toContain('Southwest Florida');
    expect(terms.length).toBeLessThanOrEqual(10);
  });

  test('loads shaped support sources from knowledge tables and static references', async () => {
    const result = await loadEstimateAiSupportContext({
      db: fakeDb({
        knowledge_base: [{
          path: 'wiki/services/lawn.md',
          title: 'Lawn Program',
          category: 'services',
          summary: 'Seasonal lawn care guidance for Southwest Florida.',
          content: 'Longer content',
        }],
        knowledge_entries: [{
          slug: 'st-augustine-fungus',
          title: 'St. Augustine Fungus',
          category: 'turf',
          summary: 'Fungus pressure increases in wet conditions.',
          content: 'Longer wiki content',
          confidence: 'high',
          data_point_count: 12,
        }],
        services: [{
          service_key: 'lawn_care',
          name: 'Lawn Care',
          category: 'lawn_care',
          description: 'Seasonal lawn care program.',
          default_products: ['0-0-7 Granular', 'Celsius WG'],
        }],
        products_catalog: [{
          name: 'Celsius WG',
          category: 'herbicide',
          active_ingredient: 'Thiencarbazone + Iodosulfuron + Dicamba',
          active: true,
          label_verified_by: 'waves-admin',
        }],
      }),
      question: 'What is included with lawn care?',
      context: {
        services: [{ label: 'Lawn Care', detail: 'Fertilizer, weed, and fungus applications' }],
        waveGuardTier: 'WaveGuard Gold',
      },
    });

    expect(result.serviceKeys).toContain('lawn_care');
    expect(result.knowledgeBase).toEqual([
      expect.objectContaining({
        source: 'knowledge_base',
        path: 'wiki/services/lawn.md',
        title: 'Lawn Program',
      }),
    ]);
    expect(result.agronomicWiki).toEqual([
      expect.objectContaining({
        source: 'agronomic_wiki',
        path: 'st-augustine-fungus',
        confidence: 'high',
        dataPointCount: 12,
      }),
    ]);
    expect(result.serviceLibrary).toEqual([
      expect.objectContaining({
        source: 'admin_service_library',
        path: 'lawn_care',
      }),
    ]);
    expect(result.productCatalog).toEqual([
      expect.objectContaining({
        source: 'admin_product_catalog',
        title: 'herbicide active ingredient',
        activeIngredient: 'Thiencarbazone + Iodosulfuron + Dicamba',
        // Attributed to lawn_care via the service library's default_products
        // linkage — lets the assistant scope family-specific safety questions.
        serviceKeys: ['lawn_care'],
      }),
    ]);
    expect(JSON.stringify(result)).not.toContain('Celsius WG');
    expect(result.productCatalogTruncated).toBe(false);
    expect(result.externalSources.some((source) => source.title.includes('UF/IFAS'))).toBe(true);
    expect(result.externalSources.some((source) => source.title.includes('Florida-Friendly'))).toBe(true);
  });

  test('flags the product catalog slice as truncated when the row cap fills', () => {
    const manyProducts = Array.from({ length: 9 }, (_, i) => ({
      name: `Product ${i}`,
      category: 'herbicide',
      active_ingredient: `Ingredient ${i}`,
      active: true,
      label_verified_by: 'waves-admin',
    }));
    return loadEstimateAiSupportContext({
      db: fakeDb({ products_catalog: manyProducts }),
      question: 'Is the herbicide safe for pets?',
      context: { services: [{ label: 'Lawn Care', detail: 'Weed control applications' }] },
    }).then((result) => {
      expect(result.productCatalog).toHaveLength(8);
      // A full slice can't prove completeness — the assistant must not make
      // blanket every-product claims from it.
      expect(result.productCatalogTruncated).toBe(true);
    });
  });

  test('label-verified safety fields flow into the product snippet; unverified rows stay safety-silent', async () => {
    const result = await loadEstimateAiSupportContext({
      db: fakeDb({
        products_catalog: [
          {
            name: 'SpeedZone EW',
            category: 'herbicide',
            active_ingredient: 'Carfentrazone + 2,4-D + MCPP + Dicamba',
            active: true,
            label_verified_by: 'waves-admin',
            signal_word: 'Caution',
            rei_hours: 0,
            rainfast_minutes: 180,
            reentry_summary: 'Keep people and pets off treated areas until dry.',
            irrigation_notes: 'Rainfast in 3 hours; avoid irrigation for 24 hours.',
            ppe_text: 'Long-sleeved shirt, long pants, chemical-resistant gloves.',
          },
          {
            name: 'Mystery Concentrate',
            category: 'insecticide',
            active_ingredient: 'Bifenthrin',
            active: true,
            label_verified_by: null,
            signal_word: 'Warning',
            reentry_summary: 'Unverified re-entry claim.',
          },
          {
            // Seeded-lane shape (20260530000022): verified via
            // label_verified_at, label_verified_by never set.
            name: 'Drive XLR8',
            category: 'herbicide',
            active_ingredient: 'Quinclorac',
            active: true,
            label_verified_by: null,
            label_verified_at: '2026-05-30T00:00:00Z',
            label_version: 'EPA accepted label record',
            signal_word: 'Caution',
            rei_hours: 0,
            rainfast_minutes: 60,
            reentry_text: 'Keep pets off until sprays have dried.',
          },
          {
            // label_version can be edited independently of verification in
            // the inventory workflow — alone it is NOT a verification stamp.
            name: 'Draft Import',
            category: 'fungicide',
            active_ingredient: 'Azoxystrobin',
            active: true,
            label_verified_by: null,
            label_verified_at: null,
            label_version: 'source page import (draft)',
            signal_word: 'Danger',
            rainfast_minutes: 240,
            reentry_summary: 'Draft re-entry claim.',
            irrigation_notes: 'Draft irrigation claim.',
          },
        ],
      }),
      question: 'Is the herbicide safe for pets?',
      context: { services: [{ label: 'Lawn Care', detail: 'Weed control applications' }] },
    });

    const verified = result.productCatalog.find((row) => String(row.activeIngredient || '').includes('Carfentrazone'));
    expect(verified.snippet).toContain('Label signal word: Caution');
    expect(verified.snippet).toContain('Keep people and pets off treated areas until dry.');
    expect(verified.snippet).toContain('Rainfast in about 180 minutes');
    expect(verified.snippet).toContain('Applicator PPE');
    expect(verified.signalWord).toBe('Caution');
    expect(verified.rainfastMinutes).toBe(180);
    // Irrigation guidance is a structured field, not just snippet text, so
    // the deterministic fallback can quote it for watering questions.
    expect(verified.irrigationNotes).toBe('Rainfast in 3 hours; avoid irrigation for 24 hours.');

    // Fail closed: an unverified row must not surface safety claims.
    const unverified = result.productCatalog.find((row) => row.activeIngredient === 'Bifenthrin');
    expect(unverified.snippet).not.toContain('Warning');
    expect(unverified.snippet).not.toContain('Unverified re-entry claim');
    expect(unverified.signalWord).toBeNull();

    // Rows verified only via label_verified_at (the seeded label-facts lane
    // never sets label_verified_by) still count as verified.
    const seedVerified = result.productCatalog.find((row) => row.activeIngredient === 'Quinclorac');
    expect(seedVerified.labelVerified).toBe(true);
    expect(seedVerified.snippet).toContain('Label verified in admin catalog');
    expect(seedVerified.snippet).toContain('Label signal word: Caution');
    expect(seedVerified.snippet).toContain('Keep pets off until sprays have dried');
    expect(seedVerified.rainfastMinutes).toBe(60);

    // label_version WITHOUT an actual verification stamp must stay
    // safety-silent — it can be set on a draft row before anyone verified.
    const draftRow = result.productCatalog.find((row) => row.activeIngredient === 'Azoxystrobin');
    expect(draftRow.labelVerified).toBe(false);
    expect(draftRow.signalWord).toBeNull();
    expect(draftRow.rainfastMinutes).toBeNull();
    expect(draftRow.irrigationNotes).toBeNull();
    expect(draftRow.snippet).not.toContain('Label verified');
    expect(draftRow.snippet).not.toContain('Danger');
    expect(draftRow.snippet).not.toContain('Draft re-entry claim');
    expect(draftRow.snippet).not.toContain('Draft irrigation claim');
  });

  test('public support sources only expose external citation metadata', () => {
    const result = loadPublicEstimateSupportSources({
      question: 'What is included with lawn care?',
      context: {
        services: [{ label: 'Lawn Care', detail: 'Fertilizer, weed, and fungus applications' }],
        waveGuardTier: 'WaveGuard Gold',
      },
    });

    expect(result.length).toBeGreaterThan(0);
    expect(result.every((source) => source.url && source.title && source.relevance)).toBe(true);
    expect(result.some((source) => source.source === 'repo_file')).toBe(false);
    expect(result.some((source) => source.snippet)).toBe(false);
  });
});
