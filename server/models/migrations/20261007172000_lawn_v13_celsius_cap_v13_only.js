/**
 * Lawn protocol v13 count caps (Codex round 6 on #6104): keep the persisted Celsius cap behind the
 * v13 gate.
 *
 * 20261007170000 lowered the global Celsius WG annual_max_apps row from the compliance seed's 3 to
 * 2, and 20261007171000 reworded it. A product_limits row is read with GATE_LAWN_V13 OFF too (the
 * pre-visit brief, the compliance pages), so the lower number changed pre-v13 behavior. The v13
 * cap of 2 now lives in code (server/config/lawn-v13-count-caps.js), applied only while the gate
 * is on, and the stored row is the legacy 3 again.
 *
 * What this writes: the Celsius row goes back to the EXACT 20260401000020 seed values and
 * description, and only while it still holds what 170000 / 171000 wrote (value 2, unit, severity
 * and one of the two descriptions those migrations wrote). Anything else is an admin edit and is
 * left alone. Each restored row is recorded in lawn_protocol_audit_log (the row id and the values
 * it held before). Arena, Certainty and Blindside rows are new caps with no legacy value: untouched.
 *
 * down() puts back the recorded 2 + description only for a row that still equals the seed exactly,
 * and removes the audit row it used. Idempotent.
 */
const crypto = require('crypto');
const caps = require('./20261007170000_lawn_v13_count_caps');
const wording = require('./20261007171000_lawn_v13_count_caps_wording');

const ACTION = 'v13_celsius_cap_restore';
const SEED = caps.CELSIUS_SEED;
const FIELDS = ['match_type', 'limit_type', 'limit_value', 'limit_unit', 'severity', 'description'];

// The descriptions 171000 left on a Celsius row: the lowered seed row and the inserted one.
const WRITTEN_DESCRIPTIONS = wording.REWORDS
  .filter((reword) => /^Celsius WG/.test(reword.to))
  .map((reword) => reword.to);
const WRITTEN = { match_type: 'product', limit_type: 'annual_max_apps', limit_value: 2, limit_unit: 'applications', severity: 'hard_block' };

const hasTables = async (knex) => (await knex.schema.hasTable('product_limits')) && (await knex.schema.hasTable('lawn_protocol_audit_log'));

exports.up = async function up(knex) {
  if (!(await hasTables(knex))) return;
  const rows = await knex('product_limits').whereNotNull('product_id').where(WRITTEN).whereIn('description', WRITTEN_DESCRIPTIONS);
  for (const row of rows) {
    const updated = await knex('product_limits').where({ id: row.id, ...WRITTEN, description: row.description })
      .update({ limit_value: SEED.limit_value, description: SEED.description, updated_at: knex.fn.now() });
    if (!updated) continue;
    await knex('lawn_protocol_audit_log').insert({
      lawn_protocol_id: null,
      actor_name: 'migration 20261007172000',
      entity_type: 'catalog',
      entity_id: crypto.randomUUID(),
      action: ACTION,
      changed_fields: JSON.stringify(['limit_value', 'description']),
      before_snapshot: JSON.stringify({ limitId: row.id, limit_value: Number(row.limit_value), description: row.description }),
      after_snapshot: JSON.stringify({ limitId: row.id, limit_value: SEED.limit_value, description: SEED.description }),
      metadata: JSON.stringify({ migration: '20261007172000_lawn_v13_celsius_cap_v13_only' }),
    });
  }
};

exports.down = async function down(knex) {
  if (!(await hasTables(knex))) return;
  const audits = await knex('lawn_protocol_audit_log').where({ action: ACTION });
  for (const audit of audits) {
    const before = typeof audit.before_snapshot === 'string' ? JSON.parse(audit.before_snapshot) : audit.before_snapshot;
    await knex('product_limits')
      .where({ id: before.limitId, ...Object.fromEntries(FIELDS.map((field) => [field, SEED[field]])) })
      .update({ limit_value: before.limit_value, description: before.description, updated_at: knex.fn.now() });
    // A row someone changed since keeps its value; the audit row is spent either way.
    await knex('lawn_protocol_audit_log').where({ id: audit.id }).del();
  }
};

exports.WRITTEN_DESCRIPTIONS = WRITTEN_DESCRIPTIONS;
