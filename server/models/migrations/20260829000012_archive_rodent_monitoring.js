/**
 * Archive the `rodent_monitoring` catalog row (owner ruling 2026-08-29).
 *
 * In prod the row is already inactive under an admin-edited name ("Quarterly
 * Rodent Monitoring Service"); `rodent_bait_quarterly` is the live Rodent
 * Bait Station product and the completion lane was repointed off this row
 * long ago (#2673). Archiving takes it out of every catalog surface.
 *
 * Mirrors service-library.deactivateService: refuses (skips, recorded) while
 * OPEN visits still reference the row, writes the same `service_catalog.
 * archive` audit row, and records ownership in system_settings so down()
 * un-archives ONLY a row this migration archived and that still carries the
 * archived flags. A row an admin already archived, or re-activated after
 * this ran, is never touched.
 */
const STATE_KEY = 'migration.20260829000012.state';
const SERVICE_KEY = 'rodent_monitoring';
const TERMINAL_VISIT_STATUSES = ['completed', 'cancelled', 'skipped', 'no_show'];

async function saveState(knex, state) {
  if (!(await knex.schema.hasTable('system_settings'))) return;
  await knex('system_settings').where({ key: STATE_KEY }).del();
  await knex('system_settings').insert({ key: STATE_KEY, value: JSON.stringify(state) });
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('services'))) return;
  const row = await knex('services').where({ service_key: SERVICE_KEY }).first();
  if (!row || row.is_archived) { await saveState(knex, { archived: false, reason: row ? 'already_archived' : 'missing' }); return; }

  let openVisits = 0;
  if (await knex.schema.hasTable('scheduled_services')) {
    const r = await knex('scheduled_services')
      .where({ service_id: row.id })
      .where(function openStatus() { this.whereNull('status').orWhereNotIn('status', TERMINAL_VISIT_STATUSES); })
      .count('* as n').first();
    openVisits = Number(r && r.n) || 0;
  }
  if (openVisits > 0) { await saveState(knex, { archived: false, reason: 'open_visits', openVisits }); return; }

  const count = await knex('services')
    .where({ id: row.id, is_archived: false })
    .update({ is_active: false, is_archived: true, updated_at: knex.fn.now() });
  if (count && (await knex.schema.hasTable('audit_log'))) {
    await knex('audit_log').insert({
      actor_type: 'system', actor_id: null, action: 'service_catalog.archive',
      resource_type: 'service', resource_id: row.id,
      metadata: JSON.stringify({ changed_fields: ['is_active', 'is_archived'], before: { is_active: row.is_active, is_archived: row.is_archived, name: row.name }, after: { is_active: false, is_archived: true, name: row.name }, migration: '20260829000012' }),
    });
  }
  await saveState(knex, { archived: count > 0, priorIsActive: row.is_active, serviceId: row.id });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('services')) || !(await knex.schema.hasTable('system_settings'))) return;
  const stateRow = await knex('system_settings').where({ key: STATE_KEY }).first();
  let state = null;
  try { state = stateRow ? JSON.parse(stateRow.value) : null; } catch { state = null; }
  await knex('system_settings').where({ key: STATE_KEY }).del();
  if (!state || !state.archived) return;
  await knex('services')
    .where({ id: state.serviceId, service_key: SERVICE_KEY, is_archived: true, is_active: false })
    .update({ is_archived: false, is_active: !!state.priorIsActive, updated_at: knex.fn.now() });
};
