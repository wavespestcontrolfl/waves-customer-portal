// Follow-up to 20261009120000_watering_rule_herbicide_24h_hold (Codex round 1
// on PR #6243, two P1s). That file is already on the PR branch, so the Railway
// preview ran it and it stays byte-identical (waves-db SKILL §4); this file
// supersedes it in two ways:
//
// 1. It overwrote EVERY hold shorter than 24 hours on the named herbicides,
//    an admin's own edit included. An admin-authored rule carries the acting
//    admin's id in verified_by (admin-inventory.js stamps it); a migration-
//    seeded rule carries a label-check marker or nothing. Every overwrite was
//    audited with the before and after values, so this file reads those audit
//    rows back and RESTORES each admin-authored `before` on a product whose
//    rule is still exactly the `after` the first file wrote (a later admin
//    edit is never touched). In an environment with no audit_log there is no
//    record and nothing to restore. Each restore is audited in turn.
//
// 2. The same ruling reaches the FIELD sheet (AGENTS.md: a protocol change
//    reaches both sources of truth). The bermuda-removal rows of
//    lawn_protocol_products carry gates.noRainOrIrrigationHours = 3 (migration
//    20261006190100), which the Fast Complete sheet prints as "No rain or
//    irrigation for 3 hours after the spray." Those rows go to 24, compare-
//    and-set on the seeded 3 (an edited value is left alone), one audit row
//    each. The v13 recipe text (server/config/lawn-protocol-v13.json) is edited
//    in the same PR.
const { recordAuditEvent } = require('../../services/audit-log');

const MIGRATION = '20261009180000_watering_rule_herbicide_24h_hold_followup';
const SOURCE_ACTION = 'migration:20261009120000_watering_rule_herbicide_24h_hold:corrected';

// A rule the seed migrations wrote (or one with no provenance at all):
// verified_by absent, or one of the label-check markers. Anything else is an
// admin's own edit.
function seededProvenance(rule) {
  const by = rule && typeof rule === 'object' ? rule.verified_by : null;
  return by == null || by === '' || /^label-check-\d{4}-\d{2}-\d{2}$/.test(String(by));
}

function parseJson(value) {
  if (value == null) return null;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return null; }
}

async function audit(knex, kind, resourceType, resourceId, metadata) {
  await recordAuditEvent({
    actor_type: 'system',
    action: `migration:${MIGRATION}:${kind}`,
    resource_type: resourceType,
    resource_id: String(resourceId),
    metadata: { migration: MIGRATION, ...metadata },
    critical: true,
    trx: knex,
  });
}

// 1. Put back the admin-authored rules the first file overwrote.
async function restoreAdminRules(knex, canAudit) {
  if (!canAudit) return;
  const events = await knex('audit_log').where({ action: SOURCE_ACTION }).select('resource_id', 'metadata');
  for (const event of events) {
    const meta = parseJson(event.metadata) || {};
    const before = parseJson(meta.before);
    const after = parseJson(meta.after);
    if (!before || !after || seededProvenance(before)) continue;
    const updated = await knex('products_catalog')
      .where({ id: event.resource_id })
      .whereRaw('post_application_watering = ?::jsonb', [JSON.stringify(after)])
      .update({ post_application_watering: JSON.stringify(before), updated_at: knex.fn.now() });
    if (!updated) continue;
    await audit(knex, 'restored', 'products_catalog', event.resource_id, { product: meta.product || null, before: after, after: before });
  }
}

const FIELD_GATE = Object.freeze({ key: 'noRainOrIrrigationHours', before: 3, after: 24 });

// 2. The bermuda-removal field-sheet gate: 3 -> 24 hours on every row still at 3.
async function raiseFieldGate(knex, canAudit) {
  if (!(await knex.schema.hasTable('lawn_protocol_products'))) return;
  const atSeed = (qb) => qb.whereRaw('(gates->>?)::numeric = ?', [FIELD_GATE.key, FIELD_GATE.before]);
  const rows = await atSeed(knex('lawn_protocol_products').whereRaw("gates->>'bermudaRemoval' = 'true'"))
    .select('id', 'product_name');
  for (const row of rows) {
    const updated = await atSeed(knex('lawn_protocol_products').where({ id: row.id }))
      .update({
        gates: knex.raw('jsonb_set(gates, ?, ?::jsonb)', [`{${FIELD_GATE.key}}`, JSON.stringify(FIELD_GATE.after)]),
        updated_at: knex.fn.now(),
      });
    if (!updated || !canAudit) continue;
    await audit(knex, 'field_gate', 'lawn_protocol_products', row.id, { product: row.product_name, gate: FIELD_GATE.key, before: FIELD_GATE.before, after: FIELD_GATE.after });
  }
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('products_catalog'))) return;
  if (!(await knex.schema.hasColumn('products_catalog', 'post_application_watering'))) return;
  const canAudit = await knex.schema.hasTable('audit_log');
  await restoreAdminRules(knex, canAudit);
  await raiseFieldGate(knex, canAudit);
};

// Documented no-op (waves-db SKILL: a data-correction migration whose up()
// preserves admin edits never reverts on rollback). The audit rows keep every
// before value.
exports.down = async function down() {};

exports.seededProvenance = seededProvenance;
exports.FIELD_GATE = FIELD_GATE;
exports.SOURCE_ACTION = SOURCE_ACTION;
