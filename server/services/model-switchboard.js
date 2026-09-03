// Model switchboard — the Agents → Models tab's data.
//
// Answers one question per AI lane: which model runs it RIGHT NOW, through
// which registry selector, and which env var would move it. Everything is
// resolved against the live `config/models.js` exports plus the per-lane env
// pins the call sites read (`process.env.PIN || MODELS.TIER`), so the page
// reports the process's actual configuration rather than a hand-typed table.
//
// Read-only by design. Every registry selector is a module-load const, so the
// switch itself is a Railway env change + the restart Railway performs on
// save; the client composes those env lines. The lane catalog below is the
// audited call-site map (2026-09-02); LANE_REFS drift against the registry is
// caught by tests/model-switchboard.test.js.

const MODELS = require('../config/models');

// The picker's model catalog lives in the registry (every model id in one
// place — AGENTS.md model-ID rule); this module only resolves against it.
const { MODEL_CATALOG } = MODELS;

const RATES_AS_OF = '2026-09-02';

// Provider from a model id — the same prefix rule the picker filters on.
function providerOf(id) {
  if (!id) return 'unknown';
  if (id.startsWith('claude')) return 'anthropic';
  if (id.startsWith('gpt') || id.startsWith('text-embedding') || /^o\d/.test(id)) return 'openai';
  if (id.startsWith('gemini') || id.startsWith('veo')) return 'gemini';
  if (id === 'sonar' || id.startsWith('sonar')) return 'perplexity';
  return 'unknown';
}

// Ids the registry resolves to today that are not picker options (audio,
// embeddings, image/video generation) still need a label + provider.
function catalogEntry(id) {
  if (MODEL_CATALOG[id]) return MODEL_CATALOG[id];
  return { label: id, provider: providerOf(id), caps: [], rate: null, status: 'current' };
}

// ── Registry selectors ────────────────────────────────────────────────
// The env-overridable consts in config/models.js. `env` is the var the
// composer writes (first of the aliases the registry reads). `accepts`
// is what the picker may offer: the provider the call sites' SDK speaks and
// the modality the lanes need. `lock` removes the picker entirely.
const SELECTORS = [
  { key: 'FLAGSHIP', env: 'MODEL_FLAGSHIP', description: 'Best general reasoning', accepts: { providers: ['anthropic'], cap: 'text' } },
  { key: 'DEEP', env: 'MODEL_DEEP', description: 'Verifiers, judges, gates (via llm/deep.js)', accepts: { providers: ['anthropic'], cap: 'text' } },
  { key: 'EXTREME', env: 'MODEL_EXTREME', description: 'Explicit deep-audit opt-in; never automatic', accepts: { providers: ['anthropic'], cap: 'text' } },
  { key: 'WORKHORSE', env: 'MODEL_WORKHORSE', description: 'Drafting and content', accepts: { providers: ['anthropic'], cap: 'text' } },
  { key: 'FAST', env: 'MODEL_FAST', description: 'Claude leg of the fast lanes', accepts: { providers: ['anthropic'], cap: 'text' } },
  { key: 'VOICE', env: 'MODEL_VOICE', description: 'Spoken voice relay + Ask Waves fallback', accepts: { providers: ['anthropic'], cap: 'text' } },
  { key: 'VISION', env: 'MODEL_VISION', description: 'Claude photo scoring', accepts: { providers: ['anthropic'], cap: 'vision' } },
  { key: 'LAWN_CHALLENGE', env: 'MODEL_LAWN_CHALLENGE', description: 'Lawn diagnostic adversarial challenge', accepts: { providers: ['anthropic'], cap: 'text' } },
  { key: 'SMS_SONNET', env: 'MODEL_SMS_SONNET', description: 'Every SMS draft route', accepts: { providers: ['anthropic'], cap: 'text' } },
  { key: 'CALL_EXTRACTION_ANTHROPIC', env: 'MODEL_CALL_EXTRACTION_ANTHROPIC', description: 'Call extraction Claude fallback leg', accepts: { providers: ['anthropic'], cap: 'text' } },
  { key: 'CALL_RESEARCH_ANTHROPIC', env: 'MODEL_CALL_RESEARCH_ANTHROPIC', description: 'Call-research miner Claude fallback leg', accepts: { providers: ['anthropic'], cap: 'text' } },
  { key: 'OPENAI_REPORT_WRITER', env: 'MODEL_OPENAI_REPORT_WRITER', description: 'Reports + high-stakes backup (Sol)', accepts: { providers: ['openai'], cap: 'text' } },
  { key: 'OPENAI_BALANCED', env: 'MODEL_OPENAI_BALANCED', description: 'Q&A + customer-copy backup (Terra)', accepts: { providers: ['openai'], cap: 'text' } },
  { key: 'OPENAI_FAST', env: 'MODEL_OPENAI_FAST', description: 'Cheap structured classification (Luna)', accepts: { providers: ['openai'], cap: 'text' } },
  { key: 'OPENAI_SMS_DRAFT', env: 'MODEL_OPENAI_SMS_DRAFT', description: 'Sealed-eval Luna leg', accepts: { providers: ['openai'], cap: 'text' } },
  { key: 'GEMINI_VISION_BEST', env: 'MODEL_GEMINI_VISION', description: 'Gemini leg of the photo lanes', accepts: { providers: ['gemini'], cap: 'vision' } },
  { key: 'GEMINI_VISION_FALLBACK', env: 'GEMINI_VISION_FALLBACK_MODEL', description: 'Gemini photo retry model', accepts: { providers: ['gemini'], cap: 'vision' } },
  { key: 'GEMINI_TEXT_BEST', env: 'MODEL_GEMINI_TEXT', description: 'Sealed-eval Gemini leg (measurement only)', accepts: { providers: ['gemini'], cap: 'text' } },
  { key: 'OPENAI_EMBEDDING', env: 'MODEL_OPENAI_EMBEDDING', description: 'Knowledge embeddings (1536-dim)', accepts: { providers: ['openai'], cap: 'embedding' }, lock: { kind: 'migration', label: 'Requires re-embed', detail: 'changing it re-embeds the whole corpus' } },
  { key: 'GEMINI_IMAGE_BEST', env: 'MODEL_GEMINI_IMAGE', description: 'Image generation', accepts: { providers: ['gemini'], cap: 'image' }, lock: { kind: 'provider', label: 'Provider-specific', detail: 'image chain, not a text model' } },
  { key: 'GEMINI_IMAGE_STABLE', env: 'MODEL_GEMINI_IMAGE_STABLE', description: 'Image generation fallback', accepts: { providers: ['gemini'], cap: 'image' }, lock: { kind: 'provider', label: 'Provider-specific', detail: 'image chain, not a text model' } },
  { key: 'GEMINI_VIDEO_FAST', env: 'MODEL_GEMINI_VIDEO', description: 'Reels video generation', accepts: { providers: ['gemini'], cap: 'video' }, lock: { kind: 'provider', label: 'Provider-specific', detail: 'video chain, not a text model' } },
  { key: 'GEMINI_VIDEO_QUALITY', env: 'MODEL_GEMINI_VIDEO_QUALITY', description: 'Reels video step-up', accepts: { providers: ['gemini'], cap: 'video' }, lock: { kind: 'provider', label: 'Provider-specific', detail: 'video chain, not a text model' } },
];
// Aliases the registry also honours — reported as the override source when set.
const SELECTOR_ENV_ALIASES = {
  LAWN_CHALLENGE: ['LAWN_CHALLENGE_MODEL'],
  OPENAI_BALANCED: ['MODEL_OPENAI_BEST'],
};

