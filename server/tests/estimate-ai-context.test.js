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

// WHERE-aware fake: applies the recorded ilike patterns (and the normalized
// orWhereRaw predicate the named-product query uses) so the broad query and
// the dedicated named-product query return different rows — the shared
// fakeDb ignores predicates and cannot reproduce cap or punctuation cases.
function filteringDb(tables = {}) {
  const normalize = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return (table) => {
    const likes = [];
    return {
      where(arg) {
        if (typeof arg === 'function') arg.call(this);
        return this;
      },
      whereNull() { return this; },
      orWhere(column, _op, pattern) {
        if (typeof pattern === 'string') likes.push({ column, needle: pattern.replace(/%/g, '').toLowerCase() });
        return this;
      },
      orWhereNull() { return this; },
      orWhereRaw(sql, bindings = []) {
        // Mirrors regexp_replace(lower(coalesce(<col>, '')), '[^a-z0-9]', '', 'g') like ?
        const column = String(sql).includes('active_ingredient') ? 'active_ingredient' : 'name';
        const pattern = Array.isArray(bindings) ? bindings[0] : bindings;
        if (typeof pattern === 'string') {
          likes.push({ column, needle: pattern.replace(/%/g, '').toLowerCase(), normalized: true });
        }
        return this;
      },
      select() { return this; },
      limit(count) {
        const rows = (tables[table] || []).filter((row) => !likes.length
          || likes.some(({ column, needle, normalized }) => (normalized
            ? normalize(row[column]).includes(needle)
            : String(row[column] || '').toLowerCase().includes(needle))));
        return Promise.resolve(rows.slice(0, count));
      },
    };
  };
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
    // "the lawn" as the RECIPIENT of a treatment is not a target family...
    expect(serviceFamiliesFromText('Is the mosquito spray safe for the lawn?')).toEqual(['mosquito']);
    // ...including coordinated recipient lists.
    expect(serviceFamiliesFromText('Is the mosquito spray safe for lawns and shrubs?')).toEqual(['mosquito']);
    // ...but "for the lawn treatment" TARGETS the lawn family.
    expect(serviceFamiliesFromText('What product is used for the lawn treatment?')).toEqual(['lawn_care']);
    // A treatment verb before the preposition makes the area the target...
    expect(serviceFamiliesFromText('What product do you spray on the lawn?')).toEqual(['lawn_care']);
    // ...but the customer's own ACTIVITY on the area is recipient wording —
    // a pest-only estimate must not lose its facts to a lawn_care scope.
    expect(serviceFamiliesFromText('Can I water the lawn after treatment?')).toEqual([]);
    expect(serviceFamiliesFromText('How long before we can re-enter the lawn?')).toEqual([]);
    // Specialty pests are pest control.
    expect(serviceFamiliesFromText('Is the flea and tick treatment safe for my dog?')).toEqual(['pest_control']);
    expect(serviceFamiliesFromText('Is the wasp spray safe near the patio?')).toEqual(['pest_control']);
    expect(serviceFamiliesFromText('Will the pest treatment hurt my shrubs?')).toEqual(['pest_control']);
    // "landscape plant" is Tree & Shrub wording (mirrors the service label
    // matcher) when it TARGETS the treatment...
    expect(serviceFamiliesFromText('Is the landscape plant treatment safe for pets?')).toEqual(['tree_shrub']);
    // ...but stays recipient/activity wording when it names what the
    // customer sprays near or waters — in BOTH spellings.
    expect(serviceFamiliesFromText('Is the pest spray safe near the landscape plants?')).toEqual(['pest_control']);
    expect(serviceFamiliesFromText('Is the pest spray safe near the landscape plantings?')).toEqual(['pest_control']);
    expect(serviceFamiliesFromText('Can I water the landscape plants after treatment?')).toEqual([]);
    // Family-qualified insect wording stays in that family, including the
    // landscape-plant phrasing.
    expect(serviceFamiliesFromText('Do you treat landscape plant bugs?')).toEqual(['tree_shrub']);
    expect(serviceFamiliesFromText('Is the landscape plant insect treatment safe?')).toEqual(['tree_shrub']);
    // Plain location words are not pest scope without treatment context...
    expect(serviceFamiliesFromText('Can I water my outside plants after treatment?')).toEqual([]);
    // ...but treatment-tied perimeter wording is.
    expect(serviceFamiliesFromText('Do you spray inside the house?')).toEqual(['pest_control']);
    // A treatment word already qualified by another family is NOT perimeter
    // pest wording — the mosquito spray happening outside stays mosquito.
    expect(serviceFamiliesFromText('Is the mosquito spray outside safe for pets?')).toEqual(['mosquito']);
    expect(serviceFamiliesFromText('')).toEqual([]);
  });

  test('token-subset default_products aliases still attribute the catalog row', async () => {
    const result = await loadEstimateAiSupportContext({
      db: fakeDb({
        services: [{
          service_key: 'cockroach_control',
          name: 'Cockroach Control',
          category: 'pest_control',
          description: 'German roach cleanout program.',
          default_products: ['Advion Gel'],
        }],
        products_catalog: [{
          // The library alias "Advion Gel" is a token subset of the real name.
          name: 'Advion Cockroach Gel',
          category: 'insecticide',
          active_ingredient: 'Indoxacarb',
          active: true,
          label_verified_by: 'waves-admin',
        }],
      }),
      question: 'Is the roach gel safe for pets?',
      context: { services: [{ label: 'Cockroach Control', detail: 'Cleanout program' }] },
    });
    const row = result.productCatalog.find((r) => r.activeIngredient === 'Indoxacarb');
    expect(row.serviceKeys).toEqual(['pest_control']);
    // Family nouns inside product names ("Cockroach") are not distinctive —
    // a family question must not stamp whichever product carries the word.
    expect(row.questionNameMatch).toBe(false);
  });

  test('rodent-bait services attribute as rodent_bait, not termite_bait', async () => {
    const result = await loadEstimateAiSupportContext({
      db: fakeDb({
        services: [{
          // The loose label matcher's bare "bait" alternate would classify
          // this as termite_bait; the service_key prefix must win.
          service_key: 'rodent_bait_quarterly',
          name: 'Rodent Bait Stations',
          category: 'rodent',
          description: 'Exterior rodent bait station program.',
          default_products: ['Contrac Blox'],
        }],
        products_catalog: [{
          name: 'Contrac Blox',
          category: 'rodenticide',
          active_ingredient: 'Bromadiolone',
          active: true,
          label_verified_by: 'waves-admin',
        }],
      }),
      question: 'Is the rodent bait safe for pets?',
      context: { services: [{ label: 'Rodent Bait Stations', detail: 'Quarterly exterior program' }] },
    });
    const row = result.productCatalog.find((r) => r.activeIngredient === 'Bromadiolone');
    expect(row.serviceKeys).toEqual(['rodent_bait']);
  });

  test('lawn protocol products attribute to lawn_care without a default_products entry', async () => {
    const result = await loadEstimateAiSupportContext({
      db: fakeDb({
        // SpeedZone lives in the operating-layer protocol product list, NOT
        // in any service-library default_products — attribution must come
        // from the lawn_protocol_products linkage, and the "+ NIS" tank-mix
        // suffix must not break the catalog-name match.
        lawn_protocol_products: [{ product_name: 'SpeedZone Southern + NIS' }],
        products_catalog: [{
          name: 'SpeedZone Southern EW',
          category: 'herbicide',
          active_ingredient: 'Carfentrazone-ethyl + 2,4-D + Mecoprop-p + Dicamba',
          active: true,
          label_verified_by: 'waves-admin',
        }],
      }),
      question: 'Is SpeedZone safe for pets?',
      context: { services: [{ label: 'Lawn Care', detail: 'Weed control applications' }] },
    });
    const row = result.productCatalog.find((r) => String(r.activeIngredient || '').includes('Carfentrazone'));
    expect(row).toBeDefined();
    expect(row.serviceKeys).toEqual(['lawn_care']);
    expect(row.questionNameMatch).toBe(true);
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

  test('short DISTINCTIVE names still count as product mentions', async () => {
    const result = await loadEstimateAiSupportContext({
      db: fakeDb({
        products_catalog: [{
          name: 'Tekko Pro IGR',
          category: 'insect growth regulator',
          active_ingredient: 'Pyriproxyfen + Novaluron',
          active: true,
          label_verified_by: 'waves-admin',
        }],
      }),
      question: 'Is Tekko safe for pets?',
      context: { services: [{ label: 'Pest Control', detail: 'Quarterly perimeter plan' }] },
    });
    const row = result.productCatalog.find((r) => String(r.activeIngredient || '').includes('Pyriproxyfen'));
    expect(row.questionNameMatch).toBe(true);
  });

  test('a named product survives the catalog row cap', async () => {
    const fillers = Array.from({ length: 8 }, (_, i) => ({
      name: `Filler Product ${i}`,
      category: 'herbicide',
      active_ingredient: `Filler Ingredient ${i}`,
      active: true,
      label_verified_by: 'waves-admin',
    }));
    const result = await loadEstimateAiSupportContext({
      db: fakeDb({
        products_catalog: [...fillers, {
          // Ninth row — would be cut by a naive first-8 slice.
          name: 'ZetaGuard 9000',
          category: 'insecticide',
          active_ingredient: 'Zeta-cypermethrin',
          active: true,
          label_verified_by: 'waves-admin',
        }],
      }),
      question: 'Is ZetaGuard 9000 safe for pets?',
      context: { services: [{ label: 'Pest Control', detail: 'Quarterly perimeter plan' }] },
    });
    const named = result.productCatalog.find((r) => r.activeIngredient === 'Zeta-cypermethrin');
    expect(named).toBeDefined();
    expect(named.questionNameMatch).toBe(true);
    expect(result.productCatalogTruncated).toBe(true);
  });

  test('a named product ranked past 24 broad matches is still fetched', async () => {
    const fillers = Array.from({ length: 30 }, (_, i) => ({
      name: `Lawn Filler ${i}`,
      category: 'herbicide',
      active_ingredient: `Filler Ingredient ${i}`,
      active: true,
      label_verified_by: 'waves-admin',
    }));
    const result = await loadEstimateAiSupportContext({
      db: filteringDb({
        products_catalog: [...fillers, {
          // 31st row — the broad query's limit(24) fills up on fillers and
          // never returns it; only the dedicated named-product query can.
          name: 'ZetaGuard 9000',
          category: 'insecticide',
          active_ingredient: 'Zeta-cypermethrin',
          active: true,
          label_verified_by: 'waves-admin',
        }],
      }),
      question: 'Is ZetaGuard 9000 safe for pets?',
      context: { services: [{ label: 'Lawn Care', detail: 'Weed control applications' }] },
    });
    const named = result.productCatalog.find((r) => r.activeIngredient === 'Zeta-cypermethrin');
    expect(named).toBeDefined();
    expect(named.questionNameMatch).toBe(true);
    // Question-word matches rank ahead of broad matches in the working set.
    expect(result.productCatalog[0].activeIngredient).toBe('Zeta-cypermethrin');
    expect(result.productCatalogTruncated).toBe(true);
  });

  test('a punctuated active ingredient still matches the named-product lookup', async () => {
    // "2,4-D" in the question normalizes to "24d"; the catalog stores the
    // punctuated spelling. The named query must compare normalized text —
    // a raw ilike '%24d%' can never match "2,4-D" and the row would be
    // silently absent, so the off-estimate fail-close never sees it.
    const result = await loadEstimateAiSupportContext({
      db: filteringDb({
        products_catalog: [
          {
            name: 'Lawn Filler',
            category: 'herbicide',
            active_ingredient: 'Filler Ingredient',
            active: true,
            label_verified_by: 'waves-admin',
          },
          {
            name: 'Surge Broadleaf',
            category: 'herbicide',
            active_ingredient: '2,4-D dimethylamine salt',
            active: true,
            label_verified_by: 'waves-admin',
          },
        ],
      }),
      question: 'Is 2,4-D safe for my dog?',
      context: { services: [{ label: 'Lawn Care', detail: 'Weed control applications' }] },
    });
    const named = result.productCatalog.find((r) => r.activeIngredient === '2,4-D dimethylamine salt');
    expect(named).toBeDefined();
    // Prioritization normalizes the same way — the punctuated row ranks first.
    expect(result.productCatalog[0].activeIngredient).toBe('2,4-D dimethylamine salt');
  });

  test('protocol-only products are fetched for lawn questions, not just attributed', async () => {
    // SpeedZone lives in lawn_protocol_products (B/Z/B tracks), NOT in the
    // cleaned service defaults — attribution alone never fetched its row,
    // so a generic lawn rainfast question could treat the smaller default-
    // product set as complete while missing a product the protocol uses.
    const tables = {
      lawn_protocol_products: [{ product_name: 'SpeedZone Southern + NIS' }],
      products_catalog: [{
        name: 'SpeedZone Southern EW',
        category: 'herbicide',
        active_ingredient: 'Carfentrazone + 2,4-D + MCPP + Dicamba',
        active: true,
        label_verified_by: 'waves-admin',
        rainfast_minutes: 180,
      }],
    };
    const result = await loadEstimateAiSupportContext({
      db: filteringDb(tables),
      question: 'Will rain wash away my lawn treatment?',
      context: { services: [{ label: 'Lawn Care', detail: 'Weed control applications' }] },
    });
    const row = result.productCatalog.find((r) => r.activeIngredient === 'Carfentrazone + 2,4-D + MCPP + Dicamba');
    expect(row).toBeDefined();
    expect(row.serviceKeys).toEqual(['lawn_care']);
    expect(row.rainfastMinutes).toBe(180);

    // Protocol names are lawn linkage — they must not dilute the capped
    // working set of a pest-scoped lookup.
    const pestResult = await loadEstimateAiSupportContext({
      db: filteringDb(tables),
      question: 'Is the pest spray safe for pets?',
      context: { services: [{ label: 'Pest Control', detail: 'Quarterly perimeter plan' }] },
    });
    expect(pestResult.productCatalog.find((r) => r.activeIngredient === 'Carfentrazone + 2,4-D + MCPP + Dicamba')).toBeUndefined();

    // Estimate-level lawn presence is not enough: on a MIXED estimate, a
    // pest-specific question must not spend lookup and working-set slots on
    // lawn protocol names its scoping will filter out anyway.
    const mixedPestResult = await loadEstimateAiSupportContext({
      db: filteringDb(tables),
      question: 'Is the pest spray safe for pets?',
      context: {
        services: [
          { label: 'Lawn Care', detail: 'Weed control applications' },
          { label: 'Pest Control', detail: 'Quarterly perimeter plan' },
        ],
      },
    });
    expect(mixedPestResult.productCatalog.find((r) => r.activeIngredient === 'Carfentrazone + 2,4-D + MCPP + Dicamba')).toBeUndefined();

    // An untargeted question on the same mixed estimate still loads them.
    const mixedGenericResult = await loadEstimateAiSupportContext({
      db: filteringDb(tables),
      question: 'Is it safe for pets and kids?',
      context: {
        services: [
          { label: 'Lawn Care', detail: 'Weed control applications' },
          { label: 'Pest Control', detail: 'Quarterly perimeter plan' },
        ],
      },
    });
    expect(mixedGenericResult.productCatalog.find((r) => r.activeIngredient === 'Carfentrazone + 2,4-D + MCPP + Dicamba')).toBeDefined();
  });

  test('overflowing the lookup-term cap flags the catalog as truncated', async () => {
    // A lookup candidate that never reaches the query means the fetched set
    // is not provably complete — blanket completeness claims must fail
    // closed exactly like the row caps.
    const result = await loadEstimateAiSupportContext({
      db: fakeDb({
        lawn_protocol_products: Array.from({ length: 45 }, (_, i) => ({ product_name: `Protocol Product ${i}` })),
        products_catalog: [{
          name: 'Lawn Filler',
          category: 'herbicide',
          active_ingredient: 'Filler Ingredient',
          active: true,
          label_verified_by: 'waves-admin',
        }],
      }),
      question: 'Is the lawn treatment safe for pets?',
      context: { services: [{ label: 'Lawn Care', detail: 'Weed control applications' }] },
    });
    expect(result.productCatalogTruncated).toBe(true);
  });

  test('a single short common word never counts as naming a product', async () => {
    const result = await loadEstimateAiSupportContext({
      db: fakeDb({
        products_catalog: [{
          name: 'Drive XLR8 Herbicide Crabgrass Killer',
          category: 'herbicide',
          active_ingredient: 'Quinclorac',
          active: true,
          label_verified_by: 'waves-admin',
        }],
      }),
      // "drive" is a name token, but as an ordinary verb it must not stamp.
      question: 'Is it safe to drive on the lawn after treatment?',
      context: { services: [{ label: 'Lawn Care', detail: 'Weed control applications' }] },
    });
    const row = result.productCatalog.find((r) => r.activeIngredient === 'Quinclorac');
    expect(row.questionNameMatch).toBe(false);
  });

  test('estimate rows classify by canonical service key, not loose label text', () => {
    // "Rodent Bait Stations" label text would hit the termite pattern's
    // bare "bait" alternate; the canonical service key must win.
    expect(serviceKeysFromContext({
      services: [{ service: 'rodent_bait_quarterly', label: 'Rodent Bait Stations', detail: 'Quarterly exterior program' }],
    }, '')).toEqual(['rodent_bait']);
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
