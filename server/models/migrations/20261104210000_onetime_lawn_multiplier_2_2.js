/**
 * One-time lawn uses the same multiple as one-time pest (owner 2026-11-04:
 * asked whether one-time lawn used the one-time pest multiple, then "go ahead
 * and do this you edit one row (onetime_lawn) in the admin pricing settings").
 *
 * Moves, in the live data:
 *  - pricing_config.onetime_lawn.recurringPerAppMultiplier 1.5 -> 2.2: the
 *    multiple priceOneTimeLawn applies to the 6x per-app anchor before the
 *    treatment factor. The treatment factors and the $115 floor are untouched.
 *  - a pricing_changelog entry.
 *
 * Production already holds 2.2 (the owner-requested edit of 2026-11-04 wrote
 * it through the admin writer's path, with its pricing_config_audit row), so
 * there up() finds nothing at 1.5 and records nothing. Fresh and preview
 * databases still carry the 1.5 seeded by 20260515000002; this moves them to
 * match the code default.
 *
 * The multiplier moves only while it still holds the seeded 1.5; any other
 * value is an admin's and wins. The value is read the way db-bridge reads it
 * (recurringPerAppMultiplier, else the legacy markup_multiplier). The write
 * is under the row lock the admin pricing writer also takes, with a
 * pricing_config_audit row.
 *
 * down() keys off this migration's own audit row and restores the old value
 * only while the row still holds the 2.2 up() wrote, so a later admin edit
 * wins.
 *
 * Quotes already saved keep their stored prices; a new save reprices.
 */
const MIGRATION_TAG = 'migration:20261104210000';
const DOWN_TAG = `${MIGRATION_TAG}:down`;
const CONFIG_KEY = 'onetime_lawn';
const OLD_MULTIPLIER = 1.5;
const NEW_MULTIPLIER = 2.2;

const CHANGELOG_IDENTITY = {
  version_from: 'v4.9',
  version_to: 'v4.9',
  changed_by: 'claude-2026-11-04',
  // pricing_changelog_category_check: a price-level change is 'rule' by
  // repo convention (see 20260808010000).
  category: 'rule',
  summary: 'One-time lawn: same multiple as one-time pest (2.2x the 6x per-app anchor, was 1.5x); treatment factors and $115 floor unchanged.',
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

// db-bridge: recurringPerAppMultiplier ?? markup_multiplier.
function effectiveMultiplier(data) {
  return data.recurringPerAppMultiplier ?? data.markup_multiplier;
}

async function hasAuditTable(knex) {
  return knex.schema.hasTable('pricing_config_audit');
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
  // forUpdate: the admin pricing writer locks this row for its own
  // read-modify-write, so an edit committed between this SELECT and the
  // whole-JSON UPDATE below cannot be overwritten.
  const row = await knex('pricing_config').where({ config_key: CONFIG_KEY }).forUpdate().first();
  const data = row ? parseData(row) : null;
  return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
}

async function writeRow(knex, next) {
  await knex('pricing_config')
    .where({ config_key: CONFIG_KEY })
    .update({ data: JSON.stringify(next), updated_at: knex.fn.now() });
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('pricing_config'))) return;
  const data = await lockedRow(knex);
  if (!data || !sameNumber(effectiveMultiplier(data), OLD_MULTIPLIER)) return;

  const next = { ...data, recurringPerAppMultiplier: NEW_MULTIPLIER };
  await writeRow(knex, next);
  await auditInsert(knex, data, next, MIGRATION_TAG,
    'One-time lawn uses the one-time pest multiple (owner 2026-11-04): recurringPerAppMultiplier 1.5 -> 2.2.');

  if (!(await knex.schema.hasTable('pricing_changelog'))) return;
  const existing = await knex('pricing_changelog').where(CHANGELOG_IDENTITY).first('id');
  if (existing) return;
  await knex('pricing_changelog').insert({
    ...CHANGELOG_IDENTITY,
    affected_services: JSON.stringify(['lawn']),
    before_value: JSON.stringify({ onetime_lawn: { recurringPerAppMultiplier: OLD_MULTIPLIER } }),
    after_value: JSON.stringify({ onetime_lawn: { recurringPerAppMultiplier: NEW_MULTIPLIER } }),
    rationale: 'Owner 2026-11-04: one-time lawn uses the same multiple as one-time pest (2.2). One-time lawn = max($115, 6x per-app x 2.2) x treatment factor (fert 1.00, weed 1.12, lawn pest 1.30, fungicide 1.38), $115 floor re-applied after the 15% recurring-customer perk. Moves the One-Time Lawn and Lawn Pest Knockdown lines; one-time pest is unchanged.',
  });
};

exports.down = async function down(knex) {
  // The changelog must never report a rolled-back change as active.
  if (await knex.schema.hasTable('pricing_changelog')) {
    await knex('pricing_changelog').where(CHANGELOG_IDENTITY).del();
  }
  // No audit row of our own = no proof up() wrote the value: leave it alone.
  if (!(await hasAuditTable(knex)) || !(await knex.schema.hasTable('pricing_config'))) return;
  const own = await knex('pricing_config_audit')
    .where({ config_key: CONFIG_KEY, changed_by: MIGRATION_TAG })
    .orderBy('id', 'desc')
    .first();
  if (!own) return;
  const before = parseJson(own.old_value) || {};
  const data = await lockedRow(knex);
  if (!data || !sameNumber(data.recurringPerAppMultiplier, NEW_MULTIPLIER)) return;

  const next = { ...data };
  if (before.recurringPerAppMultiplier === undefined) delete next.recurringPerAppMultiplier;
  else next.recurringPerAppMultiplier = before.recurringPerAppMultiplier;
  await writeRow(knex, next);
  await auditInsert(knex, data, next, DOWN_TAG,
    'Rollback of the 2026-11-04 one-time lawn multiplier 1.5 -> 2.2 (kept when a later edit changed it).');
};

module.exports.MIGRATION_TAG = MIGRATION_TAG;
module.exports.OLD_MULTIPLIER = OLD_MULTIPLIER;
module.exports.NEW_MULTIPLIER = NEW_MULTIPLIER;
