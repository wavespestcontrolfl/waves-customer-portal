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

async function loadBreakpoints(knex) {
  if (!(await knex.schema.hasTable('pricing_config'))) return null;
  const row = await knex('pricing_config').where({ config_key: 'pest_footprint' }).first();
  if (!row) return null;
  const data = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
  if (!Array.isArray(data?.breakpoints)) return null;
  return { row, data };
}

async function saveBreakpoints(knex, row, oldData, breakpoints, reason) {
  const newData = { ...oldData, breakpoints };
  await knex('pricing_config')
    .where({ config_key: 'pest_footprint' })
    .update({ data: JSON.stringify(newData), updated_at: knex.fn.now() });
  if (await knex.schema.hasTable('pricing_config_audit')) {
    await knex('pricing_config_audit').insert({
      config_key: 'pest_footprint',
      old_value: JSON.stringify(oldData),
      new_value: JSON.stringify(newData),
      changed_by: 'migration:20260611000003',
      reason,
    });
  }
}

exports.up = async function (knex) {
  const loaded = await loadBreakpoints(knex);
  if (!loaded) return;
  const { row, data } = loaded;
  if (data.breakpoints.some((bp) => Number(bp?.sqft) === BRACKET_SQFT)) return;
  const breakpoints = [...data.breakpoints, { sqft: BRACKET_SQFT, adj: BRACKET_ADJ }]
    .sort((a, b) => Number(a.sqft) - Number(b.sqft));
  await saveBreakpoints(
    knex, row, data, breakpoints,
    'Flat -$5 footprint bracket extended to 1750 sqft (owner decision; PR #1576)'
  );
};

exports.down = async function (knex) {
  const loaded = await loadBreakpoints(knex);
  if (!loaded) return;
  const { row, data } = loaded;
  const breakpoints = data.breakpoints.filter((bp) => Number(bp?.sqft) !== BRACKET_SQFT);
  if (breakpoints.length === data.breakpoints.length) return;
  await saveBreakpoints(
    knex, row, data, breakpoints,
    'Rollback: remove 1750 sqft pest footprint bracket (PR #1576)'
  );
};
