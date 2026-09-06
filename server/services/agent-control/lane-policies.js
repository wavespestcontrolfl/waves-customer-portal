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
 *                (audio | embedding | image | video | search | direct_sdk —
 *                the site calls the provider SDK directly, bypassing the
 *                adapters; unrecordable until it is migrated)
 * `expected_cadence`: 'event' = candidate-driven, no silence alarm;
 *   hourly / daily / weekly = a cron lane that alarms when it goes quiet.
 *   Set only where the tick UNCONDITIONALLY calls the model; a queue worker,
 *   candidate scan or cached/weekly-guarded refresh that can legitimately
 *   make no call stays 'event' (Codex r8 on PR #3793).
 * `maturity`: only where the lane's own code makes it obvious (an approval
 *   queue = M2, a shadow-only lane = M0, auto-apply with an audit trail = M3).
 *
 * Invariants (tested): stall_after_ms >= 2 x heartbeat_interval_ms and
 * hard_timeout_ms >= expected_duration_ms for every merged policy.
 */

const LEDGER = Object.freeze(['call', 'session', 'unrecordable']);
const UNRECORDABLE_REASON = Object.freeze(['audio', 'embedding', 'image', 'video', 'search', 'direct_sdk', 'no_call_site']);
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
  // customer_visible + M3 (Codex r23): classified by the worst-case path — with GATE_SMS_AUTO_SEND on, an intent promoted to auto_send hands
  // the drafted reply to maybeAutoSend() and it reaches the customer with no human step (deliveredAs 'auto_sent', judge-covered). Gate off = shadow rows.
  sms_draft: { side_effect_class: 'customer_visible', ledger: 'call', fallback_class: 'interactive', eval_family: 'routine_copy', maturity: 'M3' },
  sms_save_sale: { side_effect_class: 'customer_visible', ledger: 'call', fallback_class: 'interactive', eval_family: 'high_stakes_copy', maturity: 'M3' },
  // M2 (Codex r20): both return text the comms client installs into the editable body; sending is the operator's separate action.
  sms_tone: { side_effect_class: 'draft_for_human', ledger: 'call', fallback_class: 'interactive', eval_family: 'routine_copy', maturity: 'M2' },
  sms_suggest: { side_effect_class: 'draft_for_human', ledger: 'call', fallback_class: 'interactive', eval_family: 'routine_copy', maturity: 'M2' },
  // response-drafter.js picks customerCopy for routine intents and highStakes for cancel / complaint / severity (two switchboard lanes since #3769 b21f45aeb).
  response_drafter: { side_effect_class: 'draft_for_human', ledger: 'call', fallback_class: 'interactive', eval_family: 'routine_copy', maturity: 'M2' },
  response_drafter_high_stakes: { side_effect_class: 'draft_for_human', ledger: 'call', fallback_class: 'interactive', eval_family: 'high_stakes_copy', maturity: 'M2' },
  estimate_followup: { side_effect_class: 'draft_for_human', ledger: 'call', fallback_class: 'interactive', eval_family: 'routine_copy', maturity: 'M0' },
  sms_intent: { side_effect_class: 'internal_write', ledger: 'call', fallback_class: 'interactive', eval_family: 'classification' },
  // offline: one bounded Anthropic call; a miss returns null so the durable
  // queue retries later — no cross-provider chain, no deterministic answer.
  contact_correction: { side_effect_class: 'internal_write', ledger: 'call', fallback_class: 'offline', eval_family: 'structured_extraction', maturity: 'M3' },
  sms_pathology: { side_effect_class: 'internal_write', ledger: 'call', fallback_class: 'offline', eval_family: 'classification', ...LONG_BATCH },
  sms_verifier: { side_effect_class: 'internal_write', ledger: 'call', fallback_class: 'interactive', eval_family: 'compliance_check' },
  // offline, not measurement: the nightly judge goes through createDeepMessage,
  // which deliberately falls back to the OpenAI leg and records who judged.
  shadow_judge: { side_effect_class: 'internal_write', ledger: 'call', fallback_class: 'offline', eval_family: 'compliance_check', maturity: 'M0', workflow_id: 'shadow-judge', ...LONG_BATCH },
  // event, not daily: the distiller skips when a profile is pending or no new
  // corpus exists, and the sealed exam returns already_examined once the
  // current prompt/profile has been scored — healthy lanes that stay quiet.
  // M3: a profile that passes its deterministic checks is approved by
  // auto_distiller and made live without a human (audit-logged).
  voice_profile: { side_effect_class: 'internal_write', ledger: 'call', fallback_class: 'offline', eval_family: null, maturity: 'M3', workflow_id: 'voice-profile-distiller', ...LONG_BATCH },
  sealed_eval: { side_effect_class: 'internal_write', ledger: 'call', fallback_class: 'measurement', eval_family: 'routine_copy', ...LONG_BATCH },
  quarantine_arbiter: { side_effect_class: 'internal_write', ledger: 'call', fallback_class: 'interactive', eval_family: 'transcription_contact' },
  // Route canaries: one tiny probe per draft route at boot + every 6h; the
  // answer IS the measurement (a substitute provider would hide the outage
  // it exists to catch). Alerts = admin bell + internal SMS to the owner.
  sms_canary_default: { side_effect_class: 'internal_write', ledger: 'call', fallback_class: 'measurement', eval_family: null, expected_cadence: 'daily', expected_duration_ms: 15_000 },
  sms_canary_save_sale: { side_effect_class: 'internal_write', ledger: 'call', fallback_class: 'measurement', eval_family: null, expected_cadence: 'daily', expected_duration_ms: 15_000 },

  // ── Calls ──
  call_extraction: { side_effect_class: 'internal_write', ledger: 'call', fallback_class: 'interactive', eval_family: 'structured_extraction', maturity: 'M0', ...CALL_PIPELINE },
  // direct_sdk (Codex r15): V1 extraction and transcript relabeling are raw Gemini / OpenAI fetches in call-recording-processor.js.
  // offline (Codex r16): each is one provider with no cross-provider answer, retried by the background call pipeline.
  call_extraction_v1: { side_effect_class: 'internal_write', ledger: 'unrecordable', unrecordable_reason: 'direct_sdk', fallback_class: 'offline', eval_family: 'structured_extraction', ...CALL_PIPELINE },
  // workflow_id = the cron job (scheduler.js runExclusive name) whose body IS this lane's run — the module names the lane on its calls — so job_health rows read with the lane's long-batch policy, not the 1-min default (Codex r3). Lanes served by two jobs (sms_pathology: classify + propose; sealed_eval: seal + autorun) or one job serving two lanes (sms-draft-canary) stay unmapped until the S5 cron wrap registers the job per run.
  call_research: { side_effect_class: 'internal_write', ledger: 'call', fallback_class: 'offline', eval_family: 'structured_extraction', workflow_id: 'call-research-miner', ...LONG_BATCH },
  transcription: { side_effect_class: 'internal_write', ledger: 'unrecordable', unrecordable_reason: 'audio', fallback_class: 'interactive', eval_family: 'transcription_contact', ...CALL_PIPELINE },
  transcript_label: { side_effect_class: 'internal_write', ledger: 'unrecordable', unrecordable_reason: 'direct_sdk', fallback_class: 'offline', eval_family: 'transcription_contact', ...CALL_PIPELINE },
  contact_pass: { side_effect_class: 'internal_write', ledger: 'unrecordable', unrecordable_reason: 'audio', fallback_class: 'offline', eval_family: 'transcription_contact', ...CALL_PIPELINE },
  call_sentiment: { side_effect_class: 'internal_write', ledger: 'call', fallback_class: 'interactive', eval_family: 'classification' },
  call_self_audit: { side_effect_class: 'internal_write', ledger: 'call', fallback_class: 'offline', eval_family: 'compliance_check', workflow_id: 'call-self-audit', ...LONG_BATCH },
  lead_synopsis: { side_effect_class: 'internal_write', ledger: 'unrecordable', unrecordable_reason: 'direct_sdk', fallback_class: 'offline', eval_family: 'structured_extraction' },
  // The hourly cron only verifies follow-ups (no model call); the model runs
  // per scored call and for the weekly recommendation — candidate-driven.
  // direct_sdk (Codex r12 sweep): csr_coach, wdo_history, signal_detector, retention_drafts, ads_advisor, wiki_qa,
  // tax_advisor call anthropic.messages.create directly — no adapter row until migrated (S2a); expense_categorize left this list in #3821.
  // offline (Codex r14): contact_pass, lead_synopsis, contact_dictation, address_recovery and tech_dictation each
  // run one provider and degrade to null / a review path / typed notes — no cross-provider answer. lead_synopsis is also direct_sdk.
  // direct_sdk (Codex r15): contact_dictation and address_recovery are raw Gemini fetches (contact-dictation.js, address-validation/recovery.js).
  csr_coach: { side_effect_class: 'internal_write', ledger: 'unrecordable', unrecordable_reason: 'direct_sdk', fallback_class: 'offline', eval_family: null },
  contact_dictation: { side_effect_class: 'internal_write', ledger: 'unrecordable', unrecordable_reason: 'direct_sdk', fallback_class: 'offline', eval_family: 'transcription_contact' },
  address_recovery: { side_effect_class: 'internal_write', ledger: 'unrecordable', unrecordable_reason: 'direct_sdk', fallback_class: 'offline', eval_family: 'structured_extraction' },
  tech_dictation: { side_effect_class: 'internal_write', ledger: 'unrecordable', unrecordable_reason: 'audio', fallback_class: 'offline', eval_family: 'transcription_contact' },
  parse_when: { side_effect_class: 'read_only', ledger: 'call', fallback_class: 'interactive', eval_family: 'structured_extraction' },

  // ── Voice AI agent ──
  // offline: streams from Anthropic only with a canned spoken error — no second provider (Codex r12).
  // direct_sdk: both relay implementations stream through the Anthropic SDK, not llm/call.js (Codex r14).
  // M3 (Codex r19): replies go straight to the caller mid-call; the ordered transcript is written back to call_log on close.
  voice_relay: { side_effect_class: 'customer_visible', ledger: 'unrecordable', unrecordable_reason: 'direct_sdk', fallback_class: 'offline', eval_family: 'high_stakes_copy', maturity: 'M3', expected_duration_ms: 15_000, stall_after_ms: 60_000, hard_timeout_ms: 900_000 },

  // ── Photos & property ──
  // direct_sdk: the photo lanes call Anthropic directly and Gemini over raw HTTP, not llm/call.js (Codex r13);
  // satellite, both property-lookup lanes and turf OCR do the same for every provider arm (Codex r14);
  // treatment_zone (raw Gemini fetch + anthropic.messages.create), lawn_quality_gate (new Anthropic()), the three
  // lawn-diagnostic stages (raw Gemini / OpenAI fetches + the SDK) are direct_sdk too (Codex r15).
  // offline (Codex r15): the pest / lawn / tree-shrub fetches and treatment_zone's Gemini attempts carry no AbortSignal,
  // so a stalled provider hangs the request past any interactive hard timeout — same condition as chart_builder_image.
  // M3 (Codex r19): pest_id persists pest_identifications and returns the teaser + claim token with no staff review; tree_shrub
  // scores with autoConfirm=true and marks its photos customer-visible on completion.
  pest_id: { side_effect_class: 'customer_visible', ledger: 'unrecordable', unrecordable_reason: 'direct_sdk', fallback_class: 'offline', eval_family: 'vision_id', maturity: 'M3' },
  // M3 (Codex r20): the public analyzer's fallback path converts analyzePhoto() into report findings it persists and teases without staff review.
  lawn_assess: { side_effect_class: 'customer_visible', ledger: 'unrecordable', unrecordable_reason: 'direct_sdk', fallback_class: 'offline', eval_family: 'vision_id', maturity: 'M3' },
  tree_shrub: { side_effect_class: 'customer_visible', ledger: 'unrecordable', unrecordable_reason: 'direct_sdk', fallback_class: 'offline', eval_family: 'vision_id', maturity: 'M3' },
  treatment_zone: { side_effect_class: 'internal_write', ledger: 'unrecordable', unrecordable_reason: 'direct_sdk', fallback_class: 'offline', eval_family: 'property_measurement' },
  // offline (Codex r18): the caption ladder passes no timeoutMs, so a stalled first Gemini rung never reaches either fallback.
  tech_caption_vision: { side_effect_class: 'draft_for_human', ledger: 'call', fallback_class: 'offline', eval_family: 'vision_id' },
  // offline (Codex r17): satellite's Promise.allSettled fetches and turf OCR's Gemini leg carry no AbortSignal, and the OCR reading
  // is a background enrichment left pending for a later retry — neither can honour an interactive hard timeout.
  satellite: { side_effect_class: 'internal_write', ledger: 'unrecordable', unrecordable_reason: 'direct_sdk', fallback_class: 'offline', eval_family: 'property_measurement', expected_duration_ms: 120_000 },
  property_trio: { side_effect_class: 'internal_write', ledger: 'unrecordable', unrecordable_reason: 'direct_sdk', fallback_class: 'interactive', eval_family: 'property_measurement', expected_duration_ms: 120_000 },
  property_v2_vision: { side_effect_class: 'internal_write', ledger: 'unrecordable', unrecordable_reason: 'direct_sdk', fallback_class: 'interactive', eval_family: 'property_measurement', expected_duration_ms: 120_000 },
  turf_ocr: { side_effect_class: 'internal_write', ledger: 'unrecordable', unrecordable_reason: 'direct_sdk', fallback_class: 'offline', eval_family: 'vision_id' },
  // draft_for_human + M2 (Codex r20): /photo-analysis/draft installs summary + captions into the tech's editable completion state; the later completion submits them.
  photo_scoring: { side_effect_class: 'draft_for_human', ledger: 'call', fallback_class: 'interactive', eval_family: 'vision_id', maturity: 'M2' },
  // offline + M3 (Codex r22): sweepUnscoredOutcomes is a scheduled batch that retries a pair up to 3 attempts, then applies the verdict,
  // score, attempt count and terminal stamp to treatment_outcomes with no human step.
  vision_delta: { side_effect_class: 'internal_write', ledger: 'call', fallback_class: 'offline', eval_family: 'vision_id', maturity: 'M3' },
  // offline (Codex r16): lawn_quality_gate fails open on a miss and lawn_challenge falls to the caller's symptom downgrade — one Anthropic request each, no second provider.
  lawn_quality_gate: { side_effect_class: 'read_only', ledger: 'unrecordable', unrecordable_reason: 'direct_sdk', fallback_class: 'offline', eval_family: 'vision_id' },
  // offline (Codex r17): runPerception / runWriter await unbounded raw Gemini + OpenAI fetches before either fallback can run.
  lawn_diag_vision: { side_effect_class: 'internal_write', ledger: 'unrecordable', unrecordable_reason: 'direct_sdk', fallback_class: 'offline', eval_family: 'vision_id' },
  lawn_challenge: { side_effect_class: 'internal_write', ledger: 'unrecordable', unrecordable_reason: 'direct_sdk', fallback_class: 'offline', eval_family: 'compliance_check' },
  // M3 (Codex r19): the public lawn analyzer persists customer_summary and returns the teaser without staff review.
  lawn_diag_writer: { side_effect_class: 'customer_visible', ledger: 'unrecordable', unrecordable_reason: 'direct_sdk', fallback_class: 'offline', eval_family: 'service_report', maturity: 'M3' },
  // direct_sdk + offline (Codex r18): the WDO treatment-photo path in admin-projects.js is one anthropic.messages.create with no fallback.
  // Both sites (brief + treatment-photo read) ride dispatchWithFallback, so the
  // adapters record them; the direct_sdk mark was stale (S2c follow-up).
  wdo_project_brief: { side_effect_class: 'internal_write', ledger: 'call', fallback_class: 'offline', eval_family: null },
  // internal_write: a project-scoped lookup persists the answer to projects.wdo_history (admin-projects.js) — Codex r9.
  wdo_history: { side_effect_class: 'internal_write', ledger: 'unrecordable', unrecordable_reason: 'direct_sdk', fallback_class: 'offline', eval_family: 'retrieval_qa' },

  // ── Estimates & sales ──
  // direct_sdk (Codex r17): lead-triage.js's Claude fallback is new Anthropic().messages.create — an OpenAI outage would record only the miss.
  lead_triage: { side_effect_class: 'internal_write', ledger: 'unrecordable', unrecordable_reason: 'direct_sdk', fallback_class: 'interactive', eval_family: 'classification' },
  // customer_visible + M3 (Codex r17): the public estimate ask handler returns the answer straight to the customer and audit-logs it.
  // direct_sdk (Codex r18): answerWithAnthropic builds its own client after an OpenAI miss.
  estimate_assistant: { side_effect_class: 'customer_visible', ledger: 'unrecordable', unrecordable_reason: 'direct_sdk', fallback_class: 'interactive', eval_family: 'retrieval_qa', maturity: 'M3' },
  estimator_sms_signal: { side_effect_class: 'internal_write', ledger: 'call', fallback_class: 'interactive', eval_family: 'classification' },
  // draft_for_human + M2 (Codex r22): the composed intent is priced deterministically by draft-builder into an estimate draft nobody sends until an operator reviews it.
  intent_composer: { side_effect_class: 'draft_for_human', ledger: 'call', fallback_class: 'interactive', eval_family: 'structured_extraction', maturity: 'M2', expected_duration_ms: 120_000 },
  // M2 (Codex r20): persists the brief + an unpriced, disabled estimate scaffold; the operator prices, enables and sends.
  commercial_proposal: { side_effect_class: 'draft_for_human', ledger: 'call', fallback_class: 'interactive', eval_family: 'high_stakes_copy', maturity: 'M2' },
  churn_classify: { side_effect_class: 'internal_write', ledger: 'call', fallback_class: 'interactive', eval_family: 'classification' },
  signal_detector: { side_effect_class: 'internal_write', ledger: 'unrecordable', unrecordable_reason: 'direct_sdk', fallback_class: 'offline', eval_family: 'classification', ...LONG_BATCH },
  retention_drafts: { side_effect_class: 'draft_for_human', ledger: 'unrecordable', unrecordable_reason: 'direct_sdk', fallback_class: 'offline', eval_family: 'high_stakes_copy', maturity: 'M2', ...LONG_BATCH },

  // ── Service reports ──
  // draft_for_human + M2 (Codex r19): /generate-report copy lands in the tech's editable notes and reaches the customer only through the later completion action.
  report_copy: { side_effect_class: 'draft_for_human', ledger: 'call', fallback_class: 'interactive', eval_family: 'service_report', maturity: 'M2' },
  // M3 (Codex r21): buildTreatmentNarrative runs on report read with no staff step and caches the copy in service_report_ai_summaries.
  treatment_narrative: { side_effect_class: 'customer_visible', ledger: 'call', fallback_class: 'interactive', eval_family: 'service_report', maturity: 'M3' },
  rodent_narrative: { side_effect_class: 'customer_visible', ledger: 'call', fallback_class: 'interactive', eval_family: 'service_report' },
  // M2 (Codex r20): both admin-projects AI-write endpoints return copy into the editable Recommendations field; delivery is a separate admin action.
  project_report: { side_effect_class: 'draft_for_human', ledger: 'call', fallback_class: 'interactive', eval_family: 'service_report', maturity: 'M2' },
  // M3: admin-dispatch completion auto-generates the recap when the tech supplies none, persists it in structured_notes and
  // sends it in the customer completion SMS with no approval step (Codex r15).
  completion_recap: { side_effect_class: 'customer_visible', ledger: 'call', fallback_class: 'interactive', eval_family: 'service_report', maturity: 'M3' },
  lawn_visit_narratives: { side_effect_class: 'customer_visible', ledger: 'call', fallback_class: 'interactive', eval_family: 'service_report' },
  // event: the half-hourly sweep returns cached briefs unchanged, so a stable
  // route (or a day with no eligible visits) makes no model call.
  // M3 (Codex r21): the generator writes body + provenance straight into scheduled_services.pre_service_brief; no approval boundary.
  previsit_brief: { side_effect_class: 'internal_write', ledger: 'call', fallback_class: 'offline', eval_family: 'retrieval_qa', maturity: 'M3' },
  // interactive: runs while the tech opens the drawer — bounded cross-provider
  // fallback, then the deterministic template (Codex r8 on #3885).
  job_card_paragraph: { side_effect_class: 'internal_write', ledger: 'call', fallback_class: 'interactive', eval_family: 'retrieval_qa', maturity: 'M1' },
  // M2 (Codex r20): notes / email copy land in the editable invoice fields, never saved or sent directly.
  invoice_summary: { side_effect_class: 'draft_for_human', ledger: 'call', fallback_class: 'interactive', eval_family: 'routine_copy', maturity: 'M2' },
  // M3 (Codex r21): appointment-tagger generates and persists the brief the moment the appointment is tagged.
  wdo_appt_brief: { side_effect_class: 'internal_write', ledger: 'call', fallback_class: 'interactive', eval_family: null, maturity: 'M3' },

  // ── Email ──
  // irreversible_external + M3 (Codex r16): a marketing_newsletter verdict runs executeAutoAction — Gmail archive and a one-click
  // unsubscribe request with no approval, audited on the emails row (email-classifier.js → email-actions.js).
  email_classify: { side_effect_class: 'irreversible_external', ledger: 'call', fallback_class: 'interactive', eval_family: 'classification', maturity: 'M3' },
  // M2 (Codex r20): creates a Gmail draft (id recorded) and never sends; the operator reviews and sends it.
  email_reply: { side_effect_class: 'draft_for_human', ledger: 'call', fallback_class: 'interactive', eval_family: 'routine_copy', maturity: 'M2' },
  // M2 (Codex r16): the LLM decode leg only ever yields a `suggested` candidate emailed to the owner; applying it is an operator action.
  bounce_rescue: { side_effect_class: 'internal_write', ledger: 'call', fallback_class: 'interactive', eval_family: 'structured_extraction', maturity: 'M2' },
  // direct_sdk (Codex r15): email/invoice-processor.js parses through its own new Anthropic() client.
  // offline (Codex r16): background email step, one request, continues without parsed data on a miss.
  invoice_pdf: { side_effect_class: 'internal_write', ledger: 'unrecordable', unrecordable_reason: 'direct_sdk', fallback_class: 'offline', eval_family: 'structured_extraction', expected_duration_ms: 120_000 },

  // ── Content & SEO ──
  // M3 (Codex r19): a scheduled draft can ride the 'publishing' claim through pages-poll auto-merge after the preview + Codex gates.
  blog_draft: { side_effect_class: 'customer_visible', ledger: 'call', fallback_class: 'offline', eval_family: 'high_stakes_copy', maturity: 'M3', ...LONG_BATCH },
  // draft_for_human + M2 (Codex r21): optimizeExistingPost only stores optimization_suggestions; the operator applies them to the draft by hand.
  blog_optimize: { side_effect_class: 'draft_for_human', ledger: 'call', fallback_class: 'offline', eval_family: 'high_stakes_copy', maturity: 'M2', ...LONG_BATCH },
  newsletter: { side_effect_class: 'draft_for_human', ledger: 'call', fallback_class: 'offline', eval_family: 'routine_copy', maturity: 'M2', ...LONG_BATCH },
  // irreversible_external + M3 (Codex r20): generateNewsletterSocialContent feeds publishToAll in the gated newsletter auto-share with no per-post
  // approval, outcome persisted on the newsletter row — the shared lane is classified by its worst-case path.
  content_misc: { side_effect_class: 'irreversible_external', ledger: 'call', fallback_class: 'interactive', eval_family: 'routine_copy', maturity: 'M3' },
  // M3: SOCIAL_RSS_AUTOPUBLISH publishes via publishToAll without approval and records the result in social_media_posts — Codex r11.
  social_copy: { side_effect_class: 'irreversible_external', ledger: 'call', fallback_class: 'offline', eval_family: 'routine_copy', maturity: 'M3' },
  // M3 (Codex r23): judgeSocialCopy's verdict is applied unattended — a rejection flips the post to compliance_rejected or parks the GBP action.
  social_judge: { side_effect_class: 'internal_write', ledger: 'call', fallback_class: 'interactive', eval_family: 'compliance_check', maturity: 'M3' },
  // M2 (Codex r20): captions return to editable textareas; a separate Publish action posts the selected versions.
  tech_caption_copy: { side_effect_class: 'draft_for_human', ledger: 'call', fallback_class: 'interactive', eval_family: 'routine_copy', maturity: 'M2' },
  review_ask: { side_effect_class: 'customer_visible', ledger: 'call', fallback_class: 'interactive', eval_family: 'routine_copy', maturity: 'M3' },
  // M3: GATE_REVIEW_AUTO_REPLY=auto publishes without approval and persists the audit evidence — Codex r9.
  review_reply: { side_effect_class: 'irreversible_external', ledger: 'call', fallback_class: 'interactive', eval_family: 'high_stakes_copy', maturity: 'M3' },
  // M3 (Codex r18): review-gate.js returns the generated copy to the customer and persists generated_review_text — no staff step.
  review_gate_text: { side_effect_class: 'customer_visible', ledger: 'call', fallback_class: 'interactive', eval_family: 'routine_copy', maturity: 'M3' },
  // customer_visible + M3 (Codex r18): the autonomous publisher stamps the alt text into blog frontmatter the PR poller can auto-merge.
  hero_alt: { side_effect_class: 'customer_visible', ledger: 'unrecordable', unrecordable_reason: 'direct_sdk', fallback_class: 'offline', eval_family: 'vision_id', maturity: 'M3' },
  fact_check_gate: { side_effect_class: 'internal_write', ledger: 'call', fallback_class: 'offline', eval_family: 'compliance_check', expected_duration_ms: 120_000 },
  compliance_gate: { side_effect_class: 'internal_write', ledger: 'call', fallback_class: 'offline', eval_family: 'compliance_check', expected_duration_ms: 120_000 },
  // irreversible_external + M3: with AUTONOMOUS_CODEX_REMEDIATION on, it pushes fixes to the Astro PR branch via gh.putFile and re-tags Codex (Codex r14).
  // hero_alt, seo_intent, seo_advisor, prospect_score, events: anthropic.messages.create direct — direct_sdk (Codex r14).
  codex_remediation: { side_effect_class: 'irreversible_external', ledger: 'call', fallback_class: 'offline', eval_family: 'high_stakes_copy', maturity: 'M3', ...LONG_BATCH },
  footprint_claim: { side_effect_class: 'internal_write', ledger: 'call', fallback_class: 'offline', eval_family: 'compliance_check' },
  // offline (Codex r16): classifyQueryIntent calls Anthropic only and drops to keyword rules on a miss (seo-diagnosis-tools.js).
  seo_intent: { side_effect_class: 'read_only', ledger: 'unrecordable', unrecordable_reason: 'direct_sdk', fallback_class: 'offline', eval_family: 'classification' },
  // M3 (Codex r16): the Monday cron runs generateWeeklyReport unattended, persists seo_advisor_reports and texts the owner — same shape as agent_bi.
  seo_advisor: { side_effect_class: 'internal_write', ledger: 'unrecordable', unrecordable_reason: 'direct_sdk', fallback_class: 'offline', eval_family: null, maturity: 'M3', ...LONG_BATCH },
  prospect_score: { side_effect_class: 'internal_write', ledger: 'unrecordable', unrecordable_reason: 'direct_sdk', fallback_class: 'offline', eval_family: 'classification' },
  // event, not weekly: a healthy weekly tick over an empty board (or only
  // known directories, handled heuristically) makes no model call.
  // direct_sdk: signup-classifier, outreach-drafter and browser-form-filler call anthropic.messages.create directly (Codex r13).
  // form_filler M3: the live runner submits allowlisted forms with no per-item approval and persists attempt + screenshot evidence.
  signup_classifier: { side_effect_class: 'internal_write', ledger: 'unrecordable', unrecordable_reason: 'direct_sdk', fallback_class: 'offline', eval_family: 'classification' },
  outreach_drafter: { side_effect_class: 'draft_for_human', ledger: 'unrecordable', unrecordable_reason: 'direct_sdk', fallback_class: 'offline', eval_family: 'routine_copy', maturity: 'M2' },
  form_filler: { side_effect_class: 'irreversible_external', ledger: 'unrecordable', unrecordable_reason: 'direct_sdk', fallback_class: 'offline', eval_family: null, maturity: 'M3', ...LONG_BATCH },
  // M3: the gated runner submits allowlisted listings with no per-item approval and records evidence in seo_link_attempts (Codex r12).
  signup_worker: { side_effect_class: 'irreversible_external', ledger: 'call', fallback_class: 'offline', eval_family: null, maturity: 'M3', ...LONG_BATCH },
  link_investigator: { side_effect_class: 'internal_write', ledger: 'call', fallback_class: 'offline', eval_family: 'retrieval_qa', ...LONG_BATCH },
  // event, not daily (Codex r17): the 3am tick returns before the prober when GATE_SEO_INTELLIGENCE is off, and each provider
  // skips without credentials — a dark or unconfigured lane must not page as gone-silent.
  mentions_prober: { side_effect_class: 'internal_write', ledger: 'unrecordable', unrecordable_reason: 'search', fallback_class: 'measurement', eval_family: null, ...LONG_BATCH },
  // direct_sdk (Codex r16): classifySentiment builds its own Anthropic client (seo/llm-mention-prober.js), not llm/call.js.
  mentions_sentiment: { side_effect_class: 'internal_write', ledger: 'unrecordable', unrecordable_reason: 'direct_sdk', fallback_class: 'offline', eval_family: 'classification' },
  // customer_visible + M3 (Codex r19): hero/body images are committed into the auto-mergeable post PR — same boundary as hero_alt.
  image_gen: { side_effect_class: 'customer_visible', ledger: 'unrecordable', unrecordable_reason: 'image', fallback_class: 'offline', eval_family: null, maturity: 'M3', expected_duration_ms: 180_000 },
  // draft_for_human + M2 (Codex r18): a Veo clip is only made for a draft campaign run and lands in the approval queue.
  video_gen: { side_effect_class: 'draft_for_human', ledger: 'unrecordable', unrecordable_reason: 'video', fallback_class: 'offline', eval_family: null, maturity: 'M2', ...LONG_BATCH },
  events: { side_effect_class: 'internal_write', ledger: 'unrecordable', unrecordable_reason: 'direct_sdk', fallback_class: 'offline', eval_family: 'classification', maturity: 'M3', ...LONG_BATCH },
  // events_editorial (main 2026-09-03): curation + normalizing copy on the two-provider contentDraft policy; cron batch.
  // customer_visible: curation can flip events_raw.admin_status to approved, making model-selected events publishable with no human (pre-push P1).
  events_editorial: { side_effect_class: 'customer_visible', ledger: 'call', fallback_class: 'offline', eval_family: 'routine_copy', maturity: 'M3', ...LONG_BATCH },
  // M3 (Codex r16): the 8am cron runs generateDailyAdvice unattended, persists ad_advisor_reports and texts the owner.
  ads_advisor: { side_effect_class: 'internal_write', ledger: 'unrecordable', unrecordable_reason: 'direct_sdk', fallback_class: 'offline', eval_family: null, maturity: 'M3' },

  // ── Intelligence Bar & knowledge ──
  // direct_sdk (Codex r14): the /query loop and the email/comms/procurement tools call anthropic.messages.create directly.
  // chart_builder_image + knowledge_qa are offline: no deadline on the Gemini leg / background enrichment that returns null on a miss.
  // offline: the /query handler runs every tool-loop round on one Anthropic client — 503 without a key, error path on failure, no second provider (Codex r13).
  ib_admin: { side_effect_class: 'internal_write', ledger: 'unrecordable', unrecordable_reason: 'direct_sdk', fallback_class: 'offline', eval_family: 'sql_tool', expected_duration_ms: 120_000 },
  // internal_write: every tech IB request logs an intelligence_bar_queries row and tool use a tool_health_events row — Codex r10.
  ib_tech: { side_effect_class: 'internal_write', ledger: 'unrecordable', unrecordable_reason: 'direct_sdk', fallback_class: 'offline', eval_family: 'sql_tool' },
  // M2 (Codex r21): the email tool returns a marked draft and procurement research inserts pending price-approval rows — nothing acts without the later approval.
  ib_tools: { side_effect_class: 'draft_for_human', ledger: 'unrecordable', unrecordable_reason: 'direct_sdk', fallback_class: 'offline', eval_family: 'routine_copy', maturity: 'M2' },
  chart_builder_image: { side_effect_class: 'read_only', ledger: 'call', fallback_class: 'offline', eval_family: 'vision_id' },
  // interactive (Codex r21, reversing r9): generateChartSpec now runs the bounded cross-provider dispatchWithFallback(highStakes)
  // and the /ai-chart/preview handler answers a miss with a 422 — a synchronous UI request, not a retried queue.
  chart_builder_sql: { side_effect_class: 'read_only', ledger: 'call', fallback_class: 'interactive', eval_family: 'sql_tool' },
  // internal_write: knowledge_qa's only caller writes lawn_assessments
  // ai_summary / recommendations; every WikiQA query logs to knowledge_queries.
  // direct_sdk (Codex r17): knowledge-bridge.js callClaude falls back through its own Anthropic client after an OpenAI miss.
  knowledge_qa: { side_effect_class: 'internal_write', ledger: 'unrecordable', unrecordable_reason: 'direct_sdk', fallback_class: 'offline', eval_family: 'retrieval_qa' },
  wiki_qa: { side_effect_class: 'internal_write', ledger: 'unrecordable', unrecordable_reason: 'direct_sdk', fallback_class: 'offline', eval_family: 'retrieval_qa' },
  kb_audit: { side_effect_class: 'internal_write', ledger: 'call', fallback_class: 'offline', eval_family: 'compliance_check', ...LONG_BATCH },
  wiki_compiler: { side_effect_class: 'internal_write', ledger: 'call', fallback_class: 'offline', eval_family: 'retrieval_qa', ...LONG_BATCH },
  embeddings: { side_effect_class: 'internal_write', ledger: 'unrecordable', unrecordable_reason: 'embedding', fallback_class: 'offline', eval_family: null },
  // no_call_site: the EXTREME tier is a deliberate opt-in with no automatic lane — nothing dispatches on it today, so there is no call to label (S2c).
  extreme_tier: { side_effect_class: 'read_only', ledger: 'unrecordable', unrecordable_reason: 'no_call_site', fallback_class: 'interactive', eval_family: null, expected_duration_ms: 300_000 },

  // ── Customer portal ──
  // M3 (Codex r17): processIntakeMessage returns the reply to the public intake route and records it sent_to_customer with its session audit.
  ask_waves: { side_effect_class: 'customer_visible', ledger: 'call', fallback_class: 'interactive', eval_family: 'retrieval_qa', maturity: 'M3' },
  // offline + M3: single Anthropic client, canned error copy; tools run without approval and every call is persisted to agent_messages (Codex r12).
  // direct_sdk: that client is the raw SDK — agent_messages is an audit trail, not the adapter call ledger (Codex r14).
  portal_assistant: { side_effect_class: 'customer_visible', ledger: 'unrecordable', unrecordable_reason: 'direct_sdk', fallback_class: 'offline', eval_family: 'retrieval_qa', maturity: 'M3' },

  // ── Managed agents (sessions) ──
  // M3: the Monday session sends the owner SMS and saves the report without approval (bi-agent-tools) — Codex r13.
  agent_bi: { side_effect_class: 'internal_write', ledger: 'session', fallback_class: 'offline', eval_family: 'long_running_agent', maturity: 'M3', expected_cadence: 'weekly', ...AGENT_SESSION },
  // offline: Managed Agents are Anthropic-only sessions (switchboard: "Managed agents (Anthropic only)") — no cross-provider path (Codex r12).
  agent_lead: { side_effect_class: 'customer_visible', ledger: 'session', fallback_class: 'offline', eval_family: 'long_running_agent', maturity: 'M3', ...AGENT_SESSION },
  // irreversible_external: distribute_to_social → SocialMedia.publishToAll
  // posts straight to the platforms (content-agent-tools.js) — Codex r2.
  agent_content: { side_effect_class: 'irreversible_external', ledger: 'session', fallback_class: 'offline', eval_family: 'long_running_agent', maturity: 'M3', ...AGENT_SESSION },
  // agent_meta customer_visible + M3: the daily runner publishes the metadata rewrite as an Astro PR the poller can auto-merge (Codex r14).
  // agent_backlink M3: queue / prospect / report tools persist rows with no per-tool approval (Codex r14).
  agent_meta: { side_effect_class: 'customer_visible', ledger: 'session', fallback_class: 'offline', eval_family: 'long_running_agent', maturity: 'M3', ...AGENT_SESSION },
  agent_backlink: { side_effect_class: 'internal_write', ledger: 'session', fallback_class: 'offline', eval_family: 'long_running_agent', maturity: 'M3', ...AGENT_SESSION },
  agent_assistant: { side_effect_class: 'customer_visible', ledger: 'session', fallback_class: 'offline', eval_family: 'long_running_agent', maturity: 'M3', ...AGENT_SESSION },

  // ── Back office ──
  // ledger call (Codex r16): #3821 moved expense-categorizer.js onto dispatchWithFallback (highStakes policy), so every call records.
  // M3 (Codex r22): admin-tax create-without-category and the bulk categorizer persist the matched category immediately; verification comes later.
  expense_categorize: { side_effect_class: 'internal_write', ledger: 'call', fallback_class: 'offline', eval_family: 'classification', maturity: 'M3' },
  // M3 (Codex r18): the Sunday cron persists the report and texts the owner with no approval — same shape as seo_advisor / ads_advisor.
  tax_advisor: { side_effect_class: 'internal_write', ledger: 'unrecordable', unrecordable_reason: 'direct_sdk', fallback_class: 'offline', eval_family: null, maturity: 'M3', expected_cadence: 'weekly', ...LONG_BATCH },
  // offline: direct Anthropic SDK calls, no second provider, failures reach the Express error path — Codex r10.
  // unrecordable/direct_sdk: both workflows call anthropic.messages.create directly, bypassing the adapters the call ledger records — Codex r11.
  inventory_research: { side_effect_class: 'internal_write', ledger: 'unrecordable', unrecordable_reason: 'direct_sdk', fallback_class: 'offline', eval_family: 'structured_extraction', expected_duration_ms: 180_000 },
  // M1 (Codex r16): every application is screened automatically for owner ranking; no status change or applicant outcome depends on it.
  job_screen: { side_effect_class: 'internal_write', ledger: 'call', fallback_class: 'interactive', eval_family: 'classification', maturity: 'M1' },
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
