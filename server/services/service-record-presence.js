// Does a scheduled visit have a completion (service_records) row?
//
// Two shapes exist: the FK backlink (scheduled_service_id, since migration
// 20260427000007) and pre-FK legacy rows with a NULL backlink that only the
// (customer_id, service_date, service_type) tuple ties to a visit — the same
// tuple job-costing's resolveServiceRecord soft-joins on. Migration
// 20260903000040 stamps the backlink where that tuple is unique; ambiguous
// tuples stay NULL on purpose, and THIS helper is what keeps them from being
// re-completed: a visit that matches ANY legacy record counts as having a
// record (no "Closeout owed" cue, no automated leak row), because the
// completion guard in completion-attempts.js checks the FK only and a resume
// under a fresh key would mint a second record + repeat invoice / SMS side
// effects (Codex #3799 r4 P0). Those rows are reconciled by hand from the
// record itself. Shared by the dispatch day / week / list feeds and Billing
// Recovery so every reader agrees on what "has a record" means.
//
// `ss` is the scheduled_services alias in the calling query.
function legacyServiceRecordExistsSql(ss = 'scheduled_services') {
  return `EXISTS (SELECT 1 FROM service_records lsr
    WHERE lsr.scheduled_service_id IS NULL
      AND lsr.customer_id = ${ss}.customer_id
      AND lsr.service_date = ${ss}.scheduled_date
      AND lsr.service_type = ${ss}.service_type)`;
}

function hasServiceRecordSql(ss = 'scheduled_services') {
  return `(EXISTS (SELECT 1 FROM service_records fsr WHERE fsr.scheduled_service_id = ${ss}.id) OR ${legacyServiceRecordExistsSql(ss)})`;
}

module.exports = { hasServiceRecordSql, legacyServiceRecordExistsSql };
