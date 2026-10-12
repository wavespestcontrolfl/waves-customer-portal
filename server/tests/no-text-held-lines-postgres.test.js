// The held-lines SQL against real PostgreSQL (#6292 codex r3): a no-text hold counts only with a
// text_number_differs card bound to the held line and to the hold's CURRENT arming. Self-contained:
// it shadows the four tables it reads with TEMP tables on one connection, so it needs no migrations and
// runs only on a local disposable database (DATABASE_URL on localhost; skipped otherwise).
const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;
jest.setTimeout(30000);
jest.mock('../models/db', () => {
  const db = (...args) => db.connection(...args);
  db.raw = (...args) => db.connection.raw(...args);
  db.transaction = (...args) => db.connection.transaction(...args);
  Object.defineProperty(db, 'schema', { get: () => db.connection.schema });
  Object.defineProperty(db, 'fn', { get: () => db.connection.fn });
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/audit-log', () => ({ recordAuditEvent: jest.fn(async () => {}) }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, _res, next) => { req.technician = { id: 'tech-1', role: 'admin' }; req.technicianId = 'tech-1'; req.techRole = 'admin'; next(); },
  requireTechOrAdmin: (_req, _res, next) => next(),
  requireAdmin: (_req, _res, next) => next(),
}));

const express = require('express');
const { randomUUID } = require('node:crypto');

