/**
 * Hermes agent watchdog — audit-enum expansion.
 *
 * The external watchdog (docs/hermes/waves-agent-watchdog-skill.md) polls
 * GET /api/integrations/watchdog-worker/status through link-worker-auth, so
 * every poll writes a seo_link_worker_requests row like any other worker
 * request. Two CHECK-constrained enums grow by one value each:
 *   endpoint += 'watchdog'   (the capability the hermes_watchdog key holds)
 *   result   += 'observed'   (a served snapshot — the row IS the heartbeat the
 *                             reciprocal liveness cron reads)
 * EXPAND only: no drops of existing values, no data rewrites. Down restores
 * the prior sets; the rows that only this lane can write (endpoint='watchdog')
 * are removed first, because they cannot satisfy the restored constraint and
 * mean nothing once the lane is gone (they are watchdog heartbeats, not
 * prospect evidence).
 */

const ENDPOINTS = ['claim', 'report', 'vendor_price', 'vendor_login'];
const RESULTS = ['authenticated', 'empty_claim', 'leased', 'report_accepted', 'report_rejected'];

const inSet = (col, values) => `${col} IN (${values.map((v) => `'${v}'`).join(', ')})`;
const replaceCheck = async (knex, name, expr) => {
  await knex.raw(`ALTER TABLE seo_link_worker_requests DROP CONSTRAINT IF EXISTS ${name}`);
  await knex.raw(`ALTER TABLE seo_link_worker_requests ADD CONSTRAINT ${name} CHECK (${expr})`);
};

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('seo_link_worker_requests'))) return;
  await replaceCheck(knex, 'seo_link_worker_requests_endpoint_check', inSet('endpoint', [...ENDPOINTS, 'watchdog']));
  await replaceCheck(knex, 'seo_link_worker_requests_result_check', inSet('result', [...RESULTS, 'observed']));
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('seo_link_worker_requests'))) return;
  await knex('seo_link_worker_requests').where({ endpoint: 'watchdog' }).del();
  await replaceCheck(knex, 'seo_link_worker_requests_endpoint_check', inSet('endpoint', ENDPOINTS));
  await replaceCheck(knex, 'seo_link_worker_requests_result_check', inSet('result', RESULTS));
};
