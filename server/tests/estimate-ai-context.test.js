const {
  loadEstimateAiSupportContext,
  loadPublicEstimateSupportSources,
  serviceKeysFromContext,
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
      }),
    ]);
    expect(JSON.stringify(result)).not.toContain('Celsius WG');
    expect(result.externalSources.some((source) => source.title.includes('UF/IFAS'))).toBe(true);
    expect(result.externalSources.some((source) => source.title.includes('Florida-Friendly'))).toBe(true);
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

    // Fail closed: an unverified row must not surface safety claims.
    const unverified = result.productCatalog.find((row) => row.activeIngredient === 'Bifenthrin');
    expect(unverified.snippet).not.toContain('Warning');
    expect(unverified.snippet).not.toContain('Unverified re-entry claim');
    expect(unverified.signalWord).toBeNull();
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
