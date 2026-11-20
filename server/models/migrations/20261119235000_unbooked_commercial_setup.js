// The activity row and invoice are written by the same acceptance. Claims are
// mutable afterward, so they are deliberately absent from the sale decision
// except for the invoice/estimate ownership fences below.
const legacyEvidenceCte = `
  WITH conversion_rows AS (
    SELECT t.id AS term_id, cl.id AS claim_id, i.created_at AS invoice_created_at,
      coalesce(cl.estimate_id, t.source_estimate_id) AS estimate_id,
      a.metadata, a.created_at AS evidence_created_at
    FROM annual_prepay_terms t
    JOIN invoices i ON i.id = t.prepay_invoice_id AND i.customer_id = t.customer_id
    JOIN setup_fee_claims cl ON cl.invoice_id = i.id AND cl.amount > 0
    JOIN estimates e ON e.id = coalesce(cl.estimate_id, t.source_estimate_id)
      AND e.customer_id = t.customer_id
    JOIN activity_log a ON a.customer_id = t.customer_id
      AND a.action = 'estimate_converted'
      AND a.description LIKE ('Estimate #' || coalesce(cl.estimate_id, t.source_estimate_id)::text || ' converted:%')
    WHERE i.scheduled_service_id IS NULL
      AND (cl.estimate_id IS NULL OR t.source_estimate_id IS NULL OR cl.estimate_id = t.source_estimate_id)
  ), evidence AS (
    SELECT term_id, claim_id, max(invoice_created_at) AS invoice_created_at,
      min(metadata->>'firstScheduledServiceId') AS occurrence_id,
      bool_and(coalesce(
        metadata->>'estimateId' = estimate_id::text
        AND evidence_created_at <= invoice_created_at
        AND jsonb_typeof(metadata->'firstScheduledServiceId') = 'null'
        AND CASE WHEN jsonb_typeof(metadata->'scheduledCount') = 'number'
          THEN (metadata->>'scheduledCount')::numeric = 0 ELSE false END,
        false
      )) AS proves_zero,
      bool_and(coalesce(
        metadata->>'estimateId' = estimate_id::text
        AND evidence_created_at <= invoice_created_at
        AND jsonb_typeof(metadata->'firstScheduledServiceId') = 'string'
        AND nullif(metadata->>'firstScheduledServiceId', '') IS NOT NULL
        AND CASE WHEN jsonb_typeof(metadata->'scheduledCount') = 'number'
          THEN (metadata->>'scheduledCount')::numeric > 0
            AND (metadata->>'scheduledCount')::numeric = trunc((metadata->>'scheduledCount')::numeric)
          ELSE false END,
        false
      )) AS proves_booked,
      count(DISTINCT metadata->>'firstScheduledServiceId')
        FILTER (WHERE jsonb_typeof(metadata->'firstScheduledServiceId') = 'string') AS occurrence_count
    FROM conversion_rows
    GROUP BY term_id, claim_id, estimate_id
  )
`;

// Keep the one-time backfill on the same sold-service vocabulary as runtime.
// Searching estimate_data::text is unsafe: notes, declined choices and unused
// quote variants can all contain a commercial key without selling it.
async function commercialLegacyClaimIds(knex) {
  const candidates = await knex('annual_prepay_terms as t')
    .join('invoices as i', function invoiceOwner() {
      this.on('i.id', '=', 't.prepay_invoice_id').andOn('i.customer_id', '=', 't.customer_id');
    })
    .join('setup_fee_claims as cl', 'cl.invoice_id', 'i.id')
    .join('estimates as estimate', function estimateOwner() {
      this.on('estimate.id', '=', knex.raw('coalesce(cl.estimate_id, t.source_estimate_id)'))
        .andOn('estimate.customer_id', '=', 't.customer_id');
    })
    .where('cl.amount', '>', 0)
    .whereNull('i.scheduled_service_id')
    .whereRaw('(cl.estimate_id IS NULL OR t.source_estimate_id IS NULL OR cl.estimate_id = t.source_estimate_id)')
    .select('cl.id as claim_id', 't.coverage_service_type', 'estimate.estimate_data');
  if (!candidates.length) return [];
  const { recurringServiceKey, estimateRodentBaitIsCommercial } = require('../../services/estimate-converter');
  return candidates.filter((row) => (
    recurringServiceKey({ name: row.coverage_service_type }) === 'commercial_rodent_bait'
      || estimateRodentBaitIsCommercial(row.estimate_data)
  )).map((row) => String(row.claim_id));
}

const approvedClaimSql = `cl.id::text IN (
  SELECT approved.value FROM jsonb_array_elements_text(?::jsonb) AS approved(value)
)`;

