/**
 * DB-backed schema checks for the auto-dispatch migration
 * (20260618120000_auto_dispatch): the 5 new scheduled_services columns and the
 * auto_dispatch_runs / auto_dispatch_audit_logs tables.
 *
 * Self-skips without DATABASE_URL (run after `knex migrate:latest`).
 */
const path = require('path');
const SKIP = !process.env.DATABASE_URL;
const describeOrSkip = SKIP ? describe.skip : describe;

describeOrSkip('auto-dispatch schema', () => {
  let knex;

  beforeAll(() => {
    const config = require(path.join(__dirname, '..', 'knexfile.js'));
    knex = require('knex')(config.development || config);
  });

  afterAll(async () => {
    if (knex) await knex.destroy();
  });

  test('scheduled_services gains the auto-dispatch control columns', async () => {
    const cols = await knex('scheduled_services').columnInfo();
    expect(cols).toHaveProperty('auto_dispatch_locked');
    expect(cols).toHaveProperty('auto_dispatch_excluded');
    expect(cols).toHaveProperty('last_auto_dispatch_at');
    expect(cols).toHaveProperty('last_auto_dispatch_run_id');
    expect(cols).toHaveProperty('auto_dispatch_change_count');
    expect(cols.auto_dispatch_locked.nullable).toBe(false);
  });

  test('auto_dispatch_runs table exists with the expected columns', async () => {
    const cols = await knex('auto_dispatch_runs').columnInfo();
    ['id', 'started_at', 'completed_at', 'status', 'mode', 'total_evaluated',
      'total_skipped', 'total_recommended', 'total_changed', 'total_failed',
      'config_snapshot', 'error_message'].forEach((c) => expect(cols).toHaveProperty(c));
  });

  test('auto_dispatch_audit_logs table exists with before/after + snapshot columns', async () => {
    const cols = await knex('auto_dispatch_audit_logs').columnInfo();
    ['id', 'auto_dispatch_run_id', 'scheduled_service_id', 'customer_id', 'recurring_parent_id',
      'action', 'reason_code', 'reason_description', 'old_scheduled_date', 'new_scheduled_date',
      'old_score', 'new_score', 'score_improvement', 'portal_preferences_snapshot',
      'route_metrics_snapshot', 'constraints_checked'].forEach((c) => expect(cols).toHaveProperty(c));
  });

  test('a run row round-trips with a jsonb config snapshot', async () => {
    const [run] = await knex('auto_dispatch_runs')
      .insert({ status: 'completed', mode: 'dry_run', config_snapshot: JSON.stringify({ mode: 'dry_run', lockWindowDays: 14 }) })
      .returning(['id', 'config_snapshot']);
    expect(run.id).toBeTruthy();
    const stored = typeof run.config_snapshot === 'string' ? JSON.parse(run.config_snapshot) : run.config_snapshot;
    expect(stored.lockWindowDays).toBe(14);
    await knex('auto_dispatch_runs').where({ id: run.id }).del();
  });
});
