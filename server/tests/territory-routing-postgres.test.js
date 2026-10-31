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
  const prior = { map: process.env.GATE_SERVICE_LINE_MAP, territory: process.env.GATE_TERRITORY_ROUTING };
  let priorOwner = null;

  beforeAll(async () => {
    await db('technicians').insert({
      id: techId, name: `Territory ${techId.slice(0, 8)}`, email: `${techId}@example.invalid`,
      password_hash: 'synthetic-not-a-login-hash', role: 'technician', active: true,
      employment_status: 'active', field_dispatchable: true,
    });
    priorOwner = (await db('territory_zips').where({ zip: ZIP }).first('technician_id')).technician_id;
    await db('territory_zips').where({ zip: ZIP }).update({ technician_id: techId });
  });

  afterAll(async () => {
    await db('territory_zips').where({ zip: ZIP }).update({ technician_id: priorOwner });
    await db('technicians').where({ id: techId }).del();
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
    expect(ranking.rankOf(randomUUID())).toBeNull();
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
