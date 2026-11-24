'use strict';

// Rodent Guarantee catalog description matches the signed agreement (owner 2026-11-23: sanitation is NOT
// required; eligibility is trapping plus exclusion only, as the signed Rodent Exclusion Guarantee Agreement
// says: up to 4 callbacks in 12 months and re-sealing of the original exclusion points). The row was seeded
// in 20260808080000_estimate_gap_catalog_rows with "rodent-free guarantee ... sanitation completed (or photo
// baseline) ... no activity after the final trap check". "Rodent-free" promised more than the agreement does.
//
// Guarded: the UPDATE runs only while the row still carries the exact seeded text, so an admin edit made in
// /admin/services since the seed is kept. A re-run changes nothing.
//
// down(): documented no-op (owner rule 2026-08-09): the description is an admin-editable value; the old
// wording must not come back by accident. Edit it in /admin/services.

const SERVICE_KEY = 'rodent_guarantee';
const OLD_DESCRIPTION = 'Renewable 12-month rodent-free guarantee. Eligibility requires completed trapping, completed exclusion, sanitation completed (or photo baseline), and no activity after the final trap check. Priced by property tier.';
const NEW_DESCRIPTION = 'Renewable 12-month rodent exclusion guarantee covering up to 4 callbacks and re-sealing of the original exclusion points. Eligibility requires completed trapping and completed exclusion. Priced by property tier.';

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('services'))) return;
  // Exact-match guard: any admin edit of the description is an admin choice and is left alone.
  await knex('services')
    .where({ service_key: SERVICE_KEY, description: OLD_DESCRIPTION })
    .update({ description: NEW_DESCRIPTION, updated_at: knex.fn.now() });
};

exports.down = async function down() {
  // Documented no-op: see the header.
};

exports.SERVICE_KEY = SERVICE_KEY;
exports.OLD_DESCRIPTION = OLD_DESCRIPTION;
exports.NEW_DESCRIPTION = NEW_DESCRIPTION;
