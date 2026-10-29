// Bid kit Product List sync (GATE_BID_KIT_PRODUCT_LIST_SYNC) through PostgreSQL: the 12-month product query, the SiteOne
// purchase lookup, the file replacement with its details merge and system sign-off, and the whole daily run on real rows.
// The bell service and S3 are stand-ins (their SQL runs elsewhere); the kit's own SQL is real. Every write runs in a
// transaction that is rolled back. Synthetic data only. Skips without DATABASE_URL (CI runs it against the migrated database).
const SKIP = !process.env.DATABASE_URL;

jest.mock('../models/db', () => {
  const db = (...args) => mockPg(...args);
  for (const name of ['raw', 'transaction', 'queryBuilder', 'ref']) db[name] = (...args) => mockPg[name](...args);
  for (const name of ['schema', 'fn']) Object.defineProperty(db, name, { get: () => mockPg[name] });
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config', () => ({ s3: { region: 'us-east-1', bucket: 'test-bucket' } }));
jest.mock('../services/admin-alert-episodes', () => ({
  raiseAdminAlertWithReopen: jest.fn(), openAdminAlertKeys: jest.fn(), closeAdminAlertKeys: jest.fn(),
}));
const mockSent = [];
jest.mock('@aws-sdk/client-s3', () => {
  class Command { constructor(input) { this.input = input; } }
  return {
    S3Client: class { async send(command) { mockSent.push(command); return {}; } },
    PutObjectCommand: class PutObjectCommand extends Command {},
    GetObjectCommand: class GetObjectCommand extends Command {},
    DeleteObjectCommand: class DeleteObjectCommand extends Command {},
  };
});
jest.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: jest.fn() }));

const knex = require('knex');
const { randomUUID } = require('crypto');
const episodes = require('../services/admin-alert-episodes');
const store = require('../services/bid-kit-store');
const catalog = require('../../shared/bid-kit-catalog.cjs');
const lib = require('../services/bid-kit-product-list');

const describeDb = SKIP ? describe.skip : describe;
jest.setTimeout(60000);
let database;
let mockPg;
const puts = () => mockSent.filter((c) => c.constructor.name === 'PutObjectCommand');
const deletes = () => mockSent.filter((c) => c.constructor.name === 'DeleteObjectCommand').map((c) => c.input.Key);

