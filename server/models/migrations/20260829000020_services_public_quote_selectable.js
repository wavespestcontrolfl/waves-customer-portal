/**
 * services.public_quote_selectable — "can a NEW customer choose this product
 * on the website quote form?" (owner rulings 2026-08-29, quote-to-estimate
 * alignment scope C1).
 *
 * Distinct from customer_visible (visible once it exists on an account) and
 * booking_enabled (schedulable): acquisition products only. Internal
 * follow-ons — re-service, setup fees, cartridge replacement, follow-up
 * visits, guarantees, renewals, memberships, the generic appointment row —
 * are never selectable. Inspections ARE. "Not sure" / Waves Assessment is
 * not offered (every quote ends at a real product). Combo rows and the
 * trap-only retainer wait on their own rulings.
 *
 * Column default false; the seed below flips exactly the ruled keys ONCE and
 * records the ids it touched. A re-run never re-flips a recorded row (an
 * admin who deselected it keeps that choice), and down() is a documented
 * no-op: the additive column is inert to older code, and clearing "still
 * true" rows could not tell the seed's value from an admin re-selection
 * (pre-push codex P1) — the same contract as the engine_keys parent
 * migration. The state row is retained so reruns stay idempotent.
 */
const STATE_KEY = 'migration.20260829000020.state';

const SELECTABLE_KEYS = [
  // inspections
  'rodent_inspection', 'wdo_inspection',
  // lawn
  'lawn_care_monthly', 'lawn_care_recurring', 'lawn_care_6week', 'lawn_care_quarterly',
  'lawn_care_one_time', 'dethatching', 'plugging', 'top_dressing', 'lawn_pest_knockdown',
  // mosquito
  'mosquito_monthly', 'mosquito_seasonal', 'mosquito_one_time',
  // pest
  'pest_general_quarterly', 'pest_general_monthly', 'pest_general_bimonthly', 'pest_general_semiannual',
  // One-time pest: prod carries the admin-created one_time_pest_control row;
  // migration-built databases carry its documented twin pest_initial_cleanout
  // (20260401000105) — the same environment split 20260825000011 handles.
  // Both keys are listed; the seed only flips rows that exist.
  'one_time_pest_control', 'pest_initial_cleanout', 'cockroach_control', 'german_roach', 'german_roach_initial',
  // rodent
  'rodent_exclusion', 'rodent_trapping', 'rodent_exclusion_only', 'rodent_trapping_exclusion',
  'rodent_trapping_sanitation', 'rodent_trapping_exclusion_sanitation', 'rodent_wire_mesh',
  'rodent_general_one_time', 'rodent_bird_box', 'rodent_sanitation_light', 'rodent_sanitation_standard',
  'rodent_sanitation_heavy', 'rodent_bait_quarterly',
  // specialty
  'bed_bug_treatment', 'fire_ant', 'flea_tick', 'bee_wasp_removal', 'tick_control', 'mud_dauber_removal', 'wildlife_trapping',
  // termite
  // termite_active_annual / termite_active_bait_quarterly are servicing of
  // EXISTING active stations (cartridge checks/replacement) — follow-ons, not
  // acquisition products; excluded pending an explicit owner ruling.
  'termite_liquid', 'termite_bait', 'termite_bond_10yr', 'termite_bond_5yr', 'termite_bond_1yr', 'termite_monitoring',
  'bora_care', 'foam_recurring', 'termite_slab_pretreat',
  'foam_drill', 'termite_pretreatment', 'termite_spot_treatment', 'termite_trenching',
  // tree & shrub
  'tree_shrub_program', 'tree_shrub_quarterly', 'tree_shrub_6week', 'palm_injection', 'palm_injection_semiannual',
];

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('services'))) return;
  if (!(await knex.schema.hasColumn('services', 'public_quote_selectable'))) {
    await knex.schema.alterTable('services', (t) => {
      t.boolean('public_quote_selectable').notNullable().defaultTo(false);
    });
  }
  // Rows already seeded by a previous run are never touched again — an
  // admin who deselected one keeps that choice.
  let prior = [];
  const hasState = await knex.schema.hasTable('system_settings');
  if (hasState) {
    const row = await knex('system_settings').where({ key: STATE_KEY }).first();
    try { prior = row ? (JSON.parse(row.value).seededIds || []) : []; } catch { prior = []; }
  }
  // Seed: only ACTIVE, non-archived rows still at the default flip; record ids.
  const rows = await knex('services')
    .whereIn('service_key', SELECTABLE_KEYS)
    .where({ is_active: true, is_archived: false, public_quote_selectable: false })
    .select('id', 'service_key');
  const ids = rows.map((r) => r.id).filter((id) => !prior.includes(id));
  if (ids.length) {
    await knex('services').whereIn('id', ids).where({ public_quote_selectable: false })
      .update({ public_quote_selectable: true, updated_at: knex.fn.now() });
  }
  if (hasState) {
    await knex('system_settings').where({ key: STATE_KEY }).del();
    await knex('system_settings').insert({ key: STATE_KEY, value: JSON.stringify({ seededIds: [...new Set([...prior, ...ids])] }) });
  }
};

// Documented no-op (see header): the column is additive and inert to older
// code, and the seed's value cannot be told apart from an admin
// re-selection. The state row is kept so a later up() stays idempotent.
exports.down = async function down() {};

exports.SELECTABLE_KEYS = SELECTABLE_KEYS;
