/**
 * Lawn Insect Spot Treatment: the Arena 50 WDG material cost follows the current SiteOne price (owner 2026-11-20,
 * "fix these": the add-on still priced its material from the old $394.79 price; at $296.88 it is about $1.09).
 *
 * Moves, in the live data:
 *  - pricing_config.area_addon_pricing items.lawn_insect_spot.materialPer1000 1.45 -> 1.09: 0.147 oz per 1,000 sq ft
 *    (the Florida 2(ee) rate) x $7.42/oz (SiteOne $296.88 for 2.5 lb = 40 oz). It was 0.147 x $9.87/oz ($394.79).
 *  - a pricing_changelog entry.
 *
 * With the live knobs (60% target margin, $8 admin, the global labor rate and drive minutes) no customer price moves:
 * own visit $79/$89/$109, same trip $49/$59/$79, each further add-on $29/$39/$59 at 1,000/2,000/3,500 sq ft, before and
 * after. The material line and the margin on the quote move.
 *
 * The value moves only while it still holds the seeded 1.45 (20261010110000); any other value is an admin's and wins.
 * The write is under the row lock the admin pricing writer also takes, with a pricing_config_audit row. Every other key
 * of the row, and every other add-on, is untouched.
 *
 * down() restores the old value only while the row still holds 1.09 AND the newest audit entry that moved this material is
 * up()'s own (read under the row lock), so a later admin edit wins, even one that set 1.09 again.
 *
 * Quotes already saved keep the knobs they were priced with (pricingKnobs); a new quote uses the new cost.
 */
const MIGRATION_TAG = 'migration:20261120201500';
const DOWN_TAG = `${MIGRATION_TAG}:down`;
const CONFIG_KEY = 'area_addon_pricing';
const ITEM_KEY = 'lawn_insect_spot';
const OLD_MATERIAL = 1.45;
const NEW_MATERIAL = 1.09;

const CHANGELOG_IDENTITY = {
  version_from: 'v4.9',
  version_to: 'v4.9',
  changed_by: 'claude-2026-11-20',
  // pricing_changelog_category_check: a product cost update is 'cost'.
  category: 'cost',
  summary: 'Lawn Insect Spot Treatment: Arena 50 WDG material $1.09 per 1,000 sq ft (was $1.45), at SiteOne $296.88; no customer price moves.',
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
  if (a === null || a === undefined || a === '') return false;
  const n = Number(a);
  return Number.isFinite(n) && n === Number(b);
}

const isPlain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const materialOf = (data) => (isPlain(data?.items) && isPlain(data.items[ITEM_KEY]) ? data.items[ITEM_KEY].materialPer1000 : undefined);
const withMaterial = (data, value) => ({ ...data, items: { ...data.items, [ITEM_KEY]: { ...data.items[ITEM_KEY], materialPer1000: value } } });

async function hasAuditTable(knex) {
  return knex.schema.hasTable('pricing_config_audit');
}

// The newest pricing_config_audit entry of this row whose old and new data differ in this add-on's material, or null.
async function lastMaterialChange(knex) {
  const materialIn = (text) => {
    const value = materialOf(parseJson(text));
    return value === undefined || value === null ? null : Number(value);
  };
  const entries = await knex('pricing_config_audit')
    .where({ config_key: CONFIG_KEY })
    .orderBy('id', 'desc')
    .select('id', 'changed_by', 'old_value', 'new_value');
  return entries.find((entry) => materialIn(entry.old_value) !== materialIn(entry.new_value)) || null;
}

async function auditInsert(knex, oldValue, newValue, changedBy, reason) {
  if (!(await hasAuditTable(knex))) return;
  await knex('pricing_config_audit').insert({
    config_key: CONFIG_KEY,
    old_value: oldValue == null ? null : JSON.stringify(oldValue),
    new_value: newValue == null ? null : JSON.stringify(newValue),
    changed_by: changedBy,
    reason,
  });
}

async function lockedRow(knex) {
  // forUpdate: the admin pricing writer locks this row for its own read-modify-write, so an edit committed between this
  // SELECT and the whole-JSON UPDATE below cannot be overwritten.
  const row = await knex('pricing_config').where({ config_key: CONFIG_KEY }).forUpdate().first();
  const data = row ? parseData(row) : null;
  return isPlain(data) ? data : null;
}

async function writeRow(knex, next) {
  await knex('pricing_config')
    .where({ config_key: CONFIG_KEY })
    .update({ data: JSON.stringify(next), updated_at: knex.fn.now() });
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('pricing_config'))) return;
  const data = await lockedRow(knex);
  if (!data || !sameNumber(materialOf(data), OLD_MATERIAL)) return;

  const next = withMaterial(data, NEW_MATERIAL);
  await writeRow(knex, next);
  await auditInsert(knex, data, next, MIGRATION_TAG,
    'Arena 50 WDG at the SiteOne price $296.88 (owner 2026-11-20): Lawn Insect Spot Treatment materialPer1000 1.45 -> 1.09.');

  if (!(await knex.schema.hasTable('pricing_changelog'))) return;
  const existing = await knex('pricing_changelog').where(CHANGELOG_IDENTITY).first('id');
  if (existing) return;
  await knex('pricing_changelog').insert({
    ...CHANGELOG_IDENTITY,
    affected_services: JSON.stringify(['area_addon']),
    before_value: JSON.stringify({ [CONFIG_KEY]: { items: { [ITEM_KEY]: { materialPer1000: OLD_MATERIAL } } } }),
    after_value: JSON.stringify({ [CONFIG_KEY]: { items: { [ITEM_KEY]: { materialPer1000: NEW_MATERIAL } } } }),
    rationale: 'Owner 2026-11-20: the add-on priced Arena 50 WDG from the old $394.79 SiteOne price ($9.87/oz). At $296.88 ($7.42/oz) the 0.147 oz per 1,000 sq ft rate costs $1.09 per 1,000 sq ft. At 1,000/2,000/3,500 sq ft every customer price stays the same (own visit $79/$89/$109); the quoted material cost and margin move.',
  });
};

exports.down = async function down(knex) {
  // The changelog must never report a rolled-back change as active.
  if (await knex.schema.hasTable('pricing_changelog')) {
    await knex('pricing_changelog').where(CHANGELOG_IDENTITY).del();
  }
  if (!(await hasAuditTable(knex)) || !(await knex.schema.hasTable('pricing_config'))) return;
  // Under the row lock (the admin writer takes it before its own audit insert), the NEWEST audit entry that moved this
  // add-on's material must be up()'s own. A later edit owns the value, even one that set 1.09 again, and stays.
  const data = await lockedRow(knex);
  if (!data || !sameNumber(materialOf(data), NEW_MATERIAL)) return;
  const own = await lastMaterialChange(knex);
  if (!own || own.changed_by !== MIGRATION_TAG) return;
  const before = materialOf(parseJson(own.old_value));
  if (!sameNumber(before, OLD_MATERIAL)) return;

  const next = withMaterial(data, before);
  await writeRow(knex, next);
  await auditInsert(knex, data, next, DOWN_TAG,
    'Rollback of the 2026-11-20 Lawn Insect Spot Treatment materialPer1000 1.45 -> 1.09 (kept when a later edit changed it).');
};

module.exports.MIGRATION_TAG = MIGRATION_TAG;
module.exports.OLD_MATERIAL = OLD_MATERIAL;
module.exports.NEW_MATERIAL = NEW_MATERIAL;