// ROUTES.<key> and TEXT_POLICIES.<key>.<leg> are built from these selectors
// in config/models.js. Verified against the registry at resolve time (and by
// the test) so a re-pointed route can't be mis-attributed here.
const ROUTE_SELECTOR = {
  leadClassify: 'OPENAI_FAST',
  churnClassify: 'OPENAI_FAST',
  knowledgeAnswer: 'OPENAI_BALANCED',
  estimateAssistant: 'OPENAI_BALANCED',
  askWaves: 'OPENAI_BALANCED',
  smsDraftDefault: 'SMS_SONNET',
  smsDraftSaveSale: 'SMS_SONNET',
  smsToneRewrite: 'SMS_SONNET',
};
const POLICY_SELECTOR = {
  report: { primary: 'OPENAI_REPORT_WRITER', fallback: 'FLAGSHIP' },
  customerCopy: { primary: 'FLAGSHIP', fallback: 'OPENAI_BALANCED' },
  contentDraft: { primary: 'WORKHORSE', fallback: 'OPENAI_BALANCED' },
  highStakes: { primary: 'FLAGSHIP', fallback: 'OPENAI_REPORT_WRITER' },
  fastStructured: { primary: 'OPENAI_FAST', fallback: 'FAST' },
  balancedAnswer: { primary: 'OPENAI_BALANCED', fallback: 'WORKHORSE' },
  visionAnalysis: { primary: 'VISION', fallback: 'OPENAI_BALANCED' },
  visitBrief: { primary: 'WORKHORSE', fallback: 'OPENAI_BALANCED' },
  deepAnalysis: { primary: 'DEEP', fallback: 'OPENAI_REPORT_WRITER' },
};

// ── Lane refs ─────────────────────────────────────────────────────────
// How a lane names its model. Resolution mirrors the call site:
//   T(tier)            MODELS[tier]
//   R(route)           MODELS.ROUTES[route].model
//   P(policy, leg)     MODELS.TEXT_POLICIES[policy][leg].model
//   E(env, ref)        process.env[env] || resolve(ref)      (pin over a selector)
//   D(env, literal)    process.env[env] || literal           (out-of-registry lane)
const T = (tier) => ({ kind: 'tier', key: tier });
const R = (route) => ({ kind: 'route', key: route });
const P = (policy, leg) => ({ kind: 'policy', key: policy, leg });
const E = (env, ref, opts = {}) => ({ kind: 'env', env, ref, live: !!opts.live });
const D = (env, literal, opts = {}) => ({ kind: 'env', env, literal, live: !!opts.live, accepts: opts.accepts });

