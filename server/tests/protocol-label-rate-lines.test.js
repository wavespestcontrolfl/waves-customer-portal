// A card line may carry the product label's own per-gallon rate for that card's pest (lineMeta.labelRatePerGallon). On that card's jobs
// it stands in for the catalog row's rate, and it may be higher. So each such line is listed here with its label source: a new one, or
// a changed amount, fails until someone reads the label and adds it.
const protocols = require('../config/protocols.json');
const { matchServiceProtocol } = require('../services/protocol-matcher');
const { _test } = require('../services/job-card');
const { resolveCompletionProductDefaults } = require('../services/completion-product-defaults');
const { parseProtocolLines } = require('../services/waveguard-plan-engine');
const { _internals: { buildCompletionActions } } = require('../routes/admin-protocols');

const TEKKO = { id: 't', name: 'Tekko Pro IGR', active: true, default_rate: '1', default_unit: 'fl_oz/gal', epa_reg_number: '53883-335' };
const homeCard = () => protocols.cockroach.visits.find((visit) => visit.visit === 1);

// program, visit, product, amount, unit: label source. In protocols.json order.
const REVIEWED = [
  // Suspend PolyZone, EPA 101563-143 (label read 2026-11-26), outdoor use rate "0.25 to 1.5 fl oz of this product per 1,000 sq ft of
  // surfaces"; mosquitoes: "Treat with spray or mist around landscape plants ... and other places where mosquitoes may rest". The card's
  // 1.1 fl oz per gallon at 1 gallon per 1,500 sq ft is 0.73 fl oz per 1,000 (owner 2026-11-25, D7). Barrier visit and event visit.
  ['mosquito', 1, 'Suspend Polyzone', 1.1, 'fl_oz'],
  ['mosquito', 3, 'Suspend Polyzone', 1.1, 'fl_oz'],
  // Tekko Pro IGR, EPA 53883-335, "CONTROL OF COCKROACHES AND CRICKETS": 2 oz per gallon of water, 1 gallon per 1,000 sq ft.
  ['cockroach', 1, 'Tekko Pro IGR', 2, 'fl_oz'],
  // Tekko Pro IGR, EPA 53883-335, fleas: "Dilute spray solution: 1 oz. per gal. of water ... Spray rate: 1 gal. per 1,500 ft2", so
  // 1 fl oz per 1,500 sq ft. The flea card sprays the shared Antapex tank at 1 gallon per 1,000 sq ft, so the tank carries 0.66 fl oz
  // per gallon (0.66 per 1,000 sq ft, under the label's 0.667). Below the catalog's 1 per gallon: the close-out starts and is
  // reviewed here, since a gallon per 1,000 sq ft at 1 fl oz per gallon puts down 1.5 times the label amount.
  ['flea', 1, 'Tekko Pro IGR', 0.66, 'fl_oz'],
];

function labelRateLines() {
  const found = [];
  for (const [programKey, program] of Object.entries(protocols)) {
    for (const visit of program?.visits || []) {
      for (const meta of Object.values(visit.lineMeta || {})) {
        if (meta?.labelRatePerGallon) found.push([programKey, visit.visit, (meta.catalogProductHints || []).join('+'), meta.labelRatePerGallon.amount, meta.labelRatePerGallon.unit]);
      }
    }
  }
  return found;
}

