/**
 * Rename "Lawn Assessment Service" → "Lawn Assessment".
 *
 * Per owner, the trailing "Service" is dropped from the assessment's name.
 * This is a pure relabel of the existing catalog row (service_key
 * `lawn_inspection`); its pricing, category, and completion behavior are
 * unchanged.
 *
 * The sibling assessments (Pest Control Assessment, Lawn and Pest Control
 * Assessment) are intentionally NOT created here. They are meant to complete
 * as internal-only consultations, which is a coupled change to the core
 * completion handler — without it, a new row would fall back to
 * DEFAULT_SERVICE_REPORT_PROFILE and send a customer-facing Service Report.
 * Seeding them merely inactive isn't an airtight guard (the completion
 * resolver and admin-schedule.js don't check `is_active`), so the new
 * services are created AND wired to the consultation flow together in a
 * dedicated follow-up PR.
 *
 * The rename is read-modify-write so admin edits to other columns survive.
 *
 * `down` is intentionally a no-op — reversing the rename would risk
 * clobbering newer edits made through the Service Library UI.
 */
exports.up = async function (knex) {
  // ── Rename the existing Lawn Assessment (drop trailing "Service") ──
  // Prefer the stable service_key; fall back to the known name for any env
  // where the key drifted.
  const lawn = await knex('services').where('service_key', 'lawn_inspection').first();
  if (lawn) {
    await knex('services')
      .where('service_key', 'lawn_inspection')
      .update({ name: 'Lawn Assessment', short_name: 'Lawn Assess' });
  } else {
    await knex('services')
      .where('name', 'Lawn Assessment Service')
      .update({ name: 'Lawn Assessment', short_name: 'Lawn Assess' });
  }

  // Keep the completion-profile snapshot in step with the rename. The
  // profile row's `service_name_snapshot` is what `serializeProfile` returns
  // as `serviceName`, which the typed-report builder uses as the
  // customer-facing service label — leave it stale and new lawn assessment
  // reports keep rendering the old "Lawn Assessment Service" heading. Match on
  // the OLD snapshot value rather than a hardcoded service_key so a drifted
  // key (the fallback rename branch above) is still corrected.
  if (await knex.schema.hasTable('service_completion_profiles')) {
    await knex('service_completion_profiles')
      .where({ service_name_snapshot: 'Lawn Assessment Service' })
      .update({ service_name_snapshot: 'Lawn Assessment', updated_at: knex.fn.now() });
  }
};

exports.down = async function () {
  // Intentional no-op. See header comment.
};