const POLICIES = [
  { key: 'fastText', label: 'Fast text', description: 'Classification, tagging, intent, sentiment — short JSON' },
  { key: 'multimodal', label: 'Multimodal processor', description: 'Photos, satellite, PDFs, maps, OCR' },
  { key: 'voice', label: 'Customer voice', description: 'Words a customer reads: SMS, recaps, reviews, social, email' },
  { key: 'report', label: 'Report writer', description: 'Completed-service and project narratives' },
  { key: 'qa', label: 'Balanced Q&A and analysis', description: 'Estimate assistant, knowledge answers, Ask Waves, SEO analysis' },
  { key: 'reason', label: 'High-stakes reasoner', description: 'Intelligence Bar, advisors, complaints, retention, adjudication' },
  { key: 'deep', label: 'Deep audit and verification', description: 'Verifiers, judges, gates, nightly audits' },
  { key: 'agents', label: 'Managed agents', description: 'Anthropic Managed Agents — Anthropic only by design' },
  { key: 'locked', label: 'Specialized and locked', description: 'Audio, embeddings, generation, bake-off-pinned extraction, measurement probes' },
  { key: 'ops', label: 'Operations coordinator', description: 'Muse Spark — no adapter exists, no lane routes here today' },
];

const LOCK = {
  benchmark: (detail) => ({ kind: 'benchmark', label: 'Bake-off pinned', detail }),
  provider: (detail) => ({ kind: 'provider', label: 'Provider-specific', detail }),
  migration: (detail) => ({ kind: 'migration', label: 'Requires re-embed', detail }),
  measurement: (detail) => ({ kind: 'measurement', label: 'Measurement probe', detail }),
  agents: (detail) => ({ kind: 'provider', label: 'Anthropic only', detail }),
};

const SHARED_GEMINI_PIN = 'GEMINI_VISION_MODEL env is shared by six photo lanes';
const L = (id, name, file, policy, primary, fallback = null, extra = {}) => ({ id, name, file, policy, primary, fallback, ...extra });

