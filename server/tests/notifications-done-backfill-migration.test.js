/**
 * 20261001003000 — done backfill for pre-migration auto-closes. DB-backed
 * (self-skips without DATABASE_URL): the statements are jsonb/timestamptz
 * comparisons a fake knex would prove nothing about. Runs in a rolled-back
 * transaction.
 *
 * Pins: a relevance retirement whose read is still the sweep's own becomes
 * done at that instant (so putBack's done_at fence matches); one a person
 * read again since stays open; read auto-cleared episodes and resolved
 * digests become done; an unread or already-done row is untouched; down()
 * clears only the backfill's own done.
 */
const path = require('path');

const knexConfig = require(path.join(__dirname, '..', 'knexfile.js'));
const SKIP = !process.env.DATABASE_URL;
const describeOrSkip = SKIP ? describe.skip : describe;

const migration = require('../models/migrations/20261001003000_notifications_done_backfill');
const followup = require('../models/migrations/20261001004000_notifications_done_followup');

describeOrSkip('20261001003000 notifications done backfill (DB-backed)', () => {
  let knex;
  beforeAll(() => {
    knex = require('knex')(knexConfig[process.env.NODE_ENV === 'production' ? 'production' : 'development']);
  });
  afterAll(async () => { await knex.destroy(); });

  test('up() marks the modules\' own pre-migration closes done; down() undoes only those', async () => {
    await expect(knex.transaction(async (trx) => {
      const stampAt = '2026-09-20T10:00:00.123Z';
      const later = '2026-09-21T09:00:00.000Z';
      const insert = async (fields) => {
        const [row] = await trx('notifications').insert({ recipient_type: 'admin', category: 'alert', title: 'Backfill fixture', ...fields,
          metadata: JSON.stringify(fields.metadata || {}) }).returning('id');
        return row.id || row;
      };
      const retired = await insert({ read_at: stampAt, metadata: { retired: { by: 'alert-relevance', reason: 'The visit was completed', at: stampAt } } });
      const personRead = await insert({ read_at: later, metadata: { retired: { by: 'alert-relevance', reason: 'x', at: stampAt } } });
      const cleared = await insert({ read_at: later, metadata: { autoCleared: true } });
      const recurred = await insert({ read_at: null, metadata: { autoCleared: false } });
      const resolved = await insert({ read_at: later, metadata: { resolved: true, resolvedBy: 'ops-crons' } });
      const alreadyDone = await insert({ read_at: later, done_at: later, done_by: '7', resolution: 'By hand', metadata: { resolved: true } });
      const plainRead = await insert({ read_at: later });

      await migration.up(trx);
      const get = (id) => trx('notifications').where({ id }).first();

      expect(await get(retired)).toMatchObject({ done_by: 'relevance', resolution: 'The visit was completed' });
      expect((await get(retired)).done_at.toISOString()).toBe(stampAt);
      expect((await get(personRead)).done_at).toBeNull();
      expect(await get(cleared)).toMatchObject({ done_by: 'episodes' });
      expect((await get(recurred)).done_at).toBeNull();
      expect(await get(resolved)).toMatchObject({ done_by: 'ops-crons' });
      expect(await get(alreadyDone)).toMatchObject({ done_by: '7', resolution: 'By hand' });
      expect((await get(plainRead)).done_at).toBeNull();

      await migration.down(trx);
      for (const id of [retired, cleared, resolved]) expect((await get(id)).done_at).toBeNull();
      expect(await get(alreadyDone)).toMatchObject({ done_by: '7', resolution: 'By hand' });

      throw new Error('rollback');
    })).rejects.toThrow('rollback');
  });

  test('the follow-up re-dates a backfilled auto-close to its recorded close time; down() puts it back', async () => {
    await expect(knex.transaction(async (trx) => {
      const readAt = '2026-09-10T10:00:00.000Z';
      const clearedAt = '2026-09-25T08:30:00.000Z';
      const insert = async (fields) => {
        const [row] = await trx('notifications').insert({ recipient_type: 'admin', category: 'alert', title: 'Follow-up fixture', ...fields,
          metadata: JSON.stringify(fields.metadata || {}) }).returning('id');
        return row.id || row;
      };
      const episode = await insert({ read_at: readAt, metadata: { autoCleared: true, autoClearedAt: clearedAt } });
      const digest = await insert({ read_at: readAt, metadata: { resolved: true, resolvedBy: 'ops-crons', resolvedAt: clearedAt } });
      const noStamp = await insert({ read_at: readAt, metadata: { autoCleared: true } });
      const junkStamp = await insert({ read_at: readAt, metadata: { autoCleared: true, autoClearedAt: 'not a date' } });

      await migration.up(trx);
      await followup.up(trx);
      const doneAt = async (id) => (await trx('notifications').where({ id }).first()).done_at.toISOString();
      expect(await doneAt(episode)).toBe(clearedAt);
      expect(await doneAt(digest)).toBe(clearedAt);
      expect(await doneAt(noStamp)).toBe(readAt);
      expect(await doneAt(junkStamp)).toBe(readAt);

      await followup.down(trx);
      expect(await doneAt(episode)).toBe(readAt);
      expect(await doneAt(digest)).toBe(readAt);
      throw new Error('rollback');
    })).rejects.toThrow('rollback');
  });

  test('the follow-up ensures each done column on its own (idempotent when all exist)', async () => {
    await expect(knex.transaction(async (trx) => {
      await followup.up(trx);
      for (const column of ['done_at', 'done_by', 'resolution']) {
        expect(await trx.schema.hasColumn('notifications', column)).toBe(true);
      }
      throw new Error('rollback');
    })).rejects.toThrow('rollback');
  });
});
