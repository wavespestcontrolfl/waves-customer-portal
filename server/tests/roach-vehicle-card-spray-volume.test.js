// Protocols audit, roach items:
//   - a vehicle roach job got the house card (kitchens, appliance motors). It has its own two cards now: the vehicle job (gel
//     bait, non-repellent, growth regulator) and the add-on on a home job (gel bait and growth regulator only), each with the
//     labels' limits inside a vehicle;
//   - a card's label rate per gallon is the label amount per area only at the label's spray volume (Tekko Pro on cockroaches:
//     2 fl oz per gallon at 1 gallon per 1,000 sq ft). The tank search names that volume, and gives no amount for a named
//     rig that sprays more water per area.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const protocols = require('../config/protocols.json');
const { matchServiceProtocol, followupVisitMatch, MATCH_RULES } = require('../services/protocol-matcher');
const { labelRateCarrier } = require('../utils/protocol-label-rate');
const { resolveCompletionDefaultProductNames } = require('../services/completion-product-defaults');
const jobCard = require('../services/job-card');

const cardOf = (name, serviceKey = null, isFollowup = false) => {
  const match = followupVisitMatch(matchServiceProtocol(protocols, name, { serviceKey }), isFollowup);
  return [match.programKey, match.matchedVisit?.visit, match.reason];
};
const visitNo = (n) => protocols.cockroach.visits.find((visit) => visit.visit === n);
const productsOf = (visit) => Object.values(visit.lineMeta).filter((meta) => meta.treatmentApplied === true).flatMap((meta) => meta.catalogProductHints);

