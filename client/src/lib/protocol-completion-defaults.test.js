import { describe, expect, it } from 'vitest';
import { cardRateRow, labelUseItemFor, protocolCompletionDefaultSelections, withLabelUseRates } from './protocol-completion-defaults';
import { resolveRatePrefill } from './product-rate-prefill';

// The home cockroach card mixes Tekko Pro at its label's cockroach rate, 2 fl oz per gallon, while the catalog row keeps the
// label's flea rate, 1 (server/utils/protocol-label-rate.js). The server marks the card's rate with labelUseRate; the seeded row
// must prefill and review at 2, never at the catalog's 1.
const tekkoRow = { id: 't', name: 'Tekko Pro IGR', category: 'IGR', default_rate: '1', default_unit: 'fl_oz/gal' };
const response = (item) => ({ programKey: 'cockroach', source: 'protocol_visit', products: [{ id: 't', name: 'Tekko Pro IGR', ...item }] });
const build = (product, { applicationMethodOverride } = {}) => {
  const prefill = resolveRatePrefill(product, { applicationMethod: applicationMethodOverride, serviceLine: 'pest' });
  return { productId: product.id, rate: prefill.rate, labelMaxRate: prefill.labelMaxRate, applicationMethod: applicationMethodOverride };
};

describe('protocol completion defaults: a card line with its own label rate', () => {
  it('prefills and reviews at the card rate when the server marks it', () => {
    const [row] = protocolCompletionDefaultSelections(
      response({ defaultRate: '2', defaultUnit: 'fl_oz/gal', labelUseRate: true, completionApplicationMethod: 'spot_treatment' }),
      [tekkoRow],
      build,
    );
    expect(row).toMatchObject({ productId: 't', rate: 2, labelMaxRate: 2, applicationMethod: 'spot_treatment' });
  });

  it('keeps the catalog rate when the server does not mark a card rate', () => {
    const [row] = protocolCompletionDefaultSelections(
      response({ defaultRate: '1', defaultUnit: 'fl_oz/gal', completionApplicationMethod: 'spot_treatment' }),
      [tekkoRow],
      build,
    );
    expect(row).toMatchObject({ rate: 1, labelMaxRate: 1 });
  });

  it('a product another booked card shares (blank card rate) starts with no rate and no single ceiling', () => {
    const [row] = protocolCompletionDefaultSelections(
      response({ defaultRate: '', defaultUnit: 'fl_oz/gal', labelUseRate: true, completionApplicationMethod: 'spot_treatment' }),
      [tekkoRow],
      build,
    );
    expect(row).toMatchObject({ rate: '', labelMaxRate: null });
  });

  // The flea card's Tekko Pro rate is held when the row's registration or catalog rate does not match the card (server
  // labelRateHeld): the rate starts blank whatever the catalog keeps, a per-1,000 rate included.
  it('a held rate starts blank on a row that keeps a per-1,000 catalog rate or an unreadable band', () => {
    for (const catalogRow of [
      { ...tekkoRow, default_rate: '1/2' },
      { ...tekkoRow, default_unit: 'fl_oz/1000sf', default_rate_per_1000: '0.67' },
      { ...tekkoRow, defaultRatePer1000: 0.67 },
    ]) {
      const [row] = protocolCompletionDefaultSelections(
        { programKey: 'flea', source: 'protocol_visit', products: [{ id: 't', name: 'Tekko Pro IGR', defaultRate: '', labelUseRate: true, completionApplicationMethod: 'spot_treatment' }] },
        [catalogRow],
        build,
      );
      expect(row).toMatchObject({ rate: '', labelMaxRate: null });
    }
  });
});

describe('withLabelUseRates', () => {
  const response = { source: 'protocol_visit', programKey: 'cockroach', products: [{ id: 't', labelUseRate: true, defaultRate: '2' }, { id: 'a' }] };
  const catalog = [{ id: 't', name: 'Tekko Pro IGR', default_rate: '1' }, { id: 'a', name: 'Alpine WSG', default_rate: '10' }, { id: 'x', default_rate: '3' }];

  it('sets only the card-rate product to its card rate, so Fast Complete reviews 2 fl oz per gallon against 2', () => {
    const out = withLabelUseRates(catalog, response);
    expect(out.map((p) => p.default_rate)).toEqual(['2', '10', '3']);
  });

  it('a failed or unseeded read keeps the catalog rates', () => {
    expect(withLabelUseRates(catalog, null)).toEqual(catalog);
    expect(withLabelUseRates(catalog, { ...response, programKey: 'pest' })).toEqual(catalog);
  });
});

describe('labelUseItemFor', () => {
  const response = { source: 'protocol_visit', programKey: 'cockroach', products: [{ id: 't', labelUseRate: true, defaultRate: '2', completionApplicationMethod: 'spot_treatment' }, { id: 'a' }] };

  it('finds the card-rate line by id, so a product the tech removes and adds again keeps its card rate and method', () => {
    expect(labelUseItemFor(response, 't')).toMatchObject({ defaultRate: '2', completionApplicationMethod: 'spot_treatment' });
    expect(labelUseItemFor(response, 'a')).toBeNull();
    expect(labelUseItemFor(null, 't')).toBeNull();
  });
});

describe('cardRateRow', () => {
  const antapex = { id: 'a', name: 'Atticus Antapex WSG', default_rate: '10-30', default_unit: 'g/gal' };
  const response = { source: 'protocol_visit', programKey: 'bed_bug', products: [{ id: 'x' }, { id: 'a', cardStartRate: 20, completionApplicationMethod: 'spot_treatment' }] };

  it('carries the card\'s own tank rate as the start of the rate, and leaves the catalog band (the review ceiling) alone', () => {
    expect(cardRateRow(response, antapex)).toEqual({ product: antapex, applicationMethodOverride: undefined, startRate: 20 });
    // A product with no card rate, and a product the visit's card does not list.
    expect(cardRateRow(response, { id: 'x' }).startRate).toBeUndefined();
    expect(cardRateRow(response, { id: 'other' }).startRate).toBeUndefined();
  });

  it('gives no start rate from a response this hook would not seed, or from a value that is not a rate', () => {
    expect(cardRateRow(null, antapex).startRate).toBeUndefined();
    expect(cardRateRow({ ...response, source: 'none' }, antapex).startRate).toBeUndefined();
    expect(cardRateRow({ ...response, programKey: 'pest' }, antapex).startRate).toBeUndefined();
    for (const cardStartRate of [0, -5, 'x', null, Infinity]) {
      expect(cardRateRow({ ...response, products: [{ id: 'a', cardStartRate }] }, antapex).startRate).toBeUndefined();
    }
  });
});
