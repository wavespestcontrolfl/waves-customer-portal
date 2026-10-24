// Lawn report product cards: the two granular pre-emergents ask for ½ inch within 14 days, as their watering rule
// does (owner 2026-10-24: "fix watering").
//
// 20261009200000 moved the Stonewall 15-0-15 and Dimension 18-0-10 watering rules from 0.5 inch within 24 hours to
// 0.5 inch within 14 days (Stonewall: label; Dimension: owner rule 2026-10-09). Their catalog precaution, which a
// lawn report prints on the product card, still said "Water in with about ½ inch within 24 hours." So a real report
// on 2026-10-23 gave two deadlines: the banner's 14 days and the card's 24 hours. The banner was right.
//
// The sentence becomes "Water in with about ½ inch within 14 days; rain and your regular watering both count." It
// stays ONE sentence on purpose:
//   - the frozen label-line decision (lawn-label-lines.js) stores dropped sentence INDEXES, so the count and the
//     order of the sentences stay the same;
//   - parseWaterInInches (lawn-water-in-rain.js) still reads ½ inch from it;
//   - its second half is the banner's own words for a 14-day water-in (lawn-watering-instruction.js rule D).
//
// Compare-and-set: a row changes only while its precaution still carries the old sentence exactly once AND its
// watering rule is still the 14-day value (an admin who set the rule back to 24 hours keeps the 24-hour card). Only
// that sentence is replaced; any other edit to the text stays. One audit row each with before and after.
//
// New visits only. A completed visit froze its card text at completion (reportIdentitySnapshot.productFacts); this
// migration never touches a visit.
const { recordAuditEvent } = require('../../services/audit-log');

const MIGRATION = '20261025010000_preemergent_card_water_in_window';
const OLD_SENTENCE = 'Water in with about ½ inch within 24 hours.';
const NEW_SENTENCE = 'Water in with about ½ inch within 14 days; rain and your regular watering both count.';
const WINDOW_HOURS = 336;

const PRODUCTS = Object.freeze([
  'LESCO Stonewall 0.43% 15-0-15 50% PolyPlus OPTI45 Pre-Emergent Plus Fertilizer',
  'LESCO Dimension 0.21% 18-0-10 50% PolyPlus OPTI45 MOP Pre-Emergent Plus Fertilizer',
]);

function parseJson(value) {
  if (value == null) return null;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return null; }
}

// The 20261009200000 value: water in 0.5 inch within 14 days.
function isFourteenDayRule(rule) {
  return !!rule && rule.mode === 'water_in' && Number(rule.water_in_inches) === 0.5
    && Number(rule.water_in_by_hours) === WINDOW_HOURS;
}

// The precaution with the one sentence replaced, or null when the text does not carry it exactly once.
function precautionAfter(text) {
  if (typeof text !== 'string') return null;
  const at = text.indexOf(OLD_SENTENCE);
  if (at < 0 || text.indexOf(OLD_SENTENCE, at + OLD_SENTENCE.length) >= 0) return null;
  return text.slice(0, at) + NEW_SENTENCE + text.slice(at + OLD_SENTENCE.length);
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('products_catalog'))) return;
  if (!(await knex.schema.hasColumn('products_catalog', 'customer_precaution_summary'))) return;
  if (!(await knex.schema.hasColumn('products_catalog', 'post_application_watering'))) return;
  const canAudit = await knex.schema.hasTable('audit_log');

  const rows = await knex('products_catalog')
    .whereIn('name', PRODUCTS)
    .select('id', 'name', 'customer_precaution_summary', 'post_application_watering');
  for (const row of rows) {
    const rule = parseJson(row.post_application_watering);
    if (!isFourteenDayRule(rule)) continue;
    const before = row.customer_precaution_summary;
    const after = precautionAfter(before);
    if (!after) continue;
    const updated = await knex('products_catalog')
      .where({ id: row.id, customer_precaution_summary: before })
      .whereRaw('post_application_watering = ?::jsonb', [JSON.stringify(rule)])
      .update({ customer_precaution_summary: after, updated_at: knex.fn.now() });
    if (!updated || !canAudit) continue;
    await recordAuditEvent({
      actor_type: 'system',
      action: `migration:${MIGRATION}:card_water_in_window`,
      resource_type: 'products_catalog',
      resource_id: String(row.id),
      metadata: { migration: MIGRATION, product: row.name, before, after },
      critical: true,
      trx: knex,
    });
  }
};

// Documented no-op (waves-db SKILL: a data-correction migration never reverts on rollback; a blanket revert would
// also put the wrong deadline back). The audit rows keep every before value.
exports.down = async function down() {};

exports.OLD_SENTENCE = OLD_SENTENCE;
exports.NEW_SENTENCE = NEW_SENTENCE;
exports.PRODUCTS = PRODUCTS;
exports.isFourteenDayRule = isFourteenDayRule;
exports.precautionAfter = precautionAfter;
