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
// Plan/callback keys the Standard-only pricer no longer reads, PLUS the
// footprint/lot/pressure adjustment tables 20260526000009 stored — the
// flat $350 ignores them, and leaving them on existing rows kept the
// generic pricing editor offering knobs that move nothing (codex #3521
// r8 P2). All restored from the audit row on rollback.
const RETIRED_KEYS = [
  'unlimited_price', 'upgrade_to_unlimited_price', 'unlimited_floor', 'additional_followup_rate',
  'home_size_adjustments', 'lot_adjustments', 'pressure_adjustments',
  // priceRodentTrapping reads only the emergency surcharge settings; the
  // $350 Standard price is FIXED in code (owner 2026-08-26) — a DB copy of
  // it was a second dollar authority that could drift from the catalog and
  // client mirror (codex #3521). The bracketed-pricing scaffolding goes too.
  'standard_price', 'base', 'floor', 'ceiling_before_custom', 'active_window_days',
];
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


// Audit rows persist across up/down cycles: a later no-op reapplication
// must NOT consume provenance from an earlier cycle and restore values this
// application never changed (codex #3521 r20 P2, mirroring
// 20260724130000's pattern). Only an UP row with a HIGHER id than the most
// recent matching ROLLBACK row belongs to the current cycle.
async function latestUncancelledUp(knex, configKey) {
  const lastDown = await knex('pricing_config_audit')
    .where({ config_key: configKey, changed_by: MIGRATION_TAG })
    .whereLike('reason', 'Rollback:%')
    .orderBy('id', 'desc')
    .first('id');
  const query = knex('pricing_config_audit')
    .where({ config_key: configKey, changed_by: MIGRATION_TAG, reason: UP_REASON })
    .orderBy('id', 'desc');
  if (lastDown?.id != null) query.where('id', '>', lastDown.id);
  return query.first();
}

exports.up = async function (knex) {
  const loaded = await loadTrappingRow(knex);
  if (!loaded) return;
  const { data } = loaded;
  const pricingNeedsChange = RETIRED_KEYS.some((key) => data[key] != null)
    || data.included_followups !== 'unlimited';

  // Catalog copy is judged INDEPENDENTLY of the pricing row (uncapped audit
  // P1 on #3521): a config already at target must not leave the Service
  // Library describing the retired two-plan terms. The prior copy is
  // remembered so down() restores the real predecessor.
  let priorServiceDescription = null;
  let descriptionChanged = false;
  if (await knex.schema.hasTable('services')) {
    const svc = await knex('services').where('service_key', 'rodent_trapping').first('description');
    if (svc && String(svc.description || '') !== STANDARD_SERVICE_DESCRIPTION) {
      priorServiceDescription = svc.description ?? null;
      await knex('services')
        .where('service_key', 'rodent_trapping')
        .update({ description: STANDARD_SERVICE_DESCRIPTION, updated_at: knex.fn.now() });
      descriptionChanged = true;
    }
  }
  if (!pricingNeedsChange && !descriptionChanged) return;

  const newData = pricingNeedsChange
    ? { ...data, included_followups: 'unlimited' }
    : { ...data };
  if (pricingNeedsChange) for (const key of RETIRED_KEYS) delete newData[key];
  // One audit row per up(), even for a description-only change — down()
  // keys its rollback (pricing keys AND the captured catalog copy) off it.
  await saveTrappingRow(
    knex,
    // Prior catalog copy AND prior pricing-row name ride the audit row so
    // down() restores the real predecessors (codex #3521 r15 P2).
    { ...data, __service_description: priorServiceDescription, __row_name: loaded.row.name ?? null },
    newData,
    UP_REASON,
    pricingNeedsChange ? STANDARD_ROW_NAME : null
  );

  if (await knex.schema.hasTable('pricing_changelog')) {
    const existing = await knex('pricing_changelog').where(CHANGELOG_IDENTITY).first('id');
    if (!existing) {
      await knex('pricing_changelog').insert({
        ...CHANGELOG_IDENTITY,
        affected_services: JSON.stringify(['rodent_trapping']),
        before_value: JSON.stringify({
          ...Object.fromEntries(RETIRED_KEYS.map((key) => [key, data[key] ?? null])),
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
  const ownUp = await latestUncancelledUp(knex, 'rodent_trapping');
  if (!ownUp) return;

  const loaded = await loadTrappingRow(knex);
  if (loaded) {
    const oldValue = typeof ownUp.old_value === 'string' ? JSON.parse(ownUp.old_value) : ownUp.old_value;
    // Value-guarded like the companion migrations (uncapped audit P1 on
    // #3521): each field goes back ONLY while it still holds what up()
    // wrote — an admin edit made after up() survives the rollback.
    const restored = { ...loaded.data };
    for (const key of RETIRED_KEYS) {
      if (oldValue && oldValue[key] != null && restored[key] === undefined) restored[key] = oldValue[key];
    }
    if (oldValue && oldValue.included_followups != null && restored.included_followups === 'unlimited') {
      restored.included_followups = oldValue.included_followups;
    }
    // Restore the pricing-row name only if up() renamed it (the row still
    // carries STANDARD_ROW_NAME) and only to the captured predecessor — a
    // description-only up() never touched the name, so neither does this.
    const restoreName = loaded.row.name === STANDARD_ROW_NAME && oldValue && typeof oldValue.__row_name === 'string'
      ? oldValue.__row_name
      : null;
    await saveTrappingRow(
      knex, loaded.data, restored,
      'Rollback: restore pre-Standard-only rodent trapping plan keys (20260826000001)',
      restoreName
    );
  }
  if (await knex.schema.hasTable('services')) {
    const oldValue = typeof ownUp.old_value === 'string' ? JSON.parse(ownUp.old_value) : ownUp.old_value;
    // Restore the catalog copy ONLY if up() recorded changing it (a captured
    // prior string) and the row still carries this migration's copy — an
    // up() that found the copy already current never touches it, and
    // neither does its rollback.
    const captured = oldValue && typeof oldValue.__service_description === 'string'
      ? oldValue.__service_description
      : null;
    if (captured !== null) {
      await knex('services')
        .where('service_key', 'rodent_trapping')
        .where('description', STANDARD_SERVICE_DESCRIPTION)
        .update({ description: captured, updated_at: knex.fn.now() });
    }
  }
  if (await knex.schema.hasTable('pricing_changelog')) {
    await knex('pricing_changelog').where(CHANGELOG_IDENTITY).del();
  }
};
