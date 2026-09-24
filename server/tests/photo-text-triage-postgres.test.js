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

  async function message({ createdAt = new Date(), triagedAt = null } = {}) {
    const [row] = await trx('messages').insert({
      id: randomUUID(), conversation_id: randomUUID(), channel: 'sms', direction: 'inbound',
      author_type: 'customer', body: 'what is this', created_at: createdAt, photo_triage_at: triagedAt,
    }).returning(['id']);
    return row.id;
  }

  test('claim: once per message; a replay is already_triaged and keeps the first stamp', async () => {
    const id = await message();
    await expect(triage.claimTriage(id)).resolves.toBe('claimed');
    const first = await trx('messages').where({ id }).first('photo_triage_at');
    expect(first.photo_triage_at).toBeInstanceOf(Date);
    await expect(triage.claimTriage(id)).resolves.toBe('already_triaged');
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
    await expect(triage.claimTriage(next)).resolves.toBe('claimed');
    const overCap = await message();
    await expect(triage.claimTriage(overCap)).resolves.toBe('cap_reached');
    expect((await trx('messages').where({ id: overCap }).first('photo_triage_at')).photo_triage_at).toBeNull();
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
