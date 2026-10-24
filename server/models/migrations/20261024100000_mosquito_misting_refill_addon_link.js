/**
 * Mosquito misting refill add-on link (misting PR 2c, GATE_MOSQUITO_MISTING): makes the refill (mosquito_misting_refill) attachable
 * to a Mosquito Misting Service Plan visit (mosquito_misting_service) by adding the one service_addons row between them. The two
 * catalog rows come from 20261023100000 (frozen: it deliberately created NO link, so no picker offered the dormant refill).
 *
 * What the link does and does not do:
 *  - It is the catalog's "this add-on belongs to that service" row: GET /admin/services/:id lists the refill under the plan, so the
 *    add-on picker suggests it. addon_price stays NULL on purpose: a refill has no fixed price. The solution the customer's accepted
 *    misting estimate was sold with sets it per refill application (services/misting-refill.js), and the picker's catalog price is
 *    only the Standard placeholder.
 *  - It does not make the refill recur. The refill is one-time only everywhere it can be copied: admin-schedule
 *    isOneTimeOnlyAddonKey (a series child, top-up or extension never copies it) and an explicit recurring_pattern 'one_time' on
 *    every refill row the booking and Update Details paths write.
 *  - It changes no service row, price, profile, tax row or discount rule.
 *
 * Idempotent and self-healing, same contract as the catalog migration it follows: a missing parent or add-on service is a skip with
 * a warning (a re-run adds the link once both exist); a link that already exists (an operator's, or an earlier run's) is left
 * untouched and is not recorded, so down() never removes it. up() records the link it inserted in a system_settings state row;
 * down() removes only a recorded link that is still the same parent/add-on pair, then the state row. It removes nothing when the
 * state row is missing. Rolled back before the catalog migration (reverse order), so the catalog down() sees no link of ours.
 */

const PARENT_KEY = 'mosquito_misting_service';
const ADDON_KEY = 'mosquito_misting_refill';
const STATE_KEY = 'migration.20261024100000.state';
const LOG = '[mosquito-misting-refill-link]';

const emptyState = () => ({ links: [] });

async function readState(knex) {
  if (!(await knex.schema.hasTable('system_settings'))) return null;
  const row = await knex('system_settings').where({ key: STATE_KEY }).first();
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.value);
    return { ...emptyState(), ...parsed, links: Array.isArray(parsed && parsed.links) ? parsed.links : [] };
  } catch {
    return null;
  }
}

async function recordState(knex, links) {
  if (!(await knex.schema.hasTable('system_settings'))) return;
  const existing = await knex('system_settings').where({ key: STATE_KEY }).first();
  if (!existing) {
    await knex('system_settings').insert({ key: STATE_KEY, value: JSON.stringify({ links }) });
    return;
  }
  // Union with the prior run so a re-run can never shrink what down() may remove.
  let prior = emptyState();
  try { prior = { ...emptyState(), ...JSON.parse(existing.value) }; } catch { /* keep empty */ }
  const byId = new Map();
  for (const link of [...prior.links, ...links]) if (link && link.id) byId.set(link.id, link);
  await knex('system_settings').where({ key: STATE_KEY }).update({ value: JSON.stringify({ links: [...byId.values()] }) });
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('services')) || !(await knex.schema.hasTable('service_addons'))) {
    console.warn(`${LOG} services or service_addons table absent - skipping`);
    return;
  }
  const parent = await knex('services').where({ service_key: PARENT_KEY }).first();
  const addon = await knex('services').where({ service_key: ADDON_KEY }).first();
  if (!parent || !addon) {
    console.warn(`${LOG} ${!parent ? PARENT_KEY : ADDON_KEY} has no services row - no link added (a re-run adds it once both exist)`);
    return;
  }
  const existing = await knex('service_addons').where({ parent_service_id: parent.id, addon_service_id: addon.id }).first();
  if (existing) {
    console.warn(`${LOG} the ${PARENT_KEY} -> ${ADDON_KEY} link already exists - leaving untouched`);
    return;
  }
  const returned = await knex('service_addons')
    .insert({ parent_service_id: parent.id, addon_service_id: addon.id, is_default: false, addon_price: null, sort_order: 0 })
    .returning('id');
  const first = Array.isArray(returned) ? returned[0] : returned;
  const linkId = first && typeof first === 'object' ? first.id : first;
  if (!linkId) {
    console.warn(`${LOG} link inserted but no id returned - it will survive rollback`);
    return;
  }
  await recordState(knex, [{ id: linkId, parent_service_id: parent.id, addon_service_id: addon.id }]);
  console.log(`${LOG} ${PARENT_KEY} -> ${ADDON_KEY} link inserted (${linkId})`);
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('service_addons'))) return;
  const state = await readState(knex);
  if (!state) {
    console.warn(`${LOG} down: no readable state row - removing nothing`);
    return;
  }
  for (const link of state.links) {
    // Only the recorded row, and only while it is still that parent/add-on pair (an operator may have re-pointed it).
    const removed = await knex('service_addons')
      .where({ id: link.id, parent_service_id: link.parent_service_id, addon_service_id: link.addon_service_id })
      .del();
    if (!removed) console.warn(`${LOG} down: recorded link ${link.id} is gone or changed - leaving untouched`);
  }
  await knex('system_settings').where({ key: STATE_KEY }).del();
};

exports.PARENT_KEY = PARENT_KEY;
exports.ADDON_KEY = ADDON_KEY;
exports.STATE_KEY = STATE_KEY;
