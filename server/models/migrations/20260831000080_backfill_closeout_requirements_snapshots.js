/**
 * One-time backfill: freeze closeout requirements for COMPLETED historical
 * service_records that predate the completion-time snapshot
 * (structured_notes.closeoutRequirements, service-closeout-requirements.js).
 *
 * Owner decision 2026-08-31: historical verdicts stop being rewritable by
 * catalog edits, at the cost of freezing TODAY'S catalog as the historical
 * truth. The snapshot is honest about that: `source` is
 * 'backfilled_from_live_catalog' (never a completion-time source) and
 * `catalogSource` preserves the row's closeout_requirements_source, so a
 * reader can always tell a true completion-time freeze from this guess.
 *
 * Only status='completed' records are stamped — an 'incomplete' record's
 * eventual completion must write its own completion-time freeze, and the
 * writers' first-freeze-wins merge would otherwise keep this backfill stamp
 * instead.
 *
 * Idempotent: the `-> 'closeoutRequirements' IS NULL` guard skips rows that
 * already carry the key (a re-run, or a row frozen by the new writers
 * between deploy and this migration). Set-based per catalog identity — one
 * UPDATE per distinct (service_id, service_type) combo; structured_notes is
 * jsonb (verified against the live schema), so the merge is a plain
 * `||` with no casts.
 *
 * down(): removes ONLY backfilled snapshots (source guard) — a true
 * completion-time freeze is never deleted.
 */
const {
  resolveCloseoutRequirementsForJobs,
} = require('../../services/service-closeout-requirements');

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('service_records'))) return;
  if (!(await knex.schema.hasColumn('service_records', 'structured_notes'))) return;

  const combos = await knex('service_records as sr')
    .leftJoin('scheduled_services as ss', 'sr.scheduled_service_id', 'ss.id')
    .where('sr.status', 'completed')
    .whereRaw(`(sr.structured_notes -> 'closeoutRequirements') IS NULL`)
    .distinct(
      knex.raw('ss.service_id AS service_id'),
      knex.raw('COALESCE(ss.service_type, sr.service_type) AS service_type'),
    );

  const frozenAt = new Date().toISOString();
  for (const combo of combos) {
    const map = await resolveCloseoutRequirementsForJobs(
      [{ id: 'combo', service_id: combo.service_id || null, service_type: combo.service_type || null }],
      { knex, strict: true },
    );
    const req = map.get('combo');
    if (!req || typeof req.requiresServiceReport !== 'boolean') continue;
    const snapshot = {
      v: 1,
      frozenAt,
      serviceId: req.serviceId || null,
      serviceName: req.serviceName || null,
      category: req.category || null,
      source: 'backfilled_from_live_catalog',
      catalogSource: req.source || null,
      requiresServiceReport: req.requiresServiceReport === true,
      requiresApplicationLog: req.requiresApplicationLog === true,
      requiredPhotoCount: Number.isFinite(Number(req.requiredPhotoCount))
        ? Math.max(0, Number(req.requiredPhotoCount))
        : 0,
      requiresCustomerSignature: req.requiresCustomerSignature === true,
      requiresCustomerNotice: req.requiresCustomerNotice === true,
      requiresLicense: req.requiresLicense === true,
      licenseCategory: req.licenseCategory || null,
    };

    await knex.raw(
      `UPDATE service_records sr
          SET structured_notes = COALESCE(sr.structured_notes, '{}'::jsonb)
              || jsonb_build_object('closeoutRequirements', :snapshot::jsonb)
        FROM (
          SELECT sr2.id
            FROM service_records sr2
            LEFT JOIN scheduled_services ss ON sr2.scheduled_service_id = ss.id
           WHERE sr2.status = 'completed'
             AND (sr2.structured_notes -> 'closeoutRequirements') IS NULL
             AND ss.service_id IS NOT DISTINCT FROM :serviceId
             AND COALESCE(ss.service_type, sr2.service_type) IS NOT DISTINCT FROM :serviceType
        ) target
        WHERE sr.id = target.id`,
      {
        snapshot: JSON.stringify(snapshot),
        serviceId: combo.service_id || null,
        serviceType: combo.service_type || null,
      },
    );
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('service_records'))) return;
  if (!(await knex.schema.hasColumn('service_records', 'structured_notes'))) return;
  // Remove ONLY backfilled snapshots — completion-time freezes stay.
  await knex.raw(
    `UPDATE service_records
        SET structured_notes = structured_notes - 'closeoutRequirements'
      WHERE structured_notes -> 'closeoutRequirements' ->> 'source' = 'backfilled_from_live_catalog'`,
  );
};
