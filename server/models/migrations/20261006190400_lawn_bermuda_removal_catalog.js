/**
 * Lawn bermuda removal, catalog rows for a database built from migrations alone
 * (GATE_LAWN_BERMUDA_REMOVAL, owner 2026-10-06). Migrations 20261006190000 to
 * 20261006190300 are pushed and frozen; this one fixes what they assumed.
 *
 * 190100 stages the three spot rows and the product limits by catalog id, but the
 * Recognition and Fusilade II catalog rows exist in prod only through data writes. On a
 * database built from migrations (CI, a fresh environment) they are absent, so the staged
 * rows kept product_id NULL and the limits were skipped: the step could never be offered.
 *
 * 1. Catalog rows. Recognition and Fusilade II are inserted ONLY when no catalog row has
 *    that exact name and no product alias spells it (a prod row is never touched). Price is
 *    unknown, so needs_pricing. EPA numbers as the owner gave them: Recognition 100-1658,
 *    Fusilade II 100-1084. Rates are the step's label rates (Recognition 0.03 oz, Fusilade II
 *    0.55 fl oz per 1,000 sq ft). An ingredient the owner did not give is left NULL.
 * 2. Links. Every staged bermuda removal row (gates.bermudaRemoval) with a NULL product_id
 *    is linked by exact name, then alias.
 * 3. Limits. The 5 program rows of 190100 / 190300 are created when missing, tagged
 *    match_value 'bermuda_removal'; an untagged copy 190100 wrote is tagged.
 *
 * Idempotent. Reversible by record: every row this migration inserts, links or tags is
 * written to audit_log (action migration:<name>:seeded) with what it did; down() undoes
 * exactly those, then marks the audit rows ':reverted' so a second down does nothing and
 * a later up writes new ones. A catalog row this migration created is deleted only when
 * nothing references it any more; a link is nulled only while it still holds the id
 * written here.
 */
const { recordAuditEvent } = require('../../services/audit-log');

const MIGRATION = '20261006190400_lawn_bermuda_removal_catalog';
const SEEDED = `migration:${MIGRATION}:seeded`;
const REVERTED = `migration:${MIGRATION}:reverted`;
const V13_VERSION = '2026.10-v13';
const PROGRAM = 'bermuda_removal';
const LIMIT_TAG = 'bermuda removal (owner 2026-10-06)';

const N = {
  REC: 'Recognition Post Emergent Herbicide',
  FUS: 'Fusilade II Post Emergent Liquid Herbicide',
};

const PRODUCTS = [
  { name: N.REC, category: 'herbicide', formulation: 'dry', epa_reg_number: '100-1658', default_rate_per_1000: 0.03, rate_unit: 'oz' },
  { name: N.FUS, category: 'herbicide', active_ingredient: 'Fluazifop-P-butyl', formulation: 'liquid', container_size: '32 fl oz', unit_size_oz: 32, epa_reg_number: '100-1084', default_rate_per_1000: 0.55, rate_unit: 'fl oz' },
];

const LIMITS = [
  { name: N.REC, limit_type: 'annual_max_apps', limit_value: 2, limit_unit: 'applications', severity: 'hard_block', description: `Recognition: max 2 bermuda removal sprays per calendar year per property ${LIMIT_TAG}. A third waits for next year.` },
  { name: N.REC, limit_type: 'min_interval_days', limit_value: 42, limit_unit: 'days', severity: 'hard_block', description: `Recognition: at least 42 days between bermuda removal sprays ${LIMIT_TAG}.` },
  { name: N.REC, limit_type: 'annual_max_rate', limit_value: 0.1437, limit_unit: 'oz/1000sf/year', severity: 'warning', description: `Recognition label annual maximum 6.26 oz per acre (0.1437 oz per 1,000 sq ft) ${LIMIT_TAG}.` },
  { name: N.FUS, limit_type: 'annual_max_apps', limit_value: 2, limit_unit: 'applications', severity: 'hard_block', description: `Fusilade II: max 2 bermuda removal sprays per calendar year per property ${LIMIT_TAG}. A third waits for next year.` },
  { name: N.FUS, limit_type: 'min_interval_days', limit_value: 42, limit_unit: 'days', severity: 'hard_block', description: `Fusilade II: at least 42 days between bermuda removal sprays ${LIMIT_TAG}.` },
];

const normalize = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

async function loadResolver(knex) {
  const catalog = await knex('products_catalog').select('id', 'name', 'active');
  const aliases = (await knex.schema.hasTable('product_aliases'))
    ? await knex('product_aliases').select('product_id', 'alias_name') : [];
  const byName = new Map();
  for (const row of [...catalog].sort((a, b) => Number(b.active !== false) - Number(a.active !== false))) {
    if (!byName.has(normalize(row.name))) byName.set(normalize(row.name), row.id);
  }
  const byAlias = new Map();
  for (const row of aliases) if (!byAlias.has(normalize(row.alias_name))) byAlias.set(normalize(row.alias_name), row.product_id);
  return (name) => byName.get(normalize(name)) || byAlias.get(normalize(name)) || null;
}

