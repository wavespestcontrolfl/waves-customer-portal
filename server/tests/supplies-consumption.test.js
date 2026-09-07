/**
 * supplies-consumption.js — per-completion consumables.
 *
 * Unit contract (mocked db):
 *   - GATE_AUTO_REORDER unset → nothing read, nothing written (dark)
 *   - incomplete visit → nothing read, nothing written
 *   - a consumable with a count → one usage movement + decrement
 *   - a duplicate (movement insert ignored by the partial unique index) →
 *     NO decrement (resume-path idempotency)
 *   - a line-scoped product is consumed only on a listed service line;
 *     null = every line; no resolvable line → not consumed
 *   - no inventory_on_hand → skipped, no movement
 *   - a thrown error is contained (never rejects)
 *
 * DB-backed contract (self-skips without DATABASE_URL, after migrate:latest):
 *   - the auto-reorder columns and the partial unique expression index
 *     exist, and the index rejects a second completion_consumable movement
 *     for the same (product, visit).
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => ({})) }));

const { consumeCompletionSupplies, settleOwedCompletionSupplies, completionSuppliesOwed, appliesToLine } = require('../services/supplies-consumption');
const { notifyAdmin } = require('../services/notification-service');

function fakeDb({ products, duplicate = false, throwOnInsert = false, techLogged = false, handedOff = false, settledAfterBell = false, openLookupBell = false }) {
  const updates = [];
  const inserts = [];
  const trx = (table) => {
    const q = {};
    q.where = () => q;
    q._sql = '';
    q.whereRaw = (sql) => { q._sql += sql; return q; };
    q.forUpdate = () => q;
    q.first = async () => {
      if (table === 'product_inventory_movements') return techLogged ? { id: 'mv-tech' } : null;
      // handedOff 'auto' = the only matching bell is one this module retired itself (metadata.autoRetired): the settled read's predicate excludes it.
      if (table === 'notifications') return handedOff === 'auto' ? (q._sql.includes('autoRetired') ? null : { id: 'bell-auto' }) : handedOff ? { id: 'bell-1' } : null;
      return products[0];
    };
    q.update = async (row) => { updates.push({ table, row }); return 1; };
    q.whereNull = () => q;
    q.insert = (row) => ({
      onConflict: () => ({
        ignore: () => ({
          returning: async () => {
            if (throwOnInsert) throw new Error('insert boom');
            inserts.push(row);
            return duplicate ? [] : [{ id: 'mv-1' }];
          },
        }),
      }),
    });
    return q;
  };
  trx.raw = (s) => s;
  const db = (table) => {
    const q = {};
    for (const m of ['whereNotNull', 'where', 'whereNull']) q[m] = () => q;
    q.whereRaw = (sql, bindings) => { if (table === 'notifications' && bindings) q._key = bindings[0]; return q; };
    q.select = async () => products;
    q.update = async (row) => { updates.push({ table, row, ...(q._key ? { key: q._key } : {}) }); return 1; };
    q.first = async () => {
      if (table === 'notifications') return openLookupBell && q._key === 'supplies-consumption-failed:lookup:svc-1' ? { id: 'bell-lookup' } : null; // retireLookupBellIfSettled's open-bell probe
      return table === 'product_inventory_movements' && (settledAfterBell || openLookupBell) ? { id: 'mv-race' } : null; // the post-bell settled re-check / lookupSettled
    };
    return q;
  };
  db.transaction = async (fn) => fn(trx);
  db.raw = (s) => s;
  return { db, updates, inserts };
}

const sign = { id: 'prod-sign', name: 'Sign card', per_completion_usage: '1', inventory_on_hand: '640', inventory_unit: 'each' };
const args = { scheduledServiceId: 'svc-1', serviceRecordId: 'rec-1', customerId: 'cust-1', technicianId: 'tech-1' };

// The hook shares the lane's kill switch with the sweep: on for the contract
// below; one test proves unset = nothing read.
beforeAll(() => { process.env.GATE_AUTO_REORDER = 'true'; });
afterAll(() => { delete process.env.GATE_AUTO_REORDER; });

test('GATE_AUTO_REORDER unset → skipped before any read (PR ships dark end to end — GH codex r6 P1)', async () => {
  delete process.env.GATE_AUTO_REORDER;
  try {
    const selectSpy = jest.fn();
    const db = () => ({ where: () => ({ whereNotNull: () => ({ where: () => ({ select: selectSpy }) }) }) });
    const res = await consumeCompletionSupplies(db, args);
    expect(res.skipped).toEqual([{ reason: 'gated' }]);
    expect(selectSpy).not.toHaveBeenCalled();
  } finally { process.env.GATE_AUTO_REORDER = 'true'; }
});

test('incomplete visit → skipped before any read', async () => {
  const selectSpy = jest.fn();
  const db = () => ({ where: () => ({ whereNotNull: () => ({ where: () => ({ select: selectSpy }) }) }) });
  const res = await consumeCompletionSupplies(db, { ...args, isIncompleteVisit: true });
  expect(res.skipped).toEqual([{ reason: 'incomplete_visit' }]);
  expect(selectSpy).not.toHaveBeenCalled();
});

test('inspection_only / customer_declined closeout (visitPerformed=false) → skipped before any read', async () => {
  const selectSpy = jest.fn();
  const db = () => ({ where: () => ({ whereNotNull: () => ({ where: () => ({ select: selectSpy }) }) }) });
  const res = await consumeCompletionSupplies(db, { ...args, visitPerformed: false });
  expect(res.skipped).toEqual([{ reason: 'visit_not_performed' }]);
  expect(selectSpy).not.toHaveBeenCalled();
});

test('an inspection service completed normally consumes nothing (no application, no sign)', async () => {
  const { db, inserts } = fakeDb({ products: [sign] });
  const res = await consumeCompletionSupplies(db, { ...args, serviceType: 'Pest Inspection Service' });
  expect(res.skipped).toEqual([{ reason: 'inspection_service' }]);
  expect(inserts).toHaveLength(0);
});

test('a product retired between the scan and the lock is not deducted', async () => {
  const { db, inserts } = fakeDb({ products: [{ ...sign, active: false }] });
  const res = await consumeCompletionSupplies(db, args);
  expect(inserts).toHaveLength(0);
  expect(res.skipped).toEqual([{ productId: 'prod-sign', reason: 'retired' }]);
});

test('a service-line scope set between the scan and the lock is honored', async () => {
  const { db, inserts } = fakeDb({ products: [{ ...sign, per_completion_service_lines: '["lawn"]' }] });
  const res = await consumeCompletionSupplies(db, { ...args, serviceLine: 'pest' });
  expect(inserts).toHaveLength(0);
  expect(res.skipped).toEqual([{ productId: 'prod-sign', reason: 'service_line_excluded' }]);
});

test('an internal-only completion profile (Waves Assessment) consumes nothing even though its name reads as pest (Codex r9 P2)', async () => {
  const { db, inserts } = fakeDb({ products: [sign] });
  const res = await consumeCompletionSupplies(db, { ...args, serviceType: 'Waves Assessment', isInternalOnlyCompletion: true });
  expect(res.skipped).toEqual([{ reason: 'internal_only_completion' }]);
  expect(inserts).toHaveLength(0);
});

const notice = { ...sign, id: 'prod-notice', name: 'Termite protection notice', per_completion_service_lines: '["termite"]', inventory_on_hand: '10' };

test('a WDO inspection project consumes the termite-scoped notice (owner ruling 2026-09-06)', async () => {
  const { db, inserts } = fakeDb({ products: [notice] });
  const res = await consumeCompletionSupplies(db, { ...args, serviceType: 'WDO Inspection', serviceLine: 'termite', projectType: 'wdo_inspection' });
  expect(res.skipped).toEqual([]);
  expect(res.consumed).toEqual([{ productId: 'prod-notice', name: 'Termite protection notice', usage: 1, unit: 'each', before: 10, after: 9, costUsed: null }]);
  expect(inserts).toHaveLength(1);
});

test('a WDO inspection project still leaves the pest-scoped yard sign alone', async () => {
  const { db, inserts } = fakeDb({ products: [{ ...sign, per_completion_service_lines: '["pest"]' }] });
  const res = await consumeCompletionSupplies(db, { ...args, serviceType: 'WDO Inspection', serviceLine: 'termite', projectType: 'wdo_inspection' });
  expect(res.skipped).toEqual([{ productId: 'prod-sign', reason: 'service_line_excluded' }]);
  expect(inserts).toHaveLength(0);
});

test('a visual Termite Inspection Service on the normal path posts no notice — the exception is the WDO project, not the termite line (codex #3996 P2)', async () => {
  const { db, inserts } = fakeDb({ products: [notice] });
  const res = await consumeCompletionSupplies(db, { ...args, serviceType: 'Termite Inspection Service', serviceLine: 'termite' });
  expect(res.skipped).toEqual([{ reason: 'inspection_service' }]);
  expect(inserts).toHaveLength(0);
});

// ---- owed-marker lifecycle shared by the recap route and the project close
test('completionSuppliesOwed reads the marker off jsonb or text flags and fails closed on garbage', () => {
  expect(completionSuppliesOwed({ field_flags: { completion_supplies_owed: true } })).toBe(true);
  expect(completionSuppliesOwed({ field_flags: '{"completion_supplies_owed":true}' })).toBe(true);
  expect(completionSuppliesOwed({ field_flags: { completion_supplies_owed: 'true' } })).toBe(false);
  expect(completionSuppliesOwed({ field_flags: null })).toBe(false);
  expect(completionSuppliesOwed({ field_flags: '{not json' })).toBe(false);
  expect(completionSuppliesOwed(null)).toBe(false);
});

test('settleOwedCompletionSupplies consumes, then clears the owed marker on the record', async () => {
  const { db, updates, inserts } = fakeDb({ products: [sign] });
  const res = await settleOwedCompletionSupplies(db, { ...args, serviceType: 'Quarterly Pest Control', serviceLine: 'pest' });
  expect(res.consumed).toHaveLength(1);
  expect(inserts).toHaveLength(1);
  const clear = updates.filter((u) => u.table === 'service_records');
  expect(clear).toHaveLength(1);
  expect(String(clear[0].row.field_flags)).toContain("- 'completion_supplies_owed'");
});

test('settleOwedCompletionSupplies keeps the marker when the hand-off bell was lost', async () => {
  notifyAdmin.mockResolvedValueOnce(null); // the bell could not persist
  const { db, updates } = fakeDb({ products: [sign], throwOnInsert: true });
  const res = await settleOwedCompletionSupplies(db, { ...args, serviceType: 'Quarterly Pest Control', serviceLine: 'pest' });
  expect(res.errors.some((e) => e.reason === 'failure_bell_not_sent')).toBe(true);
  expect(updates.filter((u) => u.table === 'service_records')).toHaveLength(0);
});

test('a treatment service type is not an inspection', async () => {
  const { db, inserts } = fakeDb({ products: [sign] });
  await consumeCompletionSupplies(db, { ...args, serviceType: 'Quarterly Pest Control' });
  expect(inserts).toHaveLength(1);
});

test('consumable with a count → one usage movement and a decrement', async () => {
  const { db, updates, inserts } = fakeDb({ products: [sign] });
  const res = await consumeCompletionSupplies(db, args);
  expect(res.consumed).toEqual([{ productId: 'prod-sign', name: 'Sign card', usage: 1, unit: 'each', before: 640, after: 639, costUsed: null }]);
  expect(inserts).toHaveLength(1);
  expect(inserts[0]).toMatchObject({ scheduled_service_id: 'svc-1', movement_type: 'usage', quantity: 1, stock_before: 640, stock_after: 639, metadata: { source: 'completion_consumable' } });
  expect(updates.filter((u) => u.table === 'products_catalog')).toEqual([{ table: 'products_catalog', row: expect.objectContaining({ inventory_on_hand: 639 }) }]);
});

test('a kit item the tech logged in the picker is not consumed again', async () => {
  const { db, updates, inserts } = fakeDb({ products: [sign], techLogged: true });
  const res = await consumeCompletionSupplies(db, args);
  expect(res.skipped).toEqual([{ productId: 'prod-sign', reason: 'already_logged_by_tech' }]);
  expect(inserts).toHaveLength(0);
  expect(updates).toHaveLength(0);
});

test('movement carries unit_cost / cost_used from cost_per_unit in the inventory unit', async () => {
  const { db, inserts } = fakeDb({ products: [{ ...sign, cost_per_unit: '0.5356', cost_unit: 'each' }] });
  const res = await consumeCompletionSupplies(db, args);
  expect(inserts[0]).toMatchObject({ unit_cost: 0.5356, cost_used: 0.5356 });
  expect(res.consumed[0].costUsed).toBe(0.5356);
  const mismatch = fakeDb({ products: [{ ...sign, cost_per_unit: '12', cost_unit: 'gal' }] });
  await consumeCompletionSupplies(mismatch.db, args);
  expect(mismatch.inserts).toHaveLength(1);
  expect(mismatch.inserts[0]).toMatchObject({ unit_cost: null, cost_used: null });
});

test('a product whose hand-off bell landed on an earlier attempt is NOT deducted on the retry — the office adjusts it by hand; no movement, no decrement, bell left alone (Codex r17 P1)', async () => {
  const { db, updates, inserts } = fakeDb({ products: [sign], handedOff: true });
  const res = await consumeCompletionSupplies(db, args);
  expect(res.consumed).toHaveLength(0);
  expect(res.skipped).toEqual([{ productId: 'prod-sign', reason: 'handed_off' }]);
  expect(inserts).toHaveLength(0);
  expect(updates).toHaveLength(0);
});

test('a failure bell that lands after a concurrent retry already deducted the kit is retired right away (Codex r18 P1)', async () => {
  notifyAdmin.mockClear();
  const { db, updates } = fakeDb({ products: [sign], throwOnInsert: true, settledAfterBell: true });
  const res = await consumeCompletionSupplies(db, args);
  expect(res.errors).toEqual([{ productId: 'prod-sign', message: 'insert boom' }]);
  expect(notifyAdmin).toHaveBeenCalledTimes(1);
  const retired = updates.filter((u) => u.table === 'notifications');
  expect(retired).toHaveLength(1);
  expect(retired[0].row.read_at).toBeInstanceOf(Date);
});

test('duplicate (index ignored the insert) → no decrement', async () => {
  const { db, updates } = fakeDb({ products: [sign], duplicate: true });
  const res = await consumeCompletionSupplies(db, args);
  expect(res.consumed).toHaveLength(0);
  expect(res.skipped).toEqual([{ productId: 'prod-sign', reason: 'already_consumed' }]);
  expect(updates.filter((u) => u.table === 'products_catalog')).toHaveLength(0);
});

describe('service-line scope', () => {
  const scoped = { ...sign, per_completion_service_lines: ['pest', 'mosquito', 'lawn', 'tree_shrub'] };

  test('appliesToLine: null = every line; jsonb string or array both parse; unknown line excluded', () => {
    expect(appliesToLine(null, 'termite')).toBe(true);
    // Malformed scope fails CLOSED, never widens to every line.
    expect(appliesToLine('{not json', 'pest')).toBe(false);
    expect(appliesToLine('"pest"', 'pest')).toBe(false);
    expect(appliesToLine({ pest: true }, 'pest')).toBe(false);
    expect(appliesToLine(['pest'], 'pest')).toBe(true);
    expect(appliesToLine(JSON.stringify(['pest']), 'pest')).toBe(true);
    expect(appliesToLine(['pest'], 'termite')).toBe(false);
    expect(appliesToLine(['pest'], null)).toBe(false);
    // Malformed scope fails CLOSED (pre-push P1): not "every line".
    expect(appliesToLine('not json', 'termite')).toBe(false);
    expect(appliesToLine('not json', 'pest')).toBe(false);
    expect(appliesToLine({ pest: true }, 'pest')).toBe(false);
  });

  test('a product whose scope is malformed is skipped with a recorded error, no movement — and handed to staff by the per-product bell (Codex #3832 hook P1)', async () => {
    notifyAdmin.mockClear();
    const { db, inserts } = fakeDb({ products: [{ ...sign, per_completion_service_lines: 'not json' }] });
    const res = await consumeCompletionSupplies(db, { ...args, serviceLine: 'pest' });
    expect(res.errors).toEqual([{ productId: 'prod-sign', reason: 'invalid_service_lines' }]);
    expect(res.consumed).toHaveLength(0);
    expect(inserts).toHaveLength(0);
    expect(notifyAdmin).toHaveBeenCalledTimes(1);
    expect(notifyAdmin.mock.calls[0][3].dedupeKey).toBe('supplies-consumption-failed:prod-sign:svc-1');
  });

  test('a pest visit consumes the kit item', async () => {
    const { db, inserts } = fakeDb({ products: [scoped] });
    const res = await consumeCompletionSupplies(db, { ...args, serviceLine: 'pest' });
    expect(res.consumed).toHaveLength(1);
    expect(inserts).toHaveLength(1);
  });

  test('a termite visit does not consume a pest/mosquito/lawn/tree_shrub item — no movement, no decrement', async () => {
    const { db, inserts, updates } = fakeDb({ products: [scoped] });
    const res = await consumeCompletionSupplies(db, { ...args, serviceLine: 'termite' });
    expect(res.consumed).toHaveLength(0);
    expect(res.skipped).toEqual([{ productId: 'prod-sign', reason: 'service_line_excluded' }]);
    expect(inserts).toHaveLength(0);
    expect(updates).toHaveLength(0);
  });

  test('an unscoped product is consumed on any line', async () => {
    const { db } = fakeDb({ products: [{ ...sign, per_completion_service_lines: null }] });
    const res = await consumeCompletionSupplies(db, { ...args, serviceLine: 'rodent' });
    expect(res.consumed).toHaveLength(1);
  });
});

test('no inventory_on_hand → skipped, no movement', async () => {
  const { db, updates, inserts } = fakeDb({ products: [{ ...sign, inventory_on_hand: null }] });
  const res = await consumeCompletionSupplies(db, args);
  expect(res.skipped).toEqual([{ productId: 'prod-sign', reason: 'no_on_hand' }]);
  expect(inserts).toHaveLength(0);
  expect(updates).toHaveLength(0);
});

test('a thrown error is contained — and rings ONE deduped bell so the miss is not silent', async () => {
  notifyAdmin.mockClear();
  const { db } = fakeDb({ products: [sign], throwOnInsert: true });
  await expect(consumeCompletionSupplies(db, args)).resolves.toMatchObject({ errors: [{ productId: 'prod-sign', message: 'insert boom' }] });
  expect(notifyAdmin).toHaveBeenCalledTimes(1);
  const [category, title, , opts] = notifyAdmin.mock.calls[0];
  expect(category).toBe('system');
  expect(title).toContain('Sign card');
  expect(opts.bell).toBe(true);
  expect(opts.dedupeKey).toBe('supplies-consumption-failed:prod-sign:svc-1');
});

test('a bell failure on top of a deduction failure is still contained — and recorded, not treated as sent', async () => {
  notifyAdmin.mockImplementationOnce(async () => { throw new Error('bell down'); });
  const { db } = fakeDb({ products: [sign], throwOnInsert: true });
  await expect(consumeCompletionSupplies(db, args)).resolves.toMatchObject({
    errors: [{ productId: 'prod-sign', message: 'insert boom' }, { productId: 'prod-sign', reason: 'failure_bell_not_sent', message: 'bell down' }],
  });
});

test('notifyAdmin resolving null (its own persistence failure) counts as a lost bell (Codex r11 P2)', async () => {
  notifyAdmin.mockImplementationOnce(async () => null);
  const { db } = fakeDb({ products: [sign], throwOnInsert: true });
  const res = await consumeCompletionSupplies(db, args);
  expect(res.errors).toEqual([{ productId: 'prod-sign', message: 'insert boom' }, { productId: 'prod-sign', reason: 'failure_bell_not_sent', message: 'notification not persisted' }]);
  expect(require('../services/logger').error).toHaveBeenCalledWith(expect.stringContaining('failure bell NOT sent'));
});

test('a failed consumables lookup rings ONE visit-scoped deduped bell (Codex r14 P2)', async () => {
  notifyAdmin.mockClear();
  const db = (table) => {
    if (table === 'products_catalog') throw new Error('relation lost');
    const q = {}; for (const m of ['where', 'whereRaw', 'whereNull']) q[m] = () => q; q.first = async () => null; q.update = async () => 1; return q; // the post-bell settled re-check finds nothing
  };
  db.transaction = async () => { throw new Error('unreachable'); };
  const res = await consumeCompletionSupplies(db, args);
  expect(res.errors).toEqual([{ reason: 'lookup_failed', message: 'relation lost' }]);
  expect(notifyAdmin).toHaveBeenCalledTimes(1);
  expect(notifyAdmin.mock.calls[0][3].dedupeKey).toBe('supplies-consumption-failed:lookup:svc-1');
});

// The lookup-failure bell's post-bell re-check re-runs the lookup: the bell is
// retired only when EVERY kit product that applies to the line has a usage
// movement; a lookup that fails again, or one product still owed, keeps the
// bell and the owed marker (Codex r24 P1 → r27 P1).
function lookupBellDb({ retryProducts, movements }) {
  const updates = [];
  let lookups = 0;
  const db = (table) => {
    if (table === 'products_catalog') {
      lookups += 1;
      if (lookups === 1 || retryProducts === null) throw new Error('relation lost');
      const q = {}; for (const m of ['where', 'whereNotNull']) q[m] = () => q; q.select = async () => retryProducts; return q;
    }
    const q = {}; let productId = null;
    q.where = (w) => { if (w && w.product_id) productId = w.product_id; return q; };
    for (const m of ['whereRaw', 'whereNull']) q[m] = () => q;
    q.first = async () => (table === 'product_inventory_movements' && movements.includes(productId) ? { id: `mv-${productId}` } : null);
    q.update = async (row) => { updates.push({ table, row }); return 1; };
    return q;
  };
  db.raw = (sql) => sql;
  return { db, updates };
}
const card = { id: 'prod-card', name: 'Door card', per_completion_usage: '1', per_completion_service_lines: null };
const lawnOnly = { id: 'prod-lawn', name: 'Lawn flag', per_completion_usage: '1', per_completion_service_lines: '["lawn"]' };

test('a lookup bell is retired when the re-run lookup shows EVERY applicable kit product already deducted by the concurrent retry (Codex r24 P1)', async () => {
  notifyAdmin.mockClear();
  const { db, updates } = lookupBellDb({ retryProducts: [sign, card, lawnOnly], movements: ['prod-sign', 'prod-card'] });
  const res = await consumeCompletionSupplies(db, { ...args, serviceLine: 'pest' }); // lawnOnly does not apply to a pest visit
  expect(res.errors).toEqual([{ reason: 'lookup_failed', message: 'relation lost' }]);
  expect(notifyAdmin).toHaveBeenCalledTimes(1);
  expect(updates).toEqual([{ table: 'notifications', row: expect.objectContaining({ read_at: expect.any(Date) }) }]);
});

test('a lookup bell STAYS when one applicable kit product has no movement yet — one movement is not visit-wide settlement (Codex r27 P1)', async () => {
  notifyAdmin.mockClear();
  const { db, updates } = lookupBellDb({ retryProducts: [sign, card], movements: ['prod-sign'] });
  const res = await consumeCompletionSupplies(db, { ...args, serviceLine: 'pest' });
  expect(res.errors).toEqual([{ reason: 'lookup_failed', message: 'relation lost' }]);
  expect(notifyAdmin).toHaveBeenCalledTimes(1);
  expect(updates).toEqual([]);
});

test('a lookup bell STAYS when the re-run lookup fails again, whatever movements exist (Codex r27 P1)', async () => {
  notifyAdmin.mockClear();
  const { db, updates } = lookupBellDb({ retryProducts: null, movements: ['prod-sign'] });
  const res = await consumeCompletionSupplies(db, args);
  expect(res.errors).toEqual([{ reason: 'lookup_failed', message: 'relation lost' }]);
  expect(updates).toEqual([]);
});

test('a successful deduction retires the failure bell an earlier attempt rang for this product + visit — and ONLY that one: the visit-wide lookup bell stays until every kit product is proven settled (Codex r15 P2, hook r27 P1)', async () => {
  const { db, updates } = fakeDb({ products: [sign] });
  await consumeCompletionSupplies(db, args);
  const retired = updates.filter((u) => u.table === 'notifications');
  expect(retired).toHaveLength(1);
  expect(retired[0].key).toBe('supplies-consumption-failed:prod-sign:svc-1'); // never the lookup key from a product clear
  expect(retired[0].row.read_at).toBeInstanceOf(Date);
  expect(String(retired[0].row.metadata)).toContain('autoRetired'); // stamped so it never reads as a staff hand-off (Codex r26 P1)
});

test('a deduction whose obsolete bell could NOT be retired reports bell_retire_failed so the owed marker stays for the next retry (Codex r30 P1)', async () => {
  const { db } = fakeDb({ products: [sign] });
  const inner = db;
  const failing = (table) => { const q = inner(table); if (table === 'notifications') q.update = async () => { throw new Error('notifications lost connection'); }; return q; };
  failing.transaction = db.transaction; failing.raw = db.raw;
  const res = await consumeCompletionSupplies(failing, args);
  expect(res.consumed).toHaveLength(1);
  expect(res.errors).toEqual([{ productId: 'prod-sign', reason: 'bell_retire_failed', message: expect.any(String) }]);
});

test('an open lookup bell is retired at the end of a run only when every applicable kit product has a movement (hook r27 P1)', async () => {
  const { db, updates } = fakeDb({ products: [sign], openLookupBell: true });
  await consumeCompletionSupplies(db, args); // sign is deducted in this run → the one applicable product is settled
  const keys = updates.filter((u) => u.table === 'notifications').map((u) => u.key);
  expect(keys).toEqual(['supplies-consumption-failed:prod-sign:svc-1', 'supplies-consumption-failed:lookup:svc-1']);
});

test('an open lookup bell whose end-of-run re-check is INDETERMINATE (the catalog re-read fails) is a bell_retire_failed — the owed marker stays, the bell is not retired (Codex r31 P1)', async () => {
  const { db, updates } = fakeDb({ products: [sign], openLookupBell: true });
  let catalogReads = 0;
  const flaky = (table) => { const q = db(table); if (table === 'products_catalog') { catalogReads += 1; if (catalogReads > 1) q.select = async () => { throw new Error('catalog lost connection'); }; } return q; };
  flaky.transaction = db.transaction; flaky.raw = db.raw;
  const res = await consumeCompletionSupplies(flaky, args);
  expect(res.consumed).toHaveLength(1); // the main deduction landed
  expect(res.errors).toEqual([{ reason: 'bell_retire_failed', message: expect.stringMatching(/could not be re-checked/) }]);
  expect(updates.filter((u) => u.table === 'notifications').map((u) => u.key)).toEqual(['supplies-consumption-failed:prod-sign:svc-1']); // the product bell only; the lookup bell stands
});

test('a lookup bell this module auto-retired (a concurrent retry deducted the kit) does NOT hand off the next kit product — it is deducted (Codex r26 P1)', async () => {
  const { db, inserts } = fakeDb({ products: [sign], handedOff: 'auto' });
  const res = await consumeCompletionSupplies(db, args);
  expect(res.skipped).toEqual([]);
  expect(res.consumed).toHaveLength(1);
  expect(inserts).toHaveLength(1);
});

test('an already_consumed retry (the movement exists) still retires the stale failure bells (Codex r17 P2)', async () => {
  const { db, updates } = fakeDb({ products: [sign], duplicate: true });
  const res = await consumeCompletionSupplies(db, args);
  expect(res.skipped).toEqual([{ productId: 'prod-sign', reason: 'already_consumed' }]);
  expect(updates.filter((u) => u.table === 'notifications')).toHaveLength(1);
});

test('a successful deduction rings no bell', async () => {
  notifyAdmin.mockClear();
  const { db } = fakeDb({ products: [sign] });
  await consumeCompletionSupplies(db, args);
  expect(notifyAdmin).not.toHaveBeenCalled();
});

const path = require('path');
const describeOrSkip = process.env.DATABASE_URL ? describe : describe.skip;
describeOrSkip('supplies auto-reorder schema (DB-backed)', () => {
  let knex;
  beforeAll(() => {
    const config = require(path.join(__dirname, '..', 'knexfile.js'));
    knex = require('knex')(config.development || config);
  });
  afterAll(async () => { if (knex) await knex.destroy(); });

  test('products_catalog gains the auto-reorder columns', async () => {
    const cols = await knex('products_catalog').columnInfo();
    ['reorder_quantity', 'auto_reorder_vendor_id', 'auto_reorder_enabled', 'per_completion_usage', 'per_completion_service_lines'].forEach((c) => expect(cols).toHaveProperty(c));
    const seeded = await knex('products_catalog').where('name', 'like', 'Pesticide application sign 4x5%').first();
    if (seeded) expect([...seeded.per_completion_service_lines].sort()).toEqual(['lawn', 'mosquito', 'pest', 'tree_shrub']);
    expect(cols.auto_reorder_enabled.nullable).toBe(false);
  });

  test('one live auto_reorder restock request per product is a DB invariant', async () => {
    const idx = await knex('pg_indexes').where({ indexname: 'product_restock_requests_auto_reorder_live_uniq' }).first();
    expect(idx).toBeTruthy();
    expect(idx.indexdef).toMatch(/UNIQUE/);
    const [product] = await knex('products_catalog').insert({ name: `__test reorder ${Date.now()}`, category: 'supplies', inventory_unit: 'each', inventory_on_hand: 5, needs_pricing: false }).returning('id');
    try {
      const row = { product_id: product.id, status: 'open', source: 'auto_reorder', requested_quantity: 1, unit: 'each' };
      await knex('product_restock_requests').insert(row);
      await expect(knex('product_restock_requests').insert(row)).rejects.toMatchObject({ code: '23505' });
      await knex('product_restock_requests').insert({ ...row, source: 'manual' }); // other sources are not constrained
      await knex('product_restock_requests').insert({ ...row, status: 'received' }); // closed rows are not constrained
    } finally {
      await knex('product_restock_requests').where({ product_id: product.id }).del();
      await knex('products_catalog').where({ id: product.id }).del();
    }
  });

  test('the completion_consumable partial unique index exists and rejects a duplicate', async () => {
    const idx = await knex('pg_indexes').where({ indexname: 'product_inventory_movements_completion_consumable_uniq' }).first();
    expect(idx).toBeTruthy();
    expect(idx.indexdef).toMatch(/UNIQUE/);
    expect(idx.indexdef).toMatch(/completion_consumable/);

    const visit = await knex('scheduled_services').select('id').first();
    if (!visit) return; // empty local DB: the index shape above is still proven
    const [product] = await knex('products_catalog').insert({ name: `__test consumable ${Date.now()}`, category: 'supplies', inventory_unit: 'each', inventory_on_hand: 5, needs_pricing: false }).returning('id');
    try {
      const row = { product_id: product.id, scheduled_service_id: visit.id, movement_type: 'usage', quantity: 1, unit: 'each', metadata: { source: 'completion_consumable' } };
      await knex('product_inventory_movements').insert(row);
      await expect(knex('product_inventory_movements').insert(row)).rejects.toMatchObject({ code: '23505' });
      // a different source for the same pair is NOT blocked (partial predicate)
      await knex('product_inventory_movements').insert({ ...row, metadata: { source: 'other' } });
    } finally {
      await knex('product_inventory_movements').where({ product_id: product.id }).del();
      await knex('products_catalog').where({ id: product.id }).del();
    }
  });
});

// ---------------------------------------------------------------------------
// Recap hook source contract (routes/admin-dispatch.js is pinned by source in
// the house style): a priorCompleted recap still consumes when it is a RETRY
// of the completing recap — service record created inside the 15-minute
// window — because submitRecap commits the status before the consumption
// call (PR 2 pre-push P1). Edits of historical completions keep consuming
// nothing.
// ---------------------------------------------------------------------------
describe('recap consumption hook — retry window (source contract)', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '../routes/admin-dispatch.js'), 'utf8');
  const hook = src.slice(src.indexOf('async function recapSuppliesOwed('), src.indexOf("router.post('/:serviceId/pest-recap'"));
  const route = src.slice(src.indexOf("router.post('/:serviceId/pest-recap'"), src.indexOf('router.post(', src.indexOf("router.post('/:serviceId/pest-recap'") + 10));

  test('the retry signal is the durable completion_supplies_owed marker the recap transition wrote, read and cleared by the hook — never record age', () => {
    const recapSrc = fs.readFileSync(path.join(__dirname, '../services/pest-recap.js'), 'utf8');
    // update branch: the shared marker helper; insert branch: the literal inside the fresh field_flags object. Both gated on !recapPriorCompleted.
    expect(recapSrc.match(/completion_supplies_owed: true/g)).toHaveLength(1);
    expect(recapSrc).toMatch(/\.\.\.\(recapPriorCompleted \? \{\} : \{ field_flags: completionSuppliesOwedMarker\(trx\) \}\)/);
    expect(hook).toMatch(/if \(result\.priorCompleted !== true\) return true;/);
    expect(hook).toMatch(/completionSuppliesOwed\(await db\('service_records'\)\.where\(\{ id: result\.recordId \}\)\.first\('field_flags'\)\)/);
    // A failed marker read is NOT owed (hook r27 P1): a historical completion edited today has no movement for the index to stop; the marker stays for the next recap.
    expect(hook).toMatch(/settlement deferred, marker kept/);
    expect(hook).not.toMatch(/consuming anyway:/); // the old warn-and-return-true branch
    // Consume + clear-unless-bell-lost is the SHARED lifecycle (settleOwedCompletionSupplies, unit-tested above), not a route-local copy (GH codex #3996 r3 P1).
    expect(hook).toMatch(/await settleOwedCompletionSupplies\(db, \{/);
    expect(hook).toMatch(/serviceRecordId: result\.recordId \|\| null,/);
    expect(hook).not.toMatch(/handoffLost|- 'completion_supplies_owed'/);
    expect(hook).not.toMatch(/RECAP_RETRY_WINDOW_MS|created_at/);
    expect(hook).toMatch(/if \(!\(await recapSuppliesOwed\(result\)\)\) return;/);
    expect(route).toMatch(/await settleRecapSupplies\(req\.params\.serviceId, result\);/); // the recap route runs the settlement after submitRecap
    expect(route).toMatch(/if \(!result\.ok\) return res\.status\(recapStatusForReason\(result\.reason\)\)/);
  });
});
