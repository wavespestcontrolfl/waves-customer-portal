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
 *     request) while still writing the service_records audit row.
 *   - project_type cleared (no typed findings form).
 *   - portal_visibility 'internal_only' / portal_attach_policy 'never'.
 *
 * Pricing is left untouched — the row is already variable / base_price NULL
 * (no $ amount, no fixed-price lock), which is the desired consultation shape.
 *
 * Read-modify-write: only the fields that define the consultation posture are
 * updated, so admin edits to other columns (follow-up policy, etc.) survive.
 *
 * `down` is intentionally a no-op — reversing the rename/mode could clobber
 * newer Service Library UI edits, and the typed lawn-findings cutover this
 * replaces was itself a forward-only migration.
 */
exports.up = async function (knex) {
  // ── 1) Rename Lawn Assessment → Waves Assessment ──
  const svc = await knex('services').where('service_key', 'lawn_inspection').first();
  if (svc) {
    await knex('services')
      .where('service_key', 'lawn_inspection')
      .update({ name: 'Waves Assessment', short_name: 'Waves Assess' });
  } else {
    // Fallback for any env where the key drifted: match the post-#1912 name.
    await knex('services')
      .where('name', 'Lawn Assessment')
      .update({ name: 'Waves Assessment', short_name: 'Waves Assess' });
  }

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
      .where({ service_key: 'lawn_inspection' })
      .first();
    if (existing) {
      await knex('service_completion_profiles')
        .where({ service_key: 'lawn_inspection' })
        .update(consultationFields);
    } else {
      // No profile row in this env — create one in the consultation shape.
      const catalog = await knex('services')
        .where('service_key', 'lawn_inspection')
        .first('category', 'billing_type');
      await knex('service_completion_profiles').insert({
        service_key: 'lawn_inspection',
        category: catalog?.category || 'inspection',
        billing_type: catalog?.billing_type || 'one_time',
        followup_policy: 'none',
        active: true,
        notes: 'Waves Assessment: internal-only consultation (no customer-facing report).',
        ...consultationFields,
      });
    }
  }
};

exports.down = async function () {
  // Intentional no-op. See header comment.
};
