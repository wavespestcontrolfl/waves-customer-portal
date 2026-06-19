/**
 * Waves Assessment — single internal-only consultation.
 *
 * Per owner, the assessment lineup is simplified to ONE catch-all service:
 * the existing "Lawn Assessment" (service_key `lawn_inspection`) is renamed
 * to "Waves Assessment" and converted from its typed lawn-findings report
 * into an internal-only consultation:
 *
 *   - completion_mode = 'internal_only' — an advisory walkthrough, not a
 *     treatment. The completion path (admin-dispatch `/complete` via
 *     resolveCompletionDeliveryPosture) suppresses every customer-facing
 *     artifact (no report token/PDF, no completion SMS/email, no review
 *     request, no Pest Pressure) while still writing the service_records
 *     audit row.
 *   - project_type cleared (no typed findings form).
 *   - portal_visibility 'internal_only' / portal_attach_policy 'never'.
 *
 * Pricing is left untouched — the row is already variable / base_price NULL
 * (no $ amount, no fixed-price lock), which is the desired consultation shape.
 *
 * Read-modify-write: only the fields that define the consultation posture are
 * updated, so admin edits to other columns (follow-up policy, etc.) survive.
 * The profile is keyed by the ACTUAL renamed service_key (not a hardcoded
 * 'lawn_inspection') so a drifted key still receives the internal-only flip.
 *
 * Already-scheduled assessment visits carry a denormalized
 * `scheduled_services.service_type` snapshot; the completion path derives its
 * service line from that string, so leaving stale "Lawn Assessment" labels
 * would keep queued visits on the lawn-assessment / turf-height gates. We
 * backfill the label on non-terminal scheduled rows so they get the same
 * gate-free consultation flow as new "Waves Assessment" visits.
 *
 * `down` is intentionally a no-op — reversing the rename/mode could clobber
 * newer Service Library UI edits, and the typed lawn-findings cutover this
 * replaces was itself a forward-only migration.
 */
const OLD_ASSESSMENT_LABELS = ['Lawn Assessment', 'Lawn Assessment Service'];
// Open (still-to-be-completed) visit statuses — the only rows whose
// denormalized label we relabel. An explicit allowlist (rather than a
// terminal denylist) guarantees we never rewrite a closed visit's history
// (completed / cancelled / rescheduled / skipped / no_show), even if new
// closed statuses are added later.
const OPEN_VISIT_STATUSES = ['pending', 'confirmed', 'en_route', 'on_site'];

const WAVES_ASSESSMENT_DESCRIPTION =
  'Advisory walkthrough of the property to evaluate lawn and/or pest conditions and recommend a plan. Findings are reviewed with the customer; no treatment is performed during the visit.';

exports.up = async function (knex) {
  // ── 1) Rename Lawn Assessment → Waves Assessment (capture the real key) ──
  // Also replace the old lawn-specific description: the public tracker
  // (track-public.js) surfaces services.description as the customer-facing
  // summary, so stale "comprehensive lawn evaluation" copy would mislead on
  // the new catch-all assessment.
  const renameFields = {
    name: 'Waves Assessment',
    short_name: 'Waves Assess',
    description: WAVES_ASSESSMENT_DESCRIPTION,
  };
  let serviceKey = null;
  const byKey = await knex('services').where('service_key', 'lawn_inspection').first('service_key', 'id');
  let serviceId = null;
  if (byKey) {
    serviceKey = byKey.service_key;
    serviceId = byKey.id;
    await knex('services')
      .where('service_key', serviceKey)
      .update(renameFields);
  } else {
    // Fallback for any env where the key drifted: match the post-#1912 name.
    const byName = await knex('services').where('name', 'Lawn Assessment').first('service_key', 'id');
    if (byName) {
      serviceKey = byName.service_key;
      serviceId = byName.id;
      await knex('services')
        .where('service_key', serviceKey)
        .update(renameFields);
    }
  }

  // Nothing to convert in this env (no such service) — done.
  if (!serviceKey) return;

  // ── 2) Convert the completion profile to an internal-only consultation ──
  if (await knex.schema.hasTable('service_completion_profiles')) {
    const consultationFields = {
      service_name_snapshot: 'Waves Assessment',
      completion_mode: 'internal_only',
      project_type: null,
      creates_service_record: true,
      portal_visibility: 'internal_only',
      portal_attach_policy: 'never',
      updated_at: knex.fn.now(),
    };
    const existing = await knex('service_completion_profiles')
      .where({ service_key: serviceKey })
      .first();
    if (existing) {
      await knex('service_completion_profiles')
        .where({ service_key: serviceKey })
        .update(consultationFields);
    } else {
      // No profile row in this env — create one in the consultation shape.
      const catalog = await knex('services')
        .where('service_key', serviceKey)
        .first('category', 'billing_type');
      await knex('service_completion_profiles').insert({
        service_key: serviceKey,
        category: catalog?.category || 'inspection',
        billing_type: catalog?.billing_type || 'one_time',
        followup_policy: 'none',
        active: true,
        notes: 'Waves Assessment: internal-only consultation (no customer-facing report).',
        ...consultationFields,
      });
    }
  }

  // ── 3) Backfill the denormalized label on OPEN scheduled visits only ──
  if (await knex.schema.hasColumn('scheduled_services', 'service_type')) {
    // Linked rows (reliable): match by service_id.
    if (serviceId) {
      await knex('scheduled_services')
        .where({ service_id: serviceId })
        .whereIn('status', OPEN_VISIT_STATUSES)
        .update({ service_type: 'Waves Assessment' });
    }
    // Legacy/unlinked rows: match by the old denormalized label.
    await knex('scheduled_services')
      .whereIn('service_type', OLD_ASSESSMENT_LABELS)
      .whereIn('status', OPEN_VISIT_STATUSES)
      .update({ service_type: 'Waves Assessment' });
  }
};

exports.down = async function () {
  // Intentional no-op. See header comment.
};
