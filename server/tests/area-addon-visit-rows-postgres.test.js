/**
 * Several area add-ons are one visit, against REAL Postgres (owner ruling
 * 2026-10-08). The accept's hold graduation writes one structured
 * `scheduled_service_addons` row per sold add-on the appointment is not itself
 * stamped with, in the booking transaction. A mocked knex proves none of the
 * foreign keys, the column set or the invoice arithmetic, so this suite drives
 * the real functions against the migrated catalog (migration 20261008200000
 * seeds the six `area_addon_*` services) inside a transaction that is always
 * rolled back.
 *
 * Runs in the existing DB-gated CI step (DATABASE_URL on disposable localhost
 * waves_test) or this worktree's private QA database. It cannot run without one.
 */
const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;

let mockPg;
jest.mock('../models/db', () => new Proxy((...args) => mockPg(...args), {
  get: (_, key) => (typeof mockPg[key] === 'function' ? mockPg[key].bind(mockPg) : mockPg[key]),
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../config/feature-gates', () => ({
  ...jest.requireActual('../config/feature-gates'),
  isEnabled: jest.fn(() => false),
  gateEnvValue: jest.fn(() => false),
  gates: {},
}));
// The profile the accept resolves for a one-time estimate carrying three area
// add-ons (estimate-slot-availability.js oneTimeProfileServices emits these rows;
// area-addon-visit.test.js proves that half). The web sweep is the pest-control
// family, so it is the visit's own stamp.
const mockProfile = () => ({
  serviceMode: 'one_time',
  durationMinutes: 90,
  serviceLabel: 'Web Sweep + Bed Pre-Emergent Weed Control + Fire Ant Yard Treatment',
  services: [
    { service: 'lawn_care', label: 'Bed Pre-Emergent Weed Control', engineKey: 'area_addon', catalogServiceKey: 'area_addon_bed_pre_emergent', durationMinutes: 30, addOnPrice: 139, addOnKey: 'bed_pre_emergent', areaSqFt: 1450, tierSqFt: 2000 },
    { service: 'pest_control', label: 'Web Sweep', engineKey: 'area_addon', catalogServiceKey: 'area_addon_web_sweep', durationMinutes: 25, addOnPrice: 59, addOnKey: 'web_sweep' },
    { service: 'lawn_care', label: 'Fire Ant Yard Treatment', engineKey: 'area_addon', catalogServiceKey: 'area_addon_fire_ant_yard', durationMinutes: 26, addOnPrice: 69, addOnKey: 'fire_ant_yard', areaSqFt: 4200, tierSqFt: 5000 },
  ],
});
jest.mock('../services/estimate-slot-availability', () => ({
  invalidateEstimate: jest.fn(),
  async resolveCatalogSlotProfile() { return mockProfile(); },
  resolveEstimateSlotProfile: jest.fn(() => mockProfile()),
  SLOT_DAY_START_MINUTES: 8 * 60,
  SLOT_DAY_END_MINUTES: 17 * 60,
  MAX_SLOT_HORIZON_DAYS: 90,
}));

const knex = require('knex');
const { randomUUID } = require('node:crypto');
const { addETDays, etDateString } = require('../utils/datetime-et');

jest.setTimeout(120000);

const TOTAL = 139 + 59 + 69;

