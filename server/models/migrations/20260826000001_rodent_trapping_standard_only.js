/**
 * Retire the Unlimited rodent trapping plan (owner directive 2026-08-26).
 *
 * Rodent trapping is now Standard-only: flat $350 with 2 included
 * callbacks/checks, extras at $125 each. The engine no longer reads
 * unlimited_price / upgrade_to_unlimited_price / unlimited_floor, so this
 * migration strips those keys from the DB-authoritative
 * pricing_config.rodent_trapping row (read-modify-write — admin edits to the
 * surviving keys are preserved) so the admin pricing panel stops advertising
 * a plan that can no longer be sold. Standard pricing values are unchanged.
 */
const MIGRATION_TAG = 'migration:20260826000001';
const UP_REASON = 'Retire Unlimited rodent trapping plan — Standard-only, $350 flat (owner directive 2026-08-26)';
const RETIRED_KEYS = ['unlimited_price', 'upgrade_to_unlimited_price', 'unlimited_floor'];
const STANDARD_SERVICE_DESCRIPTION = 'Interior snap trap and glue board placement for active rodent activity. Includes initial setup plus 2 callbacks/checks; additional callbacks after the included visits are $125 each.';
// Prior catalog copy (set by 20260516000009) — restored on rollback.
const LEGACY_SERVICE_DESCRIPTION = 'Interior snap trap and glue board placement for active rodent activity. Includes initial setup and unlimited trap checks/callbacks during the 14-day active trapping window.';
const CHANGELOG_IDENTITY = {
  version_from: 'v4.6',
  version_to: 'v4.6',
  changed_by: 'claude-2026-08-26',
  category: 'rule',
  summary: 'Rodent trapping Standard-only: retire Unlimited plan and mid-program upgrade.',
};

async function loadTrappingRow(knex) {
  if (!(await knex.schema.hasTable('pricing_config'))) return null;
  const row = await knex('pricing_config').where({ config_key: 'rodent_trapping' }).first();
  if (!row) return null;
  const data = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
  if (!data || typeof data !== 'object') return null;
  return { row, data };
}

async function saveTrappingRow(knex, oldData, newData, reason, name) {
  await knex('pricing_config')
    .where({ config_key: 'rodent_trapping' })
    .update({
      ...(name ? { name } : {}),
      data: JSON.stringify(newData),
      updated_at: knex.fn.now(),
    });
  if (await knex.schema.hasTable('pricing_config_audit')) {
    await knex('pricing_config_audit').insert({
      config_key: 'rodent_trapping',
      old_value: JSON.stringify(oldData),
      new_value: JSON.stringify(newData),
      changed_by: MIGRATION_TAG,
      reason,
    });
  }
}

exports.up = async function (knex) {
  const loaded = await loadTrappingRow(knex);
  if (!loaded) return;
  const { data } = loaded;
  if (!RETIRED_KEYS.some((key) => data[key] != null)) return;

  const newData = { ...data };
  for (const key of RETIRED_KEYS) delete newData[key];
  await saveTrappingRow(knex, data, newData, UP_REASON,
    'Rodent Trapping (Standard — flat, 2 included callbacks)');

  // Catalog copy still promised unlimited active-window trap checks
  // (20260516000009) — align it with the Standard-only plan.
  if (await knex.schema.hasTable('services')) {
    await knex('services')
      .where('service_key', 'rodent_trapping')
      .update({ description: STANDARD_SERVICE_DESCRIPTION, updated_at: knex.fn.now() });
  }

  if (await knex.schema.hasTable('pricing_changelog')) {
    const existing = await knex('pricing_changelog').where(CHANGELOG_IDENTITY).first('id');
    if (!existing) {
      await knex('pricing_changelog').insert({
        ...CHANGELOG_IDENTITY,
        affected_services: JSON.stringify(['rodent_trapping']),
        before_value: JSON.stringify({
          unlimited_price: data.unlimited_price ?? null,
          upgrade_to_unlimited_price: data.upgrade_to_unlimited_price ?? null,
          unlimited_floor: data.unlimited_floor ?? null,
        }),
        after_value: JSON.stringify({ plans: ['standard'] }),
        rationale: 'Owner directive 2026-08-26: rodent trapping sells one plan — Standard, $350 flat, 2 included callbacks, $125 per extra callback after they are used. The Unlimited plan ($450) and the mid-program upgrade (+$125) are retired; the engine coerces legacy unlimited inputs to Standard with a warning. Standard pricing values are unchanged.',
      });
    }
  }
};

exports.down = async function (knex) {
  // Only restore the retired keys if this migration's up() removed them —
  // keyed off the audit row, mirroring 20260611000003's ownership pattern.
  if (!(await knex.schema.hasTable('pricing_config_audit'))) return;
  const ownUp = await knex('pricing_config_audit')
    .where({ config_key: 'rodent_trapping', changed_by: MIGRATION_TAG, reason: UP_REASON })
    .orderBy('id', 'desc')
    .first();
  if (!ownUp) return;

  const loaded = await loadTrappingRow(knex);
  if (loaded) {
    const oldValue = typeof ownUp.old_value === 'string' ? JSON.parse(ownUp.old_value) : ownUp.old_value;
    const restored = { ...loaded.data };
    for (const key of RETIRED_KEYS) {
      if (oldValue && oldValue[key] != null) restored[key] = oldValue[key];
    }
    await saveTrappingRow(
      knex, loaded.data, restored,
      'Rollback: restore Unlimited rodent trapping plan keys (20260826000001)',
      'Rodent Trapping'
    );
  }
  if (await knex.schema.hasTable('services')) {
    await knex('services')
      .where('service_key', 'rodent_trapping')
      .update({ description: LEGACY_SERVICE_DESCRIPTION, updated_at: knex.fn.now() });
  }
  if (await knex.schema.hasTable('pricing_changelog')) {
    await knex('pricing_changelog').where(CHANGELOG_IDENTITY).del();
  }
};
