/**
 * Lawn minimum per visit AFTER discounts (owner 2026-11-06).
 *
 * Lawn pricing is DB-authoritative: db-bridge.syncConstantsFromDB deepMerges
 * `pricing_config.lawn_pricing_v2` over constants.LAWN_PRICING_V2. This
 * read-modify-write
 *   - adds minimumPerVisitAfterDiscount: 55 — a residential recurring lawn
 *     customer pays at least $55 an application after the WaveGuard tier %
 *     and a typed discount (percent or dollar); the crossed-out list price is raised so
 *     the full discount still shows (estimate-engine
 *     raiseLawnListForMinimumAfterDiscount);
 *   - retires the cost-plus list-side minimum (costPlusList.minimumPerVisit
 *     55 → 0). Cost-plus pricing is off; cost bases stamped on saved quotes
 *     keep their own value, so nothing already sent moves.
 * The engine reads the minimum only while GATE_LAWN_MIN_AFTER_DISCOUNT is on,
 * so this row edit changes no price by itself.
 * Only an untouched seeded value is changed; admin edits are left alone.
 * Saved quotes replay with the stamped pricingMetadata value (0 when the
 * quote predates this rule), so only new quotes price with it.
 */
const MIGRATION_TAG = 'migration:20261106150000';
const UP_REASON = 'Lawn $55 minimum per visit after discounts; retire cost-plus list-side minimum (owner 2026-11-06)';
const MINIMUM = 55;
const RETIRED_COST_PLUS_MINIMUM = 55;
const CHANGELOG_IDENTITY = {
  // pricing_changelog.version_from/to are varchar(10).
  version_from: 'v4.6',
  version_to: 'v4.6',
  changed_by: 'claude-2026-11-06',
  category: 'rule',
  summary: 'Lawn: $55 a visit minimum after discounts; list price raised so the full discount shows.',
};

async function loadRow(knex) {
  if (!(await knex.schema.hasTable('pricing_config'))) return null;
  const row = await knex('pricing_config').where({ config_key: 'lawn_pricing_v2' }).forUpdate().first();
  if (!row) return null;
  const data = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
  if (!data || typeof data !== 'object') return null;
  return { row, data };
}

async function saveRow(knex, oldData, newData, reason) {
  await knex('pricing_config')
    .where({ config_key: 'lawn_pricing_v2' })
    .update({ data: JSON.stringify(newData), updated_at: knex.fn.now() });
  if (await knex.schema.hasTable('pricing_config_audit')) {
    await knex('pricing_config_audit').insert({
      config_key: 'lawn_pricing_v2',
      old_value: JSON.stringify(oldData),
      new_value: JSON.stringify(newData),
      changed_by: MIGRATION_TAG,
      reason,
    });
  }
}

exports.up = async function (knex) {
  const loaded = await loadRow(knex);
  // No row: a fresh env prices from the in-code defaults (55 / 0).
  if (!loaded) return;
  const { data } = loaded;
  const newData = JSON.parse(JSON.stringify(data));
  let changed = false;
  if (newData.minimumPerVisitAfterDiscount === undefined) {
    newData.minimumPerVisitAfterDiscount = MINIMUM;
    changed = true;
  }
  const cp = newData.costPlusList;
  if (cp && typeof cp === 'object' && !Array.isArray(cp) && Number(cp.minimumPerVisit) === RETIRED_COST_PLUS_MINIMUM) {
    cp.minimumPerVisit = 0;
    changed = true;
  }
  if (!changed) return;
  await saveRow(knex, data, newData, UP_REASON);

  if (await knex.schema.hasTable('pricing_changelog')) {
    const existing = await knex('pricing_changelog').where(CHANGELOG_IDENTITY).first('id');
    if (!existing) {
      await knex('pricing_changelog').insert({
        ...CHANGELOG_IDENTITY,
        affected_services: JSON.stringify(['lawn_care']),
        before_value: JSON.stringify({ minimumPerVisitAfterDiscount: null, costPlusListMinimumPerVisit: RETIRED_COST_PLUS_MINIMUM }),
        after_value: JSON.stringify({ minimumPerVisitAfterDiscount: MINIMUM, costPlusListMinimumPerVisit: 0 }),
        rationale: 'Owner 2026-11-06: residential recurring lawn (every 6 weeks and monthly) never collects under $55 an application after WaveGuard and typed (percent or dollar) discounts. The list price is raised to $55 / (1 - discount), so Silver shows $61.11 crossed out and $55.00 paid. New quotes only: saved quotes replay with their stamped value. The cost-plus list-side $55 minimum is retired.',
      });
    }
  }
};

exports.down = async function (knex) {
  // Only undo what this migration's up() wrote (keyed off its audit row).
  if (!(await knex.schema.hasTable('pricing_config_audit'))) return;
  const ownUp = await knex('pricing_config_audit')
    .where({ config_key: 'lawn_pricing_v2', changed_by: MIGRATION_TAG, reason: UP_REASON })
    .first('id', 'old_value');
  if (!ownUp) return;
  const before = typeof ownUp.old_value === 'string' ? JSON.parse(ownUp.old_value) : (ownUp.old_value || {});

  const loaded = await loadRow(knex);
  if (loaded) {
    const { data } = loaded;
    const newData = JSON.parse(JSON.stringify(data));
    let changed = false;
    // Remove the key only while it still holds the seeded value.
    if (before.minimumPerVisitAfterDiscount === undefined && Number(newData.minimumPerVisitAfterDiscount) === MINIMUM) {
      delete newData.minimumPerVisitAfterDiscount;
      changed = true;
    }
    const cp = newData.costPlusList;
    if (Number(before.costPlusList?.minimumPerVisit) === RETIRED_COST_PLUS_MINIMUM
      && cp && typeof cp === 'object' && Number(cp.minimumPerVisit) === 0) {
      cp.minimumPerVisit = RETIRED_COST_PLUS_MINIMUM;
      changed = true;
    }
    if (changed) await saveRow(knex, data, newData, 'Rollback: lawn minimum per visit after discounts');
  }
  if (await knex.schema.hasTable('pricing_changelog')) {
    await knex('pricing_changelog').where(CHANGELOG_IDENTITY).del();
  }
};
