// get_product_info must surface label/SDS-derived safety (PPE, REI, watering-in,
// signal word) so the tech IB grounds those statements in catalog data instead
// of training memory — and must omit absent fields so a blank never reads as
// "none required".

let mockRow = null;
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => {
  const fn = jest.fn(() => ({
    whereILike: () => ({ first: () => Promise.resolve(mockRow) }),
  }));
  return fn;
});

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
    mockRow = { name: 'Sample CS', default_rate: '0.2-0.8', default_unit: 'fl_oz/gal' };
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
