/**
 * Lawn protocol v13 count caps (Codex round 8 on #6104): every v13-only count cap lives behind the
 * GATE_LAWN_V13 kill switch, as Celsius's already does (20261007172000).
 *
 * 20261007170000 inserted a stored annual_max_apps row of 2 for Arena 50 WDG, Certainty Turf
 * Herbicide and Blindside Herbicide. A stored product_limits row is read with the gate OFF too, so
 * those three caps applied to pre-v13 behavior. The caps now live in code
 * (server/config/lawn-v13-count-caps.js): applied only while the gate is on, as a synthetic
 * hard_block limit because no row is stored for them.
 *
 * What this writes: it DELETES the three rows 170000 inserted, matched on every field including the
 * description 171000 left on them (exact equality). A row an admin edited, or one a product has
 * from somewhere else, is left alone and logged. Each deleted row is recorded in
 * lawn_protocol_audit_log with its full column set, so down() can re-insert it exactly. Celsius is
 * not touched here (172000 restored its legacy 3; the gate lowers it to 2).
 *
 * down(): re-inserts each recorded row exactly, only while its product has no annual_max_apps row,
 * and spends the audit row. Idempotent.
 */
const crypto = require('crypto');
const wording = require('./20261007171000_lawn_v13_count_caps_wording');

const ACTION = 'v13_count_caps_row_removed';
const PRODUCTS = ['Arena 50 WDG', 'Certainty Turf Herbicide', 'Blindside Herbicide'];
const WRITTEN = { match_type: 'product', limit_type: 'annual_max_apps', limit_value: 2, limit_unit: 'applications', severity: 'hard_block' };
// The descriptions 171000 left on those rows.
const WRITTEN_DESCRIPTIONS = wording.REWORDS.map((reword) => reword.to).filter((text) => PRODUCTS.some((name) => text.startsWith(`${name}:`)));

const hasTables = async (knex) => (await knex.schema.hasTable('product_limits')) && (await knex.schema.hasTable('lawn_protocol_audit_log'));
const parse = (value) => (typeof value === 'string' ? JSON.parse(value) : value);

exports.up = async function up(knex) {
  if (!(await hasTables(knex))) return;
  const rows = await knex('product_limits').whereNotNull('product_id').where(WRITTEN).whereIn('description', WRITTEN_DESCRIPTIONS);
  for (const row of rows) {
    const deleted = await knex('product_limits').where({ id: row.id, ...WRITTEN, description: row.description }).del();
    if (!deleted) continue;
    await knex('lawn_protocol_audit_log').insert({
      lawn_protocol_id: null,
      actor_name: 'migration 20261007174000',
      entity_type: 'catalog',
      entity_id: crypto.randomUUID(),
      action: ACTION,
      changed_fields: JSON.stringify(['product_limits']),
      before_snapshot: JSON.stringify({ row }),
      after_snapshot: JSON.stringify({ deleted: row.id }),
      metadata: JSON.stringify({ migration: '20261007174000_lawn_v13_count_caps_v13_only' }),
    });
  }
  // Rows of those products that this migration does not own are never touched; say so.
  const names = await knex('products_catalog').whereIn('name', PRODUCTS).select('id', 'name');
  for (const product of names) {
    const left = await knex('product_limits').where({ product_id: product.id, limit_type: 'annual_max_apps' }).select('limit_value', 'severity');
    if (left.length) console.log(`[lawn-v13-count-caps-v13-only] ${product.name} keeps its stored annual_max_apps row (${left.map((r) => `${Number(r.limit_value)} ${r.severity}`).join('; ')}); not ours, left as is`);
  }
};

exports.down = async function down(knex) {
  if (!(await hasTables(knex))) return;
  for (const audit of await knex('lawn_protocol_audit_log').where({ action: ACTION })) {
    const { row } = parse(audit.before_snapshot);
    const taken = await knex('product_limits').where({ product_id: row.product_id, limit_type: 'annual_max_apps' }).first('id');
    if (!taken) await knex('product_limits').insert(row);
    await knex('lawn_protocol_audit_log').where({ id: audit.id }).del();
  }
};

exports.WRITTEN_DESCRIPTIONS = WRITTEN_DESCRIPTIONS;
