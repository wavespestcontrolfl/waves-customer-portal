/**
 * Spam TAG for SMS senders (GATE_SMS_SPAM_TAG, owner 2026-11-02) against real
 * PostgreSQL: the migration, the tag, the not-spam undo, the customer and
 * open-lead refusals, and NANP-versus-international phone identity. Tables live
 * in a private schema that is dropped afterwards; every phone is synthetic.
 */
const SKIP = !process.env.DATABASE_URL;

jest.mock('../models/db', () => {
  const db = (...args) => mockDatabase(...args);
  db.raw = (...args) => mockDatabase.raw(...args);
  db.transaction = (...args) => mockDatabase.transaction(...args);
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
// The bell service is covered elsewhere; only its feed scope is read here.
jest.mock('../services/notification-service', () => ({
  scopeAdminFeedToRole: (query) => query,
  markInboundSmsReadAdmin: jest.fn(async () => 0),
  markApplicantRepliesReadAdmin: jest.fn(async () => 0),
}));

const knex = require('knex');
const { randomUUID } = require('crypto');
const { responseFlags } = require('../services/sms-response-policy');

jest.setTimeout(60000);

let mockDatabase;

(SKIP ? describe.skip : describe)('sms spam tag on PostgreSQL', () => {
  const schema = `sms_spam_tag_${randomUUID().replaceAll('-', '')}`;
  const ADMIN = randomUUID();
  const OUR_LINE = '+19415550199';
  const MIGRATION = require('../models/migrations/20261102120000_sms_spam_senders');
  let tag;

  beforeAll(async () => {
    mockDatabase = knex({ client: 'pg', connection: process.env.DATABASE_URL, searchPath: [schema], pool: { min: 0, max: 4 } });
    await mockDatabase.raw('CREATE SCHEMA ??', [schema]);
    await mockDatabase.raw(`
      CREATE TABLE customers (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), phone text, service_contact_phone text,
        service_contact2_phone text, service_contact3_phone text, secondary_phone text,
        first_name text, last_name text, deleted_at timestamptz);
      CREATE TABLE leads (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), phone text, first_name text, last_name text,
        status text, converted_at timestamptz, deleted_at timestamptz);
      CREATE TABLE conversations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), customer_id uuid, channel text,
        contact_phone text, our_endpoint_id text);
      CREATE TABLE messages (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), conversation_id uuid, channel text,
        direction text, body text, media jsonb DEFAULT '[]', metadata jsonb DEFAULT '{}', message_type text,
        twilio_sid text, is_read boolean, read_at timestamptz, read_by_admin_user_id uuid,
        updated_at timestamptz, created_at timestamptz DEFAULT now());
      CREATE TABLE sms_log (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), customer_id uuid, direction text,
        from_phone text, to_phone text, message_body text, metadata jsonb, created_at timestamptz DEFAULT now(),
        message_type text, status text, twilio_sid text, is_read boolean);
      CREATE TABLE notifications (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), recipient_type text, category text,
        read_at timestamptz, created_at timestamptz DEFAULT now(), link text, metadata jsonb);
    `);
    await MIGRATION.up(mockDatabase);
    tag = require('../services/sms-spam-tag');
  });
  afterAll(async () => {
    delete process.env.GATE_SMS_SPAM_TAG;
    if (!mockDatabase) return;
    await mockDatabase.raw('DROP SCHEMA ?? CASCADE', [schema]).catch(() => {});
    await mockDatabase.destroy();
  });
  beforeEach(async () => {
    await mockDatabase.raw('TRUNCATE customers, leads, conversations, messages, sms_log, notifications, sms_spam_senders');
  });

  let sidCounter = 0;
  // One inbound (or outbound) text, in both stores, the way the webhook writes it.
  async function addText({ from, body = 'hello there', direction = 'inbound', verdict = null, media = [], messageType = null, read = false, customerId = null }) {
    sidCounter += 1;
    const sid = `SM-synthetic-${sidCounter}`;
    const conversationId = randomUUID();
    const metadata = verdict ? { spam_verdict: verdict } : {};
    await mockDatabase('conversations').insert({
      id: conversationId, customer_id: customerId, channel: 'sms',
      contact_phone: direction === 'inbound' ? from : OUR_LINE, our_endpoint_id: OUR_LINE,
    });
    const [message] = await mockDatabase('messages').insert({
      conversation_id: conversationId, channel: 'sms', direction, body, media: JSON.stringify(media),
      metadata: JSON.stringify(metadata), message_type: messageType, twilio_sid: sid, is_read: read,
    }).returning('id');
    await mockDatabase('sms_log').insert({
      customer_id: customerId, direction, from_phone: direction === 'inbound' ? from : OUR_LINE,
      to_phone: direction === 'inbound' ? OUR_LINE : from, message_body: body,
      metadata: JSON.stringify({ ...metadata, media }), message_type: messageType || 'inbound', twilio_sid: sid, is_read: read,
    });
    return { sid, messageId: message.id };
  }
  const unified = (sid) => mockDatabase('messages').where({ twilio_sid: sid }).first();
  const legacy = (sid) => mockDatabase('sms_log').where({ twilio_sid: sid }).first();
  const MODEL_VERDICT = { solicitation: true, confidence: 0.95, method: 'model', mode: 'enforce', enforced: true };

  test('the migration creates the table and its down removes it', async () => {
    const cols = await mockDatabase('information_schema.columns').where({ table_schema: schema, table_name: 'sms_spam_senders' })
      .select('column_name', 'is_nullable', 'data_type');
    expect(Object.fromEntries(cols.map((c) => [c.column_name, c.is_nullable]))).toEqual({
      phone: 'NO', marked_by: 'YES', marked_at: 'NO', reason: 'YES', source: 'NO',
    });
    await MIGRATION.down(mockDatabase);
    expect(await mockDatabase.schema.hasTable('sms_spam_senders')).toBe(false);
    await MIGRATION.up(mockDatabase);
    expect(await mockDatabase.schema.hasTable('sms_spam_senders')).toBe(true);
  });

  test('tagging keeps every text, stamps the manual verdict and marks them read', async () => {
    const first = await addText({ from: '+19415550100', body: 'Need leads?' });
    const second = await addText({ from: '(941) 555-0100', body: 'Reply STOP to stop messages.' });
    const other = await addText({ from: '+19415550101', body: 'A different sender' });
    const outbound = await addText({ from: '+19415550100', direction: 'outbound', body: 'We texted them once' });
    const photo = await addText({ from: '+19415550100', body: 'Look', media: [{ url: 'https://example.com/p.jpg', contentType: 'image/jpeg' }] });
    const stop = await addText({ from: '+19415550100', body: 'STOP', messageType: 'opt_out' });

    const result = await tag.tagSpamSender({ number: '941-555-0100', adminUserId: ADMIN, reason: 'pitch' });
    expect(result).toMatchObject({ phone: '+19415550100', alreadyTagged: false, legacy: 2, unified: 2, readFailed: false });

    for (const { sid } of [first, second]) {
      for (const row of [await unified(sid), await legacy(sid)]) {
        expect(row.is_read).toBe(true);
        expect(row.metadata.spam_verdict).toMatchObject({
          solicitation: true, confidence: 1, method: 'manual', mode: 'manual', enforced: true, version: 'sms-spam-tag-v1', marked_by: ADMIN,
        });
      }
      const flags = responseFlags({ direction: 'inbound', body: 'x', media: [], metadata: (await unified(sid)).metadata });
      expect(flags.spamEnforced).toBe(true);
    }
    // Nothing was removed.
    expect(Number((await mockDatabase('messages').count())[0].count)).toBe(6);
    expect(Number((await mockDatabase('sms_log').count())[0].count)).toBe(6);
    // Untouched: another sender, our own outbound, a photo text, a STOP.
    for (const { sid } of [other, outbound, photo, stop]) {
      expect((await unified(sid)).metadata.spam_verdict).toBeUndefined();
      expect((await legacy(sid)).metadata.spam_verdict).toBeUndefined();
    }
    expect((await unified(other.sid)).is_read).toBe(false);
    expect((await mockDatabase('sms_spam_senders'))).toEqual([
      expect.objectContaining({ phone: '+19415550100', marked_by: ADMIN, reason: 'pitch', source: 'inbox' }),
    ]);
  });

  test('tagging twice is not an error and keeps the first stamp', async () => {
    await tag.tagSpamSender({ number: '+19415550100', adminUserId: ADMIN });
    const before = await mockDatabase('sms_spam_senders').first();
    const again = await tag.tagSpamSender({ number: '+19415550100', adminUserId: randomUUID() });
    expect(again.alreadyTagged).toBe(true);
    const rows = await mockDatabase('sms_spam_senders');
    expect(rows).toHaveLength(1);
    expect(rows[0].marked_by).toBe(before.marked_by);
  });

  test('a text a model already silenced keeps its model verdict', async () => {
    const { sid } = await addText({ from: '+19415550100', verdict: MODEL_VERDICT, read: true });
    await tag.tagSpamSender({ number: '+19415550100', adminUserId: ADMIN });
    expect((await unified(sid)).metadata.spam_verdict).toMatchObject({ method: 'model' });
  });

  // The inbox payload marks tagged senders (a photo-only thread has no stamped
  // text): identity keys, NANP by ten digits, others by full digits.
  test('taggedSenderKeys lists every tagged sender by phone identity', async () => {
    await tag.tagSpamSender({ number: '(941) 555-0100', adminUserId: ADMIN });
    await tag.tagSpamSender({ number: '+44 7700 900123', adminUserId: ADMIN });
    const keys = await tag.taggedSenderKeys();
    const { phoneIdentityKey } = require('../utils/phone');
    expect(keys.has(phoneIdentityKey('+19415550100'))).toBe(true);
    expect(keys.has(phoneIdentityKey('+447700900123'))).toBe(true);
    expect(keys.has(phoneIdentityKey('+19415550101'))).toBe(false);
    expect(keys.size).toBe(2);
  });

  // Pre-push audit P1 (in-flight Not spam): the webhook wrote a manual verdict
  // after the undo's scan; its re-read finds no tag and releases the text.
  test('releaseIfUntagged clears an in-flight text once the tag is gone, and only then', async () => {
    const manual = tag.manualVerdict({ adminUserId: ADMIN });
    const kept = await addText({ from: '+19415550100', verdict: manual, read: true });
    await tag.tagSpamSender({ number: '+19415550100', adminUserId: ADMIN });
    const keptLog = await legacy(kept.sid);
    expect(await tag.releaseIfUntagged({ phone: '+19415550100', messageSid: kept.sid, smsLogId: keptLog.id })).toBe(false);
    expect((await unified(kept.sid)).metadata.spam_verdict.enforced).toBe(true);

    await tag.untagSpamSender({ number: '+19415550100', adminUserId: ADMIN });
    const late = await addText({ from: '+19415550100', verdict: manual, read: true });
    const lateLog = await legacy(late.sid);
    expect(await tag.releaseIfUntagged({ phone: '+19415550100', messageSid: late.sid, smsLogId: lateLog.id })).toBe(true);
    for (const row of [await unified(late.sid), await legacy(late.sid)]) {
      expect(row.is_read).toBe(false);
      expect(row.metadata.spam_verdict).toMatchObject({ method: 'manual', enforced: false });
      expect(row.metadata.spam_verdict.cleared_at).toEqual(expect.any(String));
    }
    const flags = responseFlags({ direction: 'inbound', body: 'x', media: [], metadata: (await unified(late.sid)).metadata });
    expect(flags.spamEnforced).toBe(false);
  });

  // Pre-push audit P1 (tag vs undo): one lock per sender. While another
  // session holds it, each of the three writers waits and writes nothing.
  test.each([
    ['Mark spam', async () => tag.tagSpamSender({ number: '+19415550100', adminUserId: ADMIN }),
      async () => (await mockDatabase('sms_spam_senders')).length === 0],
    ['Not spam', async () => tag.untagSpamSender({ number: '+19415550100', adminUserId: ADMIN }),
      async () => (await mockDatabase('sms_spam_senders')).length === 1],
    ['the in-flight re-read', async (ids) => tag.releaseIfUntagged({ phone: '+19415550100', messageSid: ids.sid, smsLogId: ids.logId }),
      async (ids) => (await unified(ids.sid)).metadata.spam_verdict.enforced === true],
  ])('%s waits for the sender lock', async (label, run, unchanged) => {
    const sent = await addText({ from: '+19415550100', verdict: tag.manualVerdict({ adminUserId: ADMIN }), read: true });
    const ids = { sid: sent.sid, logId: (await legacy(sent.sid)).id };
    if (label === 'Not spam') await mockDatabase('sms_spam_senders').insert({ phone: '+19415550100', marked_by: ADMIN });
    const { phoneIdentityKey } = require('../utils/phone');
    let unlock;
    const held = new Promise((resolve) => { unlock = resolve; });
    let locked;
    const lockTaken = new Promise((resolve) => { locked = resolve; });
    const holder = mockDatabase.transaction(async (trx) => {
      await trx.raw('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [`sms-spam-tag:${phoneIdentityKey('+19415550100')}`]);
      locked();
      await held;
    });
    await lockTaken;
    const pending = run(ids);
    // Release the lock even when the check fails, so a regression fails here
    // instead of hanging the suite on an open transaction.
    try {
      await new Promise((resolve) => { setTimeout(resolve, 300); });
      expect(await unchanged(ids)).toBe(true);
    } finally {
      unlock();
      await holder;
    }
    await pending;
    expect(await unchanged(ids)).toBe(false);
  });

  test('Mark spam and Not spam at the same moment always end consistent', async () => {
    await addText({ from: '+19415550100', body: 'Need leads?' });
    await addText({ from: '+19415550100', body: 'Still there?' });
    for (let round = 0; round < 8; round += 1) {
      await Promise.all([
        tag.tagSpamSender({ number: '+19415550100', adminUserId: ADMIN }),
        tag.untagSpamSender({ number: '+19415550100', adminUserId: ADMIN }),
      ]);
      const tagged = (await mockDatabase('sms_spam_senders')).length === 1;
      const enforced = await mockDatabase('messages').whereRaw("metadata->'spam_verdict'->>'enforced' = 'true'");
      expect(enforced).toHaveLength(tagged ? 2 : 0);
    }
  });

  // Pre-push audit P1: a tag whose read failed is repaired by the next tag;
  // the verdict already on file stays as it is.
  test('a failed read is repaired when the sender is tagged again', async () => {
    const { sid } = await addText({ from: '+19415550100', body: 'Need leads?' });
    const reads = require('../services/inbound-sms-read');
    const spy = jest.spyOn(reads, 'markInboundSmsRead')
      .mockRejectedValueOnce(Object.assign(new Error('read failed'), { code: 'EREADFAIL' }));
    try {
      const first = await tag.tagSpamSender({ number: '+19415550100', adminUserId: ADMIN });
      expect(first).toMatchObject({ unified: 1, readFailed: true });
      expect((await unified(sid)).is_read).toBe(false);
      const stampedAt = (await unified(sid)).metadata.spam_verdict.marked_at;

      const second = await tag.tagSpamSender({ number: '+19415550100', adminUserId: ADMIN });
      expect(second).toMatchObject({ alreadyTagged: true, unified: 0, readFailed: false });
      const row = await unified(sid);
      expect(row.is_read).toBe(true);
      expect(row.metadata.spam_verdict).toMatchObject({ method: 'manual', enforced: true, marked_at: stampedAt });
    } finally {
      spy.mockRestore();
    }
  });

  test.each([
    ['primary phone', { phone: '(941) 555-0100' }],
    ['service-contact slot', { service_contact2_phone: '9415550100' }],
    ['secondary phone', { secondary_phone: '+19415550100' }],
  ])('a live customer\'s %s is refused', async (_label, columns) => {
    const id = randomUUID();
    await mockDatabase('customers').insert({ id, first_name: 'Synthetic', last_name: 'Customer', ...columns });
    await addText({ from: '+19415550100' });
    await expect(tag.tagSpamSender({ number: '+19415550100', adminUserId: ADMIN }))
      .rejects.toMatchObject({ code: 'CUSTOMER_NUMBER', details: { customer_id: id } });
    expect(await mockDatabase('sms_spam_senders')).toHaveLength(0);
    expect((await mockDatabase('messages').first()).metadata.spam_verdict).toBeUndefined();
  });

  test('an archived customer does not block the tag', async () => {
    await mockDatabase('customers').insert({ first_name: 'Old', last_name: 'Customer', phone: '+19415550100', deleted_at: new Date() });
    await expect(tag.tagSpamSender({ number: '+19415550100', adminUserId: ADMIN })).resolves.toMatchObject({ alreadyTagged: false });
  });

  test('an open lead is refused and a closed lead is not', async () => {
    const id = randomUUID();
    await mockDatabase('leads').insert({ id, phone: '(941) 555-0100', status: 'new' });
    await expect(tag.tagSpamSender({ number: '+19415550100', adminUserId: ADMIN }))
      .rejects.toMatchObject({ code: 'LEAD_NUMBER', details: { lead_id: id } });
    expect(await mockDatabase('sms_spam_senders')).toHaveLength(0);
    await mockDatabase('leads').update({ status: 'lost' });
    await expect(tag.tagSpamSender({ number: '+19415550100', adminUserId: ADMIN })).resolves.toMatchObject({ alreadyTagged: false });
  });

  test('a number that is not a phone is refused', async () => {
    await expect(tag.tagSpamSender({ number: 'abc', adminUserId: ADMIN })).rejects.toMatchObject({ code: 'INVALID_NUMBER' });
    await expect(tag.tagSpamSender({ number: '', adminUserId: ADMIN })).rejects.toMatchObject({ code: 'INVALID_NUMBER' });
  });

  test('not spam deletes the tag and clears enforced on manual and model verdicts, leaving is_read alone', async () => {
    const manual = await addText({ from: '+19415550100', body: 'one' });
    const model = await addText({ from: '+19415550100', body: 'two', verdict: MODEL_VERDICT, read: true });
    const shadow = await addText({ from: '+19415550100', body: 'three', verdict: { ...MODEL_VERDICT, enforced: false } });
    const other = await addText({ from: '+19415550101', body: 'four', verdict: MODEL_VERDICT, read: true });
    await tag.tagSpamSender({ number: '+19415550100', adminUserId: ADMIN });
    // The tag stamped "one" and "three"; "two" kept its model verdict.
    expect((await unified(manual.sid)).metadata.spam_verdict.method).toBe('manual');

    const undone = await tag.untagSpamSender({ number: '(941) 555-0100', adminUserId: ADMIN });
    expect(undone).toMatchObject({ phone: '+19415550100', removed: true });
    expect(await mockDatabase('sms_spam_senders')).toHaveLength(0);

    for (const { sid } of [manual, model]) {
      for (const row of [await unified(sid), await legacy(sid)]) {
        expect(row.metadata.spam_verdict).toMatchObject({ enforced: false, cleared_by: ADMIN });
        expect(typeof row.metadata.spam_verdict.cleared_at).toBe('string');
        expect(row.is_read).toBe(true);
      }
      expect(responseFlags({ direction: 'inbound', body: 'x', media: [], metadata: (await unified(sid)).metadata }).spamEnforced).toBe(false);
    }
    // The model's own fields survive the clear.
    expect((await unified(model.sid)).metadata.spam_verdict).toMatchObject({ method: 'model', confidence: 0.95 });
    // A shadow (not enforced) verdict does not count as silenced, so the tag stamped it and the undo cleared it.
    expect((await unified(shadow.sid)).metadata.spam_verdict).toMatchObject({ method: 'manual', enforced: false, cleared_by: ADMIN });
    // Another sender's silenced text is untouched.
    expect((await unified(other.sid)).metadata.spam_verdict.enforced).toBe(true);
    // Not spam on an untagged number is quiet.
    await expect(tag.untagSpamSender({ number: '+19415550100', adminUserId: ADMIN })).resolves.toMatchObject({ removed: false });
  });

  test('a NANP number and an international number sharing its last ten digits never collide', async () => {
    const nanp = await addText({ from: '+12079460958' });
    const foreign = await addText({ from: '+442079460958' });
    await tag.tagSpamSender({ number: '+442079460958', adminUserId: ADMIN });
    expect((await unified(foreign.sid)).metadata.spam_verdict.enforced).toBe(true);
    expect((await unified(nanp.sid)).metadata.spam_verdict).toBeUndefined();
    expect(await tag.findTaggedSender('+442079460958')).toMatchObject({ phone: '+442079460958' });
    expect(await tag.findTaggedSender('+12079460958')).toBeNull();
    expect(await tag.findTaggedSender('(207) 946-0958')).toBeNull();

    await tag.untagSpamSender({ number: '+442079460958', adminUserId: ADMIN });
    await tag.tagSpamSender({ number: '(207) 946-0958', adminUserId: ADMIN });
    expect((await unified(nanp.sid)).metadata.spam_verdict.enforced).toBe(true);
    expect((await unified(foreign.sid)).metadata.spam_verdict.enforced).toBe(false);
    expect(await tag.findTaggedSender('+12079460958')).toMatchObject({ phone: '+12079460958' });
    expect(await tag.findTaggedSender('2079460958')).toMatchObject({ phone: '+12079460958' });
    expect(await tag.findTaggedSender('+442079460958')).toBeNull();
  });

  test('the webhook lookup honors the gate and an open lead', async () => {
    await tag.tagSpamSender({ number: '+19415550100', adminUserId: ADMIN });
    delete process.env.GATE_SMS_SPAM_TAG;
    expect(await tag.taggedVerdictForInbound({ phone: '+19415550100' })).toBeNull();
    process.env.GATE_SMS_SPAM_TAG = 'true';
    expect(await tag.taggedVerdictForInbound({ phone: '+19415550100' })).toMatchObject({ method: 'manual', enforced: true, marked_by: ADMIN });
    expect(await tag.taggedVerdictForInbound({ phone: '+19415550102' })).toBeNull();
    // A lead that arrived after the tag wins.
    await mockDatabase('leads').insert({ phone: '+19415550100', status: 'contacted' });
    expect(await tag.taggedVerdictForInbound({ phone: '+19415550100' })).toBeNull();
  });
});
