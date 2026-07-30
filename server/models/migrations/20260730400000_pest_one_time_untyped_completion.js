/**
 * Untype the one_time_pest_treatment completion family (owner directive
 * 2026-07-30): the typed "Service findings" closeout form (target pest /
 * areas inspected / activity gauge / treatment performed / …) takes too
 * long in the field. Every service_report profile pointing at
 * one_time_pest_treatment drops its pointer so these visits render the
 * same basic completion form the recurring pest services use (protocol
 * actions + notes + products + areas + activity rating).
 *
 *   pest_re_service        service_report / one_time_pest_treatment → service_report / null
 *   one_time_pest_control  service_report / one_time_pest_treatment → service_report / null
 *   fire_ant               service_report / one_time_pest_treatment → service_report / null
 *   tick_control           service_report / one_time_pest_treatment → service_report / null
 *   bee_wasp_removal       service_report / one_time_pest_treatment → service_report / null
 *   mud_dauber_removal     service_report / one_time_pest_treatment → service_report / null
 *   pest_initial_cleanout  service_report / one_time_pest_treatment → service_report / null (seeded envs only)
 *
 * general_appointment stays project_required (untouched — separate owner
 * call), and the species-specific typed flows (cockroach, bed_bug,
 * german/palmetto knockdown, wildlife, rodent) keep their own schemas.
 * Already-completed typed reports are stored on service_records and keep
 * rendering; this only changes what NEW completions collect.
 *
 * Self-healing per-key (20260712300000 pattern — env catalogs are
 * admin-mutable, no fixed-count assertions):
 *  - profile row absent → loud skip (the profile-less fallback is already
 *    the untyped basic form; nothing to untype)
 *  - profile inactive → loud skip
 *  - pointer isn't one_time_pest_treatment or mode isn't service_report
 *    (admin drift / manual repoint) → loud skip, never clobber
 *  - pointer already null → no-op
 *
 * ROLLBACK FIDELITY: up() stamps [pest_untype_action=untyped:<prior_type>]
 * into the row's notes; down() restores exactly those rows and strips the
 * marker.
 */

const MARKER_RE = / ?\[pest_untype_action=[^\]]*\]/;

function withMarker(notes, action) {
  const base = String(notes || '').replace(MARKER_RE, '').trim();
  return `${base}${base ? ' ' : ''}[pest_untype_action=${action}]`;
}

const UNTYPE_KEYS = [
  'pest_re_service',
  'one_time_pest_control',
  'fire_ant',
  'tick_control',
  'bee_wasp_removal',
  'mud_dauber_removal',
  // Seeded-catalog twin of one_time_pest_control (dev/CI environments; no
  // profile row in prod, where this loud-skips) — untyped with the family
  // so the migrated catalog stays coherent with the lane registry.
  'pest_initial_cleanout',
];

const EXPECTED_TYPE = 'one_time_pest_treatment';

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('service_completion_profiles'))) return;
  for (const key of UNTYPE_KEYS) {
    const row = await knex('service_completion_profiles')
      .where({ service_key: key })
      .first();
    if (!row) {
      console.log(`[pest-untype] ${key}: no profile row — skip (fallback is already untyped)`);
      continue;
    }
    if (row.active === false) {
      console.log(`[pest-untype] ${key}: profile inactive — skip`);
      continue;
    }
    if (row.completion_mode !== 'service_report') {
      console.log(`[pest-untype] ${key}: mode ${row.completion_mode} (expected service_report) — skip`);
      continue;
    }
    if (row.project_type == null) {
      console.log(`[pest-untype] ${key}: already untyped — no-op`);
      continue;
    }
    if (row.project_type !== EXPECTED_TYPE) {
      console.log(`[pest-untype] ${key}: pointer ${row.project_type} (expected ${EXPECTED_TYPE}) — admin drift, skip`);
      continue;
    }
    await knex('service_completion_profiles')
      .where({ service_key: key })
      .update({
        project_type: null,
        notes: withMarker(row.notes, `untyped:${row.project_type}`),
        updated_at: new Date(),
      });
    console.log(`[pest-untype] ${key}: service_report/${EXPECTED_TYPE} → service_report/null`);
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('service_completion_profiles'))) return;
  const rows = await knex('service_completion_profiles')
    .whereIn('service_key', UNTYPE_KEYS)
    .where('notes', 'like', '%[pest_untype_action=%');
  for (const row of rows) {
    const match = String(row.notes || '').match(/\[pest_untype_action=untyped:([^\]]+)\]/);
    if (!match) continue;
    await knex('service_completion_profiles')
      .where({ service_key: row.service_key })
      .update({
        project_type: match[1],
        notes: String(row.notes || '').replace(MARKER_RE, '').trim() || null,
        updated_at: new Date(),
      });
    console.log(`[pest-untype:down] ${row.service_key}: restored service_report/${match[1]}`);
  }
};
