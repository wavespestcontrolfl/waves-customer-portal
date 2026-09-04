/**
 * Owner rulings 2026-09-03 ("I don't want all the services"): the customer
 * quote menu carries only products a NEW customer would search for. Office
 * SKUs, cadence variants nobody sells cold, warranty riders and species tiers
 * leave the menu (services.public_quote_selectable → false). Every row stays
 * active, bookable and on the estimate tool — this is a visibility flip, not a
 * catalog change, and the Service Library "Quote Form Selectable" checkbox is
 * the one-click revert per row.
 *
 * Why each group:
 *  - pest_general_semiannual, palm_injection_semiannual — no semiannual cadence
 *    is offered to a new customer; the public engine never priced it.
 *  - german_roach_initial — the 3-visit initial is the recurring-start add-on;
 *    next to German Roach Cleanout a visitor picks the wrong one.
 *  - lawn_care_quarterly — lawn basic 4x was retired for new sales 2026-07-09
 *    (customer-pricing-ai.js) yet stayed selectable online.
 *  - termite bonds / monitoring / recurring foam — warranty riders and
 *    follow-ons attached at the estimate, never bought cold.
 *  - foam_drill / termite_pretreatment / termite_spot_treatment — office-scoped
 *    variants of "termite treatment"; termite_liquid is the public product.
 *  - rodent combos, exclusion-only, wire mesh, bird box, sanitation tiers,
 *    rodent_general_one_time — the office's decomposition of one job;
 *    rodent_exclusion (Exclusion & Trapping) is the public entry point. The
 *    sanitation tiers also share one engine key, so acceptance could stamp no
 *    service_id (public-services-menu.js).
 *  - tick_control — sold as the flea exterior leg; a second tile duplicates
 *    Flea Control.
 *  - mud_dauber_removal — species tier of bee_wasp_removal (owner ruling
 *    2026-08-10 maps the engine's stinging line to the broad row).
 *
 * Same contract as 20260829000020: flip only rows still true, record the ids
 * touched, never re-flip a recorded row (an admin who re-selected it keeps
 * that choice). down() is a documented no-op — a "still false" row cannot be
 * told apart from an admin deselection.
 */
const STATE_KEY = 'migration.20260903000020.state';

const HIDE_KEYS = [
  // cadence variants
  'pest_general_semiannual', 'palm_injection_semiannual', 'lawn_care_quarterly',
  // add-on / species tiers of a product that stays public
  'german_roach_initial', 'tick_control', 'mud_dauber_removal',
  // termite riders, follow-ons and office-scoped variants
  'termite_bond_10yr', 'termite_bond_5yr', 'termite_bond_1yr', 'termite_monitoring', 'foam_recurring',
  'foam_drill', 'termite_pretreatment', 'termite_spot_treatment',
  // rodent job decomposition
  'rodent_exclusion_only', 'rodent_trapping_exclusion', 'rodent_trapping_sanitation',
  'rodent_trapping_exclusion_sanitation', 'rodent_wire_mesh', 'rodent_bird_box', 'rodent_general_one_time',
  'rodent_sanitation_light', 'rodent_sanitation_standard', 'rodent_sanitation_heavy',
];

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('services'))) return;
  if (!(await knex.schema.hasColumn('services', 'public_quote_selectable'))) return;

  let prior = [];
  const hasState = await knex.schema.hasTable('system_settings');
  if (hasState) {
    const row = await knex('system_settings').where({ key: STATE_KEY }).first();
    try { prior = row ? (JSON.parse(row.value).hiddenIds || []) : []; } catch { prior = []; }
  }
  const rows = await knex('services')
    .whereIn('service_key', HIDE_KEYS)
    .where({ public_quote_selectable: true })
    .select('id', 'service_key');
  const ids = rows.map((r) => r.id).filter((id) => !prior.includes(id));
  if (ids.length) {
    await knex('services').whereIn('id', ids).where({ public_quote_selectable: true })
      .update({ public_quote_selectable: false, updated_at: knex.fn.now() });
  }
  if (hasState) {
    await knex('system_settings').where({ key: STATE_KEY }).del();
    await knex('system_settings').insert({ key: STATE_KEY, value: JSON.stringify({ hiddenIds: [...new Set([...prior, ...ids])] }) });
  }
};

// Documented no-op (see header). The state row is kept so a later up() stays
// idempotent.
exports.down = async function down() {};

exports.HIDE_KEYS = HIDE_KEYS;
