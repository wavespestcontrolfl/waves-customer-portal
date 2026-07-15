/**
 * WDO report payment hold — "pay before you get the report".
 *
 * A gated send-with-invoice delivers the invoice + pay link ONLY and parks
 * the report behind these columns; the release sweep (or a payment-event
 * nudge) delivers the held FDACS report once the linked invoice settles.
 *
 * The projects table itself is the release queue (receipt_delivery_jobs
 * shape without a jobs table): status drives the claim
 * (held → releasing → released), locked_at recovers stale claims,
 * attempts/next_attempt_at back off failed release deliveries, and
 * last_error surfaces the block reason in the admin drawer.
 */

exports.up = async function up(knex) {
  const hasProjects = await knex.schema.hasTable('projects');
  if (!hasProjects) return;

  const addColumn = async (name, builder) => {
    const exists = await knex.schema.hasColumn('projects', name);
    if (exists) return;
    await knex.schema.alterTable('projects', builder);
  };

  // null = never held; 'held' | 'releasing' | 'released'
  await addColumn('report_hold_status', (t) => t.text('report_hold_status'));
  await addColumn('report_hold_at', (t) => t.timestamp('report_hold_at', { useTz: true }));
  await addColumn('report_hold_released_at', (t) => t.timestamp('report_hold_released_at', { useTz: true }));
  // 'payment_sweep' | 'manual_send' — how the hold was cleared
  await addColumn('report_hold_release_source', (t) => t.text('report_hold_release_source'));
  await addColumn('report_hold_attempts', (t) => t.integer('report_hold_attempts').notNullable().defaultTo(0));
  await addColumn('report_hold_next_attempt_at', (t) => t.timestamp('report_hold_next_attempt_at', { useTz: true }));
  await addColumn('report_hold_locked_at', (t) => t.timestamp('report_hold_locked_at', { useTz: true }));
  await addColumn('report_hold_last_error', (t) => t.text('report_hold_last_error'));

  // The sweep polls for held rows every minute; keep the scan a partial-index
  // lookup instead of a projects seq scan.
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS projects_report_hold_held_idx
    ON projects (report_hold_next_attempt_at)
    WHERE report_hold_status IN ('held', 'releasing')
  `);
};

exports.down = async function down(knex) {
  const hasProjects = await knex.schema.hasTable('projects');
  if (!hasProjects) return;

  await knex.raw('DROP INDEX IF EXISTS projects_report_hold_held_idx');

  const dropColumn = async (name) => {
    const exists = await knex.schema.hasColumn('projects', name);
    if (!exists) return;
    await knex.schema.alterTable('projects', (t) => t.dropColumn(name));
  };

  await dropColumn('report_hold_last_error');
  await dropColumn('report_hold_locked_at');
  await dropColumn('report_hold_next_attempt_at');
  await dropColumn('report_hold_attempts');
  await dropColumn('report_hold_release_source');
  await dropColumn('report_hold_released_at');
  await dropColumn('report_hold_at');
  await dropColumn('report_hold_status');
};
