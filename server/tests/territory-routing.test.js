/**
 * Territory routing, build 5 (GATE_TERRITORY_ROUTING, owner 2026-10-30): the map-position
 * ZIP lookup, the place -> territory technician read, and the overlay of a territory on a
 * service line's home / gap technicians. No database (fake knex); the pickers on real rows
 * are in territory-routing-postgres.test.js.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const { zipForPoint, territoryTechnicianFor, TERRITORY_LINES } = require('../services/territory');
const { _internals } = require('../services/scheduling/line-technician');

const { withTerritory, shadowPlace } = _internals;

describe('zipForPoint (Census 2020 ZIP areas)', () => {
  test.each([
    ['Parrish', 27.587, -82.425, '34219'],
    ['Sarasota, Bee Ridge', 27.283, -82.45, '34233'],
    ['Siesta Key', 27.2667, -82.547, '34242'],
    ['Venice island', 27.0998, -82.4543, '34285'],
    ['Venice south', 27.05, -82.4, '34293'],
    ['North Port', 27.0442, -82.2359, '34287'],
  ])('%s reads its ZIP', (_place, lat, lng, zip) => {
    expect(zipForPoint(lat, lng)).toBe(zip);
  });

  test('database strings work like numbers', () => {
    expect(zipForPoint('27.587', '-82.425')).toBe('34219');
  });

  test('the Gulf, a missing point or junk is no ZIP', () => {
    expect(zipForPoint(27.3, -82.8)).toBeNull();
    for (const [lat, lng] of [[null, null], ['', ''], [undefined, -82.4], ['abc', '-82.4'], [0, 0]]) {
      expect(zipForPoint(lat, lng)).toBeNull();
    }
  });
});

describe('territoryTechnicianFor', () => {
  function fakeDb({ territory = {}, customers = {} } = {}) {
    const reads = [];
    const db = jest.fn((table) => ({
      where: (filter) => ({
        first: async () => {
          reads.push({ table, filter });
          if (table === 'territory_zips') {
            return territory[filter.zip] === undefined ? undefined : { zip: filter.zip, area: 'venice', technician_id: territory[filter.zip] };
          }
          return customers[filter.id];
        },
      }),
    }));
    db.reads = reads;
    return db;
  }

  test('a place ZIP wins, then its map position', async () => {
    const db = fakeDb({ territory: { 34293: 'tech-south', 34219: 'tech-north' } });
    await expect(territoryTechnicianFor(db, { zip: '34293', lat: 27.587, lng: -82.425 })).resolves.toBe('tech-south');
    await expect(territoryTechnicianFor(db, { lat: 27.587, lng: -82.425 })).resolves.toBe('tech-north');
    expect(db.reads.some((read) => read.table === 'customers')).toBe(false);
  });

  test('with neither, the customer row: its ZIP, else its map position', async () => {
    const db = fakeDb({
      territory: { 34293: 'tech-south' },
      customers: { 'cust-zip': { zip: '34293-0001' }, 'cust-point': { zip: '', latitude: '27.05', longitude: '-82.40' } },
    });
    await expect(territoryTechnicianFor(db, { customerId: 'cust-zip' })).resolves.toBe('tech-south');
    await expect(territoryTechnicianFor(db, { customerId: 'cust-point' })).resolves.toBe('tech-south');
  });

  test('no technician on the ZIP, a ZIP outside the 52, or no place: null', async () => {
    const db = fakeDb({ territory: { 34293: null } });
    await expect(territoryTechnicianFor(db, { zip: '34293' })).resolves.toBeNull();
    await expect(territoryTechnicianFor(db, { zip: '90210' })).resolves.toBeNull();
    await expect(territoryTechnicianFor(db, {})).resolves.toBeNull();
    await expect(territoryTechnicianFor(db, { customerId: 'missing' })).resolves.toBeNull();
  });
});

describe('withTerritory (a territory over a service line)', () => {
  test('pest, mosquito, rodent and termite / WDO follow the territory; lawn does not', () => {
    expect(TERRITORY_LINES).toEqual(['general', 'mosquito', 'rodent', 'termite']);
  });

  test('the territory technician becomes home; the line home covers the gaps', () => {
    expect(withTerritory({ homeId: 'hire', gapId: 'owner' }, 'general', 'owner')).toEqual({ homeId: 'owner', gapId: 'hire' });
    expect(withTerritory({ homeId: 'hire', gapId: 'owner' }, 'termite', 'hire')).toEqual({ homeId: 'hire', gapId: 'owner' });
    expect(withTerritory({ homeId: 'hire', gapId: null }, 'rodent', 'third')).toEqual({ homeId: 'third', gapId: 'hire' });
  });

  test('a line with nobody set takes the territory technician alone', () => {
    expect(withTerritory(null, 'mosquito', 'owner')).toEqual({ homeId: 'owner', gapId: null });
  });

  test('lawn, or no territory technician: the line map unchanged', () => {
    const entry = { homeId: 'owner', gapId: 'hire' };
    expect(withTerritory(entry, 'lawn', 'hire')).toBe(entry);
    expect(withTerritory(entry, 'general', null)).toBe(entry);
    expect(withTerritory(null, 'general', null)).toBeNull();
  });
});

describe('shadowPlace (the shadow row reads the saved visit\'s own place)', () => {
  const prior = process.env.GATE_TERRITORY_ROUTING;
  afterEach(() => {
    if (prior === undefined) delete process.env.GATE_TERRITORY_ROUTING; else process.env.GATE_TERRITORY_ROUTING = prior;
  });
  function fakeDb(visit, { fail = false } = {}) {
    return jest.fn(() => ({
      where: () => ({ first: async () => { if (fail) throw new Error('db down'); return visit; } }),
    }));
  }

  test('gate off: no place and no read', async () => {
    delete process.env.GATE_TERRITORY_ROUTING;
    const db = fakeDb({ service_address_zip: '34293' });
    await expect(shadowPlace(db, { scheduledServiceId: 'visit-1', customerId: 'cust-1' })).resolves.toBeNull();
    expect(db).not.toHaveBeenCalled();
  });

  test('gate on: the visit\'s service ZIP and map position, the customer as fallback', async () => {
    process.env.GATE_TERRITORY_ROUTING = 'true';
    const db = fakeDb({ service_address_zip: '34293', lat: '27.05', lng: '-82.40' });
    await expect(shadowPlace(db, { scheduledServiceId: 'visit-1', customerId: 'cust-1' }))
      .resolves.toEqual({ zip: '34293', lat: '27.05', lng: '-82.40', customerId: 'cust-1' });
    await expect(shadowPlace(fakeDb(null, { fail: true }), { scheduledServiceId: 'visit-1', customerId: 'cust-1' }))
      .resolves.toEqual({ zip: null, lat: null, lng: null, customerId: 'cust-1' });
  });
});

describe('call bookings route by the booked property (source guard)', () => {
  const source = require('fs').readFileSync(require('path').join(__dirname, '../services/call-recording-processor.js'), 'utf8');

  test('a fresh call booking passes the linked property\'s ZIP and map position', () => {
    const call = source.slice(source.indexOf('const bookingLineTech = await lineDefaultCallBookingTechnician(trx, {'));
    expect(call.slice(0, 700)).toContain('zip: propertyLinkage.address?.zip || null,');
    expect(call.slice(0, 700)).toContain('lat: propertyLinkage.lat ?? null,');
  });

  test('a reused visit passes its own stamped ZIP and map position', () => {
    const call = source.slice(source.indexOf('const reuseLineTech = await lineDefaultCallBookingTechnician(trx, {'));
    expect(call.slice(0, 700)).toContain('zip: existing.service_address_zip || null,');
    expect(call.slice(0, 700)).toContain('lat: existing.lat ?? null,');
  });
});
