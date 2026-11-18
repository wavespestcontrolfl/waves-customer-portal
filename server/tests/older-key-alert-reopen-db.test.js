/**
 * A text follow-up alert an older build keyed on the promise (`sms-commitment:<id>`) or on its text
 * (`sms-commitment-source:<id>`) comes back open on every path that reopens a closed admin alert, and takes the
 * customer's key as it does (adoptOlderKeyAlerts, server/services/sms-operational-actions.js). Then it folds,
 * closes and settles with its promises like a row written today. The four reopen paths: a person's Reopen
 * (NotificationService.reopenAdminDone), the promise age-out undo (reopenPromiseAgeOut), the retention undo
 * (undoRetentionRun) and the quiet fall-off undo (reopenQuietFallOff). Postgres only (DATABASE_URL); synthetic data.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { randomUUID } = require('node:crypto');

const SKIP = !process.env.DATABASE_URL;
const maybeDescribe = SKIP ? describe.skip : describe;

const DAY = 24 * 60 * 60 * 1000;
const OUR_NUMBER = '+15555550100';

jest.setTimeout(30000);

maybeDescribe('older-key text alerts that reopen (live Postgres)', () => {
  let db;
  let notifications;
  let ageOut;
  let retention;
  let actions;
  const made = { customers: [], texts: [], promises: [], alerts: [], runs: [] };
  const now = new Date();
  const ago = (days) => new Date(now.getTime() - DAY * days);
  const token = () => randomUUID().replaceAll('-', '');

  beforeAll(() => {
    // Done on a text follow-up alert settles its promises only while the text follow-up lane is on.
    process.env.GATE_SMS_OPERATIONAL_ACTIONS = 'true';
    process.env.GATE_SMS_COMMITMENT_FOLLOWUP = 'true';
    db = require('../models/db');
    notifications = require('../services/notification-service');
    ageOut = require('../services/promise-age-out');
    retention = require('../services/admin-alert-retention');
    actions = require('../services/sms-operational-actions');
  });
  afterAll(async () => {
    delete process.env.GATE_SMS_OPERATIONAL_ACTIONS;
    delete process.env.GATE_SMS_COMMITMENT_FOLLOWUP;
    const del = async (table, ids) => { if (ids.length) await db(table).whereIn('id', ids).del(); };
    if (made.runs.length) await db('audit_log').whereRaw("metadata->>'runId' = ANY(?::text[])", [made.runs]).del();
    if (made.customers.length) await db('notifications').whereRaw("metadata->>'customerId' = ANY(?::text[])", [made.customers]).del();
    await del('notifications', made.alerts);
    await del('call_commitments', made.promises);
    await del('sms_log', made.texts);
    await del('customers', made.customers);
    await db.destroy();
  });

  const alertRow = (id) => db('notifications').where({ id }).first();
  const meta = (r) => (typeof r.metadata === 'string' ? JSON.parse(r.metadata) : r.metadata);
  const openFor = (customerId) => db('notifications').where({ recipient_type: 'admin' }).whereNull('done_at')
    .whereRaw("metadata->>'dedupeKey' LIKE 'sms-commitment%'").whereRaw("metadata->>'customerId' = ?", [customerId]).pluck('id');
  const doneToken = async (id) => (await db.raw('SELECT done_at::text AS t FROM notifications WHERE id = ?', [id])).rows[0].t;

  async function customer() {
    const digits = String(Math.floor(Math.random() * 1e7)).padStart(7, '0');
    const [row] = await db('customers').insert({ first_name: 'OlderKey', last_name: 'Fixture', phone: `+1555${digits}`, email: `olderkey-${token()}@example.invalid` }).returning('id');
    made.customers.push(row.id);
    return { id: row.id, phone: `+1555${digits}` };
  }
  async function staffText(owner) {
    const who = owner || await customer();
    const [text] = await db('sms_log').insert({
      direction: 'outbound', from_phone: OUR_NUMBER, to_phone: who.phone, customer_id: who.id, message_type: 'manual', status: 'delivered',
      message_body: 'I will send the details over today, and I will call you tomorrow.', created_at: ago(40),
    }).returning('id');
    made.texts.push(text.id);
    return { id: text.id, customerId: who.id, owner: who };
  }
  async function textPromise(text, over = {}) {
    const [row] = await db('call_commitments').insert({
      commitment_key: `waves:other:${token()}`, party: 'waves', kind: 'other', description: 'Send the details over', source: 'ai',
      evidence: JSON.stringify([{ quote: 'I will send the details over today' }]), status: 'open', sms_log_id: text.id,
      sms_context: JSON.stringify({ basis: 'promise', customer_id: text.customerId }), due_at: ago(10), created_at: ago(40), updated_at: ago(40), ...over,
    }).returning('*');
    made.promises.push(row.id);
    return row;
  }
  // An alert row, open or closed.
  async function alert(metadata, done = null) {
    const [row] = await db('notifications').insert({
      recipient_type: 'admin', category: 'alert', title: 'Older key fixture alert', body: 'Fixture body.', metadata: JSON.stringify(metadata),
      ...(done ? { done_at: done.at || ago(1), done_by: done.by, resolution: 'Closed in a fixture', read_at: ago(1) } : {}),
    }).returning('*');
    made.alerts.push(row.id);
    return row;
  }
  const byPromise = (text, promise, done) => alert({ dedupeKey: `sms-commitment:${promise.id}`, customerId: text.customerId,
    sms_log_id: text.id, commitment_id: promise.id }, done);
  const bySource = (text, promises, done) => alert({ dedupeKey: `sms-commitment-source:${text.id}`, customerId: text.customerId,
    sms_log_id: text.id, commitment_id: promises[0].id, commitment_ids: promises.map((p) => p.id) }, done);
  const customerKey = (customerId) => `sms-commitment-customer:${customerId}`;
  const person = () => ({ by: randomUUID() });

  // What a row written today does: it is keyed on the customer, lists its promises, and closes with the last of them.
  async function expectsCustomerRow(id, text, promises) {
    const after = await alertRow(id);
    expect([after.done_at, after.done_by, after.resolution]).toEqual([null, null, null]);
    expect(meta(after).dedupeKey).toBe(customerKey(text.customerId));
    expect([...meta(after).commitment_ids].sort()).toEqual(promises.map((p) => p.id).sort());
    expect(meta(after).spoke_for).toContain(text.id);
    expect(after.link).toContain(encodeURIComponent(text.customerId));
  }

  describe("a person's Reopen (NotificationService.reopenAdminDone)", () => {
    test('a row keyed on its promise takes the customer key, and then closes when its promise is settled', async () => {
      const text = await staffText();
      const promise = await textPromise(text);
      const old = await byPromise(text, promise, person());

      expect(await notifications.reopenAdminDone(old.id, { expectedDoneAt: await doneToken(old.id) })).toBe('reopened');

      await expectsCustomerRow(old.id, text, [promise]);
      expect(meta(await alertRow(old.id)).quietHoldFrom).toBeTruthy();
      // It folds like a new row: the promise's settle closes it.
      await db.transaction((trx) => actions.closeSmsCommitmentAlerts(trx, { commitmentId: promise.id, smsLogId: text.id },
        notifications._private.doneColumns({ by: 'sms-commitments', resolution: 'Follow-up marked done by staff', keepExisting: true, conn: trx })));
      expect((await alertRow(old.id)).done_by).toBe('sms-commitments');
    });

    test("a row keyed on its text takes the customer key, lists both promises, and a person's Done settles both", async () => {
      const text = await staffText();
      const promises = [await textPromise(text), await textPromise(text, { description: 'Call you tomorrow' })];
      const old = await bySource(text, promises, person());

      expect(await notifications.reopenAdminDone(old.id, { expectedDoneAt: await doneToken(old.id) })).toBe('reopened');

      await expectsCustomerRow(old.id, text, promises);
      const staff = randomUUID();
      expect(await actions.settleCommitmentsForDoneAlert(db, old.id, { reviewedBy: staff })).toBe(2);
      const settled = await db('call_commitments').whereIn('id', promises.map((p) => p.id)).select('status', 'reviewed_by');
      expect(settled.map((r) => [r.status, r.reviewed_by])).toEqual([['fulfilled', staff], ['fulfilled', staff]]);
    });

    test('a row the quiet fall-off closed is adopted too', async () => {
      const text = await staffText();
      const promise = await textPromise(text);
      const old = await byPromise(text, promise, { by: 'quiet-72h' });

      expect(await notifications.reopenAdminDone(old.id, { expectedDoneAt: await doneToken(old.id) })).toBe('reopened');

      await expectsCustomerRow(old.id, text, [promise]);
    });

    test("the customer's own open alert stands: the reopened older row folds into it, and the one alert lists both promises", async () => {
      const text = await staffText();
      const other = await staffText(text.owner);
      const closedPromise = await textPromise(text);
      const openPromise = await textPromise(other, { description: 'Call you tomorrow' });
      const own = await alert({ dedupeKey: customerKey(text.customerId), customerId: text.customerId, sms_log_id: other.id,
        commitment_id: openPromise.id, commitment_ids: [openPromise.id], itemKeys: [openPromise.id], spoke_for: [other.id] });
      const old = await byPromise(text, closedPromise, person());

      expect(await notifications.reopenAdminDone(old.id, { expectedDoneAt: await doneToken(old.id) })).toBe('reopened');

      // One open alert for the customer, listing both promises; the other row is closed as replaced.
      const open = await openFor(text.customerId);
      expect(open).toHaveLength(1);
      const standing = await alertRow(open[0]);
      expect([...meta(standing).commitment_ids].sort()).toEqual([closedPromise.id, openPromise.id].sort());
      expect(meta(standing).dedupeKey).toBe(customerKey(text.customerId));
      const folded = await alertRow(open[0] === own.id ? old.id : own.id);
      expect([folded.done_by, folded.resolution]).toEqual(['supersede', 'Replaced by one alert for this customer']);
    });

    test('a row that names no promise and no customer still reopens, and is left as it is', async () => {
      const old = await alert({ dedupeKey: `sms-commitment:${randomUUID()}` }, person());

      expect(await notifications.reopenAdminDone(old.id, { expectedDoneAt: await doneToken(old.id) })).toBe('reopened');

      const after = await alertRow(old.id);
      expect([after.done_at, meta(after).dedupeKey.startsWith('sms-commitment:')]).toEqual([null, true]);
    });

    test('a refused reopen changes no key', async () => {
      const text = await staffText();
      const promise = await textPromise(text);
      const old = await byPromise(text, promise, { by: 'relevance' });

      expect(await notifications.reopenAdminDone(old.id, { expectedDoneAt: await doneToken(old.id) })).toBe('not_reopenable');

      const after = await alertRow(old.id);
      expect([after.done_by, meta(after).dedupeKey]).toEqual(['relevance', `sms-commitment:${promise.id}`]);
    });
  });

  describe('the promise age-out undo (reopenPromiseAgeOut)', () => {
    test("a row the run closed comes back on the customer's key, and its promise comes back with it", async () => {
      const text = await staffText();
      const promise = await textPromise(text);
      const old = await byPromise(text, promise);
      const runId = new Date(now.getTime() + 1000).toISOString();
      made.runs.push(runId);
      // The run dismisses the promise (the closed row stands for what an earlier build's run closed with it).
      await db('call_commitments').where({ id: promise.id }).update({ status: 'dismissed', fulfillment: JSON.stringify({ kind: 'aged_out', closed_by: ageOut.CLOSED_BY_AGE_OUT, run: runId, basis: ageOut.AGED_OUT_KIND }) });
      await db('notifications').where({ id: old.id }).update({ done_at: runId, done_by: 'promise-age-out', resolution: 'The promise expired: no action in 30 days' });

      const applied = await ageOut.reopenPromiseAgeOut({ run: runId, apply: true });

      expect([applied.reopened, applied.alertsReopened]).toEqual([1, 1]);
      await expectsCustomerRow(old.id, text, [promise]);
      expect(await openFor(text.customerId)).toEqual([old.id]);
    });
  });

  describe('the retention undo (undoRetentionRun)', () => {
    test('a row the run expired comes back on the customer key', async () => {
      const text = await staffText();
      const promise = await textPromise(text);
      const run = `older-key-${token()}`;
      const old = await byPromise(text, promise, { by: 'retention' });
      await db('notifications').where({ id: old.id }).update({ metadata: db.raw("metadata || ?::jsonb", [JSON.stringify({ retention: { run } })]) });

      expect(await retention.undoRetentionRun({ run, execute: true, now })).toMatchObject({ found: 1, reopened: 1 });

      await expectsCustomerRow(old.id, text, [promise]);
      expect(meta(await alertRow(old.id)).retentionUndone).toEqual({ run, at: now.toISOString() });
    });
  });

  describe('the quiet fall-off undo (reopenQuietFallOff)', () => {
    test('a row the fall-off closed comes back on the customer key and keeps the 72-hour hold', async () => {
      const text = await staffText();
      const promise = await textPromise(text);
      const run = `older-key-${token()}`;
      const old = await bySource(text, [promise], { by: 'quiet-72h' });
      await db('notifications').where({ id: old.id }).update({ metadata: db.raw("metadata || ?::jsonb", [JSON.stringify({ retention: { run } })]) });

      expect(await retention.reopenQuietFallOff({ run, apply: true, now })).toMatchObject({ found: 1, reopened: 1 });

      await expectsCustomerRow(old.id, text, [promise]);
      expect(meta(await alertRow(old.id)).quietHoldFrom).toBe(now.toISOString());
    });
  });
});
