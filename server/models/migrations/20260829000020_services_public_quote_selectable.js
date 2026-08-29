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
 * Column default false; the seed below flips exactly the ruled keys and
 * records which rows it flipped so down() clears ONLY those (an admin who
 * later selects/deselects a row is never overridden).
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
  'one_time_pest_control', 'cockroach_control', 'german_roach', 'german_roach_initial',
  // rodent
  'rodent_exclusion', 'rodent_trapping', 'rodent_exclusion_only', 'rodent_trapping_exclusion',
  'rodent_trapping_sanitation', 'rodent_trapping_exclusion_sanitation', 'rodent_wire_mesh',
  'rodent_general_one_time', 'rodent_bird_box', 'rodent_sanitation_light', 'rodent_sanitation_standard',
  'rodent_sanitation_heavy', 'rodent_bait_quarterly',
  // specialty
  'bed_bug_treatment', 'fire_ant', 'flea_tick', 'bee_wasp_removal', 'tick_control', 'mud_dauber_removal', 'wildlife_trapping',
  // termite
  'termite_liquid', 'termite_bait', 'termite_bond_10yr', 'termite_bond_5yr', 'termite_bond_1yr', 'termite_monitoring',
  'termite_active_annual', 'termite_active_bait_quarterly', 'bora_care', 'foam_recurring', 'termite_slab_pretreat',
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
  // Seed: only ACTIVE, non-archived rows still at the default flip; record ids.
  const rows = await knex('services')
    .whereIn('service_key', SELECTABLE_KEYS)
    .where({ is_active: true, is_archived: false, public_quote_selectable: false })
    .select('id', 'service_key');
  const ids = rows.map((r) => r.id);
  if (ids.length) {
    await knex('services').whereIn('id', ids).where({ public_quote_selectable: false })
      .update({ public_quote_selectable: true, updated_at: knex.fn.now() });
  }
  if (await knex.schema.hasTable('system_settings')) {
    let prior = [];
    const row = await knex('system_settings').where({ key: STATE_KEY }).first();
    try { prior = row ? (JSON.parse(row.value).seededIds || []) : []; } catch { prior = []; }
    await knex('system_settings').where({ key: STATE_KEY }).del();
    await knex('system_settings').insert({ key: STATE_KEY, value: JSON.stringify({ seededIds: [...new Set([...prior, ...ids])] }) });
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('services'))) return;
  let seededIds = [];
  if (await knex.schema.hasTable('system_settings')) {
    const row = await knex('system_settings').where({ key: STATE_KEY }).first();
    try { seededIds = row ? (JSON.parse(row.value).seededIds || []) : []; } catch { seededIds = []; }
    await knex('system_settings').where({ key: STATE_KEY }).del();
  }
  // Clear ONLY rows this migration flipped and that still read true; the
  // column itself stays (a later re-run re-seeds; dropping would destroy
  // admin selections made in between).
  if (seededIds.length && (await knex.schema.hasColumn('services', 'public_quote_selectable'))) {
    await knex('services').whereIn('id', seededIds).where({ public_quote_selectable: true })
      .update({ public_quote_selectable: false, updated_at: knex.fn.now() });
  }
};

exports.SELECTABLE_KEYS = SELECTABLE_KEYS;
