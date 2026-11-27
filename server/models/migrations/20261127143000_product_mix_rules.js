/**
 * Mix safety table (owner 2026-11-27: "we also need to create a database, of some sort, where we can define if we can mix
 * products without safety, or other risk"). One row says whether two products, or a product and a product group, may go
 * in the same tank: verdict ok / caution / never, a short reason the tech reads, and where the rule came from.
 * Every verdict is a WARNING only (owner rule 2026-11-26: a safety alert never blocks a visit or a product).
 *
 *   product_a_id       the product the rule is about (products_catalog)
 *   product_b_id       the other product, or NULL when the rule names a group
 *   group_b            a product group (services/product-mix-rules.js GROUPS), or NULL when the rule names a product
 *   verdict            'ok' | 'caution' | 'never'
 *   reason             at most 200 characters, shown to the tech
 *   source             label section, card rule, or 'owner'
 *   jar_test_required  the tech jar-tests the mix before the tank
 *   active             false = removed from the screen (soft delete)
 *
 * Exactly one of product_b_id / group_b is set. A product pair keeps the smaller id in product_a_id, so the pair has
 * one row whatever order it was entered in; two partial unique indexes keep one row per pair and per product + group.
 *
 * Seed: only rules quoted from server/config/lawn-protocol-v13.json, server/config/protocols.json (tree_shrub) or an
 * existing catalog row; each row's source holds the quote. Products are found by name; a product missing from the
 * catalog skips its row and never fails the migration. The seed only INSERTS a missing row (a second run adds nothing),
 * and one audit_log event records each row it adds.
 *
 * down() drops the table. The rows exist only in this table, so nothing outside it is lost.
 */

const MIGRATION = '20261127143000_product_mix_rules';
const AUDIT_ACTION = 'product_mix_rules.seeded';
const LOG = '[20261127143000]';

const VERDICTS = ['ok', 'caution', 'never'];
// Mirrors services/product-mix-rules.js GROUPS (a test keeps them equal).
const GROUPS = ['any', 'fertilizer', 'surfactant', 'oil', 'copper', 'pyrethroid', 'neonic', 'granular', 'herbicide', 'insecticide', 'fungicide'];

// Catalog names. Each list is tried in order: an exact active name first, then the first entry as a prefix (one match only).
const CELSIUS = ['Celsius WG'];
const CERTAINTY = ['Certainty Turf Herbicide'];
const NIS = ['LESCO 90/10 Nonionic Surfactant'];
const TETRINO = ['Tetrino Insecticide', 'Tetrino'];
const TOPCHOICE = ['Topchoice Granular Insecticide'];
const SEQUESTAR = ['Sequestar 6% Fe EDDHA Soluble Micronutrient', 'Sequestar 6% Fe EDDHA'];
const RELIANT = ['Reliant Systemic Fungicide', 'Reliant'];
const COPPER = ['Southern Ag Copper Fungicide 27.15%', 'Southern Ag Copper Fungicide'];
const TRITEK = ['TriTek Spray Oil Emulsion (OMRI)', 'TriTek Spray Oil Emulsion'];
const SUFFOIL = ['SuffOil-X Spray Oil Emulsion'];

const LAWN = 'server/config/lawn-protocol-v13.json';
const TREE = 'server/config/protocols.json tree_shrub';
const CELSIUS_ALONE = '"In February and from June through September the weed spot is Celsius alone: no Certainty and no surfactant."';
const OIL_NOTE = '"Do not make oil + copper, oil + broad-spectrum pyrethroid, or neonic systemics a default production tank."';

