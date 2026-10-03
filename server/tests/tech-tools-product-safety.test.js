// get_product_info must surface label/SDS-derived safety (PPE, REI, watering-in,
// signal word) so the tech IB grounds those statements in catalog data instead
// of training memory — and must omit absent fields so a blank never reads as
// "none required".

// mockRow is the single catalog match most tests need; mockRows, when set,
// is the whole ILIKE result.
let mockRow = null;
let mockRows = null;
const VERIFIED = '2026-07-01T00:00:00Z';
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => {
  const fn = jest.fn(() => ({
    whereILike: () => ({
      orderBy: () => Promise.resolve(mockRows || (mockRow ? [mockRow] : [])),
    }),
  }));
  return fn;
});

beforeEach(() => { mockRows = null; });

const { executeTechTool } = require('../services/intelligence-bar/tech-tools');

async function productInfo() {
  return executeTechTool('get_product_info', { product_name: 'x' }, {});
}

describe('get_product_info safety block', () => {
  test('surfaces label safety fields, mapping irrigation_required to watering-in copy', async () => {
    mockRow = {
      name: 'Acelepryn Xtra',
      category: 'Insecticide',
      active_ingredient: 'Chlorantraniliprole',
      signal_word: 'Caution',
      ppe_text: 'Long-sleeved shirt, long pants, chemical-resistant gloves, shoes plus socks.',
      reentry_text: 'Do not enter until sprays have dried.',
      rei_hours: 4,
      rainfast_minutes: 120,
      irrigation_required: true,
      epa_reg_number: '100-1680',
      label_url: 'https://example.com/label.pdf',
      sds_url: 'https://example.com/sds.pdf',
    };

    const result = await productInfo();
    expect(result.safety).toMatchObject({
      signal_word: 'Caution',
      ppe: 'Long-sleeved shirt, long pants, chemical-resistant gloves, shoes plus socks.',
      reentry: 'Do not enter until sprays have dried.',
      rei_hours: 4,
      rainfast_minutes: 120,
      watering_in: 'Water in after application',
      epa_reg_number: '100-1680',
      label_url: 'https://example.com/label.pdf',
      sds_url: 'https://example.com/sds.pdf',
    });
  });

  test('rei_hours 0 is omitted (until-dry), never surfaced as a bare 0', async () => {
    // 0 is the residential "until sprays have dried" value; exposing the number
    // would read as immediate re-entry. The meaning is carried by `reentry`.
    mockRow = {
      name: 'LESCO Three-Way Selective Herbicide',
      rei_hours: 0,
      reentry_text: 'Keep people and pets off treated areas until dry.',
    };
    const result = await productInfo();
    expect(result.safety.rei_hours).toBeUndefined();
    expect(result.safety.reentry).toMatch(/until dry/i);
  });

  test('irrigation_required false reports "not required", never a prohibition', async () => {
    // K-Flow / Green Flo liquid fertilizers are seeded false but should still be
    // watered in — false means "not required", not "do not water".
    mockRow = { name: 'LESCO K-Flow 0-0-25', irrigation_required: false };
    const result = await productInfo();
    expect(result.safety.watering_in).toBe('Watering-in not required per the label');
    expect(result.safety.watering_in).not.toMatch(/do not water/i);
  });

  test('irrigation_notes carry real label nuance when present', async () => {
    mockRow = {
      name: 'Celsius WG',
      irrigation_required: false,
      irrigation_notes: 'Do not irrigate for 24 hours — keep on the leaf.',
    };
    const result = await productInfo();
    expect(result.safety.watering_in).toBe('Do not irrigate for 24 hours — keep on the leaf.');
  });

  test('absent safety fields are omitted, not emitted as blanks', async () => {
    mockRow = { name: 'Bare Product', category: 'fertilizer' };
    const result = await productInfo();
    // JSON round-trip drops undefined keys, so the model never sees a blank field.
    const safety = JSON.parse(JSON.stringify(result.safety));
    expect(safety).toEqual({});
    expect('watering_in' in safety).toBe(false);
    expect('ppe' in safety).toBe(false);
  });

  test('unknown product returns an error, no safety block', async () => {
    mockRow = null;
    const result = await productInfo();
    expect(result.error).toMatch(/not found/);
    expect(result.safety).toBeUndefined();
  });
});

