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

// ── Evidence for the SELECTED value (pre-push audit P1s) ─────────────────
describe('quantity and unit are checked together against what was said', () => {
  const one = (productRow, transcript) => validateFill(answer({ products: [productRow] }), ctx, transcript);

  test('"four ounces of Taurus" never authorizes 900 gal (the audit reproduction)', () => {
    const out = one(product({ amount: 900, unit: 'gal', heard: 'four ounces of Taurus' }), 'four ounces of Taurus');
    expect(out.products).toHaveLength(1);
    expect(out.products[0]).toMatchObject({ productId: 'p-taurus', amount: null, unit: '' });
    expect(out.unclear).toEqual([{ heard: 'four ounces of Taurus', reason: 'amount_not_spoken' }]);
  });

  test('the right number in the wrong unit is dropped, the product tap stays', () => {
    const out = one(product({ amount: 4, unit: 'gal', heard: 'four ounces of Taurus' }), 'four ounces of Taurus');
    expect(out.products[0]).toMatchObject({ productId: 'p-taurus', amount: null, unit: '' });
    expect(out.unclear).toEqual([{ heard: 'four ounces of Taurus', reason: 'unit_not_heard' }]);
  });

  test.each([
    ['teaspoons said, fl_oz chosen', 'two teaspoons of surfactant', 2, 'fl_oz'],
    ['ounces said, tsp chosen', '2 ounces of surfactant', 2, 'tsp'],
    ['grams said, oz chosen on a weighed product', '5 grams of ant gel', 5, 'oz'],
    ['pounds said, g chosen', '5 pounds of ant gel', 5, 'g'],
  ])('substituted unit: %s', (_name, heard, amount, unit) => {
    const productId = /gel/.test(heard) ? 'p-bait' : 'p-surf';
    const out = one(product({ productId, amount, unit, heard }), heard);
    expect(out.products[0].amount).toBeNull();
    expect(out.unclear).toEqual([{ heard, reason: 'unit_not_heard' }]);
  });

  test.each([
    ['four', 5], ['four', 40], ['a quarter', 0.5], ['one and a half', 2], ['twenty five', 20], ['three quarters', 0.25],
  ])('word amount "%s ounces" does not authorize %p', (words, amount) => {
    const heard = `${words} ounces of Taurus`;
    const out = one(product({ amount, unit: 'fl_oz', heard }), heard);
    expect(out.products[0].amount).toBeNull();
    expect(out.unclear[0].reason).toBe('amount_not_spoken');
  });

  test.each([
    ['four ounces of Taurus', 4], ['an ounce of Taurus', 1], ['twenty five ounces of Taurus', 25], ['a hundred and eighty ounces of Taurus', 180],
    ['one and a half ounces of Taurus', 1.5], ['two and a half ounces of Taurus', 2.5], ['three quarters of an ounce of Taurus', 0.75],
    ['a quarter of an ounce of Taurus', 0.25], ['point two five ounces of Taurus', 0.25], ['half an ounce of Taurus', 0.5],
    ['1½ ounces of Taurus', 1.5], ['1 1/2 ounces of Taurus', 1.5], ['4 fl oz of Taurus', 4], ['0.25 fluid ounces of Taurus', 0.25],
  ])('"%s" authorizes exactly %p fl oz', (heard, amount) => {
    const out = one(product({ amount, unit: 'fl_oz', heard }), heard);
    expect(out.products[0]).toMatchObject({ amount, unit: 'fl_oz' });
    expect(out.unclear).toEqual([]);
  });

  test('"three or four ounces" authorizes neither number', () => {
    for (const amount of [3, 4]) {
      const out = one(product({ amount, unit: 'fl_oz', heard: 'Taurus, three or four ounces' }), 'Taurus, three or four ounces');
      expect(out.products[0].amount).toBeNull();
      expect(out.unclear[0].reason).toBe('amount_not_spoken');
    }
  });

  test('a number with no unit word is kept only when the product offers exactly one unit', () => {
    const counted = { ...ctx, products: [...ctx.products, { id: 'p-can', name: 'PT Wasp Freeze', fullName: 'PT Wasp Freeze', aliases: [], measure: 'count', units: ['each'] }] };
    const ok = validateFill(answer({ products: [product({ productId: 'p-can', amount: 2, unit: 'each', heard: 'two Wasp Freeze' })] }), counted, 'two Wasp Freeze');
    expect(ok.products[0]).toMatchObject({ amount: 2, unit: 'each' });
    const many = one(product({ amount: 4, unit: 'fl_oz', heard: 'Taurus, four' }), 'Taurus, four');
    expect(many.products[0].amount).toBeNull();
    expect(many.unclear).toEqual([{ heard: 'Taurus, four', reason: 'unclear_unit' }]);
  });

  test('a spoken unit the sheet does not offer is unclear_unit, whatever the model chose', () => {
    const out = one(product({ productId: 'p-surf', amount: 2, unit: 'tsp', heard: 'two tablespoons of surfactant' }), 'two tablespoons of surfactant');
    expect(out.products[0].amount).toBeNull();
    expect(out.unclear).toEqual([{ heard: 'two tablespoons of surfactant', reason: 'unclear_unit' }]);
  });

  test('a transcript word like "constructor" is never a number or a unit', () => {
    const out = one(product({ amount: 4, unit: 'fl_oz', heard: 'Taurus constructor four' }), 'Taurus constructor four');
    expect(out.products[0].amount).toBeNull();
  });
});

