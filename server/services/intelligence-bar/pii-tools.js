/**
 * Tools whose inputs or results carry customer PII (names, phones, emails,
 * addresses, message bodies, or provider text that can echo them). The route
 * logs only field names for these and marks requests that used them; the
 * scope catalog test asserts none of them is scope `none`.
 */
const PII_TOOL_NAMES = new Set([
  'query_customers',
  'get_customer_detail',
  'get_schedule_view',
  'get_my_route',
  'create_customer',
  'switch_appointment_property',
  'update_property_access',
  // cancel_plan previews/results echo the customer's name and free-text note.
  'cancel_plan',
  'get_stop_details',
  'get_recent_completions',
  'get_unanswered_threads',
  'get_conversation_thread',
  'search_messages',
  'get_call_log',
  'list_call_partners',
  'get_partner_call_history',
  'send_sms',
  // Lead write tools accept/echo lead names, and their ambiguity and bulk
  // previews return candidate names + phone last4 — taint so telemetry is
  // redacted like the comms tools (codex P1 on the pinning round).
  'update_lead_status',
  'bulk_update_leads',
  // block_sender inputs/results carry the full sender address (pre-push
  // P1) — redact its telemetry like the comms tools.
  'block_sender',
  'draft_sms_reply',
  'draft_sms',
  'lookup_property',
  'find_similar_estimates',
  'match_existing_customer',
  'create_pending_estimate',
  // Accepts a customer-phone identifier and echoes the customer name —
  // same PII class as the other estimate tools (codex P1 on #2947).
  'set_estimate_presentation',
  // compute_estimate carries the full service address + selected lead id —
  // same PII class as lookup_property and the draft writer.
  'compute_estimate',
  // search_call_research RETURNS only redacted text, but its free-form query
  // input can carry whatever the operator typed (a name, phone, address) —
  // taint so inputs/telemetry are redacted like the comms tools.
  'search_call_research',
  // Recall returns verbatim past conversation turns (which may embed
  // customer PII and carry taint markers) and its query is operator-typed.
  'search_ib_history',
  // W0B proposal pins put the resolved customer name (reschedule visit,
  // review-request recipient, estimate owner) into the model-visible tool
  // result — redact like the other identity-bearing writes.
  'reschedule_appointment',
  'trigger_review_request',
  'toggle_estimate_v2_view',
  'toggle_show_one_time_option',
  // The W0B bulk proposal resolves EVERY target id to the customer's full
  // name in the model-visible result (fail-closed name listing) — taint so
  // telemetry and thread history redact like the other bulk tools (GH r8 P1).
  'bulk_update_customers',
  // Their proposals now pin the resolved customer NAME into the
  // model-visible preview (GH r8 — uuid-only cards were unreviewable), and
  // update_customer's updates map carries emails/phones/names anyway.
  'update_customer',
  'create_appointment',
  'create_agent_estimate_draft', // AGENT_ESTIMATE_WRITE_TOOL in the route
  // Email tools return sender names/addresses and message bodies, and reply
  // inputs carry the drafted body — same class of PII as the comms tools.
  'get_inbox_summary',
  'search_emails',
  'get_email_thread',
  'draft_email_reply',
  'send_email_reply',
  'reply_via_sms',
  'get_stock_movements',
  // Railway runtime logs can echo customer identifiers from app logging —
  // redact like any other PII-bearing tool result.
  'get_railway_logs',
  // Sentry reports with sendDefaultPii — issue titles, culprits, and event
  // messages/values can embed customer emails, phones, or request data.
  'get_sentry_top_issues',
  'get_sentry_new_issues',
  'get_sentry_issue_detail',
  // Twilio results carry recipient phone numbers (and alert texts can echo
  // them) — redact like the comms tools.
  'get_twilio_alerts',
  'get_twilio_failed_messages',
  // SendGrid suppression results are lists of customer email addresses —
  // redact like the comms tools.
  'get_email_suppressions',
  'check_email_suppression',
  // Trip start/end points trace customer service stops, and managed-agent
  // session titles are app-authored and can reference leads/customers.
  'get_truck_trips',
  'get_managed_agent_runs',
  // Recorded job errors are provider messages that can echo request
  // payloads (Twilio errors embed phone numbers) — the ledger masks digit
  // runs at record time, and telemetry redacts as defense in depth.
  'get_scheduled_job_health',
  // PaymentIntent descriptions are app-written and can embed customer names
  // or invoice references — redact like the other billing-adjacent tools.
  'get_stripe_payment_intents',
  // GrowthBook feature rules expose raw targeting `condition` predicates,
  // which are arbitrary attribute strings that can embed customer emails or
  // user identifiers — keep them out of query telemetry.
  'get_growthbook_features',
  'get_growthbook_experiments',
]);

module.exports = { PII_TOOL_NAMES };