// The label rate itself: nothing a tech reads is in mL (owner ruling). For a
// technician's request (a tech context with techId) a rate the catalog keeps
// in mL is left out, so the tech is sent to the label; any other rate, and
// every rate for an admin workflow such as Agent Estimate (an empty context),
// reads as stored.
describe('get_product_info label rate', () => {
  const asTech = () => executeTechTool('get_product_info', { product_name: 'x' }, { techId: 'tech-1', techName: null });

  test('for a technician, an mL label rate is left out, and nothing in the answer reads mL', async () => {
    mockRow = { name: 'Sample SC', default_rate: '5-10', default_unit: 'ml/gal' };
    const result = await asTech();
    expect(result.default_rate).toBeNull();
    expect(result.default_unit).toBeNull();
    expect(JSON.stringify(result)).not.toMatch(/\bml\b/i);
  });

  test('for a technician, any other label rate reads exactly as the catalog states it', async () => {
    mockRow = { name: 'Sample CS', default_rate: '0.2-0.8', default_unit: 'fl_oz/gal', label_verified_at: VERIFIED };
    const result = await asTech();
    expect(result.default_rate).toBe('0.2-0.8');
    expect(result.default_unit).toBe('fl_oz/gal');
  });

  test('an admin workflow keeps the exact catalog label rate, mL included', async () => {
    mockRow = { name: 'Sample SC', default_rate: '5-10', default_unit: 'ml/gal' };
    const result = await productInfo();
    expect(result.default_rate).toBe('5-10');
    expect(result.default_unit).toBe('ml/gal');
  });
});