describeDb('Bid kit Product List sync (PostgreSQL)', () => {
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL);
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(url.pathname);
    const ciTest = process.env.CI === 'true' && ['localhost', '127.0.0.1'].includes(url.hostname) && url.pathname === '/waves_test';
    if (!privateQa && !ciTest) throw new Error('Use a verified, task-private QA database or the isolated CI database');
    database = knex({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 4 } });
    mockPg = database;
    process.env.GATE_BID_KIT = 'true';
    process.env.GATE_BID_KIT_PRODUCT_LIST_SYNC = 'true';
  });
  beforeEach(async () => {
    mockPg = await database.transaction();
    customerId = null;
    visits = new Map();
    mockSent.length = 0;
    for (const fn of Object.values(episodes)) fn.mockReset();
    episodes.raiseAdminAlertWithReopen.mockImplementation(async () => ({ id: randomUUID(), deduped: false, rang: true }));
    episodes.openAdminAlertKeys.mockResolvedValue([]);
    episodes.closeAdminAlertKeys.mockResolvedValue(0);
  });
  afterEach(async () => { const trx = mockPg; mockPg = database; await trx.rollback(); });
  afterAll(async () => {
    delete process.env.GATE_BID_KIT;
    delete process.env.GATE_BID_KIT_PRODUCT_LIST_SYNC;
    if (database) await database.destroy();
  });

  // ---- fixtures ----
  const tag = randomUUID().slice(0, 8);
  const catalogRow = async (name, over = {}) => (await mockPg('products_catalog').insert({
    name: `${name} ${tag}`, category: 'Insecticide', active_ingredient: 'synthetic ingredient', epa_reg_number: '100-200',
    label_url: 'https://labels.example.test/x.pdf', sds_url: 'https://sds.example.test/x.pdf', ...over,
  }).returning('*'))[0];
  // One visit per age (service_date = that many days before today, Eastern): the window counts the VISIT date, so a line's own
  // created_at (rewritten when an old recap is edited) can say anything. writtenDaysAgo sets that created_at.
  let customerId;
  let visits;
  const visit = async (daysAgo) => {
    if (!customerId) {
      customerId = (await mockPg('customers').insert({ first_name: 'Fixture', last_name: 'Customer', phone: `+1555${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}` }).returning('id'))[0].id;
    }
    if (!visits.has(daysAgo)) {
      visits.set(daysAgo, (await mockPg('service_records').insert({
        customer_id: customerId, service_type: 'Fixture visit',
        service_date: mockPg.raw("(now() AT TIME ZONE 'America/New_York')::date - ?::int", [daysAgo]),
      }).returning('id'))[0]);
    }
    return visits.get(daysAgo);
  };
  const apply = async (product, { daysAgo = 10, writtenDaysAgo = 0 } = {}) => {
    await mockPg('service_products').insert({
      service_record_id: (await visit(daysAgo)).id, product_id: product.id, product_name: product.name,
      created_at: mockPg.raw(`now() - interval '${writtenDaysAgo} days'`),
    });
  };
  let line = 0;
  const purchase = (product, over = {}) => mockPg('purchase_receipt_lines').insert({
    vendor: 'siteone', order_number: `FX-${tag}`, shipment_key: 'ship', line_no: (line += 1), raw_title: 'fixture line', quantity: 1,
    status: 'logged', product_id: product.id, ...over,
  });
  const kitItem = async () => (await store.createItem({ kind: 'document', item_key: 'product_list', label: 'Product list' }, { unique: true })).item;
  const signOff = (id) => mockPg('bid_kit_items').where({ id }).update({ attested_at: mockPg.fn.now() });
  const rowOf = (id) => mockPg('bid_kit_items').where({ id }).first();
  const mine = (rows) => rows.filter((r) => r.name.endsWith(tag));

  test('bid products: only active ticked catalog rows that no visit applied in the 12 months, same columns, sorted', async () => {
    const applied = await catalogRow('Applied ticked', { bid_list: true });
    await catalogRow('Bid bravo', { bid_list: true, category: 'Termiticide' });
    await catalogRow('Bid alpha', { bid_list: true, category: 'Termiticide' });
    await catalogRow('Inactive ticked', { bid_list: true, active: false });
    await catalogRow('Unticked');
    const oldApplied = await catalogRow('Applied long ago', { bid_list: true });
    await apply(applied); await apply(oldApplied, { daysAgo: 400 });
    const { rows, bidRows } = await lib.readProductList();
    expect(mine(rows).map((r) => r.name)).toEqual([`Applied ticked ${tag}`]);
    // Category first (Insecticide, then Termiticide), then name.
    expect(mine(bidRows).map((r) => r.name)).toEqual([`Applied long ago ${tag}`, `Bid alpha ${tag}`, `Bid bravo ${tag}`]);
    expect(mine(bidRows)[0]).toMatchObject({ product_id: oldApplied.id, epa_reg_number: '100-200', uses: 0 });
  });
  test('reads each product applied in the last 12 months once, with its use count; older products and unapplied ones are left out', async () => {
    const a = await catalogRow('Alpha');
    const b = await catalogRow('Bravo', { category: null });
    const old = await catalogRow('Old');
    await catalogRow('Never applied');
    await apply(a); await apply(a, { daysAgo: 300 }); await apply(b); await apply(old, { daysAgo: 400 });
    const rows = mine(await lib.readProductRows());
    expect(rows.map((r) => r.name)).toEqual([`Alpha ${tag}`, `Bravo ${tag}`]);
    expect(Number(rows[0].uses)).toBe(2);
  });

  test('the 12 months are counted on the visit date: a line rewritten today for an old visit stays out, a recent visit stays in whenever its line was written', async () => {
    const reinserted = await catalogRow('Reinserted'); // an old recap was edited: fresh created_at, old service_date
    const recentVisit = await catalogRow('Recent visit'); // a recent visit whose line carries an old created_at
    const edge = await catalogRow('Edge in');
    const justOut = await catalogRow('Edge out');
    await apply(reinserted, { daysAgo: 500, writtenDaysAgo: 0 });
    await apply(recentVisit, { daysAgo: 5, writtenDaysAgo: 500 });
    await apply(edge, { daysAgo: 364 });
    await apply(justOut, { daysAgo: 365 });
    const unlinkedAt = async (name, daysAgo) => mockPg('service_products').insert({ service_record_id: (await visit(daysAgo)).id, product_id: null, product_name: name });
    await unlinkedAt(`Old free text ${tag}`, 500); // written today, visit long ago
    await unlinkedAt(`Recent free text ${tag}`, 5);
    const list = await lib.readProductList();
    expect(mine(list.rows).map((r) => r.name)).toEqual([`Edge in ${tag}`, `Recent visit ${tag}`]);
    expect(list.unmatched.map((u) => u.name).filter((n) => n.endsWith(tag))).toEqual([`Recent free text ${tag}`]);
  });

  test('visits on an internal test account never count, linked or typed by hand; the same product on a customer visit does', async () => {
    const { INTERNAL_TEST_CUSTOMERS } = require('../services/internal-test-customers');
    const [first, ...rest] = INTERNAL_TEST_CUSTOMERS[0].split(' ');
    // The list is kept lowercase; the record's own capitals must not matter.
    const dummy = (await mockPg('customers').insert({
      first_name: first.toUpperCase(), last_name: rest.join(' '), phone: `+1555${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`,
    }).returning('id'))[0].id;
    const dummyVisit = (await mockPg('service_records').insert({
      customer_id: dummy, service_type: 'Fixture visit', service_date: mockPg.raw("(now() AT TIME ZONE 'America/New_York')::date - 10"),
    }).returning('id'))[0].id;
    const testOnly = await catalogRow('Seeded only');
    const both = await catalogRow('Both');
    await mockPg('service_products').insert([
      { service_record_id: dummyVisit, product_id: testOnly.id, product_name: testOnly.name },
      { service_record_id: dummyVisit, product_id: both.id, product_name: both.name },
      { service_record_id: dummyVisit, product_id: null, product_name: `Seeded typed ${tag}` },
    ]);
    await apply(both);
    const list = await lib.readProductList();
    expect(mine(list.rows).map((r) => [r.name, Number(r.uses)])).toEqual([[`Both ${tag}`, 1]]);
    expect(list.unmatched.map((u) => u.name).filter((n) => n.endsWith(tag))).toEqual([]);
  });

  test('visit lines with no catalog id fold into the one exact catalog match (inactive when it is the only one) and the rest are named, not printed', async () => {
    const linked = await catalogRow('Taurus');
    const inactiveOnly = await catalogRow('Retired', { active: false });
    const twinA = await catalogRow('Twin');
    await catalogRow('Twin');
    await apply(linked);
    const unlinked = async (name, daysAgo = 10) => mockPg('service_products').insert({
      service_record_id: (await visit(daysAgo)).id, product_id: null, product_name: name,
    });
    await unlinked(`taurus  ${tag.toUpperCase()}`); await unlinked(`Taurus-${tag}`);
    await unlinked(`Retired ${tag}`);
    await unlinked(`Twin ${tag}`);
    await unlinked(`Nothing like it ${tag}`);
    await unlinked(`Taurus ${tag}`, 400); // outside the 12 months
    const list = await lib.readProductList();
    const rows = mine(list.rows);
    expect(rows.map((r) => [r.name, Number(r.uses)])).toEqual([[`Retired ${tag}`, 1], [`Taurus ${tag}`, 3]]);
    expect(rows.find((r) => r.name === `Retired ${tag}`).product_id).toBe(inactiveOnly.id);
    expect(rows.find((r) => r.name === `Taurus ${tag}`).product_id).toBe(linked.id);
    expect(list.rows.map((r) => r.product_id)).not.toContain(twinA.id);
    expect(list.unmatched.filter((u) => u.name.endsWith(tag) || u.name.endsWith(tag.toUpperCase())).map((u) => [u.name, u.uses]).sort())
      .toEqual([[`Nothing like it ${tag}`, 1], [`Twin ${tag}`, 1]]);
  });

  test('a product counts as bought from SiteOne only with a logged SiteOne line for it', async () => {
    const bought = await catalogRow('Bought');
    const amazon = await catalogRow('Amazon');
    const unmatched = await catalogRow('Unmatched');
    const cheapest = await catalogRow('Cheapest', { best_vendor: 'siteone' });
    await purchase(bought); await purchase(amazon, { vendor: 'amazon' }); await purchase(unmatched, { status: 'unmatched' });
    const found = await lib.siteOnePurchased([bought.id, amazon.id, unmatched.id, cheapest.id]);
    expect([...found]).toEqual([bought.id]);
  });

  test('replaceFile with options merges details, keeps the other keys, and signs off as the system with no signer', async () => {
    const item = await kitItem();
    await mockPg('bid_kit_items').where({ id: item.id }).update({ details: JSON.stringify({ other: 1 }) });
    const first = await store.replaceFile(item.id, { key: 'bid-kit/x/a.pdf', fileName: 'a.pdf', contentType: 'application/pdf', size: 10 }, item.updated_at, { attestBySystem: true, details: { product_list_sync: { fingerprint: 'f' } } });
    expect(first.item.details).toEqual({ other: 1, product_list_sync: { fingerprint: 'f' } });
    expect(first.item.attested_by).toBeNull();
    expect(first.item.attested_at).toBeInstanceOf(Date);
    expect(catalog.itemStatus(first.item, { today: '2026-10-26' })).toBe(catalog.STATUS.READY);
    // Without options (the route's call) the sign-off is cleared and the details stay.
    const second = await store.replaceFile(item.id, { key: 'bid-kit/x/b.pdf', fileName: 'b.pdf', contentType: 'application/pdf', size: 10 }, first.item.updated_at);
    expect(second.item.attested_at).toBeNull();
    expect(second.item.details.product_list_sync.fingerprint).toBe('f');
    // A stale version is refused and nothing is written.
    expect(await store.replaceFile(item.id, { key: 'bid-kit/x/c.pdf', fileName: 'c.pdf', contentType: 'application/pdf', size: 10 }, item.updated_at, { attestBySystem: true })).toEqual({ conflict: true });
  });

  test('the whole run: first build asks, a SiteOne addition signs itself off, an Amazon addition asks again', async () => {
    const item = await kitItem();
    const a = await catalogRow('Alpha'); const b = await catalogRow('Bravo');
    await apply(a); await apply(b);

    // 1. First run: a PDF is stored, the row is unsigned, one bell.
    expect(await lib.runBidKitProductListSync()).toMatchObject({ changed: true, signedOff: false, reasons: ['first_run'] });
    expect(puts()).toHaveLength(1);
    expect(puts()[0].input.Body.slice(0, 4).toString('latin1')).toBe('%PDF');
    let row = await rowOf(item.id);
    expect(row.attested_at).toBeNull();
    expect(row.file_name).toMatch(/^product-list-\d{4}-\d{2}-\d{2}\.pdf$/);
    expect(row.details.product_list_sync.rows).toHaveLength(2);
    expect(episodes.raiseAdminAlertWithReopen).toHaveBeenCalledTimes(1);
    expect(episodes.raiseAdminAlertWithReopen.mock.calls[0][3].dedupeKey).toBe(`bid-kit:product-list:${item.id}`);

    // Same list again: nothing.
    expect(await lib.runBidKitProductListSync()).toEqual({ changed: false });
    expect(puts()).toHaveLength(1);

    // 2. The owner signs off; a product bought from SiteOne is added: the file is replaced and signed off by the system.
    await signOff(item.id);
    const c = await catalogRow('Charlie');
    await apply(c); await purchase(c);
    const firstKey = row.file_s3_key;
    expect(await lib.runBidKitProductListSync()).toEqual({ changed: true, signedOff: true, rang: false });
    row = await rowOf(item.id);
    expect(row.attested_by).toBeNull();
    expect(row.attested_at).not.toBeNull();
    expect(row.file_s3_key).not.toBe(firstKey);
    expect(deletes()).toContain(firstKey);
    expect(episodes.raiseAdminAlertWithReopen).toHaveBeenCalledTimes(1);
    const log = await mockPg('activity_log').where({ action: 'bid_kit_attested' }).orderBy('created_at', 'desc').first();
    expect(log.admin_user_id).toBeNull();
    expect(JSON.parse(typeof log.metadata === 'string' ? log.metadata : JSON.stringify(log.metadata))).toMatchObject({ bid_kit_item_id: item.id, auto: 'siteone_purchases', added: [`Charlie ${tag}`] });

    // 3. A product with no SiteOne purchase is added: the file is replaced, the sign-off is gone, one bell names it.
    const d = await catalogRow('Delta');
    await apply(d);
    expect(await lib.runBidKitProductListSync()).toMatchObject({ changed: true, signedOff: false, reasons: ['not_siteone'] });
    row = await rowOf(item.id);
    expect(row.attested_at).toBeNull();
    expect(episodes.raiseAdminAlertWithReopen).toHaveBeenCalledTimes(2);
    expect(episodes.raiseAdminAlertWithReopen.mock.calls[1][2]).toBe(`Added Delta ${tag} (not a SiteOne purchase); check and sign off.`);
  });

  test('a bell that failed to raise survives on the row, is raised on the next run, and clearing it leaves the sign-off and the rest alone', async () => {
    const item = await kitItem();
    const a = await catalogRow('Alpha');
    await apply(a);
    episodes.raiseAdminAlertWithReopen.mockRejectedValueOnce(new Error('bell down'));
    expect(await lib.runBidKitProductListSync()).toEqual({ failed: true });
    let row = await rowOf(item.id);
    expect(row.attested_at).toBeNull();
    expect(row.details.product_list_sync.pending_alert).toEqual({ why: expect.any(String), detail: expect.any(String) });
    const saved = row.details.product_list_sync;
    // Next run: same list, same file, but the words are still there: the bell is raised again (same key and version), then cleared.
    expect(await lib.runBidKitProductListSync()).toEqual({ changed: false });
    expect(episodes.raiseAdminAlertWithReopen).toHaveBeenCalledTimes(2);
    expect(episodes.raiseAdminAlertWithReopen.mock.calls[1][2]).toBe(saved.pending_alert.why);
    expect(episodes.raiseAdminAlertWithReopen.mock.calls[1][3]).toMatchObject({ dedupeKey: `bid-kit:product-list:${item.id}`, dedupeVersion: saved.fingerprint });
    row = await rowOf(item.id);
    expect(row.details.product_list_sync).not.toHaveProperty('pending_alert');
    expect(row.details.product_list_sync).toMatchObject({ fingerprint: saved.fingerprint, file_ref: saved.file_ref });
    expect(row.attested_at).toBeNull();
    expect(row.file_s3_key).toBeTruthy();
    // Third run: nothing.
    expect(await lib.runBidKitProductListSync()).toEqual({ changed: false });
    expect(episodes.raiseAdminAlertWithReopen).toHaveBeenCalledTimes(2);
  });

  test('an unchanged list with a file replaced by hand is rebuilt once and flagged, never signed off; the next run does nothing', async () => {
    const item = await kitItem();
    await apply(await catalogRow('Alpha'));
    await lib.runBidKitProductListSync();
    await signOff(item.id);
    // The owner uploads a file by hand: the route's replaceFile (no options) clears the sign-off and leaves the details.
    let row = await rowOf(item.id);
    await store.replaceFile(item.id, { key: `bid-kit/${item.id}/by-hand.pdf`, fileName: 'mine.pdf', contentType: 'application/pdf', size: 10 }, row.updated_at);
    await signOff(item.id);
    expect(await lib.runBidKitProductListSync()).toMatchObject({ changed: true, signedOff: false, reasons: ['file_replaced'] });
    row = await rowOf(item.id);
    expect(row.attested_at).toBeNull();
    expect(row.file_name).toMatch(/^product-list-/);
    expect(deletes()).toContain(`bid-kit/${item.id}/by-hand.pdf`);
    expect(episodes.raiseAdminAlertWithReopen).toHaveBeenCalledTimes(2);
    expect(await lib.runBidKitProductListSync()).toEqual({ changed: false });
  });

  test('a NEW free-text visit line is never signed off unseen; one the signed snapshot already knew is not a blocker', async () => {
    const item = await kitItem();
    await apply(await catalogRow('Alpha'));
    const freeText = async (name) => mockPg('service_products').insert({ service_record_id: (await visit(10)).id, product_id: null, product_name: name });
    await lib.runBidKitProductListSync();
    await signOff(item.id);
    // A technician's recap carries a pesticide typed as text: nothing prints, so the kit asks instead of signing off.
    await freeText(`Novel pesticide ${tag}`);
    expect(await lib.runBidKitProductListSync()).toMatchObject({ changed: true, signedOff: false, reasons: ['unmatched_new'] });
    let row = await rowOf(item.id);
    expect(row.attested_at).toBeNull();
    expect(row.details.product_list_sync.unmatched).toEqual([`novel pesticide ${tag}`]);
    expect(episodes.raiseAdminAlertWithReopen.mock.calls.at(-1)[3].detail).toContain(`Novel pesticide ${tag}`);
    // The owner checks and signs off; the same free text is now known, so a SiteOne-only addition signs itself off.
    await signOff(item.id);
    const bought = await catalogRow('Bought');
    await apply(bought); await purchase(bought);
    expect(await lib.runBidKitProductListSync()).toMatchObject({ changed: true, signedOff: true });
    row = await rowOf(item.id);
    expect(row.attested_at).not.toBeNull();
    expect(row.details.product_list_sync.unmatched).toEqual([`novel pesticide ${tag}`]);
  });

  test('a product taken off a recent visit record (its last use) is never signed off by the system: unsigned, one bell names it', async () => {
    const item = await kitItem();
    const keep = await catalogRow('Keep'); const drop = await catalogRow('Drop');
    await apply(keep); await apply(drop);
    await lib.runBidKitProductListSync();
    await signOff(item.id);
    // A recap edit deletes the line: the product has no use left in the window.
    await mockPg('service_products').where({ product_id: drop.id }).del();
    expect(await lib.runBidKitProductListSync()).toMatchObject({ changed: true, signedOff: false, reasons: ['removed'] });
    const row = await rowOf(item.id);
    expect(row.attested_at).toBeNull();
    expect(row.details.product_list_sync.rows.map((r) => r.name)).toEqual([`Keep ${tag}`]);
    expect(episodes.raiseAdminAlertWithReopen.mock.calls.at(-1)[2]).toBe(`Removed Drop ${tag}; check and sign off.`);
  });

  test('a kit with no product list item is left alone', async () => {
    expect(await lib.runBidKitProductListSync()).toEqual({ skipped: 'no_item' });
    expect(puts()).toHaveLength(0);
  });
});
