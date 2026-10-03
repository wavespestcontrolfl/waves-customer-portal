/**
 * St. Augustine October fungicide: Medallion SC replaces Velista in the
 * structured operating layer (owner 2026-10-03).
 *
 * Torque SC left the residential program (EPA Reg. No. 1001-87: "for use on
 * golf course turf only"), and the owner chose Medallion SC (FRAC 12) for the
 * October slot over Velista on cost. protocols.json changes in the same commit
 * (AGENTS.md lawn protocol data fan-out), and this brings the second source of
 * truth with it: buildLawnCompletionDefaults keeps only JSON plan products that
 * are registered in lawn_protocol_products, so a JSON-only Medallion line would
 * drop out of technician defaults.
 *
 * The October window (oct_recovery_fall_pre_m) of the ACTIVE St. Augustine
 * protocol carries one conditional fungicide row, seeded as Velista 0.50 oz on
 * large patch history. That row becomes Medallion SC 1 fl oz (the catalog
 * default rate, which the mix math reads), still conditional on large patch
 * history and still out of the default plan. Only a row still in the seeded
 * Velista shape is rewritten; an edited row is left alone and Medallion is
 * added beside it. Idempotent.
 */
const MIGRATION = '20261003120000_st_augustine_october_fungicide_medallion';
const WINDOW_KEY = 'oct_recovery_fall_pre_m';
const MEDALLION = 'Medallion SC';
const VELISTA = 'Velista';

const MEDALLION_GATES = { frac: '12', trigger: 'large_patch_history', seededBy: MIGRATION };
const VELISTA_GATES = { frac: '7', trigger: 'large_patch_history' };

exports.MIGRATION = MIGRATION;
exports.WINDOW_KEY = WINDOW_KEY;
exports.MEDALLION_GATES = MEDALLION_GATES;

function parseJson(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === 'object') return Array.isArray(value) ? [...value] : { ...value };
  try { return JSON.parse(value); } catch (e) { return fallback; }
}

async function octoberWindow(knex) {
  if (!(await knex.schema.hasTable('lawn_protocol_products'))) return null;
  const protocol = await knex('lawn_protocols')
    .where({ grass_track: 'st_augustine', status: 'active' })
    .orderBy('effective_from', 'desc')
    .orderBy('created_at', 'desc')
    .first();
  if (!protocol) return null;
  const window = await knex('lawn_protocol_windows')
    .where({ lawn_protocol_id: protocol.id, window_key: WINDOW_KEY })
    .first();
  return window || null;
}

async function catalogId(knex, name) {
  const row = await knex('products_catalog').whereRaw('LOWER(name) = ?', [name.toLowerCase()]).first();
  return row ? row.id : null;
}

const sameJson = (value, expected) => (
  JSON.stringify(Object.entries(parseJson(value, {})).sort()) === JSON.stringify(Object.entries(expected).sort())
);

// The seeded row, untouched in EVERY field the rewrite replaces (20260529000003:
// product('oct_recovery_fall_pre_m', 'Velista', 'fungicide', 0.50, 'oz', 2, false,
// { frac: '7', trigger: 'large_patch_history' })). A row with any customized
// rate, unit, carrier, mode, plan flag, gates, counter or mixing is not this.
function isSeededVelista(row) {
  return row.role === 'fungicide'
    && row.application_mode === 'broadcast'
    && Number(row.rate_per_1000) === 0.5
    && row.rate_unit === 'oz'
    && Number(row.carrier_gal_per_1000) === 2
    && row.default_in_plan === false
    && sameJson(row.gates, VELISTA_GATES)
    && sameJson(row.annual_counter, {})
    && sameJson(row.mixing, {})
    && sameJson(row.report_copy, { role: 'fungicide' });
}

exports.up = async function up(knex) {
  const window = await octoberWindow(knex);
  if (!window) return;

  const existing = await knex('lawn_protocol_products')
    .where({ lawn_protocol_window_id: window.id, product_name: MEDALLION })
    .first();
  if (existing) return;

  const fields = {
    product_id: await catalogId(knex, MEDALLION),
    product_name: MEDALLION,
    role: 'fungicide',
    application_mode: 'broadcast',
    rate_per_1000: 1, // catalog default_rate_per_1000 (label range 1-2 fl oz/M)
    rate_unit: 'fl_oz',
    carrier_gal_per_1000: 2,
    default_in_plan: false,
    gates: JSON.stringify(MEDALLION_GATES),
    annual_counter: JSON.stringify({}),
    mixing: JSON.stringify({}),
    report_copy: JSON.stringify({ role: 'fungicide' }),
    updated_at: knex.fn.now(),
  };

  const velista = await knex('lawn_protocol_products')
    .where({ lawn_protocol_window_id: window.id, product_name: VELISTA })
    .first();
  if (velista && isSeededVelista(velista)) {
    await knex('lawn_protocol_products').where({ id: velista.id }).update(fields);
    return;
  }
  await knex('lawn_protocol_products').insert({
    lawn_protocol_window_id: window.id,
    ...fields,
    created_at: knex.fn.now(),
  });
};

// Still exactly what up() wrote, in every field it set.
function isUntouchedMedallion(row) {
  return row.role === 'fungicide'
    && row.application_mode === 'broadcast'
    && Number(row.rate_per_1000) === 1
    && row.rate_unit === 'fl_oz'
    && Number(row.carrier_gal_per_1000) === 2
    && row.default_in_plan === false
    && sameJson(row.gates, MEDALLION_GATES)
    && sameJson(row.annual_counter, {})
    && sameJson(row.mixing, {})
    && sameJson(row.report_copy, { role: 'fungicide' });
}

// Only a Medallion row that is still exactly what up() wrote is undone; a row
// someone has edited since is left alone. A rewritten row goes back to the
// seeded Velista shape; a row added beside an edited Velista row is removed.
exports.down = async function down(knex) {
  const window = await octoberWindow(knex);
  if (!window) return;
  const rows = await knex('lawn_protocol_products')
    .where({ lawn_protocol_window_id: window.id, product_name: MEDALLION });
  for (const row of rows) {
    if (!isUntouchedMedallion(row)) continue;
    const velistaElsewhere = await knex('lawn_protocol_products')
      .where({ lawn_protocol_window_id: window.id, product_name: VELISTA })
      .first();
    if (velistaElsewhere) {
      await knex('lawn_protocol_products').where({ id: row.id }).del();
      continue;
    }
    await knex('lawn_protocol_products').where({ id: row.id }).update({
      product_id: await catalogId(knex, VELISTA),
      product_name: VELISTA,
      rate_per_1000: 0.5,
      rate_unit: 'oz',
      gates: JSON.stringify(VELISTA_GATES),
      updated_at: knex.fn.now(),
    });
  }
};
