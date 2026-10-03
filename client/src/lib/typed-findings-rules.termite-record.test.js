// The termite treatment record's state fields the visit itself gives (Fast
// Complete step 5, lib termiteRecordFromVisit): the products, their EPA
// numbers from the catalog, the finished solution mixed (one shared tank,
// plus a product mixed on its own) or the amount used, and the traced feet.
import { describe, expect, it } from 'vitest';
import { termiteRecordFromVisit } from './typed-findings-rules';

const CATALOG = [
  { id: 'termidor', epa_reg_number: '7969-210' },
  { id: 'bifen', epa_reg_number: '279-3206' },
  { id: 'foam', epa_reg_number: '' },
];
const tankRow = (overrides) => ({ productId: 'termidor', name: 'Termidor SC', rateUnit: 'fl_oz/gal', carrierGallons: '80', tankOwner: true, totalAmount: '64', amountUnit: 'fl_oz', ...overrides });

describe('termiteRecordFromVisit', () => {
  it('one product mixed by the gallon: its name, EPA number, the gallons and the traced feet', () => {
    expect(termiteRecordFromVisit({ products: [tankRow()], catalog: CATALOG, tracedFeet: 181.6 })).toEqual({
      products_used: { value: 'Termidor SC', source: 'From the products' },
      epa_registration: { value: '7969-210', source: 'From the product' },
      gallons_or_amount: { value: '80 gal', source: 'From the products' },
      linear_feet_or_stations: { value: '182 ft', source: 'From the trace' },
    });
  });

  it('two products: both named, each EPA number with its product, one shared tank counted once', () => {
    const record = termiteRecordFromVisit({
      products: [tankRow(), tankRow({ productId: 'bifen', name: 'Bifen IT', tankOwner: false })],
      catalog: CATALOG,
    });
    expect(record.products_used.value).toBe('Termidor SC, Bifen IT');
    expect(record.epa_registration).toEqual({ value: '7969-210 (Termidor SC); 279-3206 (Bifen IT)', source: 'From the products' });
    expect(record.gallons_or_amount.value).toBe('80 gal');
    expect(record).not.toHaveProperty('linear_feet_or_stations');
  });

  it('a product mixed on its own is its own tank, named; a product not mixed by the gallon gives its amount', () => {
    const record = termiteRecordFromVisit({
      products: [
        tankRow(),
        tankRow({ productId: 'bifen', name: 'Bifen IT', tankOwner: false, carrierGallonsManual: true, carrierGallons: '20' }),
        { productId: 'foam', name: 'Foam agent', rateUnit: 'fl_oz', totalAmount: '6', amountUnit: 'fl_oz' },
      ],
      catalog: CATALOG,
    });
    expect(record.gallons_or_amount.value).toBe('80 gal (Termidor SC); 20 gal (Bifen IT); 6 fl oz Foam agent');
    // A product with no EPA number in the catalog adds none.
    expect(record.epa_registration.value).toBe('7969-210 (Termidor SC); 279-3206 (Bifen IT)');
  });

  it('a per-gallon product with no gallons entered gives the amount used', () => {
    const record = termiteRecordFromVisit({ products: [tankRow({ carrierGallons: '', tankOwner: false })], catalog: CATALOG });
    expect(record.gallons_or_amount.value).toBe('64 fl oz Termidor SC');
  });

  it('nothing on the visit fills nothing', () => {
    expect(termiteRecordFromVisit({ products: [], catalog: CATALOG, tracedFeet: null })).toEqual({});
    expect(termiteRecordFromVisit({})).toEqual({});
  });
});