describe('the selected product must be named in its heard words', () => {
  const alpine = {
    ...ctx,
    products: [
      ...ctx.products,
      { id: 'p-alpine-wsg', name: 'Alpine WSG', fullName: 'Alpine WSG', aliases: ['Alpine'], measure: 'weight', units: ['g', 'oz', 'lb'] },
      { id: 'p-alpine-dust', name: 'Alpine Dust', fullName: 'Alpine Dust', aliases: ['Alpine dust'], measure: 'weight', units: ['g', 'oz', 'lb'] },
    ],
  };

  test('a valid-looking quote for ANOTHER product swaps nothing in', () => {
    const heard = 'Taurus, four ounces';
    const out = validateFill(answer({ products: [product({ productId: 'p-talak', amount: 4, unit: 'fl_oz', heard })] }), ctx, heard);
    expect(out.products).toEqual([]);
    expect(out.unclear).toEqual([{ heard, reason: 'product_not_heard' }]);
  });

  test('a quote that names no product at all (just an amount) does not pick one', () => {
    const out = validateFill(answer({ products: [product({ amount: 4, unit: 'fl_oz', heard: 'four ounces' })] }), ctx, 'used four ounces on the lanai');
    expect(out.products).toEqual([]);
    expect(out.unclear[0].reason).toBe('product_not_heard');
  });

  test('a generic number in the quote is not a name ("7 ounces" is not Atticus Talak 7.9 F)', () => {
    const out = validateFill(answer({ products: [product({ productId: 'p-talak', amount: 7, unit: 'fl_oz', heard: '7 ounces of the stuff' })] }), ctx, '7 ounces of the stuff');
    expect(out.products).toEqual([]);
  });

  test('an alias counts: "Talstar" names Atticus Talak', () => {
    const out = validateFill(answer({ products: [product({ productId: 'p-talak', amount: 4, unit: 'fl_oz', heard: 'Talstar, four ounces' })] }), ctx, 'Talstar, four ounces');
    expect(out.products[0].productId).toBe('p-talak');
  });

  test('"the Alpine" names two products equally: not picked either way', () => {
    const heard = 'the Alpine, three ounces';
    for (const productId of ['p-alpine-wsg', 'p-alpine-dust']) {
      const out = validateFill(answer({ products: [product({ productId, amount: 3, unit: 'oz', heard })] }), alpine, heard);
      expect(out.products).toEqual([]);
      expect(out.unclear).toEqual([{ heard, reason: 'ambiguous_product' }]);
    }
  });

  test('"Alpine dust" is Alpine Dust, and only that', () => {
    const heard = 'Alpine dust, two ounces';
    const dust = validateFill(answer({ products: [product({ productId: 'p-alpine-dust', amount: 2, unit: 'oz', heard })] }), alpine, heard);
    expect(dust.products[0].productId).toBe('p-alpine-dust');
    const wsg = validateFill(answer({ products: [product({ productId: 'p-alpine-wsg', amount: 2, unit: 'oz', heard })] }), alpine, heard);
    expect(wsg.products).toEqual([]);
  });

  test('one quote naming several products backs each of them', () => {
    const heard = 'Same mix as last time, Taurus, Talstar and the surfactant';
    const out = validateFill(answer({ products: ['p-taurus', 'p-talak', 'p-surf'].map((productId) => product({ productId, sameAsLast: true, heard })) }), ctx, heard);
    expect(out.products.map((p) => p.productId)).toEqual(['p-taurus', 'p-talak', 'p-surf']);
  });
});

