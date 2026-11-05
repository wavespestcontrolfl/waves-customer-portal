/**
 * The Multi-Home Discount on every home of a family, against the real migrated schema (skipped without
 * DATABASE_URL; CI runs it). Every test runs inside ONE outer transaction that is rolled back at the end, so a shared
 * test database never keeps a row. The real services, the real admin-schedule "This and following" helpers and the
 * real discount catalog row run; only the bell (notification-service) is faked. Synthetic names and addresses only.
 */
const { randomUUID } = require('node:crypto');
const knex = require('knex');

const SKIP = !process.env.DATABASE_URL;
const maybeDescribe = SKIP ? describe.skip : describe;
jest.setTimeout(120000);

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
process.env.GATE_MULTI_HOME_ALL_HOMES = 'true';
process.env.GATE_EDIT_APPT_PRICE_SERVICE_SCOPE = 'true';

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/notification-service', () => ({
  notifyAdmin: jest.fn(async () => ({ id: 'bell' })),
  NotificationService: {},
}));

const notification = require('../services/notification-service');
const featureGates = require('../config/feature-gates');

const NOW = new Date('2026-11-06T15:00:00Z');
const ACCEPTED_AT = new Date('2026-11-05T15:00:00Z');

class Rollback extends Error {}

maybeDescribe('Multi-Home Discount on every home (real schema, rolled back)', () => {
  let conn;
  let apply;

  beforeAll(() => {
    conn = knex({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 1, max: 1 } });
    apply = require('../services/multi-home-discount-apply');
  });
  afterAll(async () => {
    if (conn) await conn.destroy();
    // The services load the shared pool (models/db); close it so jest can exit.
    await require('../models/db').destroy();
  });
  beforeEach(() => { notification.notifyAdmin.mockClear(); });
  afterEach(() => { jest.restoreAllMocks(); delete process.env.GATE_DISCOUNT_STACKING; });

  async function inRollback(fn) {
    try {
      await conn.transaction(async (trx) => {
        await fn(trx);
        throw new Rollback();
      });
    } catch (err) {
      if (!(err instanceof Rollback)) throw err;
    }
  }

  let n = 0;
  async function customer(trx, extra = {}) {
    n += 1;
    const id = randomUUID();
    await trx('customers').insert({
      id, first_name: 'Sample', last_name: `Example${n}`, phone: `+1941555${String(4000 + n)}`,
      address_line1: `${200 + n} Example Loop`, city: 'Sarasota', state: 'FL', zip: '34231',
      pipeline_stage: 'new_lead', active: true, billing_mode: 'per_application', per_application_fee: 117, ...extra,
    });
    return id;
  }
  async function property(trx, customerId, extra = {}) {
    n += 1;
    const id = randomUUID();
    await trx('customer_properties').insert({
      id, customer_id: customerId, address_line1: `${300 + n} Sample Court`, city: 'Sarasota', state: 'FL', zip: '34231',
      is_primary: true, active: true, ...extra,
    });
    return id;
  }
  async function link(trx, a, b) {
    const familyId = randomUUID();
    await trx('multi_home_family_members').insert([{ customer_id: a, family_id: familyId }, { customer_id: b, family_id: familyId }]);
  }
  async function estimate(trx, customerId, propertyId, md = { presetKey: 'multi_home', type: 'PERCENT', value: 10, recurringAmount: 40, amount: 40 }) {
    const id = randomUUID();
    await trx('estimates').insert({
      id, customer_id: customerId, property_id: propertyId, status: 'accepted', accepted_at: ACCEPTED_AT, token: randomUUID().replace(/-/g, ''),
      estimate_data: JSON.stringify(md ? { summary: { manualDiscount: md } } : {}),
    });
    return id;
  }
  // A quarterly pest series: one completed root plus `dates.length` upcoming children, all flat at `price`.
  async function series(trx, { customerId, propertyId, price = 117, dates = ['2026-11-14', '2027-02-13', '2027-05-15'], sourceEstimateId = null, rootExtra = {}, childExtra = {} }) {
    const rootId = randomUUID();
    const base = {
      customer_id: customerId, property_id: propertyId, service_type: 'Quarterly Pest Control Service', is_recurring: true,
      recurring_pattern: 'quarterly', service_category_snapshot: 'pest_control', service_key_snapshot: 'pest_general_quarterly',
      estimated_price: price, source_estimate_id: sourceEstimateId,
    };
    await trx('scheduled_services').insert({ id: rootId, ...base, scheduled_date: '2026-08-15', status: 'completed', ...rootExtra });
    const ids = [];
    for (const date of dates) {
      const id = randomUUID();
      await trx('scheduled_services').insert({ id, ...base, recurring_parent_id: rootId, scheduled_date: date, status: 'pending', ...childExtra });
      ids.push(id);
    }
    return { rootId, ids };
  }

  // The parents' home (target) and the son's home (source), linked as one family.
  async function family(trx) {
    const parents = await customer(trx);
    const parentsHome = await property(trx, parents);
    const son = await customer(trx);
    const sonHome = await property(trx, son);
    await link(trx, parents, son);
    const estimateId = await estimate(trx, son, sonHome);
    const sonSeries = await series(trx, { customerId: son, propertyId: sonHome, price: 90, sourceEstimateId: estimateId });
    const parentSeries = await series(trx, { customerId: parents, propertyId: parentsHome });
    return { parents, parentsHome, son, sonHome, estimateId, sonSeries, parentSeries };
  }

  const visitRows = (trx, ids) => trx('scheduled_services').whereIn('id', ids).orderBy('scheduled_date').select('estimated_price', 'primary_line_price', 'discount_id', 'discount_name', 'discount_type', 'discount_amount', 'discount_dollars');
  const ledger = (trx, estimateId) => trx('multi_home_discount_applications').where({ source_estimate_id: estimateId }).select('*');

  test.each([['stacking off', undefined], ['stacking on', 'true']])('puts the discount on the other family home from its next visit (%s)', async (_label, stacking) => {
    if (stacking) process.env.GATE_DISCOUNT_STACKING = stacking;
    await inRollback(async (trx) => {
      const f = await family(trx);
      const preset = await trx('discounts').where({ discount_key: 'multi_home' }).first();
      expect(preset).toBeTruthy();

      const out = await apply.runMultiHomeAllHomes({ now: NOW, dbh: trx });
      expect(out).toMatchObject({ ok: true, sources: 1, targets: 1, applied: 1, held: 0 });

      const rows = await visitRows(trx, f.parentSeries.ids);
      expect(rows).toHaveLength(3);
      for (const r of rows) {
        expect(Number(r.estimated_price)).toBe(105.3);
        expect(Number(r.primary_line_price)).toBe(117);
        expect(Number(r.discount_dollars)).toBe(11.7);
        expect(r.discount_id).toBe(preset.id);
        expect(r.discount_type).toBe('percentage');
        expect(Number(r.discount_amount)).toBe(10);
      }
      // The series parent's template is stamped so auto-extended visits spawn with the discount.
      const root = await trx('scheduled_services').where({ id: f.parentSeries.rootId }).first('recurring_template_overrides', 'estimated_price', 'discount_id');
      expect(root.recurring_template_overrides).toMatchObject({ discount_id: preset.id, primary_line_price: 117, estimated_price: 105.3 });
      // The completed root visit's own record is untouched.
      expect(Number(root.estimated_price)).toBe(117);
      expect(root.discount_id).toBeNull();
      // The source home's own series is never touched.
      const sourceRows = await visitRows(trx, f.sonSeries.ids);
      expect(sourceRows.every((r) => Number(r.estimated_price) === 90 && r.discount_id === null)).toBe(true);

      const [row] = await ledger(trx, f.estimateId);
      expect(row).toMatchObject({ status: 'applied', series_root_id: f.parentSeries.rootId, target_customer_id: f.parents, source_customer_id: f.son, hold_reason: null });
      expect(row.first_visit_id).toBe(f.parentSeries.ids[0]);
      expect(String(row.first_visit_date.toISOString ? row.first_visit_date.toISOString().slice(0, 10) : row.first_visit_date)).toMatch(/^2026-11-1[345]/);
      expect([Number(row.price_before), Number(row.price_after)]).toEqual([117, 105.3]);
      expect(row.applied_at).toBeTruthy();

      const audits = await trx('audit_log').where({ action: 'customer.multi_home_discount_applied', resource_id: f.parents });
      expect(audits).toHaveLength(1);
      expect(notification.notifyAdmin).not.toHaveBeenCalled();
      // Rate and fee scalars do not move.
      const parentRow = await trx('customers').where({ id: f.parents }).first('per_application_fee');
      expect(Number(parentRow.per_application_fee)).toBe(117);
    });
  });

  test.each([['stacking off', undefined], ['stacking on', 'true']])('the next auto-extended visit is priced by production at the discounted price (%s)', async (_label, stacking) => {
    if (stacking) process.env.GATE_DISCOUNT_STACKING = stacking;
    await inRollback(async (trx) => {
      const f = await family(trx);
      const production = require('../routes/admin-schedule');
      expect((await production.seriesNextOccurrencesPrice(trx, f.parentSeries.rootId)).price).toBe(117);
      await apply.runMultiHomeAllHomes({ now: NOW, dbh: trx });
      const next = await production.seriesNextOccurrencesPrice(trx, f.parentSeries.rootId);
      expect(next).toMatchObject({ unverified: false, price: 105.3 });
    });
  });

  test('an estimate whose stored discount names the preset by catalog id only is found and applied', async () => {
    await inRollback(async (trx) => {
      const f = await family(trx);
      const preset = await trx('discounts').where({ discount_key: 'multi_home' }).first();
      await trx('estimates').where({ id: f.estimateId }).update({
        estimate_data: JSON.stringify({ summary: { manualDiscount: { presetId: preset.id, type: 'PERCENT', value: 10, recurringAmount: 40, amount: 40 } } }),
      });
      expect((await trx('estimates').where({ id: f.estimateId }).first('estimate_data')).estimate_data.summary.manualDiscount.presetKey).toBeUndefined();
      const out = await apply.runMultiHomeAllHomes({ now: NOW, dbh: trx });
      expect(out).toMatchObject({ sources: 1, applied: 1 });
      expect((await visitRows(trx, f.parentSeries.ids)).every((r) => Number(r.estimated_price) === 105.3)).toBe(true);
    });
  });

  test('a second run changes nothing (an applied row is never applied twice)', async () => {
    await inRollback(async (trx) => {
      const f = await family(trx);
      await apply.runMultiHomeAllHomes({ now: NOW, dbh: trx });
      const second = await apply.runMultiHomeAllHomes({ now: NOW, dbh: trx });
      expect(second).toMatchObject({ applied: 0, held: 0, targets: 0 });
      const rows = await visitRows(trx, f.parentSeries.ids);
      expect(rows.every((r) => Number(r.estimated_price) === 105.3)).toBe(true);
      expect(await ledger(trx, f.estimateId)).toHaveLength(1);
      expect(await trx('audit_log').where({ action: 'customer.multi_home_discount_applied' })).toHaveLength(1);
    });
  });

  test('only visits from today on are discounted; earlier ones keep their price', async () => {
    await inRollback(async (trx) => {
      const f = await family(trx);
      const earlier = randomUUID();
      await trx('scheduled_services').insert({
        id: earlier, customer_id: f.parents, property_id: f.parentsHome, service_type: 'Quarterly Pest Control Service', is_recurring: true,
        recurring_parent_id: f.parentSeries.rootId, scheduled_date: '2026-11-01', status: 'pending', estimated_price: 117,
        service_category_snapshot: 'pest_control', service_key_snapshot: 'pest_general_quarterly',
      });
      await apply.runMultiHomeAllHomes({ now: NOW, dbh: trx });
      const [past] = await visitRows(trx, [earlier]);
      expect(Number(past.estimated_price)).toBe(117);
      expect(past.discount_id).toBeNull();
    });
  });

  test('a second property on the SAME profile gets it; a plan at the source home does not', async () => {
    await inRollback(async (trx) => {
      const son = await customer(trx);
      const home1 = await property(trx, son);
      const home2 = await property(trx, son, { is_primary: false });
      await trx('customers').where({ id: son }).update({ has_multi_home: true });
      const estimateId = await estimate(trx, son, home1);
      const own = await series(trx, { customerId: son, propertyId: home1, price: 90, sourceEstimateId: estimateId });
      const sameHomeOther = await series(trx, { customerId: son, propertyId: home1, price: 60 });
      const otherHome = await series(trx, { customerId: son, propertyId: home2, price: 117 });
      const out = await apply.runMultiHomeAllHomes({ now: NOW, dbh: trx });
      expect(out).toMatchObject({ targets: 1, applied: 1 });
      expect((await visitRows(trx, otherHome.ids)).every((r) => Number(r.estimated_price) === 105.3)).toBe(true);
      expect((await visitRows(trx, sameHomeOther.ids)).every((r) => Number(r.estimated_price) === 60)).toBe(true);
      expect((await visitRows(trx, own.ids)).every((r) => Number(r.estimated_price) === 90)).toBe(true);
    });
  });

  test('a same-profile series moved to the source\'s own house after selection is dropped, unpriced', async () => {
    await inRollback(async (trx) => {
      const son = await customer(trx);
      const home1 = await property(trx, son);
      const home2 = await property(trx, son, { is_primary: false });
      await trx('customers').where({ id: son }).update({ has_multi_home: true });
      const estimateId = await estimate(trx, son, home1);
      const own = await series(trx, { customerId: son, propertyId: home1, price: 90, sourceEstimateId: estimateId });
      const otherHome = await series(trx, { customerId: son, propertyId: home2, price: 117 });
      const source = { estimateId, customerId: son, propertyId: home1, roots: new Set([own.rootId]) };
      const target = { customerId: son, rootId: otherHome.rootId, propertyId: home2, line: 'pest_control', cadence: 'quarterly', serviceType: 'Quarterly Pest Control Service' };
      // After target selection, staff move that series to the source's own house.
      await trx('scheduled_services').whereIn('id', otherHome.ids).update({ property_id: home1 });
      expect(await apply.applyTargetSeries(source, target, { now: NOW, dbh: trx })).toEqual({ skipped: true, dropped: true });
      expect((await visitRows(trx, otherHome.ids)).every((r) => Number(r.estimated_price) === 117 && r.discount_id === null)).toBe(true);
      expect(await ledger(trx, estimateId)).toHaveLength(0);
    });
  });

  test('a source revised to drop the discount after selection hands its targets nothing', async () => {
    await inRollback(async (trx) => {
      const son = await customer(trx);
      const home1 = await property(trx, son);
      const home2 = await property(trx, son, { is_primary: false });
      await trx('customers').where({ id: son }).update({ has_multi_home: true });
      const estimateId = await estimate(trx, son, home1);
      const own = await series(trx, { customerId: son, propertyId: home1, price: 90, sourceEstimateId: estimateId });
      const otherHome = await series(trx, { customerId: son, propertyId: home2, price: 117 });
      const source = { estimateId, customerId: son, propertyId: home1, roots: new Set([own.rootId]) };
      const target = { customerId: son, rootId: otherHome.rootId, propertyId: home2, line: 'pest_control', cadence: 'quarterly', serviceType: 'Quarterly Pest Control Service' };
      // After selection, a revise removes the Multi-Home Discount from the accepted estimate.
      await trx('estimates').where({ id: estimateId }).update({ estimate_data: trx.raw("'{}'::jsonb") });
      expect(await apply.applyTargetSeries(source, target, { now: NOW, dbh: trx })).toEqual({ skipped: true, dropped: true });
      expect((await visitRows(trx, otherHome.ids)).every((r) => Number(r.estimated_price) === 117 && r.discount_id === null)).toBe(true);
    });
  });

  test('no source without the Same family link or the multi-home flag', async () => {
    await inRollback(async (trx) => {
      const parents = await customer(trx);
      const parentsHome = await property(trx, parents);
      const son = await customer(trx);
      const sonHome = await property(trx, son);
      await estimate(trx, son, sonHome).then((id) => series(trx, { customerId: son, propertyId: sonHome, sourceEstimateId: id }));
      const target = await series(trx, { customerId: parents, propertyId: parentsHome });
      const out = await apply.runMultiHomeAllHomes({ now: NOW, dbh: trx });
      expect(out).toMatchObject({ sources: 0, applied: 0 });
      expect((await visitRows(trx, target.ids)).every((r) => Number(r.estimated_price) === 117)).toBe(true);
    });
  });

  test('an estimate older than 14 days, or without the preset, is not a source', async () => {
    await inRollback(async (trx) => {
      const f = await family(trx);
      await trx('estimates').where({ id: f.estimateId }).update({ accepted_at: new Date('2026-10-01T15:00:00Z') });
      expect(await apply.runMultiHomeAllHomes({ now: NOW, dbh: trx })).toMatchObject({ sources: 0 });
      await trx('estimates').where({ id: f.estimateId }).update({
        accepted_at: ACCEPTED_AT, estimate_data: JSON.stringify({ summary: { manualDiscount: { presetKey: 'military', type: 'PERCENT', value: 5, recurringAmount: 20 } } }),
      });
      expect(await apply.runMultiHomeAllHomes({ now: NOW, dbh: trx })).toMatchObject({ sources: 0 });
    });
  });

  describe('holds', () => {
    async function heldReason(trx, f) {
      const [row] = await ledger(trx, f.estimateId);
      return row;
    }
    function expectBell(reasonCode, f) {
      expect(notification.notifyAdmin).toHaveBeenCalledWith(
        'billing', expect.stringContaining('Billing'), expect.any(String),
        expect.objectContaining({ dedupeKey: `multi-home-discount-hold:${f.estimateId}:${f.parentSeries.rootId}:${reasonCode}` }),
      );
    }

    test('a monthly membership holds, rings one bell, changes nothing and retries', async () => {
      await inRollback(async (trx) => {
        const f = await family(trx);
        await trx('customers').where({ id: f.parents }).update({ billing_mode: 'monthly_membership', monthly_rate: 49, waveguard_tier: 'Gold' });
        const out = await apply.runMultiHomeAllHomes({ now: NOW, dbh: trx });
        expect(out).toMatchObject({ applied: 0, held: 1 });
        expect(out.holds[0].reason).toBe('lane_monthly_membership');
        const row = await heldReason(trx, f);
        expect(row).toMatchObject({ status: 'held', hold_reason: 'lane_monthly_membership', attempts: 1 });
        expectBell('lane_monthly_membership', f);
        expect((await visitRows(trx, f.parentSeries.ids)).every((r) => Number(r.estimated_price) === 117 && r.discount_id === null)).toBe(true);
        await apply.runMultiHomeAllHomes({ now: NOW, dbh: trx });
        expect((await heldReason(trx, f)).attempts).toBe(2);
        // Staff fix the lane; the next run applies it and the row turns applied.
        await trx('customers').where({ id: f.parents }).update({ billing_mode: 'per_application' });
        expect(await apply.runMultiHomeAllHomes({ now: NOW, dbh: trx })).toMatchObject({ applied: 1 });
        expect((await heldReason(trx, f)).status).toBe('applied');
      });
    });

    test('a visit that already has a discount holds', async () => {
      await inRollback(async (trx) => {
        const f = await family(trx);
        await trx('scheduled_services').where({ id: f.parentSeries.ids[1] }).update({ discount_type: 'percentage', discount_amount: 5, discount_dollars: 5.85, estimated_price: 111.15 });
        await apply.runMultiHomeAllHomes({ now: NOW, dbh: trx });
        expect((await heldReason(trx, f)).hold_reason).toBe('visit_already_discounted');
        expectBell('visit_already_discounted', f);
      });
    });

    test('an add-on line holds', async () => {
      await inRollback(async (trx) => {
        const f = await family(trx);
        await trx('scheduled_service_addons').insert({ scheduled_service_id: f.parentSeries.ids[0], service_name: 'Gutter cleaning', estimated_price: 20 });
        await apply.runMultiHomeAllHomes({ now: NOW, dbh: trx });
        expect((await heldReason(trx, f)).hold_reason).toBe('visit_has_addons');
        expect((await visitRows(trx, f.parentSeries.ids)).every((r) => r.discount_id === null)).toBe(true);
      });
    });

    test('prepaid money on a visit holds', async () => {
      await inRollback(async (trx) => {
        const f = await family(trx);
        await trx('scheduled_services').where({ id: f.parentSeries.ids[0] }).update({ prepaid_amount: 117 });
        await apply.runMultiHomeAllHomes({ now: NOW, dbh: trx });
        expect((await heldReason(trx, f)).hold_reason).toBe('visit_prepaid');
      });
    });

    test('a live invoice on an upcoming visit holds', async () => {
      await inRollback(async (trx) => {
        const f = await family(trx);
        await trx('invoices').insert({
          token: randomUUID().replace(/-/g, ''), invoice_number: `MH-${Date.now()}`, customer_id: f.parents, total: 117, status: 'sent',
          scheduled_service_id: f.parentSeries.ids[0],
        });
        await apply.runMultiHomeAllHomes({ now: NOW, dbh: trx });
        expect((await heldReason(trx, f)).hold_reason).toBe('live_invoice');
        expect((await visitRows(trx, f.parentSeries.ids)).every((r) => r.discount_id === null)).toBe(true);
      });
    });

    test('a plan on hold holds', async () => {
      await inRollback(async (trx) => {
        const f = await family(trx);
        await trx('plan_holds').insert({ customer_id: f.parents, family_key: 'pest_control', starts_on: '2026-11-01', resume_on: '2027-01-15', status: 'active' });
        await apply.runMultiHomeAllHomes({ now: NOW, dbh: trx });
        expect((await heldReason(trx, f)).hold_reason).toBe('plan_on_hold');
      });
    });

    test('mixed prices across the series hold', async () => {
      await inRollback(async (trx) => {
        const f = await family(trx);
        await trx('scheduled_services').where({ id: f.parentSeries.ids[2] }).update({ estimated_price: 120 });
        await apply.runMultiHomeAllHomes({ now: NOW, dbh: trx });
        expect((await heldReason(trx, f)).hold_reason).toBe('visit_prices_differ');
      });
    });

    test('a prepaid-year plan holds', async () => {
      await inRollback(async (trx) => {
        const f = await family(trx);
        await trx('customers').where({ id: f.parents }).update({ billing_mode: 'annual_prepay' });
        await apply.runMultiHomeAllHomes({ now: NOW, dbh: trx });
        expect((await heldReason(trx, f)).hold_reason).toBe('lane_annual_prepay');
        expect((await visitRows(trx, f.parentSeries.ids)).every((r) => r.discount_id === null)).toBe(true);
      });
    });

    test('a profile that fails the catalog rules holds', async () => {
      await inRollback(async (trx) => {
        const f = await family(trx);
        await trx('discounts').where({ discount_key: 'multi_home' }).update({ min_subtotal: 500 });
        await apply.runMultiHomeAllHomes({ now: NOW, dbh: trx });
        expect((await heldReason(trx, f)).hold_reason).toBe('discount_not_eligible');
      });
    });

    test('the discount switched off in the catalog holds', async () => {
      await inRollback(async (trx) => {
        const f = await family(trx);
        await trx('discounts').where({ discount_key: 'multi_home' }).update({ is_active: false });
        await apply.runMultiHomeAllHomes({ now: NOW, dbh: trx });
        expect((await heldReason(trx, f)).hold_reason).toBe('preset_missing');
      });
    });

    test('a series template that would not spawn at the discounted price holds', async () => {
      await inRollback(async (trx) => {
        const f = await family(trx);
        await trx('scheduled_services').where({ id: f.parentSeries.rootId }).update({ line_discount_dollars: 5 });
        await apply.runMultiHomeAllHomes({ now: NOW, dbh: trx });
        expect((await heldReason(trx, f)).hold_reason).toBe('series_template_complex');
        expect((await visitRows(trx, f.parentSeries.ids)).every((r) => r.discount_id === null)).toBe(true);
      });
    });

    test('the edit-scope gate off holds', async () => {
      await inRollback(async (trx) => {
        const f = await family(trx);
        const real = featureGates.isEnabled;
        jest.spyOn(featureGates, 'isEnabled').mockImplementation((name) => (name === 'editApptPriceServiceScope' ? false : real(name)));
        await apply.runMultiHomeAllHomes({ now: NOW, dbh: trx });
        expect((await heldReason(trx, f)).hold_reason).toBe('scope_gate_off');
        expectBell('scope_gate_off', f);
      });
    });
  });

  test('a plan sold with the Multi-Home Discount already netted in is already_discounted, not discounted twice', async () => {
    await inRollback(async (trx) => {
      const f = await family(trx);
      const soldWith = await estimate(trx, f.parents, f.parentsHome);
      await trx('scheduled_services').where({ id: f.parentSeries.rootId }).update({ source_estimate_id: soldWith });
      const out = await apply.runMultiHomeAllHomes({ now: NOW, dbh: trx });
      // The parents' own estimate is a source too; its own series is excluded, and the son's series is the same
      // situation from the other side.
      expect(out.held).toBe(0);
      const rows = await ledger(trx, f.estimateId);
      expect(rows.map((r) => r.status)).toEqual(['already_discounted']);
      expect((await visitRows(trx, f.parentSeries.ids)).every((r) => Number(r.estimated_price) === 117 && r.discount_id === null)).toBe(true);
    });
  });

  test('a plan sold with a different manual discount holds', async () => {
    await inRollback(async (trx) => {
      const f = await family(trx);
      const soldWith = await estimate(trx, f.parents, f.parentsHome, { presetKey: 'military', type: 'PERCENT', value: 5, recurringAmount: 20, amount: 20 });
      await trx('scheduled_services').where({ id: f.parentSeries.rootId }).update({ source_estimate_id: soldWith });
      await apply.runMultiHomeAllHomes({ now: NOW, dbh: trx });
      const [row] = await ledger(trx, f.estimateId);
      expect(row).toMatchObject({ status: 'held', hold_reason: 'plan_has_other_discount' });
    });
  });

  const carryPreset = async (trx, ids) => {
    const preset = await trx('discounts').where({ discount_key: 'multi_home' }).first();
    await trx('scheduled_services').whereIn('id', ids).update({
      discount_id: preset.id, discount_name: preset.name, discount_type: 'percentage', discount_amount: 10, discount_dollars: 11.7, primary_line_price: 117, estimated_price: 105.3,
    });
    return preset;
  };

  test('visits that already carry the preset (hand edits) and a template that does not: the template is stamped, then already_discounted', async () => {
    await inRollback(async (trx) => {
      const f = await family(trx);
      const preset = await carryPreset(trx, f.parentSeries.ids);
      await apply.runMultiHomeAllHomes({ now: NOW, dbh: trx });
      const [row] = await ledger(trx, f.estimateId);
      expect(row).toMatchObject({ status: 'already_discounted', hold_reason: null, detail: { reason: 'all_upcoming_visits_carry_it', templateStamped: true } });
      expect((await visitRows(trx, f.parentSeries.ids)).every((r) => Number(r.estimated_price) === 105.3)).toBe(true);
      const root = await trx('scheduled_services').where({ id: f.parentSeries.rootId }).first('recurring_template_overrides');
      expect(root.recurring_template_overrides).toMatchObject({ discount_id: preset.id, primary_line_price: 117, estimated_price: 105.3 });
      // A second run leaves it alone.
      expect(await apply.runMultiHomeAllHomes({ now: NOW, dbh: trx })).toMatchObject({ targets: 0 });
    });
  });

  test('visits and template both already discounted: already_discounted with nothing stamped', async () => {
    await inRollback(async (trx) => {
      const f = await family(trx);
      const preset = await carryPreset(trx, f.parentSeries.ids);
      const overrides = { primary_line_price: 117, estimated_price: 105.3, discount_id: preset.id, discount_name: preset.name, discount_type: 'percentage', discount_amount: 10 };
      await trx('scheduled_services').where({ id: f.parentSeries.rootId }).update({ recurring_template_overrides: JSON.stringify(overrides) });
      await apply.runMultiHomeAllHomes({ now: NOW, dbh: trx });
      const [row] = await ledger(trx, f.estimateId);
      expect(row).toMatchObject({ status: 'already_discounted', detail: { templateStamped: false } });
    });
  });

  test('visits carry the preset but the template cannot be fixed: held as template_not_discounted, nothing stamped', async () => {
    await inRollback(async (trx) => {
      const f = await family(trx);
      await carryPreset(trx, f.parentSeries.ids);
      await trx('scheduled_services').where({ id: f.parentSeries.rootId }).update({ line_discount_dollars: 5 });
      const out = await apply.runMultiHomeAllHomes({ now: NOW, dbh: trx });
      expect(out).toMatchObject({ held: 1, already: 0 });
      const [row] = await ledger(trx, f.estimateId);
      expect(row).toMatchObject({ status: 'held', hold_reason: 'template_not_discounted' });
      const root = await trx('scheduled_services').where({ id: f.parentSeries.rootId }).first('recurring_template_overrides');
      expect(root.recurring_template_overrides).toBeNull();
      expect(notification.notifyAdmin).toHaveBeenCalledWith('billing', expect.any(String), expect.any(String),
        expect.objectContaining({ dedupeKey: `multi-home-discount-hold:${f.estimateId}:${f.parentSeries.rootId}:template_not_discounted` }));
    });
  });

  test('sold with the discount netted in, but the template would spawn at another price: held, not terminal', async () => {
    await inRollback(async (trx) => {
      const f = await family(trx);
      const soldWith = await estimate(trx, f.parents, f.parentsHome);
      await trx('scheduled_services').where({ id: f.parentSeries.rootId }).update({ source_estimate_id: soldWith });
      // The visits were sold at the net price; the parent row (the template) still reads the gross.
      await trx('scheduled_services').whereIn('id', f.parentSeries.ids).update({ estimated_price: 105.3 });
      await apply.runMultiHomeAllHomes({ now: NOW, dbh: trx });
      const rows = await ledger(trx, f.estimateId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: 'held', hold_reason: 'template_not_discounted' });
    });
  });

  describe('the family is checked again under the family-changes lock', () => {
    // A -> B and C: the son (source) is linked with two other profiles.
    async function threeProfileFamily(trx) {
      const f = await family(trx);
      const third = await customer(trx);
      const thirdHome = await property(trx, third);
      const familyId = (await trx('multi_home_family_members').where({ customer_id: f.son }).first()).family_id;
      await trx('multi_home_family_members').insert({ customer_id: third, family_id: familyId });
      const thirdSeries = await series(trx, { customerId: third, propertyId: thirdHome });
      const source = { estimateId: f.estimateId, customerId: f.son, propertyId: f.sonHome, roots: new Set([f.sonSeries.rootId]) };
      const targetOf = (customerId, propertyId, s) => ({ customerId, rootId: s.rootId, propertyId, line: 'pest_control', cadence: 'quarterly', serviceType: 'Quarterly Pest Control Service' });
      return { ...f, third, thirdHome, thirdSeries, source, parentsTarget: targetOf(f.parents, f.parentsHome, f.parentSeries), thirdTarget: targetOf(third, thirdHome, thirdSeries) };
    }

    test('a profile unlinked after the targets were picked is dropped: no price change, no hold, no bell, its old held row gone', async () => {
      await inRollback(async (trx) => {
        const f = await threeProfileFamily(trx);
        await trx('multi_home_discount_applications').insert({
          source_estimate_id: f.estimateId, source_customer_id: f.son, target_customer_id: f.parents, series_root_id: f.parentSeries.rootId, status: 'held', hold_reason: 'plan_on_hold',
        });
        // Staff unlink the parents after selection (their membership row is gone).
        await trx('multi_home_family_members').where({ customer_id: f.parents }).del();
        const dropped = await apply.applyTargetSeries(f.source, f.parentsTarget, { now: NOW, dbh: trx });
        expect(dropped).toEqual({ skipped: true, dropped: true });
        expect((await visitRows(trx, f.parentSeries.ids)).every((r) => Number(r.estimated_price) === 117 && r.discount_id === null)).toBe(true);
        expect((await ledger(trx, f.estimateId)).filter((r) => r.series_root_id === f.parentSeries.rootId)).toHaveLength(0);
        expect(notification.notifyAdmin).not.toHaveBeenCalled();
        // The other linked profile is still a target and still gets it.
        const thirdResult = await apply.applyTargetSeries(f.source, f.thirdTarget, { now: NOW, dbh: trx });
        expect(thirdResult).toMatchObject({ status: 'applied' });
        expect((await visitRows(trx, f.thirdSeries.ids)).every((r) => Number(r.estimated_price) === 105.3)).toBe(true);
      });
    });

    test('the source unlinked after selection: no other profile gets the discount from an unrelated source', async () => {
      await inRollback(async (trx) => {
        const f = await threeProfileFamily(trx);
        await trx('multi_home_family_members').where({ customer_id: f.son }).del();
        for (const target of [f.parentsTarget, f.thirdTarget]) {
          expect(await apply.applyTargetSeries(f.source, target, { now: NOW, dbh: trx })).toEqual({ skipped: true, dropped: true });
        }
        expect((await visitRows(trx, [...f.parentSeries.ids, ...f.thirdSeries.ids])).every((r) => r.discount_id === null)).toBe(true);
      });
    });

    test('a family left with one live member no longer counts', async () => {
      await inRollback(async (trx) => {
        const f = await family(trx);
        const source = { estimateId: f.estimateId, customerId: f.son, propertyId: f.sonHome, roots: new Set([f.sonSeries.rootId]) };
        await trx('customers').where({ id: f.son }).update({ active: false });
        expect(await apply.applyTargetSeries(source, { customerId: f.parents, rootId: f.parentSeries.rootId, propertyId: f.parentsHome, line: 'pest_control', cadence: 'quarterly' }, { now: NOW, dbh: trx })).toEqual({ skipped: true, dropped: true });
      });
    });

    test('a held row for a profile that was unlinked is deleted by the next run, and counted', async () => {
      await inRollback(async (trx) => {
        const f = await threeProfileFamily(trx);
        await trx('customers').where({ id: f.third }).update({ has_multi_home: false });
        await trx('multi_home_discount_applications').insert({
          source_estimate_id: f.estimateId, source_customer_id: f.son, target_customer_id: f.third, series_root_id: f.thirdSeries.rootId, status: 'held', hold_reason: 'plan_on_hold',
        });
        await trx('multi_home_family_members').where({ customer_id: f.third }).del();
        const out = await apply.runMultiHomeAllHomes({ now: NOW, dbh: trx });
        expect(out).toMatchObject({ applied: 1, dropped: 1 });
        const left = await ledger(trx, f.estimateId);
        expect(left.map((r) => r.series_root_id)).toEqual([f.parentSeries.rootId]);
      });
    });

    // A second connection holds the lock the way a link or unlink does (exclusive). The apply waits for it, then goes on.
    async function holdFamilyLock(mode) {
      const holder = knex({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 1, max: 1 } });
      const fn = mode === 'shared' ? 'pg_advisory_xact_lock_shared' : 'pg_advisory_xact_lock';
      const release = await new Promise((resolveHeld, rejectHeld) => {
        holder.transaction(async (trx) => {
          await trx.raw(`SELECT ${fn}(hashtext(?))`, ['multi_home_family_members:changes']);
          await new Promise((finish) => resolveHeld(finish));
        }).catch(rejectHeld);
      });
      return { release, destroy: () => holder.destroy() };
    }

    test('an apply waits while a link or unlink holds the family lock exclusively', async () => {
      const held = await holdFamilyLock('exclusive');
      try {
        await inRollback(async (trx) => {
          const f = await family(trx);
          let finished = false;
          const pending = apply.runMultiHomeAllHomes({ now: NOW, dbh: trx }).then((out) => { finished = true; return out; });
          await new Promise((r) => setTimeout(r, 400));
          expect(finished).toBe(false);
          held.release();
          expect(await pending).toMatchObject({ applied: 1 });
          expect((await visitRows(trx, f.parentSeries.ids)).every((r) => Number(r.estimated_price) === 105.3)).toBe(true);
        });
      } finally {
        await held.destroy();
      }
    });

    test('applies share the lock: another shared holder does not block an apply', async () => {
      const held = await holdFamilyLock('shared');
      try {
        await inRollback(async (trx) => {
          await family(trx);
          expect(await apply.runMultiHomeAllHomes({ now: NOW, dbh: trx })).toMatchObject({ applied: 1 });
        });
      } finally {
        held.release();
        await held.destroy();
      }
    });
  });

  describe('stale held rows and paging', () => {
    const episodes = () => require('../services/admin-alert-episodes');

    async function heldFamily(trx) {
      const f = await family(trx);
      await trx('customers').where({ id: f.parents }).update({ billing_mode: 'monthly_membership', monthly_rate: 49, waveguard_tier: 'Gold' });
      const out = await apply.runMultiHomeAllHomes({ now: NOW, dbh: trx });
      expect(out).toMatchObject({ held: 1 });
      expect((await ledger(trx, f.estimateId))[0]).toMatchObject({ status: 'held' });
      return f;
    }
    const bellClosedFor = (spy, f) => spy.mock.calls.some(([, keys]) => keys.includes(`multi-home-discount-hold:${f.estimateId}:${f.parentSeries.rootId}:lane_monthly_membership`));

    test('the whole family unlinked after a hold: the held row and its bell are gone on the next run', async () => {
      await inRollback(async (trx) => {
        const spy = jest.spyOn(episodes(), 'closeAdminAlertKeys').mockResolvedValue(1);
        const f = await heldFamily(trx);
        await trx('multi_home_family_members').whereIn('customer_id', [f.son, f.parents]).del();
        const out = await apply.runMultiHomeAllHomes({ now: NOW, dbh: trx });
        expect(out).toMatchObject({ sources: 0, dropped: 1, held: 0 });
        expect(await ledger(trx, f.estimateId)).toHaveLength(0);
        expect(bellClosedFor(spy, f)).toBe(true);
      });
    });

    test('an accepted estimate that leaves the 14-day window: its held rows are cleared, applied rows stay', async () => {
      await inRollback(async (trx) => {
        const spy = jest.spyOn(episodes(), 'closeAdminAlertKeys').mockResolvedValue(1);
        const f = await heldFamily(trx);
        await trx('multi_home_discount_applications').insert({
          source_estimate_id: f.estimateId, source_customer_id: f.son, target_customer_id: f.parents, series_root_id: randomUUID(),
          status: 'applied', applied_at: NOW, price_before: 117, price_after: 105.3,
        });
        const later = new Date(NOW.getTime() + 20 * 86400000);
        const out = await apply.runMultiHomeAllHomes({ now: later, dbh: trx });
        expect(out).toMatchObject({ sources: 0, dropped: 1 });
        const left = await ledger(trx, f.estimateId);
        expect(left.map((r) => r.status)).toEqual(['applied']);
        expect(bellClosedFor(spy, f)).toBe(true);
      });
    });

    test('an estimate that stops being accepted: its held rows are cleared', async () => {
      await inRollback(async (trx) => {
        jest.spyOn(episodes(), 'closeAdminAlertKeys').mockResolvedValue(1);
        const f = await heldFamily(trx);
        await trx('estimates').where({ id: f.estimateId }).update({ status: 'declined' });
        expect(await apply.runMultiHomeAllHomes({ now: NOW, dbh: trx })).toMatchObject({ dropped: 1 });
        expect(await ledger(trx, f.estimateId)).toHaveLength(0);
      });
    });

    test('an accepted estimate revised to drop the Multi-Home Discount: its held rows are cleared', async () => {
      await inRollback(async (trx) => {
        jest.spyOn(episodes(), 'closeAdminAlertKeys').mockResolvedValue(1);
        const f = await heldFamily(trx);
        // The revise removes the discount, so the source scan's prefilter no longer reads this estimate at all.
        await trx('estimates').where({ id: f.estimateId }).update({ estimate_data: trx.raw("'{}'::jsonb") });
        expect(await apply.runMultiHomeAllHomes({ now: NOW, dbh: trx })).toMatchObject({ dropped: 1 });
        expect(await ledger(trx, f.estimateId)).toHaveLength(0);
      });
    });

    test('every source in the window is read by keyset, including rows with the same accepted_at', async () => {
      await inRollback(async (trx) => {
        const ids = [];
        for (const at of ['2026-11-01T10:00:00.123456Z', '2026-11-01T10:00:00.123456Z', '2026-11-02T10:00:00Z', '2026-11-03T10:00:00Z', '2026-11-04T10:00:00Z']) {
          const c = await customer(trx);
          const id = randomUUID();
          await trx('estimates').insert({
            id, customer_id: c, status: 'accepted', accepted_at: at, token: randomUUID().replace(/-/g, ''),
            estimate_data: JSON.stringify({ summary: { manualDiscount: { presetKey: 'multi_home', type: 'PERCENT', value: 10, recurringAmount: 40 } } }),
          });
          ids.push(id);
        }
        const seen = [];
        await apply._private.eachSourceEstimate(trx, NOW, async (e) => { seen.push(e.id); }, 2);
        expect(seen).toHaveLength(5);
        expect(seen.slice().sort()).toEqual(ids.slice().sort());
        expect(new Set(seen).size).toBe(5);
      });
    });
  });

  test('the ledger holds one row per source estimate and series (unique)', async () => {
    await inRollback(async (trx) => {
      const f = await family(trx);
      await apply.runMultiHomeAllHomes({ now: NOW, dbh: trx });
      await expect(trx.transaction((sp) => sp('multi_home_discount_applications').insert({
        source_estimate_id: f.estimateId, source_customer_id: f.son, target_customer_id: f.parents, series_root_id: f.parentSeries.rootId,
      }))).rejects.toThrow(/duplicate key|unique/i);
    });
  });
});
