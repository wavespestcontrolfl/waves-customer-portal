/**
 * Copy only a property's proven visit link, including unconfirmed retakes.
 * No current-home inference and no updated_at: dedupe undo treats that as
 * customer activity. Ownership supports an idempotent, value-guarded rollback.
 */
const STATE_KEY = 'migration.20260907000020.state';
const CHUNK = 500;

async function sourceFor(row, knex) {
  const record = row.service_record_id
    ? await knex('service_records').where({ id: row.service_record_id }).first('id', 'customer_id', 'scheduled_service_id')
    : null;
  if (row.service_record_id && !record) return { skip: 'noVisit' };
  if (record && record.customer_id !== row.customer_id) return { skip: 'crossCustomer' };
  if (row.service_id && record?.scheduled_service_id && row.service_id !== record.scheduled_service_id) return { skip: 'conflict' };
  const visitId = row.service_id || record?.scheduled_service_id;
  const visit = visitId ? await knex('scheduled_services').where({ id: visitId }).first('id', 'customer_id', 'property_id') : null;
  if (!visit) return { skip: 'noVisit' };
  if (visit.customer_id !== row.customer_id) return { skip: 'crossCustomer' };
  if (!visit.property_id) return { skip: 'noProperty' };
  const property = await knex('customer_properties').where({ id: visit.property_id, customer_id: row.customer_id }).first('id');
  return property ? { visit, record } : { skip: 'crossCustomer' };
}

function unchangedSource(q, row, visit, record) {
  q.where({ id: row.id, customer_id: row.customer_id }).whereNull('property_id')
    .where({ service_id: row.service_id, service_record_id: row.service_record_id })
    .whereExists(function propertyStillOwned() {
      this.select(1).from('customer_properties').where({ id: visit.property_id, customer_id: row.customer_id });
    })
    .whereExists(function visitStillLinked() {
      this.select(1).from('scheduled_services').where({ id: visit.id, customer_id: row.customer_id, property_id: visit.property_id });
    });
  // Both source paths must preserve the record evidence we inspected, including
  // a previously NULL link. A record re-pointed during the scan is not ours.
  if (record) {
    q.whereExists(function recordStillLinked() {
      this.select(1).from('service_records').where({
        id: record.id, customer_id: row.customer_id, scheduled_service_id: record.scheduled_service_id,
      });
    });
  }
  return q;
}

exports.up = async function up(knex) {
  for (const table of ['lawn_assessments', 'scheduled_services', 'service_records', 'customer_properties', 'system_settings']) {
    if (!(await knex.schema.hasTable(table))) return;
  }
  if (!(await knex.schema.hasColumn('lawn_assessments', 'property_id'))) return;
  if (await knex('system_settings').where({ key: STATE_KEY }).first()) return;
  const state = { linked: {}, skipped: { conflict: 0, noVisit: 0, crossCustomer: 0, noProperty: 0, changed: 0 } };
  let cursor = null;
  for (;;) {
    const query = knex('lawn_assessments').whereNull('property_id')
      .where(function linkedRows() { this.whereNotNull('service_id').orWhereNotNull('service_record_id'); })
      .orderBy('id').limit(CHUNK).select('id', 'customer_id', 'service_id', 'service_record_id');
    if (cursor) query.where('id', '>', cursor);
    const rows = await query;
    if (!rows.length) break;
    for (const row of rows) {
      const source = await sourceFor(row, knex);
      if (source.skip) { state.skipped[source.skip] += 1; continue; }
      const changed = await unchangedSource(knex('lawn_assessments'), row, source.visit, source.record)
        .update({ property_id: source.visit.property_id });
      if (changed) state.linked[row.id] = source.visit.property_id;
      else state.skipped.changed += 1;
    }
    cursor = rows[rows.length - 1].id;
  }
  await knex('system_settings').insert({ key: STATE_KEY, value: JSON.stringify(state) });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('system_settings'))) return;
  const saved = await knex('system_settings').where({ key: STATE_KEY }).first('value');
  if (!saved) return;
  const state = typeof saved.value === 'string' ? JSON.parse(saved.value) : saved.value;
  if (await knex.schema.hasTable('lawn_assessments') && await knex.schema.hasColumn('lawn_assessments', 'property_id')) {
    for (const [id, propertyId] of Object.entries(state.linked || {})) {
      await knex('lawn_assessments').where({ id, property_id: propertyId }).update({ property_id: null });
    }
  }
  await knex('system_settings').where({ key: STATE_KEY, value: saved.value }).del();
};

exports.STATE_KEY = STATE_KEY;
