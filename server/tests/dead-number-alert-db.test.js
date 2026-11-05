/**
 * GATE_DEAD_NUMBER_ALERT against live Postgres: the real sms_log reads, the real notifyAdmin dedupe under the
 * key's lock, and the real close. The rules themselves are in dead-number-alert.test.js. Synthetic customer and
 * numbers only; every row this suite writes is found by its customer id and removed afterwards.
 */
const SKIP = !process.env.DATABASE_URL;
const maybeDescribe = SKIP ? describe.skip : describe;

afterAll(async () => { if (!SKIP) await require('../models/db').destroy(); });

maybeDescribe('dead number alert (live Postgres)', () => {
  let db;
  let deadNumber;
  const customerId = '7d1e0c2a-5b8f-4c3e-9a61-0d4f2b9e8c11';
  const PHONE = '+19415550142';
  const KEY = `dead-number:${customerId}:9415550142`;
  const DAY = 24 * 60 * 60 * 1000;
  const ago = (days) => new Date(Date.now() - days * DAY);
  let seq = 0;

  beforeAll(async () => {
    db = require('../models/db');
    deadNumber = require('../services/dead-number-alert');
    process.env.GATE_DEAD_NUMBER_ALERT = 'true';
    await db('customers').insert({ id: customerId, first_name: 'Jane', last_name: 'Doe', phone: PHONE });
  });
  const clean = async () => {
    await db('notifications').where({ recipient_type: 'admin' }).whereRaw("metadata->>'dedupeKey' = ?", [KEY]).del();
    await db('sms_log').where({ customer_id: customerId }).del();
  };
  beforeEach(clean);
  afterAll(async () => {
    delete process.env.GATE_DEAD_NUMBER_ALERT;
    await clean();
    await db('customers').where({ id: customerId }).del();
  });

  const text = async (status, daysAgo, to = PHONE) => {
    seq += 1;
    const sid = `SMdeadnumberdb${String(seq).padStart(4, '0')}`;
    await db('sms_log').insert({
      customer_id: customerId, direction: 'outbound', from_phone: '+19415550100', to_phone: to,
      message_body: 'Synthetic reminder.', message_type: 'reminder_72h', status, twilio_sid: sid, created_at: ago(daysAgo),
    });
    return sid;
  };
  const fail = (sid) => deadNumber.handleDeadNumberFailure({ sid, status: 'undelivered', errorCode: '30005', to: PHONE });
  const rows = () => db('notifications').where({ recipient_type: 'admin' }).whereRaw("metadata->>'dedupeKey' = ?", [KEY]).orderBy('created_at');
  const meta = (r) => (typeof r.metadata === 'string' ? JSON.parse(r.metadata) : r.metadata);

  test('the second failure in a row raises one row; a retry and a late callback add nothing', async () => {
    const first = await text('undelivered', 30);
    expect(await fail(first)).toBeNull();
    expect(await rows()).toHaveLength(0);

    const second = await text('undelivered', 2);
    await fail(second);
    const [row] = await rows();
    expect(row.title).toBe("Customers — Jane D.'s phone can't get texts");
    expect(row.body).toMatch(/^2 texts in a row to …0142 failed since /);
    expect(row.done_at).toBeNull();
    expect(meta(row).lastFailureAt).toBe(new Date((await db('sms_log').where({ twilio_sid: second }).first('created_at')).created_at).toISOString());

    await fail(second); // Twilio retries the same callback
    await fail(first); // a late callback for the older failure
    expect(await rows()).toHaveLength(1);
  });

  test('a newer failure updates the open row quietly; after Done only a later failure raises a fresh row', async () => {
    await text('undelivered', 30);
    await fail(await text('undelivered', 10));
    const third = await text('undelivered', 2);
    await fail(third);
    let all = await rows();
    expect(all).toHaveLength(1);
    expect(all[0].body).toMatch(/^3 texts in a row/);

    await db('notifications').where({ id: all[0].id }).update({ done_at: new Date() });
    await fail(third); // retried after Done: no news
    expect(await rows()).toHaveLength(1);

    await fail(await text('undelivered', 0));
    all = await rows();
    expect(all).toHaveLength(2);
    expect(all.filter((r) => !r.done_at)).toHaveLength(1);
    expect(all[1].body).toMatch(/^4 texts in a row/);
  });

  test('a queued text that failed before reaching Twilio (no sid) does not count', async () => {
    await db('sms_log').insert({
      customer_id: customerId, direction: 'outbound', from_phone: '+19415550100', to_phone: PHONE,
      message_body: 'Synthetic reminder.', message_type: 'reminder_72h', status: 'failed', twilio_sid: null, created_at: ago(20),
    });
    await fail(await text('undelivered', 2));
    expect(await rows()).toHaveLength(0);
  });

  test("a retry for a callback that beat the sender's log writes the missed status and raises", async () => {
    await text('undelivered', 30);
    const early = await text('sent', 1); // logged after its undelivered callback had already come and gone
    await deadNumber.handleDeadNumberFailure({ sid: early, status: 'undelivered', errorCode: '30005', to: PHONE, attempt: 1 });
    expect((await db('sms_log').where({ twilio_sid: early }).first('status')).status).toBe('undelivered');
    const [row] = await rows();
    expect(row.body).toMatch(/^2 texts in a row/);
  });

  test('a delivery between two failures raises nothing', async () => {
    await text('undelivered', 30);
    await text('delivered', 20);
    await fail(await text('undelivered', 2));
    expect(await rows()).toHaveLength(0);
  });

  test('the failure path reads the history inside the customer lock, so a delivery that lands meanwhile counts', async () => {
    await text('undelivered', 30);
    const second = await text('undelivered', 10);
    const later = await text('sent', 5); // sent after the failures; its delivered update lands while the failure waits
    let locked;
    let release;
    const isLocked = new Promise((r) => { locked = r; });
    const held = new Promise((r) => { release = r; });
    const holder = db.transaction(async (trx) => {
      await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`dead-number:${customerId}`]);
      locked();
      await held;
    });
    await isLocked;
    const pending = fail(second);
    await new Promise((r) => { setTimeout(r, 300); });
    await db('sms_log').where({ twilio_sid: later }).update({ status: 'delivered' });
    release();
    await holder;
    expect(await pending).toBeNull();
    expect(await rows()).toHaveLength(0);
  });

  test('a late delivered callback for an older text leaves the row; a text sent after the failures closes it', async () => {
    await text('undelivered', 30);
    const older = await text('sent', 25); // its delivered callback arrives late
    await text('undelivered', 10);
    await fail(await text('undelivered', 2));
    expect(await rows()).toHaveLength(1);

    expect(await deadNumber.closeDeadNumberAlerts({ sid: older, status: 'delivered' })).toBe(0);
    expect((await rows())[0].done_at).toBeNull();

    const later = await text('sent', 0);
    expect(await deadNumber.closeDeadNumberAlerts({ sid: later, status: 'delivered' })).toBe(1);
    const [closed] = await rows();
    expect(closed.done_at).not.toBeNull();
    expect(meta(closed).autoClearedReason).toBe('text_delivered');
  });
});