describe('card lines that carry a label rate for their own pest', () => {
  test('every such line is on the reviewed list', () => {
    expect(labelRateLines()).toEqual(REVIEWED);
    // Only the flea Tekko Pro line is a weaker mix (below the label's dilution): the one line whose rate needs no registration match.
    const weaker = [];
    for (const [programKey, program] of Object.entries(protocols)) {
      for (const visit of program?.visits || []) {
        for (const meta of Object.values(visit.lineMeta || {})) {
          if (meta?.labelRatePerGallon?.weakerMix != null) weaker.push([programKey, visit.visit, meta.labelRatePerGallon.amount, meta.labelRatePerGallon.weakerMix]);
        }
      }
    }
    expect(weaker).toEqual([['flea', 1, 0.66, true]]);
  });

  test('the cockroach line governs the Tekko Pro tank rate above the catalog band; a plain declared rate never does', () => {
    const label = { lo: 1, hi: 1, unit: 'fl_oz' };
    const two = { lo: 2, hi: 2, unit: 'fl_oz' };
    expect(_test.protocolBand(label, { rate: two, declared: true, labelUse: true })).toEqual(two);
    expect(_test.protocolBand(label, { rate: two, declared: true })).toBeNull();
    expect(_test.protocolBand(label, { rate: two })).toBeNull();
    // Another unit is never taken.
    expect(_test.protocolBand(label, { rate: { lo: 2, hi: 2, unit: 'g' }, declared: true, labelUse: true })).toBeNull();
  });

  test('the cockroach card line resolves with its label rate, and the flea card line with its own shared-tank label rate', () => {
    const catalog = [TEKKO];
    const lineFor = (programKey, visitNo) => _test.linesFromLineMeta(protocols[programKey].visits.find((visit) => visit.visit === visitNo), catalog)
      .find((line) => line.product.id === 't');
    expect(lineFor('cockroach', 1)).toMatchObject({ declaredRate: { lo: 2, hi: 2, unit: 'fl_oz' }, labelUseRate: true, selected: true });
    const flea = lineFor('flea', 1);
    expect(flea).toMatchObject({ declaredRate: { lo: 0.66, hi: 0.66, unit: 'fl_oz' }, labelUseRate: true });
    // The flea rate is weaker than the catalog band. A row with another or no registration number gets no rate: not the card's
    // (not verified for that product) and not the catalog's stronger one. The line carries the hold the tank search shows.
    const fleaCard = protocols.flea.visits.find((visit) => visit.visit === 1);
    for (const epa of ['53883-444', null]) {
      const other = _test.linesFromLineMeta(fleaCard, [{ ...TEKKO, epa_reg_number: epa }]).find((line) => line.product.id === 't');
      expect(other.declaredRate).toBeUndefined();
      expect(other.labelUseRate).toBeUndefined();
      expect(other).toMatchObject({ labelRateRefused: true, labelHold: expect.stringContaining('53883-335') });
    }
    // The right registration with a weaker catalog band keeps the catalog: no card rate, no hold.
    for (const band of ['0.5', '0.25-0.5']) {
      const weakerRow = _test.linesFromLineMeta(fleaCard, [{ ...TEKKO, default_rate: band }]).find((line) => line.product.id === 't');
      expect(weakerRow.labelUseRate).toBeUndefined();
      expect(weakerRow.declaredRate).toBeUndefined();
      expect(weakerRow.labelHold).toBeUndefined();
    }
    // A catalog rate that cannot be compared with the card's (not a plain number or band, or another unit) is held too: "1/2"
    // would read as 1 in the close-out form.
    for (const row of [{ default_rate: '1/2' }, { default_unit: 'oz/gal' }, { default_unit: 'fl_oz/1000sf' }]) {
      const unread = _test.linesFromLineMeta(fleaCard, [{ ...TEKKO, ...row }]).find((line) => line.product.id === 't');
      expect(unread.declaredRate).toBeUndefined();
      expect(unread).toMatchObject({ labelRateRefused: true, labelHold: expect.stringContaining('cannot be checked') });
    }
  });

  test('the card line names no product or rate: a completion action records the generic step, the verified rate rides only with the product', () => {
    const [raw] = Object.entries(homeCard().lineMeta).find(([, meta]) => meta.labelRatePerGallon);
    expect(raw).not.toMatch(/Tekko|fl oz per gallon/i);
    expect(_test.lineRate(raw)).toBeNull();
  });

  test('a hint that resolves to another registration never takes the label rate', () => {
    for (const epa of ['53883-444', null]) {
      const [line] = _test.linesFromLineMeta(homeCard(), [{ ...TEKKO, epa_reg_number: epa }]).filter((l) => l.product.id === 't');
      expect(line.labelUseRate).toBeUndefined();
      expect(line.declaredRate).toBeUndefined();
    }
  });

  test('every cockroach job gets the Tekko Pro card, vehicles included, and no card names Gentrol Complete EC3', () => {
    // Owner 2026-11-25 (D11): "EC3 stops on cockroach jobs". The Tekko Pro label (53883-335) lists transportation equipment:
    // automobiles, buses, boats and trucks.
    expect(JSON.stringify(protocols.cockroach)).not.toContain('Gentrol');
    expect(protocols.cockroach.visits.map((visit) => visit.visit)).toEqual([1, 2, 3]);
    for (const [name, serviceKey] of [
      ['Cockroach Treatment', 'cockroach_control'], ['German Roach Cleanout', 'german_roach'], ['German Roach Cleanout', null],
      ['Cockroach Control Service', null], ['Vehicle German Roach Treatment (2 Visits)', 'vehicle_german_roach'],
      ['Vehicle Roach Add-On', 'vehicle_roach_addon'], ['RV Roach Treatment', null],
    ]) {
      const match = matchServiceProtocol(protocols, name, serviceKey ? { serviceKey } : {});
      expect([name, match.matchedVisit.visit]).toEqual([name, 1]);
      expect(match.matchedVisit.completionDefaultProducts).toContain('Tekko Pro IGR');
    }
  });

  test('the follow-up card records nothing as applied that the tech did not apply', () => {
    // Its "no growth regulator again" reminder is a note, never a selectable completion action.
    const visit = protocols.cockroach.visits.find((v) => v.visit === 3);
    const lines = [...parseProtocolLines(visit.primary, 'base'), ...parseProtocolLines(visit.secondary, 'conditional')];
    expect(lines.map((line) => line.raw).join(' ')).not.toMatch(/growth regulator/i);
    expect(visit.notes).toMatch(/No growth regulator at the follow-up/);
  });

});

