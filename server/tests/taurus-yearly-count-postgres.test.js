/**
 * Real PostgreSQL: the Taurus SC yearly count (services/taurus-yearly-count.js) against a scratch
 * schema. The compliance ledger is the source: retracted rows are left out, the home is the property
 * frozen on the ledger (else the visit's), the year is the ET year of today, the visit being completed
 * is left out, one service record is one application, and the product is found by the close-out
 * picker's name rule. The SQL's own answers, through the real driver.
 *
 * Self-skips without DATABASE_URL (CI runs it in the server-db job), e.g.:
 *   DATABASE_URL=postgresql://localhost:5432/waves_test \
 *     ~/.claude/bin/jest-slot --runInBand tests/taurus-yearly-count-postgres.test.js
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const knexLib = require('knex');
const { randomUUID } = require('crypto');
const { taurusYearlyCount, projectTaurusEligibility } = require('../services/taurus-yearly-count');

const SKIP = !process.env.DATABASE_URL;
const describeOrSkip = SKIP ? describe.skip : describe;
const NOW = new Date('2026-12-10T15:00:00Z');
const OLD = '2026-05-01'; // before the 0.03% ruling: counts as 0.06%
const NEW = '2026-12-01';

describeOrSkip('taurus yearly count on PostgreSQL', () => {
  let db;
  let schema;
  let taurusId;
  let retiredTaurusId;
  let otherId;
  const propA = randomUUID();
  const propB = randomUUID();

  // One completed visit with one ledger row (more rows on the same record through `extra`).
  async function application({
    cust, property = null, date = NEW, product = taurusId, ledgerProperty = null, rate = null, unit = null, dilution = null,
    quantity = null, quantityUnit = null, retracted = false, withVisit = true,
  }) {
    const ssId = randomUUID();
    const srId = randomUUID();
    if (withVisit) await db('scheduled_services').insert({ id: ssId, customer_id: cust, property_id: property });
    await db('service_records').insert({ id: srId, customer_id: cust, scheduled_service_id: withVisit ? ssId : null, service_date: date });
    await ledgerRow({ cust, srId, date, product, ledgerProperty, rate, unit, dilution, quantity, quantityUnit, retracted });
    return { ssId, srId };
  }
  const ledgerRow = ({
    cust, srId, date = NEW, product = taurusId, ledgerProperty = null, rate = null, unit = null, dilution = null,
    quantity = null, quantityUnit = null, retracted = false, serviceProductId = null,
  }) => db('property_application_history').insert({
    customer_id: cust, service_record_id: srId, product_id: product, application_date: date, property_id: ledgerProperty,
    application_rate: rate, rate_unit: unit, dilution_rate: dilution, quantity_applied: quantity, quantity_unit: quantityUnit,
    service_product_id: serviceProductId, retracted_at: retracted ? new Date() : null,
  });
  const count = (cust, property, visitId = randomUUID(), now = NOW, scheduledDate = undefined) => taurusYearlyCount({
    id: visitId, customer_id: cust, property_id: property, scheduled_date: scheduledDate,
  }, { knex: db, now });

  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.pathname !== '/waves_test') {
      throw new Error('This test requires a local waves_test database');
    }
    schema = `taurus_yearly_${randomUUID().replace(/-/g, '')}`;
    db = knexLib({ client: 'pg', connection: url.toString(), searchPath: [schema], pool: { min: 0, max: 4 } });
    await db.raw('CREATE SCHEMA ??', [schema]);
    await db.raw('CREATE TABLE products_catalog (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text, active boolean DEFAULT true)');
    await db.raw('CREATE TABLE scheduled_services (id uuid PRIMARY KEY, customer_id uuid, property_id uuid)');
    await db.raw('CREATE TABLE service_records (id uuid PRIMARY KEY, customer_id uuid, scheduled_service_id uuid, service_date date NOT NULL)');
    await db.raw(`CREATE TABLE property_application_history (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), customer_id uuid NOT NULL, service_record_id uuid, product_id uuid,
      application_date date NOT NULL, application_rate numeric(8,4), rate_unit varchar(30), dilution_rate varchar(100),
      quantity_applied numeric(8,3), quantity_unit varchar(20), service_product_id uuid,
      property_id uuid, retracted_at timestamptz
    )`);
    await db.raw('CREATE TABLE service_products (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), service_record_id uuid, product_name text)');
    [taurusId] = (await db('products_catalog').insert({ name: 'Taurus SC' }).returning('id')).map((r) => r.id);
    [retiredTaurusId] = (await db('products_catalog').insert({ name: '  TAURUS SC 9.7%  ', active: false }).returning('id')).map((r) => r.id);
    [otherId] = (await db('products_catalog').insert([{ name: 'LESCO Crosscheck Plus' }]).returning('id')).map((r) => r.id);
    await db('products_catalog').insert({ name: 'Taurus SCX' });
  });

  // Homes are shared across tests and every account's rows at a home now count, so each test starts empty.
  beforeEach(async () => {
    await db.raw('TRUNCATE property_application_history, service_records, scheduled_services, service_products');
  });

  afterAll(async () => {
    if (!db) return;
    await db.raw('DROP SCHEMA IF EXISTS ?? CASCADE', [schema]);
    await db.destroy();
  });

  it('counts the home\'s non-retracted Taurus ledger rows this ET year, by concentration', async () => {
    const cust = randomUUID();
    await application({ cust, property: propA, date: OLD }); // 0.06%
    await application({ cust, property: propA, date: NEW }); // 0.03%
    await application({ cust, property: propA, date: NEW, product: otherId }); // not Taurus
    await application({ cust, property: propA, date: NEW, retracted: true }); // retracted
    await application({ cust, property: propB, date: NEW }); // another home
    await application({ cust, property: propA, date: '2025-12-31' }); // last year
    await application({ cust, property: propA, date: '2027-01-01' }); // next year
    expect(await count(cust, propA)).toEqual({ high: 1, low: 1, count: 2, eligible: true, eligibleHigh: false, year: 2026, beforeRuling: false });
  });

  it('leaves out only the rows of the visit being completed', async () => {
    const cust = randomUUID();
    const first = await application({ cust, property: propA, date: NEW });
    await application({ cust, property: propA, date: OLD });
    expect((await count(cust, propA, first.ssId)).count).toBe(1);
    expect((await count(cust, propA)).count).toBe(2);
  });

  it('counts two visits on one day as two applications, and two rows of one record as one', async () => {
    const cust = randomUUID();
    await application({ cust, property: propA });
    await application({ cust, property: propA });
    const twoRows = await application({ cust, property: propA });
    await ledgerRow({ cust, srId: twoRows.srId });
    expect(await count(cust, propA)).toMatchObject({ high: 0, low: 3, count: 3 });
  });

  it('applies the label scenarios: 4 at 0.03%, 1 at 0.06% + 2 at 0.03%, 2 at 0.06%', async () => {
    const four = randomUUID();
    const fourHome = randomUUID();
    for (let i = 0; i < 4; i += 1) await application({ cust: four, property: fourHome });
    expect(await count(four, fourHome)).toMatchObject({ high: 0, low: 4, eligible: false });

    const three = randomUUID();
    const threeHome = randomUUID();
    for (let i = 0; i < 3; i += 1) await application({ cust: three, property: threeHome });
    expect(await count(three, threeHome)).toMatchObject({ high: 0, low: 3, eligible: true });

    const oneHigh = randomUUID();
    const oneHighHome = randomUUID();
    await application({ cust: oneHigh, property: oneHighHome, date: OLD });
    await application({ cust: oneHigh, property: oneHighHome });
    expect(await count(oneHigh, oneHighHome)).toMatchObject({ high: 1, low: 1, eligible: true });
    await application({ cust: oneHigh, property: oneHighHome });
    expect(await count(oneHigh, oneHighHome)).toMatchObject({ high: 1, low: 2, eligible: false });

    const twoHigh = randomUUID();
    const twoHighHome = randomUUID();
    await application({ cust: twoHigh, property: twoHighHome, date: OLD });
    await application({ cust: twoHigh, property: twoHighHome, date: '2026-09-09' });
    expect(await count(twoHigh, twoHighHome)).toMatchObject({ high: 2, low: 0, eligible: false });
  });

  it('reads a later 0.06% row from its rate or dilution', async () => {
    const cust = randomUUID();
    await application({ cust, property: propA, rate: 0.8, unit: 'fl_oz/gal' });
    await application({ cust, property: propA, dilution: '0.06%' });
    await application({ cust, property: propA, rate: 1.6, unit: 'oz' });
    expect(await count(cust, propA)).toMatchObject({ high: 2, low: 1, eligible: false });
  });

  it('places an application at the property frozen on the ledger, not at the visit as corrected later', async () => {
    const cust = randomUUID();
    await application({ cust, property: propB, ledgerProperty: propA });
    await application({ cust, property: propA, ledgerProperty: propB });
    expect((await count(cust, propA)).count).toBe(1);
    expect((await count(cust, propB)).count).toBe(1);
  });

  it('falls back to the visit\'s property for a legacy row, and counts a row with no property anywhere', async () => {
    const cust = randomUUID();
    await application({ cust, property: propA }); // ledger property_id null, visit propA
    await application({ cust, property: propB }); // ledger null, visit propB: another home
    await application({ cust, property: null }); // no property anywhere: counts at every home
    await application({ cust, withVisit: false }); // a record with no visit: unplaced
    expect((await count(cust, propA)).count).toBe(3);
    // A visit with no property counts the whole customer.
    expect((await count(cust, null)).count).toBe(4);
  });

  it('draws the year at ET midnight, not UTC', async () => {
    const cust = randomUUID();
    await application({ cust, property: null, date: '2026-12-31' });
    await application({ cust, property: null, date: '2027-01-01' });
    // 9 PM ET Dec 31 2026 = 02:00Z Jan 1 2027: still the 2026 year.
    expect((await count(cust, null, undefined, new Date('2027-01-01T02:00:00Z'))).count).toBe(1);
    // 1 AM ET Jan 1 2027: the 2027 year.
    expect(await count(cust, null, undefined, new Date('2027-01-01T06:00:00Z'))).toMatchObject({ count: 1, year: 2027 });
  });

  it('finds the product by the picker\'s name rule, a retired catalog row included, and not a lookalike', async () => {
    const cust = randomUUID();
    await application({ cust, property: propA, product: retiredTaurusId });
    await application({ cust, property: propA });
    const [{ id: lookalike }] = await db('products_catalog').where({ name: 'Taurus SCX' }).select('id');
    await application({ cust, property: propA, product: lookalike });
    expect((await count(cust, propA)).count).toBe(2);
  });

  it('counts a legacy ledger row with no product_id through its service product row\'s name', async () => {
    const cust = randomUUID();
    const legacy = await application({ cust, property: propA, product: null });
    const [{ id: spId }] = await db('service_products').insert({ service_record_id: legacy.srId, product_name: ' taurus sc ' }).returning('id');
    await db('property_application_history').where({ service_record_id: legacy.srId }).update({ service_product_id: spId });
    // A null-product row whose product row names something else is not Taurus.
    const other = await application({ cust, property: propA, product: null });
    const [{ id: otherSp }] = await db('service_products').insert({ service_record_id: other.srId, product_name: 'LESCO Crosscheck Plus' }).returning('id');
    await db('property_application_history').where({ service_record_id: other.srId }).update({ service_product_id: otherSp });
    await application({ cust, property: propA, product: null }); // no product row at all
    expect((await count(cust, propA)).count).toBe(1);
  });

  it('reads an amount above the house mix (after the cutoff) as the old 0.06% tank', async () => {
    const cust = randomUUID();
    await application({ cust, property: propA, quantity: 3.2, quantityUnit: 'fl_oz' });
    await application({ cust, property: propA, rate: 4, unit: 'oz' });
    await application({ cust, property: propA, quantity: 1.6, quantityUnit: 'fl_oz' });
    expect(await count(cust, propA)).toMatchObject({ high: 2, low: 1, eligible: false });
  });

  it('checks both years for a visit scheduled in the year before today', async () => {
    const cust = randomUUID();
    await application({ cust, property: propA, date: '2025-03-03' });
    await application({ cust, property: propA, date: '2025-04-04' });
    await application({ cust, property: propA, date: '2025-05-05' });
    await application({ cust, property: propA, date: '2025-06-06' });
    const now = new Date('2026-01-05T15:00:00Z');
    // 2025's rows read as 0.06% (before the cutoff), so 2025 is used up; 2026 is empty. Today alone says eligible, both years say not.
    expect(await count(cust, propA, undefined, now)).toMatchObject({ count: 0, eligible: true });
    expect(await count(cust, propA, undefined, now, '2025-12-30')).toMatchObject({ eligible: false, year: 2025 });
  });

  it('counts every account\'s applications at the home (a home that changed hands), and only this account\'s rows with no home', async () => {
    const oldOwner = randomUUID();
    const newOwner = randomUUID();
    await application({ cust: oldOwner, property: propA, date: NEW });
    await application({ cust: oldOwner, property: propA, date: NEW });
    await application({ cust: oldOwner, property: null, date: NEW, withVisit: false }); // the old owner's, no home recorded
    await application({ cust: newOwner, property: propA, date: NEW });
    await application({ cust: newOwner, property: propB, date: NEW }); // the new owner's other home
    expect((await count(newOwner, propA)).count).toBe(3);
    expect((await count(oldOwner, propA)).count).toBe(4);
    expect((await count(newOwner, null)).count).toBe(2);
  });

  describe('projectTaurusEligibility (the weekly buy list: one read for every home, judged in visit order)', () => {
    const project = (visits, now = NOW) => projectTaurusEligibility(visits, { knex: db, now });

    it('answers each home as the one-visit count does: same ledger, same label scenarios, same year bounds', async () => {
      const roomy = randomUUID();
      const full = randomUUID();
      const oneHigh = randomUUID();
      const handedOver = randomUUID();
      for (let i = 0; i < 3; i += 1) await application({ cust: roomy, property: propA });
      for (let i = 0; i < 4; i += 1) await application({ cust: full, property: propB });
      await application({ cust: oneHigh, property: randomUUID(), date: OLD });
      await application({ cust: oneHigh, property: null, date: OLD, withVisit: false });
      await application({ cust: handedOver, property: null, date: NEW, withVisit: false }); // this account's, no home recorded
      await application({ cust: randomUUID(), property: propA, date: NEW, product: otherId }); // not Taurus
      const homes = [[roomy, propA], [full, propB], [oneHigh, null], [handedOver, null], [randomUUID(), randomUUID()]];
      const visits = homes.map(([customer_id, property_id]) => ({ id: randomUUID(), customer_id, property_id, scheduled_date: '2026-12-11' }));
      const { fits, failed } = await project(visits);
      expect(failed).toBe(false);
      for (const v of visits) {
        const single = await count(v.customer_id, v.property_id);
        expect(fits.get(v.id)).toBe(single.eligible);
      }
      // roomy (3 at 0.03%) fits, full (4) does not, a visit with no home counts the whole account (two at 0.06%: used up)
      expect(visits.map((v) => fits.get(v.id))).toEqual([true, false, false, true, true]);
    });

    it('judges two visits at one home in date order, whoever drives them: the last application that fits uses the year up', async () => {
      const cust = randomUUID();
      for (let i = 0; i < 3; i += 1) await application({ cust, property: propA });
      const early = { id: randomUUID(), customer_id: cust, property_id: propA, scheduled_date: '2026-12-08' };
      const late = { id: randomUUID(), customer_id: cust, property_id: propA, scheduled_date: '2026-12-10' };
      const { fits } = await project([late, early]); // asked out of order
      expect(fits.get(early.id)).toBe(true);
      expect(fits.get(late.id)).toBe(false);
    });

    it('visits the same day are judged by window start (an unset time last), then id', async () => {
      const cust = randomUUID();
      for (let i = 0; i < 2; i += 1) await application({ cust, property: propA }); // two at the home: room for two more
      const mk = (id, window_start) => ({ id, customer_id: cust, property_id: propA, scheduled_date: '2026-12-10', window_start });
      // ids sort the opposite way to the times: the afternoon stop has the smallest id
      const afternoon = mk('00000000-0000-4000-8000-000000000001', '14:00:00');
      const morning = mk('00000000-0000-4000-8000-000000000002', '08:00:00');
      const unset = mk('00000000-0000-4000-8000-000000000003', null);
      const { fits } = await project([unset, afternoon, morning]);
      expect([morning, afternoon, unset].map((v) => fits.get(v.id))).toEqual([true, true, false]);
      // same time: the lower id goes first
      const tieA = mk('00000000-0000-4000-8000-0000000000a1', '09:00:00');
      const tieB = mk('00000000-0000-4000-8000-0000000000b1', '09:00:00');
      const tie = await project([tieB, tieA, { ...morning, id: '00000000-0000-4000-8000-0000000000c1', scheduled_date: '2026-12-09' }]);
      expect([tieA, tieB].map((v) => tie.fits.get(v.id))).toEqual([true, false]); // the earlier-day visit took the third; one more fits
    });

    it('a visit with no customer, or a failed read, leaves Taurus off', async () => {
      const lone = { id: randomUUID(), customer_id: null, property_id: propA, scheduled_date: '2026-12-08' };
      expect((await project([lone])).fits.get(lone.id)).toBe(false);
      const broken = { raw: () => { const err = new Error('select * from secret'); err.code = '57014'; throw err; } };
      const out = await projectTaurusEligibility([{ ...lone, customer_id: randomUUID() }], { knex: broken, now: NOW });
      expect(out.failed).toBe(true);
      expect(out.fits.get(lone.id)).toBe(false);
    });

    it('judges a visit in the ET year of its own date only: a December run reads a January 1 visit against the new year', async () => {
      const cust = randomUUID();
      for (const date of ['2026-03-03', '2026-04-04', '2026-05-05', '2026-06-06']) await application({ cust, property: propA, date }); // 2026 is used up
      const now = new Date('2026-12-28T15:00:00Z');
      const dec = { id: randomUUID(), customer_id: cust, property_id: propA, scheduled_date: '2026-12-30' };
      const jan1 = { id: randomUUID(), customer_id: cust, property_id: propA, scheduled_date: '2027-01-01' };
      const jan2 = { id: randomUUID(), customer_id: cust, property_id: propA, scheduled_date: '2027-01-02' };
      const { fits } = await project([dec, jan1, jan2], now);
      expect(fits.get(dec.id)).toBe(false); // 2026 has four
      expect(fits.get(jan1.id)).toBe(true); // 2027 has none
      expect(fits.get(jan2.id)).toBe(true);
    });

    it('charges a projected use to the new year only: three January visits in a row are all judged in 2027 and use it up one by one', async () => {
      const cust = randomUUID();
      for (let i = 0; i < 2; i += 1) await application({ cust, property: propA, date: '2027-01-02' }); // already 2 in 2027 (ledger rows may be future-dated in a test)
      const visits = ['2027-01-03', '2027-01-04', '2027-01-05'].map((scheduled_date) => ({ id: randomUUID(), customer_id: cust, property_id: propA, scheduled_date }));
      const { fits } = await project(visits, new Date('2026-12-28T15:00:00Z'));
      expect(visits.map((v) => fits.get(v.id))).toEqual([true, true, false]); // 2 + 2 = 4
    });

    it('two accounts at one property share the count: a use projected for one is charged to the other', async () => {
      const oldOwner = randomUUID();
      const newOwner = randomUUID();
      for (let i = 0; i < 3; i += 1) await application({ cust: oldOwner, property: propA });
      const first = { id: randomUUID(), customer_id: oldOwner, property_id: propA, scheduled_date: '2026-12-11' };
      const second = { id: randomUUID(), customer_id: newOwner, property_id: propA, scheduled_date: '2026-12-12' };
      const { fits } = await project([second, first]);
      expect(fits.get(first.id)).toBe(true); // the fourth application at the home
      expect(fits.get(second.id)).toBe(false); // the home has none left, whoever's account the visit is on
      // the one-visit count agrees about the new owner's visit once the first has happened
      expect((await count(newOwner, propA)).count).toBe(3);
    });

    it('a visit with no property charges the account-wide counter, and an account-wide count sees every property use', async () => {
      const cust = randomUUID();
      for (let i = 0; i < 2; i += 1) await application({ cust, property: propA });
      const a = { id: randomUUID(), customer_id: cust, property_id: null, scheduled_date: '2026-12-08' }; // no property: counts the whole account (2)
      const b = { id: randomUUID(), customer_id: cust, property_id: propA, scheduled_date: '2026-12-09' }; // sees a's use at propA
      const c = { id: randomUUID(), customer_id: cust, property_id: propB, scheduled_date: '2026-12-10' }; // propB: sees only the account-wide (no-property) use of a
      const d = { id: randomUUID(), customer_id: cust, property_id: null, scheduled_date: '2026-12-11' }; // account-wide again: 2 + a + b + c
      const { fits } = await project([d, c, b, a]);
      // a: 2 -> fits; b: 2 + a(no property counts for any home of the account) = 3 -> fits; c: propB has 0 + a = 1 -> fits;
      // d: account-wide 2 + a + b + c = 5 -> does not fit
      expect([a, b, c, d].map((v) => fits.get(v.id))).toEqual([true, true, true, false]);
    });
  });
});
