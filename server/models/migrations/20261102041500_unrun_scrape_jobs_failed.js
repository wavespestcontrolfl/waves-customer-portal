// Scrape jobs the manual trigger recorded as "completed" although no scrape ran (metrics audit 2026-11-01).
// No price scraper was ever connected. POST /admin/inventory/scrape-jobs/:vendorId/trigger, the only writer of
// price_scrape_jobs and of vendors.last_scrape_*, inserted a pending job, marked the vendor "running", then in the
// same request marked the job completed with zero results and no duration and the vendor "completed". Those rows
// are the whole "completed" count on the Scrape Jobs card. Each such job becomes failed with the reason (a job left
// pending because its completion update never ran is closed the same way), and the vendors it marked lose the
// status and the time, so their badge reads "never". One audit event lists every row changed and its old values.
const NEVER_RAN = 'Never ran: no price scraper is connected.';
const AUDIT_ACTION = 'migration:20261102041500:unrun_scrape_jobs_failed';
const NO_RESULTS = `coalesce(products_found, 0) = 0 AND coalesce(prices_updated, 0) = 0 AND coalesce(prices_new, 0) = 0
  AND coalesce(errors, 0) = 0 AND coalesce(duration_ms, 0) = 0`;

exports.NEVER_RAN = NEVER_RAN;
exports.AUDIT_ACTION = AUDIT_ACTION;

exports.up = async function up(knex) {
  const jobs = await knex('price_scrape_jobs').whereIn('status', ['pending', 'completed']).whereRaw(NO_RESULTS).select('id', 'status');
  const vendors = await knex('vendors').whereIn('last_scrape_status', ['running', 'completed'])
    .select('id', 'last_scrape_status', 'last_scrape_at');
  if (!jobs.length && !vendors.length) return;
  if (jobs.length) {
    await knex('price_scrape_jobs').whereIn('id', jobs.map((job) => job.id)).update({ status: 'failed', error_message: NEVER_RAN });
  }
  if (vendors.length) {
    await knex('vendors').whereIn('id', vendors.map((vendor) => vendor.id)).update({ last_scrape_status: null, last_scrape_at: null });
  }
  const { recordAuditEvent } = require('../../services/audit-log');
  await recordAuditEvent({
    actor_type: 'system:migration',
    action: AUDIT_ACTION,
    resource_type: 'price_scrape_jobs',
    critical: true,
    trx: knex,
    metadata: { reason: NEVER_RAN, jobs, vendors },
  });
};

// Down puts back exactly what up changed, read from up's audit event, on rows still as up left them, and appends a
// rollback event (audit_log is append-only).
exports.down = async function down(knex) {
  const event = await knex('audit_log').where({ action: AUDIT_ACTION }).orderBy('created_at', 'desc').first('id', 'metadata');
  if (!event) return;
  const metadata = typeof event.metadata === 'string' ? JSON.parse(event.metadata) : (event.metadata || {});
  for (const job of metadata.jobs || []) {
    await knex('price_scrape_jobs').where({ id: job.id, status: 'failed', error_message: NEVER_RAN })
      .update({ status: job.status, error_message: null });
  }
  for (const vendor of metadata.vendors || []) {
    await knex('vendors').where({ id: vendor.id }).whereNull('last_scrape_status').whereNull('last_scrape_at')
      .update({ last_scrape_status: vendor.last_scrape_status, last_scrape_at: vendor.last_scrape_at });
  }
  const { recordAuditEvent } = require('../../services/audit-log');
  await recordAuditEvent({
    actor_type: 'system:migration',
    action: `${AUDIT_ACTION}:down`,
    resource_type: 'price_scrape_jobs',
    critical: true,
    trx: knex,
    metadata: { restored_from_audit_id: event.id },
  });
};
