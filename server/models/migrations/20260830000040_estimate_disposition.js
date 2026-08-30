/**
 * Normalized estimate loss disposition (estimator audit 2026-08-29, P0).
 *
 * Adds the disposition columns and backfills every already-terminal row so
 * the win/loss card has history on day one:
 *   - expired rows   → expired_unviewed / expired_viewed from the view
 *                      signals the public page has always stamped
 *   - declined rows  → mapped from the legacy decline_reason label
 * Both are idempotent (only NULL dispositions are written) and never touch
 * live rows. No customer-facing effect. Symmetric down.
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('estimates'))) return;
  const has = async (col) => knex.schema.hasColumn('estimates', col);

  if (!(await has('disposition'))) {
    await knex.schema.alterTable('estimates', (t) => { t.string('disposition', 40); });
  }
  if (!(await has('disposition_source'))) {
    await knex.schema.alterTable('estimates', (t) => { t.string('disposition_source', 20); });
  }
  if (!(await has('disposition_at'))) {
    await knex.schema.alterTable('estimates', (t) => { t.timestamp('disposition_at', { useTz: true }); });
  }
  if (!(await has('disposition_note'))) {
    await knex.schema.alterTable('estimates', (t) => { t.text('disposition_note'); });
  }
  if (!(await has('competitor_name'))) {
    await knex.schema.alterTable('estimates', (t) => { t.string('competitor_name', 120); });
  }
  if (!(await has('competitor_price'))) {
    await knex.schema.alterTable('estimates', (t) => { t.decimal('competitor_price', 10, 2); });
  }

  // Backfill expired rows from the view signals (same rule as the sweep's
  // EXPIRED_DISPOSITION_SQL in services/estimate-disposition.js).
  await knex.raw(`
    UPDATE estimates SET
      disposition = CASE
        WHEN COALESCE(view_count, 0) > 0 OR last_viewed_at IS NOT NULL OR viewed_at IS NOT NULL
        THEN 'expired_viewed' ELSE 'expired_unviewed' END,
      disposition_source = 'system',
      disposition_at = COALESCE(expires_at, updated_at, created_at)
    WHERE status = 'expired' AND disposition IS NULL
  `);

  // Backfill declined rows from the legacy label. Unknown free text →
  // declined_other with the text preserved as the note.
  await knex.raw(`
    UPDATE estimates SET
      disposition = CASE
        WHEN LOWER(TRIM(decline_reason)) LIKE '%expensive%' OR LOWER(TRIM(decline_reason)) = 'price' THEN 'declined_price'
        WHEN LOWER(TRIM(decline_reason)) LIKE '%competitor%' THEN 'declined_competitor'
        WHEN LOWER(TRIM(decline_reason)) LIKE '%not ready%' OR LOWER(TRIM(decline_reason)) LIKE '%timing%' THEN 'declined_timing'
        WHEN LOWER(TRIM(decline_reason)) LIKE '%not needed%' THEN 'not_needed'
        WHEN LOWER(TRIM(decline_reason)) LIKE '%no response%' THEN 'no_response'
        WHEN LOWER(TRIM(decline_reason)) = 'diy' THEN 'diy'
        WHEN LOWER(TRIM(decline_reason)) LIKE '%invalid%' OR LOWER(TRIM(decline_reason)) LIKE '%out of area%' OR LOWER(TRIM(decline_reason)) LIKE '%duplicate%' THEN 'invalid_lead'
        WHEN COALESCE(TRIM(decline_reason), '') = '' THEN 'declined_by_customer'
        ELSE 'declined_other' END,
      disposition_note = CASE
        WHEN COALESCE(TRIM(decline_reason), '') <> ''
          AND LOWER(TRIM(decline_reason)) NOT IN ('too expensive', 'went with competitor', 'not ready', 'service not needed', 'no response')
        THEN decline_reason ELSE NULL END,
      -- Only the admin modals wrote decline_reason; the public customer
      -- decline button never did — don't claim those were staff-authored.
      disposition_source = CASE WHEN COALESCE(TRIM(decline_reason), '') = '' THEN 'customer' ELSE 'staff' END,
      disposition_at = COALESCE(declined_at, updated_at, created_at)
    WHERE status = 'declined' AND disposition IS NULL
  `);

  // Backfill archived LIVE (sent/viewed) rows — the archive path never
  // rewrote status, so these carry their whole story in disposition.
  // converted_other_path mirrors archiveConvertedOpenEstimates +
  // whereNoConversionBeforeEstimate (estimate-conversion-guard.js): at
  // least one conversion signal (paid invoice OR completed visit) exists,
  // and NO conversion evidence of ANY kind predates the estimate — a
  // pre-converted customer's archived upsell stays archived_unresolved
  // instead of masquerading as the conversion.
  await knex.raw(`
    UPDATE estimates e SET
      disposition = CASE WHEN e.customer_id IS NOT NULL
        AND (
          -- Evidence must exist by the time the row was ARCHIVED — the live
          -- sweep classifies at archive time; a customer who independently
          -- bought months after an archived-unresolved courtship is not a
          -- conversion of it (codex pre-push P1).
          EXISTS (SELECT 1 FROM invoices i
            WHERE i.customer_id = e.customer_id AND i.status = 'paid'
              AND LEAST(i.created_at, COALESCE(i.paid_at, i.created_at)) <= e.archived_at)
          OR EXISTS (SELECT 1 FROM scheduled_services ss
            WHERE ss.customer_id = e.customer_id AND ss.status = 'completed'
              AND COALESCE(ss.completed_at, ss.scheduled_date::timestamp AT TIME ZONE 'America/New_York', ss.created_at) <= e.archived_at)
        )
        AND NOT EXISTS (SELECT 1 FROM invoices i
          WHERE i.customer_id = e.customer_id AND i.status = 'paid'
            AND LEAST(i.created_at, COALESCE(i.paid_at, i.created_at)) < e.created_at)
        AND NOT EXISTS (SELECT 1 FROM scheduled_services ss
          WHERE ss.customer_id = e.customer_id
            AND ss.status NOT IN ('cancelled', 'rescheduled', 'skipped', 'no_show')
            AND ss.created_at < e.created_at)
        AND NOT EXISTS (SELECT 1 FROM scheduled_services ss
          WHERE ss.customer_id = e.customer_id AND ss.status = 'completed'
            AND COALESCE(ss.completed_at, ss.scheduled_date::timestamp AT TIME ZONE 'America/New_York') < e.created_at)
        AND NOT EXISTS (SELECT 1 FROM service_records sr
          WHERE sr.customer_id = e.customer_id AND sr.status = 'completed'
            AND sr.service_date::timestamp AT TIME ZONE 'America/New_York' < e.created_at)
        AND NOT EXISTS (SELECT 1 FROM customers c
          WHERE c.id = e.customer_id
            AND c.pipeline_stage IN ('active_customer', 'won', 'at_risk')
            AND COALESCE(c.member_since, (c.created_at AT TIME ZONE 'America/New_York')::date) < (e.created_at AT TIME ZONE 'America/New_York')::date)
      THEN 'converted_other_path' ELSE 'archived_unresolved' END,
      disposition_source = 'system',
      disposition_at = COALESCE(e.archived_at, e.updated_at, e.created_at)
    WHERE e.status IN ('sent', 'viewed')
      AND e.archived_at IS NOT NULL
      AND e.disposition IS NULL
  `);
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('estimates'))) return;
  for (const col of ['competitor_price', 'competitor_name', 'disposition_note', 'disposition_at', 'disposition_source', 'disposition']) {
    if (await knex.schema.hasColumn('estimates', col)) {
      await knex.schema.alterTable('estimates', (t) => { t.dropColumn(col); });
    }
  }
};
