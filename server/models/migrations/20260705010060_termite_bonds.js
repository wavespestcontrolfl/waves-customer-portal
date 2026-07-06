'use strict';

/**
 * Termite bond tracking (owner directive 2026-07-06): bonds exist today
 * only as service names on visits ("Termite Bond Service (1-Year Term)" /
 * 5-Year / 10-Year, plus combined labels) — no renewal date lives
 * anywhere, so the bond-renewal email had nothing to cron against.
 *
 * One row per bond-establishing COMPLETED visit: term parsed from the
 * service name ("(N-Year Term)", defaulting to 1 when the label carries
 * no term — e.g. "Quarterly Termite Bait Station + Termite Bond
 * Service"); renews_at = completion + term years. The lifecycle sweep
 * (lifecycle-email-sweeps.js) keeps this table in sync going forward by
 * inserting rows for newly completed bond visits, so no completion-path
 * code changes are needed.
 *
 * Backfill note: prod has ZERO completed bond visits as of 2026-07-06,
 * so the backfill is a forward-looking no-op today.
 */

const BOND_MATCH = '%Termite Bond Service%';

// DATE columns reflect the ET business calendar (same rule as the runtime
// sweep in lifecycle-email-sweeps.js): a visit completed after 8 PM Eastern
// has a completed_at already on the next UTC day, so UTC ISO slices would
// backfill started_at/renews_at a day late and shift the renewal notice.
function etDateString(date) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
}

function termYearsFrom(serviceType) {
  const m = String(serviceType || '').match(/(\d+)\s*-\s*Year/i);
  return m ? Number(m[1]) : 1;
}

exports.up = async function up(knex) {
  const has = await knex.schema.hasTable('termite_bonds');
  if (!has) {
    await knex.schema.createTable('termite_bonds', (t) => {
      t.increments('id').primary();
      // customers.id / scheduled_services.id are UUIDs (initial schema) —
      // the sweep joins these columns back to them.
      t.uuid('customer_id').notNullable().index()
        .references('id').inTable('customers').onDelete('CASCADE');
      t.uuid('scheduled_service_id').unique()
        .references('id').inTable('scheduled_services').onDelete('SET NULL');
      t.string('service_type').notNullable();
      t.integer('term_years').notNullable().defaultTo(1);
      t.date('started_at').notNullable();
      t.date('renews_at').notNullable().index();
      t.string('status').notNullable().defaultTo('active');
      t.timestamp('renewal_notified_at').nullable();
      t.timestamps(true, true);
    });
  }

  if (!(await knex.schema.hasTable('scheduled_services'))) return;
  const visits = await knex('scheduled_services')
    .where('status', 'completed')
    .where('service_type', 'ilike', BOND_MATCH)
    .select('id', 'customer_id', 'service_type', 'completed_at', 'scheduled_date');
  for (const v of visits) {
    const existing = await knex('termite_bonds').where({ scheduled_service_id: v.id }).first('id');
    if (existing) continue;
    const startedRaw = v.completed_at || v.scheduled_date;
    if (!startedRaw || !v.customer_id) continue;
    const started = new Date(startedRaw);
    if (Number.isNaN(started.getTime())) continue;
    const years = termYearsFrom(v.service_type);
    const startedEt = etDateString(started);
    const [sy, sm, sd] = startedEt.split('-').map(Number);
    const renewsEt = new Date(Date.UTC(sy + years, sm - 1, sd)).toISOString().slice(0, 10);
    await knex('termite_bonds').insert({
      customer_id: v.customer_id,
      scheduled_service_id: v.id,
      service_type: v.service_type,
      term_years: years,
      started_at: startedEt,
      renews_at: renewsEt,
      status: 'active',
    });
  }
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('termite_bonds');
};