// The audited call-site map (server/, 2026-09-02). Grouped by the kind of
// work the lane does — NOT by the model it happens to run — so a routine lane
// riding a heavier model than its job needs is visible at a glance.
const LANES = [
  // ── Fast text ──
  L('lead_triage', 'Lead triage classification', 'lead-triage.js', 'fastText', R('leadClassify'), T('FAST')),
  L('churn_classify', 'Churn-reason classification', 'churn-classifier.js', 'fastText', R('churnClassify'), T('FAST')),
  L('email_classify', 'Inbound email classification', 'email/email-classifier.js', 'fastText', P('fastStructured', 'primary'), P('fastStructured', 'fallback')),
  L('sms_intent', 'SMS service-intent classification', 'sms-service-intent.js', 'fastText', P('fastStructured', 'primary'), P('fastStructured', 'fallback')),
  L('call_sentiment', 'Call sentiment', 'call-sentiment.js', 'fastText', P('fastStructured', 'primary'), P('fastStructured', 'fallback')),
  L('parse_when', 'Scheduling "when" parse', 'scheduling/parse-when.js', 'fastText', P('fastStructured', 'primary'), P('fastStructured', 'fallback')),
  L('social_judge', 'Social compliance judge', 'social-compliance-judge.js', 'fastText', P('fastStructured', 'primary'), P('fastStructured', 'fallback')),
  L('job_screen', 'Job application screening', 'job-application-screen.js', 'fastText', P('fastStructured', 'primary'), P('fastStructured', 'fallback')),
  L('footprint_claim', 'Service-footprint claim classifier', 'content/footprint-claim-classifier.js', 'fastText', P('fastStructured', 'primary'), P('fastStructured', 'fallback')),
  L('estimator_sms_signal', 'Estimator SMS thread quote signal', 'estimator-engine/sms-thread.js', 'fastText', P('fastStructured', 'primary'), P('fastStructured', 'fallback')),
  L('sms_pathology', 'SMS pathology clustering', 'sms-pathology-ledger.js', 'fastText', P('fastStructured', 'primary'), P('fastStructured', 'fallback'), { note: 'summary pass rides DEEP' }),
  L('contact_correction', 'SMS contact-correction extraction', 'contact-correction.js', 'fastText', T('FAST')),
  L('bounce_rescue', 'Email bounce address decode', 'email-bounce-rescue.js', 'fastText', T('FAST')),
  L('seo_intent', 'SEO query-intent classification', 'seo/seo-diagnosis-tools.js', 'fastText', T('FAST')),
  L('prospect_score', 'Backlink prospect scoring', 'seo/prospect-scorer.js', 'fastText', T('FAST')),
  L('signup_classifier', 'Backlink signup classifier', 'seo/signup-classifier.js', 'fastText', E('MODEL_SIGNUP_CLASSIFIER', T('FAST'))),
  L('mentions_sentiment', 'LLM-mention sentiment classification', 'seo/llm-mention-prober.js', 'fastText', T('FAST')),
  L('events', 'Community events ingestion, curation, normalizing', 'event-ingestion.js, event-curation.js, event-normalizer.js', 'fastText', T('WORKHORSE')),
  L('expense_categorize', 'Expense categorization', 'expense-categorizer.js', 'fastText', T('FLAGSHIP'), null, { note: 'routine categories on the flagship tier' }),

  // ── Multimodal ──
  L('pest_id', 'Pest identification (customer photo)', 'pest-identification.js', 'multimodal', T('VISION'), E('GEMINI_VISION_MODEL', T('GEMINI_VISION_BEST')), { fanout: true, note: `Claude + Gemini in parallel, Gemini retries on GEMINI_VISION_FALLBACK · ${SHARED_GEMINI_PIN}` }),
  L('lawn_assess', 'Lawn assessment (customer photo)', 'lawn-assessment.js', 'multimodal', T('VISION'), E('GEMINI_VISION_MODEL', T('GEMINI_VISION_BEST')), { fanout: true, note: `Claude + Gemini in parallel · ${SHARED_GEMINI_PIN}` }),
  L('tree_shrub', 'Tree & shrub assessment', 'tree-shrub-assessment.js', 'multimodal', T('VISION'), E('GEMINI_VISION_MODEL', T('GEMINI_VISION_BEST')), { fanout: true, note: `Claude + Gemini in parallel · ${SHARED_GEMINI_PIN}` }),
  L('treatment_zone', 'Treatment-zone suggestion (map)', 'treatment-zone-suggest.js', 'multimodal', T('VISION'), E('GEMINI_VISION_MODEL', T('GEMINI_VISION_BEST')), { fanout: true, note: `Claude + Gemini in parallel · ${SHARED_GEMINI_PIN}` }),
  L('tech_caption_vision', 'Tech social caption · photo read', 'tech-social-caption.js', 'multimodal', T('VISION'), E('GEMINI_VISION_MODEL', T('GEMINI_VISION_BEST')), { fanout: true, note: SHARED_GEMINI_PIN }),
  L('satellite', 'Satellite / aerial property analysis', 'satellite-analyzer.js', 'multimodal', T('FLAGSHIP'), E('GEMINI_VISION_MODEL', T('GEMINI_VISION_BEST')), { fanout: true, note: 'three legs today: Claude + OPENAI_VISION_MODEL (gpt-5-mini) + Gemini · owner ruling 2026-09-02: one Gemini model — not yet coded' }),
  L('property_trio', 'Property lookup trio (stories, roof)', 'property-lookup/ai-property-lookup.js', 'multimodal', T('WORKHORSE'), D('GEMINI_PROPERTY_MODEL', 'gemini-3.5-flash', { accepts: { providers: ['gemini'], cap: 'vision' } }), { fanout: true, note: 'consensus of Claude + OPENAI_PROPERTY_MODEL (gpt-5-mini) + Gemini' }),
  L('property_v2_vision', 'Property lookup v2 · vision legs', 'routes/property-lookup-v2.js', 'multimodal', T('FLAGSHIP'), D('GEMINI_VISION_MODEL', 'gemini-3.5-flash', { accepts: { providers: ['gemini'], cap: 'vision' } }), { fanout: true, note: 'plus OPENAI_VISION_MODEL (gpt-5-mini)' }),
  L('turf_ocr', 'Turf-height gauge OCR', 'turf-height-ocr.js', 'multimodal', D('GEMINI_TURF_OCR_MODEL', 'gemini-3.5-flash', { accepts: { providers: ['gemini'], cap: 'vision' } }), T('VISION')),
  L('photo_scoring', 'Completion photo scoring', 'routes/admin-dispatch.js', 'multimodal', P('visionAnalysis', 'primary'), P('visionAnalysis', 'fallback'), { note: 'drives customer-facing health scores (owner 2026-07-21)' }),
  L('vision_delta', 'Before / after vision delta', 'vision-delta.js', 'multimodal', P('visionAnalysis', 'primary'), P('visionAnalysis', 'fallback')),
  L('lawn_quality_gate', 'Lawn photo-quality gate', 'lawn-intelligence.js', 'multimodal', T('VISION')),
  L('lawn_diag_vision', 'Lawn diagnostic · vision leg', 'lawn-diagnostic-prompt.js', 'multimodal', D('LAWN_VISION_MODEL', 'gemini-3.5-flash', { accepts: { providers: ['gemini'], cap: 'vision' } }), T('VISION')),
  L('lawn_challenge', 'Lawn diagnostic · adversarial challenge', 'lawn-diagnostic-prompt.js', 'multimodal', T('LAWN_CHALLENGE')),
  L('hero_alt', 'Hero image alt-text', 'content/hero-alt-vision.js', 'multimodal', T('VISION')),
  L('wdo_project_brief', 'WDO project brief (photo + text)', 'routes/admin-projects.js', 'multimodal', P('visionAnalysis', 'primary'), P('visionAnalysis', 'fallback'), { note: 'text-only briefs ride contentDraft' }),
  L('invoice_pdf', 'Vendor invoice PDF processing', 'email/invoice-processor.js', 'multimodal', T('FLAGSHIP')),
  L('contact_dictation', 'Contact dictation decoder', 'contact-dictation.js', 'multimodal', D('GEMINI_CONTACT_DECODER_MODEL', 'gemini-2.5-pro', { live: true, accepts: { providers: ['gemini'], cap: 'text' } })),
  L('address_recovery', 'Address street recovery', 'address-validation/recovery.js', 'multimodal', D('GEMINI_RECOVERY_MODEL', 'gemini-2.5-pro', { live: true, accepts: { providers: ['gemini'], cap: 'text' } })),

  // ── Customer voice ──
  L('sms_draft', 'SMS auto-reply draft (routine)', 'sms-shadow-drafter.js', 'voice', R('smsDraftDefault'), P('highStakes', 'fallback')),
  L('sms_save_sale', 'SMS draft · save-the-sale', 'sms-shadow-drafter.js', 'voice', R('smsDraftSaveSale'), P('highStakes', 'fallback')),
  L('sms_tone', 'SMS tone rewrite', 'routes/admin-communications.js', 'voice', R('smsToneRewrite'), P('customerCopy', 'fallback')),
  L('sms_suggest', 'SMS draft suggestion (comms panel)', 'routes/admin-communications.js', 'voice', P('customerCopy', 'primary'), P('customerCopy', 'fallback')),
  L('response_drafter', 'SMS reply drafter (auto / high-stakes split)', 'response-drafter.js', 'voice', P('highStakes', 'primary'), P('highStakes', 'fallback'), { note: 'routine intents ride customerCopy' }),
  L('estimate_followup', 'Estimate-conversion follow-up SMS', 'estimate-conversion-agent.js, sms-shadow-drafter.js', 'voice', R('smsDraftDefault'), P('highStakes', 'fallback'), { note: 'delegates to the SMS drafter' }),
  L('completion_recap', 'Completion recap (customer-facing)', 'completion-recap.js', 'voice', P('customerCopy', 'primary'), P('customerCopy', 'fallback')),
  L('lawn_visit_narratives', 'Lawn + visit-summary narratives', 'service-report/lawn-report-narrative.js, service-report/visit-summary-narrative.js', 'voice', P('customerCopy', 'primary'), P('customerCopy', 'fallback')),
  L('social_copy', 'Social post copy', 'social-media.js', 'voice', P('customerCopy', 'primary'), P('customerCopy', 'fallback')),
  L('tech_caption_copy', 'Tech social caption · copy', 'tech-social-caption.js', 'voice', P('customerCopy', 'primary'), P('customerCopy', 'fallback')),
  L('review_ask', 'Review-ask drafting', 'review-ask-drafter.js', 'voice', P('customerCopy', 'primary'), P('customerCopy', 'fallback')),
  L('review_reply', 'GBP review replies', 'review-reply/drafter.js', 'voice', P('customerCopy', 'primary'), P('customerCopy', 'fallback')),
  L('review_gate_text', 'Review gate · customer review text', 'routes/review-gate.js', 'voice', P('customerCopy', 'primary'), P('customerCopy', 'fallback')),
  L('email_reply', 'Email reply drafting', 'email/email-actions.js', 'voice', P('customerCopy', 'primary'), P('customerCopy', 'fallback')),
  L('invoice_summary', 'Invoice AI summary', 'invoice-ai-summary.js', 'voice', P('customerCopy', 'primary'), P('customerCopy', 'fallback')),
  L('blog_draft', 'Blog post drafts', 'content/blog-writer.js', 'voice', P('contentDraft', 'primary'), P('contentDraft', 'fallback')),
  L('newsletter', 'Newsletter drafts + autopilot rerank', 'newsletter-draft.js, newsletter-autopilot.js, routes/admin-newsletter.js', 'voice', P('contentDraft', 'primary'), P('contentDraft', 'fallback')),
  L('content_misc', 'Content ideas, scheduler copy, automation emails', 'routes/admin-content-v2.js, content-scheduler.js, routes/admin-automations.js', 'voice', P('contentDraft', 'primary'), P('contentDraft', 'fallback')),
  L('previsit_brief', 'Pre-visit brief', 'previsit-brief.js', 'voice', P('visitBrief', 'primary'), P('visitBrief', 'fallback')),
  L('voice_relay', 'Voice relay + collections calls', 'voice-agent/relay-conversation.js, collections/outbound-voice/collections-conversation.js', 'voice', E('VOICE_RELAY_MODEL', T('VOICE')), null, { note: 'one env for both call flows' }),
  L('outreach_drafter', 'Backlink outreach drafting', 'seo/backlink-outreach-drafter.js', 'voice', E('MODEL_OUTREACH_DRAFTER', T('WORKHORSE'))),

  // ── Report writer ──
  L('report_copy', 'Completed-service report copy', 'routes/admin-schedule.js', 'report', P('report', 'primary'), P('report', 'fallback'), { note: 'deterministic safe copy if both miss' }),
  L('treatment_narrative', 'Treatment narrative', 'service-report/treatment-narrative.js', 'report', P('report', 'primary'), P('report', 'fallback')),
  L('rodent_narrative', 'Rodent / typed report narrative', 'service-report/rodent-report-narrative.js', 'report', P('report', 'primary'), P('report', 'fallback')),
  L('project_report', 'Project report draft', 'routes/admin-projects.js', 'report', P('report', 'primary'), P('report', 'fallback')),
  L('lawn_diag_writer', 'Lawn diagnostic · customer narrative', 'lawn-diagnostic-prompt.js', 'report', D('LAWN_WRITER_MODEL', 'gpt-5.5', { accepts: { providers: ['openai'], cap: 'text' } }), T('FLAGSHIP')),

  // ── Balanced Q&A ──
  L('estimate_assistant', 'Estimate assistant Q&A', 'estimate-assistant.js', 'qa', R('estimateAssistant'), E('ESTIMATE_ASSISTANT_MODEL', T('WORKHORSE'), { live: true })),
  L('knowledge_qa', 'Knowledge-base Q&A', 'knowledge-bridge.js', 'qa', R('knowledgeAnswer'), T('FLAGSHIP')),
  L('ask_waves', 'Ask Waves (public chat)', 'ask-waves-intake.js', 'qa', R('askWaves'), E('ASK_WAVES_MODEL', T('VOICE'), { live: true })),
  L('wiki_qa', 'Wiki Q&A', 'knowledge/wiki-qa.js', 'qa', T('FLAGSHIP')),
  L('wdo_history', 'WDO history lookup', 'property-lookup/wdo-history-lookup.js', 'qa', T('WORKHORSE')),
  L('link_investigator', 'Internal-link path investigation', 'seo/link-path-investigator.js', 'qa', T('WORKHORSE')),
  L('seo_advisor', 'SEO weekly advisor + action drafts', 'seo/seo-advisor.js, seo/seo-action-generator.js', 'qa', T('FLAGSHIP')),
  L('ads_advisor', 'Ads campaign advisor (daily)', 'ads/campaign-advisor.js', 'qa', T('FLAGSHIP')),
  L('chart_builder', 'AI chart builder (NL → SQL + chart)', 'ai-chart-builder.js', 'qa', T('FLAGSHIP'), T('GEMINI_VISION_BEST'), { note: 'Gemini reads the rendered chart' }),

  // ── High-stakes reasoner ──
  L('ib_admin', 'Intelligence Bar · admin', 'routes/admin-intelligence-bar.js', 'reason', E('INTELLIGENCE_BAR_MODEL', T('FLAGSHIP'))),
  L('ib_tech', 'Intelligence Bar · tech context', 'routes/admin-intelligence-bar.js', 'reason', E('INTELLIGENCE_BAR_TECH_MODEL', T('FLAGSHIP'), { live: true }), null, { note: 'read-only tools, low max_tokens' }),
  L('ib_tools', 'IB email / SMS / procurement tools', 'intelligence-bar/email-tools.js, intelligence-bar/comms-tools.js, intelligence-bar/procurement-tools.js', 'reason', T('FLAGSHIP')),
  L('commercial_proposal', 'Commercial proposal brief', 'estimator-engine/commercial-proposal.js', 'reason', P('highStakes', 'primary'), P('highStakes', 'fallback')),
  L('signal_detector', 'Customer signal detector', 'customer-intelligence/signal-detector.js', 'reason', T('FLAGSHIP')),
  L('retention_drafts', 'Retention drafts (owner-approved)', 'customer-intelligence/retention-engine.js', 'reason', T('FLAGSHIP')),
  L('tax_advisor', 'Tax advisor weekly report', 'tax-advisor.js', 'reason', T('FLAGSHIP')),
  L('csr_coach', 'CSR call coaching', 'csr/csr-coach.js', 'reason', T('FLAGSHIP')),
  L('inventory_research', 'Inventory vendor mapping + price research', 'routes/admin-inventory.js', 'reason', T('FLAGSHIP'), null, { note: 'Anthropic web_search tool' }),
  L('lead_synopsis', 'Lead synopsis from call', 'call-recording-processor.js', 'reason', T('FLAGSHIP')),
  L('codex_remediation', 'Content finding auto-fix', 'content/codex-remediation.js', 'reason', T('FLAGSHIP')),
  L('portal_assistant', 'Customer portal assistant', 'ai-assistant/assistant.js', 'reason', T('FLAGSHIP')),
  L('signup_worker', 'Backlink signup worker', 'backlink-agent/signup-worker.js', 'reason', T('FLAGSHIP')),
  L('form_filler', 'Backlink browser form filler (vision)', 'seo/browser-form-filler.js', 'reason', E('MODEL_SIGNUP_FILLER', T('FLAGSHIP'))),

  // ── Deep audit ──
  L('sms_verifier', 'SMS draft fact-check verifier', 'sms-draft-verifier.js', 'deep', T('DEEP'), P('deepAnalysis', 'fallback')),
  L('shadow_judge', 'SMS shadow judge', 'sms-shadow-judge.js', 'deep', T('DEEP'), P('deepAnalysis', 'fallback')),
  L('intent_composer', 'Estimator intent composer', 'estimator-engine/intent-composer.js', 'deep', E('ESTIMATOR_ENGINE_MODEL', T('DEEP'), { live: true }), P('deepAnalysis', 'fallback')),
  L('fact_check_gate', 'Blog fact-check gate', 'content/fact-check-gate.js', 'deep', E('MODEL_FACTCHECK', P('deepAnalysis', 'primary')), P('deepAnalysis', 'fallback')),
  L('compliance_gate', 'Content compliance gate', 'content/compliance-gate.js', 'deep', E('MODEL_COMPLIANCE', P('deepAnalysis', 'primary')), P('deepAnalysis', 'fallback'), { note: 'GATE_COMPLIANCE ships dark' }),
  L('blog_optimize', 'Blog optimization pass', 'content/blog-writer.js', 'deep', P('deepAnalysis', 'primary'), P('deepAnalysis', 'fallback')),
  L('kb_audit', 'Knowledge-base nightly audit', 'knowledge-base.js', 'deep', T('DEEP'), P('deepAnalysis', 'fallback')),
  L('wiki_compiler', 'Wiki compiler + agronomic wiki', 'knowledge/wiki-compiler.js, agronomic-wiki.js', 'deep', T('DEEP'), P('deepAnalysis', 'fallback')),
  L('quarantine_arbiter', 'Contact quarantine arbiter', 'contact-quarantine-arbiter.js', 'deep', T('DEEP'), P('deepAnalysis', 'fallback')),
  L('call_self_audit', 'Call self-audit', 'call-self-audit.js', 'deep', T('DEEP'), P('deepAnalysis', 'fallback')),
  L('wdo_appt_brief', 'WDO appointment brief', 'appointment-tagger.js', 'deep', P('deepAnalysis', 'primary'), P('deepAnalysis', 'fallback')),
  L('voice_profile', 'Voice-profile distiller (weekly)', 'voice-profile-distiller.js', 'deep', T('DEEP'), P('deepAnalysis', 'fallback')),
  L('extreme_tier', 'Explicit deep audit (EXTREME tier)', 'config/models.js', 'deep', T('EXTREME'), null, { note: 'no automatic lane — deliberate opt-in only' }),

  // ── Managed agents (Anthropic only) ──
  L('agent_bi', 'Weekly BI briefing agent', 'bi-agent-config.js', 'agents', T('FLAGSHIP'), null, { lock: LOCK.agents('Anthropic Managed Agents') }),
  L('agent_lead', 'Lead response agent', 'lead-response-agent-config.js', 'agents', T('FLAGSHIP'), null, { lock: LOCK.agents('Anthropic Managed Agents') }),
  L('agent_content', 'Content, blog writer, refresh agents', 'content/content-agent-config.js, content/agents/writer-agent-config.js, content/agents/refresh-agent-config.js', 'agents', T('FLAGSHIP'), null, { lock: LOCK.agents('Anthropic Managed Agents') }),
  L('agent_meta', 'Meta rewriter agent', 'content/agents/meta-rewriter-config.js', 'agents', T('WORKHORSE'), null, { lock: LOCK.agents('Anthropic Managed Agents') }),
  L('agent_backlink', 'Backlink strategy agent', 'seo/backlink-strategy-agent-config.js', 'agents', T('FLAGSHIP'), null, { lock: LOCK.agents('Anthropic Managed Agents') }),
  L('agent_assistant', 'Customer assistant (managed)', 'ai-assistant/managed-agent-config.js', 'agents', T('FLAGSHIP'), null, { lock: LOCK.agents('Anthropic Managed Agents') }),

  // ── Specialized / locked ──
  L('call_extraction', 'Call extraction V2', 'call-recording-processor.js', 'locked', D('CALL_EXTRACTION_MODEL', 'gpt-5.6-sol'), T('CALL_EXTRACTION_ANTHROPIC'), { lock: LOCK.benchmark('25-call bake-off 2026-07-18 · run a new bake-off to move it'), note: 'provider via CALL_EXTRACTION_PROVIDER' }),
  L('call_research', 'Call-research corpus miner', 'call-research-miner.js', 'locked', D('CALL_RESEARCH_MODEL', 'gpt-5.6-sol'), T('CALL_RESEARCH_ANTHROPIC'), { lock: LOCK.benchmark('7-arm bake-off 2026-07-18') }),
  L('transcription', 'Call transcription (primary + long-call verifier)', 'call-recording-processor.js', 'locked', D('OPENAI_TRANSCRIPTION_MODEL', 'gpt-4o-transcribe-diarize'), D('GEMINI_TRANSCRIPTION_MODEL', 'gemini-3.5-flash'), { lock: LOCK.provider('audio pipeline with its own validation') }),
  L('transcript_label', 'Transcript speaker relabeling', 'call-recording-processor.js', 'locked', D('OPENAI_TRANSCRIPT_LABEL_MODEL', 'gpt-5-mini'), null, { lock: LOCK.provider('audio pipeline') }),
  L('contact_pass', 'Second contact-pass STT (spelled emails, addresses)', 'call-recording-processor.js', 'locked', D('OPENAI_CONTACT_PASS_MODEL', 'gpt-4o-transcribe', { live: true }), null, { lock: LOCK.provider('speech-to-text') }),
  L('tech_dictation', 'Tech field dictation', 'routes/tech-track.js', 'locked', D('OPENAI_DICTATION_MODEL', 'gpt-4o-transcribe', { live: true }), null, { lock: LOCK.provider('speech-to-text') }),
  L('embeddings', 'Knowledge embeddings', 'llm/embed.js', 'locked', T('OPENAI_EMBEDDING'), null, { lock: LOCK.migration('single provider by design; degrades to full-text search') }),
  L('image_gen', 'Blog / social image generation', 'content/image-generator.js', 'locked', T('GEMINI_IMAGE_BEST'), T('GEMINI_IMAGE_STABLE'), { lock: LOCK.provider('gpt-image chain first, then Gemini') }),
  L('video_gen', 'Reels video generation', 'content/video-generator.js', 'locked', T('GEMINI_VIDEO_FAST'), T('GEMINI_VIDEO_QUALITY'), { lock: LOCK.provider('video chain') }),
  L('mentions_prober', 'LLM mentions prober (Claude, OpenAI, Gemini, Perplexity arms)', 'seo/llm-mention-prober.js', 'locked', E('MODEL_MENTIONS', T('WORKHORSE'), { live: true }), null, { lock: LOCK.measurement('each engine is probed directly; a fallback would falsify the measurement'), note: 'OPENAI_MENTIONS_MODEL gpt-4o-search-preview · GEMINI_MENTIONS_MODEL gemini-2.5-flash · PERPLEXITY_MENTIONS_MODEL sonar' }),
  L('sealed_eval', 'SMS sealed-eval exam legs', 'sms-sealed-eval.js', 'locked', T('SMS_SONNET'), T('OPENAI_REPORT_WRITER'), { lock: LOCK.measurement('frozen exam; Gemini / Luna / Opus / Fable measurement legs too') }),
];

