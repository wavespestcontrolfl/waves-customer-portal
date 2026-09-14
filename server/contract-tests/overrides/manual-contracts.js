/**
 * Manual contract overrides for tools whose DB references can't be reliably
 * extracted via regex (raw SQL, dynamic column names, CTEs, etc.).
 *
 * Format:
 *   {
 *     '<tool_name>': {
 *       tables:  ['table_a', 'table_b'],
 *       columns: { table_a: ['col1', 'col2'], table_b: ['*'] },
 *       reason:  'why this needs manual declaration',
 *       sideEffects: true,         // optional — skip execute-smoke
 *       registerManually: true,    // optional — add a tool the registry wouldn't find
 *       schema:  { ... },          // optional — required if registerManually
 *     }
 *   }
 *
 * Tools can also declare an inline `_contracts` object on their definition;
 * the registry honors both.
 */
module.exports = {
  // _global applies to every tool. Use for tables/columns referenced inside
  // try/catch best-effort blocks that may legitimately be absent in some envs.
  _global: {
    optionalTables: [
      'revenue_daily',        // tax-tools: try/catch YTD revenue aggregation
      'ad_spend_log',         // revenue-tools: try/catch ad spend lookup
      'csr_call_records',     // comms-tools: try/catch CSR call log join
    ],
    optionalColumns: {
      call_log: ['transcript'], // comms-tools: try/catch transcript search
    },
    reason: 'Tables/columns referenced inside try/catch best-effort blocks. Absence is tolerated at runtime.',
  },

  // Lead-response agent write tools — they insert lead_activities /
  // estimates / lead_agent_responses rows and send SMS via Twilio. Smoke
  // execution must never fire them (the nil-UUID probe got as far as an
  // estimates INSERT before the FK stopped it — that was luck, not safety).
  flag_for_estimate:  { sideEffects: true, reason: 'inserts estimates + lead_activities rows' },
  send_lead_response: { sideEffects: true, reason: 'sends SMS via Twilio, inserts lead_activities' },
  update_lead_pipeline: { sideEffects: true, reason: 'updates leads.pipeline stage, inserts lead_activities' },
  queue_for_adam:     { sideEffects: true, reason: 'inserts lead_agent_responses queue rows' },
  save_lead_response_report: { sideEffects: true, reason: 'inserts lead_agent_responses report rows (write path swallowed its own failure during smoke)' },

  // The tool's queries live in estimate-detail.js rather than the
  // registered estimate-tools.js source path. Cover its row, provenance,
  // membership, acceptance, and composer dependencies here.
  get_estimate_detail: {
    tables: ['estimates', 'estimate_acceptances', 'call_log', 'leads', 'scheduled_services', 'services', 'customers', 'annual_prepay_terms'],
    columns: {
      // The estimate row is selected in full for the public composer.
      estimates: [
        'id', 'customer_id', 'customer_name', 'address', 'status', 'disposition', 'disposition_note',
        'decline_reason', 'category', 'service_interest', 'waveguard_tier', 'pricing_version', 'bill_by_invoice',
        'monthly_total', 'annual_total', 'onetime_total', 'accepted_at', 'accepted_service_mode',
        'accepted_frequency_key', 'notes', 'token', 'sent_at', 'viewed_at', 'view_count', 'declined_at',
        'expires_at', 'archived_at', 'created_at', 'updated_at', 'estimate_data',
        'price_locked_at', 'customer_phone', 'customer_email', 'terms_version', 'property_id', 'estimate_group_id',
      ],
      // acceptanceRecordForEstimate reads the latest persisted acceptance
      // whenever an accepted estimate carries a terms-version stamp.
      estimate_acceptances: [
        'id', 'estimate_id', 'terms_version', 'terms_text', 'accepted_at', 'ip', 'user_agent',
      ],
      // callSideBlockForEstimateData's own reads, reached from estimateLinks
      // for an engine-drafted row (estimatorEngine.callLogId): the blocking
      // verdict + in-flight markers off call_log, then the sid-owned /
      // stamped lead resolution when the draft is durably lead-linked.
      call_log: [
        'id', 'metadata', 'processing_token', 'processing_status', 'extraction_attempts',
        'created_at', 'twilio_call_sid',
      ],
      leads: ['id', 'twilio_call_sid', 'deleted_at', 'created_at', 'estimate_id', 'first_name', 'last_name', 'email', 'phone', 'address'],
      // composeEstimateDataPayload's per-estimate appointment adoption read
      // (findLinkedUpcomingAppointment): the filtered columns plus the
      // catalog identity it left-joins for.
      scheduled_services: [
        'id', 'status', 'scheduled_date', 'customer_id', 'reservation_expires_at',
        'is_callback', 'service_id', 'source_estimate_id',
        'window_start', 'window_end', 'window_display', 'service_type', 'property_id',
        'service_address_line1', 'service_address_line2', 'service_address_city', 'service_address_zip',
      ],
      services: ['id', 'service_key', 'name'],
      // The customer row the composer reads on two paths: every linked
      // estimate through estimateRendersMonthlyBilling → billing-cadence
      // (pipeline_stage, monthly_rate, billing_mode — codex round 7 P2),
      // an authored proposal through resolveProposalBillingContext, and
      // strict membership reconciliation through isActivePlanCustomer
      // (active, waveguard_tier).
      customers: ['id', 'active', 'waveguard_tier', 'pipeline_stage', 'monthly_rate', 'billing_mode', 'address_line1', 'address_line2', 'city', 'state', 'zip', 'first_name', 'last_name', 'email', 'phone'],
      annual_prepay_terms: ['source_estimate_id'],
    },
    reason: 'get_estimate_detail\'s DB reads live in estimate-detail.js, not its registered sourcePath (estimate-tools.js) — the automatic scan can\'t see them.',
  },
};