exports.up = async (knex) => {
  await knex.schema.alterTable('annual_prepay_terms', (table) => {
    // The sold series remains the coverage boundary after its job or setup claim is removed.
    table.uuid('commercial_setup_series_root_id');
  });
  await knex.schema.alterTable('setup_fee_claims', (table) => {
    // NULL identifies older sales whose classification was never recorded.
    table.boolean('unbooked_commercial_setup');
  });
  const approvedClaimIds = await commercialLegacyClaimIds(knex);
  const approvedClaimBindings = JSON.stringify(approvedClaimIds);

  // The conversion must name one actual occurrence on the promised date. Some
  // old commercial sales never populated the claim anchor. If present, it must
  // agree with the series identified by the conversion.
  // This also preserves a selected recurring child while storing its parent.
  // Compute the conversion evidence once, then apply the mutually exclusive
  // booked and zero-visit corrections from that one immutable snapshot.
  await knex.raw(`${legacyEvidenceCte}, booked AS (
    SELECT e.term_id, e.claim_id, root.id AS root_id
    FROM evidence e
    JOIN annual_prepay_terms t ON t.id = e.term_id
    JOIN setup_fee_claims cl ON cl.id = e.claim_id
    JOIN scheduled_services occurrence ON occurrence.id::text = e.occurrence_id
      AND occurrence.customer_id = t.customer_id
    JOIN scheduled_services root ON root.id = coalesce(occurrence.recurring_parent_id, occurrence.id)
      AND root.customer_id = t.customer_id AND root.recurring_parent_id IS NULL
    LEFT JOIN scheduled_services claim_visit ON claim_visit.id = cl.scheduled_service_id
      AND claim_visit.customer_id = t.customer_id
    LEFT JOIN scheduled_services claim_root ON claim_root.id = coalesce(claim_visit.recurring_parent_id, claim_visit.id)
      AND claim_root.customer_id = t.customer_id
    LEFT JOIN services occurrence_service ON occurrence_service.id = occurrence.service_id
    LEFT JOIN services root_service ON root_service.id = root.service_id
    WHERE e.proves_booked AND e.occurrence_count = 1
      AND (cl.scheduled_service_id IS NULL OR claim_root.id = root.id)
      AND occurrence.scheduled_date = t.term_start
      AND occurrence.created_at <= e.invoice_created_at
      AND root.created_at <= e.invoice_created_at
      AND lower(coalesce(nullif(occurrence_service.service_key, ''), nullif(occurrence_service.name, ''), occurrence.service_type, '')) LIKE '%rodent%'
      AND lower(coalesce(nullif(occurrence_service.service_key, ''), nullif(occurrence_service.name, ''), occurrence.service_type, '')) ~ '(bait|station|monitor)'
      AND lower(coalesce(nullif(root_service.service_key, ''), nullif(root_service.name, ''), root.service_type, '')) LIKE '%rodent%'
      AND lower(coalesce(nullif(root_service.service_key, ''), nullif(root_service.name, ''), root.service_type, '')) ~ '(bait|station|monitor)'
      AND (
        lower(coalesce(nullif(occurrence_service.service_key, ''), nullif(occurrence_service.name, ''), occurrence.service_type, '')) LIKE '%commercial%'
        OR lower(coalesce(nullif(root_service.service_key, ''), nullif(root_service.name, ''), root.service_type, '')) LIKE '%commercial%'
        OR ${approvedClaimSql}
      )
  ), unbooked AS (
    SELECT e.term_id, e.claim_id
    FROM evidence e
    JOIN annual_prepay_terms t ON t.id = e.term_id
    JOIN setup_fee_claims cl ON cl.id = e.claim_id
    WHERE e.proves_zero AND ${approvedClaimSql}
  ), stored AS (
    UPDATE annual_prepay_terms t
    SET commercial_setup_series_root_id = b.root_id
    FROM booked b WHERE t.id = b.term_id
    RETURNING b.claim_id, b.root_id
  ), cleared AS (
    UPDATE annual_prepay_terms t
    SET commercial_setup_series_root_id = NULL
    FROM unbooked u WHERE t.id = u.term_id
    RETURNING u.claim_id
  ), marked_booked AS (
    UPDATE setup_fee_claims cl
    SET unbooked_commercial_setup = false, scheduled_service_id = s.root_id
    FROM stored s WHERE cl.id = s.claim_id
    RETURNING cl.id
  )
  -- An exact zero-visit conversion proves invoice-only ownership. Its old
  -- anchor was attached later, so detach it before a refund can transfer the
  -- setup fee onto that unrelated series.
  UPDATE setup_fee_claims cl
  SET scheduled_service_id = NULL, unbooked_commercial_setup = true
  FROM cleared c WHERE cl.id = c.claim_id
  `, [approvedClaimBindings, approvedClaimBindings]);
};

exports.down = async (knex) => {
  // Proven zero-visit claims deliberately remain detached. Their former
  // anchors were later, incorrect mutations and cannot be reconstructed
  // safely; a downgrade removes only the classification/schema additions.
  await knex.schema.alterTable('annual_prepay_terms', (table) => {
    table.dropColumn('commercial_setup_series_root_id');
  });
  await knex.schema.alterTable('setup_fee_claims', (table) => {
    table.dropColumn('unbooked_commercial_setup');
  });
};
