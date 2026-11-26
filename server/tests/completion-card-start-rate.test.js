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
  test('a line with a label rate keeps its own fields, and a line another booked card shares has no one rate', () => {
    expect(cardStartRateFields({ ...meta, labelRatePerGallon: { amount: 2, unit: 'fl_oz', epa: '53883-335' } }, ANTAPEX)).toBeNull();
    expect(cardStartRateFields({ ...meta, sharedRate: true }, ANTAPEX)).toBeNull();
  });
});

describe('the close-out\'s starting products', () => {
  test('bed bug treatment 1: Crossfire and Antapex, with Antapex starting at the card\'s 20 g per gallon', async () => {
    const result = await defaults('Bed Bug Treatment Service', 'bed_bug_treatment');
    expect(result).toMatchObject({ source: 'protocol_visit', programKey: 'bed_bug', matchedVisit: { visit: 2 } });
    expect(result.products.map((product) => product.name)).toEqual(['MGK Crossfire Bed Bug Concentrate', 'Atticus Antapex WSG']);
    // The band stays the catalog's: 30 is still the review ceiling.
    expect(byId(result, 'a')).toMatchObject({ cardStartRate: 20, defaultRate: '10-30', defaultUnit: 'g/gal', completionApplicationMethod: 'spot_treatment' });
    expect(byId(result, 'a').labelUseRate).toBeUndefined();
    // Crossfire's card line states its dilution in words and declares no tank rate: the tech enters what went out.
    expect(byId(result, 'x').cardStartRate).toBeUndefined();
  });

  test('the bed bug inspection and every visit after treatment 1 start empty', async () => {
    expect((await defaults('Bed Bug Inspection', 'bed_bug_treatment')).products).toEqual([]);
    expect((await defaults('Bed Bug Treatment Service', 'bed_bug_treatment', { followup: true })).products).toEqual([]);
  });

  test('flea treatment 1: Antapex starts at its card\'s 10, and the Tekko Pro label rate is as before', async () => {
    const result = await defaults('Flea Control Service', 'flea_tick');
    expect(byId(result, 'a')).toMatchObject({ cardStartRate: 10, defaultRate: '10-30' });
    expect(byId(result, 't')).toMatchObject({ defaultRate: '0.66', labelUseRate: true });
    expect(byId(result, 't').cardStartRate).toBeUndefined();
  });

  test('a booked add-on whose card lists Antapex at another rate: the rate starts from the catalog, not from one card', async () => {
    const result = await defaults('Bed Bug Treatment Service', 'bed_bug_treatment', { addons: [{ service_name: 'Flea Control Service', service_key: 'flea_tick' }] });
    expect(byId(result, 'a').cardStartRate).toBeUndefined();
    // An add-on that never uses Antapex leaves the card rate.
    const other = await defaults('Bed Bug Treatment Service', 'bed_bug_treatment', { addons: [{ service_name: 'Mosquito Barrier Treatment', service_key: 'mosquito_barrier' }] });
    expect(byId(other, 'a').cardStartRate).toBe(20);
  });

  test('a catalog band below the card\'s rate gives no start rate', async () => {
    const result = await defaults('Bed Bug Treatment Service', 'bed_bug_treatment', { catalog: [{ ...ANTAPEX, default_rate: '10-15' }, CROSSFIRE] });
    expect(byId(result, 'a').cardStartRate).toBeUndefined();
  });
});
