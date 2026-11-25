/**
 * The cancelled-root plan price bell (services/series-price-guards.js) closes
 * itself only when the guard's own extension later ADDS the occurrence it had
 * refused, at a price a paid visit of the series backs. Real Postgres: the
 * notification queries, the invoice baseline, the commit fence. Fixtures are fake.
 */
process.env.GATE_SERIES_PRICE_GUARDS = 'true';
const SKIP = !process.env.DATABASE_URL;
const maybeDescribe = SKIP ? describe.skip : describe;

const DATE = '2031-03-04';
const OTHER_DATE = '2031-06-03';

maybeDescribe('series price bell closes itself (live Postgres)', () => {
  let db;
  let guards;
  const made = { notifications: [], invoices: [], scheduled_services: [], customers: [] };

  beforeAll(() => {
    db = require('../models/db');
    guards = require('../services/series-price-guards');
  });
  afterAll(async () => {
    if (made.notifications.length) await db('audit_log').where({ resource_type: 'notification' }).whereIn('resource_id', made.notifications).del();
    for (const table of ['notifications', 'invoices', 'scheduled_services', 'customers']) {
      if (made[table].length) await db(table).whereIn('id', made[table]).del();
    }
    await db.destroy();
  }, 120000);

  const insert = async (table, row) => {
    const [r] = await db(table).insert(row).returning('*');
    made[table].push(r.id);
    return r;
  };

  // A cancelled root, a completed child whose own paid invoice is `paid`, and the open bell.
  async function series({ paid = 117, refusedDate = DATE, bellExtra = {} } = {}) {
    const customer = await insert('customers', { first_name: 'Closer', last_name: 'Example', phone: `+1555555${Math.floor(1000 + Math.random() * 8999)}` });
    const root = await insert('scheduled_services', {
      customer_id: customer.id, scheduled_date: '2030-01-01', service_type: 'Quarterly Pest Control', status: 'cancelled',
      is_recurring: true, recurring_pattern: 'quarterly', estimated_price: 333.45,
    });
    if (paid != null) {
      const visit = await insert('scheduled_services', {
        customer_id: customer.id, scheduled_date: '2030-04-01', service_type: 'Quarterly Pest Control', status: 'completed',
        is_recurring: true, recurring_pattern: 'quarterly', recurring_parent_id: root.id, estimated_price: paid,
      });
      await insert('invoices', {
        customer_id: customer.id, scheduled_service_id: visit.id, status: 'paid', token: `tok-${visit.id}`, invoice_number: `SPG-${String(visit.id).slice(0, 8)}-${Date.now() % 1e6}`, total: paid, tax_amount: 0,
        line_items: JSON.stringify([{ client_id: `scheduled_${visit.id}_primary`, amount: paid, description: 'Service' }]),
      });
    }
    const bell = await insert('notifications', {
      recipient_type: 'admin', category: 'billing', title: 'Schedule - check a plan price',
      metadata: JSON.stringify({ dedupeKey: `series-price-guard:cancelled-root:${root.id}`, kind: 'cancelled_root', seriesRootId: root.id, ...(refusedDate ? { refusedDate } : {}), ...bellExtra }),
    });
    const child = await insert('scheduled_services', {
      customer_id: customer.id, scheduled_date: DATE, service_type: 'Quarterly Pest Control', status: 'pending',
      is_recurring: true, recurring_pattern: 'quarterly', recurring_parent_id: root.id, estimated_price: 117,
    });
    return { customer, root, bell, child };
  }
  const run = (s, { childDate = DATE, price = 117, commit = true, childId, after } = {}) => db.transaction(async (trx) => {
    const parent = await trx('scheduled_services').where({ id: s.root.id }).first();
    const closed = await guards.closeRefusedPriceAlertAfterInsert(trx, {
      parent, parentId: s.root.id, child: { estimated_price: price, service_type: 'Quarterly Pest Control' },
      childDate, childId: childId || s.child.id,
    });
    if (after) await after(trx);
    if (!commit) throw Object.assign(new Error('rollback'), { rolledBack: true, closed });
    return closed;
  });
  const get = (id) => db('notifications').where({ id }).first();

  test('the same occurrence added at a price the last paid visit backs closes the bell', async () => {
    const s = await series();
    expect(await run(s)).toBe(true);
    const row = await get(s.bell.id);
    expect(row.done_at).not.toBeNull();
    expect(row.done_by).toBe('series-price-guard');
    expect(row.resolution).toMatch(/last paid visit backs/);
  });

  test('a different date proves nothing: the bell stays open', async () => {
    const s = await series({ refusedDate: OTHER_DATE });
    expect(await run(s)).toBe(false);
    expect((await get(s.bell.id)).done_at).toBeNull();
  });

  test('a bell with no recorded refused date (raised before it existed) stays open', async () => {
    const s = await series({ refusedDate: null });
    expect(await run(s)).toBe(false);
    expect((await get(s.bell.id)).done_at).toBeNull();
  });

  test('the price the last paid visit does not back (over 125%) stays open', async () => {
    const s = await series();
    expect(await run(s, { price: 333.45 })).toBe(false);
    expect((await get(s.bell.id)).done_at).toBeNull();
  });

  test('no paid visit to back the price stays open', async () => {
    const s = await series({ paid: null });
    expect(await run(s)).toBe(false);
    expect((await get(s.bell.id)).done_at).toBeNull();
  });

  test('an unpriced occurrence stays open', async () => {
    const s = await series();
    expect(await run(s, { price: null })).toBe(false);
    expect((await get(s.bell.id)).done_at).toBeNull();
  });

  test('a child the prepay coverage stamped after insert stays open', async () => {
    const s = await series();
    await db('scheduled_services').where({ id: s.child.id }).update({ prepaid_method: 'cash', prepaid_amount: 117 });
    expect(await run(s)).toBe(false);
    expect((await get(s.bell.id)).done_at).toBeNull();
  });

  test('the close is inside the extension transaction: a rolled-back extension (the top-up dry run) undoes it', async () => {
    const s = await series();
    let inside;
    await expect(run(s, { commit: false, after: async (trx) => { inside = (await trx('notifications').where({ id: s.bell.id }).first()).done_by; } }))
      .rejects.toMatchObject({ rolledBack: true, closed: true });
    expect(inside).toBe('series-price-guard');
    expect((await get(s.bell.id)).done_at).toBeNull();
  });

  test('a close that fails runs in a savepoint: logged, the bell stays open, the transaction goes on', async () => {
    const s = await series();
    let later;
    // A child id that is not a uuid makes the prepay probe fail inside the close.
    expect(await run(s, { childId: 'not-a-uuid', after: async (trx) => { later = (await trx('scheduled_services').where({ id: s.root.id }).first('id')).id; } })).toBe(false);
    expect(later).toBe(s.root.id);
    expect((await get(s.bell.id)).done_at).toBeNull();
  });

  test('another series\' bell for the same date is not touched', async () => {
    const mine = await series();
    const other = await series();
    expect(await run(mine)).toBe(true);
    expect((await get(other.bell.id)).done_at).toBeNull();
  });

  test('a bell a person already closed is left as it is', async () => {
    const s = await series();
    const at = new Date(Date.now() - 3600000);
    await db('notifications').where({ id: s.bell.id }).update({ done_at: at, done_by: '0b1f6c1e-3c64-4f8e-9d7a-5a2f3e9b1c10', resolution: 'Checked by hand' });
    expect(await run(s)).toBe(false);
    expect((await get(s.bell.id)).resolution).toBe('Checked by hand');
  });

  describe('the refused date on the standing bell', () => {
    const verdict = { skip: true, kind: 'cancelled_root', price: 333.45, lastPaid: 117 };
    const ctx = (s, childDate) => ({ parent: { customer_id: s.customer.id }, parentId: s.root.id, childDate, serviceLabel: 'Quarterly Pest Control' });
    const openBells = (s) => db('notifications').where({ recipient_type: 'admin' })
      .whereRaw("metadata->>'dedupeKey' = ?", [`series-price-guard:cancelled-root:${s.root.id}`]).whereNull('done_at');

    test('a refusal on a later date moves the open bell\'s text and refused date together; no second bell, no ring', async () => {
      const s = await series({ refusedDate: null });
      await guards.raiseExtensionPriceAlert(verdict, ctx(s, DATE));
      const bells = await openBells(s);
      expect(bells).toHaveLength(1);
      expect(bells[0].id).toBe(s.bell.id);
      expect(bells[0].metadata.refusedDate).toBe(DATE);
      const readAt = bells[0].read_at;
      await guards.raiseExtensionPriceAlert(verdict, ctx(s, OTHER_DATE));
      const after = await openBells(s);
      expect(after).toHaveLength(1);
      expect(after[0].metadata.refusedDate).toBe(OTHER_DATE);
      expect(after[0].metadata.dedupeVersion).toBe(OTHER_DATE);
      // Text and date move together; quiet: no ring (read state and created_at stay), no second row.
      expect(after[0].body).toMatch(/Jun 3/);
      expect(after[0].read_at).toEqual(readAt);
      expect(after[0].created_at).toEqual(bells[0].created_at);
      expect(after[0].done_at).toBeNull();
    });

    test('the same refusal again changes nothing', async () => {
      const s = await series({ refusedDate: null });
      await guards.raiseExtensionPriceAlert(verdict, ctx(s, DATE));
      const before = await get(s.bell.id);
      await guards.raiseExtensionPriceAlert(verdict, ctx(s, DATE));
      expect(await get(s.bell.id)).toEqual(before);
    });

    test('a fresh bell carries the refused date; a closed bell is never stamped', async () => {
      const s = await series({ refusedDate: null });
      await db('notifications').where({ id: s.bell.id }).update({ done_at: new Date(), done_by: 'someone' });
      await guards.raiseExtensionPriceAlert(verdict, ctx(s, DATE));
      expect((await get(s.bell.id)).metadata.refusedDate).toBeUndefined();
      const fresh = await openBells(s);
      expect(fresh).toHaveLength(1);
      made.notifications.push(fresh[0].id);
      expect(fresh[0].metadata.refusedDate).toBe(DATE);
    });
  });
});
