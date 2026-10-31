/**
 * Lawn protocol v13, the 9x rounds plan's round 3 (owner 2026-10-29: "raise to 1.0").
 *
 * Round 3 of the 9x rounds calendar (Mar 15 to Apr 23) runs February's step: LESCO 24-0-11 with PolyPlus OPTI. The 12x plan and the
 * old 9x plan keep February's 0.75 lb N (3.1 lb of the bag per 1,000 sq ft). A rounds visit takes 1.0 lb N (4.17 lb of the bag). The
 * recipe file (lawn-protocol-v13.json, roundVariants.lawn_rounds_9 on the February step) carries the line and the N rate the plan
 * reads from the visit notes; the staged February row has no rate of its own (rate unit lb_n, derived from that target), so the only
 * stored figure to mirror is the target the pocket brief prints: the row's gates.targetN, "0.75 lb N/1000".
 *
 * This migration gives that row one more gate key, `roundsTargetN` "1.0 lb N/1000". Nothing else changes: `targetN` stays 0.75 for
 * the 12x plan and the old 9x plan, no rate, no product, no window, no other row. The brief states roundsTargetN for a rounds
 * round-3 visit only (previsit-brief.js statedRoundsNitrogen).
 *
 * Insert-only in spirit and idempotent: a row that already carries the key is left as it is. down() removes the key only from a row
 * that still holds the value written here.
 */

const V13_VERSION = '2026.10-v13';
const WINDOW_KEY = 'feb_v13_spreader_green_up';
const PRODUCT = 'LESCO 24-0-11 with PolyPlus OPTI';
const KEY = 'roundsTargetN';
const VALUE = '1.0 lb N/1000';

const parse = (value) => {
  if (typeof value !== 'string') return value && typeof value === 'object' ? value : {};
  try { return JSON.parse(value) || {}; } catch { return {}; }
};

const hasTables = async (knex) => (await Promise.all(['lawn_protocols', 'lawn_protocol_windows', 'lawn_protocol_products']
  .map((table) => knex.schema.hasTable(table)))).every(Boolean);

// The February nitrogen row of every staged v13 protocol (one per grass track).
function februaryRows(knex) {
  return knex('lawn_protocol_products as p')
    .join('lawn_protocol_windows as w', 'p.lawn_protocol_window_id', 'w.id')
    .join('lawn_protocols as l', 'w.lawn_protocol_id', 'l.id')
    .where('l.version', V13_VERSION)
    .where('w.window_key', WINDOW_KEY)
    .where('p.product_name', PRODUCT)
    .select('p.id', 'p.gates');
}

exports.up = async function up(knex) {
  if (!(await hasTables(knex)) || !(await knex.schema.hasColumn('lawn_protocol_products', 'gates'))) return;
  for (const row of await februaryRows(knex)) {
    const gates = parse(row.gates);
    // Only the row that states a target: a row without one is not the nitrogen row. A key it already has is never overwritten.
    if (!gates.targetN || KEY in gates) continue;
    await knex('lawn_protocol_products').where({ id: row.id }).update({ gates: JSON.stringify({ ...gates, [KEY]: VALUE }), updated_at: knex.fn.now() });
  }
};

exports.down = async function down(knex) {
  if (!(await hasTables(knex)) || !(await knex.schema.hasColumn('lawn_protocol_products', 'gates'))) return;
  for (const row of await februaryRows(knex)) {
    const gates = parse(row.gates);
    if (gates[KEY] !== VALUE) continue;
    const rest = { ...gates };
    delete rest[KEY];
    await knex('lawn_protocol_products').where({ id: row.id }).update({ gates: JSON.stringify(rest), updated_at: knex.fn.now() });
  }
};

exports.V13_VERSION = V13_VERSION;
exports.WINDOW_KEY = WINDOW_KEY;
exports.KEY = KEY;
exports.VALUE = VALUE;
