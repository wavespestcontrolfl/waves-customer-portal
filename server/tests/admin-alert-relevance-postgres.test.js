// retireKeysNoLongerRaised's SQL on a real Postgres (the unit suite's fake db
// matches SQL text and never executes it): the live-key list binds as ONE
// array value for none, one or many keys, and only the unread, bell-visible
// bells under the prefix whose key the scan did not raise are retired and
// re-armed. Runs in CI's DB-gated step (DATABASE_URL); fixtures fictitious.
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

  test('many, one, then no live keys: exactly the unread, bell-visible bells whose key was not raised go, re-armed', async () => {
    const a = await bell('a');
    const b = await bell('b');
    const c = await bell('c');
    const d = await bell('d');
    const quiet = await bell('q', { feed: 'activity' });
    const alreadyRead = await bell('r');
    const readAt = new Date('2026-09-28T10:00:00Z');
    await db('notifications').where({ id: alreadyRead }).update({ read_at: readAt });

    expect(await retire([`${PREFIX}a`, `${PREFIX}b`, `${PREFIX}c`])).toBe(1);
    const gone = await get(d);
    expect(gone.read_at).not.toBeNull();
    expect(gone.metadata).toMatchObject({ dedupeKey: null, retired: { by: 'alert-relevance', reason: 'gone', dedupeKey: `${PREFIX}d` } });
    for (const id of [a, b, c, quiet]) expect((await get(id)).read_at).toBeNull();

    expect(await retire([`${PREFIX}a`])).toBe(2);
    expect((await get(a)).read_at).toBeNull();
    for (const id of [b, c]) expect((await get(id)).metadata).toMatchObject({ dedupeKey: null });

    expect(await retire([])).toBe(1);
    expect((await get(a)).read_at).not.toBeNull();
    // Never the activity-only row, never a person's read.
    expect((await get(quiet)).read_at).toBeNull();
    expect(new Date((await get(alreadyRead)).read_at).getTime()).toBe(readAt.getTime());
  });

  test('switch off: nothing is touched', async () => {
    process.env.ADMIN_ALERT_RELEVANCE = 'off';
    const id = await bell('off');
    expect(await retire([])).toBe(0);
    expect((await get(id)).read_at).toBeNull();
  });
});
