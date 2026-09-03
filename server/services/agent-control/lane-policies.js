/**
 * Lane runtime policies — what the agent-control plane expects of each AI
 * lane at run time: how it may fail over (FALLBACK_CLASS), what it touches
 * (SIDE_EFFECT_CLASS), which ledger records it, how long it should take and
 * when silence or slowness becomes an alert.
 *
 * Keyed by the model-switchboard LANES id (server/services/model-switchboard.js
 * is the audited call-site map; tests/agent-control-taxonomy.test.js fails
 * when a lane appears there without an entry here, or here without a lane
 * there). The switchboard says WHICH MODEL runs a lane; this file says HOW
 * the run is supervised. Classification rationale per lane is in the PR body
 * (S1 lane-classification table).
 *
 * `ledger`:
 *   call         text / vision calls through the llm adapters — one row per call
 *   session      Anthropic Managed Agents — one row per session
 *   unrecordable no per-call row today; `unrecordable_reason` says why
 *                (audio | embedding | image | video | search)
 * `expected_cadence`: 'event' = candidate-driven, no silence alarm;
 *   hourly / daily / weekly = a cron lane that alarms when it goes quiet.
 * `maturity`: only where the lane's own code makes it obvious (an approval
 *   queue = M2, a shadow-only lane = M0, auto-apply with an audit trail = M3).
 *
 * Invariants (tested): stall_after_ms >= 2 x heartbeat_interval_ms and
 * hard_timeout_ms >= expected_duration_ms for every merged policy.
 */

const LEDGER = Object.freeze(['call', 'session', 'unrecordable']);
const UNRECORDABLE_REASON = Object.freeze(['audio', 'embedding', 'image', 'video', 'search']);
const CADENCE = Object.freeze(['hourly', 'daily', 'weekly', 'event']);

const DEFAULT_RUNTIME = Object.freeze({
  expected_duration_ms: 60_000,
  heartbeat_interval_ms: 30_000,
  stall_after_ms: 300_000,
  hard_timeout_ms: 1_800_000,
  no_progress_after_ms: 600_000,
  expected_cadence: 'event',
  human_wait_alert_ms: 172_800_000, // 48 h
  fallback_class: 'interactive',
  eval_family: null,
  maturity: null,
  workflow_id: null,
  trace: false,
  // null = no cap yet (cost arrives in a later PR)
  budget: Object.freeze({ max_steps: 50, max_tool_calls: 100, max_retries: 2, max_cost_usd: null }),
});

// Long-running shapes shared by several lanes below. Plain data, spread into
// the entry so the merged policy stays flat.
const LONG_BATCH = { expected_duration_ms: 600_000, stall_after_ms: 900_000, hard_timeout_ms: 3_600_000 };
const CALL_PIPELINE = { expected_duration_ms: 300_000, stall_after_ms: 600_000 };
const AGENT_SESSION = {
  expected_duration_ms: 900_000, heartbeat_interval_ms: 60_000, stall_after_ms: 900_000,
  hard_timeout_ms: 3_600_000, no_progress_after_ms: 900_000,
  budget: { max_steps: 200, max_tool_calls: 400, max_retries: 1 },
};

