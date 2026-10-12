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
  async function seedHold(callId, phone, heldAt, extra = {}) {
    await database.raw('INSERT INTO call_log (id) VALUES (?) ON CONFLICT DO NOTHING', [callId]);
    await database('disclaimed_number_holds').insert({ phone_e164: phone, source_call_log_id: callId, held_at: heldAt, ...extra });
  }
  async function seedCard(callId, createdAt, { status = 'resolved', ani = X, reason = 'text_number_differs', payload = {} } = {}) {
    const id = randomUUID();
    await database('triage_items').insert({ id, call_log_id: callId, reason_code: reason, status, created_at: createdAt, updated_at: createdAt,
      payload: JSON.stringify({ ani_phone: ani, ...payload }) });
    return id;
  }
  const listed = async () => (await (await fetch(`${baseUrl}/admin/triage/held-lines`)).json()).lines;

  test('a card filed BEFORE the hold was last armed does not make it a no-text hold; one filed after does', async () => {
    const stale = randomUUID();
    const fresh = randomUUID();
    await seedHold(stale, X, T('2030-02-01T10:00:00Z'));
    await seedCard(stale, T('2030-01-01T10:00:00Z')); // closed card from an earlier no-text arming
    await seedHold(fresh, X, T('2030-02-01T10:00:00Z'));
    const cardId = await seedCard(fresh, T('2030-02-01T10:00:05Z'));
    const lines = await listed();
    expect(lines.map((l) => l.source_call_log_id)).toEqual([fresh]);
    expect(lines[0].card_id).toBe(cardId);
  });

  test('a card in the SAME instant as the hold (one arming transaction) counts; an OPEN older card counts', async () => {
    const same = randomUUID();
    const open = randomUUID();
    await seedHold(same, X, T('2030-02-01T10:00:00Z'));
    await seedCard(same, T('2030-02-01T10:00:00Z'));
    await seedHold(open, Y, T('2030-02-02T10:00:00Z'));
    await seedCard(open, T('2030-02-01T10:00:00Z'), { status: 'open', ani: Y });
    expect((await listed()).map((l) => l.source_call_log_id).sort()).toEqual([same, open].sort());
  });

  test('a card for a different line does not bind to the hold (ani_phone compared on its digits)', async () => {
    const callId = randomUUID();
    await seedHold(callId, X, T('2030-02-01T10:00:00Z'));
    await seedCard(callId, T('2030-02-01T10:00:05Z'), { ani: Y });
    expect(await listed()).toEqual([]);
    await seedCard(callId, T('2030-02-01T10:00:06Z'), { ani: '(941) 555-1234' });
    expect((await listed()).map((l) => l.source_call_log_id)).toEqual([callId]);
  });

  test('clearNoTextHoldsForPhone and linesBlockedByOwnershipCard use the same binding', async () => {
    const real = randomUUID();
    const reArmed = randomUUID();
    const source = randomUUID();
    await seedHold(real, X, T('2030-02-01T10:00:00Z'));
    await seedCard(real, T('2030-02-01T10:00:05Z'));
    await seedHold(reArmed, X, T('2030-03-01T10:00:00Z')); // re-armed later, ownership-only
    await seedCard(reArmed, T('2030-01-01T10:00:00Z'));
    await seedCard(reArmed, T('2030-03-01T10:00:00Z'), { reason: 'callback_number_needed', status: 'open', payload: { ownership_disclaimed: true } });
    expect((await Holds.linesBlockedByOwnershipCard(database, [X, Y])).size).toBe(0); // no bound text card on that call
    const cleared = await Holds.clearNoTextHoldsForPhone({ phoneE164: X, exceptCallLogId: source, clearedBy: 'tech-1', reason: 'verified_same_number', conn: database });
    expect(cleared).toEqual([real]);
    const rows = await database('disclaimed_number_holds').where({ source_call_log_id: reArmed });
    expect(rows[0].cleared_at).toBeNull(); // the ownership-only hold stays
  });

  test('a bound no-text hold whose call has an open ownership card blocks the whole line', async () => {
    const a = randomUUID();
    const b = randomUUID();
    await seedHold(a, X, T('2030-02-01T10:00:00Z'));
    await seedCard(a, T('2030-02-01T10:00:05Z'));
    await seedHold(b, X, T('2030-02-02T10:00:00Z'));
    await seedCard(b, T('2030-02-02T10:00:05Z'));
    await seedCard(b, T('2030-02-02T10:00:05Z'), { reason: 'callback_number_needed', status: 'open', payload: {} });
    expect([...await Holds.linesBlockedByOwnershipCard(database, [X, Y])]).toEqual([X]);
    // the same card, resolved, no longer blocks
    await database('triage_items').where({ reason_code: 'callback_number_needed' }).update({ status: 'resolved' });
    expect((await Holds.linesBlockedByOwnershipCard(database, [X])).size).toBe(0);
  });
});
