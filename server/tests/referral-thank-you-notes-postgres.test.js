// The thank-you note list (Referral Step 2) against real PostgreSQL, one rolled-back transaction per test: the REAL
// service on the migrated referrals and customers tables. It proves what only the database can: which referrals
// owe a note (booked under the Step 2 rules, not written yet), that the list carries the member and never the
// friend, and that the "written" mark is taken once. No network, no message, no customer.
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
const migration = require('../models/migrations/20261122160000_referral_thank_you_note');

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

  // A referral the friend booked under the Step 2 rules: converted, and marked by the conversion ('staged') or by
  // the settlement (the final reason).
  async function referral(memberRow, fields = {}) {
    const [row] = await trx('referrals').insert({
      referrer_customer_id: memberRow.id,
      ...FRIEND,
      referral_code: `FX${randomUUID().slice(0, 8).toUpperCase()}`,
      status: 'signed_up',
      converted_at: new Date('2027-02-03T15:00:00.000Z'),
      referrer_reward_reason: 'staged',
      ...fields,
    }).returning('*');
    return row;
  }

  // Only this test's rows: the database may hold other rows.
  const listFor = async (...referrals) => {
    const ids = new Set(referrals.map((r) => r.id));
    return (await notes.listThankYouNotes()).filter((n) => ids.has(n.referralId));
  };

  test('a friend who booked under Step 2 puts the member on the list, with the mailing lines and the booking day', async () => {
    const m = await member({ last_name: 'Listed', address_line2: 'Unit 4' });
    const r = await referral(m);

    expect(await listFor(r)).toEqual([{
      referralId: r.id,
      bookedAt: new Date('2027-02-03T15:00:00.000Z'),
      memberName: 'Fixture Listed',
      addressLines: ['12 Sample Way', 'Unit 4', 'Parrish, FL 34219'],
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

  test('no note is owed for a referral from before Step 2, one that is not booked, one the office rejected, a retired duplicate, or an archived member', async () => {
    const m = await member();
    const beforeStep2 = await referral(m, { referrer_reward_reason: null, status: 'credited' });
    const notBooked = await referral(m, { status: 'pending', converted_at: null });
    const rejected = await referral(m, { status: 'rejected', referrer_reward_status: 'superseded' });
    // Another member's referral for the same friend earned; this one stays signed_up and can never pay.
    const duplicate = await referral(m, { referrer_reward_status: 'superseded' });
    const archived = await referral(await member({ deleted_at: new Date() }));

    expect(await listFor(beforeStep2, notBooked, rejected, duplicate, archived)).toEqual([]);
    await expect(notes.markThankYouNoteWritten({ referralId: duplicate.id })).rejects.toMatchObject({ code: 'NO_NOTE_OWED' });
  });

  test('a booked referral that waits for the first plan service (reward status pending_service) owes the note already', async () => {
    const r = await referral(await member(), { referrer_reward_status: 'pending_service' });

    expect((await listFor(r)).map((n) => n.referralId)).toEqual([r.id]);
  });

  test('oldest booking first', async () => {
    const m = await member();
    const later = await referral(m, { converted_at: new Date('2027-02-09T15:00:00.000Z') });
    const first = await referral(m, { converted_at: new Date('2027-02-01T15:00:00.000Z') });

    expect((await listFor(later, first)).map((n) => n.referralId)).toEqual([first.id, later.id]);
  });

  test('a missing address part leaves no empty line and no stray comma', async () => {
    const noState = await referral(await member({ last_name: 'Nostate', state: null }));
    const blank = await referral(await member({ last_name: 'Blank', address_line1: ' ', city: '', state: null, zip: '' }));

    const [a] = await listFor(noState);
    const [b] = await listFor(blank);
    expect(a.addressLines).toEqual(['12 Sample Way', 'Parrish, 34219']);
    expect(b.addressLines).toEqual([]);
    expect(b.memberName).toBe('Fixture Blank');
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
    const beforeStep2 = await referral(await member(), { referrer_reward_reason: null });

    await expect(notes.markThankYouNoteWritten({ referralId: beforeStep2.id, writtenBy: randomUUID() }))
      .rejects.toMatchObject({ statusCode: 404, code: 'NO_NOTE_OWED' });
    await expect(notes.markThankYouNoteWritten({ referralId: randomUUID() }))
      .rejects.toMatchObject({ statusCode: 404, code: 'NO_NOTE_OWED' });

    const row = await trx('referrals').where({ id: beforeStep2.id }).first('thank_you_note_at', 'thank_you_note_by');
    expect(row).toEqual({ thank_you_note_at: null, thank_you_note_by: null });
  });

  test('the migration: down drops the two columns, up adds them again, and a second up changes nothing', async () => {
    const has = (column) => trx.schema.hasColumn('referrals', column);
    expect(migration._COLUMNS).toEqual(['thank_you_note_at', 'thank_you_note_by']);

    await migration.down(trx);
    expect(await Promise.all(migration._COLUMNS.map(has))).toEqual([false, false]);
    await migration.up(trx);
    await migration.up(trx);
    expect(await Promise.all(migration._COLUMNS.map(has))).toEqual([true, true]);
  });
});