describe('the completion form gets the cockroach label rate', () => {
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

  test('the completion defaults prefill and review Tekko Pro at 2 fl oz per gallon on the home cockroach card only', async () => {
    const run = async (row, serviceType, serviceKey, addons = []) => {
      const db = fakeDb({
        products_catalog: [row], product_aliases: [], scheduled_service_addons: addons,
        scheduled_services: [{ id: 's', service_id: null, service_type: serviceType, service_key_snapshot: serviceKey, scheduled_date: '2026-12-01' }],
      });
      const result = await resolveCompletionProductDefaults({ db, serviceId: 's', protocols });
      return result.products.find((p) => p.id === 't') || null;
    };
    expect(await run(TEKKO, 'German Roach Cleanout', 'german_roach')).toMatchObject({ defaultRate: '2', labelUseRate: true });
    // Another registration, or a catalog band in another unit, keeps the catalog rate.
    expect((await run({ ...TEKKO, epa_reg_number: '53883-444' }, 'German Roach Cleanout', 'german_roach')).defaultRate).toBe('1');
    expect((await run({ ...TEKKO, default_unit: 'fl_oz/1000sqft' }, 'German Roach Cleanout', 'german_roach')).defaultRate).toBe('1');
    // The flea card prefills and reviews Tekko Pro at its own shared-tank rate: never the cockroach 2, and never the catalog 1
    // (1 fl oz per gallon at the card's gallon per 1,000 sq ft is 1.5 times the flea label amount).
    // 0.66 is the prefill and the review ceiling: the card's tank goes out at 1 gallon per 1,000 sq ft, where anything above 0.66 fl
    // oz per gallon is above the label amount per area.
    expect(await run(TEKKO, 'Flea Treatment', 'flea_tick')).toMatchObject({ defaultRate: '0.66', labelUseRate: true });
    // Another or no registration number: the rate starts blank (never the catalog's stronger 1), as the tank search withholds it.
    for (const epa of ['53883-444', null]) {
      expect(await run({ ...TEKKO, epa_reg_number: epa }, 'Flea Treatment', 'flea_tick')).toMatchObject({ defaultRate: '', labelUseRate: true });
    }
    // The right registration with a weaker catalog band keeps that band.
    const weakerBand = await run({ ...TEKKO, default_rate: '0.5' }, 'Flea Treatment', 'flea_tick');
    expect(weakerBand.defaultRate).toBe('0.5');
    expect(weakerBand.labelUseRate).toBeUndefined();
    // A catalog rate that cannot be compared starts blank too, whatever its unit.
    for (const row of [{ default_rate: '1/2' }, { default_unit: 'oz/gal' }, { epa_reg_number: null, default_unit: 'fl_oz/1000sf' }]) {
      expect(await run({ ...TEKKO, ...row }, 'Flea Treatment', 'flea_tick')).toMatchObject({ defaultRate: '', labelUseRate: true });
    }
    // Every other label-rate line keeps its card rate as the ceiling: PolyZone on the mosquito card is 1.1, though its catalog band
    // reaches 1.5.
    const polyzone = { id: 't', name: 'Suspend Polyzone', active: true, default_rate: '0.25-1.5', default_unit: 'fl_oz/gal', epa_reg_number: '101563-143' };
    expect(await run(polyzone, 'Mosquito Barrier Treatment', 'mosquito_barrier')).toMatchObject({ defaultRate: '1.1', labelUseRate: true });
    // A booked cockroach add-on lists Tekko Pro at 2: the flea rate starts blank too.
    expect(await run(TEKKO, 'Flea Treatment', 'flea_tick', [{ service_name: 'German Roach Cleanout', service_key: 'german_roach' }])).toMatchObject({ defaultRate: '', labelUseRate: true });
    // A booked flea add-on lists Tekko Pro at 0.66: the rate starts blank (neither the 2 nor the catalog 1), the tech records what went out.
    const withFlea = await run(TEKKO, 'German Roach Cleanout', 'german_roach', [{ service_name: 'Flea Treatment', service_key: 'flea_tick' }]);
    expect(withFlea).toMatchObject({ defaultRate: '', labelUseRate: true });
    // An add-on whose card never uses Tekko Pro keeps the card rate.
    const withAnts = await run(TEKKO, 'German Roach Cleanout', 'german_roach', [{ service_name: 'Ant Treatment', service_key: null }]);
    expect(withAnts).toMatchObject({ defaultRate: '2', labelUseRate: true });
  });

  test('the completion actions carry the same rate', () => {
    const visit = homeCard();
    const lines = parseProtocolLines(visit.primary, 'base');
    const actions = buildCompletionActions({ lines, products: [TEKKO], programKey: 'cockroach', visit });
    const tekko = actions.find((a) => a.product?.id === 't');
    // The line's own crack-and-crevice method goes with it: a catalog row with no method never falls to the inferred perimeter
    // spray and its 4 oz pest default.
    expect(tekko.product).toMatchObject({ defaultRate: '2', labelUseRate: true, method: 'spot_treatment' });
    // A booked add-on card that lists Tekko Pro too (the flea add-on): the action prefills no card rate; its method stays.
    const shared = buildCompletionActions({ lines, products: [TEKKO], programKey: 'cockroach', visit, addonHints: new Set(['tekko pro igr']) })
      .find((a) => a.product?.id === 't');
    expect(shared.product).toMatchObject({ defaultRate: '', labelUseRate: true, method: 'spot_treatment' });
    // Add-ons that could not be read: the rate starts blank too.
    expect(buildCompletionActions({ lines, products: [TEKKO], programKey: 'cockroach', visit, addonHints: null })
      .find((a) => a.product?.id === 't').product.defaultRate).toBe('');
    const other = buildCompletionActions({ lines, products: [{ ...TEKKO, epa_reg_number: '53883-444' }], programKey: 'cockroach', visit })
      .find((a) => a.product?.id === 't');
    expect(other.product.defaultRate).toBe('1');
    expect(other.product.labelUseRate).toBeUndefined();
  });

});

