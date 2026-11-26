// CI's DB-gated pass runs this against PostgreSQL. Minimal newsletter_sends and
// newsletter_calendar tables live in a unique schema, dropped after the suite. It runs the real
// Tuesday-to-Thursday migration and then the stale-proof cleanup that follows it in one batch.
const SKIP = !process.env.DATABASE_URL;
const knex = require('knex');
const { randomUUID } = require('crypto');

const anchor = require('../models/migrations/20261126130000_newsletter_calendar_thursday_anchor');
const cleanup = require('../models/migrations/20261126150100_newsletter_weekly_stale_proof_cleanup');

jest.setTimeout(30000);

const FUTURE_TUE = '2099-06-02';
const FUTURE_THU = '2099-06-04';
const PAST_TUE = '2020-06-02';
const PAST_THU = '2020-06-04';
const FLAGSHIP = 'local-weekly-fresh-events';
const CLEARED = { proof_token: null, proof_sent_at: null, proof_approved_at: null, proof_approval_email_id: null };

(SKIP ? describe.skip : describe)('weekly stale proof cleanup on PostgreSQL', () => {
  let database;
  const schema = `nl_clean_${randomUUID().replaceAll('-', '')}`;

  beforeAll(async () => {
    database = knex({ client: 'pg', connection: process.env.DATABASE_URL, searchPath: [schema], pool: { min: 0, max: 3 } });
    await database.raw('CREATE SCHEMA ??', [schema]);
    await database.raw(`
      CREATE TABLE newsletter_sends (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        newsletter_type text,
        status text NOT NULL,
        scheduled_for timestamptz,
        proof_token text,
        proof_sent_at timestamptz,
        proof_approved_at timestamptz,
        proof_approval_email_id text,
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

  // A migration batch: the anchor first, then the cleanup, as knex runs them on deploy.
  const deploy = async () => { await anchor.up(database); await cleanup.up(database); };
  const proofed = { proof_token: 'ab12cd34', proof_sent_at: new Date(), proof_approved_at: null };
  const send = (status, fields = {}) => database('newsletter_sends').insert({ status, ...fields }).returning('*').then(([r]) => r);
  const week = (weekOf, status, sendId = null) => database('newsletter_calendar')
    .insert({ week_of: weekOf, status, send_id: sendId, target_send_at: `${weekOf}T10:00:00Z` }).returning('*').then(([r]) => r);
  const sendById = (id) => database('newsletter_sends').where({ id }).first();
  const weekById = (id) => database('newsletter_calendar').where({ id }).first();

  test('P0: a proofed legacy NULL-type draft that the move unlinks keeps no proof credentials and becomes a flagship, so an APPROVED reply cannot dispatch it', async () => {
    const draft = await send('draft', { newsletter_type: null, ...proofed });
    const row = await week(FUTURE_TUE, 'drafted', draft.id);
    await deploy();
    expect(await weekById(row.id)).toMatchObject({ status: 'planned', send_id: null });
    expect(await sendById(draft.id)).toMatchObject({ newsletter_type: FLAGSHIP, status: 'draft', ...CLEARED });
  });

  test('a proofed typed weekly draft the move unlinks is cleared too', async () => {
    const draft = await send('draft', { newsletter_type: FLAGSHIP, ...proofed });
    await week(FUTURE_TUE, 'drafted', draft.id);
    await deploy();
    expect(await sendById(draft.id)).toMatchObject({ newsletter_type: FLAGSHIP, ...CLEARED });
  });

  test('an unlinked weekly draft or queued send from any earlier week loses its credentials; a queued one returns to a draft', async () => {
    const orphanDraft = await send('draft', { newsletter_type: null, ...proofed });
    const orphanQueued = await send('scheduled', { newsletter_type: FLAGSHIP, ...proofed, proof_approved_at: new Date(), proof_approval_email_id: 'm1', scheduled_for: `${FUTURE_THU}T10:00:00Z` });
    await deploy();
    expect(await sendById(orphanDraft.id)).toMatchObject({ newsletter_type: FLAGSHIP, ...CLEARED });
    expect(await sendById(orphanQueued.id)).toMatchObject({ status: 'draft', scheduled_for: null, ...CLEARED });
  });

  test('Pest Insider, other types, linked weekly drafts and sent or sending sends are left alone', async () => {
    const pest = await send('draft', { newsletter_type: 'pest-insider-monthly', ...proofed });
    const promo = await send('draft', { newsletter_type: 'service-promo', ...proofed });
    const sent = await send('sent', { newsletter_type: null, ...proofed });
    const sending = await send('sending', { newsletter_type: FLAGSHIP, ...proofed });
    const linkedPast = await send('draft', { newsletter_type: FLAGSHIP, ...proofed });
    await week(PAST_TUE, 'drafted', linkedPast.id);
    await deploy();
    for (const row of [pest, promo, sent, sending]) {
      const after = await sendById(row.id);
      expect(after.proof_token).toBe('ab12cd34');
      expect(after.newsletter_type).toBe(row.newsletter_type);
      expect(after.status).toBe(row.status);
    }
    // a past week's linked draft keeps its link and its proof
    expect((await sendById(linkedPast.id)).proof_token).toBe('ab12cd34');
  });

  test('P1: a pending week whose row is still drafted while its send is already queued is unqueued and re-drafted', async () => {
    const queued = await send('scheduled', { newsletter_type: FLAGSHIP, ...proofed, proof_approved_at: new Date(), proof_approval_email_id: 'm1', scheduled_for: `${FUTURE_TUE}T10:00:00Z` });
    const row = await week(FUTURE_TUE, 'drafted', queued.id);
    await deploy();
    expect(await sendById(queued.id)).toMatchObject({ status: 'draft', scheduled_for: null, ...CLEARED });
    expect(await weekById(row.id)).toMatchObject({ status: 'planned', send_id: null });
    expect((await weekById(row.id)).week_of.getDate()).toBe(4); // the Thursday
  });

  test('a past week with the same split state is history and keeps its link', async () => {
    const queued = await send('scheduled', { newsletter_type: FLAGSHIP, ...proofed });
    const row = await week(PAST_TUE, 'drafted', queued.id);
    await deploy();
    expect(await weekById(row.id)).toMatchObject({ status: 'drafted', send_id: queued.id });
    expect((await sendById(queued.id)).status).toBe('scheduled');
    expect(PAST_THU).toBe('2020-06-04');
  });

  test('a send already sending whose row is drafted keeps both', async () => {
    const sending = await send('sending', { newsletter_type: FLAGSHIP, ...proofed });
    const row = await week(FUTURE_TUE, 'drafted', sending.id);
    await deploy();
    expect(await weekById(row.id)).toMatchObject({ status: 'drafted', send_id: sending.id });
    expect((await sendById(sending.id)).status).toBe('sending');
  });

  test('down changes nothing', async () => {
    await expect(cleanup.down(database)).resolves.toBeUndefined();
  });
});
