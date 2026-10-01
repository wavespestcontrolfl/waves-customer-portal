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

// Outside-service writes (owner ruling 2026-09-28, IB scope expansion item 1):
// Sentry/Cloudflare/Railway/GitHub/Search Console/GrowthBook tools whose commit reaches
// a THIRD-PARTY API, not the portal's own DB. They are structurally two-step
// (folded into WRITE_TWO_STEP_TOOL_NAMES below) — a card, not the owner-only
// /execute flow — but per the owner ruling every write tool (not just
// red-tier) is full-access-only: the contact@ login gets it through the
// confirm card, every other admin and every technician is gated. Enforced at
// the tool-list level (getToolsForContext) and at proposal/confirm time in
// admin-intelligence-bar.js via FULL_ACCESS_TWO_STEP_TOOL_NAMES below — never
// by inventing a new access helper (ib-access.js's ibFullAccess /
// requireFullAccess are the only predicate). On confirm, each executor acts
// ONLY on the `_verified_*` pins /confirm-action derives from the
// fingerprint-verified live preview (outside-write-pins.js) — never on the
// operator's raw strings — and a read-only token refuses with
// code "write_access_required", changing nothing.
const OUTSIDE_WRITE_TOOL_NAMES = new Set([
  'resolve_sentry_issue',
  'ignore_sentry_issue',
  'assign_sentry_issue',
  'purge_cloudflare_cache',
  'retry_cloudflare_pages_build',
  'redeploy_railway_service',
  'restart_railway_service',
  'rerun_failed_github_checks',
  'add_github_pr_label',
  'request_codex_review',
  'submit_gsc_sitemap',
  // Feature switches (owner ruling 2026-09-28, Decision 5): a GrowthBook flag
  // toggle and a Railway GATE_* variable change. Confirmed, each acts only
  // on its `_verified_*` pins (outside-write-pins.js).
  'set_railway_gate',
  'set_growthbook_feature_environment',
]);

// Every outside write is full-access-only. Named separately from
// WRITE_TWO_STEP_TOOL_NAMES (rather than inferred) so a future two-step tool
// that is NOT an outside write does not silently inherit the restriction.
const FULL_ACCESS_TWO_STEP_TOOL_NAMES = new Set([...OUTSIDE_WRITE_TOOL_NAMES]);

// Writes with a structural preview→confirmed two-step in their executor.
// Their no-confirmed call produces the rich preview shown to the operator.
const WRITE_TWO_STEP_TOOL_NAMES = new Set([
  'save_customer_estimate',
  'add_customer_property',
  'update_customer_property',
  'set_primary_property',
  'switch_appointment_property',
  'create_agent_estimate_draft',
  'set_estimate_presentation',
  'create_customer',
  'update_property_access',
  'optimize_all_routes',
  'optimize_tech_route',
  'assign_technician',
  'move_stops_to_day',
  'swap_tech_assignments',
  'adjust_stock',
  'create_restock_request',
  'update_restock_request',
  'cancel_plan',
  'merge_customers',
  'repair_closeout',
  ...OUTSIDE_WRITE_TOOL_NAMES,
  'cancel_queued_message',
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

// Writes blocked in the /query tool loop entirely and executable only via
// /execute with server-checked confirmed:true + idempotency key. The route's
// CONFIRMED_ACTION_TOOL_NAMES is built from this set; the contract test
// asserts all three stay equal.
const CONFIRMED_ENDPOINT_WRITE_TOOL_NAMES = new Set([
  'run_seo_pipeline',
  'approve_seo_action',
  'request_instant_payout',
  'request_standard_payout',
  'cancel_pending_payout',
]);

module.exports = {
  WRITE_TWO_STEP_TOOL_NAMES,
  LEGACY_BARE_WRITE_TOOL_NAMES,
  UI_GATED_WRITE_TOOL_NAMES,
  CONFIRMED_ENDPOINT_WRITE_TOOL_NAMES,
  OUTSIDE_WRITE_TOOL_NAMES,
  FULL_ACCESS_TWO_STEP_TOOL_NAMES,
};
