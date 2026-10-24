/**
 * The found-codes bell (owner ruling 2026-10-24) against live Postgres: the
 * standing row's whole life through the real notification service and alert
 * episodes, under the production bell policy (GATE_ADMIN_BELL_POLICY on, so an
 * access_codes row lands only because the category rings by default). A first
 * list rings; the same list again is quiet; a code that leaves refreshes it
 * quietly (read and done stay as a person left them); a code that joins rings
 * again and moves the row to the top; an empty list closes it done; a comeback
 * rings. The codes come from a stubbed list, so other suites' rows never join,
 * and the row carries this run's own key, so cleanup touches only rows this
 * suite wrote. It refuses any database but a private QA one or CI's.
 */
process.env.GATE_ADMIN_BELL_POLICY = 'true'; // read once, when feature-gates loads
const { randomUUID } = require('crypto');

const SKIP = !process.env.DATABASE_URL;
const maybeDescribe = SKIP ? describe.skip : describe;

afterAll(async () => { if (!SKIP) await require('../models/db').destroy(); });

maybeDescribe('found-codes bell (live Postgres)', () => {
  let db;
  let Bell;
  let NotificationService;
  const KEY = `access-codes-found-test-${randomUUID()}`;
  const NOW = new Date('2026-10-24T14:00:00Z');

  beforeAll(() => {
    const target = new URL(process.env.DATABASE_URL);
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(target.pathname);
    const ci = process.env.CI === 'true' && ['localhost', '127.0.0.1'].includes(target.hostname) && target.pathname === '/waves_test';
    if (!privateQa && !ci) throw new Error('Use a private QA or isolated CI database');
    db = require('../models/db');
    Bell = require('../services/access-code-found-bell');
    NotificationService = require('../services/notification-service');
  });
  afterAll(async () => {
    if (db) await rows().del();
  });

  const rows = () => db('notifications').where({ recipient_type: 'admin' }).whereRaw("metadata->>'dedupeKey' = ?", [KEY]);
  const standing = async () => {
    const all = await rows();
    expect(all).toHaveLength(1);
    return all[0];
  };
  const code = (id, over = {}) => ({
    id, customerId: randomUUID(), customerName: 'Pat Synthetic', kind: 'door', code: '4821', life: 'standing',
    status: 'found', sourceType: 'sms', sourceQuote: 'Door code is 4821', sourceAt: '2026-10-24T11:16:45.000Z',
    createdAt: '2026-10-24T11:17:00.000Z', suggestedCustomer: null, ...over,
  });
  const run = (items) => Bell.syncFoundCodesBell({
    now: NOW, gateEnabled: true, sectionOn: true, dedupeKey: KEY,
    ids: async () => items.map((row) => row.id), list: async () => ({ total: items.length, items }),
  });

  test('raise, quiet repeat, quiet leave, a person\'s done, a new code rings, silenced closes, closed at zero, a comeback rings', async () => {
    const a = randomUUID();
    const b = randomUUID();
    const c = randomUUID();

    // 1. The first list rings: one unread access_codes row with the codes as its item keys.
    await expect(run([code(b), code(a, { kind: 'lockbox', customerName: 'Kim Sample' })])).resolves.toEqual({ count: 2, outcome: 'raised' });
    let row = await standing();
    expect(row.category).toBe('access_codes');
    expect(row.title).toBe('Customers — review 2 codes found in messages');
    expect(row.link).toBe('/admin/customers/gate-codes?view=found');
    expect(row.read_at).toBeNull();
    expect(row.metadata).toMatchObject({ itemKeys: [a, b].sort(), count: 2, area: 'Customers', severity: 'needs-you', doneWhen: 'count_zero' });
    expect(`${row.title}\n${row.body}\n${row.detail}`).not.toContain('4821');
    const firstId = row.id;

    // 2. The same list again changes nothing.
    await expect(run([code(b), code(a, { kind: 'lockbox', customerName: 'Kim Sample' })])).resolves.toEqual({ count: 2, outcome: 'unchanged' });

    // 3. A person reads it; the office saves one code: a quiet refresh that keeps the read.
    await db('notifications').where({ id: firstId }).update({ read_at: new Date('2026-10-24T14:01:00Z') });
    await expect(run([code(b)])).resolves.toEqual({ count: 1, outcome: 'refreshed' });
    row = await standing();
    expect(row.id).toBe(firstId);
    expect(row.title).toBe('Customers — review the door code from Pat Synthetic');
    expect(new Date(row.read_at).toISOString()).toBe('2026-10-24T14:01:00.000Z');

    // 4. A person marks it done while the code still waits: the same list stays done.
    expect(await NotificationService.markAdminDone([firstId], { by: '7', resolution: 'Saving it after lunch' })).toBe(1);
    await run([code(b)]);
    row = await standing();
    expect(row.done_at).not.toBeNull();
    expect(row.resolution).toBe('Saving it after lunch');

    // 5. A new code joins: the row rings again (unread, not done) and moves to the top.
    const before = new Date(row.created_at).getTime();
    await expect(run([code(c, { kind: 'pass', customerId: null, customerName: null }), code(b)])).resolves.toEqual({ count: 2, outcome: 'raised' });
    row = await standing();
    expect([row.read_at, row.done_at]).toEqual([null, null]);
    expect(new Date(row.created_at).getTime()).toBeGreaterThan(before);
    expect(row.metadata.itemKeys).toEqual([b, c].sort());

    // 6. The owner silences the category in Settings: a new code does not ring
    //    the standing row; it closes. Unsilenced, the codes still waiting ring it again.
    const bellPolicy = require('../services/notification-bell-policy');
    const silence = jest.spyOn(bellPolicy, 'bellAllowed').mockResolvedValue(false);
    const d = randomUUID();
    await expect(run([code(d), code(c, { kind: 'pass', customerId: null, customerName: null }), code(b)])).resolves.toEqual({ count: 0, outcome: 'closed' });
    row = await standing();
    expect(row.done_at).not.toBeNull();
    expect(row.resolution).toBe('Gate codes found in messages are silenced in Settings');
    expect(row.metadata.itemKeys).toEqual([b, c].sort());
    silence.mockRestore();
    await expect(run([code(d), code(c, { kind: 'pass', customerId: null, customerName: null }), code(b)])).resolves.toEqual({ count: 3, outcome: 'raised' });
    row = await standing();
    expect([row.read_at, row.done_at]).toEqual([null, null]);
    expect(row.metadata.itemKeys).toEqual([b, c, d].sort());

    // 7. Nothing waits: the row closes itself as done.
    await expect(run([])).resolves.toEqual({ count: 0, outcome: 'closed' });
    row = await standing();
    expect(row.done_by).toBe('episodes');
    expect(row.resolution).toBe('No codes are waiting');
    expect(row.metadata.autoCleared).toBe(true);
    await expect(run([])).resolves.toEqual({ count: 0, outcome: 'clear' });

    // 8. A code waits again: a comeback rings, even for a code the row named before.
    await expect(run([code(b)])).resolves.toMatchObject({ count: 1 });
    row = await standing();
    expect([row.read_at, row.done_at]).toEqual([null, null]);
    expect(row.metadata.autoCleared).toBe(false);
    expect(row.title).toBe('Customers — review the door code from Pat Synthetic');
  });

  test('with no stub it lists what the Gate codes page lists, inside one rolled-back transaction', async () => {
    const access = require('../services/access-code-capture');
    const ownKey = `${KEY}-real`;
    const trx = await db.transaction();
    try {
      const customerId = randomUUID();
      await trx('customers').insert({ id: customerId, first_name: 'Sample', last_name: 'Owner', phone: '+19415550142', email: `${customerId}@example.invalid` });
      const propertyId = randomUUID();
      await trx('customer_properties').insert({
        id: propertyId, customer_id: customerId, label: 'Synthetic', occupancy_type: 'owner_occupied', is_primary: true,
        address_line1: '4455 Example Lane', city: 'Lakewood Ranch', zip: '34202', active: true, address_key: randomUUID(),
      });
      const [found] = await trx('customer_access_codes').insert({
        property_id: propertyId, customer_id: customerId, kind: 'door', code: '4821', instructions: null, life: 'standing',
        status: 'found', source_type: 'sms', source_id: randomUUID(), source_quote: 'Door code is 4821', source_at: NOW,
        value_hash: access.valueHash('4821', null),
      }).returning('*');
      const listed = await access.listFound(trx, { limit: 50, offset: 0 });
      expect(listed.items.map((item) => item.id)).toContain(found.id);
      const waiting = await access.listFoundIds(trx);
      expect(waiting).toContain(found.id);
      expect(waiting).toHaveLength(listed.total);

      await expect(Bell.syncFoundCodesBell({ now: NOW, conn: trx, gateEnabled: true, sectionOn: true, dedupeKey: ownKey }))
        .resolves.toEqual({ count: listed.total, outcome: 'raised' });
      const [row] = await trx('notifications').where({ recipient_type: 'admin' }).whereRaw("metadata->>'dedupeKey' = ?", [ownKey]);
      expect(row.category).toBe('access_codes');
      expect(row.metadata.itemKeys).toContain(found.id);
      expect(row.metadata.count).toBe(listed.total);
      expect(`${row.title}\n${row.body}\n${row.detail}`).not.toContain('4821');
      if (listed.total === 1) expect(row.title).toBe('Customers — review the door code from Sample Owner');
    } finally {
      await trx.rollback();
    }
  });
});
