/**
 * One-time mosquito: a $199 minimum and a ladder whose steps shrink as yards
 * grow (owner 2026-10-25: "one time minimum for mosquito has to be 199, and go
 * up from there"; then "as we scale up in price, the gap in how much they pay
 * should get slightly smaller"; approved the proposed ladder with "build").
 *
 * Moves, in the live data:
 *  - pricing_config.onetime_mosquito: the six bucket prices, OVER_ACRE and
 *    overAcreIncrementPrice (156/177/198/219/251/282/282/+42 per 10k sf →
 *    199/212/230/255/278/309/309/+26), plus a new `floor` key (199), the list
 *    minimum priceOneTimeMosquito applies after the recurring-customer perk.
 *    Station/dunk add-ons and overAcreIncrementSqFt are untouched.
 *  - services.mosquito_one_time base_price / price_range_min / price_range_max
 *    (156/156/282 → 199/199/309): the no-lot scheduling fallback and the
 *    Service Library range, kept on the ladder since 20260728300000.
 *  - a pricing_changelog entry.
 *
 * The ladder moves all-or-nothing: only when every one of its eight price
 * cells still holds the 2026-08-08 value. An admin-edited ladder is left
 * alone, because moving some cells and not others could price a bigger yard
 * below a smaller one. `floor` is added only when the key is absent (an
 * admin's value wins). The catalog row follows the same rule for its three
 * cells. Every write is under the row lock the admin pricing writer also
 * takes, with a pricing_config_audit row.
 *
 * down() keys off this migration's own audit rows and restores a cell only
 * while it still holds the value up() wrote, so a later admin edit wins.
 *
 * Quotes already sent keep their stamped prices; only new quotes see this.
 */
const MIGRATION_TAG = 'migration:20261025235000';
const DOWN_TAG = `${MIGRATION_TAG}:down`;

const OLD_LADDER = {
  SMALL: 156,
  STANDARD: 177,
  LARGE: 198,
  XL: 219,
  ESTATE: 251,
  ACRE_CLASS: 282,
  OVER_ACRE: 282,
  overAcreIncrementPrice: 42,
};
const NEW_LADDER = {
  SMALL: 199,
  STANDARD: 212,
  LARGE: 230,
  XL: 255,
  ESTATE: 278,
  ACRE_CLASS: 309,
  OVER_ACRE: 309,
  overAcreIncrementPrice: 26,
};
const FLOOR = 199;

const CATALOG_KEY = 'services_mosquito_one_time';
const OLD_CATALOG = { base_price: 156, price_range_min: 156, price_range_max: 282 };
const NEW_CATALOG = { base_price: 199, price_range_min: 199, price_range_max: 309 };

const CHANGELOG_IDENTITY = {
  version_from: 'v4.9',
  version_to: 'v4.9',
  changed_by: 'claude-2026-10-25',
  // pricing_changelog_category_check: a price-level change is 'rule' by
  // repo convention (see 20260808010000).
  category: 'rule',
  summary: 'One-time mosquito: $199 minimum (after the recurring perk) and a ladder whose steps shrink as yards grow ($199 to $309 at an acre).',
};

function parseData(row) {
  try { return typeof row.data === 'string' ? JSON.parse(row.data) : (row.data || {}); } catch { return null; }
}

function parseJson(text) {
  if (text == null) return null;
  if (typeof text === 'object') return text;
  try { return JSON.parse(text); } catch { return null; }
}

function sameNumber(a, b) {
  const n = Number(a);
  return Number.isFinite(n) && n === Number(b);
}

function holdsAll(values, expected) {
  return Object.entries(expected).every(([key, value]) => sameNumber(values?.[key], value));
}

async function hasAuditTable(knex) {
  return knex.schema.hasTable('pricing_config_audit');
}

async function auditInsert(knex, configKey, oldValue, newValue, changedBy, reason) {
  if (!(await hasAuditTable(knex))) return;
  await knex('pricing_config_audit').insert({
    config_key: configKey,
    old_value: oldValue == null ? null : JSON.stringify(oldValue),
    new_value: newValue == null ? null : JSON.stringify(newValue),
    changed_by: changedBy,
    reason,
  });
}

async function latestOwnUpAudit(knex, configKey) {
  if (!(await hasAuditTable(knex))) return null;
  return knex('pricing_config_audit')
    .where({ config_key: configKey, changed_by: MIGRATION_TAG })
    .orderBy('id', 'desc')
    .first();
}

async function upConfig(knex) {
  if (!(await knex.schema.hasTable('pricing_config'))) return null;
  // forUpdate: the admin pricing writer locks this row for its own
  // read-modify-write, so an edit committed between this SELECT and the
  // whole-JSON UPDATE below cannot be overwritten.
  const row = await knex('pricing_config').where({ config_key: 'onetime_mosquito' }).forUpdate().first();
  if (!row) return null;
  const data = parseData(row);
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;

  const moveLadder = holdsAll(data, OLD_LADDER);
  const addFloor = data.floor === undefined || data.floor === null;
  if (!moveLadder && !addFloor) return null;

  const next = { ...data, ...(moveLadder ? NEW_LADDER : {}), ...(addFloor ? { floor: FLOOR } : {}) };
  await knex('pricing_config')
    .where({ config_key: 'onetime_mosquito' })
    .update({ data: JSON.stringify(next), updated_at: knex.fn.now() });
  const parts = [];
  if (moveLadder) parts.push('ladder 156/177/198/219/251/282/282 +42 -> 199/212/230/255/278/309/309 +26');
  else parts.push('ladder left alone (admin-edited cells)');
  if (addFloor) parts.push('floor 199 added');
  await auditInsert(knex, 'onetime_mosquito', data, next, MIGRATION_TAG,
    `One-time mosquito $199 minimum + tapering ladder (owner 2026-10-25): ${parts.join('; ')}.`);
  return { moveLadder, addFloor };
}

