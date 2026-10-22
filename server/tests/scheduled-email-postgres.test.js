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
}));

const express = require('express');
const gmail = require('../services/email/gmail-client');
const { notifyAdmin } = require('../services/notification-service');
const { sendDueScheduledEmails } = require('../services/email/scheduled-email-sender');
const { recordLeaseFreeJobEnd } = require('../utils/cron-lock');
const migration = require('../models/migrations/20261022130000_scheduled_emails');
const restoredMigration = require('../models/migrations/20261022150000_scheduled_emails_restored_at');
const restoreKeyMigration = require('../models/migrations/20261022160000_scheduled_emails_restore_key');

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
    // Minimal stand-ins for the tables the sender reads beside its own.
    await database.schema.createTable('notifications', (t) => { t.increments('id'); t.string('recipient_type'); t.jsonb('metadata'); });
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
    gmail.sendMessage.mockResolvedValue({ id: 'gmail-fixture-1' });
    expect((await sendDueScheduledEmails()).results).toEqual(['sent']);
    expect(gmail.sendMessage).toHaveBeenCalledWith('fixture@example.invalid', 'Fixture', 'Hi<br>there', null, null, { timeoutMs: 60000 });
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
    expect(gmail.sendMessage).toHaveBeenCalledWith('fixture@example.invalid', 'Fixture', 'Hi<br>there', 'thread-fixture', '<source-fixture@example.invalid>', { timeoutMs: 60000 });
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
    const repeated = await cancel(body.scheduled.id);
    expect(repeated).toMatchObject({ status: 200, body: { draft: { draftText: 'Hi\nthere' } } });

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

  test('only the tab that cancelled gets the text back; its own repeat still works', async () => {
    const { body } = await queue();
    const [a, b] = await Promise.all([cancel(body.scheduled.id, 'tab-a-fixture-key'), cancel(body.scheduled.id, 'tab-b-fixture-key')]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);
    const winner = a.status === 200 ? 'tab-a-fixture-key' : 'tab-b-fixture-key';
    const loser = winner === 'tab-a-fixture-key' ? 'tab-b-fixture-key' : 'tab-a-fixture-key';
    expect((await cancel(body.scheduled.id, winner)).body.draft).toMatchObject({ draftText: 'Hi\nthere' });
    expect(await cancel(body.scheduled.id, loser)).toMatchObject({ status: 409, body: { error: expect.stringMatching(/^This email is already open as a draft in another tab/) } });
    // A claim is never taken over by time.
    await database('scheduled_emails').where({ id: body.scheduled.id }).update({ updated_at: database.raw("now() - interval '2 days'") });
    expect((await cancel(body.scheduled.id, loser)).status).toBe(409);
    expect((await call('POST', `/scheduled/${body.scheduled.id}/cancel`, {})).status).toBe(400);
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

  test('a cancelled email marked restored leaves the list, so its text cannot come back twice', async () => {
    const { body } = await queue();
    await cancel(body.scheduled.id);
    expect((await call('GET', '/scheduled')).body.emails).toEqual([expect.objectContaining({ id: body.scheduled.id, status: 'cancelled' })]);
    expect((await call('POST', `/scheduled/${body.scheduled.id}/restored`)).status).toBe(200);
    expect((await call('POST', `/scheduled/${body.scheduled.id}/restored`)).status).toBe(200);
    expect((await call('GET', '/scheduled')).body.emails).toEqual([]);
    expect(await row(body.scheduled.id)).toMatchObject({ status: 'cancelled' });
    expect(await cancel(body.scheduled.id)).toMatchObject({ status: 409, body: { error: 'This email is already back in a draft.' } });
  });

  test('an unconfirmed cancel stays listed however old it is; a confirmed one leaves', async () => {
    const far = Array.from({ length: 110 }, (_, i) => ({
      to_address: `far${i}@example.invalid`, subject: 'Far', body_html: 'x', draft_text: 'x', status: 'cancelled',
      send_at: database.raw(`now() + interval '${i + 30} days'`), cancelled_at: database.raw("now() - interval '1 hour'"),
      updated_at: database.raw("now() - interval '1 hour'"), client_key: randomUUID(),
    }));
    await database('scheduled_emails').insert(far);
    const { body } = await queue();
    await cancel(body.scheduled.id);
    // A cancel from days ago whose answer was lost is still recoverable.
    await database('scheduled_emails').where({ id: body.scheduled.id }).update({ cancelled_at: database.raw("now() - interval '4 days'") });
    const listed = (await call('GET', '/scheduled')).body.emails;
    expect(listed.some((e) => e.id === body.scheduled.id && e.status === 'cancelled')).toBe(true);
    expect(listed.filter((e) => e.status === 'cancelled')).toHaveLength(111);
    await call('POST', `/scheduled/${body.scheduled.id}/restored`);
    expect((await call('GET', '/scheduled')).body.emails.some((e) => e.id === body.scheduled.id)).toBe(false);
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
    // A later sweep that started after it.
    await recordLeaseFreeJobEnd('scheduled-email-send', Date.now(), null);
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
    expect((await call('GET', '/scheduled')).body.emails).toEqual([]);
    expect((await cancel(body.scheduled.id)).status).toBe(409);
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
