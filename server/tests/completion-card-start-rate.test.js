// A card line may declare its tank's own rate inside the catalog band (tankRatePerGallon). The completion form starts a
// per-gallon rate at the bottom of the band, so the bed bug card's Antapex (20 g per gallon, band 10-30) started at 10.
// The card's rate now goes along as the start of the rate (cardStartRate); the band's top stays the review ceiling.
const protocols = require('../config/protocols.json');
const { cardStartRateFields } = require('../utils/protocol-label-rate');
const { resolveCompletionProductDefaults } = require('../services/completion-product-defaults');

const ANTAPEX = { id: 'a', name: 'Atticus Antapex WSG', epa_reg_number: '91234-401', active: true, default_rate: '10-30', default_unit: 'g/gal' };
const CROSSFIRE = { id: 'x', name: 'MGK Crossfire Bed Bug Concentrate', epa_reg_number: '1021-2776', active: true, default_rate: null, default_unit: 'fl_oz' };
const TEKKO = { id: 't', name: 'Tekko Pro IGR', epa_reg_number: '53883-335', active: true, default_rate: '1', default_unit: 'fl_oz/gal' };

function fakeDb(tables) {
  const dbFn = (name) => {
    const rows = tables[String(name).split(' as ')[0]] || [];
    const q = {
      where: () => q, orWhereNull: () => q, whereIn: () => q, whereNotNull: () => q, leftJoin: () => q, andWhere: () => q,
      select: () => q, first: () => Promise.resolve(rows[0]), catch: () => q,
      then: (resolve, reject) => Promise.resolve(rows).then(resolve, reject),
    };
    return q;
  };
  dbFn.raw = (sql) => sql;
  return dbFn;
}
const defaults = (serviceType, serviceKey, { catalog = [ANTAPEX, CROSSFIRE, TEKKO], addons = [], followup = false } = {}) => resolveCompletionProductDefaults({
  db: fakeDb({
    products_catalog: catalog, product_aliases: [], scheduled_service_addons: addons,
    scheduled_services: [{ id: 's', service_id: null, service_type: serviceType, service_key_snapshot: serviceKey, scheduled_date: '2026-12-01', ...(followup ? { followup_source_service_id: 'src' } : {}) }],
  }),
  serviceId: 's', protocols,
});
const byId = (result, id) => result.products.find((product) => product.id === id) || null;
const rateOf = (result, id) => (result.cardRates || []).find((rate) => rate.id === id) || null;

describe('cardStartRateFields', () => {
  const meta = { tankRatePerGallon: { amount: 20, unit: 'g' } };
  test('the card rate, when the catalog keeps the band per gallon in the card\'s unit and the rate is not above its top', () => {
    expect(cardStartRateFields(meta, ANTAPEX)).toEqual({ cardStartRate: 20 });
    expect(cardStartRateFields({ tankRatePerGallon: { amount: 30, unit: 'g' } }, ANTAPEX)).toEqual({ cardStartRate: 30 });
    // A card may mix weaker than the band (the job card's rule for a declared rate).
    expect(cardStartRateFields({ tankRatePerGallon: { amount: 5, unit: 'g' } }, ANTAPEX)).toEqual({ cardStartRate: 5 });
  });
  test('nothing above the band, on another unit, on an unreadable band, or with no usable amount', () => {
    expect(cardStartRateFields({ tankRatePerGallon: { amount: 31, unit: 'g' } }, ANTAPEX)).toBeNull();
    expect(cardStartRateFields(meta, { ...ANTAPEX, default_unit: 'oz/gal' })).toBeNull();
    expect(cardStartRateFields(meta, { ...ANTAPEX, default_unit: 'g' })).toBeNull();
    expect(cardStartRateFields(meta, { ...ANTAPEX, default_rate: '1/2' })).toBeNull();
    expect(cardStartRateFields(meta, { ...ANTAPEX, default_rate: null })).toBeNull();
    for (const amount of [0, -1, Infinity, 'x', undefined]) expect(cardStartRateFields({ tankRatePerGallon: { amount, unit: 'g' } }, ANTAPEX)).toBeNull();
    expect(cardStartRateFields(null, ANTAPEX)).toBeNull();
    expect(cardStartRateFields({}, ANTAPEX)).toBeNull();
  });
  test('a line with a label rate keeps its own fields; a line another booked card shares starts blank', () => {
    expect(cardStartRateFields({ ...meta, labelRatePerGallon: { amount: 2, unit: 'fl_oz', epa: '53883-335' } }, ANTAPEX)).toBeNull();
    // No one rate: an explicit blank, so the form never falls back to the bottom of the band.
    expect(cardStartRateFields({ ...meta, sharedRate: true }, ANTAPEX)).toEqual({ cardStartRate: '' });
    // A row the card's rate could not start anyway (another unit) is left to the catalog.
    expect(cardStartRateFields({ ...meta, sharedRate: true }, { ...ANTAPEX, default_unit: 'oz/gal' })).toBeNull();
  });
});