// A shared name fragment must never resolve to whichever row came first:
// an exact name wins, one active match is used, several come back as
// candidates to ask about, and retired rows are never answered from.
describe('get_product_info product match', () => {
  const ask = (name) => executeTechTool('get_product_info', { product_name: name }, { techId: 'tech-1', techName: null });

  test('several active matches come back as candidates with no product data', async () => {
    mockRows = [
      { name: 'Advion Ant Bait Gel', active: true, default_rate: '0.1-1', default_unit: 'g/spot' },
      { name: 'Advion Cockroach Gel', active: false },
      { name: 'Advion WDG Granular', active: true },
    ];
    const result = await ask('Advion');
    expect(result.ambiguous).toBe(true);
    expect(result.candidates).toEqual(['Advion Ant Bait Gel', 'Advion WDG Granular']);
    expect(result.default_rate).toBeUndefined();
  });

  test('an exact name wins over other active matches', async () => {
    mockRows = [
      { name: 'Alpine WSG', active: true, default_rate: '10-30', default_unit: 'g/gal', label_verified_at: VERIFIED },
      { name: 'Alpine WSG Insecticide Kit', active: true },
    ];
    const result = await ask('alpine wsg');
    expect(result.name).toBe('Alpine WSG');
    expect(result.default_rate).toBe('10-30');
  });

  test('one active match is used even when retired rows also match', async () => {
    mockRows = [
      { name: 'Advion Cockroach Gel Bait', active: false, default_rate: '0.5', default_unit: 'g/spot' },
      { name: 'Advion Evolution Cockroach Gel Bait', active: true, default_rate: '0.5', default_unit: 'g/spot' },
    ];
    const result = await ask('Cockroach Gel');
    expect(result.name).toBe('Advion Evolution Cockroach Gel Bait');
  });

  test('only retired matches: no product data, sent to the label', async () => {
    mockRows = [{ name: 'Talstar P', active: false, default_rate: '1', default_unit: 'fl_oz/gal' }];
    const result = await ask('Talstar P');
    expect(result.error).toMatch(/not in the active product catalog/);
    expect(result.retired_matches).toEqual(['Talstar P']);
    expect(result.default_rate).toBeUndefined();
  });

  test('no match at all is a plain not-found', async () => {
    mockRows = [];
    expect(await ask('Nothing')).toEqual({ error: 'Product "Nothing" not found' });
  });

  test('a product with no rate carries a rate note; one with a rate does not', async () => {
    mockRows = [{ name: 'Atticus Talak 7.9 F', active: true, default_rate: null }];
    expect((await ask('Talak')).rate_note).toBe('No rate on file. Check the current label before mixing.');
    mockRows = [{ name: 'Sample CS', active: true, default_rate: '0.2-0.8', default_unit: 'fl_oz/gal', label_verified_at: VERIFIED }];
    expect((await ask('Sample CS')).rate_note).toBeUndefined();
  });

  test('a per-1,000 label rate counts as a rate on file and is returned with its basis', async () => {
    mockRows = [{
      name: 'Acelepryn Xtra', active: true, default_rate: null, label_verified_at: VERIFIED,
      default_rate_per_1000: '0.46', min_label_rate_per_1000: '0.23', max_label_rate_per_1000: '0.92', rate_unit: 'fl_oz',
    }];
    const result = await ask('Acelepryn Xtra');
    expect(result.rate_note).toBeUndefined();
    expect(result.label_rate_per_1000).toEqual({ unit: 'fl_oz per 1,000 sq ft', default: '0.46', min: '0.23', max: '0.92' });
  });

  test('for a technician, an mL per-1,000 rate is withheld and the rate note stands', async () => {
    mockRows = [{ name: 'Sample Liquid', active: true, default_rate: null, default_rate_per_1000: '30', rate_unit: 'ml', label_verified_at: VERIFIED }];
    const result = await ask('Sample Liquid');
    expect(result.label_rate_per_1000).toBeUndefined();
    expect(result.rate_note).toBe('No rate on file. Check the current label before mixing.');
    expect(JSON.stringify(result)).not.toMatch(/\bml\b/i);
  });

  test('an unverified label withholds every rate from a technician and sends them to the label', async () => {
    mockRows = [{
      name: 'Velista', active: true, default_rate: '0.5', default_unit: 'oz',
      default_rate_per_1000: '0.5', rate_unit: 'oz', label_verified_at: null,
    }];
    const result = await ask('Velista');
    expect(result.default_rate).toBeNull();
    expect(result.label_rate_per_1000).toBeUndefined();
    expect(result.rate_note).toBe('No rate on file. Check the current label before mixing.');
  });

  test('an admin workflow keeps an unverified catalog rate as stored but gets no per-1,000 label rate', async () => {
    mockRows = [{
      name: 'Velista', active: true, default_rate: '0.5', default_unit: 'oz',
      default_rate_per_1000: '0.5', rate_unit: 'oz', label_verified_at: null,
    }];
    const result = await executeTechTool('get_product_info', { product_name: 'Velista' }, {});
    expect(result.default_rate).toBe('0.5');
    expect(result.label_rate_per_1000).toBeUndefined();
  });

  test('ambiguity is decided across every match, not the first page of rows', async () => {
    // 24 retired rows sort first, then two active ones: a row cap would have
    // hidden the second active match and answered for the first.
    mockRows = [
      ...Array.from({ length: 24 }, (_, i) => ({ name: `Bifen Old ${String(i).padStart(2, '0')}`, active: false })),
      { name: 'Bifen XTS', active: true, default_rate: '1', default_unit: 'fl_oz/gal', label_verified_at: VERIFIED },
      { name: 'Bifen Zeta', active: true },
    ];
    const result = await ask('Bifen');
    expect(result.ambiguous).toBe(true);
    expect(result.candidates).toEqual(['Bifen XTS', 'Bifen Zeta']);
    expect(result.default_rate).toBeUndefined();
  });

  test('an exact name deep in the matches still wins, and a long candidate list says how many more', async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ name: `Sample Mix ${String(i).padStart(2, '0')}`, active: true }));
    mockRows = [...many, { name: 'Sample Mix Z', active: true, default_rate: '2', default_unit: 'fl_oz/gal', label_verified_at: VERIFIED }];
    expect((await ask('sample mix z')).name).toBe('Sample Mix Z');
    const result = await ask('Sample Mix');
    expect(result.candidates).toHaveLength(8);
    expect(result.more_matches).toBe(23);
  });
});
