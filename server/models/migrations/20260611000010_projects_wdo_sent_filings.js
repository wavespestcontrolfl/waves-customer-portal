/**
 * projects.wdo_sent_filings — immutable archive index of every FDACS-13645
 * PDF actually emailed for a WDO inspection report.
 *
 * The send routes regenerate the PDF from live findings on every send, so
 * without this there is no durable record of what was actually filed in the
 * real-estate transaction. Each successful send uploads the exact emailed PDF
 * to S3 BEFORE delivery and appends an entry here on success:
 *
 *   { s3_key, sha256, sent_at, source ('send' | 'send_with_invoice'),
 *     invoice_id, sent_by_tech_id, signer_name, signed_at, content_hash,
 *     findings (as-sent snapshot), project_date }
 *
 * The public token viewer serves the latest entry's findings snapshot for WDO
 * projects so the web report can't silently diverge from the emailed signed
 * PDF, and admins can list/download archived filings via
 * GET /api/admin/projects/:id/wdo-filings.
 */

exports.up = async function (knex) {
  const has = await knex.schema.hasColumn('projects', 'wdo_sent_filings');
  if (has) return;
  await knex.schema.alterTable('projects', (t) => {
    t.jsonb('wdo_sent_filings');
  });
};

exports.down = async function (knex) {
  const has = await knex.schema.hasColumn('projects', 'wdo_sent_filings');
  if (!has) return;
  await knex.schema.alterTable('projects', (t) => {
    t.dropColumn('wdo_sent_filings');
  });
};
