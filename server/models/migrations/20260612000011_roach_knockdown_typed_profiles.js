/**
 * Cockroach knockdown typed profiles (owner spec 2026-06-12, Phase 2 §8).
 *
 * Points the two PROD-ONLY knockdown keys (admin-created — the catalog
 * never seeded a pest_initial_cleanout in this environment) at their new
 * dedicated typed flows:
 *
 *   pest_initial_german_knockdown   → german_roach_knockdown
 *   pest_initial_palmetto_knockdown → palmetto_roach_knockdown
 *
 * Both were running the untyped legacy completion path ("thin reports" —
 * owner). delivery_mode = auto_send: the typed reports ARE the strong
 * customer notes the owner wants sent — the German one carries mandatory
 * cooperation language (no OTC sprays / clean food debris / keep bait
 * undisturbed) deterministically.
 *
 * Keys are admin-created, so environments without them loud-skip (the
 * self-healed 20260611000012/16 pattern: update / insert / heal / skip).
 * ROLLBACK FIDELITY: up() stamps what it did into the row's notes; down()
 * restores ONLY what up() changed.
 */

const MARKER_RE = / ?\[roach_knockdown_action=[^\]]*\]/;

function withMarker(notes, action) {
  const base = String(notes || '').replace(MARKER_RE, '').trim();
  return `${base}${base ? ' ' : ''}[roach_knockdown_action=${action}]`;
}

const TARGETS = [
  { key: 'pest_initial_german_knockdown', projectType: 'german_roach_knockdown', category: 'pest_control', billingType: 'one_time' },
  { key: 'pest_initial_palmetto_knockdown', projectType: 'palmetto_roach_knockdown', category: 'pest_control', billingType: 'one_time' },
];

exports.up = async function up(knex) {
  const hasProfiles = await knex.schema.hasTable('service_completion_profiles');
  if (!hasProfiles) throw new Error('service_completion_profiles table missing — roach knockdown cutover cannot run');

  for (const target of TARGETS) {
    const service = await knex('services').where({ service_key: target.key }).first('id', 'name');
    if (!service) {
      console.warn(`[roach-knockdown] ${target.key}: services row ABSENT in this environment — skipping profile`);
      continue;
    }
    const row = await knex('service_completion_profiles').where({ service_key: target.key }).first();
    if (row && !row.active) {
      console.warn(`[roach-knockdown] ${target.key}: profile row is INACTIVE — skipping (runtime ignores inactive rows)`);
      continue;
    }
    if (!row) {
      await knex('service_completion_profiles').insert({
        service_key: target.key,
        service_name_snapshot: service.name,
        category: target.category,
        billing_type: target.billingType,
        completion_mode: 'service_report',
        project_type: target.projectType,
        delivery_mode: 'auto_send',
        creates_service_record: true,
        portal_visibility: 'customer_portal',
        portal_attach_policy: 'active_portal_customer',
        followup_policy: 'none',
        active: true,
        notes: withMarker('', 'inserted'),
      });
      console.log(`[roach-knockdown] ${target.key}: profile inserted → service_report/${target.projectType}/auto_send`);
      continue;
    }
    if (row.completion_mode === 'service_report' && row.project_type === target.projectType) {
      console.log(`[roach-knockdown] ${target.key}: already at target — no-op`);
      continue;
    }
    const prior = `${row.completion_mode || '-'}:${row.project_type || '-'}:${row.delivery_mode || '-'}`;
    await knex('service_completion_profiles')
      .where({ service_key: target.key })
      .update({
        completion_mode: 'service_report',
        project_type: target.projectType,
        delivery_mode: 'auto_send',
        notes: withMarker(row.notes, `updated:${prior}`),
        updated_at: knex.fn.now(),
      });
    console.log(`[roach-knockdown] ${target.key}: ${prior} → service_report/${target.projectType}/auto_send (prior recorded)`);
  }
};

exports.down = async function down(knex) {
  const hasProfiles = await knex.schema.hasTable('service_completion_profiles');
  if (!hasProfiles) return;

  const rows = await knex('service_completion_profiles')
    .whereIn('service_key', TARGETS.map((t) => t.key))
    .select('service_key', 'notes');
  for (const row of rows) {
    const match = String(row.notes || '').match(/\[roach_knockdown_action=([^\]]*)\]/);
    if (!match) continue; // up() never touched this row
    const action = match[1];
    if (action === 'inserted') {
      await knex('service_completion_profiles').where({ service_key: row.service_key }).del();
      console.log(`[roach-knockdown:down] ${row.service_key}: inserted profile deleted`);
      continue;
    }
    const prior = action.match(/^updated:([^:]+):([^:]+):([^:]+)$/);
    if (prior) {
      await knex('service_completion_profiles')
        .where({ service_key: row.service_key })
        .update({
          completion_mode: prior[1] === '-' ? null : prior[1],
          project_type: prior[2] === '-' ? null : prior[2],
          delivery_mode: prior[3] === '-' ? null : prior[3],
          notes: String(row.notes || '').replace(MARKER_RE, '').trim() || null,
          updated_at: knex.fn.now(),
        });
      console.log(`[roach-knockdown:down] ${row.service_key}: restored ${prior[1]}/${prior[2]}/${prior[3]}`);
    }
  }
};
