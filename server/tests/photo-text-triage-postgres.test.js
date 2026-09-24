// Real SQL behind the photo-text triage guards, in a rollback-only
// transaction on disposable/owned PostgreSQL: the per-message claim + ET-day
// cap (messages.photo_triage_at), the pending-draft conversation match, the
// technician sender match, and the opt-out reads.
const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;

jest.mock('../models/db', () => {
  const db = (...args) => db.connection(...args);
  db.transaction = (...args) => db.connection.transaction(...args);
  db.raw = (...args) => db.connection.raw(...args);
  Object.defineProperty(db, 'fn', { get: () => db.connection.fn });
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const { randomUUID } = require('node:crypto');
const db = require('../models/db');
const { etDateString, parseETDateTime } = require('../utils/datetime-et');
const { _test: triage } = require('../services/photo-text-triage');

jest.setTimeout(30000);

postgres('photo-text triage guards on PostgreSQL', () => {
  let database;
  let trx;
  const savedCap = process.env.PHOTO_TRIAGE_DAILY_CAP;

  beforeAll(() => {
    const url = new URL(process.env.DATABASE_URL);
    const local = ['localhost', '127.0.0.1'].includes(url.hostname);
    const ownedQA = process.env.WAVES_LOCAL_DEV === '1'
      && url.pathname === `/waves_qa_${String(process.env.WAVES_WORKTREE_ID || '').replaceAll('-', '')}`;
    if (!local && !ownedQA) throw new Error('Use disposable CI or this worktree\'s private QA database');
    database = require('knex')({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 2 } });
  });

  beforeEach(async () => {
    trx = await database.transaction();
    const schema = `photo_triage_${randomUUID().replaceAll('-', '')}`;
    await trx.raw('CREATE SCHEMA ??', [schema]);
    for (const table of ['messages', 'message_drafts', 'sms_log', 'technicians', 'notification_prefs', 'messaging_suppression']) {
      await trx.raw('CREATE TABLE ??.?? (LIKE public.?? INCLUDING ALL)', [schema, table, table]);
    }
    await trx.raw('SET LOCAL search_path TO ??, public', [schema]);
    db.connection = trx;
    delete process.env.PHOTO_TRIAGE_DAILY_CAP;
  });

  afterEach(async () => { await trx?.rollback(); });
  afterAll(async () => {
    if (savedCap === undefined) delete process.env.PHOTO_TRIAGE_DAILY_CAP;
    else process.env.PHOTO_TRIAGE_DAILY_CAP = savedCap;
    await database?.destroy();
  });

  async function message({ createdAt = new Date(), triagedAt = null, direction = 'inbound' } = {}) {
    const [row] = await trx('messages').insert({
      id: randomUUID(), conversation_id: randomUUID(), channel: 'sms', direction,
      author_type: 'customer', body: 'what is this', created_at: createdAt, photo_triage_at: triagedAt,
    }).returning(['id']);
    return row.id;
  }

  test('claim: once per message; a replay is already_triaged and keeps the first stamp', async () => {
    const id = await message();
    await expect(triage.claimSlot('vision', id)).resolves.toBe('claimed');
    const first = await trx('messages').where({ id }).first('photo_triage_at');
    expect(first.photo_triage_at).toBeInstanceOf(Date);
    await expect(triage.claimSlot('vision', id)).resolves.toBe('already_triaged');
    const second = await trx('messages').where({ id }).first('photo_triage_at');
    expect(second.photo_triage_at.getTime()).toBe(first.photo_triage_at.getTime());
  });

  test('cap: counts only this ET day\'s claims and refuses at the cap without stamping', async () => {
    process.env.PHOTO_TRIAGE_DAILY_CAP = '2';
    const dayStart = parseETDateTime(`${etDateString()}T00:00`);
    // Yesterday's claim does not count against today.
    await message({ createdAt: new Date(dayStart.getTime() - 3 * 3600e3), triagedAt: new Date(dayStart.getTime() - 3600e3) });
    await message({ triagedAt: new Date() });
    const next = await message();
    await expect(triage.claimSlot('vision', next)).resolves.toBe('claimed');
    const overCap = await message();
    await expect(triage.claimSlot('vision', overCap)).resolves.toBe('cap_reached');
    expect((await trx('messages').where({ id: overCap }).first('photo_triage_at')).photo_triage_at).toBeNull();
  });

  test('classifier slot: its own stamp and cap, independent of the vision slot', async () => {
    process.env.PHOTO_TRIAGE_DAILY_CAP = '5';
    process.env.PHOTO_TRIAGE_CLASSIFIER_DAILY_CAP = '2';
    const first = await message();
    await expect(triage.claimSlot('classifier', first)).resolves.toBe('claimed');
    await expect(triage.claimSlot('classifier', first)).resolves.toBe('already_classified');
    const row = await trx('messages').where({ id: first }).first('photo_triage_at', 'photo_triage_classified_at');
    expect(row.photo_triage_at).toBeNull();
    expect(row.photo_triage_classified_at).toBeInstanceOf(Date);
    await expect(triage.claimSlot('classifier', await message())).resolves.toBe('claimed');
    await expect(triage.claimSlot('classifier', await message())).resolves.toBe('classifier_cap_reached');
    // The vision budget is untouched by classifier stamps.
    await expect(triage.visionBudgetLeft()).resolves.toBe(true);
    await expect(triage.claimSlot('vision', first)).resolves.toBe('claimed');
    delete process.env.PHOTO_TRIAGE_CLASSIFIER_DAILY_CAP;
  });

  test('cap counts only inbound rows: a stamped outbound row is not counted', async () => {
    process.env.PHOTO_TRIAGE_DAILY_CAP = '1';
    await message({ direction: 'outbound', triagedAt: new Date() });
    await expect(triage.visionBudgetLeft()).resolves.toBe(true);
    await expect(triage.claimSlot('vision', await message())).resolves.toBe('claimed');
    await expect(triage.visionBudgetLeft()).resolves.toBe(false);
  });

  test('releaseVisionSlot clears the stamp: the message is claimable again and off the budget', async () => {
    process.env.PHOTO_TRIAGE_DAILY_CAP = '1';
    const id = await message();
    await expect(triage.claimSlot('vision', id)).resolves.toBe('claimed');
    await expect(triage.visionBudgetLeft()).resolves.toBe(false);
    await triage.releaseVisionSlot(id);
    expect((await trx('messages').where({ id }).first('photo_triage_at')).photo_triage_at).toBeNull();
    await expect(triage.visionBudgetLeft()).resolves.toBe(true);
    await expect(triage.claimSlot('vision', id)).resolves.toBe('claimed');
  });

  test('the cap count uses the (direction, channel, created_at) index', async () => {
    const dayStart = parseETDateTime(`${etDateString()}T00:00`);
    await trx.raw('SET LOCAL enable_seqscan = off');
    const plan = await trx.raw(`EXPLAIN SELECT count(*) FROM messages WHERE direction = 'inbound' AND channel = 'sms'
      AND created_at >= ? AND photo_triage_at >= ?`, [new Date(dayStart.getTime() - 86400e3), dayStart]);
    expect(plan.rows.map((r) => r['QUERY PLAN']).join('\n')).toMatch(/direction_channel_created_at/);
  });

  test('vision budget read is non-consuming', async () => {
    process.env.PHOTO_TRIAGE_DAILY_CAP = '1';
    await expect(triage.visionBudgetLeft()).resolves.toBe(true);
    await expect(triage.visionBudgetLeft()).resolves.toBe(true);
    await message({ triagedAt: new Date() });
    await expect(triage.visionBudgetLeft()).resolves.toBe(false);
  });

  test('pending draft: inbound anchor from the same phone (any format), flagged phone, or same customer', async () => {
    const customerId = randomUUID();
    const [anchor] = await trx('sms_log').insert({
      id: randomUUID(), direction: 'inbound', from_phone: '(202) 555-0101', to_phone: '+19415550000',
    }).returning(['id']);
    await expect(triage.hasPendingDraft('+12025550101', null)).resolves.toBe(false);

    const [draft] = await trx('message_drafts').insert({ sms_log_id: anchor.id, status: 'pending', intent: 'x' }).returning(['id']);
    await expect(triage.hasPendingDraft('+12025550101', null)).resolves.toBe(true);
    await expect(triage.hasPendingDraft('+12025550199', null)).resolves.toBe(false);

    await trx('message_drafts').where({ id: draft.id }).update({ status: 'rejected' });
    await expect(triage.hasPendingDraft('+12025550101', null)).resolves.toBe(false);

    await trx('message_drafts').insert({ status: 'pending', intent: 'click_followup', flags: { toPhone: '+1 202 555 0101' } });
    await expect(triage.hasPendingDraft('+12025550101', null)).resolves.toBe(true);

    await trx('message_drafts').where({ intent: 'click_followup' }).update({ status: 'approved' });
    await trx('message_drafts').insert({ status: 'pending', intent: 'reactivation', customer_id: customerId });
    await expect(triage.hasPendingDraft('+12025550188', customerId)).resolves.toBe(true);
    await expect(triage.hasPendingDraft('+12025550188', null)).resolves.toBe(false);
    // Shadow rows never count — they are not in the approval queue.
    await trx('message_drafts').where({ customer_id: customerId }).update({ status: 'shadow' });
    await expect(triage.hasPendingDraft('+12025550188', customerId)).resolves.toBe(false);
  });

  test('internal sender: a technician phone in any stored format', async () => {
    await expect(triage.isInternalSender('+12025550101')).resolves.toBe(false);
    await trx('technicians').insert({ id: randomUUID(), name: 'Synthetic Tech', phone: '202.555.0101' });
    await expect(triage.isInternalSender('+12025550101')).resolves.toBe(true);
  });

  test('opt-out: active suppression, cleared suppression, and sms_enabled=false', async () => {
    const customerId = randomUUID();
    await expect(triage.isOptedOut('+12025550101', customerId)).resolves.toBe(false);
    await trx('messaging_suppression').insert({ phone: '+12025550101', reason: 'opt_out_keyword', active: true });
    await expect(triage.isOptedOut('+12025550101', customerId)).resolves.toBe(true);
    await trx('messaging_suppression').where({ phone: '+12025550101' }).update({ active: false });
    await expect(triage.isOptedOut('+12025550101', customerId)).resolves.toBe(false);
    await trx('notification_prefs').insert({ customer_id: customerId, sms_enabled: false });
    await expect(triage.isOptedOut('+12025550101', customerId)).resolves.toBe(true);
    await expect(triage.isOptedOut('+12025550101', null)).resolves.toBe(false);
  });
});

// Committed (not rollback-scoped) tables so two pooled connections can race
// the way two webhook deliveries would; the schema is dropped afterwards.
postgres('photo-text triage draft parking under concurrency', () => {
  const knex = require('knex');
  let schema;
  let pooled;

  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL);
    const local = ['localhost', '127.0.0.1'].includes(url.hostname);
    const ownedQA = process.env.WAVES_LOCAL_DEV === '1'
      && url.pathname === `/waves_qa_${String(process.env.WAVES_WORKTREE_ID || '').replaceAll('-', '')}`;
    if (!local && !ownedQA) throw new Error('Use disposable CI or this worktree\'s private QA database');
    schema = `photo_triage_race_${randomUUID().replaceAll('-', '')}`;
    const admin = knex({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 1 } });
    await admin.raw('CREATE SCHEMA ??', [schema]);
    for (const table of ['message_drafts', 'sms_log']) {
      await admin.raw('CREATE TABLE ??.?? (LIKE public.?? INCLUDING ALL)', [schema, table, table]);
    }
    // Widen the check→commit window so an unlocked check-then-insert would
    // deterministically double-park (verified by removing the lock).
    await admin.raw(`CREATE FUNCTION ??.slow_insert() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM pg_sleep(0.3); RETURN NEW; END $$`, [schema]);
    await admin.raw('CREATE TRIGGER slow_insert BEFORE INSERT ON ??.message_drafts FOR EACH ROW EXECUTE FUNCTION ??.slow_insert()', [schema, schema]);
    await admin.destroy();
    pooled = knex({ client: 'pg', connection: process.env.DATABASE_URL, searchPath: [schema, 'public'], pool: { min: 0, max: 4 } });
    db.connection = pooled;
  });

  afterAll(async () => {
    await pooled?.destroy();
    if (!schema) return;
    const admin = knex({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 1 } });
    await admin.raw('DROP SCHEMA IF EXISTS ?? CASCADE', [schema]);
    await admin.destroy();
  });

  test('two photo texts from one contact finishing together park exactly one draft', async () => {
    const phone = '+12025550101';
    const anchors = await pooled('sms_log').insert([1, 2].map(() => ({
      id: randomUUID(), direction: 'inbound', from_phone: phone, to_phone: '+19415550000',
    }))).returning(['id']);
    const park = (anchor) => triage.parkDraftUnlessPending({
      from: phone,
      smsLogId: anchor.id,
      customer: null,
      body: 'what is this',
      text: 'Thanks for the photo.',
      created: { type: 'lawn', id: randomUUID() },
      messageId: randomUUID(),
      method: 'regex',
    });
    const results = await Promise.all(anchors.map(park));
    expect(results.filter(Boolean)).toHaveLength(1);
    const rows = await pooled('message_drafts').where({ intent: 'photo_triage', status: 'pending' });
    expect(rows).toHaveLength(1);
    // A third attempt after the fact is refused by the same check.
    await expect(park(anchors[0])).resolves.toBeNull();
  });
});
