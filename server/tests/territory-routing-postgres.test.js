/**
 * Territory routing on real PostgreSQL (GATE_TERRITORY_ROUTING, build 5): with the
 * service-line map live, the technician who owns a visit's ZIP gets a pest visit (by
 * ZIP or by map position), the offer ranking keeps that technician first, the shadow
 * resolver records it, lawn keeps the line map, and the gate off changes nothing.
 *
 * DB-gated: skips without DATABASE_URL, runs in CI against the migrated database. The
 * technician is synthetic; the one territory_zips row it takes is restored afterwards.
 */
const SKIP = !process.env.DATABASE_URL;
const describeDb = SKIP ? describe.skip : describe;

jest.setTimeout(60000);
jest.mock('../services/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const { randomUUID } = require('node:crypto');
const db = require('../models/db');
const lineTech = require('../services/scheduling/line-technician');

const ZIP = '34293';
const IN_ZIP = { lat: 27.05, lng: -82.4 };
const DAY = '2027-03-02';
const PEST = { serviceType: 'General Pest Control', date: DAY };
const LAWN = { serviceType: 'Lawn Fertilization', date: DAY };

describeDb('territory routing (Postgres)', () => {
  const techId = randomUUID();
  const coverId = randomUUID(); // the line's cover technician (the owner's role)
  let priorCard = [];
  const prior = { map: process.env.GATE_SERVICE_LINE_MAP, territory: process.env.GATE_TERRITORY_ROUTING };
  let priorOwner = null;

  const synthetic = (id, label) => ({
    id, name: `${label} ${id.slice(0, 8)}`, email: `${id}@example.invalid`,
    password_hash: 'synthetic-not-a-login-hash', role: 'technician', active: true,
    employment_status: 'active', field_dispatchable: true,
  });

  beforeAll(async () => {
    await db('technicians').insert([synthetic(techId, 'Territory'), synthetic(coverId, 'Cover')]);
    // A territory needs a cover on the card: the general pest line names one. A database that holds a card gets it back.
    priorCard = await db('service_line_techs').select('*');
    await db('service_line_techs').del();
    await db('service_line_techs').insert({ service_category: 'general', home_technician_id: coverId, gap_technician_id: null });
    priorOwner = (await db('territory_zips').where({ zip: ZIP }).first('technician_id')).technician_id;
    await db('territory_zips').where({ zip: ZIP }).update({ technician_id: techId });
  });

  afterAll(async () => {
    await db('territory_zips').where({ zip: ZIP }).update({ technician_id: priorOwner });
    await db('service_line_techs').del();
    if (priorCard.length) await db('service_line_techs').insert(priorCard);
    await db('technicians').whereIn('id', [techId, coverId]).del();
    for (const [key, value] of [['GATE_SERVICE_LINE_MAP', prior.map], ['GATE_TERRITORY_ROUTING', prior.territory]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await db.destroy();
  });

  beforeEach(() => {
    process.env.GATE_SERVICE_LINE_MAP = 'live';
    process.env.GATE_TERRITORY_ROUTING = 'true';
  });

  test('a pest visit in the ZIP goes to its territory technician, by ZIP or by map position', async () => {
    await expect(lineTech.pickLineTechnician(db, { ...PEST, zip: ZIP }))
      .resolves.toMatchObject({ mapped: true, line: 'general', technicianId: techId, reason: 'home' });
    await expect(lineTech.pickLineTechnician(db, { ...PEST, ...IN_ZIP }))
      .resolves.toMatchObject({ mapped: true, technicianId: techId, reason: 'home' });
  });

  test('offers rank the territory technician first and drop a technician with no part in the line', async () => {
    const ranking = await lineTech.lineOfferRanking(db, { lines: ['general'], place: { zip: ZIP } });
    expect(ranking.rankOf(techId)).toBe(0);
    expect(ranking.rankOf(coverId)).toBe(1);
    expect(ranking.rankOf(randomUUID())).toBeNull();
  });

  test('a territory line with no cover on the card adds no rule: the map decides, every technician\'s slots stay', async () => {
    await db('service_line_techs').del();
    try {
      await expect(lineTech.pickLineTechnician(db, { ...PEST, zip: ZIP })).resolves.toMatchObject({ mapped: false, technicianId: null, reason: 'no_map' });
      await expect(lineTech.lineOfferRanking(db, { lines: ['general'], place: { zip: ZIP } })).resolves.toBeNull();
      // A card naming only the territory technician has no cover either: the card entry is unchanged.
      await db('service_line_techs').insert({ service_category: 'general', home_technician_id: techId, gap_technician_id: null });
      await expect(lineTech.pickLineTechnician(db, { ...PEST, zip: ZIP })).resolves.toMatchObject({ technicianId: techId, reason: 'home' });
    } finally {
      await db('service_line_techs').del();
      await db('service_line_techs').insert({ service_category: 'general', home_technician_id: coverId, gap_technician_id: null });
    }
  });

  test('the shadow resolver records the territory pick', async () => {
    await expect(lineTech.resolveLineTechnician(db, { ...PEST, place: { zip: ZIP } }))
      .resolves.toMatchObject({ line: 'general', technicianId: techId, reason: 'home' });
  });

  test('lawn keeps the line map', async () => {
    const pick = await lineTech.pickLineTechnician(db, { ...LAWN, zip: ZIP });
    expect(pick.technicianId).not.toBe(techId);
  });

  test('gate off: the territory is never read', async () => {
    delete process.env.GATE_TERRITORY_ROUTING;
    const pick = await lineTech.pickLineTechnician(db, { ...PEST, zip: ZIP });
    expect(pick.technicianId).not.toBe(techId);
    const ranking = await lineTech.lineOfferRanking(db, { lines: ['general'], place: { zip: ZIP } });
    expect(ranking ? ranking.rankOf(techId) : null).toBeNull();
  });
});
