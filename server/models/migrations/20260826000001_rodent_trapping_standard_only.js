/**
 * Rodent trapping: Standard-only, flat $350, unlimited callbacks
 * (owner directive 2026-08-26).
 *
 * The single trapping plan is Standard: flat $350 covering initial setup
 * plus UNLIMITED callbacks/checks for the same active trapping job. The
 * separate Unlimited tier ($450), the mid-program upgrade (+$125), and
 * per-callback extra billing ($125 each) are all retired. The engine no
 * longer reads unlimited_price / upgrade_to_unlimited_price /
 * unlimited_floor / additional_followup_rate, so this migration strips
 * those keys from the DB-authoritative pricing_config.rodent_trapping row
 * and sets included_followups to 'unlimited' (read-modify-write — admin
 * edits to the surviving keys are preserved) so the admin pricing panel
 * matches what can actually be sold. The $350 Standard price is unchanged.
 */
const MIGRATION_TAG = 'migration:20260826000001';
const UP_REASON = 'Rodent trapping Standard-only — $350 flat, unlimited callbacks (owner directive 2026-08-26)';
const RETIRED_KEYS = ['unlimited_price', 'upgrade_to_unlimited_price', 'unlimited_floor', 'additional_followup_rate'];
const STANDARD_ROW_NAME = 'Rodent Trapping (Standard — flat $350, unlimited callbacks)';
const STANDARD_SERVICE_DESCRIPTION = 'Interior snap trap and glue board placement for active rodent activity. Includes initial setup plus unlimited callbacks/checks for the same active trapping job.';
// Rollback restores the description the row ACTUALLY carried before up()
// (captured in the audit row's old_value — an admin edit survives the
// round trip). This constant is the fallback for a row whose prior copy
// was not captured: the immediately preceding catalog copy, set by
// 20260526000009 (two-plan Standard + Unlimited terms).
const LEGACY_SERVICE_DESCRIPTION = 'Standard rodent trapping includes initial setup plus 2 callbacks/checks. Unlimited Callback trapping covers callbacks for the same active trapping job only.';
const CHANGELOG_IDENTITY = {
  version_from: 'v4.6',
  version_to: 'v4.6',
  changed_by: 'claude-2026-08-26',
  category: 'rule',
  summary: 'Rodent trapping Standard-only: $350 flat with unlimited callbacks; Unlimited tier, upgrade, and per-callback extras retired.',
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
  const needsChange = RETIRED_KEYS.some((key) => data[key] != null)
    || data.included_followups !== 'unlimited';
  if (!needsChange) return;

  const newData = { ...data, included_followups: 'unlimited' };
  for (const key of RETIRED_KEYS) delete newData[key];

  // Catalog copy still described the two-plan terms (20260526000009) —
  // align it with the Standard-only plan, remembering what it said so
  // down() restores the real predecessor rather than a guess.
  let priorServiceDescription = null;
  if (await knex.schema.hasTable('services')) {
    const svc = await knex('services').where('service_key', 'rodent_trapping').first('description');
    if (svc) priorServiceDescription = svc.description ?? null;
    await knex('services')
      .where('service_key', 'rodent_trapping')
      .update({ description: STANDARD_SERVICE_DESCRIPTION, updated_at: knex.fn.now() });
  }
  await saveTrappingRow(
    knex,
    { ...data, __service_description: priorServiceDescription },
    newData,
    UP_REASON,
    STANDARD_ROW_NAME
  );

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
          additional_followup_rate: data.additional_followup_rate ?? null,
          included_followups: data.included_followups ?? null,
        }),
        after_value: JSON.stringify({ plans: ['standard'], included_followups: 'unlimited' }),
        rationale: 'Owner directive 2026-08-26: rodent trapping sells one plan — Standard, $350 flat, unlimited callbacks/checks for the same active trapping job. The Unlimited tier ($450), the mid-program upgrade (+$125), and $125 per-callback extras are retired; the engine ignores legacy plan/upgrade/callback-count inputs on re-price. The $350 Standard price is unchanged.',
      });
    }
  }
};

exports.down = async function (knex) {
  // Only restore what this migration's up() changed — keyed off the audit
  // row, mirroring 20260611000003's ownership pattern.
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
    if (oldValue && oldValue.included_followups != null) {
      restored.included_followups = oldValue.included_followups;
    }
    await saveTrappingRow(
      knex, loaded.data, restored,
      'Rollback: restore pre-Standard-only rodent trapping plan keys (20260826000001)',
      'Rodent Trapping'
    );
  }
  if (await knex.schema.hasTable('services')) {
    const oldValue = typeof ownUp.old_value === 'string' ? JSON.parse(ownUp.old_value) : ownUp.old_value;
    const captured = oldValue && typeof oldValue.__service_description === 'string'
      ? oldValue.__service_description
      : null;
    await knex('services')
      .where('service_key', 'rodent_trapping')
      // Value-guarded: only a row still carrying this migration's copy is
      // restored, so a later admin edit survives the rollback.
      .where('description', STANDARD_SERVICE_DESCRIPTION)
      .update({ description: captured ?? LEGACY_SERVICE_DESCRIPTION, updated_at: knex.fn.now() });
  }
  if (await knex.schema.hasTable('pricing_changelog')) {
    await knex('pricing_changelog').where(CHANGELOG_IDENTITY).del();
  }
};
