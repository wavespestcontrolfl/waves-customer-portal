// The thank-you note list (Referral Step 2) against real PostgreSQL, one rolled-back transaction per test: the REAL
// service on the migrated referrals and customers tables. It proves what only the database can: which referrals
// owe a note (stamped at a booking under Step 2, booking still standing, not written yet), that the list carries
// the member and never the friend, and that the "written" mark is taken once. The stamp itself (the real
// conversion writes it under the gate) is proven in referral-step2-postgres.test.js. No network, no message.
// CI runs a DB suite only when it carries this exact line (tests.yml greps for it).
const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;
const { randomUUID } = require('crypto');

let mockConnection;
jest.mock('../models/db', () => new Proxy((...args) => mockConnection(...args), {
  get(_target, key) {
    const value = mockConnection?.[key];
    return typeof value === 'function' ? value.bind(mockConnection) : value;
  },
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const notes = require('../services/referral-thank-you-notes');
const migration = require('../models/migrations/20261122180000_referral_thank_you_notes');

const FRIEND = { referee_name: 'Friend Notonlist', referee_phone: '+19415550177', referee_email: 'friend-notonlist@example.invalid' };

postgres('referral thank-you notes (live Postgres)', () => {
  jest.setTimeout(60000);
  let database;
  let trx;
  let phoneSeq = 0;

  beforeAll(async () => {
    const target = new URL(process.env.DATABASE_URL);
    // This worktree's OWN QA database, never another checkout's: the managed runner sets both marks and names
    // the database after the worktree id (scripts/dev/context.js, scripts/qa/server.js). Or CI's database.
    const worktreeId = String(process.env.WAVES_WORKTREE_ID || '').replaceAll('-', '');
    const privateQa = process.env.WAVES_LOCAL_DEV === '1' && /^[a-f0-9]{32}$/.test(worktreeId) && target.pathname === `/waves_qa_${worktreeId}`;
    const ci = process.env.CI === 'true' && ['localhost', '127.0.0.1'].includes(target.hostname) && target.pathname === '/waves_test';
    if (!privateQa && !ci) throw new Error("Use this worktree's private QA database or the isolated CI database");
    // The driver copies every query parameter of a connection string into its settings, so ?host=, ?port= or
    // ?connectionString= would name another server than the one checked above. A URL with a query is refused,
    // and the pool gets the parts this guard read, never the URL text.
    if (target.search) throw new Error('DATABASE_URL must not carry query parameters');
    database = require('knex')({
      client: 'pg',
      connection: {
        host: target.hostname,
        port: target.port ? Number(target.port) : undefined,
        user: decodeURIComponent(target.username) || undefined,
        password: decodeURIComponent(target.password) || undefined,
        database: target.pathname.slice(1),
      },
      pool: { min: 0, max: 2 },
    });
  });

  afterAll(async () => {
    await database?.destroy();
  });

  beforeEach(async () => {
    trx = await database.transaction();
    mockConnection = trx;
  });

  afterEach(async () => {
    await trx.rollback();
  });

  async function member(fields = {}) {
    phoneSeq += 1;
    const [row] = await trx('customers').insert({
      first_name: 'Fixture',
      last_name: `Member${phoneSeq}`,
      phone: `+1941556${String(1000 + phoneSeq)}`,
      address_line1: '12 Sample Way',
      city: 'Parrish',
      state: 'FL',
      zip: '34219',
      ...fields,
    }).returning('*');
    return row;
  }

  // A referral the friend booked under Step 2: converted, and stamped "note owed" by that conversion.
  const BOOKED = new Date('2027-02-03T15:00:00.000Z');
  async function referral(memberRow, fields = {}) {
    const [row] = await trx('referrals').insert({
      referrer_customer_id: memberRow.id,
      ...FRIEND,
      referral_code: `FX${randomUUID().slice(0, 8).toUpperCase()}`,
      status: 'signed_up',
      converted_at: BOOKED,
      referrer_reward_reason: 'staged',
      thank_you_note_due_at: BOOKED,
      ...fields,
    }).returning('*');
    return row;
  }

  // Only this test's rows: the database may hold other rows.
  const listFor = async (...referrals) => {
    const ids = new Set(referrals.map((r) => r.id));
    return (await everyNote()).filter((n) => ids.has(n.referralId));
  };

  // Every page, as the card reads them: the first, then each nextCursor until the server says there is no more.
  async function everyNote() {
    const all = [];
    let after = null;
    do {
      const page = await notes.listThankYouNotes({ after });
      all.push(...page.notes);
      after = page.nextCursor;
    } while (after);
    return all;
  }

  test('a referral converted under Step 2 puts the member on the list, with the mailing lines and the day the note became owed', async () => {
    const m = await member({ last_name: 'Listed', address_line2: 'Unit 4' });
    const r = await referral(m);

    expect(await listFor(r)).toEqual([{
      referralId: r.id,
      owedSince: BOOKED,
      memberCustomerId: m.id,
      memberName: 'Fixture Listed',
      addressLines: ['12 Sample Way', 'Unit 4', 'Parrish, FL 34219'],
      addressComplete: true,
    }]);
  });

  test('the list never carries the friend: no name, phone or email of the friend in any row', async () => {
    const r = await referral(await member());
    const text = JSON.stringify(await listFor(r));

    expect(text).not.toContain('Notonlist');
    expect(text).not.toContain('9415550177');
    expect(text).not.toContain('example.invalid');
  });

  test('a settled Step 2 referral stays owed, and a member at the yearly limit is on the list too', async () => {
    const m = await member();
    const settled = await referral(m, { status: 'credited', referrer_reward_reason: 'standard', referrer_credit_cents: 2500 });
    const atLimit = await referral(m, { status: 'credited', referrer_reward_reason: 'cap_reached', referrer_credit_cents: 0 });

    expect((await listFor(settled, atLimit)).map((n) => n.referralId).sort()).toEqual([settled.id, atLimit.id].sort());
  });

  test('no note is owed for a referral with no stamp (booked before Step 2), one the office rejected, or an archived member', async () => {
    const m = await member();
    // Booked before Step 2. A settlement under Step 2 records its reason and credit; that does not make a note owed.
    const beforeStep2 = await referral(m, { thank_you_note_due_at: null, status: 'credited', referrer_reward_reason: 'standard', referrer_credit_cents: 2500 });
    const notBooked = await referral(m, { thank_you_note_due_at: null, status: 'pending', converted_at: null, referrer_reward_reason: null });
    const rejected = await referral(m, { status: 'rejected', referrer_reward_status: 'superseded' });
    const archived = await referral(await member({ deleted_at: new Date() }));

    expect(await listFor(beforeStep2, notBooked, rejected, archived)).toEqual([]);
    await expect(notes.markThankYouNoteWritten({ referralId: beforeStep2.id })).rejects.toMatchObject({ code: 'NO_NOTE_OWED' });
  });

  test('two members who referred the same friend are each owed a note, also the one whose referral the settlement retired', async () => {
    const paid = await referral(await member({ last_name: 'Paid' }), { status: 'credited', referrer_reward_status: 'earned', referrer_reward_reason: 'standard' });
    // The other member's referral for the same friend: retired at the settlement, status still signed_up, no credit.
    const retired = await referral(await member({ last_name: 'Retired' }), { referrer_reward_status: 'superseded' });

    expect((await listFor(paid, retired)).map((n) => n.memberName).sort()).toEqual(['Fixture Paid', 'Fixture Retired']);
    await expect(notes.markThankYouNoteWritten({ referralId: retired.id })).resolves.toEqual({ written: true });
  });

  test('a member archived after the list was read: the mark is refused and nothing is stamped', async () => {
    const m = await member();
    const r = await referral(m);
    expect(await listFor(r)).toHaveLength(1);

    await trx('customers').where({ id: m.id }).update({ deleted_at: new Date() });

    await expect(notes.markThankYouNoteWritten({ referralId: r.id, writtenBy: randomUUID() }))
      .rejects.toMatchObject({ statusCode: 404, code: 'NO_NOTE_OWED' });
    expect(await trx('referrals').where({ id: r.id }).first('thank_you_note_at', 'thank_you_note_by'))
      .toEqual({ thank_you_note_at: null, thank_you_note_by: null });
    expect(await listFor(r)).toEqual([]);
  });

  test('a referral the office rejected after the list was read: the mark is refused and nothing is stamped', async () => {
    const r = await referral(await member());
    await trx('referrals').where({ id: r.id }).update({ status: 'rejected', referrer_reward_status: 'superseded' });

    await expect(notes.markThankYouNoteWritten({ referralId: r.id })).rejects.toMatchObject({ code: 'NO_NOTE_OWED' });
    expect((await trx('referrals').where({ id: r.id }).first('thank_you_note_at')).thank_you_note_at).toBeNull();
  });

  test('a booked referral that waits for the first plan service (reward status pending_service) owes the note already', async () => {
    const r = await referral(await member(), { referrer_reward_status: 'pending_service' });

    expect((await listFor(r)).map((n) => n.referralId)).toEqual([r.id]);
  });

  test('oldest first', async () => {
    const m = await member();
    const later = await referral(m, { thank_you_note_due_at: new Date('2027-02-09T15:00:00.000Z') });
    const first = await referral(m, { thank_you_note_due_at: new Date('2027-02-01T15:00:00.000Z') });

    expect((await listFor(later, first)).map((n) => n.referralId)).toEqual([first.id, later.id]);
  });

  describe('pages', () => {
    // 203 notes older than any other row the database may hold, one microsecond apart: the positions a JS Date
    // (milliseconds) cannot tell apart. Notes 200 and 201 (the page boundary) share one stamp, so only the id
    // orders them.
    const stampSql = (n) => trx.raw("timestamptz '1990-01-01 00:00:00+00' + (? * interval '1 microsecond')", [n]);
    async function seed() {
      const m = await member({ last_name: 'Paged' });
      const rows = [];
      for (let n = 1; n <= 203; n += 1) rows.push(await referral(m, { thank_you_note_due_at: stampSql(n === 201 ? 200 : n) }));
      const boundary = [rows[199], rows[200]].sort((a, b) => (a.id < b.id ? -1 : 1));
      return { ordered: [...rows.slice(0, 199), ...boundary, ...rows.slice(201)].map((r) => r.id) };
    }
    const ids = (page) => page.notes.map((n) => n.referralId);

    test('a page is 200 notes with the count of all of them; the next position reaches every later note once, with no mark', async () => {
      const before = (await notes.listThankYouNotes()).total;
      const { ordered } = await seed();
      expect(notes.PAGE_SIZE).toBe(200);

      const first = await notes.listThankYouNotes();
      expect(ids(first)).toEqual(ordered.slice(0, 200));
      expect(first.total).toBe(before + 203);
      expect(first.nextCursor).toMatch(/^1990-01-01T00:00:00\.000200Z,[0-9a-f-]{36}$/);

      // The next page starts after the boundary row: the row with the same stamp and the higher id comes first.
      const second = await notes.listThankYouNotes({ after: first.nextCursor });
      expect(ids(second).slice(0, 3)).toEqual(ordered.slice(200));
      expect(second.total).toBe(before + 203);
      if (before === 0) expect(second).toMatchObject({ nextCursor: null, notes: { length: 3 } });

      // Read to the end: every seeded note exactly once, in order.
      const seen = (await everyNote()).map((n) => n.referralId).filter((id) => ordered.includes(id));
      expect(seen).toEqual(ordered);
    });

    test('a mark takes a note off its page and off the count; the position of a written note still works', async () => {
      const before = (await notes.listThankYouNotes()).total;
      const { ordered } = await seed();
      const first = await notes.listThankYouNotes();

      // The office writes the last note of page 1: the row the position names.
      await notes.markThankYouNoteWritten({ referralId: ordered[199] });
      const second = await notes.listThankYouNotes({ after: first.nextCursor });
      expect(ids(second).slice(0, 3)).toEqual(ordered.slice(200));
      expect(second.total).toBe(before + 202);

      // Page 1 read again: the note after it moves up, nothing is lost.
      const again = await notes.listThankYouNotes();
      expect(ids(again)).toEqual([...ordered.slice(0, 199), ordered[200]]);
    });

    test.each([
      'nonsense', '2027-02-03T15:00:00.000Z,00000000-0000-4000-8000-000000000001', '2027-02-03T15:00:00.000000Z',
      '2027-02-30T15:00:00.000000Z,00000000-0000-4000-8000-000000000001',
      '0000-01-01T00:00:00.000000Z,00000000-0000-4000-8000-000000000001',
      '2027-02-03T25:00:00.000000Z,00000000-0000-4000-8000-000000000001',
      "2027-02-03T15:00:00.000000Z,00000000-0000-4000-8000-000000000001'; --",
      '2027-02-03t15:00:00.000000z,00000000-0000-4000-8000-000000000001', '[object Object]',
    ])('a position the server did not write is refused before any query: %s', async (after) => {
      await expect(notes.listThankYouNotes({ after })).rejects.toMatchObject({ statusCode: 400, code: 'BAD_CURSOR' });
      // The transaction is still usable: nothing reached PostgreSQL.
      expect((await notes.listThankYouNotes()).total).toBeGreaterThanOrEqual(0);
    });

    test('a well-formed position past the end answers an empty last page', async () => {
      const page = await notes.listThankYouNotes({ after: '9999-12-31T23:59:59.999999Z,ffffffff-ffff-4fff-8fff-ffffffffffff' });
      expect(page).toMatchObject({ notes: [], nextCursor: null });
    });
  });

  test('no note owed for a row adds nothing to the list or the count', async () => {
    const before = await notes.listThankYouNotes();
    await referral(await member(), { thank_you_note_due_at: null });
    const after = await notes.listThankYouNotes();
    expect(after.total).toBe(before.total);
    expect(after.notes).toHaveLength(before.notes.length);
  });

  test('a missing address part leaves no empty line and no stray comma, and the row says the address is not complete', async () => {
    const noState = await referral(await member({ last_name: 'Nostate', state: null }));
    const blank = await referral(await member({ last_name: 'Blank', address_line1: ' ', city: '', state: null, zip: '' }));
    // A profile made from a lead: no street and no ZIP, the state column at its default.
    const stateOnly = await referral(await member({ last_name: 'Stateonly', address_line1: '', city: '', state: 'FL', zip: '' }));
    const noZip = await referral(await member({ last_name: 'Nozip', zip: ' ' }));

    const [a] = await listFor(noState);
    const [b] = await listFor(blank);
    const [c] = await listFor(stateOnly);
    const [d] = await listFor(noZip);
    expect(a).toMatchObject({ addressLines: ['12 Sample Way', 'Parrish, 34219'], addressComplete: false });
    expect(b).toMatchObject({ addressLines: [], addressComplete: false, memberName: 'Fixture Blank' });
    expect(c).toMatchObject({ addressLines: ['FL'], addressComplete: false });
    expect(d).toMatchObject({ addressLines: ['12 Sample Way', 'Parrish, FL'], addressComplete: false });
  });

  test('Mark written stamps the time and the staff login, and the note leaves the list', async () => {
    const staff = randomUUID();
    const r = await referral(await member());

    await expect(notes.markThankYouNoteWritten({ referralId: r.id, writtenBy: staff })).resolves.toEqual({ written: true });

    const row = await trx('referrals').where({ id: r.id }).first('thank_you_note_at', 'thank_you_note_by');
    expect(row.thank_you_note_at).toBeInstanceOf(Date);
    expect(row.thank_you_note_by).toBe(staff);
    expect(await listFor(r)).toEqual([]);
  });

  test('a second mark answers the same and keeps the first time and the first staff login', async () => {
    const first = randomUUID();
    const r = await referral(await member());
    await notes.markThankYouNoteWritten({ referralId: r.id, writtenBy: first });
    const before = await trx('referrals').where({ id: r.id }).first('thank_you_note_at', 'thank_you_note_by');

    await expect(notes.markThankYouNoteWritten({ referralId: r.id, writtenBy: randomUUID() })).resolves.toEqual({ written: true });

    expect(await trx('referrals').where({ id: r.id }).first('thank_you_note_at', 'thank_you_note_by')).toEqual(before);
  });

  test('a referral that owes no note cannot be marked: 404, and nothing is written', async () => {
    const beforeStep2 = await referral(await member(), { thank_you_note_due_at: null, referrer_reward_reason: null });

    await expect(notes.markThankYouNoteWritten({ referralId: beforeStep2.id, writtenBy: randomUUID() }))
      .rejects.toMatchObject({ statusCode: 404, code: 'NO_NOTE_OWED' });
    await expect(notes.markThankYouNoteWritten({ referralId: randomUUID() }))
      .rejects.toMatchObject({ statusCode: 404, code: 'NO_NOTE_OWED' });

    const row = await trx('referrals').where({ id: beforeStep2.id }).first('thank_you_note_at', 'thank_you_note_by');
    expect(row).toEqual({ thank_you_note_at: null, thank_you_note_by: null });
  });

  test('the migration: down drops the three columns, up adds them again, and a second up changes nothing', async () => {
    const has = (column) => trx.schema.hasColumn('referrals', column);
    expect(migration._COLUMNS).toEqual(['thank_you_note_due_at', 'thank_you_note_at', 'thank_you_note_by']);

    await migration.down(trx);
    expect(await Promise.all(migration._COLUMNS.map(has))).toEqual([false, false, false]);
    await migration.up(trx);
    await migration.up(trx);
    expect(await Promise.all(migration._COLUMNS.map(has))).toEqual([true, true, true]);
  });
});
