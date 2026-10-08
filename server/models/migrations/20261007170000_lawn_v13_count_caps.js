/**
 * Lawn protocol v13, yearly COUNT LIMITS for the four spot products (owner 2026-10-06:
 * "limit to twice a year"). GATE_LAWN_V13 is live; these products are optional spot work.
 *
 *   Arena 50 WDG             2 applications per lawn per year. The label caps clothianidin at
 *                            0.4 lb per acre per year, which is one pass over an area, so the
 *                            recipe also says "never the same area twice".
 *   Celsius WG               2 passes per spot per year.
 *   Certainty Turf Herbicide 2 passes per spot per year.
 *   Blindside Herbicide      2 per year.
 *
 * What this writes: one product-level annual_max_apps row (hard_block, value 2) per product,
 * inserted by explicit product id ONLY where that product has no annual_max_apps row at all.
 * An existing row (an admin's) is never changed: the migration logs it and moves on.
 *
 * One exception, Celsius (owner 2026-10-06, "I approve all changes": 2 a year, not 3). The
 * compliance seed (20260401000020) wrote a Celsius row of 3. That row is lowered to 2 only
 * while it still equals the seed row exactly (value 3, unit, severity and description); any
 * other value or description is an admin edit and is left and logged. The lowered row gets
 * its own description, which is how down() knows it wrote it. application-limits.js counts the history by property
 * (#6103), so a customer's second property starts its own count.
 *
 * Each product id is resolved once: exact catalog name (active rows first), else an exact
 * alias. A product that cannot be resolved is skipped with a log line (these are optional
 * spot products, so a missing one must not block the deploy).
 *
 * No price, catalog or protocol field is touched. Idempotent: a second run writes nothing.
 *
 * down() deletes only the rows this inserted, and restores the Celsius seed row (value 3, seed
 * description) only while it still holds the lowered values and description. A row goes only
 * while every field still equals what was written.
 */

const LABEL = 'owner 2026-10-06';

const CAPS = [
  {
    name: 'Arena 50 WDG',
    limit_value: 2,
    limit_unit: 'applications',
    description: `Arena 50 WDG: max 2 applications per lawn per year, never the same area twice (${LABEL}; label 0.4 lb clothianidin per acre per year).`,
  },
  {
    name: 'Celsius WG',
    limit_value: 2,
    limit_unit: 'applications',
    description: `Celsius WG: max 2 passes per spot per year (${LABEL}).`,
  },
  {
    name: 'Certainty Turf Herbicide',
    limit_value: 2,
    limit_unit: 'applications',
    description: `Certainty Turf Herbicide: max 2 passes per spot per year (${LABEL}).`,
  },
  {
    name: 'Blindside Herbicide',
    limit_value: 2,
    limit_unit: 'applications',
    description: `Blindside Herbicide: max 2 applications per year (${LABEL}).`,
  },
];

// The row 20260401000020 seeded for Celsius, and what it becomes (owner 2026-10-06).
const CELSIUS_SEED = {
  match_type: 'product',
  limit_type: 'annual_max_apps',
  limit_value: 3,
  limit_unit: 'applications',
  severity: 'hard_block',
  description: 'Celsius WG: max 3 applications per year per property. Exceeding voids warranty and risks turf damage.',
};
const CELSIUS_LOWERED = {
  ...CELSIUS_SEED,
  limit_value: 2,
  description: `Celsius WG: max 2 passes per spot per year (${LABEL}; lowered from 3).`,
};

const normalize = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// Exact catalog name (active rows first), else an exact alias; null when neither exists.
async function resolveProductId(knex, name) {
  const catalog = await knex('products_catalog').select('id', 'name', 'active');
  const hit = [...catalog].sort((a, b) => Number(b.active !== false) - Number(a.active !== false))
    .find((row) => normalize(row.name) === normalize(name));
  if (hit) return hit.id;
  if (!(await knex.schema.hasTable('product_aliases'))) return null;
  const alias = (await knex('product_aliases').select('product_id', 'alias_name'))
    .find((row) => normalize(row.alias_name) === normalize(name));
  return alias ? alias.product_id : null;
}

function row(cap, productId) {
  return {
    product_id: productId,
    match_type: 'product',
    limit_type: 'annual_max_apps',
    limit_value: cap.limit_value,
    limit_unit: cap.limit_unit,
    severity: 'hard_block',
    description: cap.description,
  };
}

async function hasTables(knex) {
  return (await knex.schema.hasTable('product_limits')) && (await knex.schema.hasTable('products_catalog'));
}

exports.up = async function up(knex) {
  if (!(await hasTables(knex))) return;
  for (const cap of CAPS) {
    const productId = await resolveProductId(knex, cap.name);
    if (!productId) {
      console.log(`[lawn-v13-count-caps] no catalog row or alias for ${cap.name}; no count cap written`);
      continue;
    }
    const existing = await knex('product_limits')
      .where({ product_id: productId, limit_type: 'annual_max_apps' })
      .select('id', 'match_type', 'limit_value', 'severity');
    if (existing.length === 1 && cap.name === 'Celsius WG') {
      const [only] = existing;
      const matchesSeed = await knex('product_limits')
        .where({ id: only.id, product_id: productId, ...CELSIUS_SEED }).first('id');
      if (matchesSeed) {
        await knex('product_limits').where({ id: only.id, ...CELSIUS_SEED }).update({ ...pick(CELSIUS_LOWERED), updated_at: knex.fn.now() });
        continue;
      }
    }
    if (existing.length) {
      console.log(`[lawn-v13-count-caps] ${cap.name} already has annual_max_apps: ${existing.map((r) => `${r.match_type} ${Number(r.limit_value)} ${r.severity}`).join('; ')} (owner value is ${cap.limit_value}); left as is`);
      continue;
    }
    await knex('product_limits').insert(row(cap, productId));
  }
};

// The columns an update writes (never the key columns).
function pick(spec) {
  return { limit_value: spec.limit_value, description: spec.description };
}

exports.down = async function down(knex) {
  if (!(await hasTables(knex))) return;
  // The lowered Celsius row goes back to the seed row, only while it still equals what up wrote.
  await knex('product_limits')
    .whereNotNull('product_id')
    .where(CELSIUS_LOWERED)
    .update({ ...pick(CELSIUS_SEED), updated_at: knex.fn.now() });
  for (const cap of CAPS) {
    // The description is unique to this migration; every other field must still equal what was written.
    await knex('product_limits')
      .whereNotNull('product_id')
      .where({
        match_type: 'product',
        limit_type: 'annual_max_apps',
        limit_value: cap.limit_value,
        limit_unit: cap.limit_unit,
        severity: 'hard_block',
        description: cap.description,
      })
      .del();
  }
};

exports.CAPS = CAPS;
exports.CELSIUS_SEED = CELSIUS_SEED;
exports.CELSIUS_LOWERED = CELSIUS_LOWERED;
exports.resolveProductId = resolveProductId;