async function upCatalog(knex) {
  if (!(await knex.schema.hasTable('services'))) return false;
  const svc = await knex('services')
    .where({ service_key: 'mosquito_one_time' })
    .forUpdate()
    .first('base_price', 'price_range_min', 'price_range_max');
  if (!svc || !holdsAll(svc, OLD_CATALOG)) return false;
  await knex('services').where({ service_key: 'mosquito_one_time' }).update({
    ...NEW_CATALOG,
    updated_at: knex.fn.now(),
  });
  await auditInsert(knex, CATALOG_KEY, OLD_CATALOG, NEW_CATALOG, MIGRATION_TAG,
    'One-time mosquito catalog fallback and Service Library range follow the new ladder (156/156/282 -> 199/199/309).');
  return true;
}

exports.up = async function up(knex) {
  const config = await upConfig(knex);
  const catalogMoved = await upCatalog(knex);
  if (!config && !catalogMoved) return;
  if (!(await knex.schema.hasTable('pricing_changelog'))) return;
  const existing = await knex('pricing_changelog').where(CHANGELOG_IDENTITY).first('id');
  if (existing) return;
  await knex('pricing_changelog').insert({
    ...CHANGELOG_IDENTITY,
    affected_services: JSON.stringify(['mosquito']),
    before_value: JSON.stringify({ onetime_mosquito: { ...OLD_LADDER, floor: null }, services_mosquito_one_time: OLD_CATALOG }),
    after_value: JSON.stringify({ onetime_mosquito: { ...NEW_LADDER, floor: FLOOR }, services_mosquito_one_time: NEW_CATALOG }),
    rationale: 'Owner 2026-10-25: the one-time mosquito minimum is $199 and the price climbs from there, with each step a little smaller than the one before. Sized on spray volume: the Bifen I/T label sprays 1 gal per 1,000 sq ft, so one 4-gal backpack tank covers about 4,000 sq ft of foliage, about a 7,500 sq ft yard. Bigger yards need more tanks but not in proportion (tanks ~ (yard/7,500)^0.75, fit to Trout et al. 2007), at about $40 per extra tank. Each extra 5,000 sq ft now adds $18 tapering to $13 (it was 27/19/13/18/19/14/13). The $199 minimum applies after the 15% recurring-customer perk, as one-time pest does; it is an owner-set list minimum, not one of the margin floors disarmed 2026-07-17.',
  });
};

async function downConfig(knex) {
  const configAudit = await latestOwnUpAudit(knex, 'onetime_mosquito');
  if (!configAudit || !(await knex.schema.hasTable('pricing_config'))) return;
  const before = parseJson(configAudit.old_value) || {};
  const after = parseJson(configAudit.new_value) || {};
  const row = await knex('pricing_config').where({ config_key: 'onetime_mosquito' }).forUpdate().first();
  const data = row ? parseData(row) : null;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return;
  const next = { ...data };
  // The ladder goes back only as a whole, only if up() moved it, and only
  // while every cell still holds what up() wrote.
  const restoreLadder = holdsAll(after, NEW_LADDER) && holdsAll(before, OLD_LADDER) && holdsAll(data, NEW_LADDER);
  if (restoreLadder) Object.assign(next, OLD_LADDER);
  // The floor goes only if up() added it and nobody has changed it since.
  const upAddedFloor = (before.floor === undefined || before.floor === null) && sameNumber(after.floor, FLOOR);
  const removeFloor = upAddedFloor && sameNumber(data.floor, FLOOR);
  if (removeFloor) delete next.floor;
  if (!restoreLadder && !removeFloor) return;
  await knex('pricing_config')
    .where({ config_key: 'onetime_mosquito' })
    .update({ data: JSON.stringify(next), updated_at: knex.fn.now() });
  await auditInsert(knex, 'onetime_mosquito', data, next, DOWN_TAG,
    'Rollback of the 2026-10-25 one-time mosquito $199 minimum + tapering ladder (cells a later edit changed are kept).');
}

async function downCatalog(knex) {
  const catalogAudit = await latestOwnUpAudit(knex, CATALOG_KEY);
  if (!catalogAudit || !(await knex.schema.hasTable('services'))) return;
  const svc = await knex('services')
    .where({ service_key: 'mosquito_one_time' })
    .forUpdate()
    .first('base_price', 'price_range_min', 'price_range_max');
  if (!svc || !holdsAll(svc, NEW_CATALOG)) return;
  await knex('services').where({ service_key: 'mosquito_one_time' }).update({
    ...OLD_CATALOG,
    updated_at: knex.fn.now(),
  });
  await auditInsert(knex, CATALOG_KEY, NEW_CATALOG, OLD_CATALOG, DOWN_TAG,
    'Rollback of the 2026-10-25 one-time mosquito catalog fallback (199/199/309 -> 156/156/282).');
}

exports.down = async function down(knex) {
  // The changelog must never report a rolled-back change as active.
  if (await knex.schema.hasTable('pricing_changelog')) {
    await knex('pricing_changelog').where(CHANGELOG_IDENTITY).del();
  }
  // No audit table = no proof of ownership: leave the data alone.
  if (!(await hasAuditTable(knex))) return;
  await downConfig(knex);
  await downCatalog(knex);
};

module.exports.MIGRATION_TAG = MIGRATION_TAG;
module.exports.OLD_LADDER = OLD_LADDER;
module.exports.NEW_LADDER = NEW_LADDER;
module.exports.FLOOR = FLOOR;
module.exports.OLD_CATALOG = OLD_CATALOG;
module.exports.NEW_CATALOG = NEW_CATALOG;
