// "What we applied today" names BOTH halves of a combination pre-emergent +
// fertilizer product. The catalog active string is "prodiamine 0.43% + 15-0-15";
// the old label-percentage strip cut everything after the first "%", so the
// report said only "Today we applied prodiamine (granular application)."

const { buildTreatmentSummary } = require('../services/service-report/treatment-summary');

const summary = (products) => buildTreatmentSummary({ products });

describe('buildTreatmentSummary: combination pre-emergent + fertilizer', () => {
  it('names the fertilizer half of Stonewall 15-0-15', () => {
    const out = summary([{
      name: 'LESCO Stonewall 0.43% 15-0-15 Pre-Emergent Plus Fertilizer',
      activeIngredient: 'prodiamine 0.43% + 15-0-15',
      kind: 'pre_emergent',
      method: 'granular_broadcast',
      targets: [],
    }]);
    expect(out).toBe('Today we applied prodiamine with 15-0-15 fertilizer (granular application).');
  });

  it('names the fertilizer half of Dimension 0.21% 18-0-10', () => {
    const out = summary([{
      name: 'LESCO Dimension 0.21% 18-0-10 50% PolyPlus OPTI45 MOP Pre-Emergent Plus Fertilizer',
      activeIngredient: 'Dithiopyr 0.21% + 18-0-10',
      kind: 'pre_emergent',
      method: 'granular_broadcast',
      targets: [],
    }]);
    expect(out).toBe('Today we applied dithiopyr with 18-0-10 fertilizer (granular application).');
  });

  it('keeps the fertilizer half when the analysis comes first', () => {
    const out = summary([{ name: 'Combo', activeIngredient: '15-0-15 + prodiamine 0.43%', kind: 'pre_emergent', method: 'granular_broadcast' }]);
    expect(out).toBe('Today we applied prodiamine with 15-0-15 fertilizer (granular application).');
  });

  it('reads cleanly beside a second product and a shared method', () => {
    const out = summary([
      { name: 'Stonewall', activeIngredient: 'prodiamine 0.43% + 15-0-15', method: 'granular_broadcast' },
      { name: 'Celsius', activeIngredient: 'thiencarbazone-methyl 10%', method: 'granular_broadcast' },
    ]);
    expect(out).toBe('Today we applied prodiamine with 15-0-15 fertilizer and thiencarbazone-methyl (all applied as a granular application).');
  });

  it('does not change single-active, pure-fertilizer or non-combination strings', () => {
    expect(summary([{ name: 'Dinotefuran 20% SG', activeIngredient: 'Dinotefuran 20%', method: 'foliar_spray' }]))
      .toBe('Today we applied dinotefuran (foliar spray).');
    expect(summary([{ name: 'LESCO 24-0-11', activeIngredient: '24-0-11', method: 'granular_broadcast' }]))
      .toBe('Today we applied 24-0-11 (granular application).');
    expect(summary([{ name: 'Nitrogen blend', activeIngredient: 'Nitrogen 20-0-0 + micros', method: 'granular_broadcast' }]))
      .toBe('Today we applied nitrogen 20-0-0 + micros (granular application).');
    expect(summary([{ name: 'Potassium', activeIngredient: 'Potassium 0-0-25 + sulfur', method: 'granular_broadcast' }]))
      .toBe('Today we applied potassium 0-0-25 + sulfur (granular application).');
    expect(summary([{ name: 'No active', activeIngredient: null, method: null }]))
      .toBe('Today we applied No active.');
  });
});

describe('buildTreatmentSummary: combination product from the v13 catalog migration', () => {
  // The migration creates these rows with the active alone; the analysis lives
  // in the product name (and analysis_n/p/k, which this builder is not given).
  it('names the fertilizer half of Stonewall from the product name', () => {
    expect(summary([{
      name: 'LESCO Stonewall 0.43% 15-0-15 50% PolyPlus OPTI45 Pre-Emergent Plus Fertilizer',
      activeIngredient: 'Prodiamine',
      kind: 'pre_emergent',
      method: 'granular_broadcast',
    }])).toBe('Today we applied prodiamine with 15-0-15 fertilizer (granular application).');
  });

  it('names the fertilizer half of Dimension from the product name', () => {
    expect(summary([{
      name: 'LESCO Dimension 0.21% 18-0-10 50% PolyPlus OPTI45 MOP Pre-Emergent Plus Fertilizer',
      activeIngredient: 'Dithiopyr',
      kind: 'pre_emergent',
      method: 'granular_broadcast',
    }])).toBe('Today we applied dithiopyr with 18-0-10 fertilizer (granular application).');
  });

  it('leaves straight pre-emergents and non-pre-emergents unchanged', () => {
    expect(summary([{ name: 'LESCO Stonewall 4FL Prodiamine 40.7% Pre-Emergent Liquid Herbicide', activeIngredient: 'Prodiamine', kind: 'pre_emergent', method: 'broadcast_spray' }]))
      .toBe('Today we applied prodiamine (broadcast application).');
    expect(summary([{ name: 'Dimension 2EW Dithiopyr 24% Pre-Emergent Liquid Herbicide', activeIngredient: 'Dithiopyr', kind: 'pre_emergent', method: 'broadcast_spray' }]))
      .toBe('Today we applied dithiopyr (broadcast application).');
    // An analysis in the name of a non-pre-emergent never adds a fertilizer half.
    expect(summary([{ name: 'Iron 6-0-0 Micro', activeIngredient: 'Iron', kind: 'supplement', method: 'foliar_spray' }]))
      .toBe('Today we applied iron (foliar spray).');
  });

  it('does not double the analysis when the active already carries it', () => {
    expect(summary([{ name: 'LESCO Stonewall 0.43% 15-0-15', activeIngredient: 'prodiamine 0.43% + 15-0-15', kind: 'pre_emergent', method: 'granular_broadcast' }]))
      .toBe('Today we applied prodiamine with 15-0-15 fertilizer (granular application).');
  });
});

