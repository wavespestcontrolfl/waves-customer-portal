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
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), resolved_at timestamptz,
      resolution_note text, resolution_source text, assigned_to text)`);
    await database.raw('CREATE TEMP TABLE call_log (id uuid PRIMARY KEY, created_at timestamptz DEFAULT now(), customer_id uuid, review_status text, updated_at timestamptz)');
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
  const HELD = '2030-02-01T10:00:00.123456Z'; // microseconds: the binding must survive full precision
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
  // after (held_at later), then the open card is stamped in the same transaction; staff close it later.
  async function armNoText(callId, phone = X, { cardAt = '2030-02-01T09:59:59Z', heldAt = HELD, close = 'resolved' } = {}) {
    const cardId = await insertCard(callId, cardAt, { ani: phone });
    await insertHold(callId, phone, heldAt);
    await Holds.stampOpenNoTextCards(database, callId, { phone });
    if (close) await database('triage_items').where({ id: cardId }).update({ status: close });
    return cardId;
  }
  const listed = async () => (await (await fetch(`${baseUrl}/admin/triage/held-lines`)).json()).lines;
  const bindings = async (cardId) => (await database('triage_items').where({ id: cardId }).first()).payload.hold_bindings;

  test('the normal order (card first, hold after) binds, and the CLOSED card still binds', async () => {
    const callId = randomUUID();
    const cardId = await armNoText(callId);
    expect(await bindings(cardId)).toEqual([{ line_e164: X, held_at: expect.any(String) }]);
    const lines = await listed();
    expect(lines.map((l) => [l.source_call_log_id, l.card_id, l.card_status])).toEqual([[callId, cardId, 'resolved']]);
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
    await Holds.stampOpenNoTextCards(database, callId, { phone: X });
    expect((await bindings(cardId))).toHaveLength(2); // appended, never replaced
    await database('triage_items').where({ id: cardId }).update({ status: 'dismissed' });
    expect((await listed()).map((l) => l.card_id)).toEqual([cardId]);
  });

  test('ONE open card binds BOTH lines of a call (X, then a Y re-arm refreshes the same card); releasing Y leaves X listed and releasable', async () => {
    const callId = randomUUID();
    const cardId = await armNoText(callId, X, { close: null });
    await insertHold(callId, Y, '2030-02-01T10:30:00.5Z'); // the call now also holds Y
    // the processor's refresh rewrites the single open card from the Y pass: ani_phone becomes Y, bindings stay
    await database('triage_items').where({ id: cardId }).update({ payload: Holds.refreshedCardPayload(database, JSON.stringify({ ani_phone: Y, note: 'refreshed' })) });
    await Holds.stampOpenNoTextCards(database, callId, { phone: Y });
    expect((await bindings(cardId)).map((b) => b.line_e164).sort()).toEqual([X, Y]);
    await database('triage_items').where({ id: cardId }).update({ status: 'resolved' });
    const byPhone = Object.fromEntries((await listed()).map((l) => [l.phone_e164, l.card_id]));
    expect(byPhone).toEqual({ [X]: cardId, [Y]: cardId }); // both lines keep a release surface
    // release Y only (what the panel's line_e164 does), then X is still listed and still releasable from another call
    await Holds.clearDisclaimedNumberHoldsForCall({ callLogId: callId, reason: 'verified_same_number', phoneKeys: [Y], conn: database });
    expect((await listed()).map((l) => l.phone_e164)).toEqual([X]);
    const other = randomUUID();
    expect(await Holds.clearNoTextHoldsForPhone({ phoneE164: X, exceptCallLogId: other, clearedBy: 't', reason: 'verified_same_number', conn: database })).toEqual([callId]);
  });

  test('a no-text card binds only the line it was filed for: an ownership-only hold X on the same call stays unbound and cannot be cleared with it', async () => {
    const callId = randomUUID();
    await insertHold(callId, X, '2030-02-01T09:00:00Z'); // earlier pass: "not my number" on X, no text card
    const cardId = await insertCard(callId, T('2030-02-01T10:00:00Z'), { ani: Y });
    const yHeld = await Holds.recordDisclaimedNumberHold({ phone: Y, callLogId: callId, conn: database }); // the new no-text arming
    await Holds.stampOpenNoTextCards(database, callId, { phone: Y, heldAt: yHeld.heldAt });
    expect((await bindings(cardId)).map((b) => b.line_e164)).toEqual([Y]);
    // a refresh for the same arming appends nothing
    await Holds.stampOpenNoTextCards(database, callId, { phone: Y, heldAt: yHeld.heldAt });
    expect(await bindings(cardId)).toHaveLength(1);
    await database('triage_items').where({ id: cardId }).update({ status: 'resolved' });
    expect((await listed()).map((l) => l.phone_e164)).toEqual([Y]);
    expect(await Holds.clearNoTextHoldsForPhone({ phoneE164: X, exceptCallLogId: randomUUID(), clearedBy: 't', reason: 'verified_same_number', conn: database })).toEqual([]);
    const boundPairs = await Holds.boundCardsForActiveHolds(database, callId);
    expect(boundPairs.map((p) => p.phone_e164)).toEqual([Y]);
    expect((await database('disclaimed_number_holds').where({ phone_e164: X }).first()).cleared_at).toBeNull();
  });

  test('a cross-call release binds and closes the sibling call\'s legacy card; a later ownership-only re-arm there is not listed and cannot be cleared by it', async () => {
    const a = randomUUID();
    const b = randomUUID();
    const aCard = await armNoText(a, X, { close: null });
    // call B: a legacy (unstamped) OPEN card and its hold, armed within the window
    const bCard = await insertCard(b, T('2030-02-01T10:00:00Z'), { status: 'open' });
    await insertHold(b, X, T('2030-02-01T10:00:04Z'));
    expect((await listed()).map((l) => l.calls_on_line)).toEqual([2]);
    const cleared = await Holds.clearNoTextHoldsForPhone({ phoneE164: X, exceptCallLogId: a, clearedBy: 'tech-1', reason: 'verified_same_number', conn: database });
    expect(cleared).toEqual([b]);
    const row = await database('triage_items').where({ id: bCard }).first();
    expect(row).toMatchObject({ status: 'resolved', resolution_source: 'human', assigned_to: 'tech-1' });
    expect(row.resolution_note).toBe(`line released from ***1234 via call ${a}`);
    expect(row.resolved_at).not.toBeNull();
    expect(row.payload.hold_bindings).toEqual([{ line_e164: X, held_at: expect.any(String) }]); // provenance now immutable
    expect(await database('call_log').where({ id: b }).first('review_status')).toEqual({ review_status: 'resolved' });
    // the releasing call's own card is untouched here (the route closes it)
    expect((await database('triage_items').where({ id: aCard }).first()).status).toBe('open');
    // call B re-arms the line for an ownership-only reason within 5 minutes of the old card
    await database('disclaimed_number_holds').where({ source_call_log_id: b }).update({ cleared_at: null, held_at: T('2030-02-01T10:02:00Z') });
    await database('triage_items').where({ id: aCard }).update({ status: 'resolved' });
    expect((await listed()).map((l) => l.source_call_log_id)).toEqual([a]); // B's re-arm is not a no-text hold
    expect(await Holds.clearNoTextHoldsForPhone({ phoneE164: X, exceptCallLogId: randomUUID(), clearedBy: 't', reason: 'verified_same_number', conn: database })).toEqual([a]);
    expect((await database('disclaimed_number_holds').where({ source_call_log_id: b }).first()).cleared_at).toBeNull();
  });

  test('a sibling card that is still bound to another ACTIVE line of its call stays open, but is bound', async () => {
    const a = randomUUID();
    const b = randomUUID();
    await armNoText(a, X, { close: null });
    const cardB = await armNoText(b, X, { close: null, heldAt: '2030-02-01T10:00:00.5Z' });
    await insertHold(b, Y, '2030-02-01T10:30:00.5Z');
    await Holds.stampOpenNoTextCards(database, b, { phone: Y });
    expect((await bindings(cardB)).map((x) => x.line_e164).sort()).toEqual([X, Y]);
    await Holds.clearNoTextHoldsForPhone({ phoneE164: X, exceptCallLogId: a, clearedBy: 't', reason: 'verified_same_number', conn: database });
    expect((await database('triage_items').where({ id: cardB }).first()).status).toBe('open'); // Y is still held under it
  });

  test('the backfill prints card ids, call ids and counts only: no phone number, no 10-digit run', async () => {
    const { backfill, reportLines } = require('../../scripts/backfill-no-text-card-bindings');
    const one = randomUUID();
    const two = randomUUID();
    await insertCard(one, T('2030-02-01T10:00:00Z'), { status: 'resolved', ani: '+19415551234' });
    await insertHold(one, X, T('2030-02-01T10:00:04Z'));
    await insertCard(two, T('2030-02-01T10:00:00Z'), { status: 'resolved', ani: '+19415557777' });
    await insertCard(two, T('2030-02-01T10:01:00Z'), { status: 'resolved', ani: '+19415557777' });
    await insertHold(two, Y, T('2030-02-01T10:00:30Z'));
    for (const apply of [false, true]) {
      const text = reportLines(await backfill(database, { apply }), apply).join('\n');
      const withoutIds = text.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<id>');
      expect(withoutIds).not.toMatch(/\d{10,}/);
      expect(withoutIds).not.toContain('+1');
      expect(withoutIds).toContain('unbound: ambiguous');
    }
  });

  describe('legacy cards (no bindings): a 5-minute window on the canonical line, never a wildcard', () => {
    test('a legacy card binds to a hold armed within 5 minutes of it, not to one armed later', async () => {
      const near = randomUUID();
      const far = randomUUID();
      await insertCard(near, T('2030-02-01T10:00:00Z'), { status: 'resolved' });
      await insertHold(near, X, T('2030-02-01T10:00:04Z'));
      await insertCard(far, T('2030-02-01T10:00:00Z'), { status: 'resolved' });
      await insertHold(far, X, T('2030-02-01T10:06:00Z')); // a later re-arm for another reason
      expect((await listed()).map((l) => l.source_call_log_id)).toEqual([near]);
      expect(await Holds.clearNoTextHoldsForPhone({ phoneE164: X, exceptCallLogId: randomUUID(), clearedBy: 't', reason: 'verified_same_number', conn: database })).toEqual([near]);
    });

    test('international lines that share the last ten digits do not bind (+44 vs +55, and +44 vs NANP)', async () => {
      const UK = '+442025550123';
      const bound = async (ani) => {
        const callId = randomUUID(); // one call each: two unstamped cards on one call would compete
        await insertHold(callId, UK, T('2030-02-01T10:00:02Z'));
        const id = await insertCard(callId, T('2030-02-01T10:00:00Z'), { status: 'resolved', ani });
        const ids = (await listed()).map((l) => l.card_id);
        await database.raw('TRUNCATE disclaimed_number_holds, triage_items');
        return ids.includes(id);
      };
      expect(await bound('+552025550123')).toBe(false);
      expect(await bound('(202) 555-0123')).toBe(false); // NANP: +12025550123
      expect(await bound('+44 202 555 0123')).toBe(true);
    });

    test('two unstamped cards that fit one arming are ambiguous: neither binds, nothing is listed or cleared, the backfill reports and skips them', async () => {
      const { backfill } = require('../../scripts/backfill-no-text-card-bindings');
      const callId = randomUUID();
      await insertHold(callId, X, T('2030-02-01T10:00:04Z'));
      const a = await insertCard(callId, T('2030-02-01T10:00:00Z'), { status: 'resolved' });
      const b = await insertCard(callId, T('2030-02-01T10:02:00Z'), { status: 'resolved' });
      expect(await listed()).toEqual([]);
      expect(await Holds.clearNoTextHoldsForPhone({ phoneE164: X, exceptCallLogId: randomUUID(), clearedBy: 't', reason: 'verified_same_number', conn: database })).toEqual([]);
      const dry = await backfill(database, { apply: false });
      expect(dry.rows).toEqual([]);
      expect(dry.ambiguous.map((r) => r.card_id).sort()).toEqual([a, b].sort());
      const applied = await backfill(database, { apply: true });
      expect(applied.rows).toEqual([]);
      expect(await bindings(a)).toBeUndefined();
      expect(await bindings(b)).toBeUndefined();
      expect(await listed()).toEqual([]);
    });

    test('one call with a legacy X card and a legacy Y card inside the window: each binds its OWN line (cards for other lines do not compete)', async () => {
      const callId = randomUUID();
      await insertHold(callId, X, T('2030-02-01T10:00:04Z'));
      await insertHold(callId, Y, T('2030-02-01T10:00:20Z'));
      const cx = await insertCard(callId, T('2030-02-01T10:00:00Z'), { status: 'resolved', ani: X });
      const cy = await insertCard(callId, T('2030-02-01T10:00:10Z'), { status: 'resolved', ani: Y });
      const pairs = (await Holds.boundCardsForActiveHolds(database, callId)).map((p) => [p.phone_e164, p.card_id]);
      expect(pairs.sort()).toEqual([[X, cx], [Y, cy]].sort());
      // two cards for the SAME line and arming are still ambiguous
      await insertCard(callId, T('2030-02-01T10:01:00Z'), { status: 'resolved', ani: X });
      expect((await Holds.boundCardsForActiveHolds(database, callId)).map((p) => p.phone_e164)).toEqual([Y]);
    });

    test('a card closed BEFORE the hold was armed again cannot own that arming, even inside the window', async () => {
      const callId = randomUUID();
      const card = await insertCard(callId, T('2030-02-01T10:00:00Z'), { status: 'resolved' });
      await database('triage_items').where({ id: card }).update({ resolved_at: T('2030-02-01T10:01:00Z') });
      await insertHold(callId, X, T('2030-02-01T10:03:00Z')); // ownership-only re-arm after the card closed
      expect(await listed()).toEqual([]);
      expect(await Holds.clearNoTextHoldsForPhone({ phoneE164: X, exceptCallLogId: randomUUID(), clearedBy: 't', reason: 'verified_same_number', conn: database })).toEqual([]);
      // the same hold armed before the card closed does bind
      await database('disclaimed_number_holds').update({ held_at: T('2030-02-01T10:00:30Z') });
      expect((await listed()).map((l) => l.card_id)).toEqual([card]);
    });

    test('the SQL phone key equals holdPhoneKey for every fixture (NANP, 1+10, unprefixed 11-15, +44, +55, garbage)', async () => {
      const fixtures = ['9415551234', '19415551234', '+19415551234', '(941) 555-1234', '941-555-1234', '+1 (941) 555-1234',
        '29415551234', '442025550123', '4420255501234', '442025550123456', '4420255501234567', '+442025550123', '+44 202 555 0123',
        '  +44 2025550123  ', '+552025550123', '+55 11 91234 5678', '+4420255501', '+442025550', '+1234567', '+123456789012345',
        '+1234567890123456', '12345', 'garbage', 'abc9415551234', '', '+', ' ', null];
      for (const value of fixtures) {
        const sql = Holds.holdPhoneKeySql('v.x');
        const row = (await database.raw(`SELECT ${sql} AS k FROM (SELECT ?::text AS x) v`, [value])).rows[0];
        expect({ value, key: row.k }).toEqual({ value, key: Holds.holdPhoneKey(value) });
      }
    });

    test('a NANP number in any common format binds to its +1 hold', async () => {
      const callId = randomUUID();
      await insertHold(callId, X, T('2030-02-01T10:00:02Z'));
      const id = await insertCard(callId, T('2030-02-01T10:00:00Z'), { status: 'resolved', ani: '(941) 555-1234' });
      expect((await listed()).map((l) => l.card_id)).toEqual([id]);
    });
  });

  test('the backfill script stamps legacy cards by the same rule, only once, and the stamped card then binds exactly', async () => {
    const { backfill } = require('../../scripts/backfill-no-text-card-bindings');
    const near = randomUUID();
    const far = randomUUID();
    const nearCard = await insertCard(near, T('2030-02-01T10:00:00Z'), { status: 'resolved' });
    await insertHold(near, X, T('2030-02-01T10:00:04Z'));
    const farCard = await insertCard(far, T('2030-02-01T10:00:00Z'), { status: 'resolved' });
    await insertHold(far, X, T('2030-02-01T10:06:00Z'));
    const dry = await backfill(database, { apply: false });
    expect(dry.rows.map((r) => r.card_id)).toEqual([nearCard]);
    expect(dry.unstampedAfter).toBe(1); // the far card stays unbound
    expect(await bindings(nearCard)).toBeUndefined(); // a dry run writes nothing
    const applied = await backfill(database, { apply: true });
    expect(applied.rows).toHaveLength(1);
    expect(await bindings(nearCard)).toEqual([{ line_e164: X, held_at: expect.any(String) }]);
    expect(await bindings(farCard)).toBeUndefined();
    expect((await backfill(database, { apply: true })).rows).toEqual([]); // idempotent
    // stamped now: a re-arm of the near hold (new held_at) no longer matches the old card
    await database('disclaimed_number_holds').where({ source_call_log_id: near }).update({ held_at: T('2030-02-01T10:01:00Z') });
    expect((await listed()).map((l) => l.source_call_log_id)).toEqual([]);
  });

  test('a card for a different line does not bind to the hold', async () => {
    const callId = randomUUID();
    await armNoText(callId, Y);
    await database('disclaimed_number_holds').where({ source_call_log_id: callId }).update({ phone_e164: X }); // the hold moved to X; the card's binding names Y
    expect(await listed()).toEqual([]);
  });

  test('a call with two lines and a card for each: each card binds only its own line', async () => {
    const callId = randomUUID();
    const cx = await armNoText(callId, X);
    const cy = await armNoText(callId, Y, { heldAt: '2030-02-02T10:00:00.5Z', cardAt: '2030-02-02T09:59:59Z' });
    expect((await bindings(cx)).map((b) => b.line_e164)).toEqual([X]);
    expect((await bindings(cy)).map((b) => b.line_e164)).toEqual([Y]);
    const byPhone = Object.fromEntries((await listed()).map((l) => [l.phone_e164, l.card_id]));
    expect(byPhone).toEqual({ [X]: cx, [Y]: cy }); // each line's release surface is the card filed for it
    const pairs = await Holds.boundCardsForActiveHolds(database, callId);
    expect(pairs.map((p) => [p.phone_e164, p.card_id])).toEqual([[X, cx], [Y, cy]]);
  });

  test('one row per line, newest hold first; calls_on_line and line_since come from every call on it; the cap applies to lines', async () => {
    const calls = [randomUUID(), randomUUID(), randomUUID()];
    await armNoText(calls[0], X, { heldAt: '2030-02-01T10:00:00Z', cardAt: '2030-02-01T09:59:00Z' });
    const newest = await armNoText(calls[1], X, { heldAt: '2030-02-03T10:00:00Z', cardAt: '2030-02-03T09:59:00Z' });
    await armNoText(calls[2], Y, { heldAt: '2030-02-02T10:00:00Z', cardAt: '2030-02-02T09:59:00Z' });
    const lines = await listed();
    expect(lines.map((l) => l.phone_e164)).toEqual([X, Y]); // newest representative first
    expect(lines[0]).toMatchObject({ card_id: newest, calls_on_line: 2, source_call_log_id: calls[1] });
    expect(new Date(lines[0].line_since).toISOString()).toBe('2030-02-01T10:00:00.000Z');
    expect(lines[1].calls_on_line).toBe(1);
  });

  test('the list\'s blocked flag covers the whole line: an ownership-only call B blocks it, a resolved card does not', async () => {
    const a = randomUUID();
    const b = randomUUID();
    await armNoText(a);
    await insertHold(b, X, T('2030-02-02T10:00:00Z'));
    const cb = await insertCard(b, T('2030-02-02T10:00:00Z'), { reason: 'callback_number_needed', payload: {} });
    expect((await listed()).map((l) => [l.phone_e164, l.blocked_by_ownership_card])).toEqual([[X, true]]);
    await database('triage_items').where({ id: cb }).update({ status: 'resolved' });
    expect((await listed()).map((l) => l.blocked_by_ownership_card)).toEqual([false]);
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

// Two real connections (#6292 r9). The tables are real tables in a private schema (TEMP tables are per session), so a
// transition on call B can hold B's card row while call A releases the same line from its own connection.
postgres('sibling settle skips a card another transaction holds (no deadlock)', () => {
  const SCHEMA = 'hl_two_conn';
  const X = '+19415551234';
  let admin;
  let connA;
  let connB;
  let Holds;
  let server;
  let baseUrl;
  let previousConnection;

  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL);
    if (!['localhost', '127.0.0.1'].includes(url.hostname)) throw new Error('Use a local disposable database');
    const make = (searchPath) => require('knex')({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 1, max: 2 }, searchPath });
    admin = make(['public']);
    await admin.raw(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.raw(`CREATE SCHEMA ${SCHEMA}`);
    connA = make([SCHEMA]);
    connB = make([SCHEMA]);
    await connA.raw(`CREATE TABLE disclaimed_number_holds (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), phone_e164 text NOT NULL, customer_id uuid, source_call_log_id uuid NOT NULL,
      held_at timestamptz NOT NULL DEFAULT now(), cleared_at timestamptz, cleared_by text, clear_reason text, updated_at timestamptz DEFAULT now(),
      UNIQUE (phone_e164, source_call_log_id))`);
    await connA.raw(`CREATE TABLE triage_items (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), call_log_id uuid, reason_code text, status text, payload jsonb,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), resolved_at timestamptz,
      resolution_note text, resolution_source text, assigned_to text)`);
    await connA.raw('CREATE TABLE call_log (id uuid PRIMARY KEY, created_at timestamptz DEFAULT now(), customer_id uuid, review_status text, updated_at timestamptz)');
    await connA.raw('CREATE TABLE customers (id uuid PRIMARY KEY, first_name text, last_name text, phone text)');
    await connA.raw(`CREATE TABLE scheduled_services (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), source_call_log_id uuid, customer_id uuid, status text,
      callback_number_hold_at timestamptz, call_sms_cleared_at timestamptz, updated_at timestamptz)`);
    const dbModule = require('../models/db');
    previousConnection = dbModule.connection;
    dbModule.connection = connA;
    Holds = require('../services/disclaimed-number-holds');
    const app = express();
    app.use(express.json());
    app.use('/admin/triage', require('../routes/admin-triage'));
    server = app.listen(0);
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (previousConnection !== undefined) require('../models/db').connection = previousConnection;
    if (admin) await admin.raw(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    for (const c of [connA, connB, admin]) if (c) await c.destroy();
  });

  async function seedCall() {
    const callId = randomUUID();
    await connA('call_log').insert({ id: callId });
    const cardId = randomUUID();
    await connA('triage_items').insert({ id: cardId, call_log_id: callId, reason_code: 'text_number_differs', status: 'open',
      created_at: new Date('2030-02-01T09:59:59Z'), updated_at: new Date('2030-02-01T10:00:01Z'), payload: JSON.stringify({ ani_phone: X }) });
    await connA('disclaimed_number_holds').insert({ phone_e164: X, source_call_log_id: callId, held_at: new Date('2030-02-01T10:00:00Z') });
    await Holds.stampOpenNoTextCards(connA, callId, { phone: X });
    return { callId, cardId };
  }

  test('call A releases the line while call B\'s transition holds B\'s card row: A completes, B\'s hold is cleared, B\'s card is left to B, and B\'s own release then resolves it with no lines', async () => {
    const a = await seedCall();
    const b = await seedCall();
    const trxB = await connB.transaction();
    let timer;
    try {
      await trxB.raw('SELECT id FROM triage_items WHERE id = ? FOR UPDATE', [b.cardId]); // B's transition has locked its own card
      const released = await Promise.race([
        connA.transaction(async (trx) => {
          await Holds.lockNoTextLines(trx, [X]);
          return Holds.clearNoTextHoldsForPhone({ phoneE164: X, exceptCallLogId: a.callId, clearedBy: 'tech-1', reason: 'verified_same_number', conn: trx });
        }),
        new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error('release waited on a locked sibling card (deadlock)')), 8000); }),
      ]);
      expect(released).toEqual([b.callId]);
    } finally {
      clearTimeout(timer);
      await trxB.rollback(); // frees B's card row (and ends the test's stand-in for B's transaction)
    }
    expect((await connA('disclaimed_number_holds').where({ source_call_log_id: b.callId }).first()).cleared_at).not.toBeNull();
    const cardB = await connA('triage_items').where({ id: b.cardId }).first();
    expect(cardB.status).toBe('open'); // skipped: left to its owner
    // B's own release finds the hold already cleared and resolves its card normally
    const res = await fetch(`${baseUrl}/admin/triage/${b.cardId}/resolve`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expected_updated_at: new Date(cardB.updated_at).toISOString(), line_can_get_texts: true, line_e164: X }),
    });
    const out = await res.json();
    expect({ status: res.status, error: out.error }).toEqual({ status: 200, error: undefined });
    expect(out.callback_number.lines_released).toEqual([]);
    expect(out.callback_number).toMatchObject({ release: 'ok', already_released: [X] }); // idempotent: the panel's named-line retry, not a 409
    expect((await connA('triage_items').where({ id: b.cardId }).first()).status).toBe('resolved');
  });

  test('a named line this call never held is still a 409 NO_TEXT_LINE_NOT_HELD, and an ownership-only active hold it still has is too', async () => {
    const b = await seedCall();
    const stranger = '+19415550999';
    const put = (line) => fetch(`${baseUrl}/admin/triage/${b.cardId}/resolve`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expected_updated_at: '2030-02-01T10:00:01.000Z', line_can_get_texts: true, line_e164: line }),
    });
    const res = await put(stranger);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('NO_TEXT_LINE_NOT_HELD');
    // an active ownership-only hold of this call on another line (no bound card) is not this card's to release
    await connA('disclaimed_number_holds').insert({ phone_e164: stranger, source_call_log_id: b.callId, held_at: new Date('2030-02-01T12:00:00Z') });
    expect((await put(stranger)).status).toBe(409);
    expect((await connA('triage_items').where({ id: b.cardId }).first()).status).toBe('open');
  });

  test('two connections resolve two cards of one call at once: review_status ends resolved (lock the call_log row, then recompute in a new statement)', async () => {
    const callId = randomUUID();
    await connA('call_log').insert({ id: callId, review_status: 'open' });
    const mk = async (reason) => {
      const id = randomUUID();
      await connA('triage_items').insert({ id, call_log_id: callId, reason_code: reason, status: 'open', payload: JSON.stringify({}) });
      return id;
    };
    const c1 = await mk('text_number_differs');
    const c2 = await mk('callback_number_needed');
    const t1 = await connA.transaction();
    const t2 = await connB.transaction();
    await t1('triage_items').where({ id: c1 }).update({ status: 'resolved' });
    await t2('triage_items').where({ id: c2 }).update({ status: 'resolved' });
    await Holds.recomputeCallReviewStatus(t1, [callId]); // t1 counts c2 as open (t2 has not committed) and holds the call_log lock
    let t2Done = false;
    const second = Holds.recomputeCallReviewStatus(t2, [callId]).then(() => { t2Done = true; });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(t2Done).toBe(false); // t2 waits on the call_log row, not on a stale snapshot
    await t1.commit();
    await second; // runs its UPDATE after the lock, with a fresh snapshot: sees c1 resolved too
    await t2.commit();
    expect((await connA('call_log').where({ id: callId }).first()).review_status).toBe('resolved');
  });

  test('an unlocked sibling card is bound-then-closed as before', async () => {
    const a = await seedCall();
    const b = await seedCall();
    expect(await Holds.clearNoTextHoldsForPhone({ phoneE164: X, exceptCallLogId: a.callId, clearedBy: 'tech-1', reason: 'verified_same_number', conn: connA })).toContain(b.callId);
    expect((await connA('triage_items').where({ id: b.cardId }).first()).status).toBe('resolved');
  });
});
