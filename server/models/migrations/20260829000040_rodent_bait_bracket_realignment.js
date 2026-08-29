/**
 * Rodent bait station bracket realignment (owner directive 2026-08-29).
 *
 * Pricing is DB-authoritative (db-bridge.syncConstantsFromDB overlays
 * pricing_config over constants), so the constants.js changes in this PR are
 * inert in prod without these row updates:
 *
 *  1. NEW pricing_config row `rodent_bait_brackets` — footprint-bracket
 *     QUARTERLY per-visit pricing ($79–$129, up-to-N station allowance,
 *     ladder extends +1 station/+$10 per 1,000 sf above 6,750).
 *  2. `rodent_waveguard` → tier_qualifier TRUE, exclude_from_pct_discount
 *     FALSE (full WaveGuard membership; db-bridge now syncs the WAVEGUARD
 *     maps from this row, so the old values would revert the code default).
 *  3. `rodent_setup_fee` → $99, non-WaveGuard members only.
 *  4. RETIRE rows `rodent_monthly` and `rodent_post_exclusion` — db-bridge
 *     no longer reads them (the constants they overlaid are gone) and the
 *     admin panel must not offer dead knobs.
 *  5. Catalog `services.rodent_bait_setup` base_price 199 → 99 with the
 *     member-waiver copy.
 *
 * Existing customers' plan rates are snapshotted at accept and are NOT
 * touched — this changes new quotes/estimates only.
 */
const MIGRATION_TAG = 'migration:20260829000040';
const UP_REASON = 'Rodent bait bracket realignment + WaveGuard membership (owner directive 2026-08-29)';
const DOWN_REASON = 'Rollback: restore score-based rodent bait pricing rows (20260829000040)';

const BRACKETS_DATA = {
  brackets: [
    { max_sq_ft: 1750, stations: 4, per_visit: 79 },
    { max_sq_ft: 2750, stations: 5, per_visit: 89 },
    { max_sq_ft: 3750, stations: 6, per_visit: 99 },
    { max_sq_ft: 4750, stations: 7, per_visit: 109 },
    { max_sq_ft: 5750, stations: 8, per_visit: 119 },
    { max_sq_ft: 6750, stations: 9, per_visit: 129 },
  ],
  extension: { per_sq_ft: 1000, stations_per_step: 1, per_visit_per_step: 10 },
  visits_per_year: 4,
  note: 'Owner directive 2026-08-29: billed per application; ladder extends above 6,750 sf; same brackets for commercial',
};

const CHANGELOG_IDENTITY = {
  version_from: 'v4.7',
  version_to: 'v4.8',
  changed_by: 'claude-2026-08-29',
  category: 'rule',
  summary: 'Rodent bait: footprint-bracket quarterly pricing, WaveGuard membership, $99 non-member setup fee.',
};

function parseData(row) {
  if (!row) return null;
  try {
    return typeof row.data === 'string' ? JSON.parse(row.data) : (row.data || {});
  } catch {
    return {};
  }
}

async function audit(knex, configKey, oldValue, newValue, reason) {
  if (!(await knex.schema.hasTable('pricing_config_audit'))) return;
  await knex('pricing_config_audit').insert({
    config_key: configKey,
    old_value: oldValue == null ? null : JSON.stringify(oldValue),
    new_value: newValue == null ? null : JSON.stringify(newValue),
    changed_by: MIGRATION_TAG,
    reason,
  });
}