const audit = (knex, resourceType, resourceId, metadata) => recordAuditEvent({
  actor_type: 'system', action: SEEDED, resource_type: resourceType, resource_id: String(resourceId), metadata: { migration: MIGRATION, ...metadata }, critical: true, trx: knex,
});

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('products_catalog'))) return;
  const canAudit = await knex.schema.hasTable('audit_log');
  let resolve = await loadResolver(knex);

  for (const product of PRODUCTS) {
    if (resolve(product.name)) continue;
    const [row] = await knex('products_catalog').insert({
      ...product,
      active: true,
      needs_pricing: true,
      content_status: 'draft',
      customer_visibility: 'internal_only',
      label_source_note: 'Added for the Waves lawn bermuda removal step (owner 2026-10-06); price pending.',
      created_at: knex.fn.now(),
      updated_at: knex.fn.now(),
    }).returning('id');
    if (canAudit) await audit(knex, 'products_catalog', row.id ?? row, { kind: 'catalog_row', name: product.name });
  }
  resolve = await loadResolver(knex);

  if (await knex.schema.hasTable('lawn_protocol_products')) {
    const unlinked = await knex('lawn_protocol_products as p')
      .join('lawn_protocol_windows as w', 'p.lawn_protocol_window_id', 'w.id')
      .join('lawn_protocols as l', 'w.lawn_protocol_id', 'l.id')
      .where('l.version', V13_VERSION).whereNull('p.product_id')
      .whereRaw("p.gates->>'bermudaRemoval' = 'true'")
      .select('p.id', 'p.product_name');
    for (const row of unlinked) {
      const productId = resolve(row.product_name);
      if (!productId) continue;
      await knex('lawn_protocol_products').where({ id: row.id }).whereNull('product_id').update({ product_id: productId, updated_at: knex.fn.now() });
      if (canAudit) await audit(knex, 'lawn_protocol_products', row.id, { kind: 'link', productId: String(productId) });
    }
  }

  if (await knex.schema.hasTable('product_limits')) {
    for (const limit of LIMITS) {
      const productId = resolve(limit.name);
      if (!productId) continue;
      const { name, ...fields } = limit;
      const existing = await knex('product_limits').where({ product_id: productId, match_type: 'product', limit_type: fields.limit_type })
        .where('description', 'like', `%${LIMIT_TAG}%`).first('id', 'match_value');
      if (!existing) {
        const [row] = await knex('product_limits').insert({ product_id: productId, match_type: 'product', match_value: PROGRAM, ...fields }).returning('id');
        if (canAudit) await audit(knex, 'product_limits', row.id ?? row, { kind: 'limit_row' });
      } else if (existing.match_value == null) {
        await knex('product_limits').where({ id: existing.id }).whereNull('match_value').update({ match_value: PROGRAM });
        if (canAudit) await audit(knex, 'product_limits', existing.id, { kind: 'limit_tag' });
      }
    }
  }
};

// A delete that a foreign key refuses leaves the row in place instead of failing down().
async function deleteIfUnreferenced(knex, table, id) {
  await knex.raw('SAVEPOINT bermuda_catalog_down');
  try {
    await knex(table).where({ id }).del();
    await knex.raw('RELEASE SAVEPOINT bermuda_catalog_down');
  } catch (err) {
    await knex.raw('ROLLBACK TO SAVEPOINT bermuda_catalog_down');
    await knex.raw('RELEASE SAVEPOINT bermuda_catalog_down');
  }
}

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('audit_log'))) return;
  const seeded = await knex('audit_log').where({ action: SEEDED }).select('id', 'resource_type', 'resource_id', 'metadata');
  if (!seeded.length) return;
  const meta = (row) => (typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata) || {};
  const ofKind = (kind) => seeded.filter((row) => meta(row).kind === kind);

  for (const row of ofKind('limit_tag')) {
    await knex('product_limits').where({ id: row.resource_id, match_value: PROGRAM }).update({ match_value: null });
  }
  for (const row of ofKind('limit_row')) await knex('product_limits').where({ id: row.resource_id }).del();
  for (const row of ofKind('link')) {
    await knex('lawn_protocol_products').where({ id: row.resource_id, product_id: meta(row).productId }).update({ product_id: null });
  }
  for (const row of ofKind('catalog_row')) await deleteIfUnreferenced(knex, 'products_catalog', row.resource_id);

  await knex('audit_log').whereIn('id', seeded.map((row) => row.id)).update({ action: REVERTED });
};

exports.PRODUCTS = PRODUCTS;
exports.LIMITS = LIMITS;
