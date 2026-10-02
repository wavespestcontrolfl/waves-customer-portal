/**
 * Fast Complete voice fill — the per-sheet context, the structured-output schema
 * and the server-side validator (services/fast-complete-voice-fill.js). The model
 * is never called here: `validateFill` is fed hand-written "model answers".
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const fs = require('fs');
const path = require('path');
const VoiceFill = require('../services/fast-complete-voice-fill');

const { validateFill, buildSchema, buildPrompt, productMeasure, fillCounts, CAPS } = VoiceFill;

// A small synthetic catalog in the sheet's context shape.
const ctx = {
  sheet: 'pest_reservice',
  products: [
    { id: 'p-taurus', name: 'Taurus SC', fullName: 'Taurus SC', aliases: [], measure: 'liquid', units: ['tsp', 'fl_oz', 'gal'] },
    { id: 'p-talak', name: 'Atticus Talak 7.9 F', fullName: 'Atticus Talak 7.9 F', aliases: ['Talstar P'], measure: 'liquid', units: ['tsp', 'fl_oz', 'gal'] },
    { id: 'p-surf', name: 'LESCO 90/10 Nonionic Surfactant', fullName: 'LESCO 90/10 Nonionic Surfactant', aliases: [], measure: 'liquid', units: ['tsp', 'fl_oz', 'gal'] },
    { id: 'p-bait', name: 'Advion Ant Gel', fullName: 'Advion Ant Gel', aliases: [], measure: 'weight', units: ['g', 'oz', 'lb'] },
  ],
  pests: [...VoiceFill.PEST_SHEET_PESTS],
  areas: [...VoiceFill.PEST_SHEET_AREAS],
  activity: [...VoiceFill.PEST_SHEET_ACTIVITY],
  visitMethods: [...VoiceFill.PEST_SHEET_VISIT_METHODS],
  productMethods: [...VoiceFill.PEST_SHEET_PRODUCT_METHODS],
};

const product = (over = {}) => ({ productId: 'p-taurus', amount: 0, unit: 'not_said', sameAsLast: false, method: 'not_said', heard: 'Taurus', ...over });
const visit = (over = {}) => ({ pests: [], otherPest: '', areas: [], method: 'not_said', linearFt: 0, activity: 'not_said', heard: '', ...over });
const answer = (over = {}) => ({ products: [], visit: visit(), customerNote: '', officeNote: '', unclear: [], ...over });

describe('validateFill', () => {
  test('a clean answer passes through in the documented shape', () => {
    const transcript = 'Sprayed the perimeter outside for ants, 4 ounces of Taurus, light activity.';
    const out = validateFill(answer({
      products: [product({ amount: 4, unit: 'oz', method: 'perimeter_spray', heard: '4 ounces of Taurus' })],
      visit: visit({ pests: ['Ants'], areas: ['Outside'], method: 'perimeter_spray', activity: 'light', heard: 'perimeter outside for ants' }),
    }), ctx, transcript);
    expect(out).toEqual({
      // A bare ounce of a liquid is a fluid ounce, the way the sheet reads it.
      products: [{ productId: 'p-taurus', amount: 4, unit: 'fl_oz', sameAsLast: false, method: 'perimeter_spray', heard: '4 ounces of Taurus' }],
      visit: { pests: ['Ants'], otherPest: '', areas: ['Outside'], method: 'perimeter_spray', linearFt: null, activity: 'light', heard: 'perimeter outside for ants' },
      customerNote: '',
      officeNote: '',
      unclear: [],
    });
  });

  test('an id that is not on the sheet is dropped to unclear as not_on_sheet', () => {
    const out = validateFill(answer({
      products: [product({ productId: 'p-made-up', amount: 2, unit: 'oz', heard: 'two ounces of the blue stuff' })],
    }), ctx, 'two ounces of the blue stuff on the lanai');
    expect(out.products).toEqual([]);
    expect(out.unclear).toEqual([{ heard: 'two ounces of the blue stuff', reason: 'not_on_sheet' }]);
  });

  test('an off-list pest, area, method and activity never reach the visit', () => {
    const out = validateFill(answer({
      visit: visit({ pests: ['Ants', 'Termites'], areas: ['Attic', 'Inside'], method: 'fogging', activity: 'extreme', heard: 'ants inside' }),
    }), ctx, 'ants inside and some termites in the attic');
    expect(out.visit.pests).toEqual(['Ants']);
    expect(out.visit.areas).toEqual(['Inside']);
    expect(out.visit.method).toBe('');
    expect(out.visit.activity).toBe('');
    // One Check chip per thing heard, however many of its values were off-list.
    expect(out.unclear).toEqual([{ heard: 'ants inside', reason: 'not_on_sheet' }]);
  });

  describe('amounts', () => {
    test('a product with no spoken number keeps no amount and needs no flag', () => {
      const out = validateFill(answer({ products: [product({ heard: 'Taurus' })] }), ctx, 'used Taurus around the foundation');
      expect(out.products[0]).toMatchObject({ productId: 'p-taurus', amount: null, unit: '', sameAsLast: false });
      expect(out.unclear).toEqual([]);
    });

    test('an amount the model made up (no number in the words it heard) is dropped and flagged', () => {
      const out = validateFill(answer({ products: [product({ amount: 4, unit: 'fl_oz', heard: 'Taurus' })] }), ctx, 'used Taurus around the foundation');
      expect(out.products[0]).toMatchObject({ productId: 'p-taurus', amount: null, unit: '' });
      expect(out.unclear).toEqual([{ heard: 'Taurus', reason: 'amount_not_spoken' }]);
    });

    test('a digit amount must equal a number in what was heard', () => {
      const out = validateFill(answer({ products: [product({ amount: 8, unit: 'fl_oz', heard: '4 ounces of Taurus' })] }), ctx, '4 ounces of Taurus');
      expect(out.products[0].amount).toBeNull();
      expect(out.unclear[0].reason).toBe('amount_not_spoken');
    });

    test.each([
      ['a quarter ounce of surfactant', 0.25],
      ['one and a half teaspoons of surfactant', 1.5],
      ['1/2 ounce of surfactant', 0.5],
      ['1 1/2 gallons of surfactant', 1.5],
      ['0.25 ounce of surfactant', 0.25],
    ])('spoken %p is accepted as %p', (heard, amount) => {
      const unit = /teaspoon/.test(heard) ? 'tsp' : /gallon/.test(heard) ? 'gal' : 'fl_oz';
      const out = validateFill(answer({ products: [product({ productId: 'p-surf', amount, unit, heard })] }), ctx, heard);
      expect(out.products[0]).toMatchObject({ productId: 'p-surf', amount, unit });
    });

    test.each([-3, Number.NaN, Infinity, 'lots'])('amount %p is dropped (never a non-positive or non-finite number)', (amount) => {
      const out = validateFill(answer({ products: [product({ amount, unit: 'fl_oz', heard: '4 ounces of Taurus' })] }), ctx, '4 ounces of Taurus');
      expect(out.products[0].amount).toBeNull();
      expect(out.unclear).toEqual([{ heard: '4 ounces of Taurus', reason: 'amount_invalid' }]);
    });

    test('a spoken number with a unit the sheet does not offer for that product is dropped', () => {
      // gel bait is weighed: fl_oz is not one of its units
      const out = validateFill(answer({ products: [product({ productId: 'p-bait', amount: 5, unit: 'fl_oz', heard: '5 ounces of the ant gel' })] }), ctx, '5 ounces of the ant gel');
      expect(out.products[0]).toMatchObject({ productId: 'p-bait', amount: null, unit: '' });
      expect(out.unclear).toEqual([{ heard: '5 ounces of the ant gel', reason: 'bad_unit' }]);
    });

    test('a spoken number with no unit is dropped', () => {
      const out = validateFill(answer({ products: [product({ amount: 4, unit: 'not_said', heard: 'four Taurus' })] }), ctx, 'four Taurus');
      expect(out.products[0].amount).toBeNull();
      expect(out.unclear[0].reason).toBe('bad_unit');
    });

    test('a weight unit is kept on a weighed product and a spoon unit on a liquid', () => {
      const out = validateFill(answer({ products: [
        product({ productId: 'p-bait', amount: 5, unit: 'g', heard: '5 grams of ant gel' }),
        product({ productId: 'p-surf', amount: 2, unit: 'tsp', heard: '2 teaspoons of surfactant' }),
      ] }), ctx, '5 grams of ant gel and 2 teaspoons of surfactant');
      expect(out.products.map((p) => [p.productId, p.amount, p.unit])).toEqual([['p-bait', 5, 'g'], ['p-surf', 2, 'tsp']]);
    });
  });

  describe('same as last time', () => {
    test('is a flag, never a number', () => {
      const out = validateFill(answer({ products: [product({ sameAsLast: true, heard: 'Taurus same as last time' })] }), ctx, 'Taurus same as last time');
      expect(out.products[0]).toMatchObject({ productId: 'p-taurus', amount: null, unit: '', sameAsLast: true });
    });

    test('a spoken number wins over the flag', () => {
      const out = validateFill(answer({ products: [product({ sameAsLast: true, amount: 4, unit: 'fl_oz', heard: '4 ounces Taurus same as last time' })] }), ctx, '4 ounces Taurus same as last time');
      expect(out.products[0]).toMatchObject({ amount: 4, unit: 'fl_oz', sameAsLast: false });
    });

    test('the flag is dropped when no "same as last time" words were heard', () => {
      const out = validateFill(answer({ products: [product({ sameAsLast: true, heard: 'Taurus' })] }), ctx, 'Taurus along the lanai');
      expect(out.products[0].sameAsLast).toBe(false);
      expect(out.unclear).toEqual([{ heard: 'Taurus', reason: 'same_as_last_not_heard' }]);
    });
  });

  describe('heard snippets', () => {
    test('a product whose snippet is not in the transcript is not applied', () => {
      const out = validateFill(answer({ products: [product({ heard: 'Taurus at the front door' })] }), ctx, 'sprayed the back lanai');
      expect(out.products).toEqual([]);
      expect(out.unclear).toEqual([{ heard: 'Taurus at the front door', reason: 'not_heard' }]);
    });

    test('matching ignores case and punctuation', () => {
      const out = validateFill(answer({ products: [product({ heard: 'taurus, 4 oz' })] }), ctx, 'Used TAURUS 4 oz. on the garage');
      expect(out.products).toHaveLength(1);
    });

    test('visit taps without words that were said are not applied', () => {
      const out = validateFill(answer({ visit: visit({ pests: ['Roaches'], heard: 'roaches in the pantry' }) }), ctx, 'did the garage only');
      expect(out.visit).toEqual({ pests: [], otherPest: '', areas: [], method: '', linearFt: null, activity: '', heard: '' });
      expect(out.unclear).toEqual([{ heard: 'roaches in the pantry', reason: 'not_heard' }]);
    });
  });

  test('one row per product: a second mention of the same product is flagged', () => {
    const out = validateFill(answer({ products: [product({ heard: 'Taurus' }), product({ heard: 'the Taurus again' })] }), ctx, 'Taurus and then the Taurus again');
    expect(out.products).toHaveLength(1);
    expect(out.unclear).toEqual([{ heard: 'the Taurus again', reason: 'duplicate_product' }]);
  });

  test('"Other" needs a pest name; with one it passes, without it moves to unclear', () => {
    const named = validateFill(answer({ visit: visit({ pests: ['Other'], otherPest: 'palmetto bugs', heard: 'palmetto bugs' }) }), ctx, 'palmetto bugs on the porch');
    expect(named.visit).toMatchObject({ pests: ['Other'], otherPest: 'palmetto bugs' });
    const bare = validateFill(answer({ visit: visit({ pests: ['Other'], heard: 'some bugs' }) }), ctx, 'some bugs on the porch');
    expect(bare.visit.pests).toEqual([]);
    expect(bare.unclear).toEqual([{ heard: 'some bugs', reason: 'other_pest_unnamed' }]);
  });

  test('linear feet only as a spoken number', () => {
    const ok = validateFill(answer({ visit: visit({ areas: ['Outside'], linearFt: 180, heard: 'about 180 linear feet outside' }) }), ctx, 'sprayed about 180 linear feet outside');
    expect(ok.visit.linearFt).toBe(180);
    const invented = validateFill(answer({ visit: visit({ areas: ['Outside'], linearFt: 180, heard: 'the perimeter outside' }) }), ctx, 'did the perimeter outside');
    expect(invented.visit.linearFt).toBeNull();
    expect(invented.unclear).toEqual([{ heard: 'the perimeter outside', reason: 'amount_not_spoken' }]);
  });

  describe('notes', () => {
    test('the customer / office split passes through untouched', () => {
      const out = validateFill(answer({
        customerNote: 'Treated the perimeter for ants.',
        officeNote: 'Gate code changed to 4412. Customer asked about the invoice.',
      }), ctx, 'Treated the perimeter for ants. Note for the office, gate code changed to 4412.');
      expect(out.customerNote).toBe('Treated the perimeter for ants.');
      expect(out.officeNote).toBe('Gate code changed to 4412. Customer asked about the invoice.');
    });

    test('missing notes become empty strings', () => {
      const out = validateFill(answer({ customerNote: undefined, officeNote: null }), ctx, 'x');
      expect(out.customerNote).toBe('');
      expect(out.officeNote).toBe('');
    });
  });

  describe('length caps', () => {
    test('notes and heard are cut to their caps', () => {
      const long = 'word '.repeat(2000);
      const out = validateFill(answer({
        customerNote: long,
        officeNote: long,
        unclear: [{ heard: long, reason: 'unclear_other' }],
      }), ctx, 'x');
      expect(out.customerNote.length).toBeLessThanOrEqual(CAPS.customerNote);
      expect(out.officeNote.length).toBeLessThanOrEqual(CAPS.officeNote);
      expect(out.unclear[0].heard.length).toBeLessThanOrEqual(CAPS.heard);
    });

    test('lists are capped: products, unclear, pests', () => {
      const many = Array.from({ length: 40 }, (_, i) => ({ heard: `thing ${i}`, reason: 'unclear_other' }));
      const out = validateFill(answer({ unclear: many, visit: visit({ pests: [...ctx.pests, ...ctx.pests], heard: 'ants' }) }), ctx, 'ants');
      expect(out.unclear).toHaveLength(CAPS.unclear);
      expect(out.visit.pests.length).toBeLessThanOrEqual(CAPS.pests);
      expect(new Set(out.visit.pests).size).toBe(out.visit.pests.length);

      const bigCtx = { ...ctx, products: Array.from({ length: 30 }, (_, i) => ({ id: `p${i}`, name: `Prod ${i}`, aliases: [], measure: 'liquid', units: ['fl_oz'] })) };
      const heardAll = Array.from({ length: 30 }, (_, i) => `prod ${i}`).join(' ');
      const products = Array.from({ length: 30 }, (_, i) => product({ productId: `p${i}`, heard: `prod ${i}` }));
      const capped = validateFill(answer({ products }), bigCtx, heardAll);
      expect(capped.products).toHaveLength(CAPS.products);
      expect(capped.unclear.length).toBeGreaterThan(0);
    });

    test('an over-long heard on a product is shortened to the cap', () => {
      const heard = 'Taurus '.repeat(60);
      const out = validateFill(answer({ products: [product({ heard })] }), ctx, heard);
      expect(out.products[0].heard.length).toBeLessThanOrEqual(CAPS.heard);
    });
  });

  test.each([null, undefined, 'text', 42, [], {}])('garbage model output %p yields an empty fill', (raw) => {
    expect(validateFill(raw, ctx, 'anything')).toEqual({
      products: [],
      visit: { pests: [], otherPest: '', areas: [], method: '', linearFt: null, activity: '', heard: '' },
      customerNote: '',
      officeNote: '',
      unclear: [],
    });
  });

  test("the model's own unclear items are kept, deduplicated", () => {
    const out = validateFill(answer({ unclear: [
      { heard: 'the other stuff', reason: 'ambiguous_product' },
      { heard: 'the other stuff', reason: 'ambiguous_product' },
    ] }), ctx, 'the other stuff');
    expect(out.unclear).toEqual([{ heard: 'the other stuff', reason: 'ambiguous_product' }]);
  });
});

describe('fillCounts', () => {
  test('counts taps and note presence, never words', () => {
    const counts = fillCounts({
      products: [{}, {}],
      visit: { pests: ['Ants'], areas: ['Inside', 'Outside'], method: 'spot_treatment', activity: '', linearFt: null },
      customerNote: 'secret words',
      officeNote: '',
      unclear: [{}],
    });
    expect(counts).toEqual({ products: 2, visitFields: 4, unclear: 1, hasCustomerNote: true, hasOfficeNote: false });
    expect(JSON.stringify(counts)).not.toMatch(/secret/);
  });
});

describe('structured-output schema', () => {
  const schema = buildSchema(ctx);

  test('has no numeric bounds (Anthropic rejects them) and no nullable types', () => {
    const text = JSON.stringify(schema);
    expect(text).not.toMatch(/"(minimum|maximum|exclusiveMinimum|exclusiveMaximum|multipleOf)"/);
    expect(text).not.toMatch(/"nullable"/);
    expect(text).not.toMatch(/"type":\[/);
    expect(text).not.toMatch(/"null"/);
  });

  test('every object is closed and requires every key it declares', () => {
    const walk = (node) => {
      if (!node || typeof node !== 'object') return;
      if (node.type === 'object') {
        expect(node.additionalProperties).toBe(false);
        expect([...node.required].sort()).toEqual(Object.keys(node.properties).sort());
      }
      Object.values(node).forEach(walk);
    };
    walk(schema);
  });

  test('visit choices are the sheet exact strings', () => {
    expect(schema.properties.visit.properties.pests.items.enum).toEqual(ctx.pests);
    expect(schema.properties.visit.properties.areas.items.enum).toEqual(ctx.areas);
    expect(schema.properties.visit.properties.activity.enum).toEqual([...ctx.activity, 'not_said']);
    expect(schema.properties.products.items.properties.unit.enum).toEqual(['tsp', 'fl_oz', 'gal', 'g', 'oz', 'lb', 'each', 'not_said']);
  });
});

describe('prompt', () => {
  const text = buildPrompt(ctx, 'sprayed the lanai');
  test('lists every product id, name, alias and unit set, and the transcript', () => {
    expect(text).toContain('p-talak | Atticus Talak 7.9 F | also called: Talstar P | units: tsp, fl_oz, gal');
    expect(text).toContain('p-bait | Advion Ant Gel | units: g, oz, lb');
    expect(text).toContain('PESTS: Ants, Roaches');
    expect(text.endsWith('"""\nsprayed the lanai\n"""')).toBe(true);
  });
});

describe('productMeasure', () => {
  test.each([
    [{ name: 'Taurus SC', inventory_unit: 'fl_oz', formulation: 'SC' }, 'liquid'],
    [{ name: 'Vendetta Plus', formulation: 'gel bait' }, 'weight'],
    [{ name: 'Termidor', default_unit: 'oz', formulation: 'SC' }, 'liquid'],
    [{ name: 'Talstar XTRA Granular', formulation: 'granular' }, 'weight'],
    [{ name: 'Mystery', inventory_unit: 'lbs' }, 'weight'],
    [{ name: 'Station', inventory_unit: 'each' }, 'count'],
    [{ name: 'Surfactant', rate_unit: 'oz/gal' }, 'liquid'],
    [{ name: 'Unknown thing' }, 'liquid'],
  ])('%p is %p', (row, expected) => {
    expect(productMeasure(row)).toBe(expected);
  });
});

describe('sheet choice lists stay in step with the client sheet', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../client/src/components/tech/FastCompleteSheet.jsx'), 'utf8');
  const unitsSource = fs.readFileSync(path.join(__dirname, '../../client/src/lib/fast-complete-products.js'), 'utf8');

  test.each([...VoiceFill.PEST_SHEET_PESTS, ...VoiceFill.PEST_SHEET_AREAS])('the sheet offers %s', (label) => {
    expect(source).toContain(`'${label}'`);
  });
  test.each([...VoiceFill.PEST_SHEET_ACTIVITY])('the sheet offers activity %s', (value) => {
    expect(source).toContain(`value: '${value}'`);
  });
  test.each([...VoiceFill.PEST_SHEET_PRODUCT_METHODS])('the sheet offers method %s', (value) => {
    expect(source).toContain(`value: '${value}'`);
  });
  test('the sheet keeps the unit choices this validator accepts', () => {
    for (const unit of ['tsp', 'fl_oz', 'gal', 'g', 'oz', 'lb', 'each']) expect(unitsSource).toContain(`value: "${unit}"`);
  });
});

describe('call ledger lane', () => {
  const { policyFor } = require('../services/agent-control/lane-policies');
  const { LANES } = require('../services/model-switchboard');

  test('the lane is registered, ledgered and never keeps prompt or response bodies (the transcript is not stored)', () => {
    expect(LANES.some((lane) => lane.id === VoiceFill.LANE_ID)).toBe(true);
    const policy = policyFor(VoiceFill.LANE_ID);
    expect(policy.ledger).toBe('call');
    expect(policy.trace).toBe(false);
    // the call site labels the ledger row with this lane
    expect(fs.readFileSync(path.join(__dirname, '../services/fast-complete-voice-fill.js'), 'utf8')).toContain(`laneId: '${VoiceFill.LANE_ID}'`);
  });

  test('the model comes from the registry tier named by one constant', () => {
    expect(VoiceFill.VOICE_FILL_TIER).toBe('FAST');
    expect(require('../config/models')[VoiceFill.VOICE_FILL_TIER]).toEqual(expect.any(String));
  });
});