async function updateRow(knex, configKey, mutate, reason) {
  const row = await knex('pricing_config').where({ config_key: configKey }).first();
  if (!row) return;
  const oldData = parseData(row);
  const newData = mutate({ ...oldData });
  if (JSON.stringify(newData) === JSON.stringify(oldData)) return;
  await knex('pricing_config')
    .where({ config_key: configKey })
    .update({ data: JSON.stringify(newData), updated_at: knex.fn.now() });
  await audit(knex, configKey, oldData, newData, reason);
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('pricing_config'))) return;

  // 1. Bracket row — insert only when absent (an admin-authored row wins).
  const existingBrackets = await knex('pricing_config')
    .where({ config_key: 'rodent_bait_brackets' }).first();
  if (!existingBrackets) {
    await knex('pricing_config').insert({
      config_key: 'rodent_bait_brackets',
      name: 'Rodent Bait Footprint Brackets (per quarterly visit)',
      category: 'rodent',
      sort_order: 1,
      data: JSON.stringify(BRACKETS_DATA),
    });
    await audit(knex, 'rodent_bait_brackets', null, BRACKETS_DATA, UP_REASON);
  }

  // 2. WaveGuard membership flags — preserve any other keys on the row.
  //    Prod pre-read 2026-08-29: the row does NOT exist in prod (only the
  //    admin seed path ever wrote it in fresh envs), so an update-only
  //    branch would silently no-op and leave the admin panel without the
  //    knob — insert it when absent.
  const waveguardRow = await knex('pricing_config').where({ config_key: 'rodent_waveguard' }).first();
  if (waveguardRow) {
    await updateRow(knex, 'rodent_waveguard', (data) => ({
      ...data,
      tier_qualifier: true,
      exclude_from_pct_discount: false,
      note: 'Owner directive 2026-08-29: rodent bait is a full WaveGuard member — counts toward the tier and receives the tier discount.',
    }), UP_REASON);
  } else {
    const waveguardData = {
      tier_qualifier: true,
      exclude_from_pct_discount: false,
      setup_credit: 0,
      note: 'Owner directive 2026-08-29: rodent bait is a full WaveGuard member — counts toward the tier and receives the tier discount.',
    };
    await knex('pricing_config').insert({
      config_key: 'rodent_waveguard',
      name: 'Rodent WaveGuard Rules',
      category: 'rodent',
      sort_order: 10,
      data: JSON.stringify(waveguardData),
    });
    await audit(knex, 'rodent_waveguard', null, waveguardData, UP_REASON);
  }

  // 3. Setup fee $99, non-members only.
  await updateRow(knex, 'rodent_setup_fee', (data) => {
    const next = {
      ...data,
      value: 99,
      note: 'Owner directive 2026-08-29: charged only when the customer has no other WaveGuard qualifying recurring service',
    };
    delete next.waived_with_recurring;
    return next;
  }, UP_REASON);

  // 4. Retire the dead knobs (audit rows keep the old values recoverable).
  for (const configKey of ['rodent_monthly', 'rodent_post_exclusion']) {
    const row = await knex('pricing_config').where({ config_key: configKey }).first();
    if (!row) continue;
    await audit(knex, configKey, parseData(row), null, UP_REASON);
    await knex('pricing_config').where({ config_key: configKey }).del();
  }

  // 5. Catalog setup-fee service row.
  if (await knex.schema.hasTable('services')) {
    await knex('services')
      .where({ service_key: 'rodent_bait_setup' })
      .update({
        base_price: 99.0,
        description: 'One-time inspection, station hardware, placement, and mapping. Charged only for non-WaveGuard members — waived when the customer has any other WaveGuard recurring service.',
        internal_notes: 'Owner directive 2026-08-29: $99, non-WaveGuard members only (no other qualifying recurring service on the estimate or account).',
        updated_at: knex.fn.now(),
      });
  }

  if (await knex.schema.hasTable('pricing_changelog')) {
    const existing = await knex('pricing_changelog').where(CHANGELOG_IDENTITY).first('id');
    if (!existing) {
      await knex('pricing_changelog').insert({
        ...CHANGELOG_IDENTITY,
        affected_services: JSON.stringify(['rodent_bait', 'commercial_rodent_bait', 'rodent_bait_setup']),
        before_value: JSON.stringify({ bait_monthly: { small: 49, medium: 59, large: 69 }, setup_fee: 199, post_exclusion: { multiplier: 0.72, floor_monthly: 39 }, waveguard: { tier_qualifier: false, exclude_from_pct_discount: true } }),
        after_value: JSON.stringify({ ...BRACKETS_DATA, setup_fee_non_members: 99, waveguard: { tier_qualifier: true, exclude_from_pct_discount: false } }),
        rationale: 'Owner directive 2026-08-29: rodent bait moves to footprint-bracket per-quarterly-visit pricing ($79–$129 with station allowances, ladder extends above 6,750 sf, commercial identical), joins WaveGuard (tier-counted + tier-discounted), post-exclusion modifier retired, setup fee $99 for non-members only. Existing plan rates are snapshotted and unaffected.',
      });
    }
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('pricing_config'))) return;
  if (!(await knex.schema.hasTable('pricing_config_audit'))) return;
  const ownUp = await knex('pricing_config_audit')
    .where({ changed_by: MIGRATION_TAG, reason: UP_REASON })
    .first('id');
  if (!ownUp) return;

  // Restore retired rows from their audit snapshots.
  for (const configKey of ['rodent_monthly', 'rodent_post_exclusion']) {
    const auditRow = await knex('pricing_config_audit')
      .where({ config_key: configKey, changed_by: MIGRATION_TAG, reason: UP_REASON })
      .orderBy('id', 'desc')
      .first();
    if (!auditRow || !auditRow.old_value) continue;
    const exists = await knex('pricing_config').where({ config_key: configKey }).first('id');
    if (exists) continue;
    await knex('pricing_config').insert({
      config_key: configKey,
      name: configKey === 'rodent_monthly'
        ? 'Rodent Bait Monthly Tiers (quarterly visits, billed monthly)'
        : 'Rodent Bait Post-Exclusion Modifier',
      category: 'rodent',
      sort_order: configKey === 'rodent_monthly' ? 1 : 3,
      data: auditRow.old_value,
    });
    await audit(knex, configKey, null, JSON.parse(auditRow.old_value), DOWN_REASON);
  }

  // Remove the bracket row only if this migration created it.
  const bracketAudit = await knex('pricing_config_audit')
    .where({ config_key: 'rodent_bait_brackets', changed_by: MIGRATION_TAG, reason: UP_REASON })
    .first('id');
  if (bracketAudit) {
    await knex('pricing_config').where({ config_key: 'rodent_bait_brackets' }).del();
    await audit(knex, 'rodent_bait_brackets', BRACKETS_DATA, null, DOWN_REASON);
  }

  // Restore waveguard/setup rows from their audit snapshots. A null
  // old_value means up() INSERTED the row (prod had none) — rollback
  // deletes it instead of restoring.
  for (const configKey of ['rodent_waveguard', 'rodent_setup_fee']) {
    const auditRow = await knex('pricing_config_audit')
      .where({ config_key: configKey, changed_by: MIGRATION_TAG, reason: UP_REASON })
      .orderBy('id', 'desc')
      .first();
    if (!auditRow) continue;
    if (!auditRow.old_value) {
      await knex('pricing_config').where({ config_key: configKey }).del();
      await audit(knex, configKey, JSON.parse(auditRow.new_value || 'null'), null, DOWN_REASON);
      continue;
    }
    await knex('pricing_config')
      .where({ config_key: configKey })
      .update({ data: auditRow.old_value, updated_at: knex.fn.now() });
    await audit(knex, configKey, JSON.parse(auditRow.new_value || 'null'), JSON.parse(auditRow.old_value), DOWN_REASON);
  }

  if (await knex.schema.hasTable('services')) {
    await knex('services')
      .where({ service_key: 'rodent_bait_setup' })
      .update({
        base_price: 199.0,
        description: 'One-time inspection, station hardware, placement, and mapping. Waived in standard recurring sign-up flow.',
        internal_notes: 'Waived when bait service is added alongside any recurring plan. Only invoices for the rare non-recurring case.',
        updated_at: knex.fn.now(),
      });
  }

  if (await knex.schema.hasTable('pricing_changelog')) {
    await knex('pricing_changelog').where(CHANGELOG_IDENTITY).del();
  }
};
