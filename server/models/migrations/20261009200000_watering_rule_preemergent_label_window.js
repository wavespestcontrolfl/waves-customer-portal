// Pre-emergent water-in follows the label (owner 2026-10-09: "hold 24 hr,
// then label watering/irrigation"; Dimension "match Stonewall").
//
// The v13 rules (20261005235500, 20261006120000) asked the customer for 0.5
// inch within 24 hours, so a rotor lawn read "each zone about 80 minutes". The
// Stonewall labels say "at least 0.5 inch of rainfall or irrigation within 14
// days following application"; the Dimension labels give no deadline (2EW) or
// no amount (18-0-10), so the owner matched them to Stonewall. A window this
// long is met by rain and the regular schedule (lawn-watering-instruction.js
// rule D), never by a one-off run. The 24-hour post-emergent hold is unchanged.
//
// Topchoice's 0.25 inch within 24 hours is the program default (its own note
// says so), not label text: its source becomes 'owner'.
//
// Compare-and-set on the value read: a rule is rewritten only while it still
// carries the values being replaced; any other admin edit is left alone. One
// audit row each with before and after.
const { recordAuditEvent } = require('../../services/audit-log');
const { validateRule } = require('../../services/service-report/lawn-watering-rule');

const MIGRATION = '20261009200000_watering_rule_preemergent_label_window';
const VERIFIED_AT = '2026-10-09T00:00:00.000Z';
const VERIFIED_BY = 'owner-ruling-2026-10-09';
const WINDOW_HOURS = 336;

const STONEWALL_NOTE = 'Label: activate by at least 0.5 inch of rainfall or irrigation within 14 days following application.';

const PRE_EMERGENTS = [
  { name: 'LESCO Stonewall 4FL Prodiamine 40.7% Pre-Emergent Liquid Herbicide', source: 'label', label_note: STONEWALL_NOTE },
  { name: 'LESCO Stonewall 0.43% 15-0-15 50% PolyPlus OPTI45 Pre-Emergent Plus Fertilizer', source: 'label', label_note: STONEWALL_NOTE },
  {
    name: 'Dimension 2EW Dithiopyr 24% Pre-Emergent Liquid Herbicide',
    source: 'owner',
    label_note: 'Label: "For preemergence residual control of crabgrass, apply at least 0.5 inch of water after application." (no deadline). Owner (2026-10-09): within 14 days, as Stonewall.',
  },
  {
    name: 'LESCO Dimension 0.21% 18-0-10 50% PolyPlus OPTI45 MOP Pre-Emergent Plus Fertilizer',
    source: 'owner',
    label_note: 'Label: watered or receives rainfall "within a few days after application" (no amount). Owner (2026-10-09): 0.5 inch within 14 days, as Stonewall.',
  },
];

const TOPCHOICE = 'Topchoice Granular Insecticide';

function parseJson(value) {
  if (value == null) return null;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return null; }
}

// The 2026-10-05 pre-emergent value: water in 0.5 inch within 24 hours.
function isV13PreEmergentRule(rule) {
  return !!rule && rule.mode === 'water_in' && Number(rule.water_in_inches) === 0.5
    && Number(rule.water_in_by_hours) === 24 && rule.water_in_same_day !== true;
}

function preEmergentAfter(before, item) {
  return {
    ...before,
    water_in_by_hours: WINDOW_HOURS,
    source: item.source,
    label_note: item.label_note,
    verified_at: VERIFIED_AT,
    verified_by: VERIFIED_BY,
  };
}

function topchoiceAfter(before) {
  if (!before || before.mode !== 'water_in' || before.source !== 'label') return null;
  return { ...before, source: 'owner', verified_at: VERIFIED_AT, verified_by: VERIFIED_BY };
}

async function casWrite(knex, row, before, after, kind, canAudit) {
  if (!validateRule(after).valid) return; // never write a rule the validator rejects
  const updated = await knex('products_catalog')
    .where({ id: row.id })
    .whereRaw('post_application_watering = ?::jsonb', [JSON.stringify(before)])
    .update({ post_application_watering: JSON.stringify(after), updated_at: knex.fn.now() });
  if (!updated || !canAudit) return;
  await recordAuditEvent({
    actor_type: 'system',
    action: `migration:${MIGRATION}:${kind}`,
    resource_type: 'products_catalog',
    resource_id: String(row.id),
    metadata: { migration: MIGRATION, product: row.name, before, after },
    critical: true,
    trx: knex,
  });
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('products_catalog'))) return;
  if (!(await knex.schema.hasColumn('products_catalog', 'post_application_watering'))) return;
  const canAudit = await knex.schema.hasTable('audit_log');

  for (const item of PRE_EMERGENTS) {
    const rows = await knex('products_catalog').where({ name: item.name }).select('id', 'name', 'post_application_watering');
    for (const row of rows) {
      const before = parseJson(row.post_application_watering);
      if (!isV13PreEmergentRule(before)) continue;
      await casWrite(knex, row, before, preEmergentAfter(before, item), 'label_window', canAudit);
    }
  }

  const rows = await knex('products_catalog').where({ name: TOPCHOICE }).select('id', 'name', 'post_application_watering');
  for (const row of rows) {
    const before = parseJson(row.post_application_watering);
    const after = topchoiceAfter(before);
    if (after) await casWrite(knex, row, before, after, 'source_owner', canAudit);
  }
};

// Documented no-op (waves-db SKILL: a data-correction migration never reverts
// on rollback). The audit rows keep every before value.
exports.down = async function down() {};

exports.PRE_EMERGENTS = PRE_EMERGENTS;
exports.TOPCHOICE = TOPCHOICE;
exports.isV13PreEmergentRule = isV13PreEmergentRule;
exports.preEmergentAfter = preEmergentAfter;
exports.topchoiceAfter = topchoiceAfter;
