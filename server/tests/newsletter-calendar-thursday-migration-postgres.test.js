// CI's DB-gated pass runs this against PostgreSQL. The tables live in a unique schema (minimal
// newsletter_sends and newsletter_calendar, as the migrations left them) dropped after the suite.
// It runs the real Tuesday-to-Thursday SQL on rows in each state.
const SKIP = !process.env.DATABASE_URL;
const knex = require('knex');
const { randomUUID } = require('crypto');

const migration = require('../models/migrations/20261126130000_newsletter_calendar_thursday_anchor');
const companion = require('../models/migrations/20261126140000_newsletter_calendar_thursday_rollback_reset');
const warmClear = require('../models/migrations/20261126150000_newsletter_weekly_warm_rollback_clear');

// A rollback runs the newest migration's down() first, as knex does.
const rollBack = async (database) => {
  await warmClear.down(database);
  await companion.down(database);
  await migration.down(database);
};

jest.setTimeout(30000);

// A Tuesday (and its Thursday) well ahead of any run date, and one well in the past.
const FUTURE_TUE = '2099-06-02';
const FUTURE_THU = '2099-06-04';
const PAST_TUE = '2020-06-02';
const PAST_THU = '2020-06-04';

(SKIP ? describe.skip : describe)('newsletter calendar Thursday anchor on PostgreSQL', () => {
  let database;
  const schema = `nl_thu_${randomUUID().replaceAll('-', '')}`;

  beforeAll(async () => {
    database = knex({ client: 'pg', connection: process.env.DATABASE_URL, searchPath: [schema], pool: { min: 0, max: 3 } });
    await database.raw('CREATE SCHEMA ??', [schema]);
    await database.raw(`
      CREATE TABLE newsletter_sends (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        status text NOT NULL,
        scheduled_for timestamptz,
        proof_approved_at timestamptz,
        proof_approval_email_id text,
        proof_token text,
        proof_sent_at timestamptz,
        segment_filter jsonb,
        updated_at timestamptz DEFAULT NOW()
      )`);
    await database.raw(`
      CREATE TABLE newsletter_calendar (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        week_of date NOT NULL UNIQUE,
        status text NOT NULL,
        send_id uuid REFERENCES newsletter_sends(id) ON DELETE SET NULL,
        target_send_at timestamptz NOT NULL,
        updated_at timestamptz DEFAULT NOW(),
        CONSTRAINT chk_calendar_week_of_tuesday CHECK (EXTRACT(ISODOW FROM week_of) = 2)
      )`);
  });
  // Each test starts from the pre-migration table: Tuesday CHECK in place.
  beforeEach(async () => {
    await database.raw('ALTER TABLE newsletter_calendar DROP CONSTRAINT IF EXISTS chk_calendar_week_of_thursday');
    await database.raw('ALTER TABLE newsletter_calendar DROP CONSTRAINT IF EXISTS chk_calendar_week_of_tuesday');
    await database.raw('ALTER TABLE newsletter_calendar ADD CONSTRAINT chk_calendar_week_of_tuesday CHECK (EXTRACT(ISODOW FROM week_of) = 2)');
  });
  afterEach(async () => {
    await database('newsletter_calendar').del();
    await database('newsletter_sends').del();
  });
  afterAll(async () => {
    await database.raw('DROP SCHEMA ?? CASCADE', [schema]);
    await database.destroy();
  });

  const send = (status, extra = {}) => database('newsletter_sends').insert({ status, ...extra }).returning('*').then(([r]) => r);
  const week = (weekOf, status, sendId = null) => database('newsletter_calendar')
    .insert({ week_of: weekOf, status, send_id: sendId, target_send_at: `${weekOf}T10:00:00Z` }).returning('*').then(([r]) => r);
  const byId = (id) => database('newsletter_calendar').where({ id }).first();
  const dateOf = (value) => `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;

  test('every Tuesday row becomes the Thursday two days later, and a Tuesday can no longer be stored', async () => {
    const a = await week(FUTURE_TUE, 'planned');
    const b = await week(PAST_TUE, 'sent');
    await migration.up(database);
    expect(dateOf((await byId(a.id)).week_of)).toBe(FUTURE_THU);
    expect(dateOf((await byId(b.id)).week_of)).toBe(PAST_THU);
    await expect(week('2099-06-09', 'planned')).rejects.toThrow(/chk_calendar_week_of_thursday/);
    await expect(week('2099-06-11', 'planned')).resolves.toBeTruthy();
  });

  test('a planned week ahead is re-timed to 6:00 AM New York time on its Thursday (EDT)', async () => {
    const row = await week(FUTURE_TUE, 'planned');
    await migration.up(database);
    expect((await byId(row.id)).target_send_at.toISOString()).toBe(`${FUTURE_THU}T10:00:00.000Z`);
  });

  test('an unsent draft ahead is unlinked and planned again; its draft stays', async () => {
    const draft = await send('draft');
    const row = await week(FUTURE_TUE, 'drafted', draft.id);
    await migration.up(database);
    const moved = await byId(row.id);
    expect(moved.status).toBe('planned');
    expect(moved.send_id).toBeNull();
    expect((await database('newsletter_sends').where({ id: draft.id }).first()).status).toBe('draft');
  });

  test('a queued send ahead goes back to a draft with its approval cleared, and its week is planned again', async () => {
    const queued = await send('scheduled', { scheduled_for: `${FUTURE_TUE}T10:00:00Z`, proof_approved_at: new Date(), proof_approval_email_id: 'm1' });
    const row = await week(FUTURE_TUE, 'scheduled', queued.id);
    await migration.up(database);
    const after = await database('newsletter_sends').where({ id: queued.id }).first();
    expect(after).toMatchObject({ status: 'draft', scheduled_for: null, proof_approved_at: null, proof_approval_email_id: null });
    expect(await byId(row.id)).toMatchObject({ status: 'planned', send_id: null });
  });

  test('a week whose issue already went out (or is sending) keeps its outcome and its link', async () => {
    const sent = await send('sent');
    const sending = await send('sending');
    const a = await week(FUTURE_TUE, 'sent', sent.id);
    const b = await week('2099-06-09', 'scheduled', sending.id);
    await migration.up(database);
    expect(await byId(a.id)).toMatchObject({ status: 'sent', send_id: sent.id });
    expect(await byId(b.id)).toMatchObject({ status: 'scheduled', send_id: sending.id });
    expect((await database('newsletter_sends').where({ id: sending.id }).first()).status).toBe('sending');
  });

  test('a skipped week stays skipped on its Thursday', async () => {
    const row = await week(FUTURE_TUE, 'skipped');
    await migration.up(database);
    expect(await byId(row.id)).toMatchObject({ status: 'skipped' });
  });

  test('past rows keep their recorded target time', async () => {
    const row = await week(PAST_TUE, 'drafted');
    await migration.up(database);
    expect((await byId(row.id)).target_send_at.toISOString()).toBe(`${PAST_TUE}T10:00:00.000Z`);
  });

  test('down puts the rows back on Tuesdays', async () => {
    const row = await week(FUTURE_TUE, 'planned');
    await migration.up(database);
    await migration.down(database);
    expect(dateOf((await byId(row.id)).week_of)).toBe(FUTURE_TUE);
  });

  describe('rollback state', () => {
    // Weeks are Thursdays here: the state the Thursday code leaves behind.
    test('pending weeks go back to Tuesday 6:00 AM ET, and a proofed draft and a queued send become plain drafts a fresh proof can claim', async () => {
      await database.raw('ALTER TABLE newsletter_calendar DROP CONSTRAINT chk_calendar_week_of_tuesday');
      await database.raw('ALTER TABLE newsletter_calendar ADD CONSTRAINT chk_calendar_week_of_thursday CHECK (EXTRACT(ISODOW FROM week_of) = 4)');
      const proofed = await send('draft', {
        proof_token: 'ab12cd34', proof_sent_at: new Date(),
        segment_filter: JSON.stringify({ holdout: 'weekly-warm', subscriber_ids: ['x'], address_keys: ['k'] }),
      });
      const queued = await send('scheduled', {
        scheduled_for: `${FUTURE_THU}T10:00:00Z`, proof_approved_at: new Date(), proof_approval_email_id: 'm1', proof_token: 'cd34ef56', proof_sent_at: new Date(),
      });
      const planned = await week('2099-06-11', 'planned');
      const drafted = await week(FUTURE_THU, 'drafted', proofed.id);
      const scheduled = await week('2099-06-18', 'scheduled', queued.id);
      await rollBack(database);

      expect(dateOf((await byId(planned.id)).week_of)).toBe('2099-06-09');
      expect(dateOf((await byId(drafted.id)).week_of)).toBe(FUTURE_TUE);
      expect((await byId(drafted.id)).target_send_at.toISOString()).toBe(`${FUTURE_TUE}T10:00:00.000Z`); // Tuesday 6:00 AM EDT
      expect((await byId(planned.id)).target_send_at.toISOString()).toBe('2099-06-09T10:00:00.000Z');
      // the queued week is a drafted week again, still linked
      expect(await byId(scheduled.id)).toMatchObject({ status: 'drafted', send_id: queued.id });
      const cleared = { status: 'draft', scheduled_for: null, proof_token: null, proof_sent_at: null, proof_approved_at: null, proof_approval_email_id: null };
      expect(await database('newsletter_sends').where({ id: proofed.id }).first()).toMatchObject(cleared);
      expect(await database('newsletter_sends').where({ id: queued.id }).first()).toMatchObject(cleared);
      // the warm plan the older sender cannot read is cleared (older audience: every active reader)
      expect((await database('newsletter_sends').where({ id: proofed.id }).first()).segment_filter).toBeNull();
      // the Tuesday CHECK is back
      await expect(week('2099-06-12', 'planned')).rejects.toThrow(/chk_calendar_week_of_tuesday/);
    });

    test('a past week and a send already sending keep their state', async () => {
      await database.raw('ALTER TABLE newsletter_calendar DROP CONSTRAINT chk_calendar_week_of_tuesday');
      await database.raw('ALTER TABLE newsletter_calendar ADD CONSTRAINT chk_calendar_week_of_thursday CHECK (EXTRACT(ISODOW FROM week_of) = 4)');
      const sending = await send('sending', { proof_token: 'ab12cd34', proof_sent_at: new Date() });
      const past = await week(PAST_THU, 'drafted');
      const live = await week(FUTURE_THU, 'scheduled', sending.id);
      await rollBack(database);
      expect((await byId(past.id)).target_send_at.toISOString()).toBe(`${PAST_THU}T10:00:00.000Z`);
      expect(await byId(live.id)).toMatchObject({ status: 'scheduled', send_id: sending.id });
      expect(await database('newsletter_sends').where({ id: sending.id }).first()).toMatchObject({ status: 'sending', proof_token: 'ab12cd34' });
    });
  });
});