postgres('held lines SQL against PostgreSQL', () => {
  let database;
  let Holds;
  let server;
  let baseUrl;
  const X = '+19415551234';
  const Y = '+19415557777';

  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL);
    if (!['localhost', '127.0.0.1'].includes(url.hostname)) throw new Error('Use a local disposable database');
    // One connection, so the TEMP tables below are the tables every query in this file sees.
    database = require('knex')({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 1, max: 1 } });
    require('../models/db').connection = database;
    await database.raw(`CREATE TEMP TABLE disclaimed_number_holds (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), phone_e164 text NOT NULL, customer_id uuid, source_call_log_id uuid NOT NULL,
      held_at timestamptz NOT NULL DEFAULT now(), cleared_at timestamptz, cleared_by text, clear_reason text, updated_at timestamptz DEFAULT now(),
      UNIQUE (phone_e164, source_call_log_id))`);
    await database.raw(`CREATE TEMP TABLE triage_items (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), call_log_id uuid, reason_code text, status text, payload jsonb,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now())`);
    await database.raw('CREATE TEMP TABLE call_log (id uuid PRIMARY KEY, created_at timestamptz DEFAULT now(), customer_id uuid)');
    await database.raw('CREATE TEMP TABLE customers (id uuid PRIMARY KEY, first_name text, last_name text)');
    Holds = require('../services/disclaimed-number-holds');
    const app = express();
    app.use('/admin/triage', require('../routes/admin-triage'));
    server = app.listen(0);
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (database) await database.destroy();
  });

  beforeEach(async () => {
    await database.raw('TRUNCATE disclaimed_number_holds, triage_items, call_log, customers');
  });

  const T = (iso) => new Date(iso);
  const HELD = '2030-02-01T10:00:00.123456Z'; // microseconds: the stamp must survive full precision
  async function insertHold(callId, phone, heldAt, extra = {}) {
    await database.raw('INSERT INTO call_log (id) VALUES (?) ON CONFLICT DO NOTHING', [callId]);
    await database('disclaimed_number_holds').insert({ phone_e164: phone, source_call_log_id: callId, held_at: heldAt, ...extra });
  }
  async function insertCard(callId, createdAt, { status = 'open', ani = X, reason = 'text_number_differs', payload = {} } = {}) {
    const id = randomUUID();
    await database('triage_items').insert({ id, call_log_id: callId, reason_code: reason, status, created_at: createdAt, updated_at: createdAt,
      payload: JSON.stringify({ ani_phone: ani, ...payload }) });
    return id;
  }
  // The processor's real order: the card is BUILT first (its created_at is earlier), the hold row is armed
  // after (held_at later), then the card is stamped in the same transaction; staff close the card later.
  async function armNoText(callId, phone = X, { cardAt = '2030-02-01T09:59:59Z', heldAt = HELD, close = 'resolved' } = {}) {
    const cardId = await insertCard(callId, cardAt, { ani: phone });
    await insertHold(callId, phone, heldAt);
    await Holds.stampOpenNoTextCards(database, callId);
    if (close) await database('triage_items').where({ id: cardId }).update({ status: close });
    return cardId;
  }
  const listed = async () => (await (await fetch(`${baseUrl}/admin/triage/held-lines`)).json()).lines;

  test('the normal order (card first, hold after) binds, and the CLOSED card still binds', async () => {
    const callId = randomUUID();
    const cardId = await armNoText(callId);
    const stamped = (await database('triage_items').where({ id: cardId }).first()).payload.hold_held_at;
    expect(stamped).toBeTruthy();
    const lines = await listed();
    expect(lines.map((l) => [l.source_call_log_id, l.card_id, l.card_status])).toEqual([[callId, cardId, 'resolved']]);
    const other = randomUUID();
    await insertHold(other, X, T('2030-03-01T10:00:00Z'));
    await insertCard(other, T('2030-03-01T09:59:00Z'), { status: 'resolved' });
    // an unrelated call's hold with an unstamped card binds by line (legacy), and the release reaches both
    expect(await Holds.clearNoTextHoldsForPhone({ phoneE164: X, exceptCallLogId: randomUUID(), clearedBy: 't', reason: 'verified_same_number', conn: database })).toHaveLength(2);
  });

  test('a hold released and re-armed later for an ownership-only reason is not listed and not cleared', async () => {
    const callId = randomUUID();
    await armNoText(callId);
    await database('disclaimed_number_holds').where({ source_call_log_id: callId }).update({ cleared_at: new Date() }); // released
    await Holds.recordDisclaimedNumberHold({ phone: X, callLogId: callId, conn: database }); // ownership re-arm: new held_at = now()
    expect(await listed()).toEqual([]);
    const cleared = await Holds.clearNoTextHoldsForPhone({ phoneE164: X, exceptCallLogId: randomUUID(), clearedBy: 't', reason: 'verified_same_number', conn: database });
    expect(cleared).toEqual([]);
    expect((await database('disclaimed_number_holds').where({ source_call_log_id: callId }).first()).cleared_at).toBeNull();
  });

  test('a later no-text re-arm with its card open re-stamps the card, and it binds again after it is closed', async () => {
    const callId = randomUUID();
    const cardId = await armNoText(callId, X, { close: null });
    await database('disclaimed_number_holds').where({ source_call_log_id: callId }).update({ cleared_at: new Date() });
    await Holds.recordDisclaimedNumberHold({ phone: X, callLogId: callId, conn: database }); // re-armed while the card is still open
    await Holds.stampOpenNoTextCards(database, callId);
    await database('triage_items').where({ id: cardId }).update({ status: 'dismissed' });
    expect((await listed()).map((l) => l.card_id)).toEqual([cardId]);
  });

  test('a card for a different line does not bind to the hold (ani_phone compared on its digits)', async () => {
    const callId = randomUUID();
    await insertHold(callId, X, T('2030-02-01T10:00:00Z'));
    await insertCard(callId, T('2030-02-01T10:00:05Z'), { ani: Y, status: 'resolved' });
    expect(await listed()).toEqual([]);
    await insertCard(callId, T('2030-02-01T10:00:06Z'), { ani: '(941) 555-1234', status: 'resolved' });
    expect((await listed()).map((l) => l.source_call_log_id)).toEqual([callId]);
  });

  test('a call with two lines and a card for each lists each line with its own card', async () => {
    const callId = randomUUID();
    const cx = await armNoText(callId, X);
    const cy = await armNoText(callId, Y, { heldAt: '2030-02-02T10:00:00.5Z', cardAt: '2030-02-02T09:59:59Z' });
    const byPhone = Object.fromEntries((await listed()).map((l) => [l.phone_e164, l.card_id]));
    expect(byPhone).toEqual({ [X]: cx, [Y]: cy });
  });

  test('a call that only disclaimed the same number (no text card) blocks the line; resolved, it does not', async () => {
    const a = randomUUID();
    const b = randomUUID();
    await armNoText(a);
    await insertHold(b, X, T('2030-02-02T10:00:00Z'));
    const cb = await insertCard(b, T('2030-02-02T10:00:00Z'), { reason: 'callback_number_needed', payload: {} });
    expect([...await Holds.linesBlockedByOwnershipCard(database, [X, Y])]).toEqual([X]);
    await database('triage_items').where({ id: cb }).update({ status: 'resolved' });
    expect((await Holds.linesBlockedByOwnershipCard(database, [X])).size).toBe(0);
  });
});