const LANE_RUNTIME = {
  // ── SMS & messaging ──
  sms_draft: { side_effect_class: 'draft_for_human', ledger: 'call', fallback_class: 'interactive', eval_family: 'routine_copy', maturity: 'M0' },
  sms_save_sale: { side_effect_class: 'draft_for_human', ledger: 'call', fallback_class: 'interactive', eval_family: 'high_stakes_copy', maturity: 'M0' },
  sms_tone: { side_effect_class: 'draft_for_human', ledger: 'call', fallback_class: 'interactive', eval_family: 'routine_copy' },
  sms_suggest: { side_effect_class: 'draft_for_human', ledger: 'call', fallback_class: 'interactive', eval_family: 'routine_copy' },
  response_drafter: { side_effect_class: 'draft_for_human', ledger: 'call', fallback_class: 'interactive', eval_family: 'high_stakes_copy', maturity: 'M2' },
  estimate_followup: { side_effect_class: 'draft_for_human', ledger: 'call', fallback_class: 'interactive', eval_family: 'routine_copy', maturity: 'M0' },
  sms_intent: { side_effect_class: 'internal_write', ledger: 'call', fallback_class: 'interactive', eval_family: 'classification' },
  contact_correction: { side_effect_class: 'internal_write', ledger: 'call', fallback_class: 'interactive', eval_family: 'structured_extraction', maturity: 'M3' },
  sms_pathology: { side_effect_class: 'internal_write', ledger: 'call', fallback_class: 'offline', eval_family: 'classification', expected_cadence: 'daily', ...LONG_BATCH },
  sms_verifier: { side_effect_class: 'internal_write', ledger: 'call', fallback_class: 'interactive', eval_family: 'compliance_check' },
  shadow_judge: { side_effect_class: 'internal_write', ledger: 'call', fallback_class: 'measurement', eval_family: 'compliance_check', expected_cadence: 'daily', maturity: 'M0', ...LONG_BATCH },
  voice_profile: { side_effect_class: 'internal_write', ledger: 'call', fallback_class: 'offline', eval_family: null, expected_cadence: 'daily', ...LONG_BATCH },
  sealed_eval: { side_effect_class: 'internal_write', ledger: 'call', fallback_class: 'measurement', eval_family: 'routine_copy', expected_cadence: 'daily', ...LONG_BATCH },
  quarantine_arbiter: { side_effect_class: 'internal_write', ledger: 'call', fallback_class: 'interactive', eval_family: 'transcription_contact' },
  // Route canaries: one tiny probe per draft route at boot + every 6h; the
  // answer IS the measurement (a substitute provider would hide the outage
  // it exists to catch). Alerts = admin bell + internal SMS to the owner.
  sms_canary_default: { side_effect_class: 'internal_write', ledger: 'call', fallback_class: 'measurement', eval_family: null, expected_cadence: 'daily', expected_duration_ms: 15_000 },
  sms_canary_save_sale: { side_effect_class: 'internal_write', ledger: 'call', fallback_class: 'measurement', eval_family: null, expected_cadence: 'daily', expected_duration_ms: 15_000 },

  // ── Calls ──
  call_extraction: { side_effect_class: 'internal_write', ledger: 'call', fallback_class: 'interactive', eval_family: 'structured_extraction', maturity: 'M0', ...CALL_PIPELINE },
  call_extraction_v1: { side_effect_class: 'internal_write', ledger: 'call', fallback_class: 'interactive', eval_family: 'structured_extraction', ...CALL_PIPELINE },
  call_research: { side_effect_class: 'internal_write', ledger: 'call', fallback_class: 'offline', eval_family: 'structured_extraction', expected_cadence: 'daily', ...LONG_BATCH },
  transcription: { side_effect_class: 'internal_write', ledger: 'unrecordable', unrecordable_reason: 'audio', fallback_class: 'interactive', eval_family: 'transcription_contact', ...CALL_PIPELINE },
  transcript_label: { side_effect_class: 'internal_write', ledger: 'call', fallback_class: 'interactive', eval_family: 'transcription_contact', ...CALL_PIPELINE },
  contact_pass: { side_effect_class: 'internal_write', ledger: 'unrecordable', unrecordable_reason: 'audio', fallback_class: 'interactive', eval_family: 'transcription_contact', ...CALL_PIPELINE },
  call_sentiment: { side_effect_class: 'internal_write', ledger: 'call', fallback_class: 'interactive', eval_family: 'classification' },
  call_self_audit: { side_effect_class: 'internal_write', ledger: 'call', fallback_class: 'offline', eval_family: 'compliance_check', expected_cadence: 'daily', ...LONG_BATCH },
  lead_synopsis: { side_effect_class: 'internal_write', ledger: 'call', fallback_class: 'interactive', eval_family: 'structured_extraction' },
  // The hourly cron only verifies follow-ups (no model call); the model runs
  // per scored call and for the weekly recommendation — candidate-driven.
  csr_coach: { side_effect_class: 'internal_write', ledger: 'call', fallback_class: 'offline', eval_family: null },
  contact_dictation: { side_effect_class: 'internal_write', ledger: 'call', fallback_class: 'interactive', eval_family: 'transcription_contact' },
  address_recovery: { side_effect_class: 'internal_write', ledger: 'call', fallback_class: 'interactive', eval_family: 'structured_extraction' },
  tech_dictation: { side_effect_class: 'internal_write', ledger: 'unrecordable', unrecordable_reason: 'audio', fallback_class: 'interactive', eval_family: 'transcription_contact' },
  parse_when: { side_effect_class: 'read_only', ledger: 'call', fallback_class: 'interactive', eval_family: 'structured_extraction' },

  // ── Voice AI agent ──
  voice_relay: { side_effect_class: 'customer_visible', ledger: 'call', fallback_class: 'interactive', eval_family: 'high_stakes_copy', expected_duration_ms: 15_000, stall_after_ms: 60_000, hard_timeout_ms: 900_000 },

  // ── Photos & property ──
  pest_id: { side_effect_class: 'customer_visible', ledger: 'call', fallback_class: 'interactive', eval_family: 'vision_id' },
  lawn_assess: { side_effect_class: 'customer_visible', ledger: 'call', fallback_class: 'interactive', eval_family: 'vision_id' },
  tree_shrub: { side_effect_class: 'customer_visible', ledger: 'call', fallback_class: 'interactive', eval_family: 'vision_id' },
  treatment_zone: { side_effect_class: 'internal_write', ledger: 'call', fallback_class: 'interactive', eval_family: 'property_measurement' },
  tech_caption_vision: { side_effect_class: 'draft_for_human', ledger: 'call', fallback_class: 'interactive', eval_family: 'vision_id' },
  satellite: { side_effect_class: 'internal_write', ledger: 'call', fallback_class: 'interactive', eval_family: 'property_measurement', expected_duration_ms: 120_000 },
  property_trio: { side_effect_class: 'internal_write', ledger: 'call', fallback_class: 'interactive', eval_family: 'property_measurement', expected_duration_ms: 120_000 },
  property_v2_vision: { side_effect_class: 'internal_write', ledger: 'call', fallback_class: 'interactive', eval_family: 'property_measurement', expected_duration_ms: 120_000 },
  turf_ocr: { side_effect_class: 'internal_write', ledger: 'call', fallback_class: 'interactive', eval_family: 'vision_id' },
  photo_scoring: { side_effect_class: 'customer_visible', ledger: 'call', fallback_class: 'interactive', eval_family: 'vision_id' },
  vision_delta: { side_effect_class: 'internal_write', ledger: 'call', fallback_class: 'interactive', eval_family: 'vision_id' },
  lawn_quality_gate: { side_effect_class: 'read_only', ledger: 'call', fallback_class: 'interactive', eval_family: 'vision_id' },
  lawn_diag_vision: { side_effect_class: 'internal_write', ledger: 'call', fallback_class: 'interactive', eval_family: 'vision_id' },
  lawn_challenge: { side_effect_class: 'internal_write', ledger: 'call', fallback_class: 'interactive', eval_family: 'compliance_check' },
  lawn_diag_writer: { side_effect_class: 'customer_visible', ledger: 'call', fallback_class: 'interactive', eval_family: 'service_report' },
  wdo_project_brief: { side_effect_class: 'internal_write', ledger: 'call', fallback_class: 'interactive', eval_family: null },
  wdo_history: { side_effect_class: 'read_only', ledger: 'call', fallback_class: 'interactive', eval_family: 'retrieval_qa' },

  // ── Estimates & sales ──
  lead_triage: { side_effect_class: 'internal_write', ledger: 'call', fallback_class: 'interactive', eval_family: 'classification' },
  estimate_assistant: { side_effect_class: 'read_only', ledger: 'call', fallback_class: 'interactive', eval_family: 'retrieval_qa' },
  estimator_sms_signal: { side_effect_class: 'internal_write', ledger: 'call', fallback_class: 'interactive', eval_family: 'classification' },
  intent_composer: { side_effect_class: 'internal_write', ledger: 'call', fallback_class: 'interactive', eval_family: 'structured_extraction', expected_duration_ms: 120_000 },
  commercial_proposal: { side_effect_class: 'draft_for_human', ledger: 'call', fallback_class: 'interactive', eval_family: 'high_stakes_copy' },
  churn_classify: { side_effect_class: 'internal_write', ledger: 'call', fallback_class: 'interactive', eval_family: 'classification' },
  signal_detector: { side_effect_class: 'internal_write', ledger: 'call', fallback_class: 'offline', eval_family: 'classification', expected_cadence: 'daily', ...LONG_BATCH },
  retention_drafts: { side_effect_class: 'draft_for_human', ledger: 'call', fallback_class: 'offline', eval_family: 'high_stakes_copy', expected_cadence: 'daily', maturity: 'M2', ...LONG_BATCH },

  // ── Service reports ──
  report_copy: { side_effect_class: 'customer_visible', ledger: 'call', fallback_class: 'interactive', eval_family: 'service_report' },
  treatment_narrative: { side_effect_class: 'customer_visible', ledger: 'call', fallback_class: 'interactive', eval_family: 'service_report' },
  rodent_narrative: { side_effect_class: 'customer_visible', ledger: 'call', fallback_class: 'interactive', eval_family: 'service_report' },
  project_report: { side_effect_class: 'draft_for_human', ledger: 'call', fallback_class: 'interactive', eval_family: 'service_report' },
  completion_recap: { side_effect_class: 'customer_visible', ledger: 'call', fallback_class: 'interactive', eval_family: 'service_report' },
  lawn_visit_narratives: { side_effect_class: 'customer_visible', ledger: 'call', fallback_class: 'interactive', eval_family: 'service_report' },
  previsit_brief: { side_effect_class: 'internal_write', ledger: 'call', fallback_class: 'offline', eval_family: 'retrieval_qa', expected_cadence: 'hourly' },
  invoice_summary: { side_effect_class: 'draft_for_human', ledger: 'call', fallback_class: 'interactive', eval_family: 'routine_copy' },
  wdo_appt_brief: { side_effect_class: 'internal_write', ledger: 'call', fallback_class: 'interactive', eval_family: null },

  // ── Email ──
  email_classify: { side_effect_class: 'internal_write', ledger: 'call', fallback_class: 'interactive', eval_family: 'classification' },
  email_reply: { side_effect_class: 'draft_for_human', ledger: 'call', fallback_class: 'interactive', eval_family: 'routine_copy' },
  bounce_rescue: { side_effect_class: 'internal_write', ledger: 'call', fallback_class: 'interactive', eval_family: 'structured_extraction' },
  invoice_pdf: { side_effect_class: 'internal_write', ledger: 'call', fallback_class: 'interactive', eval_family: 'structured_extraction', expected_duration_ms: 120_000 },

  // ── Content & SEO ──
  blog_draft: { side_effect_class: 'customer_visible', ledger: 'call', fallback_class: 'offline', eval_family: 'high_stakes_copy', expected_cadence: 'daily', ...LONG_BATCH },
  blog_optimize: { side_effect_class: 'internal_write', ledger: 'call', fallback_class: 'offline', eval_family: 'high_stakes_copy', ...LONG_BATCH },
  newsletter: { side_effect_class: 'draft_for_human', ledger: 'call', fallback_class: 'offline', eval_family: 'routine_copy', expected_cadence: 'weekly', maturity: 'M2', ...LONG_BATCH },
  content_misc: { side_effect_class: 'draft_for_human', ledger: 'call', fallback_class: 'interactive', eval_family: 'routine_copy' },
  social_copy: { side_effect_class: 'irreversible_external', ledger: 'call', fallback_class: 'offline', eval_family: 'routine_copy', expected_cadence: 'hourly' },
  social_judge: { side_effect_class: 'internal_write', ledger: 'call', fallback_class: 'interactive', eval_family: 'compliance_check' },
  tech_caption_copy: { side_effect_class: 'draft_for_human', ledger: 'call', fallback_class: 'interactive', eval_family: 'routine_copy' },
  review_ask: { side_effect_class: 'customer_visible', ledger: 'call', fallback_class: 'interactive', eval_family: 'routine_copy', maturity: 'M3' },
  review_reply: { side_effect_class: 'irreversible_external', ledger: 'call', fallback_class: 'interactive', eval_family: 'high_stakes_copy' },
  review_gate_text: { side_effect_class: 'customer_visible', ledger: 'call', fallback_class: 'interactive', eval_family: 'routine_copy' },
  hero_alt: { side_effect_class: 'internal_write', ledger: 'call', fallback_class: 'offline', eval_family: 'vision_id' },
  fact_check_gate: { side_effect_class: 'internal_write', ledger: 'call', fallback_class: 'offline', eval_family: 'compliance_check', expected_duration_ms: 120_000 },
  compliance_gate: { side_effect_class: 'internal_write', ledger: 'call', fallback_class: 'offline', eval_family: 'compliance_check', expected_duration_ms: 120_000 },
  codex_remediation: { side_effect_class: 'internal_write', ledger: 'call', fallback_class: 'offline', eval_family: 'high_stakes_copy', ...LONG_BATCH },
  footprint_claim: { side_effect_class: 'internal_write', ledger: 'call', fallback_class: 'offline', eval_family: 'compliance_check', expected_cadence: 'daily' },
  seo_intent: { side_effect_class: 'read_only', ledger: 'call', fallback_class: 'interactive', eval_family: 'classification' },
  seo_advisor: { side_effect_class: 'internal_write', ledger: 'call', fallback_class: 'offline', eval_family: null, expected_cadence: 'weekly', ...LONG_BATCH },
  prospect_score: { side_effect_class: 'internal_write', ledger: 'call', fallback_class: 'offline', eval_family: 'classification' },
  signup_classifier: { side_effect_class: 'internal_write', ledger: 'call', fallback_class: 'offline', eval_family: 'classification', expected_cadence: 'weekly' },
  outreach_drafter: { side_effect_class: 'draft_for_human', ledger: 'call', fallback_class: 'offline', eval_family: 'routine_copy', expected_cadence: 'daily', maturity: 'M2' },
  form_filler: { side_effect_class: 'irreversible_external', ledger: 'call', fallback_class: 'offline', eval_family: null, ...LONG_BATCH },
  signup_worker: { side_effect_class: 'irreversible_external', ledger: 'call', fallback_class: 'offline', eval_family: null, ...LONG_BATCH },
  link_investigator: { side_effect_class: 'internal_write', ledger: 'call', fallback_class: 'offline', eval_family: 'retrieval_qa', expected_cadence: 'hourly', ...LONG_BATCH },
  mentions_prober: { side_effect_class: 'internal_write', ledger: 'unrecordable', unrecordable_reason: 'search', fallback_class: 'measurement', eval_family: null, expected_cadence: 'daily', ...LONG_BATCH },
  mentions_sentiment: { side_effect_class: 'internal_write', ledger: 'call', fallback_class: 'offline', eval_family: 'classification', expected_cadence: 'daily' },
  image_gen: { side_effect_class: 'internal_write', ledger: 'unrecordable', unrecordable_reason: 'image', fallback_class: 'offline', eval_family: null, expected_duration_ms: 180_000 },
  video_gen: { side_effect_class: 'internal_write', ledger: 'unrecordable', unrecordable_reason: 'video', fallback_class: 'offline', eval_family: null, ...LONG_BATCH },
  events: { side_effect_class: 'internal_write', ledger: 'call', fallback_class: 'offline', eval_family: 'classification', expected_cadence: 'daily', maturity: 'M3', ...LONG_BATCH },
  ads_advisor: { side_effect_class: 'internal_write', ledger: 'call', fallback_class: 'offline', eval_family: null, expected_cadence: 'daily' },

  // ── Intelligence Bar & knowledge ──
  ib_admin: { side_effect_class: 'internal_write', ledger: 'call', fallback_class: 'interactive', eval_family: 'sql_tool', expected_duration_ms: 120_000 },
  ib_tech: { side_effect_class: 'read_only', ledger: 'call', fallback_class: 'interactive', eval_family: 'sql_tool' },
  ib_tools: { side_effect_class: 'draft_for_human', ledger: 'call', fallback_class: 'interactive', eval_family: 'routine_copy' },
  chart_builder_image: { side_effect_class: 'read_only', ledger: 'call', fallback_class: 'interactive', eval_family: 'vision_id' },
  chart_builder_sql: { side_effect_class: 'read_only', ledger: 'call', fallback_class: 'interactive', eval_family: 'sql_tool' },
  knowledge_qa: { side_effect_class: 'read_only', ledger: 'call', fallback_class: 'interactive', eval_family: 'retrieval_qa' },
  wiki_qa: { side_effect_class: 'read_only', ledger: 'call', fallback_class: 'interactive', eval_family: 'retrieval_qa' },
  kb_audit: { side_effect_class: 'internal_write', ledger: 'call', fallback_class: 'offline', eval_family: 'compliance_check', expected_cadence: 'daily', ...LONG_BATCH },
  wiki_compiler: { side_effect_class: 'internal_write', ledger: 'call', fallback_class: 'offline', eval_family: 'retrieval_qa', expected_cadence: 'hourly', ...LONG_BATCH },
  embeddings: { side_effect_class: 'internal_write', ledger: 'unrecordable', unrecordable_reason: 'embedding', fallback_class: 'offline', eval_family: null },
  extreme_tier: { side_effect_class: 'read_only', ledger: 'call', fallback_class: 'interactive', eval_family: null, expected_duration_ms: 300_000 },

  // ── Customer portal ──
  ask_waves: { side_effect_class: 'customer_visible', ledger: 'call', fallback_class: 'interactive', eval_family: 'retrieval_qa' },
  portal_assistant: { side_effect_class: 'customer_visible', ledger: 'call', fallback_class: 'interactive', eval_family: 'retrieval_qa' },

  // ── Managed agents (sessions) ──
  agent_bi: { side_effect_class: 'internal_write', ledger: 'session', fallback_class: 'offline', eval_family: 'long_running_agent', expected_cadence: 'weekly', ...AGENT_SESSION },
  agent_lead: { side_effect_class: 'customer_visible', ledger: 'session', fallback_class: 'interactive', eval_family: 'long_running_agent', ...AGENT_SESSION },
  agent_content: { side_effect_class: 'internal_write', ledger: 'session', fallback_class: 'offline', eval_family: 'long_running_agent', ...AGENT_SESSION },
  agent_meta: { side_effect_class: 'internal_write', ledger: 'session', fallback_class: 'offline', eval_family: 'long_running_agent', ...AGENT_SESSION },
  agent_backlink: { side_effect_class: 'internal_write', ledger: 'session', fallback_class: 'offline', eval_family: 'long_running_agent', ...AGENT_SESSION },
  agent_assistant: { side_effect_class: 'customer_visible', ledger: 'session', fallback_class: 'interactive', eval_family: 'long_running_agent', ...AGENT_SESSION },

  // ── Back office ──
  expense_categorize: { side_effect_class: 'internal_write', ledger: 'call', fallback_class: 'interactive', eval_family: 'classification' },
  tax_advisor: { side_effect_class: 'internal_write', ledger: 'call', fallback_class: 'offline', eval_family: null, expected_cadence: 'weekly', ...LONG_BATCH },
  inventory_research: { side_effect_class: 'internal_write', ledger: 'call', fallback_class: 'interactive', eval_family: 'structured_extraction', expected_duration_ms: 180_000 },
  job_screen: { side_effect_class: 'internal_write', ledger: 'call', fallback_class: 'interactive', eval_family: 'classification' },
};

/**
 * The merged runtime policy for a lane. Unknown ids get the defaults with
 * side_effect_class null so a caller can tell "unclassified" from a real
 * class; never throws (this runs on the recording hot path).
 */
function policyFor(laneId) {
  const lane = LANE_RUNTIME[laneId] || null;
  return {
    ...DEFAULT_RUNTIME,
    side_effect_class: null,
    ledger: null,
    ...(lane || {}),
    budget: { ...DEFAULT_RUNTIME.budget, ...((lane && lane.budget) || {}) },
  };
}

module.exports = { DEFAULT_RUNTIME, LANE_RUNTIME, LEDGER, UNRECORDABLE_REASON, CADENCE, policyFor };
