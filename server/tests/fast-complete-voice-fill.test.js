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
// The Checks other than "named but not filled", for tests that feed a partial answer on purpose.
const checksBesidesOmitted = (out) => out.unclear.filter((u) => u.reason !== 'product_said_not_filled' && u.reason !== 'visit_said_not_filled');
// The Checks other than "the visit / an office line was left out", for tests that
// send no visit or notes on purpose.
const withoutVisitOmission = (out) => out.unclear.filter((u) => u.reason !== 'visit_said_not_filled' && u.reason !== 'office_said_not_filled');

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
    expect(withoutVisitOmission(out)).toEqual([{ heard: 'two ounces of the blue stuff', reason: 'not_on_sheet' }]);
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
    expect(withoutVisitOmission(out)).toEqual([{ heard: 'ants inside', reason: 'not_on_sheet' }]);
  });

  describe('amounts', () => {
    test('a product with no spoken number keeps no amount and needs no flag', () => {
      const out = validateFill(answer({ products: [product({ heard: 'Taurus' })] }), ctx, 'used Taurus around the foundation');
      expect(out.products[0]).toMatchObject({ productId: 'p-taurus', amount: null, unit: '', sameAsLast: false });
      expect(withoutVisitOmission(out)).toEqual([]);
    });

    test('an amount the model made up (no number in the words it heard) is dropped and flagged', () => {
      const out = validateFill(answer({ products: [product({ amount: 4, unit: 'fl_oz', heard: 'Taurus' })] }), ctx, 'used Taurus around the foundation');
      expect(out.products[0]).toMatchObject({ productId: 'p-taurus', amount: null, unit: '' });
      expect(withoutVisitOmission(out)).toEqual([{ heard: 'Taurus', reason: 'amount_not_spoken' }]);
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
      expect(withoutVisitOmission(out)).toEqual([{ heard: '4 ounces of Taurus', reason: 'amount_invalid' }]);
    });

    test('a spoken number with a unit the sheet does not offer for that product is dropped', () => {
      // gel bait is weighed: fl_oz is not one of its units
      const out = validateFill(answer({ products: [product({ productId: 'p-bait', amount: 5, unit: 'fl_oz', heard: '5 ounces of the ant gel' })] }), ctx, '5 ounces of the ant gel');
      expect(out.products[0]).toMatchObject({ productId: 'p-bait', amount: null, unit: '' });
      expect(withoutVisitOmission(out)).toEqual([{ heard: '5 ounces of the ant gel', reason: 'bad_unit' }]);
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
      expect(withoutVisitOmission(out)).toEqual([{ heard: 'Taurus', reason: 'same_as_last_not_heard' }]);
    });
  });

  describe('heard snippets', () => {
    test('a product whose snippet is not in the transcript is not applied', () => {
      const out = validateFill(answer({ products: [product({ heard: 'Taurus at the front door' })] }), ctx, 'sprayed the back lanai');
      expect(out.products).toEqual([]);
      expect(withoutVisitOmission(out)).toEqual([{ heard: 'Taurus at the front door', reason: 'not_heard' }]);
    });

    test('matching ignores case and punctuation', () => {
      const out = validateFill(answer({ products: [product({ heard: 'taurus, 4 oz' })] }), ctx, 'Used TAURUS 4 oz. on the garage');
      expect(out.products).toHaveLength(1);
    });

    test('visit taps without words that were said are not applied', () => {
      const out = validateFill(answer({ visit: visit({ pests: ['Roaches'], heard: 'roaches in the pantry' }) }), ctx, 'did the garage only');
      expect(out.visit).toEqual({ pests: [], otherPest: '', areas: [], method: '', linearFt: null, activity: '', heard: '' });
      expect(withoutVisitOmission(out)).toEqual([{ heard: 'roaches in the pantry', reason: 'not_heard' }]);
    });
  });

  test('one row per product: a second mention of the same product is flagged', () => {
    const out = validateFill(answer({ products: [product({ heard: 'Taurus' }), product({ heard: 'the Taurus again' })] }), ctx, 'Taurus and then the Taurus again');
    expect(out.products).toHaveLength(1);
    expect(withoutVisitOmission(out)).toEqual([{ heard: 'the Taurus again', reason: 'duplicate_product' }]);
  });

  test('"Other" needs a pest name; with one it passes, without it moves to unclear', () => {
    const named = validateFill(answer({ visit: visit({ pests: ['Other'], otherPest: 'palmetto bugs', heard: 'palmetto bugs' }) }), ctx, 'palmetto bugs on the porch');
    expect(named.visit).toMatchObject({ pests: ['Other'], otherPest: 'palmetto bugs' });
    const bare = validateFill(answer({ visit: visit({ pests: ['Other'], heard: 'some bugs' }) }), ctx, 'some bugs on the porch');
    expect(bare.visit.pests).toEqual([]);
    expect(withoutVisitOmission(bare)).toEqual([{ heard: 'some bugs', reason: 'other_pest_unnamed' }]);
  });

  test('linear feet only as a spoken number', () => {
    const ok = validateFill(answer({ visit: visit({ areas: ['Outside'], linearFt: 180, heard: 'about 180 linear feet outside' }) }), ctx, 'sprayed about 180 linear feet outside');
    expect(ok.visit.linearFt).toBe(180);
    const invented = validateFill(answer({ visit: visit({ areas: ['Outside'], linearFt: 180, heard: 'the perimeter outside' }) }), ctx, 'did the perimeter outside');
    expect(invented.visit.linearFt).toBeNull();
    // linear feet need a number said with a distance word (changed from amount_not_spoken, audit P1 #3)
    expect(withoutVisitOmission(invented)).toEqual([{ heard: 'the perimeter outside', reason: 'linear_ft_not_heard' }]);
  });

  describe('notes', () => {
    test('the customer / office split passes through untouched', () => {
      const out = validateFill(answer({
        customerNote: 'Treated the perimeter for ants.',
        officeNote: 'Gate code changed to 4412. Customer asked about the invoice.',
      }), ctx, 'Treated the perimeter for ants. Note for the office, gate code changed to 4412. Customer asked about the invoice.');
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
      const out = validateFill(answer({ unclear: many, visit: visit({ pests: [...ctx.pests, ...ctx.pests], heard: 'ants' }) }), ctx, `ants. ${many.map((m) => m.heard).join('. ')}.`);
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
    expect(withoutVisitOmission(out)).toEqual([{ heard: 'the other stuff', reason: 'ambiguous_product' }]);
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
    expect(withoutVisitOmission(out)).toEqual([{ heard: 'four ounces of Taurus', reason: 'amount_not_spoken' }]);
  });

  test('the right number in the wrong unit is dropped, the product tap stays', () => {
    const out = one(product({ amount: 4, unit: 'gal', heard: 'four ounces of Taurus' }), 'four ounces of Taurus');
    expect(out.products[0]).toMatchObject({ productId: 'p-taurus', amount: null, unit: '' });
    expect(withoutVisitOmission(out)).toEqual([{ heard: 'four ounces of Taurus', reason: 'unit_not_heard' }]);
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
    expect(withoutVisitOmission(out)).toEqual([{ heard, reason: 'unit_not_heard' }]);
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
    expect(withoutVisitOmission(out)).toEqual([]);
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
    expect(withoutVisitOmission(many)).toEqual([{ heard: 'Taurus, four', reason: 'unclear_unit' }]);
  });

  test('a spoken unit the sheet does not offer is unclear_unit, whatever the model chose', () => {
    const out = one(product({ productId: 'p-surf', amount: 2, unit: 'tsp', heard: 'two tablespoons of surfactant' }), 'two tablespoons of surfactant');
    expect(out.products[0].amount).toBeNull();
    expect(withoutVisitOmission(out)).toEqual([{ heard: 'two tablespoons of surfactant', reason: 'unclear_unit' }]);
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
    expect(withoutVisitOmission(out)).toEqual([{ heard, reason: 'product_not_heard' }]);
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
      expect(withoutVisitOmission(out)).toEqual([{ heard, reason: 'ambiguous_product' }]);
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
    expect(withoutVisitOmission(out)).toEqual([{ heard: value, reason: 'value_not_heard' }]);
  });

  test('values with support stay; the unsupported one beside them goes', () => {
    const out = run({ pests: ['Ants', 'Spiders'], areas: ['Outside'], heard: 'ants along the foundation' }, 'ants along the foundation');
    expect(out.visit.pests).toEqual(['Ants']);
    expect(out.visit.areas).toEqual(['Outside']);
    expect(withoutVisitOmission(out)).toEqual([{ heard: 'Spiders', reason: 'value_not_heard' }]);
  });

  test('support may sit anywhere in the transcript, not only in the heard sentence', () => {
    const transcript = 'Ants were the issue in the kitchen. Did the perimeter, light activity. Gate was locked.';
    const out = run({ pests: ['Ants'], areas: ['Inside'], method: 'perimeter_spray', activity: 'light', heard: 'Did the perimeter' }, transcript);
    expect(out.visit).toMatchObject({ pests: ['Ants'], areas: ['Inside'], method: 'perimeter_spray', activity: 'light' });
    expect(withoutVisitOmission(out)).toEqual([]);
  });

  test('a word never said anywhere in the transcript is dropped (the audit reproduction)', () => {
    const transcript = 'Treated ants outside. Gate was locked.';
    const out = run({ pests: ['Ants', 'Roaches'], areas: ['Outside', 'Inside'], activity: 'heavy', heard: 'Treated ants outside' }, transcript);
    expect(out.visit).toMatchObject({ pests: ['Ants'], areas: ['Outside'], activity: '' });
    expect(withoutVisitOmission(out)).toEqual([
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
    expect(withoutVisitOmission(unsupported)).toEqual([{ heard: 'Other', reason: 'value_not_heard' }]);
  });

  test.each([
    ['pests', 'Roaches', 'cockroaches by the stove'], ['pests', 'Roaches', 'palmetto bugs'], ['pests', 'Ants', 'an ant trail'], ['pests', 'Wasps', 'a mud dauber nest'],
    ['areas', 'Outside', 'around the eaves'], ['areas', 'Outside', 'out front by the entry'], ['areas', 'Inside', 'under the sink'], ['areas', 'Garage', 'the garage door track'],
    ['activity', 'none', 'no activity today'], ['activity', 'light', 'a few ants'], ['activity', 'moderate', 'some activity'], ['activity', 'heavy', 'a lot of ants'],
    ['method', 'perimeter_spray', 'ran the perimeter'], ['method', 'spot_treatment', 'spot-treated the corners'],
  ])('lexicon: %s %s is backed by "%s"', (field, value, words) => {
    const key = field === 'pests' || field === 'areas' ? field : field;
    const v = field === 'pests' || field === 'areas' ? { [key]: [value], heard: words } : { [key]: value, heard: words };
    const out = run(v, words);
    expect(withoutVisitOmission(out)).toEqual([]);
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
    expect(withoutVisitOmission(out)).toEqual([]);
  });

  test('a swap is not authorized: each amount is dropped to amount_not_spoken, both product taps stay', () => {
    const out = run([row('p-taurus', 5), row('p-talak', 4)]);
    expect(out.products.map((p) => [p.productId, p.amount])).toEqual([['p-taurus', null], ['p-talak', null]]);
    expect(withoutVisitOmission(out)).toEqual([{ heard: both, reason: 'amount_not_spoken' }]);
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
    expect(withoutVisitOmission(out)).toEqual([{ heard: text, reason: 'unit_not_heard' }]);
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

describe('ownership is read off the transcript, not the model\'s stitched quote (audit round 3)', () => {
  const TRANSCRIPT = 'Taurus four ounces and Talstar five ounces';
  const run = (rows, transcript = TRANSCRIPT) => validateFill(answer({ products: rows }), ctx, transcript);
  const row = (productId, amount, heard, extra = {}) => product({ productId, amount, unit: 'fl_oz', heard, ...extra });

  test('the audit reproduction: heard "Taurus ... five ounces" does not give Taurus the five', () => {
    const out = run([row('p-taurus', 5, 'Taurus ... five ounces')]);
    expect(out.products).toHaveLength(1);
    expect(out.products[0]).toMatchObject({ productId: 'p-taurus', amount: null, unit: '' });
    expect(checksBesidesOmitted(out)).toEqual([{ heard: 'Taurus ... five ounces', reason: 'amount_not_spoken' }]);
  });

  test('the same stitched quote with the right number passes', () => {
    expect(run([row('p-taurus', 4, 'Taurus ... four ounces')]).products[0]).toMatchObject({ amount: 4, unit: 'fl_oz' });
    expect(run([row('p-talak', 5, 'Talstar ... five ounces')]).products[0]).toMatchObject({ amount: 5, unit: 'fl_oz' });
  });

  test('a stitched quote cannot pick up the other product\'s number in either order', () => {
    expect(run([row('p-talak', 4, 'Taurus four ounces ... Talstar')]).products[0].amount).toBeNull();
    const reversed = 'four ounces of Taurus and five of Talstar';
    expect(run([row('p-taurus', 5, 'four ounces of Taurus ... five of')], reversed).products[0].amount).toBeNull();
    expect(run([row('p-talak', 4, 'four ounces ... of Talstar')], reversed).products[0].amount).toBeNull();
  });

  test('a product named twice: the heard piece points at its own mention', () => {
    const text = 'Taurus four ounces on the front. Later more Taurus, six ounces on the back.';
    expect(run([row('p-taurus', 6, 'more Taurus, six ounces')], text).products[0].amount).toBe(6);
    expect(run([row('p-taurus', 4, 'more Taurus, six ounces')], text).products[0].amount).toBeNull();
    expect(run([row('p-taurus', 4, 'Taurus four ounces')], text).products[0].amount).toBe(4);
  });

  test('when the heard words cannot point at one mention, either mention\'s number is allowed, never another product\'s', () => {
    const text = 'Taurus four ounces on the front. Talstar five ounces. Later Taurus, six ounces on the back.';
    expect(run([row('p-taurus', 4, 'Taurus')], text).products[0].amount).toBe(4);
    expect(run([row('p-taurus', 6, 'Taurus')], text).products[0].amount).toBe(6);
    expect(run([row('p-taurus', 5, 'Taurus')], text).products[0].amount).toBeNull();
  });
});

describe('a product method needs its word in that product\'s span or sentence', () => {
  const run = (productRow, transcript) => validateFill(answer({ products: [productRow] }), ctx, transcript);
  const withMethod = (method, heard) => product({ method, heard });

  test('"Used Taurus" with a model-chosen granular_broadcast: cleared, tap kept, Check raised (the audit reproduction)', () => {
    const out = run(withMethod('granular_broadcast', 'Used Taurus'), 'Used Taurus');
    expect(out.products).toHaveLength(1);
    expect(out.products[0]).toMatchObject({ productId: 'p-taurus', method: '' });
    expect(withoutVisitOmission(out)).toEqual([{ heard: 'Used Taurus', reason: 'method_not_heard' }]);
  });

  test.each([
    ['spot_treatment', 'Spot treated with Taurus'], ['spot_treatment', 'Taurus, spot-treated the corners'],
    ['perimeter_spray', 'Taurus around the house'], ['perimeter_spray', 'Taurus on the foundation'], ['perimeter_spray', 'Taurus as a barrier'],
    ['bait_placement', 'Placed Taurus under the sink'], ['bait_placement', 'Taurus bait stations'],
    ['granular_broadcast', 'Spread the Taurus with a spreader'], ['granular_broadcast', 'Taurus granules, broadcast'],
  ])('%s is kept for "%s"', (method, words) => {
    const out = run(withMethod(method, 'Taurus'), words);
    expect(out.products[0].method).toBe(method);
    expect(withoutVisitOmission(out)).toEqual([]);
  });

  test('a method word in a different sentence, before the product, does not count', () => {
    const out = run(withMethod('perimeter_spray', 'Used Taurus'), 'We walked the perimeter. Used Taurus.');
    expect(out.products[0].method).toBe('');
    expect(withoutVisitOmission(out)).toEqual([{ heard: 'Used Taurus', reason: 'method_not_heard' }]);
  });

  test('a method word in a LATER sentence does not back the product (Codex #5580 r2): cleared with a Check', () => {
    const out = run(withMethod('perimeter_spray', 'Used Taurus'), 'Used Taurus. Ran the perimeter.');
    expect(out.products[0].method).toBe('');
    expect(out.unclear.map((u) => u.reason)).toContain('method_not_heard');
  });

  test('a method word in the same clause before the product counts', () => {
    const out = run(withMethod('perimeter_spray', 'sprayed Taurus around the perimeter'), 'Sprayed Taurus around the perimeter.');
    expect(out.products[0].method).toBe('perimeter_spray');
  });

  test('a method word that follows the NEXT product does not back this one', () => {
    const out = validateFill(answer({ products: [withMethod('spot_treatment', 'Used Taurus')] }), ctx, 'Used Taurus. Talstar. Spot treated the garage.');
    expect(out.products[0].method).toBe('');
  });
});

describe('linear feet need a quantity said with a distance word', () => {
  const run = (linearFt, transcript, heard = transcript) => validateFill(answer({ visit: visit({ areas: ['Outside'], linearFt, heard }) }), ctx, transcript);

  test('"four ounces of Taurus" never becomes 4 linear feet (the audit reproduction)', () => {
    const out = run(4, 'four ounces of Taurus outside');
    expect(out.visit.linearFt).toBeNull();
    expect(checksBesidesOmitted(out)).toEqual([{ heard: 'four ounces of Taurus outside', reason: 'linear_ft_not_heard' }]);
  });

  test.each([
    ['sprayed 180 linear feet outside', 180], ['about two hundred feet outside', 200], ['120 ft of foundation outside', 120],
    ['a hundred and fifty linear feet outside', 150], ['sprayed 80 lf outside', 80], ['one foot outside', 1],
  ])('"%s" authorizes exactly %p', (words, feet) => {
    const out = run(feet, words);
    expect(out.visit.linearFt).toBe(feet);
    expect(withoutVisitOmission(out)).toEqual([]);
  });

  test('a different number than the one said with the distance word is dropped', () => {
    const out = run(200, 'sprayed 180 linear feet outside, 200 ounces');
    expect(out.visit.linearFt).toBeNull();
    expect(out.unclear[0].reason).toBe('linear_ft_not_heard');
  });
});

describe('audit round 4: carrier volume, negation, field context, same-as-last, units', () => {
  const run = (rows, transcript) => validateFill(answer({ products: rows }), ctx, transcript);
  const row = (productId, amount, unit, heard, extra = {}) => product({ productId, amount, unit, heard, ...extra });

  describe('a carrier volume is not a product amount', () => {
    test('"a gallon of Taurus solution": the model\'s 1 gal is rejected as carrier_volume, the tap stays (the audit case)', () => {
      const text = 'Mixed up a gallon of Taurus solution in the sprayer';
      const out = run([row('p-taurus', 1, 'gal', 'a gallon of Taurus solution')], text);
      expect(out.products).toHaveLength(1);
      expect(out.products[0]).toMatchObject({ productId: 'p-taurus', amount: null, unit: '' });
      expect(withoutVisitOmission(out)).toEqual([{ heard: 'a gallon of Taurus solution', reason: 'carrier_volume' }]);
    });

    test.each([
      ['a gallon of mix', 'Taurus, a gallon of mix'],
      ['gallons of mix', 'two gallons of mix with the Taurus'],
      ['in a gallon', 'Taurus in a gallon'],
      ['a gallon of water', 'Taurus, a gallon of water'],
    ])('carrier phrase "%s" never becomes the product\'s amount', (_name, text) => {
      const amount = /two/.test(text) ? 2 : 1;
      const out = run([row('p-taurus', amount, 'gal', text)], text);
      expect(out.products).toHaveLength(1);
      expect(out.products[0].amount).toBeNull();
      expect(out.unclear).toHaveLength(1);
    });

    test('the product amount beside the carrier volume still passes; the carrier volume is not accepted for it', () => {
      const text = 'Taurus four ounces in a gallon of water';
      expect(run([row('p-taurus', 4, 'fl_oz', text)], text).products[0]).toMatchObject({ amount: 4, unit: 'fl_oz' });
      const swapped = run([row('p-taurus', 1, 'gal', text)], text);
      expect(swapped.products[0].amount).toBeNull();
    });

    test('"four ounces of Taurus in the tank" is still four ounces of Taurus', () => {
      const text = 'four ounces of Taurus in the tank';
      expect(run([row('p-taurus', 4, 'fl_oz', text)], text).products[0].amount).toBe(4);
    });
  });

  describe('a negated mention is not a use of the product', () => {
    test.each([
      ['Did not use four ounces of Taurus', 'p-taurus', 4, 'four ounces of Taurus'],
      ['We skipped the Talstar today', 'p-talak', 0, 'skipped the Talstar'],
      ['no surfactant this time', 'p-surf', 0, 'no surfactant this time'],
      ['Did not use Taurus this time, just the Talstar', 'p-taurus', 0, 'Did not use Taurus'],
      ['ran out of Taurus', 'p-taurus', 0, 'ran out of Taurus'],
      ['Talstar instead of Taurus', 'p-taurus', 0, 'instead of Taurus'],
      ['I used Taurus not', 'p-taurus', 0, 'Taurus not'],
    ])('"%s" does not apply %s', (transcript, productId, amount, heard) => {
      const out = run([row(productId, amount, amount ? 'fl_oz' : 'not_said', heard)], transcript);
      expect(out.products).toEqual([]);
      expect(checksBesidesOmitted(out)).toEqual([{ heard, reason: 'negated_product' }]);
    });

    test('the product used in the next clause is still applied', () => {
      const out = run([row('p-talak', 4, 'fl_oz', 'just the Talstar, four ounces')], 'Did not use Taurus this time, just the Talstar, four ounces');
      expect(out.products[0]).toMatchObject({ productId: 'p-talak', amount: 4 });
    });

    test('"no wait" is a correction, not a negation', () => {
      const text = 'Taurus, four ounces, no wait, five ounces';
      expect(run([row('p-taurus', 5, 'fl_oz', text)], text).products[0].amount).toBe(5);
    });

    test('a product with a positive mention elsewhere stays, and only the positive mention\'s quantities count', () => {
      const text = 'Did not use four ounces of Taurus on the front. Later used Taurus, six ounces on the back.';
      const six = run([row('p-taurus', 6, 'fl_oz', 'Later used Taurus, six ounces')], text);
      expect(six.products[0]).toMatchObject({ amount: 6 });
      const four = run([row('p-taurus', 4, 'fl_oz', 'Later used Taurus, six ounces')], text);
      expect(four.products).toHaveLength(1);
      expect(four.products[0].amount).toBeNull();
      // even when the heard words point at the negated mention, its quantity is not the product's
      const pointed = run([row('p-taurus', 4, 'fl_oz', 'four ounces of Taurus')], text);
      expect(pointed.products[0].amount).toBeNull();
    });
  });

  describe('units follow the same evidence as the sheet', () => {
    test('a usual unit in grams makes the row weight; an inventory unit still wins over it', () => {
      expect(productMeasure({ name: 'Mystery', formulation: 'SC', usual_unit: 'g' })).toBe('weight');
      expect(productMeasure({ name: 'Mystery', inventory_unit: 'fl_oz', usual_unit: 'g' })).toBe('liquid');
      expect(productMeasure({ name: 'Mystery', usual_unit: 'oz', formulation: 'SC' })).toBe('liquid');
      expect(productMeasure({ name: 'Mystery', formulation: 'SC' })).toBe('liquid');
    });
  });

  describe('field context for visit values', () => {
    const visitRun = (v, transcript, extraProducts = []) => validateFill(
      answer({ visit: visit(v) }),
      { ...ctx, products: [...ctx.products, ...extraProducts] },
      transcript,
    );

    test('a pest word inside a product name is not evidence for the pest', () => {
      const text = 'Placed Advion Ant Gel in the kitchen';
      const out = visitRun({ pests: ['Ants'], areas: ['Inside'], heard: 'Placed Advion Ant Gel in the kitchen' }, text);
      expect(out.visit.pests).toEqual([]);
      expect(out.visit.areas).toEqual(['Inside']);
      expect(checksBesidesOmitted(out)).toEqual([{ heard: 'Ants', reason: 'value_not_heard' }]);
    });

    test('the same word used as a pest still counts ("ants in the kitchen" beside the product)', () => {
      const text = 'Ants in the kitchen. Placed Advion Ant Gel.';
      expect(visitRun({ pests: ['Ants'], heard: 'Ants in the kitchen' }, text).visit.pests).toEqual(['Ants']);
    });

    test('"Used some Taurus" is not moderate activity', () => {
      const out = visitRun({ activity: 'moderate', heard: 'Used some Taurus' }, 'Used some Taurus');
      expect(out.visit.activity).toBe('');
      expect(checksBesidesOmitted(out)).toEqual([{ heard: 'moderate', reason: 'value_not_heard' }]);
    });

    test.each([
      ['moderate', 'We saw some activity out back'], ['moderate', 'some roaches in the pantry'], ['light', 'a few ants by the door'],
      ['heavy', 'a lot of ants out front'], ['heavy', 'lots of roaches'], ['light', 'saw a little activity'],
      ['light', 'Activity was light'], ['moderate', 'moderate'], ['heavy', 'heavy pressure'], ['none', 'no activity today'],
    ])('activity %s is backed by "%s"', (level, words) => {
      expect(visitRun({ activity: level, heard: words }, words).visit.activity).toBe(level);
    });

    test.each([
      ['light', 'a few minutes later we left'], ['heavy', 'bad gate, locked'], ['moderate', 'some of the Taurus'], ['heavy', 'lots of Taurus'],
    ])('loose activity word without activity context: %s from "%s" is dropped', (level, words) => {
      expect(visitRun({ activity: level, heard: words }, words).visit.activity).toBe('');
    });
  });

  describe('"same as last time" needs a positive dose or mix phrase', () => {
    const same = (heard, transcript = heard) => run([row('p-taurus', 0, 'not_said', heard, { sameAsLast: true })], transcript).products[0];

    test.each([
      'Taurus same as last time', 'same mix as last time, Taurus', 'Taurus, same amount', 'Taurus same rate', 'the usual mix, Taurus', 'Taurus, the usual amount', 'Taurus like last time',
    ])('"%s" is accepted', (heard) => {
      expect(same(heard).sameAsLast).toBe(true);
    });

    test.each([
      ['Taurus, last time I used four ounces', 'last time I used'], ['Taurus same as last time but not today', 'but not today'],
      ['Taurus on the same area', 'same area'], ['Taurus as before', 'as before'], ['Taurus, usual', 'usual'], ['Taurus same mix, but not today', 'but not today'],
    ])('"%s" is not (%s)', (heard) => {
      const out = run([row('p-taurus', 0, 'not_said', heard, { sameAsLast: true })], heard);
      expect(out.products[0].sameAsLast).toBe(false);
      expect(withoutVisitOmission(out)).toEqual([{ heard, reason: 'same_as_last_not_heard' }]);
    });
  });
});

describe('Codex #5580 round 2', () => {
  test('a quantity in a later sentence never belongs to the product', () => {
    const transcript = 'Used Taurus outside. The customer had four ounces of concentrate in the garage.';
    const out = validateFill(answer({ products: [{ productId: 'p-taurus', amount: 4, unit: 'fl_oz', sameAsLast: false, method: '', heard: 'Taurus ... four ounces' }] }), ctx, transcript);
    expect(out.products.find((p) => p.productId === 'p-taurus')?.amount ?? null).toBeNull();
  });

  test('two products in one sentence: each keeps only the method in its own clause', () => {
    const transcript = 'Spot treated with Talstar and sprayed Taurus around the perimeter.';
    const out = validateFill(answer({ products: [
      { productId: 'p-taurus', amount: 0, unit: 'not_said', sameAsLast: false, method: 'spot_treatment', heard: 'sprayed Taurus around the perimeter' },
    ] }), ctx, transcript);
    expect(out.products[0].method).toBe('');
    const ok = validateFill(answer({ products: [
      { productId: 'p-taurus', amount: 0, unit: 'not_said', sameAsLast: false, method: 'perimeter_spray', heard: 'sprayed Taurus around the perimeter' },
    ] }), ctx, transcript);
    expect(ok.products[0].method).toBe('perimeter_spray');
  });

  test('negated visit values are not evidence', () => {
    const heavy = validateFill(answer({ visit: visit({ activity: 'heavy', heard: 'Activity was not heavy, just light' }) }), ctx, 'Activity was not heavy, just light.');
    expect(heavy.visit.activity).toBe('');
    const light = validateFill(answer({ visit: visit({ activity: 'light', heard: 'Activity was not heavy, just light' }) }), ctx, 'Activity was not heavy, just light.');
    expect(light.visit.activity).toBe('light');
    const method = validateFill(answer({ visit: visit({ method: 'perimeter_spray', heard: 'Did not perimeter spray; spot treated' }) }), ctx, 'Did not perimeter spray; spot treated.');
    expect(method.visit.method).toBe('');
  });

  test('"no activity" still backs none', () => {
    const out = validateFill(answer({ visit: visit({ activity: 'none', heard: 'No activity' }) }), ctx, 'No activity today.');
    expect(out.visit.activity).toBe('none');
  });

  test('an entry code the model put in the customer note moves to the office note', () => {
    const out = validateFill(answer({ customerNote: 'Treated the front entry for ants. Gate code 1234.', officeNote: '' }), ctx, 'Treated the front entry for ants. Office note: gate code 1234.');
    expect(out.customerNote).toBe('Treated the front entry for ants.');
    expect(out.officeNote).toContain('Gate code 1234');
  });

  test('a sentence addressed to the office moves to the office note', () => {
    const out = validateFill(answer({ customerNote: 'Sprayed the perimeter. Tell the office the dog was loose.', officeNote: '' }), ctx, 'Sprayed the perimeter. Tell the office the dog was loose.');
    expect(out.customerNote).toBe('Sprayed the perimeter.');
    expect(out.officeNote).toBe('Tell the office the dog was loose.');
  });
});

describe('Codex #5580 round 3', () => {
  const taurus = (over = {}) => ({ productId: 'p-taurus', amount: 0, unit: 'not_said', sameAsLast: false, method: '', heard: 'Taurus', ...over });

  test('a range ("between three and four", "three to four") is no amount', () => {
    for (const transcript of ['Between three and four ounces of Taurus.', 'Three to four ounces of Taurus.']) {
      const out = validateFill(answer({ products: [taurus({ amount: 4, unit: 'fl_oz', heard: transcript.replace(/\.$/, '') })] }), ctx, transcript);
      expect(out.products[0]?.amount ?? null).toBeNull();
    }
  });

  test('a product named for another visit is not this visit\'s', () => {
    const transcript = 'Last time I used four ounces of Taurus; today I used Talstar.';
    const out = validateFill(answer({ products: [taurus({ amount: 4, unit: 'fl_oz', heard: 'four ounces of Taurus' })] }), ctx, transcript);
    expect(out.products.some((p) => p.productId === 'p-taurus')).toBe(false);
  });

  test('a product clearly named but left out of the fill becomes a Check', () => {
    const transcript = 'Used Taurus four ounces and Talstar five ounces.';
    const out = validateFill(answer({ products: [taurus({ amount: 4, unit: 'fl_oz', heard: 'Taurus four ounces' })] }), ctx, transcript);
    expect(withoutVisitOmission(out)).toEqual([{ heard: 'Talstar', reason: 'product_said_not_filled' }]);
  });

  test('words that also name another product, or that a Check already quotes, add no second Check', () => {
    const alpines = { ...ctx, products: [...ctx.products,
      { id: 'p-alp-wsg', name: 'Alpine WSG', fullName: 'Alpine WSG', aliases: [], measure: 'weight', units: ['g', 'oz', 'lb'] },
      { id: 'p-alp-dust', name: 'Alpine Dust', fullName: 'Alpine Dust', aliases: [], measure: 'weight', units: ['g', 'oz', 'lb'] }] };
    const dust = { productId: 'p-alp-dust', amount: 2, unit: 'oz', sameAsLast: false, method: '', heard: 'Alpine dust, two ounces' };
    const out = validateFill(answer({ products: [dust] }), alpines, 'Alpine dust, two ounces, in the attic.');
    expect(withoutVisitOmission(out)).toEqual([]);
  });

  test('an Other pest matches whole words only', () => {
    const out = validateFill(answer({ visit: visit({ pests: ['Other'], otherPest: 'rat', heard: 'applied at a moderate rate' }) }), ctx, 'Applied at a moderate rate.');
    expect(out.visit.pests).not.toContain('Other');
  });

  test('a customer-note sentence the tech never said becomes a Check', () => {
    const out = validateFill(answer({ customerNote: 'Treated the perimeter. Found a severe interior infestation.' }), ctx, 'Treated the perimeter.');
    expect(out.customerNote).toBe('Treated the perimeter.');
    expect(out.unclear.map((u) => u.reason)).toContain('note_not_heard');
  });
});

describe('Codex #5580 round 3: lone common-word names', () => {
  const withSuspend = { ...ctx, products: [...ctx.products, { id: 'p-suspend', name: 'Suspend Polyzone', fullName: 'Suspend Polyzone', aliases: [], measure: 'liquid', units: ['tsp', 'fl_oz', 'gal'] }] };
  const suspend = (over = {}) => ({ productId: 'p-suspend', amount: 0, unit: 'not_said', sameAsLast: false, method: '', heard: 'suspend', ...over });

  test('one ordinary word of a longer name, with no application wording, is not the product', () => {
    const transcript = 'The office asked us to suspend service. Sprayed Taurus around the perimeter.';
    const out = validateFill(answer({ products: [suspend({ heard: 'suspend' })] }), withSuspend, transcript);
    expect(out.products).toEqual([]);
    expect(out.unclear).toContainEqual({ heard: 'suspend', reason: 'product_not_heard' });
    // and no "named but not filled" Check for it either
    expect(out.unclear.filter((u) => /suspend/i.test(u.heard) && u.reason === 'product_said_not_filled')).toEqual([]);
  });

  test('the same word beside an amount or "used" is the product', () => {
    for (const transcript of ['Used Suspend around the lanai.', 'Two ounces of Suspend on the lanai.']) {
      const out = validateFill(answer({ products: [suspend({ heard: 'Suspend' })] }), withSuspend, transcript);
      expect(out.products.map((p) => p.productId)).toEqual(['p-suspend']);
    }
  });
});

describe('Codex #5580 round 3 pre-push audit', () => {
  const taurus = (over = {}) => ({ productId: 'p-taurus', amount: 0, unit: 'not_said', sameAsLast: false, method: '', heard: 'Taurus', ...over });

  test('a dose the tech negated or corrected is not the amount; the one they meant is', () => {
    const negated = 'Used Taurus, not four ounces, just two ounces.';
    expect(validateFill(answer({ products: [taurus({ amount: 4, unit: 'fl_oz', heard: negated })] }), ctx, negated).products[0].amount).toBeNull();
    expect(validateFill(answer({ products: [taurus({ amount: 2, unit: 'fl_oz', heard: negated })] }), ctx, negated).products[0].amount).toBe(2);
    const corrected = 'Taurus, four ounces, no wait, five ounces.';
    expect(validateFill(answer({ products: [taurus({ amount: 4, unit: 'fl_oz', heard: corrected })] }), ctx, corrected).products[0].amount).toBeNull();
  });

  test('a sentence said only to the office stays out of the customer note even without its label', () => {
    const transcript = 'Treated the kitchen for roaches. Note for the office: customer is disputing the invoice.';
    const out = validateFill(answer({ customerNote: 'Treated the kitchen for roaches. Customer is disputing the invoice.' }), ctx, transcript);
    expect(out.customerNote).toBe('Treated the kitchen for roaches.');
    expect(out.officeNote).toBe('Customer is disputing the invoice.');
  });
});

describe('customer note = the tech\'s own clauses, word for word', () => {
  test.each([
    ['Used four ounces of Taurus.', 'Used forty gallons of Taurus.'],
    ['Did not treat inside. Treated outside.', 'Treated inside and outside.'],
    ['Did not treat inside.', 'Treat inside.'],
  ])('transcript "%s" refuses the note "%s"', (transcript, note) => {
    const out = validateFill(answer({ customerNote: note }), ctx, transcript);
    expect(out.customerNote).toBe('');
    expect(out.unclear).toContainEqual({ heard: note, reason: 'note_not_heard' });
  });

  test('a whole clause the tech said is kept as said', () => {
    const out = validateFill(answer({ customerNote: 'Treated the kitchen for roaches.' }), ctx, 'Treated the kitchen for roaches, light activity.');
    expect(out.customerNote).toBe('Treated the kitchen for roaches.');
  });

  test.each([
    'Office, can you check why the invoice went out twice?',
    'This one is for the office only, the invoice went out twice.',
  ])('"%s" is office-only even when the model drops the label', (transcript) => {
    const out = validateFill(answer({ customerNote: 'The invoice went out twice.' }), ctx, `Treated the garage. ${transcript}`);
    expect(out.customerNote).toBe('');
  });
});

describe('internal matters never reach the customer note, labeled or not', () => {
  test.each([
    'Customer is disputing the invoice.',
    'Gate was locked so I could not get in the back.',
    'Dog was loose in the yard.',
  ])('"%s" goes to the office note', (said) => {
    const out = validateFill(answer({ customerNote: `Treated the garage. ${said}` }), ctx, `Treated the garage. ${said}`);
    expect(out.customerNote).toBe('Treated the garage.');
    expect(out.officeNote).toBe(said);
  });
});

describe('a number said right before a product name', () => {
  const row = (productId, amount, heard) => ({ productId, amount, unit: 'fl_oz', sameAsLast: false, method: '', heard });
  const fill = (rows, transcript) => validateFill(answer({ products: rows }), ctx, transcript);

  test('"4 ounces Taurus and 5 ounces Talstar": each name keeps its own number, never the next one\'s', () => {
    const t = 'Used 4 ounces Taurus and 5 ounces Talstar.';
    expect(fill([row('p-taurus', 5, t)], t).products[0].amount).toBeNull();
    expect(fill([row('p-taurus', 4, t)], t).products[0].amount).toBe(4);
    expect(fill([row('p-talak', 5, t)], t).products[0].amount).toBe(5);
    expect(fill([row('p-talak', 4, t)], t).products[0].amount).toBeNull();
  });

  test('"Taurus 4 ounces Talstar": either product could own the 4, so neither does', () => {
    const t = 'Taurus 4 ounces Talstar.';
    expect(fill([row('p-taurus', 4, t)], t).products[0].amount).toBeNull();
    expect(fill([row('p-talak', 4, t)], t).products[0].amount).toBeNull();
  });

  test('"Taurus, 4 ounces, Talstar": the pause keeps the 4 with Taurus', () => {
    const t = 'Taurus, 4 ounces, Talstar.';
    expect(fill([row('p-taurus', 4, t)], t).products[0].amount).toBe(4);
  });
});

describe('a contradicted "same as last time" is no flag', () => {
  test.each(['Used Taurus, not same as last time.', 'Taurus, not the same as last time.', 'Taurus same as last time but a different rate.'])('"%s"', (t) => {
    const out = validateFill(answer({ products: [{ productId: 'p-taurus', amount: 0, unit: 'not_said', sameAsLast: true, method: '', heard: t.replace(/\.$/, '') }] }), ctx, t);
    expect(out.products[0].sameAsLast).toBe(false);
  });
});

describe('spoken numbers past a hundred', () => {
  test.each([['one hundred ten', 110], ['a hundred and twelve', 112], ['one hundred nineteen', 119], ['one hundred five', 105]])('"%s" is %p, never its tail', (words, value) => {
    const t = `Used ${words} ounces of Taurus.`;
    const run = (amount) => validateFill(answer({ products: [{ productId: 'p-taurus', amount, unit: 'fl_oz', sameAsLast: false, method: '', heard: t.replace(/\.$/, '') }] }), ctx, t).products[0].amount;
    expect(run(value)).toBe(value);
    expect(run(value - 100)).toBeNull();
  });
});

test('"same as last time" does not cross a "but" to another product', () => {
  const t = 'Taurus same as last time, but Talstar was a new product today.';
  const out = validateFill(answer({ products: [{ productId: 'p-talak', amount: 0, unit: 'not_said', sameAsLast: true, method: '', heard: 'Talstar was a new product today' }] }), ctx, t);
  expect(out.products[0].sameAsLast).toBe(false);
});

describe('a negation after the product name', () => {
  test.each([
    'Four ounces of Taurus were not used; today I used Talstar.',
    "Taurus wasn't used today, just Talstar.",
    'Taurus was never applied, just Talstar.',
  ])('"%s" does not apply Taurus', (t) => {
    const out = validateFill(answer({ products: [{ productId: 'p-taurus', amount: 4, unit: 'fl_oz', sameAsLast: false, method: '', heard: 'Taurus' }] }), ctx, t);
    expect(out.products).toEqual([]);
    expect(out.unclear.map((u) => u.reason)).toContain('negated_product');
  });

  test('"Taurus was used, not Talstar" still applies Taurus', () => {
    const t = 'Taurus was used, not Talstar.';
    const out = validateFill(answer({ products: [{ productId: 'p-taurus', amount: 0, unit: 'not_said', sameAsLast: false, method: '', heard: 'Taurus was used' }] }), ctx, t);
    expect(out.products.map((p) => p.productId)).toEqual(['p-taurus']);
  });
});

describe('formatted numbers', () => {
  test('"1,200 linear feet" is 1200, never 200', () => {
    const t = 'Sprayed 1,200 linear feet outside.';
    const run = (linearFt) => validateFill(answer({ visit: visit({ areas: ['Outside'], linearFt, heard: t.replace(/\.$/, '') }) }), ctx, t).visit.linearFt;
    expect(run(1200)).toBe(1200);
    expect(run(200)).toBeNull();
  });

  test('"3-4 ounces" is a range: neither end is the amount', () => {
    const t = 'Used Taurus, 3-4 ounces.';
    for (const amount of [3, 4]) {
      const out = validateFill(answer({ products: [{ productId: 'p-taurus', amount, unit: 'fl_oz', sameAsLast: false, method: '', heard: t.replace(/\.$/, '') }] }), ctx, t);
      expect(out.products[0].amount).toBeNull();
    }
  });
});

test('a sentence after an office label is never customer-facing without a Check', () => {
  const t = 'Treated the kitchen. Office: customer was rude. Please do not send another technician.';
  const out = validateFill(answer({ customerNote: 'Treated the kitchen. Please do not send another technician.' }), ctx, t);
  expect(out.customerNote).toBe('Treated the kitchen.');
  expect(out.unclear).toContainEqual({ heard: 'Please do not send another technician.', reason: 'note_audience_unclear' });
});

test('a number in the sentence before is not the next sentence\'s product amount', () => {
  const t = 'The customer had four ounces. Taurus was applied outside.';
  const out = validateFill(answer({ products: [{ productId: 'p-taurus', amount: 4, unit: 'fl_oz', sameAsLast: false, method: '', heard: 'Taurus was applied outside' }] }), ctx, t);
  expect(out.products[0].amount).toBeNull();
});

test('an office note the tech never said is a Check, not a note', () => {
  const out = validateFill(answer({ officeNote: 'Customer refused payment and requested cancellation.' }), ctx, 'Treated the garage.');
  expect(out.officeNote).toBe('');
  expect(out.unclear).toContainEqual({ heard: 'Customer refused payment and requested cancellation.', reason: 'note_not_heard' });
});

test('invented internal text offered as customer note is a Check, not an office note', () => {
  const out = validateFill(answer({ customerNote: 'Customer refused payment and requested cancellation.' }), ctx, 'Treated the garage.');
  expect(out.customerNote).toBe('');
  expect(out.officeNote).toBe('');
  expect(out.unclear).toContainEqual({ heard: 'Customer refused payment and requested cancellation.', reason: 'note_not_heard' });
});

test('"Taurus same as last time but a different rate" with heard "Taurus" is no flag', () => {
  const t = 'Taurus same as last time but a different rate.';
  const out = validateFill(answer({ products: [{ productId: 'p-taurus', amount: 0, unit: 'not_said', sameAsLast: true, method: '', heard: 'Taurus' }] }), ctx, t);
  expect(out.products[0].sameAsLast).toBe(false);
});

test('"two ounces of <a product not on the sheet>" is never the previous product\'s amount', () => {
  const t = 'Used Taurus, and two ounces of Demand CS.';
  const out = validateFill(answer({ products: [{ productId: 'p-taurus', amount: 2, unit: 'fl_oz', sameAsLast: false, method: '', heard: 'Used Taurus' }] }), ctx, t);
  expect(out.products[0].amount).toBeNull();
  const back = 'Used Taurus, two ounces of it.';
  const kept = validateFill(answer({ products: [{ productId: 'p-taurus', amount: 2, unit: 'fl_oz', sameAsLast: false, method: '', heard: 'Used Taurus' }] }), ctx, back);
  expect(kept.products[0].amount).toBe(2);
});

describe('Codex #5580 round 5', () => {
  const taurus = (over = {}) => ({ productId: 'p-taurus', amount: 0, unit: 'not_said', sameAsLast: false, method: '', heard: 'Taurus', ...over });

  test('"Last time, I used four ounces of Taurus" (comma) is another visit\'s', () => {
    const t = 'Last time, I used four ounces of Taurus. Today Talstar.';
    const out = validateFill(answer({ products: [taurus({ amount: 4, unit: 'fl_oz', heard: 'four ounces of Taurus' })] }), ctx, t);
    expect(out.products.some((p) => p.productId === 'p-taurus')).toBe(false);
  });

  test('"same as last time" is this visit, not another one', () => {
    const t = 'Same mix as last time, Taurus.';
    const out = validateFill(answer({ products: [taurus({ sameAsLast: true, heard: 'Same mix as last time, Taurus' })] }), ctx, t);
    expect(out.products[0]).toMatchObject({ productId: 'p-taurus', sameAsLast: true });
  });

  test('a visit the model left empty while the tech said its facts is a Check per value', () => {
    const out = validateFill(answer({ visit: visit() }), ctx, 'Treated ants outside, light activity.');
    expect(out.unclear).toEqual(expect.arrayContaining([
      { heard: 'Ants', reason: 'visit_said_not_filled' },
      { heard: 'Outside', reason: 'visit_said_not_filled' },
      { heard: 'light', reason: 'visit_said_not_filled' },
    ]));
  });

  test('a partly filled visit adds no omission Checks', () => {
    const out = validateFill(answer({ visit: visit({ pests: ['Ants'], heard: 'Treated ants outside' }) }), ctx, 'Treated ants outside, light activity.');
    expect(out.unclear.filter((u) => u.reason === 'visit_said_not_filled')).toEqual([]);
  });

  test('"Paid special attention to the kitchen" stays customer-facing', () => {
    const out = validateFill(answer({ customerNote: 'Paid special attention to the kitchen.' }), ctx, 'Paid special attention to the kitchen.');
    expect(out.customerNote).toBe('Paid special attention to the kitchen.');
    expect(out.officeNote).toBe('');
  });

  test('a pesticide safety claim never reaches the customer note, even said word for word', () => {
    const t = 'Treated the kitchen. Taurus is pet-safe for the family.';
    const out = validateFill(answer({ customerNote: t }), ctx, t);
    expect(out.customerNote).toBe('Treated the kitchen.');
    expect(out.unclear).toContainEqual({ heard: 'Taurus is pet-safe for the family.', reason: 'note_safety_claim' });
  });

  test('a model Check quoting words never said is dropped', () => {
    const out = validateFill(answer({ unclear: [{ heard: 'used an unknown chemical', reason: 'unclear_other' }, { heard: 'the blue stuff', reason: 'unknown_product' }] }), ctx, 'Treated outside with the blue stuff.');
    expect(out.unclear).not.toContainEqual({ heard: 'used an unknown chemical', reason: 'unclear_other' });
    expect(out.unclear).toContainEqual({ heard: 'the blue stuff', reason: 'unknown_product' });
  });

  test('a product\'s own catalog method is offered and kept when its word is said', () => {
    const withDrench = { ...ctx, products: [...ctx.products, { id: 'p-drench', name: 'Dominion 2L', fullName: 'Dominion 2L', aliases: [], measure: 'liquid', units: ['tsp', 'fl_oz', 'gal'], catalogMethod: 'soil_drench' }] };
    withDrench.productMethods = [...ctx.productMethods, 'soil_drench'];
    const row = { productId: 'p-drench', amount: 0, unit: 'not_said', sameAsLast: false, method: 'soil_drench', heard: 'drenched the soil with Dominion' };
    expect(validateFill(answer({ products: [row] }), withDrench, 'Drenched the soil with Dominion.').products[0].method).toBe('soil_drench');
    // never on a product whose catalog method it is not
    expect(validateFill(answer({ products: [taurus({ method: 'soil_drench', heard: 'drenched with Taurus' })] }), withDrench, 'Drenched with Taurus.').products[0].method).toBe('');
  });

  test('a method word inside a product name is not a method ("Talstar XTRA Granular")', () => {
    const withGran = { ...ctx, products: [...ctx.products, { id: 'p-xtra', name: 'Talstar XTRA Granular', fullName: 'Talstar XTRA Granular', aliases: [], measure: 'weight', units: ['g', 'oz', 'lb'] }] };
    const row = { productId: 'p-xtra', amount: 0, unit: 'not_said', sameAsLast: false, method: 'granular_broadcast', heard: 'Used Talstar XTRA Granular' };
    expect(validateFill(answer({ products: [row] }), withGran, 'Used Talstar XTRA Granular.').products[0].method).toBe('');
  });
});

test.each([
  'Mixed Taurus at four ounces per gallon and sprayed two gallons outside.',
  'Taurus, four ounces a gallon.',
])('a mixing rate is never the amount used: "%s"', (t) => {
  const out = validateFill(answer({ products: [{ productId: 'p-taurus', amount: 4, unit: 'fl_oz', sameAsLast: false, method: '', heard: t.replace(/\.$/, '') }] }), ctx, t);
  expect(out.products[0].amount).toBeNull();
  expect(out.unclear.map((u) => u.reason)).toContain('amount_not_spoken');
});

describe('Codex #5580 round 6', () => {
  test.each(['On the previous visit, I used four ounces of Taurus. Today Talstar.', 'Prior visit I used four ounces of Taurus. Today Talstar.'])('"%s" is another visit\'s Taurus', (t) => {
    const out = validateFill(answer({ products: [{ productId: 'p-taurus', amount: 4, unit: 'fl_oz', sameAsLast: false, method: '', heard: 'four ounces of Taurus' }] }), ctx, t);
    expect(out.products.some((p) => p.productId === 'p-taurus')).toBe(false);
  });

  test('a catalog method needs its action word, not its noun ("soil" is not "soil drench")', () => {
    const withDrench = { ...ctx, products: ctx.products.map((p) => (p.id === 'p-taurus' ? { ...p, catalogMethod: 'soil_drench' } : p)) };
    withDrench.productMethods = [...ctx.productMethods, 'soil_drench'];
    const row = (heard) => ({ productId: 'p-taurus', amount: 0, unit: 'not_said', sameAsLast: false, method: 'soil_drench', heard });
    expect(validateFill(answer({ products: [row('Applied Taurus to the soil')] }), withDrench, 'Applied Taurus to the soil.').products[0].method).toBe('');
    expect(validateFill(answer({ products: [row('Drenched the soil with Taurus')] }), withDrench, 'Drenched the soil with Taurus.').products[0].method).toBe('soil_drench');
  });

  test('a plain customer clause the model put in the office note goes back to the customer note', () => {
    const t = 'Treated the kitchen for roaches. Note for the office, gate code changed to 4412.';
    const out = validateFill(answer({ officeNote: 'Treated the kitchen for roaches. Gate code changed to 4412.' }), ctx, t);
    expect(out.customerNote).toBe('Treated the kitchen for roaches.');
    expect(out.officeNote).toBe('Gate code changed to 4412.');
  });
});

describe('Codex #5580 round 7', () => {
  const row = (productId, amount, heard) => ({ productId, amount, unit: 'fl_oz', sameAsLast: false, method: '', heard });

  test('"Last time ... but today I used Talstar": today ends the other-visit scope', () => {
    const t = 'Last time, I used four ounces of Taurus, but today I used five ounces of Talstar.';
    const out = validateFill(answer({ products: [row('p-talak', 5, 'five ounces of Talstar')] }), ctx, t);
    expect(out.products[0]).toMatchObject({ productId: 'p-talak', amount: 5 });
    const old = validateFill(answer({ products: [row('p-taurus', 4, 'four ounces of Taurus')] }), ctx, t);
    expect(old.products.some((p) => p.productId === 'p-taurus')).toBe(false);
  });

  test.each(['Mixed Taurus at four ounces for every gallon.', 'Taurus, four ounces to the gallon.', 'Taurus four ounces for each gallon.'])('a rate form is never the amount: "%s"', (t) => {
    expect(validateFill(answer({ products: [row('p-taurus', 4, t.replace(/\.$/, ''))] }), ctx, t).products[0].amount).toBeNull();
  });

  test('"four ounces, no, five ounces": the five is the amount, the four is not', () => {
    const t = 'Taurus, four ounces, no, five ounces.';
    expect(validateFill(answer({ products: [row('p-taurus', 5, t.replace(/\.$/, ''))] }), ctx, t).products[0].amount).toBe(5);
    expect(validateFill(answer({ products: [row('p-taurus', 4, t.replace(/\.$/, ''))] }), ctx, t).products[0].amount).toBeNull();
  });

  test('"Taurus four ounces, no surfactant" keeps the four', () => {
    const t = 'Taurus four ounces, no surfactant.';
    expect(validateFill(answer({ products: [row('p-taurus', 4, 'Taurus four ounces')] }), ctx, t).products[0].amount).toBe(4);
  });
});

test('"four ounces per gallon and sprayed two gallons": neither number is the Taurus amount', () => {
  const t = 'Mixed Taurus at four ounces per gallon and sprayed two gallons outside.';
  const run = (amount, unit) => validateFill(answer({ products: [{ productId: 'p-taurus', amount, unit, sameAsLast: false, method: '', heard: t.replace(/\.$/, '') }] }), ctx, t).products[0].amount;
  expect(run(2, 'gal')).toBeNull();
  expect(run(4, 'fl_oz')).toBeNull();
});

describe('Codex #5580 round 8', () => {
  const row = (productId, amount, unit, heard) => ({ productId, amount, unit, sameAsLast: false, method: '', heard });

  test('"four ounces every gallon" is a rate', () => {
    const t = 'Mixed Taurus at four ounces every gallon.';
    expect(validateFill(answer({ products: [row('p-taurus', 4, 'fl_oz', t.replace(/\.$/, ''))] }), ctx, t).products[0].amount).toBeNull();
  });

  test('"one and three quarters ounces" is 1.75', () => {
    const t = 'Used one and three quarters ounces of Taurus.';
    const run = (amount) => validateFill(answer({ products: [row('p-taurus', amount, 'fl_oz', t.replace(/\.$/, ''))] }), ctx, t).products[0].amount;
    expect(run(1.75)).toBe(1.75);
    expect(run(1)).toBeNull();
  });

  test('an office line said but carried by neither note is a Check', () => {
    const t = 'Treated outside. Office: gate code 1234.';
    const out = validateFill(answer({}), ctx, t);
    expect(out.unclear).toContainEqual({ heard: 'Office: gate code 1234.', reason: 'office_said_not_filled' });
    const kept = validateFill(answer({ officeNote: 'gate code 1234.' }), ctx, t);
    expect(kept.unclear.filter((u) => u.reason === 'office_said_not_filled')).toEqual([]);
  });

  test('a refused row claiming a product id does not hide that product\'s omission Check', () => {
    const t = 'Used four ounces of Taurus.';
    const out = validateFill(answer({ products: [row('p-taurus', 4, 'fl_oz', 'Talstar')] }), ctx, t);
    expect(out.products).toEqual([]);
    expect(out.unclear.map((u) => u.reason)).toContain('product_said_not_filled');
  });
});

test.each([['one thousand two hundred', 1200], ['two thousand', 2000], ['a thousand and fifty', 1050]])('"%s linear feet" is %p, never its tail', (words, feet) => {
  const t = `Sprayed ${words} linear feet outside.`;
  const run = (linearFt) => validateFill(answer({ visit: visit({ areas: ['Outside'], linearFt, heard: t.replace(/\.$/, '') }) }), ctx, t).visit.linearFt;
  expect(run(feet)).toBe(feet);
  if (feet % 1000) expect(run(feet % 1000)).toBeNull();
});

describe('Codex #5580 round 9', () => {
  test('the retired company name never reaches the customer note', () => {
    const t = 'Waves Lawn & Pest treated the exterior. Treated the garage.';
    const out = validateFill(answer({ customerNote: t }), ctx, t);
    expect(out.customerNote).toBe('Treated the garage.');
    expect(out.unclear).toContainEqual({ heard: 'Waves Lawn & Pest treated the exterior.', reason: 'note_company_name' });
  });

  test.each(['Customer did not pay the invoice.', 'The gate was locked.'])('a plain internal line "%s" carried by neither note is a Check', (line) => {
    const out = validateFill(answer({}), ctx, `Treated outside. ${line}`);
    expect(out.unclear).toContainEqual({ heard: line, reason: 'office_said_not_filled' });
  });

  test('a package size inside a product name is never the dose ("Dismiss 64 oz")', () => {
    const withDismiss = { ...ctx, products: [...ctx.products, { id: 'p-dismiss', name: 'Dismiss 64 oz', fullName: 'Dismiss 64 oz', aliases: [], measure: 'liquid', units: ['tsp', 'fl_oz', 'gal'] }] };
    const row = (amount) => ({ productId: 'p-dismiss', amount, unit: 'fl_oz', sameAsLast: false, method: '', heard: 'Used Dismiss 64 oz outside' });
    expect(validateFill(answer({ products: [row(64)] }), withDismiss, 'Used Dismiss 64 oz outside.').products[0].amount).toBeNull();
    expect(validateFill(answer({ products: [{ ...row(2), heard: 'two ounces of Dismiss 64 oz' }] }), withDismiss, 'Used two ounces of Dismiss 64 oz outside.').products[0].amount).toBe(2);
  });
});