describe('the close-out\'s starting products', () => {
  test('bed bug treatment 1: Crossfire and Antapex, with Antapex starting at the card\'s 20 g per gallon', async () => {
    const result = await defaults('Bed Bug Treatment Service', 'bed_bug_treatment');
    expect(result).toMatchObject({ source: 'protocol_visit', programKey: 'bed_bug', matchedVisit: { visit: 2 } });
    expect(result.products.map((product) => product.name)).toEqual(['MGK Crossfire Bed Bug Concentrate', 'Atticus Antapex WSG']);
    // The band stays the catalog's: 30 is still the review ceiling.
    expect(byId(result, 'a')).toMatchObject({ defaultRate: '10-30', defaultUnit: 'g/gal', completionApplicationMethod: 'spot_treatment' });
    expect(byId(result, 'a').labelUseRate).toBeUndefined();
    // Crossfire's card line states its dilution in words and declares no tank rate: the tech enters what went out.
    expect(result.cardRates).toEqual([{ id: 'a', cardStartRate: 20, completionApplicationMethod: 'spot_treatment' }]);
  });

  test('the bed bug inspection starts empty with no rate; a visit after treatment 1 starts empty and keeps the follow-up card\'s Antapex rate', async () => {
    const inspection = await defaults('Bed Bug Inspection', 'bed_bug_treatment');
    expect(inspection.products).toEqual([]);
    expect(inspection.cardRates).toBeUndefined();
    // The follow-up card sprays Antapex at 20 only where bugs are found off the bed: nothing is seeded, and a tech who adds it
    // starts at the card's rate, not the bottom of the band.
    const followup = await defaults('Bed Bug Treatment Service', 'bed_bug_treatment', { followup: true });
    expect(followup).toMatchObject({ source: 'none', matchedVisit: { visit: 3 }, products: [] });
    expect(followup.cardRates).toEqual([{ id: 'a', cardStartRate: 20, completionApplicationMethod: 'spot_treatment' }]);
  });

  test('flea treatment 1: Antapex starts at its card\'s 10, and the Tekko Pro label rate is as before', async () => {
    const result = await defaults('Flea Control Service', 'flea_tick');
    expect(rateOf(result, 'a')).toMatchObject({ cardStartRate: 10 });
    expect(byId(result, 't')).toMatchObject({ defaultRate: '0.66', labelUseRate: true });
    // A label-rate line has its own fields: it is never also a card start rate.
    expect(rateOf(result, 't')).toBeNull();
  });

  test('a booked add-on whose card lists Antapex: the rate starts blank, never one card\'s number or the bottom of the band', async () => {
    const result = await defaults('Bed Bug Treatment Service', 'bed_bug_treatment', { addons: [{ service_name: 'Flea Control Service', service_key: 'flea_tick' }] });
    expect(rateOf(result, 'a')).toMatchObject({ cardStartRate: '' });
    // An add-on that never uses Antapex leaves the card rate.
    const other = await defaults('Bed Bug Treatment Service', 'bed_bug_treatment', { addons: [{ service_name: 'Mosquito Barrier Treatment', service_key: 'mosquito_barrier' }] });
    expect(rateOf(other, 'a')).toMatchObject({ cardStartRate: 20 });
  });

  test('a catalog band below the card\'s rate, or no Antapex row in the catalog, gives no start rate', async () => {
    expect((await defaults('Bed Bug Treatment Service', 'bed_bug_treatment', { catalog: [{ ...ANTAPEX, default_rate: '10-15' }, CROSSFIRE] })).cardRates).toBeUndefined();
    expect((await defaults('Bed Bug Treatment Service', 'bed_bug_treatment', { catalog: [CROSSFIRE] })).cardRates).toBeUndefined();
  });

  test('a card with no tank-rate line answers as before: no cardRates key', async () => {
    const roach = await defaults('German Roach Cleanout', 'german_roach');
    expect(roach.source).toBe('protocol_visit');
    expect(roach.cardRates).toBeUndefined();
  });
});
