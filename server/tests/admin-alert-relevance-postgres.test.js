// retireKeysNoLongerRaised's SQL on a real Postgres (the unit suite's fake db
// matches SQL text and never executes it): the live-key list binds as ONE
// array value for none, one or many keys, and every bell under the prefix
// whose key the scan did not raise is re-armed — an unread one marked read, a
// person's read_at left as it was. Runs in CI's DB-gated step (DATABASE_URL);
// fixtures fictitious.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const SKIP = !process.env.DATABASE_URL;
const maybeDescribe = SKIP ? describe.skip : describe;

maybeDescribe('retireKeysNoLongerRaised (live Postgres)', () => {
  let db;
  let relevance;
  const ids = [];
  const PREFIX = `relevance-pg-test-${Date.now()}:`;

  beforeAll(() => {
    db = require('../models/db');
    relevance = require('../services/admin-alert-relevance');
  });
  afterAll(async () => {
    if (ids.length) await db('notifications').whereIn('id', ids).del();
    await db.destroy();
  });
  beforeEach(() => { delete process.env.ADMIN_ALERT_RELEVANCE; });

  const bell = async (suffix, extra = {}) => {
    const [row] = await db('notifications').insert({
      recipient_type: 'admin', category: 'alert', title: 'Fixture bell', body: 'fixture',
      metadata: JSON.stringify({ dedupeKey: `${PREFIX}${suffix}`, ...extra }),
    }).returning(['id']);
    ids.push(row.id);
    return row.id;
  };
  const get = (id) => db('notifications').where({ id }).first('read_at', 'metadata');
  const retire = (liveKeys) => relevance.retireKeysNoLongerRaised({ prefix: PREFIX, liveKeys, reason: 'gone' });

  test('many, one, then no live keys: exactly the bells whose key was not raised go, re-armed; a person\'s read stands', async () => {
    const a = await bell('a');
    const b = await bell('b');
    const c = await bell('c');
    const d = await bell('d');
    const quiet = await bell('q', { feed: 'activity' });
    const alreadyRead = await bell('r');
    const readAt = new Date('2026-09-28T10:00:00Z');
    await db('notifications').where({ id: alreadyRead }).update({ read_at: readAt });

    // d, and the quiet and already-read rows (their keys were not raised either).
    expect(await retire([`${PREFIX}a`, `${PREFIX}b`, `${PREFIX}c`])).toBe(3);
    const gone = await get(d);
    expect(gone.read_at).not.toBeNull();
    expect(gone.metadata).toMatchObject({ dedupeKey: null, retired: { by: 'alert-relevance', reason: 'gone', dedupeKey: `${PREFIX}d` } });
    for (const id of [a, b, c]) expect((await get(id)).read_at).toBeNull();
    const theirs = await get(alreadyRead);
    expect(new Date(theirs.read_at).getTime()).toBe(readAt.getTime());
    expect(theirs.metadata).toMatchObject({ dedupeKey: null, retired: { dedupeKey: `${PREFIX}r` } });
    expect((await get(quiet)).metadata).toMatchObject({ dedupeKey: null });

    expect(await retire([`${PREFIX}a`])).toBe(2);
    expect((await get(a)).read_at).toBeNull();
    for (const id of [b, c]) expect((await get(id)).metadata).toMatchObject({ dedupeKey: null });

    // Rows already re-armed hold no key, so nothing under the prefix is touched twice.
    expect(await retire([])).toBe(1);
    expect((await get(a)).read_at).not.toBeNull();
  });

  test('switch off: nothing is touched', async () => {
    process.env.ADMIN_ALERT_RELEVANCE = 'off';
    const id = await bell('off');
    expect(await retire([])).toBe(0);
    expect((await get(id)).read_at).toBeNull();
  });
});
