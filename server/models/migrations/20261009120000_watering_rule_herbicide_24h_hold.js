// Post-application watering rule for every post-emergent herbicide: a 24-hour
// hold (owner ruling 2026-10-09: "24-hour hold for all herbicides", after the
// labels were checked that day).
//
// The labels themselves are looser (Celsius: until the spray has dried;
// Certainty: 2 hours; SedgeHammer: 4 hours; Fusilade II: rainfast in 1 hour;
// Recognition: about 3 hours; Dismiss: not stated), so the rule is OWNER
// sourced and each note keeps the label's own words. Blindside, LESCO
// Three-Way and Drive XLR8 already hold 24 hours on their labels and are left
// as they are. Pre-emergent herbicides are water-in products (Stonewall,
// Dimension) and are not holds, so they are never touched.
//
// Rows are matched by EPA number (Celsius) or catalog name pattern. A row is
// written when it has no rule, or when its rule is a hold SHORTER than 24 hours
// (an until-dry hold with no hours included): a hold already at or past 24
// hours, whatever its source, is stricter or equal and is left alone, as is any
// other mode. mow_hold_days is untouched. Every written row gets an audit_log
// entry with the before and after values (admin-editable compliance field).
const { recordAuditEvent } = require('../../services/audit-log');

const MIGRATION = '20261009120000_watering_rule_herbicide_24h_hold';
const VERIFIED_AT = '2026-10-09T00:00:00.000Z';
const VERIFIED_BY = 'owner-ruling-2026-10-09';
const OWNER_LINE = 'Owner (2026-10-09): no rain or irrigation for 24 hours after every post-emergent herbicide.';

const hold24 = (labelNote) => ({
  mode: 'hold',
  hold_hours: 24,
  source: 'owner',
  label_note: `${labelNote} ${OWNER_LINE}`,
  verified_at: VERIFIED_AT,
  verified_by: VERIFIED_BY,
});

// One entry per product family. `epa` matches products_catalog.epa_reg_number
// exactly; `names` are case-insensitive LIKE patterns on the catalog name.
const ITEMS = [
  { label: 'Celsius WG', epa: ['432-1507'], names: ['Celsius%'],
    rule: hold24('Label: "Do not irrigate until the spray has dried."') },
  { label: 'Certainty Turf Herbicide', names: ['Certainty%'],
    rule: hold24('Label: "Heavy rainfall or irrigation within 2 hours after application may wash this product off the foliage."') },
  { label: 'SedgeHammer / SedgeHammer Plus', epa: ['81880-24'], names: ['Sedge%Hammer%'],
    rule: hold24('Label: "Avoid applications when rainfall is forecasted to occur within 4 hours."') },
  { label: 'Dismiss', names: ['Dismiss%'],
    rule: hold24('Label: post-emergent rainfast and irrigation not stated.') },
  { label: 'Recognition', names: ['Recognition%'],
    rule: hold24('Foliar herbicide (bermuda removal mix with Fusilade II): do not water in; rainfast in about 3 hours.') },
  { label: 'Fusilade II', names: ['Fusilade%'],
    rule: hold24('Foliar herbicide (bermuda removal mix with Recognition): do not water in; rainfast in 1 hour.') },
];

function parseRule(value) {
  if (value == null) return null;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return null; }
}

// A row needs the 24-hour hold when it has no rule, or a hold shorter than 24
// hours (hold_hours null or below 24, which covers an until-dry hold).
function needsHold24(current) {
  if (current == null) return true;
  if (!current || typeof current !== 'object' || current.mode !== 'hold') return false;
  const hours = Number(current.hold_hours);
  return !Number.isFinite(hours) || hours < 24;
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('products_catalog'))) return;
  if (!(await knex.schema.hasColumn('products_catalog', 'post_application_watering'))) return;
  const hasEpa = await knex.schema.hasColumn('products_catalog', 'epa_reg_number');
  const canAudit = await knex.schema.hasTable('audit_log');

  for (const item of ITEMS) {
    const rows = await knex('products_catalog')
      .where((qb) => {
        for (const pattern of item.names) qb.orWhere('name', 'ilike', pattern);
        if (hasEpa && item.epa) for (const epa of item.epa) qb.orWhere('epa_reg_number', epa);
      })
      .select('id', 'name', 'post_application_watering');

    for (const row of rows) {
      const before = parseRule(row.post_application_watering);
      if (!needsHold24(before)) continue;
      // Write only if the row still holds the value just read (a concurrent
      // admin edit is never overwritten).
      const query = knex('products_catalog').where({ id: row.id });
      if (before == null) query.whereNull('post_application_watering');
      else query.whereRaw('post_application_watering = ?::jsonb', [JSON.stringify(before)]);
      const updated = await query.update({ post_application_watering: JSON.stringify(item.rule), updated_at: knex.fn.now() });
      if (!updated || !canAudit) continue;
      // audit_log.actor_id is a uuid column: the migration identifies itself in
      // action + metadata, as the other data migrations do.
      await recordAuditEvent({
        actor_type: 'system',
        action: `migration:${MIGRATION}:${before == null ? 'seeded' : 'corrected'}`,
        resource_type: 'products_catalog',
        resource_id: String(row.id),
        metadata: { migration: MIGRATION, product: row.name, before, after: item.rule },
        critical: true,
        trx: knex,
      });
    }
  }
};

// Documented no-op (waves-db SKILL: a data-correction migration whose up()
// preserves admin edits never reverts on rollback). The rows it replaced were
// label holds the owner overruled, and an equal value cannot prove an admin did
// not confirm it after deploy. The audit_log rows keep the before values.
exports.down = async function down() {};

// For the test that proves every rule here is one resolveWateringRule accepts.
exports.ITEMS = ITEMS;
exports.needsHold24 = needsHold24;
