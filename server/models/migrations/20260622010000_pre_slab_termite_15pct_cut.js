/**
 * 15%-across-the-board price cut for pre-slab termite treatment.
 *
 * Pre-slab pricing is DB-authoritative (db-bridge.syncConstantsFromDB loads
 * `pricing_config.onetime_preslab` over the in-code constants), so the
 * constants.js / seed changes in this PR are inert in any env carrying the row
 * unless the row is updated too. Every pre-slab quote is `max(cost ÷ margin,
 * floor)` (+ optional warranty), so a uniform 15% cut scales BOTH levers:
 *   - contextual floor tables (minimums_*)         × 0.85
 *   - per-product margin_divisor (0.45 → 0.5294)   ÷ 0.85   (cost-driven −15%)
 *   - extended-warranty add-on (200 → 170)         × 0.85
 *
 * Read-modify-write so admin edits to other keys survive; scales whatever the
 * current values are (so an admin-customized floor is cut 15%, not reset).
 *
 * down() restores each scaled field to its pre-cut value from the audit
 * snapshot, but only where the field is still exactly what up() wrote — a
 * post-cut admin edit is preserved (floors compared order-independently, since
 * Postgres jsonb does not preserve object key order).
 */
const MIGRATION_TAG = 'migration:20260622010000';
const UP_REASON = 'Pre-slab termite: 15% across-the-board price cut (floors x0.85, margin 0.45->0.5294, warranty 200->170)';
const DOWN_REASON = 'Rollback: restore pre-slab pre-cut floors / margin / warranty';
const CHANGELOG_IDENTITY = {
  version_from: 'v1.0',
  version_to: 'v1.1',
  changed_by: 'claude-2026-06-22',
  category: 'rule',  // allowed by pricing_changelog CHECK (bug|leak|rule|cost|architecture|documentation|infrastructure)
  summary: '15% across-the-board pre-slab termite price cut.',
};

const SCALE = 0.85;
const MIN_KEYS = ['minimums_standalone', 'minimums_builderBatch', 'minimums_sameTripAddOn'];

const scaleFloorTiers = (tiers) => (Array.isArray(tiers)
  ? tiers.map((t) => ({ ...t, floor: Math.round(Number(t.floor) * SCALE) }))
  : tiers);
const scaleMargin = (md) => Math.round((Number(md) / SCALE) * 10000) / 10000;
const scaleWarranty = (w) => Math.round(Number(w) * SCALE);

// Key-order-independent canonical serialization — jsonb does not preserve
// object key order, so a round-tripped floor table must still compare equal.
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
const sameTiers = (a, b) => canonical(a) === canonical(b);

function parseData(value) {
  if (!value) return null;
  if (typeof value === 'object' && !Buffer.isBuffer(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_) {
    return null;
  }
}

async function loadConfig(knex) {
  if (!(await knex.schema.hasTable('pricing_config'))) return null;
  const row = await knex('pricing_config').where({ config_key: 'onetime_preslab' }).first();
  if (!row) return null;
  const data = parseData(row.data);
  if (!data || typeof data !== 'object') return null;
  return { row, data };
}

async function save(knex, oldData, newData, reason) {
  await knex('pricing_config')
    .where({ config_key: 'onetime_preslab' })
    .update({ data: JSON.stringify(newData), updated_at: knex.fn.now() });
  if (await knex.schema.hasTable('pricing_config_audit')) {
    await knex('pricing_config_audit').insert({
      config_key: 'onetime_preslab',
      old_value: JSON.stringify(oldData),
      new_value: JSON.stringify(newData),
      changed_by: MIGRATION_TAG,
      reason,
    });
  }
}

exports.up = async function up(knex) {
  const loaded = await loadConfig(knex);
  if (!loaded) return;
  const { data } = loaded;

  const newData = { ...data };
  for (const key of MIN_KEYS) {
    if (Array.isArray(newData[key])) newData[key] = scaleFloorTiers(newData[key]);
  }
  if (Number.isFinite(Number(newData.warranty_extended))) {
    newData.warranty_extended = scaleWarranty(newData.warranty_extended);
  }
  if (newData.products && typeof newData.products === 'object') {
    newData.products = Object.fromEntries(
      Object.entries(newData.products).map(([key, product]) => {
        if (!product || typeof product !== 'object' || !Number.isFinite(Number(product.margin_divisor))) {
          return [key, product];
        }
        return [key, { ...product, margin_divisor: scaleMargin(product.margin_divisor) }];
      }),
    );
  }
  await save(knex, data, newData, UP_REASON);

  if (await knex.schema.hasTable('pricing_changelog')) {
    const existing = await knex('pricing_changelog').where(CHANGELOG_IDENTITY).first('id');
    if (!existing) {
      await knex('pricing_changelog').insert({
        ...CHANGELOG_IDENTITY,
        affected_services: JSON.stringify(['pre_slab_termiticide', 'pre_slab_termidor']),
        before_value: JSON.stringify({ minimums: MIN_KEYS.reduce((o, k) => ({ ...o, [k]: data[k] }), {}), products: data.products, warranty_extended: data.warranty_extended }),
        after_value: JSON.stringify({ minimums: MIN_KEYS.reduce((o, k) => ({ ...o, [k]: newData[k] }), {}), products: newData.products, warranty_extended: newData.warranty_extended }),
        rationale: 'Owner decision: bring pre-slab termite pricing down 15% across the board. Floors x0.85 (rounded to whole dollars), per-product margin_divisor 0.45 -> 0.5294 (margin 55% -> ~47%, cost-driven quotes -15%), extended-warranty add-on $200 -> $170.',
      });
    }
  }
};

exports.down = async function down(knex) {
  // Restore pre-cut values from this migration's audit snapshot, but only where
  // the field is still exactly what up() wrote — a post-cut admin edit is kept.
  // No audit table means no proof of ownership; leave data alone.
  if (!(await knex.schema.hasTable('pricing_config_audit'))) return;
  const ownUp = await knex('pricing_config_audit')
    .where({ config_key: 'onetime_preslab', changed_by: MIGRATION_TAG, reason: UP_REASON })
    .first('id', 'old_value');
  if (!ownUp) return;

  const loaded = await loadConfig(knex);
  if (!loaded) return;
  const { data } = loaded;
  const preUp = parseData(ownUp.old_value) || {};

  const newData = { ...data };
  for (const key of MIN_KEYS) {
    if (Array.isArray(preUp[key]) && sameTiers(newData[key], scaleFloorTiers(preUp[key]))) {
      newData[key] = preUp[key];
    }
  }
  if (Number.isFinite(Number(preUp.warranty_extended))
      && Number(newData.warranty_extended) === scaleWarranty(preUp.warranty_extended)) {
    newData.warranty_extended = preUp.warranty_extended;
  }
  const preUpProducts = preUp.products || {};
  if (newData.products && typeof newData.products === 'object') {
    newData.products = Object.fromEntries(
      Object.entries(newData.products).map(([key, product]) => {
        const old = preUpProducts[key];
        if (!product || typeof product !== 'object' || !old || !Number.isFinite(Number(old.margin_divisor))) {
          return [key, product];
        }
        if (Number(product.margin_divisor) === scaleMargin(old.margin_divisor)) {
          return [key, { ...product, margin_divisor: old.margin_divisor }];
        }
        return [key, product];
      }),
    );
  }
  await save(knex, data, newData, DOWN_REASON);

  if (await knex.schema.hasTable('pricing_changelog')) {
    await knex('pricing_changelog').where(CHANGELOG_IDENTITY).del();
  }
};
