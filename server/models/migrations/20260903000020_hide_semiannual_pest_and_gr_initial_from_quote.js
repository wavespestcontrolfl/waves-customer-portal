/**
 * Owner rulings 2026-09-03: two catalog rows leave the customer-facing quote
 * menu (services.public_quote_selectable → false).
 *
 *  - pest_general_semiannual — semiannual pest control is not sold to new
 *    customers on any quote surface. The public engine never priced it
 *    (public-services-menu.js: pest.frequency is quarterly | bimonthly |
 *    monthly), so it only ever reached the office as a quote-on-request lead.
 *  - german_roach_initial — the 3-visit German roach initial is the
 *    first-visit add-on for a customer STARTING recurring pest service, not a
 *    standalone product; next to "German Roach Cleanout" a new visitor cannot
 *    tell the two apart and picks the wrong one. It stays available to the
 *    estimate tool as the recurring add-on.
 *
 * Same contract as 20260829000020: flip only rows still true, record the ids
 * touched, and never re-flip a recorded row (an admin who re-selected it in
 * the Service Library keeps that choice). down() is a documented no-op — a
 * "still false" row cannot be told apart from an admin deselection.
 */
const STATE_KEY = 'migration.20260903000020.state';

const HIDE_KEYS = ['pest_general_semiannual', 'german_roach_initial'];

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
