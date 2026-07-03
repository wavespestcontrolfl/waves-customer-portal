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

  test('irrigation_required false gives the hold-off copy', async () => {
    mockRow = { name: 'Celsius WG', irrigation_required: false };
    const result = await productInfo();
    expect(result.safety.watering_in).toBe('Do not water in — let it dry on the leaf');
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
