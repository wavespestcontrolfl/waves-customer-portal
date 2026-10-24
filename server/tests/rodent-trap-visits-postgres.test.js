/**
 * Real migrated PostgreSQL: the booking notice's trapping-visit lookup
 * (server/services/rodent-trap-visits.js). rodent-trap-visits.test.js pins
 * the query shape against a fake builder; this suite runs the actual SQL —
 * the to_char day text, the catalog and snapshot key match on both lines,
 * the status filter and the inclusive window — against the migrated schema,
 * inside a rolled-back transaction. The premise rule is injected:
 * trappingPremiseMatcher reads through the shared pool, which cannot see
 * this transaction's rows, and it has its own suites.
 */
const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;
const { randomUUID } = require('node:crypto');
const { recentTrappingVisits } = require('../services/rodent-trap-visits');

postgres('rodent trapping visits against migrated PostgreSQL', () => {
  let database;

  beforeAll(() => {
    const connection = process.env.DATABASE_URL;
    const url = new URL(connection);
    const localCI = ['localhost', '127.0.0.1'].includes(url.hostname);
    const ownedQA = process.env.WAVES_LOCAL_DEV === '1'
      && url.pathname === `/waves_qa_${String(process.env.WAVES_WORKTREE_ID || '').replaceAll('-', '')}`;
    if (!localCI && !ownedQA) throw new Error('Use a disposable local/CI database for this suite.');
    database = require('knex')({ client: 'pg', connection, pool: { min: 0, max: 2 } });
  });

  afterAll(async () => {
    await database?.destroy();
  });

  // The migrated catalog seeds the trapping rows; fall back to a synthetic
  // row only if a seed is ever renamed away.
  async function catalogId(trx, key) {
    const row = await trx('services').where({ service_key: key }).first('id');
    if (row) return row.id;
    const [created] = await trx('services').insert({ service_key: key, name: `Synthetic ${key}` }).returning('id');
    return created.id;
  }

  async function customer(trx) {
    const id = randomUUID();
    await trx('customers').insert({
      id, first_name: 'Synthetic', last_name: 'Tester',
      phone: `+1555${id.slice(0, 7)}`, address_line1: '100 Synthetic Ln',
      city: 'Bradenton', zip: '34201', active: true,
    });
    return id;
  }

  test('counts each active trapping appointment once, on either line, in the window up to the booking date', async () => {
    const trx = await database.transaction();
    try {
      const trapping = await catalogId(trx, 'rodent_trapping');
      const check = await catalogId(trx, 'rodent_trapping_followup');
      const extra = await catalogId(trx, 'rodent_trap_check_additional');
      const other = await catalogId(trx, `synthetic_notice_other_${randomUUID().slice(0, 8)}`);
      const customerId = await customer(trx);
      const otherCustomerId = await customer(trx);
      const secondPropertyId = randomUUID();
      await trx('customer_properties').insert({
        id: secondPropertyId, customer_id: customerId, address_line1: '200 Synthetic Ln',
        city: 'Bradenton', zip: '34201', is_primary: false,
      });

      const ids = {};
      const visit = async (name, fields) => {
        ids[name] = randomUUID();
        await trx('scheduled_services').insert({
          id: ids[name], customer_id: customerId, service_type: 'Synthetic visit', status: 'confirmed', ...fields,
        });
        return ids[name];
      };
      const addon = (scheduledServiceId, fields) => trx('scheduled_service_addons').insert({
        scheduled_service_id: scheduledServiceId, service_name: 'Synthetic add-on', ...fields,
      });

      // Booking date 2099-03-15 → window 2099-01-14 .. 2099-03-15, both ends inclusive.
      await visit('windowStart', { service_id: trapping, scheduled_date: '2099-01-14', status: 'completed' });
      await visit('beforeWindow', { service_id: trapping, scheduled_date: '2099-01-13', status: 'completed' });
      await visit('setup', { service_id: trapping, scheduled_date: '2099-02-20', status: 'completed' });
      // Trapping on the primary AND an add-on line: still one visit.
      await addon(await visit('check', { service_id: check, scheduled_date: '2099-03-01' }), { service_id: extra });
      await visit('cancelled', { service_id: check, scheduled_date: '2099-03-02', status: 'cancelled' });
      await visit('rescheduled', { service_id: check, scheduled_date: '2099-03-03', status: 'rescheduled' });
      await visit('skipped', { service_id: check, scheduled_date: '2099-03-04', status: 'skipped' });
      await visit('noShow', { service_id: check, scheduled_date: '2099-03-05', status: 'no_show' });
      // The paid extra check as an add-on on another service.
      await addon(await visit('extraAddon', { service_id: other, scheduled_date: '2099-03-08' }), { service_id: extra });
      await visit('otherProperty', { service_id: check, scheduled_date: '2099-03-09', property_id: secondPropertyId });
      // Lines whose catalog link is gone count through their snapshot.
      await visit('primarySnapshot', { service_id: null, service_key_snapshot: 'rodent_trapping_followup', scheduled_date: '2099-03-10' });
      await addon(await visit('addonSnapshot', { service_id: other, scheduled_date: '2099-03-11' }), { service_id: null, service_key_snapshot: 'rodent_trapping_followup' });
      await visit('noStatus', { service_id: check, scheduled_date: '2099-03-12', status: null });
      await visit('notTrapping', { service_id: other, scheduled_date: '2099-03-13' });
      await visit('bookingDay', { service_id: check, scheduled_date: '2099-03-15', status: 'pending' });
      await visit('afterBooking', { service_id: check, scheduled_date: '2099-03-16', status: 'pending' });
      await trx('scheduled_services').insert({
        id: randomUUID(), customer_id: otherCustomerId, service_id: trapping,
        service_type: 'Synthetic visit', scheduled_date: '2099-03-01', status: 'confirmed',
      });

      const out = await recentTrappingVisits(trx, customerId, {
        date: '2099-03-15',
        premiseMatcher: (row) => row.property_id !== secondPropertyId,
      });

      expect(out).toMatchObject({ windowDays: 60, since: '2099-01-14', through: '2099-03-15', count: 8 });
      expect(out.visits).toEqual([
        { id: ids.windowStart, date: '2099-01-14', serviceKey: 'rodent_trapping' },
        { id: ids.setup, date: '2099-02-20', serviceKey: 'rodent_trapping' },
        { id: ids.check, date: '2099-03-01', serviceKey: 'rodent_trapping_followup' },
        { id: ids.extraAddon, date: '2099-03-08', serviceKey: 'rodent_trap_check_additional' },
        { id: ids.primarySnapshot, date: '2099-03-10', serviceKey: 'rodent_trapping_followup' },
        { id: ids.addonSnapshot, date: '2099-03-11', serviceKey: 'rodent_trapping_followup' },
        { id: ids.noStatus, date: '2099-03-12', serviceKey: 'rodent_trapping_followup' },
        { id: ids.bookingDay, date: '2099-03-15', serviceKey: 'rodent_trapping_followup' },
      ]);
    } finally {
      await trx.rollback();
    }
  }, 30000);

  test('an exclusion-and-trapping setup plus one trap check is two visits', async () => {
    const trx = await database.transaction();
    try {
      const exclusion = await catalogId(trx, 'rodent_exclusion');
      const check = await catalogId(trx, 'rodent_trapping_followup');
      const customerId = await customer(trx);
      const setupId = randomUUID();
      const checkId = randomUUID();
      await trx('scheduled_services').insert([
        { id: setupId, customer_id: customerId, service_id: exclusion, service_type: 'Synthetic visit', scheduled_date: '2099-03-01', status: 'completed' },
        { id: checkId, customer_id: customerId, service_id: check, service_type: 'Synthetic visit', scheduled_date: '2099-03-08', status: 'completed' },
      ]);

      const out = await recentTrappingVisits(trx, customerId, { date: '2099-03-15', premiseMatcher: () => true });

      expect(out.visits).toEqual([
        { id: setupId, date: '2099-03-01', serviceKey: 'rodent_exclusion' },
        { id: checkId, date: '2099-03-08', serviceKey: 'rodent_trapping_followup' },
      ]);
    } finally {
      await trx.rollback();
    }
  }, 30000);
});
