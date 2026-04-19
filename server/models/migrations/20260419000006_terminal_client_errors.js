/**
 * terminal_client_errors — iOS Tap to Pay client error ingestion.
 *
 * Populated by the native waves-pay-ios app via POST /api/stripe/terminal/
 * client-errors whenever the tap-to-pay flow hits a recoverable or terminal
 * failure: cancelled tap, declined card, lost connection, NFC session
 * timeout, backend 4xx/5xx, etc. Separate from tool_health_events because
 * the actors and lifecycle differ (iOS device vs server-side tool call) —
 * but the shape is aligned so the Tool Health Dashboard can union both.
 *
 * ┌──────────────────────────┬──────────────────────┬────────────────────────┐
 * │ tool_health_events       │ terminal_client_errors │ union mapping        │
 * ├──────────────────────────┼──────────────────────┼────────────────────────┤
 * │ source (const per row)   │ 'terminal-client'    │ source                 │
 * │ context                  │ stage                │ context                │
 * │ tool_name                │ error_code           │ tool_name (best-fit)   │
 * │ success                  │ false (always)       │ success                │
 * │ duration_ms              │ duration_ms          │ duration_ms            │
 * │ error_message            │ error_message        │ error_message          │
 * │ created_at               │ created_at           │ created_at             │
 * └──────────────────────────┴──────────────────────┴────────────────────────┘
 *
 * Example union query for the Tool Health Dashboard:
 *
 *   SELECT 'server' AS origin, source, context, tool_name AS signature,
 *          success, duration_ms, error_message, created_at
 *     FROM tool_health_events
 *    WHERE created_at > NOW() - INTERVAL '24 hours'
 *   UNION ALL
 *   SELECT 'ios' AS origin, 'terminal-client' AS source, stage AS context,
 *          error_code AS signature, false AS success, duration_ms,
 *          error_message, created_at
 *     FROM terminal_client_errors
 *    WHERE created_at > NOW() - INTERVAL '24 hours'
 *    ORDER BY created_at DESC;
 *
 * Terminal-specific columns (tech_user_id, invoice_id, pi_id, metadata) are
 * dropped in the union — the dashboard uses them only in drill-down views,
 * not aggregate counts.
 */

exports.up = async function (knex) {
  const has = await knex.schema.hasTable('terminal_client_errors');
  if (has) return;

  await knex.schema.createTable('terminal_client_errors', (t) => {
    t.bigIncrements('id').primary();
    // Actor: the tech device that posted the error. Nullable in case the
    // error fires before auth resolves (e.g. invalid JWT on first call).
    t.uuid('tech_user_id').references('id').inTable('technicians').onDelete('SET NULL');
    // Resource: invoice being charged, if known at time of error.
    t.uuid('invoice_id').references('id').inTable('invoices').onDelete('SET NULL');
    // Where in the flow: 'discover' (reader discovery/connect), 'handoff'
    // (validate-handoff call), 'collect' (collectPaymentMethod), 'confirm'
    // (confirmPaymentIntent), 'receipt' (post-charge send), 'other'.
    t.string('stage', 48).notNullable();
    // Stable machine-readable code — iOS SDK error code, a business code we
    // define ('handoff_expired', 'amount_mismatch'), or 'unknown'. Used for
    // grouping in the dashboard.
    t.string('error_code', 64).notNullable();
    // Human-readable detail. Safe to display in admin views.
    t.text('error_message');
    // Stripe PaymentIntent id, when one was created before the failure.
    t.string('pi_id', 64);
    // Duration of the failed step on the device, if measurable.
    t.integer('duration_ms');
    // iOS-side diagnostic blob: reader state, network condition, retry
    // count, SDK version. Keep < 4KB — this is not a log dump.
    t.jsonb('metadata').defaultTo('{}');
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());

    t.index(['created_at']);
    t.index(['tech_user_id', 'created_at']);
    t.index(['stage', 'created_at']);
    t.index(['error_code', 'created_at']);
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('terminal_client_errors');
};