describe('vehicle roach services have their own cards', () => {
  test('the catalog key routes each service, whatever the visit is named', () => {
    expect(cardOf('Vehicle German Roach Treatment (2 Visits)', 'vehicle_german_roach')).toEqual(['cockroach', 4, 'vehicle_roach']);
    expect(cardOf('Vehicle Treatment', 'vehicle_german_roach')).toEqual(['cockroach', 4, 'vehicle_roach']);
    expect(cardOf('Vehicle Roach Add-On', 'vehicle_roach_addon')).toEqual(['cockroach', 5, 'vehicle_roach_addon']);
    expect(cardOf('Car Treatment', 'vehicle_roach_addon')).toEqual(['cockroach', 5, 'vehicle_roach_addon']);
  });

  test('a row with no key routes by its name', () => {
    expect(cardOf('Vehicle German Roach Treatment (2 Visits)')).toEqual(['cockroach', 4, 'vehicle_roach']);
    expect(cardOf('Vehicle Roach Treatment')).toEqual(['cockroach', 4, 'vehicle_roach']);
    expect(cardOf('Vehicle Roach Add-On')).toEqual(['cockroach', 5, 'vehicle_roach_addon']);
  });

  test('the home cards keep their routing', () => {
    expect(cardOf('German Roach Cleanout', 'cockroach_control')).toEqual(['cockroach', 1, 'german_roach_cleanout']);
    expect(cardOf('Cockroach Control')).toEqual(['cockroach', 1, 'cockroach_control']);
    expect(cardOf('Initial Native Roach Knockdown Service', 'pest_initial_palmetto_knockdown')).toEqual(['cockroach', 2, 'american_roach_exterior']);
  });

  test('the second visit of the vehicle job is the follow-up card, booked or named', () => {
    expect(cardOf('Vehicle German Roach Treatment (2 Visits)', 'vehicle_german_roach', true)).toEqual(['cockroach', 3, 'cockroach_followup']);
    expect(cardOf('Vehicle German Roach Treatment Recheck', 'vehicle_german_roach')).toEqual(['cockroach', 3, 'cockroach_followup']);
    // The follow-up card carries the vehicle limits, as a line that is not a treatment.
    const followup = visitNo(3);
    const line = followup.secondary.split('\n').find((raw) => raw.startsWith('On a vehicle:'));
    expect(line).toMatch(/no bait on the dash.*no spray on electrical parts/);
    expect(followup.lineMeta[line]).toEqual({ scope: 'interior', treatmentApplied: false });
  });

  test('both vehicle rules sit before the German roach rule, whose terms their names carry', () => {
    const order = MATCH_RULES.filter((rule) => rule.programKey === 'cockroach').map((rule) => rule.reason);
    expect(order.indexOf('vehicle_roach_addon')).toBeLessThan(order.indexOf('vehicle_roach'));
    expect(order.indexOf('vehicle_roach')).toBeLessThan(order.indexOf('german_roach_cleanout'));
  });

  test('the vehicle job: gel bait, non-repellent and growth regulator; the add-on: gel bait and growth regulator only', () => {
    expect(productsOf(visitNo(4)).sort()).toEqual(['Advion Evolution Cockroach Gel Bait', 'Atticus Antapex WSG', 'Tekko Pro IGR']);
    expect(productsOf(visitNo(5)).sort()).toEqual(['Advion Evolution Cockroach Gel Bait', 'Tekko Pro IGR']);
    // The live service rows hold the same lists (default_products, read from production 2026-11-26).
    expect([...visitNo(4).completionDefaultProducts].sort()).toEqual(['Advion Evolution Cockroach Gel Bait', 'Atticus Antapex WSG', 'Tekko Pro IGR']);
    expect([...visitNo(5).completionDefaultProducts].sort()).toEqual(['Advion Evolution Cockroach Gel Bait', 'Tekko Pro IGR']);
    expect(JSON.stringify(visitNo(5).lineMeta)).not.toMatch(/Antapex/);
    expect(visitNo(5).primary).not.toMatch(/non-repellent/i);
  });

  test('neither card carries the house card\'s rooms, and every line is declared a treatment or not', () => {
    for (const n of [4, 5]) {
      const visit = visitNo(n);
      const lines = visit.primary.split('\n');
      expect(lines.join(' ')).not.toMatch(/kitchen|bathroom|appliance|plumbing|cabinet/i);
      for (const line of lines) expect(typeof visit.lineMeta[line]?.treatmentApplied).toBe('boolean');
      // The label limits a vehicle adds (Advion 100-1484, Tekko Pro 53883-335; Antapex 91234-401 on the vehicle job).
      expect(visit.notes).toMatch(/never on the dash, in a vent or in direct sun \(above 120 F/);
      expect(visit.notes).toMatch(/never on wiring, switches, screens or other electrical parts; do not wet carpet or seats; test a hidden spot/);
      // Drying and re-entry are steps of every job, never an "if needed" line.
      expect(visit.primary).toMatch(/Leave the doors open until the spray has dried; nobody rides in the vehicle and no child seat goes back in until then/);
      expect(visit.secondary).toBe('');
    }
    expect(visitNo(4).notes).toMatch(/Antapex WSG, EPA 91234-401/);
    expect(visitNo(5).notes).toMatch(/no non-repellent spray in the vehicle/);
  });

  test('the close-out starts each service with its own products', () => {
    const names = (serviceType, serviceKey, isFollowup = false) => resolveCompletionDefaultProductNames({ protocols, serviceType, serviceKey, isFollowup });
    expect(names('Vehicle German Roach Treatment (2 Visits)', 'vehicle_german_roach')).toMatchObject({ source: 'protocol_visit', names: ['Atticus Antapex WSG', 'Tekko Pro IGR', 'Advion Evolution Cockroach Gel Bait'] });
    expect(names('Vehicle Roach Add-On', 'vehicle_roach_addon')).toMatchObject({ source: 'protocol_visit', names: ['Tekko Pro IGR', 'Advion Evolution Cockroach Gel Bait'] });
    // The follow-up has no product list: the growth regulator goes down once.
    expect(names('Vehicle German Roach Treatment (2 Visits)', 'vehicle_german_roach', true).names).toEqual([]);
  });
});

describe('a label rate per gallon is bound to its spray volume', () => {
  const tekko = { id: 'tekko', name: 'Tekko Pro IGR', default_rate: '1', default_unit: 'fl_oz/gal', label_verified_at: '2026-07-12', epa_reg_number: '53883-335' };
  const metaOf = (visit) => Object.values(visit.lineMeta).find((meta) => meta.labelRatePerGallon);

  test('the Tekko Pro lines state 1 gallon per 1,000 sq ft: the home card, both vehicle cards and the flea card', () => {
    for (const visit of [visitNo(1), visitNo(4), visitNo(5)]) {
      expect(metaOf(visit).labelRatePerGallon).toEqual({ amount: 2, unit: 'fl_oz', use: 'cockroaches', epa: '53883-335', carrierGalPer1000: 1 });
      expect(labelRateCarrier(metaOf(visit), tekko)).toBe(1);
    }
    expect(metaOf(protocols.flea.visits[0]).labelRatePerGallon).toMatchObject({ amount: 0.66, carrierGalPer1000: 1 });
    expect(labelRateCarrier(metaOf(protocols.flea.visits[0]), tekko)).toBe(1);
  });

  test('labelRateCarrier: only with the label rate itself, and only a real volume', () => {
    const meta = metaOf(visitNo(1));
    // Another registration gets no label rate, so no volume either.
    expect(labelRateCarrier(meta, { ...tekko, epa_reg_number: '53883-444' })).toBeNull();
    for (const carrierGalPer1000 of [0, -1, Infinity, 'x', undefined]) {
      expect(labelRateCarrier({ ...meta, labelRatePerGallon: { ...meta.labelRatePerGallon, carrierGalPer1000 } }, tekko)).toBeNull();
    }
    expect(labelRateCarrier(null, tekko)).toBeNull();
  });

  const gel = { id: 'gel', name: 'Advion Evolution Cockroach Gel Bait', default_rate: '0.5', default_unit: 'g/spot', label_verified_at: '2026-07-12', epa_reg_number: '100-1484' };
  const truck = { id: 'cal-1', equipment_system_id: 'sys-1', system_type: 'tank', system_name: 'Tank #1', carrier_gal_per_1000: 2, calibration_status: 'field_verified', tank_capacity_gal: '110.00' };
  const hand = { id: 'cal-2', equipment_system_id: 'sys-2', system_type: 'backpack', system_name: 'Hand sprayer', carrier_gal_per_1000: 1, calibration_status: 'field_verified', tank_capacity_gal: '1.00' };
  const systems = [{ id: 'sys-1', name: 'Tank #1', system_type: 'tank', tank_capacity_gal: '110.00' }, { id: 'sys-2', name: 'Hand sprayer', system_type: 'backpack', tank_capacity_gal: '1.00' }];
  const home = { customer_id: 'c1', scheduled_date: '2026-12-09', service_type: 'German Roach Cleanout', service_category: 'pest_control', service_key: 'cockroach_control' };
  const mix = (visit, gallons, { equipmentSystemId = null, calibrations = [truck, hand] } = {}) => {
    const rows = { scheduled_services: [visit], products_catalog: [tekko, gel], equipment_calibrations: calibrations, equipment_systems: systems, scheduled_service_addons: [], product_aliases: [] };
    const dbh = (t) => {
      const table = String(t).split(' as ')[0];
      const chain = {};
      for (const m of ['join', 'leftJoin', 'where', 'whereIn', 'whereNotNull', 'select', 'orderByRaw', 'orderBy', 'modify']) chain[m] = () => chain;
      chain.first = async () => (rows[table] || [])[0] ?? null;
      chain.catch = (fn) => Promise.resolve(rows[table] || []).catch(fn);
      chain.then = (res, rej) => Promise.resolve(rows[table] || []).then(res, rej);
      return chain;
    };
    dbh.raw = (sql) => sql;
    return jobCard.mixForProduct('tekko', gallons, { serviceId: 'svc1', equipmentSystemId, dbh, deps: { buildPlan: jest.fn(), protocols }, now: new Date('2026-12-08T14:00:00Z') });
  };

  test('no rig named: the amount, the volume it holds at, and the area the tank covers at that volume', async () => {
    // 2 fl oz per gallon at 1 gallon per 1,000 sq ft: 4 gallons carry 8 fl oz for 4,000 sq ft, the label's 2 fl oz per 1,000.
    const out = await mix(home, 4);
    expect(out).toMatchObject({ amount: 8, unit: 'fl_oz', gallons: 4, basis: 'per_gallon', sprayVolumeGalPer1000: 1, coversSqft: 4000, ratePerGallon: { lo: 2, hi: 2 }, rateSource: 'protocol', rig: null });
    expect(out.amount / (out.coversSqft / 1000)).toBe(2);
    // Whatever calibration is on file says nothing of the sprayer in the tech's hand: no rig named, nothing judged.
    expect((await mix(home, 1, { calibrations: [truck] })).amount).toBe(2);
  });

  test('a picked rig that sprays 2 gallons per 1,000 sq ft gets no amount: the same mix would be twice the label amount', async () => {
    const out = await mix(home, null, { equipmentSystemId: 'sys-1' });
    expect(out.amount).toBeNull();
    expect(out.reason).toBe("The card's rate is for 1 gal per 1,000 sq ft. Tank #1 sprays 2: the same mix would put down more than the label amount. Use a sprayer at the card's volume");
    expect(out.ratePerGallon).toBeNull();
    expect(out.sprayVolumeGalPer1000).toBeUndefined();
  });

  test('a rig assigned to the visit is named too', async () => {
    const out = await mix({ ...home, assigned_equipment_system_id: 'sys-1' }, 4);
    expect(out.amount).toBeNull();
    expect(out.reason).toMatch(/Tank #1 sprays 2/);
  });

  test('a picked rig at the card\'s volume gets the amount; any other volume, over or under, gets none', async () => {
    expect(await mix(home, null, { equipmentSystemId: 'sys-2' })).toMatchObject({ amount: 2, gallons: 1, sprayVolumeGalPer1000: 1, coversSqft: 1000, rig: { name: 'Hand sprayer' } });
    // Under the volume the same mix is less than the label amount per area (half of it at 0.5 gal per 1,000 sq ft).
    const light = { ...hand, carrier_gal_per_1000: 0.5 };
    const under = await mix(home, null, { equipmentSystemId: 'sys-2', calibrations: [truck, light] });
    expect(under.amount).toBeNull();
    expect(under.reason).toBe("The card's rate is for 1 gal per 1,000 sq ft. Hand sprayer sprays 0.5: the same mix would put down less than the label amount. Use a sprayer at the card's volume");
    // No tolerance: a rig a hundredth over it gets no amount.
    const over = { ...hand, carrier_gal_per_1000: 1.01 };
    const refused = await mix(home, null, { equipmentSystemId: 'sys-2', calibrations: [truck, over] });
    expect(refused.amount).toBeNull();
    expect(refused.reason).toMatch(/Hand sprayer sprays 1\.01: the same mix would put down more than the label amount/);
    // A picked rig with no calibration on file has no volume to judge.
    expect(await mix(home, null, { equipmentSystemId: 'sys-2', calibrations: [truck] })).toMatchObject({ amount: 2, sprayVolumeGalPer1000: 1 });
  });

  test('the vehicle cards and the flea card are bound the same way', async () => {
    const vehicle = { ...home, service_type: 'Vehicle German Roach Treatment (2 Visits)', service_key: 'vehicle_german_roach' };
    expect(await mix(vehicle, 1)).toMatchObject({ amount: 2, sprayVolumeGalPer1000: 1, coversSqft: 1000 });
    expect((await mix(vehicle, null, { equipmentSystemId: 'sys-1' })).amount).toBeNull();
    const flea = { ...home, service_type: 'Flea Control Service', service_category: 'specialty', service_key: 'flea_tick' };
    expect(await mix(flea, 2)).toMatchObject({ amount: 1.32, sprayVolumeGalPer1000: 1, coversSqft: 2000 });
    expect((await mix(flea, null, { equipmentSystemId: 'sys-1' })).reason).toMatch(/Tank #1 sprays 2/);
  });

  test('a per-gallon rate with no stated volume is as before: no volume line, no rig check', async () => {
    const demand = { id: 'tekko', name: 'Demand CS', category: 'insecticide', default_rate: '0.2-0.8', default_unit: 'fl_oz/gal', label_verified_at: '2026-07-12' };
    const rows = { scheduled_services: [{ ...home, service_type: 'Quarterly Pest Control', service_key: null }], products_catalog: [demand], equipment_calibrations: [truck], equipment_systems: systems, scheduled_service_addons: [], product_aliases: [] };
    const dbh = (t) => {
      const table = String(t).split(' as ')[0];
      const chain = {};
      for (const m of ['join', 'leftJoin', 'where', 'whereIn', 'whereNotNull', 'select', 'orderByRaw', 'orderBy', 'modify']) chain[m] = () => chain;
      chain.first = async () => (rows[table] || [])[0] ?? null;
      chain.catch = (fn) => Promise.resolve(rows[table] || []).catch(fn);
      chain.then = (res, rej) => Promise.resolve(rows[table] || []).then(res, rej);
      return chain;
    };
    dbh.raw = (sql) => sql;
    const out = await jobCard.mixForProduct('tekko', null, { serviceId: 'svc1', equipmentSystemId: 'sys-1', dbh, deps: { buildPlan: jest.fn(), protocols }, now: new Date('2026-12-08T14:00:00Z') });
    expect(out).toMatchObject({ amount: 22, amountMax: 88, gallons: 110, basis: 'per_gallon' });
    expect(out.sprayVolumeGalPer1000).toBeUndefined();
    expect(out.coversSqft).toBeUndefined();
  });
});