describe('the tank calculator on a visit with two Tekko Pro cards', () => {
  const NOW = new Date('2026-12-01T13:00:00Z');
  const hourly = async () => Array.from({ length: 6 }, (_, i) => ({ time: new Date(NOW.getTime() + i * 3600e3).toISOString(), precipProbability: 0, windMph: 3, temperatureF: 75 }));
  const visit = { customer_id: 'c1', scheduled_date: '2026-12-01', service_type: 'German Roach Cleanout', service_key: 'german_roach', window_start: '09:00', latitude: 27.4, longitude: -82.5 };
  let tables;
  const dbh = (table) => {
    const rows = tables[String(table).split(' as ')[0]] ?? [];
    const chain = {};
    for (const m of ['join', 'leftJoin', 'where', 'whereIn', 'whereNotNull', 'select', 'orderByRaw', 'orderBy', 'modify']) chain[m] = () => chain;
    chain.first = async () => rows[0] ?? null;
    chain.catch = (fn) => Promise.resolve(rows).catch(fn);
    chain.then = (res, rej) => Promise.resolve(rows).then(res, rej);
    return chain;
  };
  dbh.raw = (sql) => sql;
  const mix = () => require('../services/job-card').mixForProduct('t', 2, { serviceId: 'svc1', dbh, deps: { getHourly: hourly }, now: NOW });
  beforeEach(() => {
    tables = { scheduled_services: [visit], products_catalog: [{ ...TEKKO, category: 'insecticide', label_verified_at: '2026-11-01' }], equipment_calibrations: [], scheduled_service_addons: [] };
  });

  test('the home cockroach visit alone mixes at the card rate', async () => {
    const result = await mix();
    expect(result.reason).toBeNull();
    expect(result.amount).toBe(4);
    expect(result.ratePerGallon).toEqual({ lo: 2, hi: 2, unit: 'fl_oz' });
  });

  test('another registration matched to the line never takes the card text\'s rate, even inside its own catalog band', async () => {
    tables.products_catalog = [{ ...TEKKO, epa_reg_number: '53883-444', default_rate: '0.5-2', category: 'insecticide', label_verified_at: '2026-11-01' }];
    const result = await mix();
    expect(result.rateSource).toBe('catalog');
    expect(result.ratePerGallon).toEqual({ lo: 0.5, hi: 2, unit: 'fl_oz' });
  });

  test('a flea add-on at another rate withholds the dose instead of taking the first card', async () => {
    tables.scheduled_service_addons = [{ service_name: 'Flea Treatment', category: 'pest_control', service_key: 'flea_tick' }];
    const result = await mix();
    expect(result.amount).toBeNull();
    // The hold names each service's own rate, so the tech can mix a tank for each.
    expect(result.reason).toBe('Tekko Pro IGR has a different rate on each service on this visit: German Roach Cleanout 2 fl oz per gallon; Flea Treatment 0.66 fl oz per gallon. Mix a separate tank for each');
  });

  test('a held flea line holds the dose whichever service is the visit and whichever the add-on', async () => {
    const other = [{ ...TEKKO, epa_reg_number: '53883-444', category: 'insecticide', label_verified_at: '2026-11-01' }];
    // A mosquito visit (its card mixes Tekko Pro at the catalog's 1) with a flea add-on.
    tables.scheduled_services = [{ ...visit, service_type: 'Mosquito Barrier Treatment', service_key: 'mosquito_barrier' }];
    tables.scheduled_service_addons = [{ service_name: 'Flea Treatment', category: 'pest_control', service_key: 'flea_tick' }];
    tables.products_catalog = other;
    const mosquitoFirst = await mix();
    expect(mosquitoFirst.amount).toBeNull();
    expect(mosquitoFirst.reason).toContain('53883-335');
    // The flea visit with a mosquito add-on.
    tables.scheduled_services = [{ ...visit, service_type: 'Flea Treatment', service_key: 'flea_tick' }];
    tables.scheduled_service_addons = [{ service_name: 'Mosquito Barrier Treatment', category: 'mosquito', service_key: 'mosquito_barrier' }];
    const fleaFirst = await mix();
    expect(fleaFirst.amount).toBeNull();
    expect(fleaFirst.reason).toContain('53883-335');
    // The card's registration on the same two visits: no hold from the flea line.
    tables.products_catalog = [{ ...TEKKO, category: 'insecticide', label_verified_at: '2026-11-01' }];
    expect((await mix()).reason || '').not.toContain('53883-335');
  });

  test('an unverified label withholds with its own reason, never the per-service rates', async () => {
    tables.scheduled_service_addons = [{ service_name: 'Flea Treatment', category: 'pest_control', service_key: 'flea_tick' }];
    tables.products_catalog = [{ ...TEKKO, category: 'insecticide', label_verified_at: null }];
    const result = await mix();
    expect(result.amount).toBeNull();
    expect(result.reason).toBe('Label rate not yet verified');
  });

  test('a service rate that fails the label check is never printed in the hold', async () => {
    tables.scheduled_service_addons = [{ service_name: 'Flea Treatment', category: 'pest_control', service_key: 'flea_tick' }];
    // A catalog band in another unit: neither card rate passes the single-dose check.
    tables.products_catalog = [{ ...TEKKO, default_unit: 'ml/gal', category: 'insecticide', label_verified_at: '2026-11-01' }];
    const result = await mix();
    expect(result.amount).toBeNull();
    expect(result.reason).not.toMatch(/fl oz per gallon/);
  });
});