describe('every selected visit value needs words that support it', () => {
  const run = (v, transcript) => validateFill(answer({ visit: visit(v) }), ctx, transcript);

  test.each([
    ['pest', { pests: ['Roaches'], heard: 'ants out back' }, 'ants out back', 'Roaches'],
    ['area', { areas: ['Garage'], heard: 'ants out back' }, 'ants out back', 'Garage'],
    ['area (inside)', { areas: ['Inside'], heard: 'ants out back' }, 'ants out back', 'Inside'],
    ['method', { method: 'perimeter_spray', heard: 'ants out back' }, 'ants out back', 'perimeter_spray'],
    ['activity', { activity: 'heavy', heard: 'ants out back' }, 'ants out back', 'heavy'],
  ])('%s with no support is dropped as value_not_heard', (_name, v, transcript, value) => {
    const out = run(v, transcript);
    expect(out.visit).toMatchObject({ pests: [], areas: [], method: '', activity: '' });
    expect(out.unclear).toEqual([{ heard: value, reason: 'value_not_heard' }]);
  });

  test('values with support stay; the unsupported one beside them goes', () => {
    const out = run({ pests: ['Ants', 'Spiders'], areas: ['Outside'], heard: 'ants along the foundation' }, 'ants along the foundation');
    expect(out.visit.pests).toEqual(['Ants']);
    expect(out.visit.areas).toEqual(['Outside']);
    expect(out.unclear).toEqual([{ heard: 'Spiders', reason: 'value_not_heard' }]);
  });

  test('support may sit anywhere in the transcript, not only in the heard sentence', () => {
    const transcript = 'Ants were the issue in the kitchen. Did the perimeter, light activity. Gate was locked.';
    const out = run({ pests: ['Ants'], areas: ['Inside'], method: 'perimeter_spray', activity: 'light', heard: 'Did the perimeter' }, transcript);
    expect(out.visit).toMatchObject({ pests: ['Ants'], areas: ['Inside'], method: 'perimeter_spray', activity: 'light' });
    expect(out.unclear).toEqual([]);
  });

  test('a word never said anywhere in the transcript is dropped (the audit reproduction)', () => {
    const transcript = 'Treated ants outside. Gate was locked.';
    const out = run({ pests: ['Ants', 'Roaches'], areas: ['Outside', 'Inside'], activity: 'heavy', heard: 'Treated ants outside' }, transcript);
    expect(out.visit).toMatchObject({ pests: ['Ants'], areas: ['Outside'], activity: '' });
    expect(out.unclear).toEqual([
      { heard: 'Roaches', reason: 'value_not_heard' },
      { heard: 'Inside', reason: 'value_not_heard' },
      { heard: 'heavy', reason: 'value_not_heard' },
    ]);
  });

  test('"Other" needs its named pest in the words', () => {
    const named = run({ pests: ['Other'], otherPest: 'millipedes', heard: 'millipedes in the garage' }, 'millipedes in the garage');
    expect(named.visit.pests).toEqual(['Other']);
    const unsupported = run({ pests: ['Other'], otherPest: 'millipedes', heard: 'some bugs in the garage' }, 'some bugs in the garage');
    expect(unsupported.visit.pests).toEqual([]);
    expect(unsupported.visit.otherPest).toBe('');
    expect(unsupported.unclear).toEqual([{ heard: 'Other', reason: 'value_not_heard' }]);
  });

  test.each([
    ['pests', 'Roaches', 'cockroaches by the stove'], ['pests', 'Roaches', 'palmetto bugs'], ['pests', 'Ants', 'an ant trail'], ['pests', 'Wasps', 'a mud dauber nest'],
    ['areas', 'Outside', 'around the eaves'], ['areas', 'Outside', 'out front by the entry'], ['areas', 'Inside', 'under the sink'], ['areas', 'Garage', 'the garage door track'],
    ['activity', 'none', 'no activity today'], ['activity', 'light', 'a few ants'], ['activity', 'moderate', 'some activity'], ['activity', 'heavy', 'a lot of them'],
    ['method', 'perimeter_spray', 'ran the perimeter'], ['method', 'spot_treatment', 'spot-treated the corners'],
  ])('lexicon: %s %s is backed by "%s"', (field, value, words) => {
    const key = field === 'pests' || field === 'areas' ? field : field;
    const v = field === 'pests' || field === 'areas' ? { [key]: [value], heard: words } : { [key]: value, heard: words };
    const out = run(v, words);
    expect(out.unclear).toEqual([]);
    expect(out.visit[field]).toEqual(field === 'pests' || field === 'areas' ? [value] : value);
  });
});

