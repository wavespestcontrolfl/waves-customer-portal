/**
 * Catalog service renames — every customer-facing service name ends in
 * "Service" (owner directive 2026-08-25), and the drill-and-foam pair gets
 * its plain-English identity:
 *
 *   Drill-and-Foam Termite    → Termite Foam Service
 *   Recurring Foam Treatment  → Recurring Termite Foam Service
 *
 * plus 17 suffix-only renames (see RENAMES).
 *
 * Renames are guarded: a row is only renamed when it still carries the
 * exact shipped name — an admin-edited name is owner data and is left
 * alone (same contract as 20260730160000).
 *
 * Two companion writes keep identity resolution working across the rename:
 *
 * 1. protocol_template_service_types — the one-tap protocol button resolves
 *    by EXACT service_type string. For every alias row matching an old
 *    name, an equivalent row for the new name is added (ON CONFLICT DO
 *    NOTHING), so protocol buttons survive on visits booked under either
 *    form.
 *
 * 2. scheduled_services — open, future visits whose service_type equals an
 *    old name are relabeled to the new name so the schedule renders the
 *    canonical form. Completed/cancelled history keeps the label it was
 *    rendered with. (CURRENT_DATE here is UTC while the schedule behaves in
 *    ET; the boundary case is an already-run visit of the same day getting
 *    the synonym label — harmless by construction.)
 *
 * Runtime bridging for labels that still carry the OLD form (engine lines,
 * older code paths) is handled by the " Service"-append candidate in
 * service-completion-profiles.serviceNameCandidates, shipped in this PR.
 */

const RENAMES = [
  // service_key, shipped name (from), new name (to)
  ['foam_drill', 'Drill-and-Foam Termite', 'Termite Foam Service'],
  ['foam_recurring', 'Recurring Foam Treatment', 'Recurring Termite Foam Service'],
  ['cockroach_control', 'Cockroach Treatment', 'Cockroach Treatment Service'],
  ['german_roach', 'German Roach Cleanout', 'German Roach Cleanout Service'],
  ['german_roach_initial', 'German Roach Initial (3-Visit)', 'German Roach Initial Service (3-Visit)'],
  ['pest_termite_bait_quarterly', 'Quarterly Pest + Termite Bait Station', 'Quarterly Pest + Termite Bait Station Service'],
  ['lawn_tree_shrub_combo', 'Lawn + Tree & Shrub', 'Lawn + Tree & Shrub Service'],
  ['dethatching', 'Lawn Dethatching', 'Lawn Dethatching Service'],
  ['lawn_pest_knockdown', 'Lawn Pest Knockdown', 'Lawn Pest Knockdown Service'],
  ['plugging', 'Lawn Plugging', 'Lawn Plugging Service'],
  ['top_dressing', 'Lawn Top Dressing', 'Lawn Top Dressing Service'],
  ['bora_care', 'Bora-Care Wood Treatment', 'Bora-Care Wood Treatment Service'],
  ['trap_only_retainer_monthly', 'Monthly Trap-Only Retainer', 'Monthly Trap-Only Retainer Service'],
  ['trap_only_retainer_plus', 'Plus Trap-Only Retainer', 'Plus Trap-Only Retainer Service'],
  ['trap_only_retainer_standard', 'Standard Trap-Only Retainer', 'Standard Trap-Only Retainer Service'],
  ['rodent_guarantee', 'Rodent Guarantee', 'Rodent Guarantee Service'],
  ['rodent_wire_mesh', 'Rodent Wire Mesh Exclusion', 'Rodent Wire Mesh Exclusion Service'],
  ['rodent_bird_box', 'Roof-entry cover / bird box', 'Roof-Entry Cover / Bird Box Service'],
  ['bed_bug_treatment', 'Bed Bug Treatment', 'Bed Bug Treatment Service'],
];

async function copyProtocolAliases(knex, fromName, toName) {
  if (!(await knex.schema.hasTable('protocol_template_service_types'))) return;
  await knex.raw(
    `INSERT INTO protocol_template_service_types (protocol_template_id, service_type, notes)
     SELECT protocol_template_id, ?, 'alias added by migration:20260825000010 (catalog rename)'
     FROM protocol_template_service_types
     WHERE lower(service_type) = lower(?)
     ON CONFLICT (protocol_template_id, service_type) DO NOTHING`,
    [toName, fromName]
  );
}

async function relabelOpenVisits(knex, fromName, toName) {
  if (!(await knex.schema.hasTable('scheduled_services'))) return;
  await knex('scheduled_services')
    .whereRaw('lower(service_type) = lower(?)', [fromName])
    .whereNull('completed_at')
    .whereNull('cancelled_at')
    .whereRaw('scheduled_date >= CURRENT_DATE')
    .update({ service_type: toName, updated_at: knex.fn.now() });
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('services'))) return;
  for (const [serviceKey, fromName, toName] of RENAMES) {
    const row = await knex('services').where({ service_key: serviceKey }).first('id', 'name');
    // Only rename a row still carrying the shipped name — admin edits win.
    // The alias/relabel companions still run: visits and protocol aliases
    // under the old label exist regardless of what the catalog row says now.
    if (row && row.name === fromName) {
      await knex('services').where({ id: row.id })
        .update({ name: toName, updated_at: knex.fn.now() });
    }
    await copyProtocolAliases(knex, fromName, toName);
    await relabelOpenVisits(knex, fromName, toName);
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('services'))) return;
  for (const [serviceKey, fromName, toName] of RENAMES) {
    const row = await knex('services').where({ service_key: serviceKey }).first('id', 'name');
    if (row && row.name === toName) {
      await knex('services').where({ id: row.id })
        .update({ name: fromName, updated_at: knex.fn.now() });
    }
    if (await knex.schema.hasTable('protocol_template_service_types')) {
      // Remove only the alias rows this migration could have added: rows for
      // the new name whose template also carries the old-name alias.
      await knex.raw(
        `DELETE FROM protocol_template_service_types t
         WHERE t.service_type = ?
           AND EXISTS (
             SELECT 1 FROM protocol_template_service_types s
             WHERE s.protocol_template_id = t.protocol_template_id
               AND lower(s.service_type) = lower(?)
           )`,
        [toName, fromName]
      );
    }
    if (await knex.schema.hasTable('scheduled_services')) {
      await knex('scheduled_services')
        .whereRaw('lower(service_type) = lower(?)', [toName])
        .whereNull('completed_at')
        .whereNull('cancelled_at')
        .whereRaw('scheduled_date >= CURRENT_DATE')
        .update({ service_type: fromName, updated_at: knex.fn.now() });
    }
  }
};