const SEED = [
  {
    a: CELSIUS, group: 'fertilizer', verdict: 'never',
    reason: 'Do not tank mix Celsius with fertilizer.',
    source: 'Catalog row Celsius WG, compatibility_notes (migration 20260401000026): "Requires NIS surfactant. Do NOT tank-mix with fertilizer."',
  },
  {
    a: CELSIUS, b: CERTAINTY, verdict: 'caution',
    reason: 'Approved weed mix. In February and June to September, spray Celsius alone: no Certainty.',
    source: `${LAWN} card lines: "Certainty Turf Herbicide — weed spots, 0.028 oz per 1,000 sq ft in the Celsius weed mix"; ${CELSIUS_ALONE}`,
  },
  {
    a: CELSIUS, b: NIS, verdict: 'caution',
    reason: 'Approved weed mix. In February and June to September, spray Celsius alone: no surfactant.',
    source: `${LAWN} card lines: "LESCO 90/10 Nonionic Surfactant — 0.25% of the spray volume in the Celsius weed mix"; ${CELSIUS_ALONE}`,
  },
  {
    a: CERTAINTY, b: NIS, verdict: 'ok',
    reason: 'Both go in the Celsius weed mix.',
    source: `${LAWN} card lines: "Certainty Turf Herbicide — weed spots, 0.028 oz per 1,000 sq ft in the Celsius weed mix"; "LESCO 90/10 Nonionic Surfactant — 0.25% of the spray volume in the Celsius weed mix"`,
  },
  {
    a: TETRINO, group: 'any', verdict: 'never',
    reason: 'Apply Tetrino alone. Do not mix it with any other product.',
    source: `${LAWN} safety_rules (Tetrino): "Sunny turf only, at least 25 ft from water, applied alone."`,
  },
  {
    a: TOPCHOICE, group: 'any', verdict: 'never',
    reason: 'Spread Topchoice as its own pass. Never blend it with another product.',
    source: `${LAWN} card line: "Topchoice Granular Insecticide — ... as its own pass, never blended with the month's granular (the label says not to apply it in combination with other materials)"`,
  },
  {
    a: COPPER, group: 'oil', verdict: 'never',
    reason: 'Keep copper out of oil tanks.',
    source: `${TREE} safety_rules: "Copper is separate from routine oil tanks"; notes: ${OIL_NOTE}`,
  },
  {
    a: TRITEK, group: 'pyrethroid', verdict: 'never',
    reason: 'No oil and pyrethroid in the same tank.',
    source: `${TREE} visit field guide, don't: "No oil and pyrethroid together"; notes: ${OIL_NOTE}`,
  },
  {
    a: SUFFOIL, group: 'pyrethroid', verdict: 'never',
    reason: 'No oil and pyrethroid in the same tank.',
    source: `${TREE} visit field guide, don't: "No oil and pyrethroid together"; notes: ${OIL_NOTE}`,
  },
  {
    a: SEQUESTAR, group: 'oil', verdict: 'never',
    reason: 'Never tank mix Sequestar with oil.',
    source: `${TREE} card line (Sequestar 6% Fe EDDHA): "never tank-mix with oil"`,
  },
  {
    a: RELIANT, group: 'copper', verdict: 'never',
    reason: 'Do not tank mix Reliant with copper.',
    source: `${TREE} card line (Reliant Systemic Fungicide, phosphite): "no tank mix with copper"`,
  },
];

function quoted(values) {
  return values.map((value) => `'${value}'`).join(', ');
}