postgres('area add-ons on the booked visit (real Postgres)', () => {
  let slotReservation;
  beforeAll(() => {
    const url = new URL(process.env.DATABASE_URL);
    const local = ['localhost', '127.0.0.1'].includes(url.hostname);
    const ownedQA = process.env.WAVES_LOCAL_DEV === '1'
      && url.pathname === `/waves_qa_${String(process.env.WAVES_WORKTREE_ID || '').replaceAll('-', '')}`;
    if (!local && !ownedQA) throw new Error('Use disposable CI or this worktree\'s private QA database');
    mockPg = knex({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 3 } });
    slotReservation = require('../services/slot-reservation');
  });
  afterAll(async () => { await mockPg.destroy(); });

  async function bookableDate(conn) {
    const { isBlackoutDate } = require('../services/scheduling/blackout-dates');
    let d = addETDays(new Date(), 14);
    for (let i = 0; i < 30; i += 1) {
      const dateStr = etDateString(d);
      if (!await isBlackoutDate(dateStr, conn)) return dateStr;
      d = addETDays(d, 1);
    }
    throw new Error('no bookable date within 30 days of the fixture anchor');
  }

  // One estimate + one live hold row inside a rolled-back transaction.
  async function withHold(run) {
    const pool = mockPg;
    const trx = await pool.transaction();
    mockPg = trx;
    try {
      const estimateId = randomUUID();
      const holdId = randomUUID();
      const customerId = randomUUID();
      const date = await bookableDate(trx);
      await trx('customers').insert({
        id: customerId, first_name: 'Synthetic', last_name: 'AddOn',
        email: `${customerId}@example.invalid`, phone: '+19415550112', active: true,
      });
      await trx('estimates').insert({
        id: estimateId, token: randomUUID().replace(/-/g, ''), status: 'sent',
        customer_name: 'Synthetic AddOn', address: '1 Test Way, Parrish, FL 34219',
        service_interest: 'One-time service', expires_at: trx.raw("NOW() + INTERVAL '7 days'"),
        estimate_data: JSON.stringify({ result: { oneTime: { total: TOTAL, items: [] } } }),
      });
      await trx('scheduled_services').insert({
        id: holdId, source_estimate_id: estimateId, customer_id: null,
        scheduled_date: date, window_start: '13:00:00', window_end: '14:30:00',
        estimated_duration_minutes: 90, service_type: 'Web Sweep', status: 'pending',
        reservation_expires_at: trx.raw("NOW() + INTERVAL '15 minutes'"),
      });
      await run({ trx, estimateId, holdId, customerId });
    } finally {
      await trx.rollback().catch(() => {});
      mockPg = pool;
    }
  }

  const addons = (trx, id) => trx('scheduled_service_addons').where({ scheduled_service_id: id }).orderBy('created_at').orderBy('id');
  const commit = (trx, holdId, customerId) => slotReservation.commitReservation({
    scheduledServiceId: holdId, customerId, estimatedPrice: TOTAL, serviceMode: 'one_time', trx,
  });

  test('accepting stamps the web sweep and writes the other two add-ons as rows on the same appointment', async () => {
    await withHold(async ({ trx, holdId, customerId }) => {
      expect(await addons(trx, holdId)).toEqual([]);
      const visit = await commit(trx, holdId, customerId);
      expect(visit.service_key_snapshot).toBe('area_addon_web_sweep');
      expect(Number(visit.estimated_price)).toBe(TOTAL);
      expect(visit.estimated_duration_minutes).toBe(90);
      const rows = await addons(trx, holdId);
      expect(rows.map((r) => [r.service_key_snapshot, Number(r.estimated_price), Number(r.base_price), r.estimated_duration_minutes, r.service_category_snapshot, r.recurring_pattern]))
        .toEqual([['area_addon_bed_pre_emergent', 139, 139, 30, 'lawn_care', 'one_time'], ['area_addon_fire_ant_yard', 69, 69, 26, 'lawn_care', 'one_time']]);
      const catalog = await trx('services').whereIn('service_key', rows.map((r) => r.service_key_snapshot)).select('id', 'service_key', 'name');
      for (const row of rows) {
        const cat = catalog.find((c) => c.service_key === row.service_key_snapshot);
        expect([row.service_id, row.service_name]).toEqual([cat.id, cat.name]);
      }
    });
  });

  test('exactly once: a replayed accept returns the booked visit and writes nothing more', async () => {
    await withHold(async ({ trx, holdId, customerId }) => {
      await commit(trx, holdId, customerId);
      await commit(trx, holdId, customerId);
      await commit(trx, holdId, customerId);
      expect(await addons(trx, holdId)).toHaveLength(2);
    });
  });

  test('a released hold leaves no add-on rows (rows are written at graduation, never on the hold)', async () => {
    await withHold(async ({ trx, estimateId, holdId }) => {
      expect(await slotReservation.releaseReservation({ scheduledServiceId: holdId, estimateId })).toEqual({ released: true });
      expect(await trx('scheduled_services').where({ id: holdId }).first('id')).toBeUndefined();
      expect(await addons(trx, holdId)).toEqual([]);
    });
  });

  test('an expired hold is refused and writes no rows', async () => {
    await withHold(async ({ trx, holdId, customerId }) => {
      await trx('scheduled_services').where({ id: holdId }).update({ reservation_expires_at: trx.raw("NOW() - INTERVAL '2 hours'") });
      await expect(commit(trx, holdId, customerId)).rejects.toMatchObject({ code: 'RESERVATION_EXPIRED' });
      expect(await addons(trx, holdId)).toEqual([]);
    });
  });

  test('the completion invoice lines equal the one-time total: the stamped service is the total less the add-on rows, nothing twice', async () => {
    await withHold(async ({ trx, holdId, customerId }) => {
      await commit(trx, holdId, customerId);
      const InvoiceService = require('../services/invoice');
      const { lineItems } = await InvoiceService.buildLineItemsForScheduledService(holdId, { fallbackAmount: TOTAL, fallbackDescription: 'Web Sweep', database: trx, strictReads: true });
      const money = (n) => Math.round(Number(n) * 100) / 100;
      expect(money(lineItems.reduce((sum, l) => sum + Number(l.amount), 0))).toBe(TOTAL);
      expect(lineItems.map((l) => money(l.amount)).sort((a, b) => a - b)).toEqual([59, 69, 139]);
      expect(lineItems.some((l) => l._kind === 'discount')).toBe(false);
    });
  });

  test('closeout: the visit stamped with the web sweep needs the L&O license because its add-on rows are chemical', async () => {
    await withHold(async ({ trx, holdId, customerId }) => {
      const visit = await commit(trx, holdId, customerId);
      const { resolveCloseoutRequirementsForJobs } = require('../services/service-closeout-requirements');
      const map = await resolveCloseoutRequirementsForJobs([{ id: visit.id, service_id: visit.service_id, service_type: visit.service_type }], { knex: trx, strict: true });
      expect(map.get(visit.id)).toMatchObject({ requiresLicense: true, licenseCategory: 'L&O', requiresApplicationLog: true });
      // The web sweep alone is labor only: without its add-on rows the same visit reads "no license".
      await trx('scheduled_service_addons').where({ scheduled_service_id: visit.id }).del();
      const alone = await resolveCloseoutRequirementsForJobs([{ id: visit.id, service_id: visit.service_id, service_type: visit.service_type }], { knex: trx, strict: true });
      expect(alone.get(visit.id).requiresLicense).toBe(false);
    });
  });

  test('the job card lists every add-on of the visit (loadAddons reads the rows the accept wrote)', async () => {
    await withHold(async ({ trx, holdId, customerId }) => {
      await commit(trx, holdId, customerId);
      const lines = await require('../services/job-card')._test.loadAddons(trx, holdId);
      expect(lines.map((l) => l.serviceKey).sort()).toEqual(['area_addon_bed_pre_emergent', 'area_addon_fire_ant_yard']);
    });
  });

  test('the sold scope is stored on the appointment (the web sweep) and on each add-on row, and the readers see it', async () => {
    await withHold(async ({ trx, holdId, customerId }) => {
      const visit = await commit(trx, holdId, customerId);
      const own = await trx('scheduled_services').where({ id: holdId }).first('area_addon_scope');
      expect(own.area_addon_scope).toEqual({ v: 1, addOnKey: 'web_sweep', catalogServiceKey: 'area_addon_web_sweep', areaSqFt: null, tierSqFt: null, grassType: null });
      const rows = await addons(trx, holdId);
      expect(rows.map((r) => r.area_addon_scope)).toEqual([
        { v: 1, addOnKey: 'bed_pre_emergent', catalogServiceKey: 'area_addon_bed_pre_emergent', areaSqFt: 1450, tierSqFt: 2000, grassType: null },
        { v: 1, addOnKey: 'fire_ant_yard', catalogServiceKey: 'area_addon_fire_ant_yard', areaSqFt: 4200, tierSqFt: 5000, grassType: null },
      ]);
      const lines = await require('../services/job-card')._test.loadAddons(trx, holdId);
      expect(lines.map((l) => l.areaAddOnScope.tierSqFt)).toEqual([2000, 5000]);
      const keyed = await require('../services/area-addon-visit-rows').areaAddOnKeysByVisit(trx, [visit.id, 'combo']);
      expect(keyed.get(visit.id).sort()).toEqual(['area_addon_bed_pre_emergent', 'area_addon_fire_ant_yard']);
    });
  });
});
