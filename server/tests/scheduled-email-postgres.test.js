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
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => ({ id: 'fixture-alert' })) }));

const express = require('express');
const gmail = require('../services/email/gmail-client');
const { notifyAdmin } = require('../services/notification-service');
const { sendDueScheduledEmails } = require('../services/email/scheduled-email-sender');
const migration = require('../models/migrations/20261022130000_scheduled_emails');

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
  const makeDue = (id, extra = {}) => database('scheduled_emails').where({ id }).update({ send_at: database.raw("now() - interval '1 minute'"), ...extra });
  const row = (id) => database('scheduled_emails').where({ id }).first();

  beforeAll(async () => {
    database = knex({ client: 'pg', connection: process.env.DATABASE_URL, searchPath: [schema], pool: { min: 0, max: 3 } });
    await database.raw('CREATE SCHEMA ??', [schema]);
    await migration.up(database);
    mockConn = database;
    const app = express();
    app.use(express.json());
    app.use('/api/admin/email', require('../routes/admin-email'));
    await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  });
  beforeEach(() => { process.env.GATE_EMAIL_SEND_LATER = 'true'; jest.clearAllMocks(); });
  afterEach(async () => { await database('scheduled_emails').del(); delete process.env.GATE_EMAIL_SEND_LATER; });
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
    expect(gmail.sendMessage).toHaveBeenCalledWith('fixture@example.invalid', 'Fixture', 'Hi<br>there', null);
    expect(await row(first.body.scheduled.id)).toMatchObject({ status: 'sent', gmail_message_id: 'gmail-fixture-1', attempts: 1 });
    expect((await sendDueScheduledEmails()).results).toEqual([]);
    expect(gmail.sendMessage).toHaveBeenCalledTimes(1);
    expect((await call('GET', '/scheduled')).body.emails).toEqual([]);
  });

  test('a reply goes out in its Gmail thread', async () => {
    const { body } = await queue({ threadId: 'thread-fixture', replyEmailId: randomUUID() });
    await makeDue(body.scheduled.id);
    gmail.sendMessage.mockResolvedValue({ id: 'gmail-fixture-2' });
    await sendDueScheduledEmails();
    expect(gmail.sendMessage).toHaveBeenCalledWith('fixture@example.invalid', 'Fixture', 'Hi<br>there', 'thread-fixture');
  });

  test('Cancel send returns the draft, stops the send, and repeats safely; a sent email cannot be cancelled', async () => {
    const { body } = await queue();
    const cancelled = await call('POST', `/scheduled/${body.scheduled.id}/cancel`);
    expect(cancelled.body.draft).toMatchObject({ to: 'fixture@example.invalid', subject: 'Fixture', draftText: 'Hi\nthere', status: 'cancelled' });
    await makeDue(body.scheduled.id, { status: 'cancelled' });
    await sendDueScheduledEmails();
    expect(gmail.sendMessage).not.toHaveBeenCalled();
    const repeated = await call('POST', `/scheduled/${body.scheduled.id}/cancel`);
    expect(repeated).toMatchObject({ status: 200, body: { draft: { draftText: 'Hi\nthere' } } });

    const sent = await queue();
    await makeDue(sent.body.scheduled.id, { status: 'sent' });
    expect((await call('POST', `/scheduled/${sent.body.scheduled.id}/cancel`)).status).toBe(409);
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
    expect((await call('POST', `/scheduled/${body.scheduled.id}/cancel`)).body.draft).toMatchObject({ draftText: 'Hi\nthere' });
  });

  test('a claim left by a dead process becomes outcome_unknown, never a second send', async () => {
    const { body } = await queue();
    await makeDue(body.scheduled.id, { status: 'sending', claimed_at: database.raw("now() - interval '11 minutes'"), attempts: 1 });
    const result = await sendDueScheduledEmails();
    expect(result.settled).toBe(1);
    expect(gmail.sendMessage).not.toHaveBeenCalled();
    expect(await row(body.scheduled.id)).toMatchObject({ status: 'outcome_unknown' });
  });

  test('with the gate off the sender sends nothing, and queued rows wait', async () => {
    const { body } = await queue();
    await makeDue(body.scheduled.id);
    delete process.env.GATE_EMAIL_SEND_LATER;
    expect(await sendDueScheduledEmails()).toEqual({ enabled: false, settled: 0, results: [] });
    expect(await row(body.scheduled.id)).toMatchObject({ status: 'scheduled' });
  });
});
