// SQL-level proof that a newsletter bounce lands by Gmail mailbox identity on
// a real Postgres. Runs only with a DATABASE_URL; TEMP tables on a single
// connection, nothing durable. Synthetic addresses only.
const knex = require('knex');
const { subscriberRowsForBounce } = require('../utils/email-equivalence');

const url = process.env.DATABASE_URL;
const pg = url ? describe : describe.skip;

pg('subscriberRowsForBounce on Postgres', () => {
  let db;
  beforeAll(async () => {
    db = knex({ client: 'pg', connection: url, pool: { min: 1, max: 1 } });
    await db.raw('CREATE TEMP TABLE newsletter_subscribers (id int PRIMARY KEY, email text, bounce_count int, last_bounced_at timestamp)');
  });
  afterAll(async () => { if (db) await db.destroy(); });

  const seed = async (emails) => {
    await db('newsletter_subscribers').del();
    await db('newsletter_subscribers').insert(emails.map((email, i) => ({ id: i + 1, email, bounce_count: 0 })));
  };
  const bounce = (id, mailed) => subscriberRowsForBounce(db('newsletter_subscribers'), id, mailed)
    .update({ bounce_count: db.raw('COALESCE(bounce_count,0) + 1'), last_bounced_at: new Date() });
  const counts = async () => Object.fromEntries((await db('newsletter_subscribers').orderBy('id')).map((r) => [r.email, r.bounce_count]));

  test('a bounce for a different Gmail spelling still lands on the stored row', async () => {
    await seed(['johndoe@gmail.com', 'other@example.test']);
    expect(await bounce(1, 'john.doe+home@googlemail.com')).toBe(1);
    expect(await counts()).toEqual({ 'johndoe@gmail.com': 1, 'other@example.test': 0 });
    expect((await db('newsletter_subscribers').where({ id: 1 }).first()).last_bounced_at).not.toBeNull();
  });

  test('every row on the bounced Gmail mailbox takes the bounce, other mailboxes do not', async () => {
    await seed(['john.doe@gmail.com', ' JohnDoe+news@GoogleMail.com ', 'johndoe2@gmail.com', 'john.doe@example.test']);
    expect(await bounce(1, 'johndoe@gmail.com')).toBe(2);
    expect(await counts()).toEqual({
      'john.doe@gmail.com': 1, ' JohnDoe+news@GoogleMail.com ': 1, 'johndoe2@gmail.com': 0, 'john.doe@example.test': 0,
    });
  });

  test('a non-Gmail address keeps the exact LOWER/TRIM match (dots are significant)', async () => {
    await seed(['john.doe@example.test', 'johndoe@example.test']);
    expect(await bounce(1, ' John.Doe@Example.test ')).toBe(1);
    expect(await counts()).toEqual({ 'john.doe@example.test': 1, 'johndoe@example.test': 0 });
    expect(await bounce(2, 'john.doe@example.test')).toBe(0);
  });

  test('a non-Gmail bounce stays fenced to the delivery subscriber id', async () => {
    await seed(['same@example.test', 'same@example.test']);
    expect(await bounce(2, 'same@example.test')).toBe(1);
    expect(await counts()).toEqual({ 'same@example.test': 1 });
  });

  test('a delivery with no recorded address keeps the plain id match, even on Gmail rows', async () => {
    await seed(['johndoe@gmail.com', 'john.doe@gmail.com']);
    expect(await bounce(1, null)).toBe(1);
    expect((await db('newsletter_subscribers').orderBy('id')).map((r) => r.bounce_count)).toEqual([1, 0]);
  });

  test('a merged-away typo on another mailbox does not bounce-count the corrected Gmail address', async () => {
    await seed(['johndoe@gmail.com']);
    expect(await bounce(1, 'jonhdoe@gmail.com')).toBe(0);
  });

  test.each(['.johndoe@gmail.com', 'johndoe.@gmail.com', 'john..doe@gmail.com'])(
    'a malformed Gmail spelling (%s) keeps the exact fence and never bounce-counts the valid mailbox',
    async (mailed) => {
      await seed(['johndoe@gmail.com']);
      expect(await bounce(1, mailed)).toBe(0);
      expect(await counts()).toEqual({ 'johndoe@gmail.com': 0 });
    },
  );

  test('malformed STORED Gmail spellings are not bounce-counted when the valid mailbox bounces', async () => {
    await seed(['johndoe@gmail.com', '.johndoe@gmail.com', 'johndoe.@gmail.com', 'john..doe@gmail.com', 'john.doe+x@gmail.com']);
    expect(await bounce(1, 'johndoe@gmail.com')).toBe(2);
    expect(await counts()).toEqual({
      'johndoe@gmail.com': 1, '.johndoe@gmail.com': 0, 'johndoe.@gmail.com': 0, 'john..doe@gmail.com': 0, 'john.doe+x@gmail.com': 1,
    });
  });

  test('a stored value with a second @ is not read as the Gmail mailbox (codex #5413 r3)', async () => {
    await seed(['johndoe@gmail.com', 'johndoe@gmail.com@invalid.test', 'john.doe@gmail.com@x.test']);
    expect(await bounce(1, 'johndoe@gmail.com')).toBe(1);
    expect(await counts()).toEqual({
      'johndoe@gmail.com': 1, 'johndoe@gmail.com@invalid.test': 0, 'john.doe@gmail.com@x.test': 0,
    });
  });

  test('a mailed value with a second @ keeps the exact fence', async () => {
    await seed(['johndoe@gmail.com', 'johndoe@gmail.com@invalid.test']);
    expect(await bounce(2, 'johndoe@gmail.com@invalid.test')).toBe(1);
    expect(await counts()).toEqual({ 'johndoe@gmail.com': 0, 'johndoe@gmail.com@invalid.test': 1 });
  });

  test('a delivery whose subscriber id a merge cleared still bounce-counts the Gmail mailbox (codex #5413 r3)', async () => {
    await seed(['johndoe@gmail.com']);
    expect(await bounce(null, 'john.doe@gmail.com')).toBe(1);
    expect(await counts()).toEqual({ 'johndoe@gmail.com': 1 });
  });

  test('…but a cleared id on a non-Gmail address updates nothing', async () => {
    await seed(['same@example.test']);
    expect(await bounce(null, 'same@example.test')).toBe(0);
    expect(await bounce(null, null)).toBe(0);
  });
});