describe('an amount belongs to the product whose name it sits with', () => {
  const both = 'Taurus four ounces and Talstar five ounces';
  const run = (rows, transcript = both) => validateFill(answer({ products: rows }), ctx, transcript);
  const row = (productId, amount, unit = 'fl_oz', heard = both) => product({ productId, amount, unit, heard });

  test('the correct pairing passes', () => {
    const out = run([row('p-taurus', 4), row('p-talak', 5)]);
    expect(out.products.map((p) => [p.productId, p.amount, p.unit])).toEqual([['p-taurus', 4, 'fl_oz'], ['p-talak', 5, 'fl_oz']]);
    expect(out.unclear).toEqual([]);
  });

  test('a swap is not authorized: each amount is dropped to amount_not_spoken, both product taps stay', () => {
    const out = run([row('p-taurus', 5), row('p-talak', 4)]);
    expect(out.products.map((p) => [p.productId, p.amount])).toEqual([['p-taurus', null], ['p-talak', null]]);
    expect(out.unclear).toEqual([{ heard: both, reason: 'amount_not_spoken' }]);
  });

  test('"of" joins a number to the name after it, so a number before a name is that name\'s', () => {
    const text = 'four ounces of Taurus and five of Talstar';
    const good = run([row('p-taurus', 4, 'fl_oz', text), row('p-talak', 5, 'fl_oz', text)], text);
    expect(good.products.map((p) => [p.productId, p.amount])).toEqual([['p-taurus', 4], ['p-talak', 5]]);
    const swapped = run([row('p-taurus', 5, 'fl_oz', text), row('p-talak', 4, 'fl_oz', text)], text);
    expect(swapped.products.map((p) => p.amount)).toEqual([null, null]);
  });

  test('"of the" is read through ("four ounces of the Taurus")', () => {
    const text = 'four ounces of the Taurus, five ounces of the Talstar';
    const out = run([row('p-taurus', 4, 'fl_oz', text), row('p-talak', 5, 'fl_oz', text)], text);
    expect(out.products.map((p) => p.amount)).toEqual([4, 5]);
  });

  test('a product with no number in its own span gets none, even if the snippet has numbers', () => {
    const text = 'Taurus and Talstar, five ounces';
    const out = run([row('p-taurus', 5, 'fl_oz', text), row('p-talak', 5, 'fl_oz', text)], text);
    expect(out.products.find((p) => p.productId === 'p-taurus').amount).toBeNull();
    expect(out.products.find((p) => p.productId === 'p-talak').amount).toBe(5);
  });

  test('the unit word is the one attached to the amount: 4 ounces + 5 gallons are not mixed up', () => {
    const text = 'Taurus four ounces and Talstar five gallons';
    const out = run([row('p-taurus', 4, 'fl_oz', text), row('p-talak', 5, 'fl_oz', text)], text);
    expect(out.products.find((p) => p.productId === 'p-taurus')).toMatchObject({ amount: 4, unit: 'fl_oz' });
    expect(out.products.find((p) => p.productId === 'p-talak').amount).toBeNull();
    expect(out.unclear).toEqual([{ heard: text, reason: 'unit_not_heard' }]);
  });

  test('a correction inside the product\'s own span is allowed ("four ounces, no wait, five ounces")', () => {
    const text = 'Taurus, four ounces, no wait, five ounces';
    expect(run([row('p-taurus', 5, 'fl_oz', text)], text).products[0].amount).toBe(5);
  });

  test('without punctuation the same position rule holds', () => {
    const text = 'taurus four ounces talstar five ounces surfactant a quarter ounce';
    const out = run([row('p-taurus', 4, 'fl_oz', text), row('p-talak', 5, 'fl_oz', text), row('p-surf', 0.25, 'fl_oz', text)], text);
    expect(out.products.map((p) => p.amount)).toEqual([4, 5, 0.25]);
    const swapped = run([row('p-taurus', 5, 'fl_oz', text), row('p-surf', 4, 'fl_oz', text)], text);
    expect(swapped.products.map((p) => p.amount)).toEqual([null, null]);
  });
});
