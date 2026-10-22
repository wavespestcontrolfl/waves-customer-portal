// CI's DB-gated pass runs this against PostgreSQL; the table comes from the
// real migration (20261022130000_scheduled_emails) inside a throwaway schema.
//
// Schedule send (GATE_EMAIL_SEND_LATER): a queued email goes out once, when
// due; a retried schedule request queues one row; Cancel send returns the
// draft; Gmail's possible acceptance is never retried; three definite
// refusals end in 'failed'. Alerts run through the real composer, which
// throws in tests when the copy breaks docs/admin-notifications.md.
const SKIP = !process.env.DATABASE_URL;
const knex = require('knex');
const { randomUUID } = require('crypto');
let mockConn;
jest.mock('../models/db', () => {
  const proxy = (...args) => mockConn(...args);
  proxy.raw = (...args) => mockConn.raw(...args);
  proxy.transaction = (...args) => mockConn.transaction(...args);
  Object.defineProperty(proxy, 'fn', { get: () => mockConn.fn });
  return proxy;
});
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => { req.techRole = 'admin'; req.technicianId = null; next(); },
  requireAdmin: (req, res, next) => next(),
}));
jest.mock('../services/email/gmail-client', () => ({ sendMessage: jest.fn() }));
jest.mock('../services/email/email-sync', () => ({ syncEmails: jest.fn() }));
jest.mock('../services/email/email-classifier', () => ({ classifyEmail: jest.fn() }));
jest.mock('../services/email/email-actions', () => ({ executeAutoAction: jest.fn() }));
jest.mock('../services/email/spam-blocker', () => ({ unblockSender: jest.fn(), manualBlockSender: jest.fn() }));
jest.mock('../services/staff-oauth-state', () => ({}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
// The alert lands as a notifications row carrying its dedupeKey, which is what
// raiseMissedAlerts looks for.
jest.mock('../services/notification-service', () => ({
  notifyAdmin: jest.fn(async (category, title, body, opts = {}) => {
    await mockConn('notifications').insert({ recipient_type: 'admin', metadata: { dedupeKey: opts.dedupeKey } });
    return { id: 'fixture-alert' };
  }),
  // The shared Done writer, reduced to its effect on the fixture table.
  markAdminDone: jest.fn(async (ids, { by, resolution }) => mockConn('notifications').whereIn('id', ids).whereNull('done_at')
    .update({ done_at: new Date(), done_by: by, resolution })),
}));

const express = require('express');
const gmail = require('../services/email/gmail-client');
const { notifyAdmin } = require('../services/notification-service');
const { sendDueScheduledEmails } = require('../services/email/scheduled-email-sender');
const { recordLeaseFreeJobEnd } = require('../utils/cron-lock');
const migration = require('../models/migrations/20261022130000_scheduled_emails');
const restoredMigration = require('../models/migrations/20261022150000_scheduled_emails_restored_at');
const restoreKeyMigration = require('../models/migrations/20261022160000_scheduled_emails_restore_key');
const sweepIndexMigration = require('../models/migrations/20261022170000_scheduled_emails_sweep_indexes');
const cancelledIndexMigration = require('../models/migrations/20261022180000_scheduled_emails_cancelled_index_drop_restore_key');

jest.setTimeout(30000);
(SKIP ? describe.skip : describe)('scheduled emails on PostgreSQL', () => {
  let database;
  let server;
  const schema = `scheduled_email_${randomUUID().replaceAll('-', '')}`;
  const etIn = (minutes) => new Date(Date.now() + minutes * 60000)
    .toLocaleString('sv-SE', { timeZone: 'America/New_York' }).slice(0, 16).replace(' ', 'T');
  const call = async (method, path, body) => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/admin/email${path}`, {
      method, headers: { 'Content-Type': 'application/json', Authorization: 'admin' }, ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: await res.json() };
  };
  const queue = (extra = {}) => call('POST', '/schedule', {
    to: 'fixture@example.invalid', subject: 'Fixture', body: 'Hi<br>there', draftText: 'Hi\nthere', sendAt: etIn(60), clientKey: randomUUID(), ...extra,
  });
  const cancel = (id, restoreKey = 'fixture-restore-key') => call('POST', `/scheduled/${id}/cancel`, { restoreKey });
  // Due now, and past any retry gap (time has passed since the last attempt).
  const makeDue = (id, extra = {}) => database('scheduled_emails').where({ id }).update({ send_at: database.raw("now() - interval '1 minute'"), claimed_at: null, ...extra });
  const row = (id) => database('scheduled_emails').where({ id }).first();

  beforeAll(async () => {
    database = knex({ client: 'pg', connection: process.env.DATABASE_URL, searchPath: [schema], pool: { min: 0, max: 3 } });
    await database.raw('CREATE SCHEMA ??', [schema]);
    await migration.up(database);
    await restoredMigration.up(database);
    await restoreKeyMigration.up(database);
    await sweepIndexMigration.up(database);
    await cancelledIndexMigration.up(database);
    // Minimal stand-ins for the tables the sender reads beside its own.
    await database.schema.createTable('notifications', (t) => {
      t.increments('id'); t.string('recipient_type'); t.jsonb('metadata');
      t.timestamp('done_at', { useTz: true }); t.string('done_by', 64); t.text('resolution'); t.timestamp('read_at', { useTz: true });
    });
    await database.schema.createTable('emails', (t) => { t.uuid('id').primary(); t.string('message_id'); });
    await database.schema.createTable('job_health', (t) => {
      t.string('job_name').primary(); t.timestamp('last_started_at', { useTz: true }); t.timestamp('last_finished_at', { useTz: true });
      t.integer('last_duration_ms'); t.string('last_status'); t.text('last_error'); t.timestamp('last_success_at', { useTz: true });
      t.integer('consecutive_failures').notNullable().defaultTo(0); t.timestamp('updated_at', { useTz: true });
    });
    mockConn = database;
    const app = express();
    app.use(express.json());
    app.use('/api/admin/email', require('../routes/admin-email'));
    await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  });
  beforeEach(() => { process.env.GATE_EMAIL_SEND_LATER = 'true'; jest.clearAllMocks(); });
  afterEach(async () => { await database('scheduled_emails').del(); await database('notifications').del(); await database('emails').del(); delete process.env.GATE_EMAIL_SEND_LATER; });
  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    await database.raw('DROP SCHEMA ?? CASCADE', [schema]);
    await database.destroy();
  });

  test('queues once per client key, lists it, and sends it once when due', async () => {
    const key = randomUUID();
    const first = await queue({ clientKey: key });
    const again = await queue({ clientKey: key, subject: 'Changed' });
    expect(first.status).toBe(200);
    expect(again.body.scheduled.id).toBe(first.body.scheduled.id);
    expect(await database('scheduled_emails').count('* as n').first()).toEqual({ n: '1' });
    expect((await call('GET', '/scheduled')).body.emails.map((e) => e.id)).toEqual([first.body.scheduled.id]);

    expect((await sendDueScheduledEmails()).results).toEqual([]);
    expect(gmail.sendMessage).not.toHaveBeenCalled();

    await makeDue(first.body.scheduled.id);
    gmail.sendMessage.mockImplementation(async (...args) => { await args[5].beforeSend(); return { id: 'gmail-fixture-1' }; });
    expect((await sendDueScheduledEmails()).results).toEqual(['sent']);
    expect(gmail.sendMessage).toHaveBeenCalledWith('fixture@example.invalid', 'Fixture', 'Hi<br>there', null, null, expect.objectContaining({ timeoutMs: 60000 }));
    expect(await row(first.body.scheduled.id)).toMatchObject({ status: 'sent', gmail_message_id: 'gmail-fixture-1', attempts: 1 });
    expect((await sendDueScheduledEmails()).results).toEqual([]);
    expect(gmail.sendMessage).toHaveBeenCalledTimes(1);
    expect((await call('GET', '/scheduled')).body.emails).toEqual([]);
  });

  test('a reply goes out in its Gmail thread with the source Message-ID', async () => {
    const replyEmailId = randomUUID();
    await database('emails').insert({ id: replyEmailId, message_id: '<source-fixture@example.invalid>' });
    const { body } = await queue({ threadId: 'thread-fixture', replyEmailId });
    await makeDue(body.scheduled.id);
    gmail.sendMessage.mockResolvedValue({ id: 'gmail-fixture-2' });
    await sendDueScheduledEmails();
    expect(gmail.sendMessage).toHaveBeenCalledWith('fixture@example.invalid', 'Fixture', 'Hi<br>there', 'thread-fixture', '<source-fixture@example.invalid>', expect.objectContaining({ timeoutMs: 60000 }));
  });

  test('an alert whose write failed is raised on the next run, and the failing run reads as failed', async () => {
    const { body } = await queue();
    await makeDue(body.scheduled.id);
    gmail.sendMessage.mockRejectedValue(Object.assign(new Error('timeout'), { providerOutcome: { outcomeUnknown: true } }));
    notifyAdmin.mockRejectedValueOnce(new Error('notifications down'));
    notifyAdmin.mockRejectedValueOnce(new Error('notifications down'));
    await expect(sendDueScheduledEmails()).rejects.toMatchObject({ summary: { results: ['outcome_unknown'], missedAlerts: 1 } });
    expect(await database('notifications')).toHaveLength(0);
    expect((await sendDueScheduledEmails()).missedAlerts).toBe(0);
    expect(await database('notifications')).toHaveLength(1);
    expect((await sendDueScheduledEmails()).missedAlerts).toBe(0);
    expect(notifyAdmin).toHaveBeenCalledTimes(3);
    expect(gmail.sendMessage).toHaveBeenCalledTimes(1);
  });

  test('Cancel send returns the draft, stops the send, and repeats safely; a sent email cannot be cancelled', async () => {
    const { body } = await queue();
    const cancelled = await cancel(body.scheduled.id);
    expect(cancelled.body.draft).toMatchObject({ to: 'fixture@example.invalid', subject: 'Fixture', draftText: 'Hi\nthere', status: 'cancelled' });
    await makeDue(body.scheduled.id, { status: 'cancelled' });
    await sendDueScheduledEmails();
    expect(gmail.sendMessage).not.toHaveBeenCalled();
    expect((await call('GET', '/scheduled')).body.emails).toEqual([expect.objectContaining({ id: body.scheduled.id, status: 'cancelled' })]);
    // The text comes back once: a repeat (another tab, a lost answer) gets 409.
    const repeated = await cancel(body.scheduled.id);
    expect(repeated).toMatchObject({ status: 409, body: { cancelled: true } });

    const sent = await queue();
    await makeDue(sent.body.scheduled.id, { status: 'sent' });
    expect((await cancel(sent.body.scheduled.id)).status).toBe(409);
  });

  test('a possible Gmail acceptance is never retried and rings one alert', async () => {
    const { body } = await queue();
    await makeDue(body.scheduled.id);
    gmail.sendMessage.mockRejectedValue(Object.assign(new Error('timeout'), { providerOutcome: { outcomeUnknown: true } }));
    expect((await sendDueScheduledEmails()).results).toEqual(['outcome_unknown']);
    expect((await sendDueScheduledEmails()).results).toEqual([]);
    expect(gmail.sendMessage).toHaveBeenCalledTimes(1);
    expect(await row(body.scheduled.id)).toMatchObject({ status: 'outcome_unknown' });
    expect(notifyAdmin).toHaveBeenCalledTimes(1);
    expect(notifyAdmin.mock.calls[0][1]).toBe('Comms — check Sent for a scheduled email');
    expect(notifyAdmin.mock.calls[0][2]).not.toContain('fixture@example.invalid');
    // The list and the cancelled draft both say Gmail may have it.
    expect((await call('GET', '/scheduled')).body.emails[0]).toMatchObject({ status: 'outcome_unknown', mayHaveSent: true });
    expect((await cancel(body.scheduled.id)).body.draft).toMatchObject({ status: 'cancelled', mayHaveSent: true });
  });

  test('three definite refusals end in failed with one alert; Back to draft still works', async () => {
    const { body } = await queue();
    gmail.sendMessage.mockRejectedValue(new Error('Pre-send failure'));
    const outcomes = [];
    for (let i = 0; i < 3; i += 1) {
      await makeDue(body.scheduled.id);
      outcomes.push(...(await sendDueScheduledEmails()).results);
    }
    expect(outcomes).toEqual(['retry', 'retry', 'failed']);
    expect(await row(body.scheduled.id)).toMatchObject({ status: 'failed', attempts: 3 });
    expect(notifyAdmin).toHaveBeenCalledTimes(1);
    expect((await cancel(body.scheduled.id)).body.draft).toMatchObject({ draftText: 'Hi\nthere' });
  });

  test('each run tries each due email once; a refusal does not hold up the others', async () => {
    const refused = await queue({ to: 'refused@example.invalid' });
    const good = await queue({ to: 'good@example.invalid' });
    await makeDue(refused.body.scheduled.id, { send_at: database.raw("now() - interval '2 minutes'") });
    await makeDue(good.body.scheduled.id);
    gmail.sendMessage.mockImplementation(async (to) => {
      if (to === 'refused@example.invalid') throw new Error('Pre-send failure');
      return { id: 'gmail-good' };
    });
    expect((await sendDueScheduledEmails()).results).toEqual(['retry', 'sent']);
    expect(gmail.sendMessage).toHaveBeenCalledTimes(2);
    expect(await row(refused.body.scheduled.id)).toMatchObject({ status: 'scheduled', attempts: 1 });
    expect(await row(good.body.scheduled.id)).toMatchObject({ status: 'sent' });
  });

  test('a claim left by a dead process becomes outcome_unknown, never a second send', async () => {
    const { body } = await queue();
    await makeDue(body.scheduled.id, { status: 'sending', claimed_at: database.raw("now() - interval '11 minutes'"), attempts: 1 });
    const result = await sendDueScheduledEmails();
    expect(result.settled).toBe(1);
    expect(gmail.sendMessage).not.toHaveBeenCalled();
    expect(await row(body.scheduled.id)).toMatchObject({ status: 'outcome_unknown' });
  });

  test('two cancels at once: exactly one gets the text', async () => {
    const { body } = await queue();
    const [a, b] = await Promise.all([cancel(body.scheduled.id), cancel(body.scheduled.id)]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect([a, b].find((r) => r.status === 200).body.draft).toMatchObject({ draftText: 'Hi\nthere' });
  });

  test('an alert that notifyAdmin did not write (null) counts as missed', async () => {
    const { body } = await queue();
    await makeDue(body.scheduled.id);
    gmail.sendMessage.mockRejectedValue(Object.assign(new Error('timeout'), { providerOutcome: { outcomeUnknown: true } }));
    notifyAdmin.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    await expect(sendDueScheduledEmails()).rejects.toMatchObject({ summary: { missedAlerts: 1 } });
    expect((await sendDueScheduledEmails()).missedAlerts).toBe(0);
    expect(await database('notifications')).toHaveLength(1);
  });

  test('cancelled emails stay listed read-only for 30 days, newest 100; void rows never show', async () => {
    const old = Array.from({ length: 105 }, (_, i) => ({
      to_address: `old${i}@example.invalid`, subject: 'Old', body_html: 'x', draft_text: 'x', status: 'cancelled',
      send_at: database.raw("now() + interval '1 day'"), cancelled_at: database.raw(`now() - interval '${i + 1} hours'`),
      restored_at: database.raw('now()'), client_key: randomUUID(),
    }));
    await database('scheduled_emails').insert(old);
    await database('scheduled_emails').insert({ to_address: 'stale@example.invalid', subject: 'Stale', body_html: 'x', draft_text: 'x', status: 'cancelled',
      send_at: database.raw('now()'), cancelled_at: database.raw("now() - interval '31 days'"), restored_at: database.raw('now()'), client_key: randomUUID() });
    await call('POST', '/schedule/reconcile', { clientKey: randomUUID() });
    const listed = (await call('GET', '/scheduled')).body.emails;
    expect(listed).toHaveLength(100);
    expect(listed.every((e) => e.status === 'cancelled' && e.to !== '' && e.to !== 'stale@example.invalid')).toBe(true);
  });

  test('old settled rows never hide a queued email from the list', async () => {
    const old = Array.from({ length: 120 }, (_, i) => ({
      to_address: `old${i}@example.invalid`, subject: 'Old', body_html: 'x', draft_text: 'x', status: 'failed',
      send_at: database.raw(`now() - interval '${i + 2} days'`), client_key: randomUUID(),
    }));
    await database('scheduled_emails').insert(old);
    const { body } = await queue();
    const listed = (await call('GET', '/scheduled')).body.emails;
    expect(listed.some((e) => e.id === body.scheduled.id && e.status === 'scheduled')).toBe(true);
    // Every unresolved row stays listed: its alert says Back to draft.
    expect(listed.filter((e) => e.status === 'failed')).toHaveLength(120);
  });

  test('job health: a success never hides a failure that finished after it started', async () => {
    const health = () => database('job_health').where({ job_name: 'scheduled-email-send' }).first();
    const t0 = Date.now() - 5000;
    await recordLeaseFreeJobEnd('scheduled-email-send', Date.now() - 1000, new Error('sweep failed'));
    expect(await health()).toMatchObject({ last_status: 'failed', consecutive_failures: 1 });
    // A concurrent sweep that started before the failure finished.
    await recordLeaseFreeJobEnd('scheduled-email-send', t0, null);
    expect(await health()).toMatchObject({ last_status: 'failed', consecutive_failures: 1 });
    // A sweep of a later scheduled minute (the same minute's would not clear it).
    await recordLeaseFreeJobEnd('scheduled-email-send', (Math.floor(Date.now() / 60000) + 1) * 60000 + 1000, null);
    expect(await health()).toMatchObject({ last_status: 'success', consecutive_failures: 0, last_error: null });
    await database('job_health').del();
  });

  test('a retry that finds its email failed uses up the row, so Back to draft cannot return it again', async () => {
    const clientKey = randomUUID();
    const { body } = await queue({ clientKey });
    await database('scheduled_emails').where({ id: body.scheduled.id }).update({ status: 'failed' });
    const retry = await queue({ clientKey });
    expect(retry.body.scheduled).toMatchObject({ id: body.scheduled.id, status: 'failed' });
    expect(await row(body.scheduled.id)).toMatchObject({ status: 'cancelled' });
    expect((await row(body.scheduled.id)).restored_at).not.toBeNull();
    // Listed read-only (Show text); it can no longer be taken into a draft.
    expect((await call('GET', '/scheduled')).body.emails).toEqual([expect.objectContaining({ id: body.scheduled.id, status: 'cancelled' })]);
    expect((await cancel(body.scheduled.id)).status).toBe(409);
  });

  test('reconcile voids an unknown key so a late request cannot queue, and returns a known row', async () => {
    const clientKey = randomUUID();
    expect((await call('POST', '/schedule/reconcile', { clientKey })).body).toEqual({ success: true, scheduled: null });
    // The original request lands afterwards: it finds the void row.
    const late = await queue({ clientKey });
    expect(late.body.scheduled).toMatchObject({ status: 'cancelled' });
    expect(await database('scheduled_emails').where({ client_key: clientKey })).toHaveLength(1);
    expect((await call('GET', '/scheduled')).body.emails).toEqual([]);
    await makeDue(late.body.scheduled.id, { status: 'cancelled' });
    expect((await sendDueScheduledEmails()).results).toEqual([]);
    const knownKey = randomUUID();
    const known = await queue({ clientKey: knownKey });
    expect((await call('POST', '/schedule/reconcile', { clientKey: knownKey })).body.scheduled)
      .toMatchObject({ id: known.body.scheduled.id, status: 'scheduled' });
  });

  test('a time refusal voids its key, so a first request landing later cannot queue', async () => {
    const clientKey = randomUUID();
    const refused = await queue({ clientKey, sendAt: etIn(-5) });
    expect(refused).toMatchObject({ status: 400, body: { keyChecked: true } });
    const late = await queue({ clientKey });
    expect(late.body.scheduled).toMatchObject({ status: 'cancelled' });
    expect((await call('GET', '/scheduled')).body.emails).toEqual([]);
  });

  test('alerts close from the row state: taken back, or the Sent check answered on the email', async () => {
    const alertOpen = async (id) => (await database('notifications').whereRaw("metadata->>'dedupeKey' = ?", [`scheduled-email:${id}`]).first()).done_at === null;
    const rows = {};
    for (const name of ['refused', 'inSent', 'notSent']) rows[name] = (await queue({ to: `${name}@example.invalid` })).body.scheduled.id;
    await database('scheduled_emails').where({ id: rows.refused }).update({ status: 'failed' });
    await database('scheduled_emails').whereIn('id', [rows.inSent, rows.notSent]).update({ status: 'outcome_unknown' });
    await sendDueScheduledEmails();
    for (const id of Object.values(rows)) expect(await alertOpen(id)).toBe(true);
    await cancel(rows.refused);
    expect((await call('POST', `/scheduled/${rows.inSent}/sent-check`, { inSent: true })).status).toBe(200);
    expect((await call('POST', `/scheduled/${rows.notSent}/sent-check`, { inSent: false })).status).toBe(200);
    expect(await row(rows.inSent)).toMatchObject({ status: 'sent' });
    expect(await row(rows.notSent)).toMatchObject({ status: 'cancelled' });
    // Not in Sent used up the recovery copy: no second draft from the list.
    expect((await cancel(rows.notSent)).status).toBe(409);
    await sendDueScheduledEmails();
    for (const id of Object.values(rows)) expect(await alertOpen(id)).toBe(false);
    expect((await call('POST', `/scheduled/${rows.inSent}/sent-check`, {})).status).toBe(400);
    // A check on an email already taken back elsewhere is not a success.
    const unclear = (await queue({ to: 'taken@example.invalid' })).body.scheduled.id;
    await database('scheduled_emails').where({ id: unclear }).update({ status: 'outcome_unknown' });
    await cancel(unclear);
    expect(await call('POST', `/scheduled/${unclear}/sent-check`, { inSent: false })).toMatchObject({ status: 409, body: { status: 'cancelled' } });
  });

  test('with the gate off, queued emails stay listed and can be cancelled; nothing new is queued', async () => {
    const { body } = await queue();
    delete process.env.GATE_EMAIL_SEND_LATER;
    expect((await call('GET', '/scheduled')).body).toMatchObject({ enabled: false, emails: [expect.objectContaining({ id: body.scheduled.id })] });
    expect((await cancel(body.scheduled.id)).body.draft).toMatchObject({ draftText: 'Hi\nthere' });
    expect((await queue()).status).toBe(404);
  });

  test('a taken-back email that may have gone out keeps its alert until the Sent check is recorded', async () => {
    const alertOpen = async (id) => (await database('notifications').whereRaw("metadata->>'dedupeKey' = ?", [`scheduled-email:${id}`]).first()).done_at === null;
    const { body } = await queue();
    await makeDue(body.scheduled.id);
    gmail.sendMessage.mockRejectedValue(Object.assign(new Error('timeout'), { providerOutcome: { outcomeUnknown: true } }));
    await sendDueScheduledEmails();
    expect((await cancel(body.scheduled.id)).body.draft).toMatchObject({ mayHaveSent: true });
    await sendDueScheduledEmails();
    expect(await alertOpen(body.scheduled.id)).toBe(true);
    // Without takenBack the server refuses: this row was taken back.
    expect((await call('POST', `/scheduled/${body.scheduled.id}/sent-check`, { inSent: false })).status).toBe(409);
    expect((await call('POST', `/scheduled/${body.scheduled.id}/sent-check`, { inSent: false, takenBack: true })).status).toBe(200);
    expect((await call('POST', `/scheduled/${body.scheduled.id}/sent-check`, { inSent: false, takenBack: true })).status).toBe(200);
    expect((await call('GET', '/scheduled')).body.emails[0]).toMatchObject({ status: 'cancelled', mayHaveSent: false });
    await sendDueScheduledEmails();
    expect(await alertOpen(body.scheduled.id)).toBe(false);
  });

  test('job health: a success never hides a failure of the same scheduled minute', async () => {
    const health = () => database('job_health').where({ job_name: 'fence-fixture' }).first();
    const minute = Math.floor(Date.now() / 60000) * 60000;
    await recordLeaseFreeJobEnd('fence-fixture', minute + 1000, new Error('fast failure'));
    // A slightly late replica of the same minute starts after that failure finished.
    await recordLeaseFreeJobEnd('fence-fixture', Date.now() + 5, null);
    expect(await health()).toMatchObject({ last_status: 'failed' });
    await database('job_health').del();
  });

  test('reconcile still settles a key with the gate off (it sends nothing)', async () => {
    delete process.env.GATE_EMAIL_SEND_LATER;
    expect((await call('POST', '/schedule/reconcile', { clientKey: randomUUID() })).body).toEqual({ success: true, scheduled: null });
  });

  test('a refused email waits a minute before any replica tries it again', async () => {
    const { body } = await queue();
    await makeDue(body.scheduled.id);
    gmail.sendMessage.mockRejectedValue(new Error('Pre-send failure'));
    expect((await sendDueScheduledEmails()).results).toEqual(['retry']);
    // Another replica's sweep right after (its own tried list is empty).
    expect((await sendDueScheduledEmails()).results).toEqual([]);
    expect(await row(body.scheduled.id)).toMatchObject({ status: 'scheduled', attempts: 1 });
    await database('scheduled_emails').where({ id: body.scheduled.id }).update({ claimed_at: database.raw("now() - interval '61 seconds'") });
    expect((await sendDueScheduledEmails()).results).toEqual(['retry']);
  });

  test('a failed claim still sends the rows already claimed, and the run reads as failed', async () => {
    const first = await queue({ to: 'first@example.invalid' });
    const second = await queue({ to: 'second@example.invalid' });
    await makeDue(first.body.scheduled.id, { send_at: database.raw("now() - interval '2 minutes'") });
    await makeDue(second.body.scheduled.id);
    let claims = 0;
    const flaky = (...args) => database(...args);
    flaky.fn = database.fn;
    flaky.raw = (sql, ...rest) => {
      if (/SET status = 'sending'/.test(sql) && (claims += 1) === 2) return Promise.reject(new Error('claim down'));
      return database.raw(sql, ...rest);
    };
    gmail.sendMessage.mockResolvedValue({ id: 'gmail-first' });
    await expect(sendDueScheduledEmails({ conn: flaky })).rejects.toMatchObject({ summary: { results: ['sent', 'error'] } });
    expect(await row(first.body.scheduled.id)).toMatchObject({ status: 'sent' });
    expect(await row(second.body.scheduled.id)).toMatchObject({ status: 'scheduled' });
  });

  test('a claim settled by another sweep before the Gmail request stops the send', async () => {
    const { body } = await queue();
    await makeDue(body.scheduled.id);
    let requested = false;
    gmail.sendMessage.mockImplementation(async (...args) => {
      // Sign-in stalled; meanwhile another replica settled the stale claim.
      await database('scheduled_emails').where({ id: body.scheduled.id }).update({ status: 'outcome_unknown' });
      await args[5].beforeSend();
      requested = true;
      return { id: 'gmail-late' };
    });
    expect((await sendDueScheduledEmails()).results).toEqual(['claim_lost']);
    expect(requested).toBe(false);
    expect(await row(body.scheduled.id)).toMatchObject({ status: 'outcome_unknown' });
  });

  test('the gate turned off mid-sweep stops the send and puts the row back', async () => {
    const { body } = await queue();
    await makeDue(body.scheduled.id);
    let requested = false;
    gmail.sendMessage.mockImplementation(async (...args) => {
      delete process.env.GATE_EMAIL_SEND_LATER;
      await args[5].beforeSend();
      requested = true;
      return { id: 'gmail-gate-off' };
    });
    expect((await sendDueScheduledEmails()).results).toEqual(['claim_lost']);
    expect(requested).toBe(false);
    expect(await row(body.scheduled.id)).toMatchObject({ status: 'scheduled', attempts: 0, claimed_at: null });
  });

  test('an accepted email that cannot be recorded as sent makes the run unhealthy, never a resend', async () => {
    const { body } = await queue();
    await makeDue(body.scheduled.id);
    const flaky = (...args) => {
      const qb = database(...args);
      const update = qb.update.bind(qb);
      qb.update = (fields, ...rest) => (fields?.status === 'sent' ? Promise.reject(new Error('db down')) : update(fields, ...rest));
      return qb;
    };
    flaky.fn = database.fn;
    flaky.raw = (...args) => database.raw(...args);
    gmail.sendMessage.mockImplementation(async (...args) => { await args[5].beforeSend(); return { id: 'gmail-accepted' }; });
    await expect(sendDueScheduledEmails({ conn: flaky })).rejects.toMatchObject({ summary: { results: ['sent_unrecorded'] } });
    expect(await row(body.scheduled.id)).toMatchObject({ status: 'sending' });
    expect((await sendDueScheduledEmails()).results).toEqual([]);
    expect(gmail.sendMessage).toHaveBeenCalledTimes(1);
  });

  test('due emails go to Gmail up to five at a time', async () => {
    for (let i = 0; i < 6; i += 1) {
      const { body } = await queue({ to: `batch${i}@example.invalid` });
      await makeDue(body.scheduled.id);
    }
    let live = 0;
    let peak = 0;
    gmail.sendMessage.mockImplementation(async () => {
      live += 1; peak = Math.max(peak, live);
      await new Promise((resolve) => setTimeout(resolve, 30));
      live -= 1;
      return { id: `gmail-${randomUUID()}` };
    });
    expect((await sendDueScheduledEmails()).results).toEqual(Array(6).fill('sent'));
    expect(peak).toBe(5);
  });

  test('with the gate off the sender sends nothing, and queued rows wait', async () => {
    const { body } = await queue();
    await makeDue(body.scheduled.id);
    delete process.env.GATE_EMAIL_SEND_LATER;
    expect(await sendDueScheduledEmails()).toEqual({ enabled: false, settled: 0, results: [] });
    expect(await row(body.scheduled.id)).toMatchObject({ status: 'scheduled' });
  });
});
