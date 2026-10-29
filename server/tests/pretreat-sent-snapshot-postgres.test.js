// The pre-treat certificate's as-sent copy (owner 10-23 option A on #6515):
// the backfill for certificates sent before the column, and the copy a send
// writes. Real PostgreSQL, rolled back. Names are synthetic.
const postgres = process.env.DATABASE_URL ? describe : describe.skip;
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
// The route module is loaded for its pure helper only; the migration runs on
// this suite's own knex. A mocked models/db opens no pool (CI exits cleanly).
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

const { randomUUID } = require('node:crypto');
const migration = require('../models/migrations/20261024010000_projects_pretreat_sent_snapshot');
const legacyBackfill = require('../models/migrations/20261024020000_projects_pretreat_sent_snapshot_legacy');

describe('pretreatSentSnapshot (pure)', () => {
  const { pretreatSentSnapshot } = require('../routes/admin-projects')._private;
  const cols = { pretreat_sent_snapshot: {} };

  test('a pre-treat send stores the findings and treatment date it carried', () => {
    const out = pretreatSentSnapshot({
      project_type: 'pre_treatment_termite_certificate',
      findings: JSON.stringify({ gallons_applied: '180' }),
      project_date: '2026-10-01',
    }, cols);
    const copy = JSON.parse(out.pretreat_sent_snapshot);
    expect(copy).toMatchObject({ findings: { gallons_applied: '180' }, project_date: '2026-10-01' });
    expect(copy.sent_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test('other project types, and a deploy without the column, store nothing', () => {
    expect(pretreatSentSnapshot({ project_type: 'wdo_inspection', findings: {} }, cols)).toEqual({});
    expect(pretreatSentSnapshot({ project_type: 'pre_treatment_termite_certificate', findings: {} }, {})).toEqual({});
  });

  test('every send that reached the owner writes the copy (send, send with invoice)', () => {
    const route = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'routes', 'admin-projects.js'), 'utf8');
    // Call sites only (the definition reads "function pretreatSentSnapshot(").
    // Call sites only, each on the row the send delivered: the post-claim
    // re-read (updatedProject / refreshed), never the pre-claim read.
    const calls = route.match(/(?<!function )pretreatSentSnapshot\((\w+), projectCols\)/g);
    expect(calls).toEqual([
      'pretreatSentSnapshot(project, projectCols)', // savePretreatSentCopy (send with invoice)
      'pretreatSentSnapshot(updatedProject, projectCols)', // /send
    ]);
    // Send with invoice saves it on the report leg, from its post-claim row.
    expect(route).toContain('await savePretreatSentCopy(refreshed, projectCols, { reportReached: delivered_report, claimToken: deliveryClaimToken });');
  });
});

jest.setTimeout(30000);
postgres('pretreat sent snapshot backfill (PostgreSQL)', () => {
  let database;
  let trx;
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL);
    const privateQa = process.env.WAVES_DATABASE_ENVIRONMENT === 'test' && /^\/waves_qa_[a-f0-9]{32}$/.test(url.pathname);
    if (!['localhost', '127.0.0.1'].includes(url.hostname) && !privateQa) {
      throw new Error('Use an isolated local/CI database or labeled private QA database');
    }
    database = require('knex')({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 2 } });
  });
  beforeEach(async () => { trx = await database.transaction(); });
  afterEach(async () => { await trx.rollback(); });
  afterAll(async () => { await database?.destroy(); });

  const certificate = async ({ sent, findings, status, deliveryStatus }) => {
    const [tech] = await trx('technicians').insert({ name: 'Sample Tech' }).returning(['id']);
    const customerId = randomUUID();
    await trx('customers').insert({ id: customerId, first_name: 'Sample', last_name: 'Owner', phone: '+19415550142' });
    const [row] = await trx('projects').insert({
      customer_id: customerId,
      created_by_tech_id: tech.id,
      project_type: 'pre_treatment_termite_certificate',
      title: 'Pre-treat',
      status: status || (sent ? 'sent' : 'draft'),
      ...(deliveryStatus ? { delivery_status: deliveryStatus } : {}),
      project_date: '2026-10-01',
      sent_at: sent ? new Date('2026-10-02T15:00:00Z') : null,
      findings,
      pretreat_sent_snapshot: null,
    }).returning(['id']);
    return row.id;
  };
  const copyOf = async (id) => (await trx('projects').where({ id }).first('pretreat_sent_snapshot')).pretreat_sent_snapshot;

  test('a sent certificate gets its current findings as the copy (a JSON-string row too); a draft gets none', async () => {
    const sent = await certificate({ sent: true, findings: JSON.stringify({ gallons_applied: '180' }) });
    const stringRow = await certificate({ sent: true, findings: trx.raw('to_jsonb(?::text)', [JSON.stringify({ gallons_applied: '90' })]) });
    const draft = await certificate({ sent: false, findings: JSON.stringify({ gallons_applied: '5' }) });
    await migration.up(trx);
    expect(await copyOf(sent)).toMatchObject({ findings: { gallons_applied: '180' }, project_date: '2026-10-01', sent_at: '2026-10-02T15:00:00.000Z', backfilled: true });
    expect(await copyOf(stringRow)).toMatchObject({ findings: { gallons_applied: '90' }, backfilled: true });
    expect(await copyOf(draft)).toBeNull();
  });

  test('a copy a send already wrote is kept', async () => {
    const sent = await certificate({ sent: true, findings: JSON.stringify({ gallons_applied: '180' }) });
    await trx('projects').where({ id: sent }).update({ pretreat_sent_snapshot: JSON.stringify({ findings: { gallons_applied: '200' }, project_date: '2026-10-01' }) });
    await migration.up(trx);
    expect((await copyOf(sent)).findings.gallons_applied).toBe('200');
  });

  test('a legacy delivery with no sent_at gets its copy from the second backfill', async () => {
    const legacy = await certificate({ sent: false, status: 'closed', deliveryStatus: 'legacy_sent', findings: JSON.stringify({ gallons_applied: '75' }) });
    const draft = await certificate({ sent: false, findings: JSON.stringify({ gallons_applied: '5' }) });
    await migration.up(trx);
    expect(await copyOf(legacy)).toBeNull();
    await legacyBackfill.up(trx);
    expect(await copyOf(legacy)).toMatchObject({ findings: { gallons_applied: '75' }, sent_at: null, backfilled: true });
    expect(await copyOf(draft)).toBeNull();
  });
});
