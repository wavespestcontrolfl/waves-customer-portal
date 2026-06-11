/**
 * Extend the flat -$5 pest footprint bracket to 1750 sqft.
 *
 * Pest footprint pricing is DB-authoritative: db-bridge.syncConstantsFromDB
 * loads `pricing_config.pest_footprint` over the in-code constants, so the
 * constants.js change in this PR is inert in any env carrying the row unless
 * the DB is updated too. Inserts `{ sqft: 1750, adj: -5 }` into the existing
 * breakpoints (preserving any admin edits to the other points) so homes
 * between 1500 and 1750 sqft get the full -$5 instead of interpolating
 * toward $0 at 2000.
 */
const BRACKET_SQFT = 1750;
const BRACKET_ADJ = -5;
const MIGRATION_TAG = 'migration:20260611000003';
const UP_REASON = 'Flat -$5 footprint bracket extended to 1750 sqft (owner decision; PR #1576)';
const CHANGELOG_IDENTITY = {
  version_from: 'v4.3',
  version_to: 'v4.3',
  changed_by: 'claude-2026-06-11',
  category: 'rule',
  summary: 'Extend flat -$5 pest footprint bracket to 1750 sqft.',
};

async function loadBreakpoints(knex) {
  if (!(await knex.schema.hasTable('pricing_config'))) return null;
  const row = await knex('pricing_config').where({ config_key: 'pest_footprint' }).first();
  if (!row) return null;
  const data = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
  if (!Array.isArray(data?.breakpoints)) return null;
  return { row, data };
}

async function saveBreakpoints(knex, oldData, breakpoints, reason) {
  const newData = { ...oldData, breakpoints };
  await knex('pricing_config')
    .where({ config_key: 'pest_footprint' })
    .update({ data: JSON.stringify(newData), updated_at: knex.fn.now() });
  if (await knex.schema.hasTable('pricing_config_audit')) {
    await knex('pricing_config_audit').insert({
      config_key: 'pest_footprint',
      old_value: JSON.stringify(oldData),
      new_value: JSON.stringify(newData),
      changed_by: MIGRATION_TAG,
      reason,
    });
  }
}

exports.up = async function (knex) {
  const loaded = await loadBreakpoints(knex);
  if (!loaded) return;
  const { data } = loaded;
  // A 1750 breakpoint already present (e.g. prior admin edit) is left alone;
  // down() keys off the audit row this branch skips writing.
  if (data.breakpoints.some((bp) => Number(bp?.sqft) === BRACKET_SQFT)) return;
  const breakpoints = [...data.breakpoints, { sqft: BRACKET_SQFT, adj: BRACKET_ADJ }]
    .sort((a, b) => Number(a.sqft) - Number(b.sqft));
  await saveBreakpoints(knex, data, breakpoints, UP_REASON);

  // Record the intentional pricing/baseline change (regression baselines for
  // zone_d recaptured in the same PR).
  if (await knex.schema.hasTable('pricing_changelog')) {
    const existing = await knex('pricing_changelog').where(CHANGELOG_IDENTITY).first('id');
    if (!existing) {
      await knex('pricing_changelog').insert({
        ...CHANGELOG_IDENTITY,
        affected_services: JSON.stringify(['pest_control']),
        before_value: JSON.stringify({ pest_footprint_breakpoints: data.breakpoints }),
        after_value: JSON.stringify({ pest_footprint_breakpoints: breakpoints }),
        rationale: 'Owner decision: homes under 1750 sqft get the full small-footprint -$5 instead of interpolating toward $0 at 2000 (a 1635 sqft home moves -$4 -> -$5, $113 -> $112/application at quarterly). 1750-2000 now ramps -5 -> 0; brackets below 1500 and above 2000 unchanged. zone_d regression baseline (1800 sqft, adj -2 -> -4) recaptured in PR #1576.',
      });
    }
  }
};

exports.down = async function (knex) {
  // Only remove the breakpoint if this migration's up() created it — keyed
  // off the audit row — so a pre-existing admin-added 1750 bracket survives
  // rollback. No audit table means no proof of ownership; leave data alone.
  if (!(await knex.schema.hasTable('pricing_config_audit'))) return;
  const ownUp = await knex('pricing_config_audit')
    .where({ config_key: 'pest_footprint', changed_by: MIGRATION_TAG, reason: UP_REASON })
    .first('id');
  if (!ownUp) return;

  const loaded = await loadBreakpoints(knex);
  if (loaded) {
    const { data } = loaded;
    const breakpoints = data.breakpoints.filter((bp) => Number(bp?.sqft) !== BRACKET_SQFT);
    if (breakpoints.length !== data.breakpoints.length) {
      await saveBreakpoints(
        knex, data, breakpoints,
        'Rollback: remove 1750 sqft pest footprint bracket (PR #1576)'
      );
    }
  }
  if (await knex.schema.hasTable('pricing_changelog')) {
    await knex('pricing_changelog').where(CHANGELOG_IDENTITY).del();
  }
};
