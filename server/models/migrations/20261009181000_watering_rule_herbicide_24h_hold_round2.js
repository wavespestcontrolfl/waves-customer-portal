// Round 2 of the herbicide 24-hour hold (Codex round 2 on PR #6243, two P1s).
// 20261009120000 and its follow-up 20261009180000 are both on the PR branch and
// have run on the Railway preview, so both stay byte-identical (waves-db SKILL
// §4) and this file supersedes them in two ways:
//
// 1. The follow-up restored every admin-authored rule the first file had
//    overwritten, `before` wholesale, so an admin rule shorter than 24 hours
//    came back shorter than the owner's ruling. The ruling is a FLOOR: the
//    admin's own conditions (an until-dry condition, the note, the provenance)
//    stay, and hold_hours becomes 24 where it was shorter or absent, with the
//    owner line appended to the note. Found through the follow-up's own audit
//    rows (`...:restored`, whose `after` is the restored admin rule), applied
//    only where the product's rule is still exactly that restored value (a
//    later admin edit is never touched). Audited as `floored`.
//
// 2. The first file replaced Celsius WG's label rule ("Do not irrigate until
//    the spray has dried", stored as hold_until 'dry') with a plain 24-hour
//    clock hold, dropping the drying condition its own note still quotes. The
//    instruction builder prints a timed minimum AND the drying condition
//    together ("until Sat 10 AM, and not before today's treatment has dried"),
//    so the label condition comes back beside the 24-hour floor. Applied only
//    where the rule is still exactly what the first file wrote. Audited as
//    `celsius_dry`.
const { recordAuditEvent } = require('../../services/audit-log');

const MIGRATION = '20261009181000_watering_rule_herbicide_24h_hold_round2';
const RESTORED_ACTION = 'migration:20261009180000_watering_rule_herbicide_24h_hold_followup:restored';
const OWNER_LINE = 'Owner (2026-10-09): no rain or irrigation for 24 hours after every post-emergent herbicide.';

// Exactly what 20261009120000 wrote to Celsius WG (its ITEMS[0].rule; pinned
// by the test so the two files cannot drift apart).
const CELSIUS_FIRST_FILE_RULE = {
  mode: 'hold',
  hold_hours: 24,
  source: 'owner',
  label_note: `Label: "Do not irrigate until the spray has dried." ${OWNER_LINE}`,
  verified_at: '2026-10-09T00:00:00.000Z',
  verified_by: 'owner-ruling-2026-10-09',
};
const CELSIUS_RULE = { ...CELSIUS_FIRST_FILE_RULE, hold_until: 'dry' };

function parseJson(value) {
  if (value == null) return null;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return null; }
}

// The owner floor on an admin-authored hold: its conditions and provenance
// stay; hold_hours becomes 24 where shorter or absent; the note says why.
function floored(rule) {
  const hours = Number(rule.hold_hours);
  if (rule.mode !== 'hold' || (Number.isFinite(hours) && hours >= 24)) return null;
  const note = typeof rule.label_note === 'string' && rule.label_note.trim() ? rule.label_note.trim() : '';
  return { ...rule, hold_hours: 24, label_note: note.includes(OWNER_LINE) ? note : `${note}${note ? ' ' : ''}${OWNER_LINE}` };
}

async function audit(knex, kind, resourceId, metadata) {
  await recordAuditEvent({
    actor_type: 'system',
    action: `migration:${MIGRATION}:${kind}`,
    resource_type: 'products_catalog',
    resource_id: String(resourceId),
    metadata: { migration: MIGRATION, ...metadata },
    critical: true,
    trx: knex,
  });
}

// Compare-and-set on the whole JSON value; false when the row has moved on.
async function replaceExact(knex, id, before, after) {
  const updated = await knex('products_catalog')
    .where({ id })
    .whereRaw('post_application_watering = ?::jsonb', [JSON.stringify(before)])
    .update({ post_application_watering: JSON.stringify(after), updated_at: knex.fn.now() });
  return updated > 0;
}

// 1. The 24-hour floor on the admin rules the follow-up restored.
async function floorRestoredAdminRules(knex, canAudit) {
  if (!canAudit) return;
  const events = await knex('audit_log').where({ action: RESTORED_ACTION }).select('resource_id', 'metadata');
  for (const event of events) {
    const meta = parseJson(event.metadata) || {};
    const restored = parseJson(meta.after);
    if (!restored) continue;
    const after = floored(restored);
    if (!after) continue;
    if (!(await replaceExact(knex, event.resource_id, restored, after))) continue;
    await audit(knex, 'floored', event.resource_id, { product: meta.product || null, before: restored, after });
  }
}

// 2. Celsius keeps its label's drying condition beside the 24-hour floor.
async function restoreCelsiusDry(knex, canAudit) {
  const hasEpa = await knex.schema.hasColumn('products_catalog', 'epa_reg_number');
  const rows = await knex('products_catalog')
    .where((qb) => {
      qb.orWhere('name', 'ilike', 'Celsius%');
      if (hasEpa) qb.orWhere('epa_reg_number', '432-1507');
    })
    .whereRaw('post_application_watering = ?::jsonb', [JSON.stringify(CELSIUS_FIRST_FILE_RULE)])
    .select('id', 'name');
  for (const row of rows) {
    if (!(await replaceExact(knex, row.id, CELSIUS_FIRST_FILE_RULE, CELSIUS_RULE))) continue;
    if (canAudit) await audit(knex, 'celsius_dry', row.id, { product: row.name, before: CELSIUS_FIRST_FILE_RULE, after: CELSIUS_RULE });
  }
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('products_catalog'))) return;
  if (!(await knex.schema.hasColumn('products_catalog', 'post_application_watering'))) return;
  const canAudit = await knex.schema.hasTable('audit_log');
  await floorRestoredAdminRules(knex, canAudit);
  await restoreCelsiusDry(knex, canAudit);
};

// Documented no-op (waves-db SKILL: a data-correction migration whose up()
// preserves admin edits never reverts on rollback). The audit rows keep every
// before value.
exports.down = async function down() {};

exports.floored = floored;
exports.CELSIUS_FIRST_FILE_RULE = CELSIUS_FIRST_FILE_RULE;
exports.CELSIUS_RULE = CELSIUS_RULE;
exports.RESTORED_ACTION = RESTORED_ACTION;
exports.OWNER_LINE = OWNER_LINE;