async function createTable(knex) {
  await knex.schema.createTable('product_mix_rules', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('product_a_id').notNullable().references('id').inTable('products_catalog').onDelete('CASCADE');
    t.uuid('product_b_id').nullable().references('id').inTable('products_catalog').onDelete('CASCADE');
    t.string('group_b', 30).nullable();
    t.string('verdict', 10).notNullable();
    t.string('reason', 200).notNullable();
    t.text('source').nullable();
    t.boolean('jar_test_required').notNullable().defaultTo(false);
    t.boolean('active').notNullable().defaultTo(true);
    t.uuid('created_by').nullable().references('id').inTable('technicians').onDelete('SET NULL');
    t.uuid('updated_by').nullable().references('id').inTable('technicians').onDelete('SET NULL');
    t.timestamps(true, true);
    t.index(['product_b_id'], 'product_mix_rules_product_b_idx');
  });
  await knex.raw(`ALTER TABLE product_mix_rules ADD CONSTRAINT product_mix_rules_one_target_check
    CHECK ((product_b_id IS NULL) <> (group_b IS NULL))`);
  await knex.raw(`ALTER TABLE product_mix_rules ADD CONSTRAINT product_mix_rules_pair_order_check
    CHECK (product_b_id IS NULL OR product_a_id < product_b_id)`);
  await knex.raw(`ALTER TABLE product_mix_rules ADD CONSTRAINT product_mix_rules_verdict_check
    CHECK (verdict IN (${quoted(VERDICTS)}))`);
  await knex.raw(`ALTER TABLE product_mix_rules ADD CONSTRAINT product_mix_rules_group_check
    CHECK (group_b IS NULL OR group_b IN (${quoted(GROUPS)}))`);
  await knex.raw(`CREATE UNIQUE INDEX product_mix_rules_one_per_pair
    ON product_mix_rules (product_a_id, product_b_id) WHERE product_b_id IS NOT NULL`);
  await knex.raw(`CREATE UNIQUE INDEX product_mix_rules_one_per_group
    ON product_mix_rules (product_a_id, group_b) WHERE group_b IS NOT NULL`);
}

async function findProduct(knex, names) {
  for (const name of names) {
    const rows = await knex('products_catalog').where({ name, active: true }).select('id', 'name');
    if (rows.length === 1) return rows[0];
  }
  const rows = await knex('products_catalog').where('name', 'ilike', `${names[0].replace(/[%_\\]/g, '\\$&')}%`)
    .andWhere({ active: true }).select('id', 'name');
  return rows.length === 1 ? rows[0] : null;
}

async function seedRules(knex) {
  const hasAudit = await knex.schema.hasTable('audit_log');
  const { recordAuditEvent } = require('../../services/audit-log');
  for (const rule of SEED) {
    const a = await findProduct(knex, rule.a);
    const b = rule.b ? await findProduct(knex, rule.b) : null;
    if (!a || (rule.b && !b)) {
      console.log(`${LOG} skipped (product not in the catalog): ${rule.a[0]} + ${rule.b ? rule.b[0] : rule.group}`);
      continue;
    }
    if (b && a.id === b.id) continue;
    // A product pair keeps the smaller id first (the pair order check).
    const [first, second] = b ? [a.id, b.id].sort() : [a.id, null];
    const key = b ? { product_a_id: first, product_b_id: second } : { product_a_id: first, group_b: rule.group };
    const existing = await knex('product_mix_rules').where(key).first();
    if (existing) continue; // an existing row may be an admin's own edit: leave it alone
    const [row] = await knex('product_mix_rules').insert({
      ...key,
      verdict: rule.verdict,
      reason: rule.reason,
      source: rule.source,
      jar_test_required: false,
      active: true,
    }).returning('id');
    const id = (row && row.id) || row;
    if (hasAudit) {
      // Critical: a lost event fails the migration (and rolls its transaction back) instead of an unrecorded seed.
      await recordAuditEvent({
        actor_type: 'system', action: AUDIT_ACTION,
        resource_type: 'product_mix_rules', resource_id: String(id),
        metadata: { migration: MIGRATION, product_a: a.name, product_b: b ? b.name : null, group_b: b ? null : rule.group, verdict: rule.verdict },
        critical: true, trx: knex,
      });
    }
    console.log(`${LOG} seeded: ${a.name} + ${b ? b.name : rule.group} = ${rule.verdict}`);
  }
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('products_catalog'))) return;
  if (!(await knex.schema.hasTable('product_mix_rules'))) await createTable(knex);
  await seedRules(knex);
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('product_mix_rules');
};

exports._MIGRATION = MIGRATION;
exports._AUDIT_ACTION = AUDIT_ACTION;
exports._VERDICTS = VERDICTS;
exports._GROUPS = GROUPS;
exports._SEED = SEED;
