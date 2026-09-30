/**
 * Hot-estimate alert episodes against live Postgres: the bell closes when its
 * estimate settles (accepted, declined, expired, archived, gone) and a new hot
 * streak on the same estimate (unarchived, or reopened) rings it again as
 * generation 1; an open estimate's bell is never touched. Synthetic rows only,
 * all deleted afterwards. The unit rules are in estimate-hot-view-alert.test.js.
 */
const SKIP = !process.env.DATABASE_URL;
const maybeDescribe = SKIP ? describe.skip : describe;

afterAll(async () => { if (!SKIP) await require('../models/db').destroy(); });

maybeDescribe('hot-estimate alert episodes (live Postgres)', () => {
  let db;
  let alert;
  const estimateIds = [];
  const NOW = new Date();
  const H = 3600000;
  const RULE = { rule_key: 'multi_view_high_intent', params: { minSessions: 3, windowHours: 72 } };
  const sessions = [1, 2, 3].map((h) => ({ startedAt: new Date(NOW.getTime() - h * H), endedAt: new Date(NOW.getTime() - h * H + 60000) }));

  beforeAll(() => {
    db = require('../models/db');
    alert = require('../services/estimate-hot-view-alert');
  });
  afterAll(async () => {
    if (estimateIds.length) {
      await db('notifications').whereIn(db.raw("metadata->>'dedupeKey'"), estimateIds.map((id) => `estimate_hot_view:${id}`)).del();
      await db('estimates').whereIn('id', estimateIds).del();
    }
  });

  const newEstimate = async (fields = {}) => {
    const [row] = await db('estimates').insert({ status: 'sent', ...fields }).returning('*');
    estimateIds.push(row.id);
    return row;
  };
  const raise = (estimate) => alert.maybeRaiseHotViewAlert({
    estimate: { id: estimate.id, customer_name: 'Test Customer' }, sessions, rule: RULE, now: NOW,
    gateOn: () => true, categoryAllowed: async () => true,
  });
  const close = () => alert.closeSettledHotViewAlerts({ now: NOW, gateOn: () => true });
  const rowsFor = (estimate) => db('notifications').whereRaw("metadata->>'dedupeKey' = ?", [`estimate_hot_view:${estimate.id}`]).orderBy('created_at', 'asc');

  test('an accepted estimate closes its bell; unarchived/reopened and hot again it rings as generation 1', async () => {
    const est = await newEstimate();
    expect(await raise(est)).toEqual({ raised: true, reason: 'sent' });
    // Standing, unread: a second streak inside the window stays a silent dedupe.
    expect(await raise(est)).toEqual({ raised: false, reason: 'deduped' });
    let [row] = await rowsFor(est);
    expect(row.read_at).toBeNull();

    // An open estimate is never closed.
    await close();
    [row] = await rowsFor(est);
    expect(row.read_at).toBeNull();

    await db('estimates').where({ id: est.id }).update({ status: 'accepted' });
    const out = await close();
    expect(out.ran).toBe(true);
    expect(out.reasons['estimate accepted']).toBeGreaterThanOrEqual(1);
    [row] = await rowsFor(est);
    expect(row.read_at).not.toBeNull();
    expect(row.metadata).toMatchObject({ autoCleared: true, autoClearedReason: 'estimate accepted' });

    // Back to an active estimate, hot again: the SAME row rings again.
    await db('estimates').where({ id: est.id }).update({ status: 'viewed' });
    expect(await raise(est)).toEqual({ raised: true, reason: 'reopened' });
    const rows = await rowsFor(est);
    expect(rows).toHaveLength(1);
    expect(rows[0].read_at).toBeNull();
    expect(rows[0].metadata).toMatchObject({ autoCleared: false, recurrenceGeneration: 1 });
    // Standing again: silent.
    expect(await raise(est)).toEqual({ raised: false, reason: 'deduped' });
  });

  test('declined, expired, archived and deleted estimates close their bells', async () => {
    const declined = await newEstimate();
    const expired = await newEstimate();
    const archived = await newEstimate();
    const deleted = await newEstimate();
    const open = await newEstimate();
    for (const e of [declined, expired, archived, deleted, open]) await raise(e);
    await db('estimates').where({ id: declined.id }).update({ status: 'declined' });
    await db('estimates').where({ id: expired.id }).update({ status: 'expired' });
    await db('estimates').where({ id: archived.id }).update({ archived_at: NOW });
    await db('estimates').where({ id: deleted.id }).del();
    await close();
    const reason = async (e) => (await rowsFor(e))[0].metadata.autoClearedReason;
    expect(await reason(declined)).toBe('estimate declined');
    expect(await reason(expired)).toBe('estimate expired');
    expect(await reason(archived)).toBe('estimate archived');
    expect(await reason(deleted)).toBe('estimate gone');
    expect((await rowsFor(open))[0].read_at).toBeNull();
  });

  test('an old cleared row aged out of the 24h window: the comebacks insert one fresh row each and then stay silent', async () => {
    const est = await newEstimate({ status: 'accepted' });
    await db('notifications').insert({
      recipient_type: 'admin', category: 'estimate_hot_view', title: 'Old', body: 'Old', link: '/admin/estimates',
      read_at: new Date(NOW.getTime() - 40 * H), created_at: new Date(NOW.getTime() - 48 * H),
      metadata: JSON.stringify({ dedupeKey: `estimate_hot_view:${est.id}`, autoCleared: true, autoClearedReason: 'estimate accepted' }),
    });
    await db('estimates').where({ id: est.id }).update({ status: 'viewed' });
    expect(await raise(est)).toEqual({ raised: true, reason: 'sent' });
    let rows = await rowsFor(est);
    expect(rows).toHaveLength(2);
    expect(rows[0].read_at).not.toBeNull();
    expect(rows[1].read_at).toBeNull();
    expect(rows[1].metadata).toMatchObject({ autoCleared: false, recurrenceGeneration: 1 });
    // The newest row decides: further views inside the window do not re-ring it.
    expect(await raise(est)).toEqual({ raised: false, reason: 'deduped' });
    rows = await rowsFor(est);
    expect(rows).toHaveLength(2);
    expect(rows[1].metadata.recurrenceGeneration).toBe(1);

    // A second cycle: settle again, age that row out too, hot again -> a third
    // row at generation 2. With three rows for the key, the standing-row read
    // must follow the NEWEST one (an older cleared row would re-version it and
    // ring on every view).
    await db('estimates').where({ id: est.id }).update({ status: 'declined' });
    await close();
    await db('notifications').where({ id: rows[1].id }).update({ created_at: new Date(NOW.getTime() - 30 * H) });
    await db('estimates').where({ id: est.id }).update({ status: 'viewed' });
    expect(await raise(est)).toEqual({ raised: true, reason: 'sent' });
    rows = await rowsFor(est);
    expect(rows).toHaveLength(3);
    expect(rows[2].metadata).toMatchObject({ autoCleared: false, recurrenceGeneration: 2 });
    expect(await raise(est)).toEqual({ raised: false, reason: 'deduped' });
    rows = await rowsFor(est);
    expect(rows).toHaveLength(3);
    expect(rows[2].metadata.recurrenceGeneration).toBe(2);
    expect(rows[2].read_at).toBeNull();
  });
});