// ── Resolution ────────────────────────────────────────────────────────
function firstSetEnv(names) {
  for (const name of names) {
    if (process.env[name]) return name;
  }
  return null;
}

function selectorEnvNames(sel) {
  return [sel.env, ...(SELECTOR_ENV_ALIASES[sel.key] || [])];
}

function resolveSelectors() {
  return SELECTORS.map((sel) => {
    const current = MODELS[sel.key];
    const overrideEnv = firstSetEnv(selectorEnvNames(sel));
    return {
      key: sel.key,
      env: sel.env,
      description: sel.description,
      accepts: sel.accepts,
      lock: sel.lock || null,
      current,
      provider: providerOf(current),
      overridden: !!overrideEnv,
      overrideEnv,
      laneCount: 0,
    };
  });
}

const SELECTOR_BY_KEY = Object.fromEntries(SELECTORS.map((s) => [s.key, s]));

// Resolve a ref to { model, selector, via, pinEnv, pinned, live, accepts }.
// `selector` is the registry selector the value ultimately comes from (null
// for out-of-registry literals); `via` is the human-readable path.
function resolveRef(ref) {
  if (!ref) return null;
  switch (ref.kind) {
    case 'tier': {
      const sel = SELECTOR_BY_KEY[ref.key];
      return { model: MODELS[ref.key], selector: ref.key, via: ref.key, pinEnv: null, pinned: false, live: false, accepts: sel ? sel.accepts : null };
    }
    case 'route': {
      const route = MODELS.ROUTES[ref.key];
      const selKey = ROUTE_SELECTOR[ref.key];
      const attributed = selKey && MODELS[selKey] === route?.model ? selKey : null;
      return { model: route?.model, selector: attributed, via: `ROUTES.${ref.key}${attributed ? ` → ${attributed}` : ''}`, pinEnv: null, pinned: false, live: false, accepts: attributed ? SELECTOR_BY_KEY[attributed].accepts : null };
    }
    case 'policy': {
      const leg = MODELS.TEXT_POLICIES[ref.key]?.[ref.leg];
      const selKey = POLICY_SELECTOR[ref.key]?.[ref.leg];
      const attributed = selKey && MODELS[selKey] === leg?.model ? selKey : null;
      return { model: leg?.model, selector: attributed, via: `TEXT_POLICIES.${ref.key}.${ref.leg}${attributed ? ` → ${attributed}` : ''}`, pinEnv: null, pinned: false, live: false, accepts: attributed ? SELECTOR_BY_KEY[attributed].accepts : null };
    }
    case 'env': {
      const pinned = !!process.env[ref.env];
      // unpinnedModel = what the leg runs on once the env var is deleted, so
      // the composer can offer "unpin" with an honest before/after.
      if (ref.literal !== undefined) {
        const model = process.env[ref.env] || ref.literal;
        return { model, selector: null, via: `${ref.env}${pinned ? '' : ' (code default)'}`, pinEnv: ref.env, pinned, unpinnedModel: ref.literal, live: ref.live, accepts: ref.accepts || { providers: [providerOf(model)], cap: 'text' } };
      }
      const base = resolveRef(ref.ref);
      const model = process.env[ref.env] || base.model;
      return { model, selector: base.selector, via: pinned ? `${ref.env} (pinned)` : `${ref.env} → ${base.via}`, pinEnv: ref.env, pinned, unpinnedModel: base.model, live: ref.live, accepts: base.accepts };
    }
    default:
      return null;
  }
}

