// ============================================================
// Migration: Align pricing_config.zone_multipliers with
// constants.ZONES / modifiers.zoneMultiplier.
//
// Session 3 of v4.3 pricing engine build. Before this migration,
// the DB row (C=1.10, no D) actively overwrote the in-code values
// at runtime via db-bridge.syncConstantsFromDB — so a Charlotte
// County quote went out at 1.10x on any path that triggered sync,
// not the 1.12x that modifiers.js intended.
//
// After this migration:
//   A=1.00, B=1.05, C=1.12, D=1.20, UNKNOWN=1.05
// matching constants.ZONES and modifiers.zoneMultiplier exactly.
// ============================================================
exports.up = async function (knex) {
  const row = await knex('pricing_config').where({ config_key: 'zone_multipliers' }).first();
  if (!row) return; // row doesn't exist — nothing to align
  const data = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
  data.C = { name: 'Charlotte outskirts', multiplier: 1.12 };
  data.D = { name: 'Far reach', multiplier: 1.20 };
  await knex('pricing_config')
    .where({ config_key: 'zone_multipliers' })
    .update({ data: JSON.stringify(data), updated_at: knex.fn.now() });
};

exports.down = async function (knex) {
  const row = await knex('pricing_config').where({ config_key: 'zone_multipliers' }).first();
  if (!row) return;
  const data = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
  data.C = { name: 'Charlotte outskirts', multiplier: 1.10 };
  delete data.D;
  await knex('pricing_config')
    .where({ config_key: 'zone_multipliers' })
    .update({ data: JSON.stringify(data), updated_at: knex.fn.now() });
};
