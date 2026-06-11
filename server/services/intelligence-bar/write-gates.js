/**
 * Operational write-gate sets for the Intelligence Bar (issue #1568).
 *
 * These sets drive route behavior: when GATE_IB_UI_CONFIRM is on, every tool
 * named here is intercepted in the /query loop — proposed as a pending
 * action instead of executed — and committable only via /confirm-action.
 *
 * The policy snapshot lives in tests/intelligence-bar-write-gate-contract.test.js,
 * which asserts these sets stay equal to its frozen classification lists.
 * Change membership there first; this module is the runtime mirror.
 */

// Writes with a structural preview→confirmed two-step in their executor.
// Their no-confirmed call produces the rich preview shown to the operator.
const WRITE_TWO_STEP_TOOL_NAMES = new Set([
  'create_customer',
  'optimize_all_routes',
  'optimize_tech_route',
  'assign_technician',
  'move_stops_to_day',
  'swap_tech_assignments',
]);

// Legacy writes with no structural gate — their executors mutate on call, so
// the route must NEVER run them from the model loop when the UI-confirm gate
// is on; their preview is synthesized from the proposed params instead.
const LEGACY_BARE_WRITE_TOOL_NAMES = new Set([
  'update_customer',
  'bulk_update_customers',
  'create_appointment',
  'reschedule_appointment',
  'cancel_appointment',
  'send_sms',
  'update_lead_status',
  'bulk_update_leads',
  'submit_review_reply',
  'trigger_review_request',
  'send_email_reply',
  'reply_via_sms',
  'block_sender',
  'create_pending_estimate',
  'toggle_estimate_v2_view',
  'toggle_show_one_time_option',
  'run_price_lookup',
  'approve_price',
  'run_tax_advisor',
]);

const UI_GATED_WRITE_TOOL_NAMES = new Set([
  ...WRITE_TWO_STEP_TOOL_NAMES,
  ...LEGACY_BARE_WRITE_TOOL_NAMES,
]);

module.exports = {
  WRITE_TWO_STEP_TOOL_NAMES,
  LEGACY_BARE_WRITE_TOOL_NAMES,
  UI_GATED_WRITE_TOOL_NAMES,
};