function withProvider(leg) {
  if (!leg) return null;
  return { ...leg, provider: providerOf(leg.model) };
}

function getSwitchboard() {
  const selectors = resolveSelectors();
  const byKey = Object.fromEntries(selectors.map((s) => [s.key, s]));
  const lanes = LANES.map((lane) => {
    const primary = withProvider(resolveRef(lane.primary));
    const fallback = withProvider(resolveRef(lane.fallback));
    if (primary.selector && byKey[primary.selector] && !primary.pinned) byKey[primary.selector].laneCount += 1;
    return {
      id: lane.id,
      name: lane.name,
      file: lane.file,
      policy: lane.policy,
      primary,
      fallback,
      applies: primary.live ? 'live' : 'restart',
      lock: lane.lock || null,
      fanout: !!lane.fanout,
      note: lane.note || null,
    };
  });
  const models = { ...MODEL_CATALOG };
  for (const lane of lanes) {
    for (const leg of [lane.primary, lane.fallback]) {
      if (leg?.model && !models[leg.model]) models[leg.model] = catalogEntry(leg.model);
    }
  }
  for (const s of selectors) {
    if (s.current && !models[s.current]) models[s.current] = catalogEntry(s.current);
  }
  return {
    generatedAt: new Date().toISOString(),
    ratesAsOf: RATES_AS_OF,
    models,
    selectors,
    policies: POLICIES,
    lanes,
  };
}

module.exports = {
  getSwitchboard,
  resolveRef,
  providerOf,
  // exported for the drift test
  LANES,
  SELECTORS,
  POLICIES,
  ROUTE_SELECTOR,
  POLICY_SELECTOR,
  MODEL_CATALOG,
};
