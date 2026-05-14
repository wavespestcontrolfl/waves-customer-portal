/**
 * service_records — durable audit columns for one-tap attestation.
 *
 * The completion attempt holds the resolved snapshot for replay; the
 * service_record holds the same data for long-term audit (regulatory
 * reads, deposition queries, year-over-year reporting). Both copies
 * are intentional — completion_attempts is sized for the active retry
 * window; service_records is the row that lives forever.
 *
 * `tech_attestation_text` is stored verbatim from what the tech saw on
 * the button: the exact protocol name + product list + area list. If
 * the button copy changes in 2027, a 2026 completion's attestation
 * remains exactly what the tech tapped on that day. Pair with
 * protocol_template_version so the read path can also resolve the
 * full immutable template row from `protocol_templates`.
 *
 * `customer_interaction_source` records WHETHER the tech confirmed the
 * customer interaction or whether the system inferred it. Three valid
 * values:
 *   - tech_confirmed_at_completion
 *   - inferred_from_last_visit
 *   - inferred_from_scheduled_note
 * Distinguishing these matters when a customer disputes a visit
 * ("I was home, nobody knocked"): an attested record reads differently
 * from a system-inferred one.
 *
 * `review_gbp_resolved` + `review_routing_reason` surface the GBP
 * decision that was previously private to review-request.js. This
 * gives the audit trail a clear answer to "which Google location did
 * this customer get routed to and why?"
 */

exports.up = async function (knex) {
  await knex.schema.alterTable('service_records', (t) => {
    t.string('completion_source', 32);
    t.boolean('protocol_defaults_used').notNullable().defaultTo(false);
    t.uuid('protocol_template_id')
      .references('id').inTable('protocol_templates');
    t.string('protocol_template_version', 40);
    t.string('protocol_name', 160);
    t.text('tech_attestation_text');
    t.string('tech_attestation_version', 20);
    t.string('customer_interaction_source', 40);
    t.string('review_gbp_resolved', 40);
    t.string('review_routing_reason', 80);
    t.jsonb('resolved_completion_snapshot');
  });

  await knex.raw(`
    ALTER TABLE service_records
    ADD CONSTRAINT service_records_completion_source_check
    CHECK (
      completion_source IS NULL OR completion_source IN (
        'one_tap_completion',
        'detailed_form'
      )
    )
  `);

  await knex.raw(`
    ALTER TABLE service_records
    ADD CONSTRAINT service_records_customer_interaction_source_check
    CHECK (
      customer_interaction_source IS NULL OR customer_interaction_source IN (
        'tech_confirmed_at_completion',
        'inferred_from_last_visit',
        'inferred_from_scheduled_note'
      )
    )
  `);

  // One-tap records must carry the attestation + template reference
  // AND the durable resolved snapshot bytes themselves. The snapshot
  // is the long-term audit record of what the tech actually attested
  // to (products, areas, customer-interaction source, review routing);
  // a one_tap row without it would still satisfy attestation/template
  // checks but lose the structured evidence.
  // Detailed_form records carry none of the attestation fields. Mixed
  // states are rejected.
  await knex.raw(`
    ALTER TABLE service_records
    ADD CONSTRAINT service_records_one_tap_has_attestation
    CHECK (
      completion_source IS DISTINCT FROM 'one_tap_completion'
      OR (
        protocol_defaults_used = true
        AND protocol_template_id IS NOT NULL
        AND protocol_template_version IS NOT NULL
        AND tech_attestation_text IS NOT NULL
        AND tech_attestation_version IS NOT NULL
        AND protocol_name IS NOT NULL
        AND resolved_completion_snapshot IS NOT NULL
      )
    )
  `);

  // Detailed_form must NOT carry attestation/template fields — those
  // mean "I performed the listed standard protocol," which a custom
  // submission did not. protocol_name is included: a detailed_form
  // row that names a standard protocol would weaken the audit
  // distinction this migration is supposed to enforce.
  // (resolved_completion_snapshot is intentionally allowed on
  // detailed_form rows — both source types use service_records as the
  // long-term audit copy of the resolved bundle.)
  await knex.raw(`
    ALTER TABLE service_records
    ADD CONSTRAINT service_records_detailed_form_no_attestation
    CHECK (
      completion_source IS DISTINCT FROM 'detailed_form'
      OR (
        protocol_defaults_used = false
        AND protocol_template_id IS NULL
        AND protocol_template_version IS NULL
        AND protocol_name IS NULL
        AND tech_attestation_text IS NULL
        AND tech_attestation_version IS NULL
      )
    )
  `);

  // Legacy/NULL-source rows must not silently carry any of the new
  // attestation/template/snapshot fields. The existing one_tap_ and
  // detailed_form CHECKs use IS DISTINCT FROM, and SQL NULL is
  // distinct from both strings — so a row with completion_source=NULL
  // bypasses both predicates and can populate protocol_defaults_used
  // / protocol_template_id / tech_attestation_text /
  // resolved_completion_snapshot freely. That would defeat the audit
  // invariant for any row that lacks a source classification.
  //
  // Two valid populations under this CHECK:
  //   - Pre-migration legacy rows: all new columns null/false.
  //   - Going forward: completion_source must be set whenever any
  //     attestation/template/snapshot field is populated.
  await knex.raw(`
    ALTER TABLE service_records
    ADD CONSTRAINT service_records_null_source_no_attestation
    CHECK (
      completion_source IS NOT NULL
      OR (
        protocol_defaults_used = false
        AND protocol_template_id IS NULL
        AND protocol_template_version IS NULL
        AND protocol_name IS NULL
        AND tech_attestation_text IS NULL
        AND tech_attestation_version IS NULL
        AND resolved_completion_snapshot IS NULL
      )
    )
  `);
};

exports.down = async function (knex) {
  await knex.raw('ALTER TABLE service_records DROP CONSTRAINT IF EXISTS service_records_null_source_no_attestation');
  await knex.raw('ALTER TABLE service_records DROP CONSTRAINT IF EXISTS service_records_detailed_form_no_attestation');
  await knex.raw('ALTER TABLE service_records DROP CONSTRAINT IF EXISTS service_records_one_tap_has_attestation');
  await knex.raw('ALTER TABLE service_records DROP CONSTRAINT IF EXISTS service_records_customer_interaction_source_check');
  await knex.raw('ALTER TABLE service_records DROP CONSTRAINT IF EXISTS service_records_completion_source_check');
  await knex.schema.alterTable('service_records', (t) => {
    t.dropColumn('resolved_completion_snapshot');
    t.dropColumn('review_routing_reason');
    t.dropColumn('review_gbp_resolved');
    t.dropColumn('customer_interaction_source');
    t.dropColumn('tech_attestation_version');
    t.dropColumn('tech_attestation_text');
    t.dropColumn('protocol_name');
    t.dropColumn('protocol_template_version');
    t.dropColumn('protocol_template_id');
    t.dropColumn('protocol_defaults_used');
    t.dropColumn('completion_source');
  });
};
