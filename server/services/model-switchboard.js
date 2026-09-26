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
// A Fable / Mythos id configured before it reaches the catalog must keep the
// deep-only restriction (same rule as model-discovery.requiresDeep).
function catalogEntry(id) {
  if (MODEL_CATALOG[id]) return MODEL_CATALOG[id];
  const entry = { label: id, provider: providerOf(id), caps: [], status: 'current' };
  if (/^claude-(fable|mythos)/.test(id)) entry.requires = 'deep';
  return entry;
}

// ── Registry selectors ────────────────────────────────────────────────
// The env-overridable consts in config/models.js. `env` is the var the
// composer writes (first of the aliases the registry reads). `accepts`
// is what the picker may offer: the provider the call sites' SDK speaks, the
// modality the lanes need, and `deep: true` where every call site reaches the
// model through services/llm/deep.js (the only path that handles Fable's
// thinking blocks + refusals — catalog entries with requires:'deep'). `lock`
// removes the picker entirely.
const SELECTORS = [
  // General reasoning callers may include images; keep a vision-capable tier.
  { key: 'FLAGSHIP', env: 'MODEL_FLAGSHIP', description: 'Best general reasoning', accepts: { providers: ['anthropic'], cap: 'vision' } },
  { key: 'DEEP', env: 'MODEL_DEEP', description: 'Verifiers, judges, gates (via llm/deep.js)', accepts: { providers: ['anthropic'], cap: 'text', deep: true } },
  { key: 'EXTREME', env: 'MODEL_EXTREME', description: 'Explicit deep-audit opt-in; never automatic', accepts: { providers: ['anthropic'], cap: 'text', deep: true } },
  { key: 'WORKHORSE', env: 'MODEL_WORKHORSE', description: 'Drafting and content', accepts: { providers: ['anthropic'], cap: 'text' } },
  { key: 'FAST', env: 'MODEL_FAST', description: 'Claude leg of the fast lanes', accepts: { providers: ['anthropic'], cap: 'text' } },
  { key: 'VOICE', env: 'MODEL_VOICE', description: 'Spoken voice relay + Ask Waves fallback', accepts: { providers: ['anthropic'], cap: 'text' } },
  { key: 'VISION', env: 'MODEL_VISION', description: 'Claude photo scoring', accepts: { providers: ['anthropic'], cap: 'vision' } },
  { key: 'LAWN_CHALLENGE', env: 'MODEL_LAWN_CHALLENGE', description: 'Lawn diagnostic adversarial challenge', accepts: { providers: ['anthropic'], cap: 'text' } },
  { key: 'VOICE_JUDGE', env: 'MODEL_VOICE_JUDGE', description: 'Voice relay eval judge (pinned: moving it re-baselines the Sandy scorecard)', accepts: { providers: ['anthropic'], cap: 'text' } },
  { key: 'SMS_SONNET', env: 'MODEL_SMS_SONNET', description: 'Every SMS draft route', accepts: { providers: ['anthropic'], cap: 'text' } },
  { key: 'CALL_EXTRACTION_ANTHROPIC', env: 'MODEL_CALL_EXTRACTION_ANTHROPIC', description: 'Call extraction Claude fallback leg', accepts: { providers: ['anthropic'], cap: 'text' }, lock: { kind: 'benchmark', label: 'Bake-off pinned', detail: 'fallback leg of the 25-call bake-off route; run a new bake-off to move it' } },
  { key: 'CALL_RESEARCH_ANTHROPIC', env: 'MODEL_CALL_RESEARCH_ANTHROPIC', description: 'Call-research miner Claude fallback leg', accepts: { providers: ['anthropic'], cap: 'text' }, lock: { kind: 'benchmark', label: 'Bake-off pinned', detail: 'fallback leg of the 7-arm bake-off route' } },
  { key: 'OPENAI_REPORT_WRITER', env: 'MODEL_OPENAI_REPORT_WRITER', description: 'Reports + high-stakes backup (Sol)', accepts: { providers: ['openai'], cap: 'text' } },
  { key: 'OPENAI_BALANCED', env: 'MODEL_OPENAI_BALANCED', description: 'Q&A + customer-copy backup; OpenAI leg of the vision route (Terra)', accepts: { providers: ['openai'], cap: 'vision' } },
  { key: 'OPENAI_FRONTIER', env: 'MODEL_OPENAI_FRONTIER', description: 'Frontier OpenAI vision — lawn visit assessment backup leg and the pest identifier\'s second look (Astra)', accepts: { providers: ['openai'], cap: 'vision' } },
  { key: 'OPENAI_ESTIMATE_VISION', env: 'MODEL_OPENAI_ESTIMATE_VISION', description: 'Estimate satellite/property image fallback (Sol)', accepts: { providers: ['openai'], cap: 'vision' } },
  { key: 'OPENAI_IMAGE_SCREEN', env: 'MODEL_OPENAI_IMAGE_SCREEN', description: 'Generated-image screen (Sol) — blog image text/logo/uniform/van check', accepts: { providers: ['openai'], cap: 'vision' } },
  { key: 'OPENAI_FAST', env: 'MODEL_OPENAI_FAST', description: 'Cheap structured classification (Luna)', accepts: { providers: ['openai'], cap: 'text' } },
  { key: 'OPENAI_SMS_DRAFT', env: 'MODEL_OPENAI_SMS_DRAFT', description: 'Sealed-eval Luna leg (follows OPENAI_FAST unless set)', derivesFrom: 'OPENAI_FAST', accepts: { providers: ['openai'], cap: 'text' }, lock: { kind: 'measurement', label: 'Measurement probe', detail: 'frozen exam leg; changing it invalidates the sealed-eval ranking' } },
  { key: 'GEMINI_VISION_BEST', env: 'MODEL_GEMINI_VISION', description: 'Gemini leg of the photo lanes', accepts: { providers: ['gemini'], cap: 'vision' } },
  { key: 'GEMINI_VISION_FALLBACK', env: 'GEMINI_VISION_FALLBACK_MODEL', description: 'Gemini photo retry model', accepts: { providers: ['gemini'], cap: 'vision' } },
  { key: 'GEMINI_TEXT_BEST', env: 'MODEL_GEMINI_TEXT', description: 'Sealed-eval Gemini leg (measurement only)', accepts: { providers: ['gemini'], cap: 'text' }, lock: { kind: 'measurement', label: 'Measurement probe', detail: 'frozen exam leg; changing it invalidates the sealed-eval ranking' } },
  { key: 'OPENAI_EMBEDDING', env: 'MODEL_OPENAI_EMBEDDING', description: 'Knowledge embeddings (1536-dim)', accepts: { providers: ['openai'], cap: 'embedding' }, lock: { kind: 'migration', label: 'Requires re-embed', detail: 'changing it re-embeds the whole corpus' } },
  { key: 'GEMINI_IMAGE_PRO', env: 'MODEL_GEMINI_IMAGE_PRO', description: 'Image generation — Nano Banana Pro leg (SynthID-watermarked; unreachable unless ALLOW_PIXEL_WATERMARKED_IMAGE_PROVIDERS=true)', accepts: { providers: ['gemini'], cap: 'image' }, lock: { kind: 'provider', label: 'Provider-specific', detail: 'image chain, not a text model' } },
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
  askWaves: { primary: 'OPENAI_BALANCED', fallback: 'VOICE' },
  visionAnalysis: { primary: 'VISION', fallback: 'OPENAI_BALANCED' },
  estimateVision: { primary: 'GEMINI_VISION_BEST', fallback: 'OPENAI_ESTIMATE_VISION' },
  photoCaptions: { primary: 'GEMINI_VISION_BEST', fallback: 'VISION' },
  lawnVisitAssessment: { primary: 'GEMINI_VISION_BEST', fallback: 'OPENAI_FRONTIER' },
  photoIdVision: { primary: 'GEMINI_VISION_BEST', fallback: 'OPENAI_FRONTIER' },
  visitBrief: { primary: 'WORKHORSE', fallback: 'OPENAI_BALANCED' },
  jobCardParagraph: { primary: 'OPENAI_FAST', fallback: 'FAST' },
  deepAnalysis: { primary: 'DEEP', fallback: 'OPENAI_REPORT_WRITER' },
  imageScreen: { primary: 'OPENAI_IMAGE_SCREEN', fallback: 'VISION' },
  voiceJudge: { primary: 'VOICE_JUDGE', fallback: 'OPENAI_REPORT_WRITER' },
};

// ── Lane refs ─────────────────────────────────────────────────────────
// How a lane names its model. Resolution mirrors the call site:
//   T(tier)            MODELS[tier]
//   R(route)           MODELS.ROUTES[route].model
//   P(policy, leg)     MODELS.TEXT_POLICIES[policy][leg].model
//   E(env, ref)        process.env[env] || resolve(ref)      (pin over a selector)
//   D(env, literal)    process.env[env] || literal           (out-of-registry lane)
// `opts.parse` on E works like D's: for the rare env whose call site validates
// the raw value (an allowlist, not a bare pass-through) before running it.
// Called with the raw string; returns the id to report, or null to report the
// same fallback the call site itself would use for a rejected value.
// `opts.catalogOnly` marks a leg whose call site allowlist-checks the raw env
// against config/models.js MODEL_CATALOG (never a live-discovered id) — the
// picker consults `accepts.catalogOnly` to stop offering a search result the
// runtime would reject after restart. Only meaningful with `opts.parse`,
// which is what actually enforces it at read time; this just advertises it.
const T = (tier) => ({ kind: 'tier', key: tier });
const R = (route) => ({ kind: 'route', key: route });
const P = (policy, leg) => ({ kind: 'policy', key: policy, leg });
const E = (env, ref, opts = {}) => ({ kind: 'env', env, ref, live: !!opts.live, parse: opts.parse || null, catalogOnly: !!opts.catalogOnly, allowed: opts.allowed || null });
// D(env | [env, ...aliases], literal): the call site reads the first set var
// in order (property records: OPENAI_PROPERTY_MODEL || OPENAI_MODEL || 'gpt-5-mini').
// The composer writes the FIRST (specific) name; aliases only report.
//   opts.parse(value)  when the env value is not a bare model id (the image
//                      chain "gpt-image-2,gemini-image-best"): returns the
//                      model id the call site actually runs first, or null to
//                      fall back to the literal exactly as the call site does.
const D = (env, literal, opts = {}) => ({ kind: 'env', env, literal, live: !!opts.live, accepts: opts.accepts, parse: opts.parse || null });
//   S(providerEnv, legs) provider switch, exactly as call-recording-processor.js
//                      and call-research-miner.js build their route: primary =
//                      legs[process.env[providerEnv] || 'openai']; fallback =
//                      legs.openai when the primary is anthropic, else legs.anthropic.
//                      A lane whose primary is S() derives its fallback from it.
//                      `fallbackLegs` overrides the fallback refs where the call
//                      site's fallback ignores the primary override (research
//                      miner: CALL_RESEARCH_MODEL moves the primary only).
const S = (providerEnv, legs, fallbackLegs = null) => ({ kind: 'switch', env: providerEnv, legs, fallbackLegs });
//   LIT(model)         a model id the call site hardcodes with no env at all
const LIT = (model, accepts) => ({ kind: 'literal', model, accepts });

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
  // Managed agents: the model is embedded when the agent is registered with
  // Anthropic (out of band, from the *-agent-config.js files); the runtime
  // invokes the registered agent by id, so a registry change reaches these
  // lanes at the NEXT registration, not on a Railway restart. The composer
  // therefore never counts them in a selector's blast radius.
  registration: (detail) => ({ kind: 'registration', label: 'Registered agent', detail }),
};
const AGENT_LOCK = LOCK.registration('Anthropic Managed Agents · model set at registration; re-register to move it');

// BLOG_IMAGE_PROVIDER is a comma-separated provider chain, not a model id:
// the first VALID slug is what the generator tries first (an all-invalid
// value falls back to its default chain, hence null → the literal). Lazy
// require: image-generator pulls in fetch + logger at load.
// The Nth leg of the EFFECTIVE image chain — image-generator's own parser,
// which drops SynthID-watermarked Gemini slugs unless
// ALLOW_PIXEL_WATERMARKED_IMAGE_PROVIDERS=true (and, with the override on and
// no env chain, restores the pre-2026-09-24 interleaved defaults). The lane's
// primary AND fallback both read through it, so the Models page shows the
// legs that will really run, override on or off.
function nthImageChainModel(n) {
  return (value) => {
    const { parseChain, MODEL_MAP } = require('./content/image-generator')._internals;
    const slug = parseChain(value)[n];
    return slug ? MODEL_MAP[slug].model : null;
  };
}
const firstImageChainModel = nthImageChainModel(0);
const secondImageChainModel = nthImageChainModel(1);

// Social keeps its OWN default chain (SOCIAL_DEFAULT_CHAIN, social-media.js's
// engine — not moved to the blog chain, no gpt-image-2.5-sunburst leg
// yet). image-generator's parseChain/MODEL_MAP do the parsing (same slugs,
// same pixel-watermark filter) but its OWN no-env default is the BLOG chain,
// so a bare `parseChain(value)` call here would silently report the blog
// lane's default whenever SOCIAL_IMAGE_PROVIDER is unset. Falling back to the
// social engine's own default (watermark-allowed variant included, mirroring
// CREATIVE_FLAGS.chain's own env-override logic) keeps the no-env case honest.
function nthSocialImageChainModel(n) {
  return (value) => {
    const { parseChain, MODEL_MAP } = require('./content/image-generator')._internals;
    const { SOCIAL_DEFAULT_CHAIN, SOCIAL_WATERMARK_ALLOWED_DEFAULT_CHAIN } = require('./social-creative-engine');
    const allowWatermark = process.env.ALLOW_PIXEL_WATERMARKED_IMAGE_PROVIDERS === 'true';
    const noEnvChain = allowWatermark ? SOCIAL_WATERMARK_ALLOWED_DEFAULT_CHAIN : SOCIAL_DEFAULT_CHAIN;
    const slug = parseChain(value || noEnvChain)[n];
    return slug ? MODEL_MAP[slug].model : null;
  };
}
const firstSocialImageChainModel = nthSocialImageChainModel(0);
const secondSocialImageChainModel = nthSocialImageChainModel(1);

// Lane extras: `retry` = the leg tried after the fallback leg (the fan-out
// photo lanes re-run Gemini on GEMINI_VISION_FALLBACK; the sequential caption
// ladder reaches Claude only after both Gemini rungs); `also` = further legs
// that run IN PARALLEL with the primary (the fan-outs' OpenAI arm). Both
// resolve like any ref and count in the Models-in-use view and the change
// preview. Without `fanout`, primary → fallback → retry IS the execution order.
// `skipsEqualLeg` = the implementation guards FALLBACK !== MODEL, so a leg that
// resolves to the same model as the one before it is not called: it is emitted
// with `skipped: true` (kept for dependency math, hidden by the card); ladders
// without the flag call every leg.
const SHARED_GEMINI_PIN = 'GEMINI_VISION_MODEL env is shared by eight photo lanes';
// `inbound: true` = the lane's prompt carries customer or third-party content
// (SMS, email, call transcripts, uploaded photos/PDFs, web forms). The Gemini
// adapter (llm/call.js) folds the system prompt into the user turn, so moving
// an inbound lane onto Gemini widens the prompt-injection surface — the tab
// warns on that specific move.
const L = (id, name, file, policy, primary, fallback = null, extra = {}) => ({ id, name, file, policy, primary, fallback, ...extra });

// voice_relay's E() parse + allowed hooks (below): VOICE_RELAY_INBOUND_MODEL is
// the one pin here the call site itself allowlist-checks. Lazy require — this
// file loads at server boot, well before any inbound call; relay-conversation.js
// pulls in the Anthropic SDK, db and other heavier deps this module has no
// other reason to load. Both hooks ask the runtime's OWN allowlist verdict
// (isAllowedOverrideModel, the check resolveSessionModel applies) — never
// compare resolved model ids, which cannot tell a rejected override from a
// fallback that happens to carry the same id.
function inboundOverrideParse(raw) {
  const { isAllowedOverrideModel } = require('./voice-agent/relay-conversation');
  return isAllowedOverrideModel(raw) ? raw : null;
}
function inboundOverrideAllowed() {
  const { ALLOWED_OVERRIDE_MODEL_IDS } = require('./voice-agent/relay-conversation');
  return [...ALLOWED_OVERRIDE_MODEL_IDS];
}

// The audited call-site map (server/, 2026-09-02). Grouped by the kind of
// work the lane does — NOT by the model it happens to run — so a routine lane
// riding a heavier model than its job needs is visible at a glance.
const LANES = [
  // ── Fast text ──
  L('lead_triage', 'Lead triage classification', 'lead-triage.js', 'fastText', R('leadClassify'), T('FAST'), { inbound: true }),
  L('churn_classify', 'Churn-reason classification', 'churn-classifier.js', 'fastText', R('churnClassify'), T('FAST'), { inbound: true }),
  L('email_classify', 'Inbound email classification', 'email/email-classifier.js', 'fastText', P('fastStructured', 'primary'), P('fastStructured', 'fallback'), { inbound: true }),
  L('sms-commitment-fulfillment', 'SMS completion verification', 'sms-commitment-fulfillment.js', 'deep', P('highStakes', 'primary'), P('highStakes', 'fallback'), { inbound: true }),
  L('sms-operational-actions', 'SMS operational extraction', 'sms-operational-extractor.js', 'fastText', P('highStakes', 'primary'), P('highStakes', 'fallback'), { inbound: true }),
  L('sms_intent', 'SMS service-intent classification', 'sms-service-intent.js', 'fastText', P('fastStructured', 'primary'), P('fastStructured', 'fallback'), { inbound: true }),
  L('call_sentiment', 'Call sentiment', 'call-sentiment.js', 'fastText', P('fastStructured', 'primary'), P('fastStructured', 'fallback'), { inbound: true }),
  L('parse_when', 'Scheduling "when" parse', 'scheduling/parse-when.js', 'fastText', P('fastStructured', 'primary'), P('fastStructured', 'fallback'), { inbound: true }),
  L('social_judge', 'Social compliance judge', 'social-compliance-judge.js', 'fastText', P('fastStructured', 'primary'), P('fastStructured', 'fallback')),
  L('job_screen', 'Job application screening', 'job-application-screen.js', 'fastText', P('fastStructured', 'primary'), P('fastStructured', 'fallback'), { inbound: true }),
  L('footprint_claim', 'Service-footprint claim classifier', 'content/footprint-claim-classifier.js', 'fastText', P('fastStructured', 'primary'), P('fastStructured', 'fallback')),
  L('estimator_sms_signal', 'Estimator SMS thread quote signal', 'estimator-engine/sms-thread.js', 'fastText', P('fastStructured', 'primary'), P('fastStructured', 'fallback'), { inbound: true }),
  L('sms_solicitation', 'SMS solicitation screen', 'sms-solicitation-classifier.js', 'fastText', P('fastStructured', 'primary'), P('fastStructured', 'fallback'), { inbound: true, note: 'GATE_SMS_SPAM_CLASSIFIER shadow/true' }),
  L('sms_pathology', 'SMS pathology clustering', 'sms-pathology-ledger.js', 'fastText', P('fastStructured', 'primary'), P('fastStructured', 'fallback'), { inbound: true, note: 'summary pass rides DEEP' }),
  L('contact_correction', 'SMS contact-correction extraction', 'contact-correction.js', 'fastText', P('fastStructured', 'primary'), P('fastStructured', 'fallback'), { inbound: true }),
  L('bounce_rescue', 'Email bounce address decode', 'email-bounce-rescue.js', 'fastText', P('fastStructured', 'primary'), P('fastStructured', 'fallback'), { inbound: true }),
  L('seo_intent', 'SEO query-intent classification', 'seo/seo-diagnosis-tools.js', 'fastText', T('FAST')),
  L('prospect_score', 'Backlink prospect scoring', 'seo/prospect-scorer.js', 'fastText', T('FAST')),
  L('signup_classifier', 'Backlink signup classifier', 'seo/signup-classifier.js', 'fastText', E('MODEL_SIGNUP_CLASSIFIER', T('FAST'))),
  L('mentions_sentiment', 'LLM-mention sentiment classification', 'seo/llm-mention-prober.js', 'fastText', T('FAST')),
  L('events', 'Community events ingestion', 'event-ingestion.js', 'fastText', T('WORKHORSE')),
  L('events_editorial', 'Community events curation + normalizing', 'event-curation.js, event-normalizer.js', 'fastText', P('contentDraft', 'primary'), P('contentDraft', 'fallback')),
  L('expense_categorize', 'Expense categorization', 'expense-categorizer.js', 'fastText', P('highStakes', 'primary'), P('highStakes', 'fallback'), { note: 'routine categories on the flagship tier' }),

  // ── Multimodal ──
  // Sequential ladder, not a fan-out (owner ruling 2026-09-26,
  // TEXT_POLICIES.photoIdVision): identifyPest's analyzePhoto tries Gemini,
  // then the prior Gemini, and reaches ChatGPT's best vision model when both
  // miss OR Gemini is unsure / lists a runner-up of different risk. No Claude.
  L('pest_id', 'Pest identification (customer photo)', 'pest-identification.js', 'multimodal', E('GEMINI_VISION_MODEL', T('GEMINI_VISION_BEST')), T('GEMINI_VISION_FALLBACK'), { skipsEqualLeg: true, inbound: true, retry: P('photoIdVision', 'fallback'), note: `Gemini-first (owner 2026-09-26); OpenAI takes a second look when Gemini misses, scores itself under PHOTO_ID_ESCALATE_BELOW, or lists a runner-up of different risk · ${SHARED_GEMINI_PIN}` }),
  // Gemini-only scoring (owner ruling 2026-09-24: no more Claude+Gemini
  // averaging) — a sequential ladder like treatment_zone/tech_caption_vision,
  // not a fan-out: Gemini live, then the prior Gemini model, then Claude
  // VISION only when both Gemini rungs miss.
  L('lawn_assess', 'Lawn assessment (customer photo)', 'lawn-assessment.js', 'multimodal', E('GEMINI_VISION_MODEL', T('GEMINI_VISION_BEST')), T('GEMINI_VISION_FALLBACK'), { skipsEqualLeg: true, inbound: true, retry: T('VISION'), note: `Gemini-only (owner 2026-09-24); Claude is a fallback only when Gemini returns nothing · ${SHARED_GEMINI_PIN}` }),
  L('lawn_visit_assessment', 'Lawn visit assessment', 'lawn-visit-assessment.js', 'multimodal', P('lawnVisitAssessment', 'primary'), P('lawnVisitAssessment', 'fallback'), { inbound: true, note: 'All visit photos in one chain; GATE_LAWN_VISIT_ASSESSMENT; technician review before publication' }),
  // Sequential ladder, not a fan-out (owner ruling 2026-09-24): analyzePhoto
  // tries Gemini, then the prior Gemini, and reaches Claude VISION only when
  // both miss (with schema validation gating each rung's acceptance).
  L('tree_shrub', 'Tree & shrub assessment', 'tree-shrub-assessment.js', 'multimodal', E('GEMINI_VISION_MODEL', T('GEMINI_VISION_BEST')), T('GEMINI_VISION_FALLBACK'), { skipsEqualLeg: true, inbound: true, retry: T('VISION'), note: `Gemini-first (owner 2026-09-24); Claude is a fallback only when Gemini returns nothing · ${SHARED_GEMINI_PIN}` }),
  // Sequential ladder like the caption read: Gemini, then the prior Gemini,
  // then Claude VISION only when both miss (treatment-zone-suggest.js attempts).
  L('treatment_zone', 'Treatment-zone suggestion (map)', 'treatment-zone-suggest.js', 'multimodal', E('GEMINI_VISION_MODEL', T('GEMINI_VISION_BEST')), T('GEMINI_VISION_FALLBACK'), { skipsEqualLeg: true, inbound: true, retry: T('VISION'), note: SHARED_GEMINI_PIN }),
  // Sequential ladder, not a fan-out: analyzePhoto tries Gemini, then the
  // prior Gemini, and reaches Claude VISION only when both miss.
  L('tech_caption_vision', 'Tech social caption · photo read', 'tech-social-caption.js', 'multimodal', E('GEMINI_VISION_MODEL', T('GEMINI_VISION_BEST')), T('GEMINI_VISION_FALLBACK'), { skipsEqualLeg: true, retry: T('VISION'), note: SHARED_GEMINI_PIN }),
  // Estimate imagery uses Gemini, then Sol only on a failed/invalid read.
  // Satellite confidence stays 'single_model'; V2 retains one source's
  // measurement provenance rather than claiming multi-provider agreement.
  L('satellite', 'Satellite / aerial property analysis', 'satellite-analyzer.js, config/models.js', 'multimodal', E('GEMINI_VISION_MODEL', T('GEMINI_VISION_BEST')), P('estimateVision', 'fallback'), { note: 'Gemini → Sol fallback, stopping at the first schema-valid result' }),
  L('property_trio', 'Property lookup trio (stories, roof)', 'property-lookup/ai-property-lookup.js', 'multimodal', T('WORKHORSE'), E('GEMINI_PROPERTY_MODEL', T('GEMINI_VISION_BEST')), { fanout: true, also: [D(['OPENAI_PROPERTY_MODEL', 'OPENAI_MODEL'], 'gpt-5-mini', { accepts: { providers: ['openai'], cap: 'vision' } })], note: 'consensus of the three legs' }),
  L('property_v2_vision', 'Property lookup v2 · vision legs', 'routes/property-lookup-v2.js, config/models.js', 'multimodal', E('GEMINI_VISION_MODEL', T('GEMINI_VISION_BEST')), P('estimateVision', 'fallback'), { note: 'Gemini → Sol fallback, stopping at the first schema-valid result' }),
  L('turf_ocr', 'Turf-height gauge OCR', 'turf-height-ocr.js', 'multimodal', E('GEMINI_TURF_OCR_MODEL', T('GEMINI_VISION_BEST')), null, { fanout: true, inbound: true, also: [T('VISION')], note: 'Claude + Gemini in parallel; consensus of both readings' }),
  L('photo_scoring', 'Completion photo scoring', 'routes/admin-dispatch.js, config/models.js', 'multimodal', E('GEMINI_VISION_MODEL', T('GEMINI_VISION_BEST')), P('photoCaptions', 'fallback'), { inbound: true, note: `drives customer-facing health scores (owner 2026-07-21); Gemini-first, Claude fallback (owner 2026-09-24) · ${SHARED_GEMINI_PIN}` }),
  L('vision_delta', 'Before / after vision delta', 'vision-delta.js', 'multimodal', P('visionAnalysis', 'primary'), P('visionAnalysis', 'fallback')),
  L('lawn_quality_gate', 'Lawn photo-quality gate', 'lawn-intelligence.js', 'multimodal', P('visionAnalysis', 'primary'), P('visionAnalysis', 'fallback')),
  L('lawn_diag_vision', 'Lawn diagnostic · vision leg', 'lawn-diagnostic-prompt.js', 'multimodal', E('LAWN_VISION_MODEL', T('GEMINI_VISION_BEST')), T('VISION')),
  L('lawn_challenge', 'Lawn diagnostic · adversarial challenge', 'lawn-diagnostic-prompt.js', 'multimodal', T('LAWN_CHALLENGE')),
  L('hero_alt', 'Hero image alt-text', 'content/hero-alt-vision.js', 'multimodal', P('visionAnalysis', 'primary'), P('visionAnalysis', 'fallback')),
  // Generated-image screen (owner ruling 2026-09-25: Sol first, Claude
  // backup) — the blog image text/logo/uniform/van check, a separate call
  // from the hero_alt alt-text pass above (which stays on visionAnalysis).
  L('image_screen', 'Generated image screen', 'content/hero-alt-vision.js', 'multimodal', P('imageScreen', 'primary'), P('imageScreen', 'fallback'), { note: 'blog image text/logo/uniform/van check; Sol first, Claude VISION backs it up' }),
  L('wdo_project_brief', 'WDO project brief + treatment-photo read', 'routes/admin-projects.js', 'multimodal', P('visionAnalysis', 'primary'), P('visionAnalysis', 'fallback'), { note: 'text-only briefs ride contentDraft' }),
  L('invoice_pdf', 'Vendor invoice PDF processing', 'email/invoice-processor.js', 'multimodal', T('FLAGSHIP'), null, { inbound: true }),
  L('contact_dictation', 'Contact dictation decoder', 'contact-dictation.js', 'multimodal', D('GEMINI_CONTACT_DECODER_MODEL', 'gemini-2.5-pro', { live: true, accepts: { providers: ['gemini'], cap: 'text' } }), null, { inbound: true }),
  L('address_recovery', 'Address street recovery', 'address-validation/recovery.js', 'multimodal', D('GEMINI_RECOVERY_MODEL', 'gemini-2.5-pro', { live: true, accepts: { providers: ['gemini'], cap: 'text' } }), null, { inbound: true }),

  // ── Customer voice ──
  L('sms_draft', 'SMS auto-reply draft (routine)', 'sms-shadow-drafter.js', 'voice', R('smsDraftDefault'), P('highStakes', 'fallback'), { inbound: true }),
  L('sms_save_sale', 'SMS draft · save-the-sale', 'sms-shadow-drafter.js', 'voice', R('smsDraftSaveSale'), P('highStakes', 'fallback'), { inbound: true }),
  L('sms_tone', 'SMS tone rewrite', 'routes/admin-communications.js', 'voice', R('smsToneRewrite'), P('customerCopy', 'fallback'), { inbound: true }),
  L('sms_suggest', 'SMS draft suggestion (comms panel)', 'routes/admin-communications.js', 'voice', P('customerCopy', 'primary'), P('customerCopy', 'fallback'), { inbound: true }),
  // response-drafter.js picks the policy per intent: cancellations, complaints
  // and high-severity flags ride highStakes; everything else rides customerCopy.
  L('response_drafter', 'SMS reply drafter · routine', 'response-drafter.js', 'voice', P('customerCopy', 'primary'), P('customerCopy', 'fallback'), { inbound: true }),
  L('response_drafter_high_stakes', 'SMS reply drafter · cancel / complaint / high severity', 'response-drafter.js', 'voice', P('highStakes', 'primary'), P('highStakes', 'fallback'), { inbound: true }),
  L('estimate_followup', 'Estimate-conversion follow-up SMS', 'estimate-conversion-agent.js, sms-shadow-drafter.js', 'voice', R('smsDraftDefault'), P('highStakes', 'fallback'), { inbound: true, note: 'delegates to the SMS drafter' }),
  // Health probes: one tiny billed call per SMS draft route at boot and every
  // six hours (scheduler.js). No fallback by design — the canary exists to
  // notice the route itself failing.
  L('sms_canary_default', 'SMS draft canary · routine route', 'sms-draft-canary.js', 'voice', R('smsDraftDefault'), null, { note: 'probe at boot + every 6h; alerts the owner when the route stops answering' }),
  L('sms_canary_save_sale', 'SMS draft canary · save-the-sale route', 'sms-draft-canary.js', 'voice', R('smsDraftSaveSale'), null, { note: 'probe at boot + every 6h; alerts the owner when the route stops answering' }),
  L('completion_recap', 'Completion recap (customer-facing)', 'completion-recap.js', 'voice', P('customerCopy', 'primary'), P('customerCopy', 'fallback')),
  L('lawn_visit_narratives', 'Lawn + visit-summary narratives', 'service-report/lawn-report-narrative.js, service-report/visit-summary-narrative.js', 'voice', P('customerCopy', 'primary'), P('customerCopy', 'fallback')),
  L('social_copy', 'Social post copy', 'social-media.js', 'voice', P('customerCopy', 'primary'), P('customerCopy', 'fallback')),
  L('tech_caption_copy', 'Tech social caption · copy', 'tech-social-caption.js', 'voice', P('customerCopy', 'primary'), P('customerCopy', 'fallback')),
  L('review_ask', 'Review-ask drafting', 'review-ask-drafter.js', 'voice', P('customerCopy', 'primary'), P('customerCopy', 'fallback')),
  L('review_reply', 'GBP review replies', 'review-reply/drafter.js', 'voice', P('customerCopy', 'primary'), P('customerCopy', 'fallback'), { inbound: true }),
  L('review_gate_text', 'Review gate · customer review text', 'routes/review-gate.js', 'voice', P('customerCopy', 'primary'), P('customerCopy', 'fallback')),
  L('email_reply', 'Email reply drafting', 'email/email-actions.js', 'voice', P('customerCopy', 'primary'), P('customerCopy', 'fallback'), { inbound: true }),
  L('invoice_summary', 'Invoice AI summary', 'invoice-ai-summary.js', 'voice', P('customerCopy', 'primary'), P('customerCopy', 'fallback')),
  L('blog_draft', 'Blog post drafts', 'content/blog-writer.js', 'voice', P('contentDraft', 'primary'), P('contentDraft', 'fallback')),
  L('newsletter', 'Newsletter drafts + autopilot rerank', 'newsletter-draft.js, newsletter-autopilot.js, routes/admin-newsletter.js', 'voice', P('contentDraft', 'primary'), P('contentDraft', 'fallback')),
  L('content_misc', 'Content ideas, scheduler copy, automation emails', 'routes/admin-content-v2.js, content-scheduler.js, routes/admin-automations.js', 'voice', P('contentDraft', 'primary'), P('contentDraft', 'fallback')),
  L('previsit_brief', 'Pre-visit brief', 'previsit-brief.js', 'voice', P('visitBrief', 'primary'), P('visitBrief', 'fallback')),
  L('job_card_paragraph', 'Job card customer paragraph', 'job-card.js', 'voice', P('jobCardParagraph', 'primary'), P('jobCardParagraph', 'fallback'), { note: 'GATE_JOB_CARD, dark' }),
  // Inbound Sandy calls resolve their own env chain — VOICE_RELAY_INBOUND_MODEL
  // (pinned once per session at conversation construction), else the shared
  // VOICE_RELAY_MODEL, else the VOICE tier. Collections reads VOICE_RELAY_MODEL
  // directly (row below) and never sees the inbound-only override.
  // Unlike every other E() pin here, VOICE_RELAY_INBOUND_MODEL is allowlist
  // -checked by the call site itself (relay-conversation.js
  // resolveSessionModel) — a raw value outside config/models.js MODEL_CATALOG
  // never runs. inboundOverrideParse() reuses that same live resolver instead
  // of re-deriving the allowlist here, so this row can never show a model the
  // runtime would actually refuse. `catalogOnly: true` carries that same fact
  // to the Models tab's picker (PickModelDialog.jsx): a live provider search
  // result that is not in MODEL_CATALOG must not be offered for this lane —
  // it would draft an env value inboundOverrideParse() (and the runtime's own
  // resolveSessionModel) reject outright, falling back after the restart the
  // owner thought would apply it.
  L('voice_relay', 'Inbound voice relay (Sandy)', 'voice-agent/relay-conversation.js', 'voice', E('VOICE_RELAY_INBOUND_MODEL', E('VOICE_RELAY_MODEL', T('VOICE')), { parse: inboundOverrideParse, catalogOnly: true, allowed: inboundOverrideAllowed }), null, { note: 'sandbox test calls (VOICE_RELAY_SANDBOX_NUMBER) prefer VOICE_RELAY_SANDBOX_MODEL ahead of this chain; an unknown override id falls back with a logged warning + model_fallback_reason stamp — allowlist is config/models.js MODEL_CATALOG, Anthropic text models only, excluding requires:"deep" ids' }),
  L('voice_relay_collections', 'Collections outbound calls', 'collections/outbound-voice/collections-conversation.js', 'voice', E('VOICE_RELAY_MODEL', T('VOICE')), null, { note: 'shares VOICE_RELAY_MODEL with inbound; VOICE_RELAY_INBOUND_MODEL / VOICE_RELAY_SANDBOX_MODEL are inbound-only and never reach this lane' }),
  L('outreach_drafter', 'Backlink outreach drafting', 'seo/backlink-outreach-drafter.js', 'voice', E('MODEL_OUTREACH_DRAFTER', T('WORKHORSE'))),

  // ── Report writer ──
  L('report_copy', 'Completed-service report copy', 'routes/admin-schedule.js', 'report', P('report', 'primary'), P('report', 'fallback'), { note: 'deterministic safe copy if both miss' }),
  L('treatment_narrative', 'Treatment narrative', 'service-report/treatment-narrative.js', 'report', P('report', 'primary'), P('report', 'fallback')),
  L('rodent_narrative', 'Rodent / typed report narrative', 'service-report/rodent-report-narrative.js', 'report', P('report', 'primary'), P('report', 'fallback')),
  L('project_report', 'Project report draft', 'routes/admin-projects.js', 'report', P('report', 'primary'), P('report', 'fallback')),
  L('lawn_diag_writer', 'Lawn diagnostic · customer narrative', 'lawn-diagnostic-prompt.js', 'report', D('LAWN_WRITER_MODEL', 'gpt-5.5', { accepts: { providers: ['openai'], cap: 'text' } }), T('FLAGSHIP')),

  // ── Balanced Q&A ──
  L('estimate_assistant', 'Estimate assistant Q&A', 'estimate-assistant.js', 'qa', R('estimateAssistant'), E('ESTIMATE_ASSISTANT_MODEL', T('WORKHORSE'), { live: true }), { inbound: true }),
  L('knowledge_qa', 'Knowledge-base Q&A', 'knowledge-bridge.js', 'qa', R('knowledgeAnswer'), T('FLAGSHIP')),
  L('ask_waves', 'Ask Waves (public chat)', 'ask-waves-intake.js', 'qa', P('askWaves', 'primary'), E('ASK_WAVES_MODEL', P('askWaves', 'fallback'), { live: true }), { inbound: true }),
  L('wiki_qa', 'Wiki Q&A', 'knowledge/wiki-qa.js', 'qa', P('highStakes', 'primary'), P('highStakes', 'fallback')),
  L('wdo_history', 'WDO history lookup', 'property-lookup/wdo-history-lookup.js', 'qa', T('WORKHORSE'), null, { inbound: true }),
  L('link_investigator', 'Internal-link path investigation', 'seo/link-path-investigator.js', 'qa', T('WORKHORSE')),
  L('seo_advisor', 'SEO weekly advisor + action drafts', 'seo/seo-advisor.js, seo/seo-action-generator.js', 'qa', P('highStakes', 'primary'), P('highStakes', 'fallback')),
  L('ads_advisor', 'Ads campaign advisor (daily)', 'ads/campaign-advisor.js', 'qa', P('highStakes', 'primary'), P('highStakes', 'fallback')),
  L('chart_builder_image', 'AI chart builder · image intent read', 'ai-chart-builder.js', 'qa', T('GEMINI_VISION_BEST'), T('FLAGSHIP'), { note: 'image-backed charts only; stage 1 of 2' }),
  L('chart_builder_sql', 'AI chart builder · SQL + chart spec', 'ai-chart-builder.js', 'qa', P('highStakes', 'primary'), P('highStakes', 'fallback'), { note: 'every chart; stage 2' }),

  // ── High-stakes reasoner ──
  L('ib_admin', 'Intelligence Bar · admin', 'routes/admin-intelligence-bar.js', 'reason', E('INTELLIGENCE_BAR_MODEL', T('FLAGSHIP'))),
  L('ib_tech', 'Intelligence Bar · tech context', 'routes/admin-intelligence-bar.js', 'reason', E('INTELLIGENCE_BAR_TECH_MODEL', T('FLAGSHIP'), { live: true }), null, { note: 'read-only tools, low max_tokens' }),
  L('ib_tools', 'IB email / SMS / procurement tools', 'intelligence-bar/email-tools.js, intelligence-bar/comms-tools.js, intelligence-bar/procurement-tools.js', 'reason', T('FLAGSHIP')),
  L('commercial_proposal', 'Commercial proposal brief', 'estimator-engine/commercial-proposal.js', 'reason', P('highStakes', 'primary'), P('highStakes', 'fallback')),
  L('signal_detector', 'Customer signal detector', 'customer-intelligence/signal-detector.js', 'reason', P('highStakes', 'primary'), P('highStakes', 'fallback'), { inbound: true }),
  L('retention_drafts', 'Retention drafts (owner-approved)', 'customer-intelligence/retention-engine.js', 'reason', P('customerCopy', 'primary'), P('customerCopy', 'fallback')),
  L('tax_advisor', 'Tax advisor weekly report', 'tax-advisor.js', 'reason', T('FLAGSHIP')),
  L('csr_coach', 'CSR call coaching', 'csr/csr-coach.js', 'reason', P('highStakes', 'primary'), P('highStakes', 'fallback')),
  L('inventory_research', 'Inventory vendor mapping + price research', 'routes/admin-inventory.js', 'reason', T('FLAGSHIP'), null, { note: 'Anthropic web_search tool' }),
  L('lead_synopsis', 'Lead synopsis from call', 'call-recording-processor.js', 'reason', T('FLAGSHIP'), null, { inbound: true }),
  L('call_commitments', 'Call commitments from transcript', 'call-commitments.js', 'reason', T('FLAGSHIP'), null, { inbound: true }),
  L('codex_remediation', 'Content finding auto-fix', 'content/codex-remediation.js', 'reason', T('FLAGSHIP')),
  L('portal_assistant', 'Customer portal assistant', 'ai-assistant/assistant.js', 'reason', T('FLAGSHIP')),
  L('signup_worker', 'Backlink signup worker', 'backlink-agent/signup-worker.js', 'reason', P('highStakes', 'primary'), P('highStakes', 'fallback')),
  L('form_filler', 'Backlink browser form filler (vision)', 'seo/browser-form-filler.js', 'reason', E('MODEL_SIGNUP_FILLER', T('FLAGSHIP'))),

  // ── Deep audit ──
  L('sms_verifier', 'SMS draft fact-check verifier', 'sms-draft-verifier.js, sms-shadow-drafter.js', 'deep', T('DEEP'), P('deepAnalysis', 'fallback'), { inbound: true }),
  L('shadow_judge', 'SMS shadow judge', 'sms-shadow-judge.js', 'deep', T('DEEP'), P('deepAnalysis', 'fallback'), { inbound: true }),
  L('intent_composer', 'Estimator intent composer', 'estimator-engine/intent-composer.js', 'deep', E('ESTIMATOR_ENGINE_MODEL', T('DEEP'), { live: true }), P('deepAnalysis', 'fallback'), { inbound: true, note: 'prompt carries the call transcript, SMS thread and customer profile' }),
  L('editorial_review', 'Editorial evidence review', 'content/editorial-review.js, llm/deep.js', 'deep', P('deepAnalysis', 'primary'), P('deepAnalysis', 'fallback')),
  L('editorial_repair', 'Editorial draft repair', 'content/editorial-review.js, llm/deep.js', 'deep', P('deepAnalysis', 'primary'), P('deepAnalysis', 'fallback')),
  L('editorial_plan_review', 'Editorial answer plan review', 'content/editorial-review.js, llm/deep.js', 'deep', P('deepAnalysis', 'primary'), P('deepAnalysis', 'fallback')),
  L('fact_check_gate', 'Blog fact-check gate', 'content/fact-check-gate.js', 'deep', E('MODEL_FACTCHECK', P('deepAnalysis', 'primary')), P('deepAnalysis', 'fallback')),
  L('compliance_gate', 'Content compliance gate', 'content/compliance-gate.js', 'deep', E('MODEL_COMPLIANCE', P('deepAnalysis', 'primary')), P('deepAnalysis', 'fallback'), { note: 'GATE_COMPLIANCE ships dark' }),
  L('blog_optimize', 'Blog optimization pass', 'content/blog-writer.js', 'deep', P('deepAnalysis', 'primary'), P('deepAnalysis', 'fallback')),
  L('kb_audit', 'Knowledge-base nightly audit', 'knowledge-base.js', 'deep', T('DEEP'), P('deepAnalysis', 'fallback')),
  L('wiki_compiler', 'Wiki compiler + agronomic wiki', 'knowledge/wiki-compiler.js, agronomic-wiki.js', 'deep', T('DEEP'), P('deepAnalysis', 'fallback')),
  L('quarantine_arbiter', 'Contact quarantine arbiter', 'contact-quarantine-arbiter.js', 'deep', T('DEEP'), P('deepAnalysis', 'fallback'), { inbound: true }),
  L('call_self_audit', 'Call self-audit', 'call-self-audit.js', 'deep', T('DEEP'), P('deepAnalysis', 'fallback'), { inbound: true }),
  L('voice_relay_judge', 'Voice relay eval judge', 'eval/voice-relay-judge.js', 'deep', P('voiceJudge', 'primary'), P('voiceJudge', 'fallback'), { inbound: true, note: 'grades synthetic manual replay transcripts when --judge is selected' }),
  L('wdo_appt_brief', 'WDO appointment brief', 'appointment-tagger.js', 'deep', P('deepAnalysis', 'primary'), P('deepAnalysis', 'fallback')),
  L('voice_profile', 'Voice-profile distiller (weekly)', 'voice-profile-distiller.js', 'deep', T('DEEP'), P('deepAnalysis', 'fallback')),
  L('extreme_tier', 'Explicit deep audit (EXTREME tier)', 'config/models.js', 'deep', T('EXTREME'), null, { note: 'no automatic lane — deliberate opt-in only' }),

  // ── Managed agents (Anthropic only) ──
  L('agent_bi', 'Weekly BI briefing agent', 'bi-agent-config.js', 'agents', T('FLAGSHIP'), null, { lock: AGENT_LOCK }),
  L('agent_lead', 'Lead response agent', 'lead-response-agent-config.js', 'agents', T('FLAGSHIP'), null, { lock: AGENT_LOCK }),
  L('agent_content', 'Content, blog writer, refresh agents', 'content/content-agent-config.js, content/agents/writer-agent-config.js, content/agents/refresh-agent-config.js', 'agents', T('FLAGSHIP'), null, { lock: AGENT_LOCK }),
  L('agent_meta', 'Meta rewriter agent', 'content/agents/meta-rewriter-config.js', 'agents', T('WORKHORSE'), null, { lock: AGENT_LOCK }),
  L('agent_backlink', 'Backlink strategy agent', 'seo/backlink-strategy-agent-config.js', 'agents', T('FLAGSHIP'), null, { lock: AGENT_LOCK }),
  L('agent_assistant', 'Customer assistant (managed)', 'ai-assistant/managed-agent-config.js', 'agents', T('FLAGSHIP'), null, { lock: AGENT_LOCK }),

  // ── Specialized / locked ──
  L('call_extraction', 'Call extraction V2', 'call-recording-processor.js', 'locked',
    S('CALL_EXTRACTION_PROVIDER', { openai: D('CALL_EXTRACTION_MODEL', 'gpt-5.6-sol'), anthropic: T('CALL_EXTRACTION_ANTHROPIC'), gemini: D('GEMINI_EXTRACTION_MODEL', 'gemini-2.5-pro') }),
    null, { inbound: true, lock: LOCK.benchmark('25-call bake-off 2026-07-18 · run a new bake-off to move it'), note: 'CALL_EXTRACTION_PROVIDER=openai|anthropic|gemini picks the primary; kill = gemini' }),
  L('call_extraction_v1', 'Call extraction V1 (runs first; V2 above is the gated shadow)', 'call-recording-processor.js', 'locked', D('GEMINI_EXTRACTION_V1_MODEL', 'gemini-3.5-flash', { accepts: { providers: ['gemini'], cap: 'text' } }), null, { inbound: true, lock: LOCK.benchmark('authoritative extractor until V2 is promoted') }),
  L('call_research', 'Call-research corpus miner', 'call-research-miner.js', 'locked',
    S('CALL_RESEARCH_PROVIDER',
      { openai: D('CALL_RESEARCH_MODEL', 'gpt-5.6-sol'), anthropic: E('CALL_RESEARCH_MODEL', T('CALL_RESEARCH_ANTHROPIC')), gemini: D('CALL_RESEARCH_MODEL', 'gemini-2.5-pro') },
      // call-research-miner.js:70-72 — the fallback never takes CALL_RESEARCH_MODEL
      { openai: LIT('gpt-5.6-sol', { providers: ['openai'], cap: 'text' }), anthropic: T('CALL_RESEARCH_ANTHROPIC') }),
    null, { inbound: true, lock: LOCK.benchmark('7-arm bake-off 2026-07-18'), note: 'CALL_RESEARCH_PROVIDER=openai|anthropic|gemini picks the primary; CALL_RESEARCH_MODEL overrides the primary only' }),
  L('transcription', 'Call transcription (primary + long-call verifier)', 'call-recording-processor.js', 'locked', D('OPENAI_TRANSCRIPTION_MODEL', 'gpt-4o-transcribe-diarize'), D('GEMINI_TRANSCRIPTION_MODEL', 'gemini-3.5-flash'), { inbound: true, lock: LOCK.provider('audio pipeline with its own validation') }),
  L('transcript_label', 'Transcript speaker relabeling', 'call-recording-processor.js', 'locked', D(['OPENAI_TRANSCRIPT_LABEL_MODEL', 'OPENAI_MODEL'], 'gpt-5-mini'), null, { lock: LOCK.provider('audio pipeline') }),
  L('contact_pass', 'Second contact-pass STT (spelled emails, addresses)', 'call-recording-processor.js', 'locked', D('OPENAI_CONTACT_PASS_MODEL', 'gpt-4o-transcribe', { live: true }), null, { inbound: true, lock: LOCK.provider('speech-to-text') }),
  L('tech_dictation', 'Tech field dictation', 'routes/tech-track.js', 'locked', D('OPENAI_DICTATION_MODEL', 'gpt-4o-transcribe', { live: true }), null, { lock: LOCK.provider('speech-to-text') }),
  L('embeddings', 'Knowledge embeddings', 'llm/embed.js', 'locked', T('OPENAI_EMBEDDING'), null, { lock: LOCK.migration('single provider by design; degrades to full-text search') }),
  // Blog image generation (content/image-generator.js, env BLOG_IMAGE_PROVIDER).
  // Literals are the REAL no-env defaults — computed through the same
  // firstImageChainModel/secondImageChainModel parse helpers the env-override
  // path uses, not a hand-typed slug, so a chain reorder (Images 2.5 leading
  // since 2026-09-25) can't drift the card out of sync with image-generator.js.
  L('image_gen', 'Blog image generation', 'content/image-generator.js', 'locked', D('BLOG_IMAGE_PROVIDER', firstImageChainModel(undefined) || 'gpt-image-2.5-sunburst', { accepts: { providers: ['openai'], cap: 'image' }, parse: firstImageChainModel }), D('BLOG_IMAGE_PROVIDER', secondImageChainModel(undefined) || 'gpt-image-2', { accepts: { providers: ['openai', 'gemini'], cap: 'image' }, parse: secondImageChainModel }), { lock: LOCK.provider('image chain, env BLOG_IMAGE_PROVIDER'), note: 'effective chain, OpenAI only by default: gpt-image-2.5-sunburst → gpt-image-2 → gpt-image-1.5 → gpt-image-1 (Images 2.5 leads since 2026-09-25; owner 2026-09-24: no pixel watermarks — every Gemini image model is SynthID-marked and is dropped from any chain). ALLOW_PIXEL_WATERMARKED_IMAGE_PROVIDERS=true restores the old interleaved Gemini legs further down the chain (out of this card\'s first two legs) during a deliberate run.' }),
  // Social image generation (social-creative-engine.js, env SOCIAL_IMAGE_PROVIDER)
  // keeps the OLDER chain — no gpt-image-2.5-sunburst leg (the 2026-09-25
  // Images 2.5 switch covered the blog generator only; social was not moved).
  L('social_image_gen', 'Social image generation', 'social-creative-engine.js', 'locked', D('SOCIAL_IMAGE_PROVIDER', firstSocialImageChainModel(undefined) || 'gpt-image-2', { accepts: { providers: ['openai'], cap: 'image' }, parse: firstSocialImageChainModel }), D('SOCIAL_IMAGE_PROVIDER', secondSocialImageChainModel(undefined) || 'gpt-image-1.5', { accepts: { providers: ['openai', 'gemini'], cap: 'image' }, parse: secondSocialImageChainModel }), { lock: LOCK.provider('image chain, env SOCIAL_IMAGE_PROVIDER'), note: 'social keeps the older chain (no Images 2.5 leg): gpt-image-2 → gpt-image-1.5 → gpt-image-1. ALLOW_PIXEL_WATERMARKED_IMAGE_PROVIDERS=true restores the old interleaved Gemini legs further down the chain during a deliberate run.' }),
  L('video_gen', 'Reels video generation', 'content/video-generator.js', 'locked', T('GEMINI_VIDEO_FAST'), T('GEMINI_VIDEO_QUALITY'), { lock: LOCK.provider('video chain') }),
  L('mentions_prober', 'LLM mentions prober (Claude, OpenAI, Gemini, Perplexity arms)', 'seo/llm-mention-prober.js', 'locked', E('MODEL_MENTIONS', T('WORKHORSE'), { live: true }), null, { lock: LOCK.measurement('each engine is probed directly; a fallback would falsify the measurement'), note: 'OPENAI_MENTIONS_MODEL gpt-4o-search-preview · GEMINI_MENTIONS_MODEL gemini-2.5-flash · PERPLEXITY_MENTIONS_MODEL sonar' }),
  L('sealed_eval', 'SMS sealed-eval exam legs', 'sms-sealed-eval.js', 'locked', T('SMS_SONNET'), T('OPENAI_REPORT_WRITER'), { lock: LOCK.measurement('frozen exam; Gemini / Luna / Opus / Fable measurement legs too') }),
];


// ── Product areas, plain-English descriptions, continuity ─────────────
// Areas are how the owner thinks about the business (not how the code is
// organised); every lane belongs to exactly one.
const AREAS = [
  { key: 'sms', label: 'SMS & messaging', description: 'Texts customers read and the checks around them' },
  { key: 'calls', label: 'Calls', description: 'Recording, transcription, extraction and coaching' },
  { key: 'voice', label: 'Voice AI agent', description: 'The spoken agent on the phone line' },
  { key: 'photos', label: 'Photos & property', description: 'Customer photos, satellite, maps and property lookups' },
  { key: 'estimates', label: 'Estimates & sales', description: 'Leads, quoting help, follow-ups and retention' },
  { key: 'reports', label: 'Service reports', description: 'What the customer receives after a visit' },
  { key: 'email', label: 'Email', description: 'Inbound email handling and replies' },
  { key: 'content', label: 'Content & SEO', description: 'Blog, newsletter, social, reviews and search' },
  { key: 'ib', label: 'Intelligence Bar', description: 'The admin and tech command bar and knowledge' },
  { key: 'portal', label: 'Customer portal', description: 'Self-serve chat on the website and app' },
  { key: 'agents', label: 'Managed agents', description: 'Long-running Anthropic agents' },
  { key: 'office', label: 'Back office', description: 'Books, hiring, inventory and audits' },
];
const LANE_AREA = {
  sms_draft: 'sms',
  sms_save_sale: 'sms',
  sms_canary_default: 'sms',
  sms_canary_save_sale: 'sms',
  sms_tone: 'sms',
  sms_suggest: 'sms',
  response_drafter: 'sms',
  response_drafter_high_stakes: 'sms',
  estimate_followup: 'sms',
  'sms-commitment-fulfillment': 'sms',
  'sms-operational-actions': 'sms',
  sms_intent: 'sms',
  contact_correction: 'sms',
  sms_pathology: 'sms',
  sms_verifier: 'sms',
  shadow_judge: 'sms',
  voice_profile: 'sms',
  sealed_eval: 'sms',
  quarantine_arbiter: 'sms',
  call_extraction: 'calls',
  call_extraction_v1: 'calls',
  call_research: 'calls',
  transcription: 'calls',
  transcript_label: 'calls',
  contact_pass: 'calls',
  call_sentiment: 'calls',
  call_self_audit: 'calls',
  lead_synopsis: 'calls',
  call_commitments: 'calls',
  csr_coach: 'calls',
  contact_dictation: 'calls',
  address_recovery: 'calls',
  tech_dictation: 'calls',
  parse_when: 'calls',
  voice_relay: 'voice',
  voice_relay_collections: 'voice',
  voice_relay_judge: 'voice',
  pest_id: 'photos',
  lawn_assess: 'photos',
  lawn_visit_assessment: 'photos',
  tree_shrub: 'photos',
  treatment_zone: 'photos',
  tech_caption_vision: 'photos',
  satellite: 'photos',
  property_trio: 'photos',
  property_v2_vision: 'photos',
  turf_ocr: 'photos',
  photo_scoring: 'photos',
  vision_delta: 'photos',
  lawn_quality_gate: 'photos',
  lawn_diag_vision: 'photos',
  lawn_challenge: 'photos',
  lawn_diag_writer: 'photos',
  wdo_project_brief: 'photos',
  wdo_history: 'photos',
  lead_triage: 'estimates',
  estimate_assistant: 'estimates',
  estimator_sms_signal: 'estimates',
  sms_solicitation: 'estimates',
  intent_composer: 'estimates',
  commercial_proposal: 'estimates',
  churn_classify: 'estimates',
  signal_detector: 'estimates',
  retention_drafts: 'estimates',
  report_copy: 'reports',
  treatment_narrative: 'reports',
  rodent_narrative: 'reports',
  project_report: 'reports',
  completion_recap: 'reports',
  lawn_visit_narratives: 'reports',
  previsit_brief: 'reports',
  job_card_paragraph: 'reports',
  invoice_summary: 'reports',
  wdo_appt_brief: 'reports',
  email_classify: 'email',
  email_reply: 'email',
  bounce_rescue: 'email',
  invoice_pdf: 'email',
  blog_draft: 'content',
  blog_optimize: 'content',
  newsletter: 'content',
  content_misc: 'content',
  social_copy: 'content',
  social_judge: 'content',
  tech_caption_copy: 'content',
  review_ask: 'content',
  review_reply: 'content',
  review_gate_text: 'content',
  hero_alt: 'content',
  image_screen: 'content',
  editorial_review: 'content',
  editorial_repair: 'content',
  editorial_plan_review: 'content',
  fact_check_gate: 'content',
  compliance_gate: 'content',
  codex_remediation: 'content',
  footprint_claim: 'content',
  seo_intent: 'content',
  seo_advisor: 'content',
  prospect_score: 'content',
  signup_classifier: 'content',
  outreach_drafter: 'content',
  form_filler: 'content',
  signup_worker: 'content',
  link_investigator: 'content',
  mentions_prober: 'content',
  mentions_sentiment: 'content',
  image_gen: 'content',
  social_image_gen: 'content',
  video_gen: 'content',
  events: 'content',
  events_editorial: 'content',
  ads_advisor: 'content',
  ib_admin: 'ib',
  ib_tech: 'ib',
  ib_tools: 'ib',
  chart_builder_image: 'ib',
  chart_builder_sql: 'ib',
  knowledge_qa: 'ib',
  wiki_qa: 'ib',
  kb_audit: 'ib',
  wiki_compiler: 'ib',
  embeddings: 'ib',
  extreme_tier: 'ib',
  ask_waves: 'portal',
  portal_assistant: 'portal',
  agent_bi: 'agents',
  agent_lead: 'agents',
  agent_content: 'agents',
  agent_meta: 'agents',
  agent_backlink: 'agents',
  agent_assistant: 'agents',
  expense_categorize: 'office',
  tax_advisor: 'office',
  inventory_research: 'office',
  job_screen: 'office',
};
// One line a person reads to know what the lane does.
const LANE_DESCRIBE = {
  sms_draft: 'Writes the reply to an everyday customer text',
  sms_save_sale: 'Writes the reply when a customer wants to cancel or complains',
  sms_canary_default: 'Checks every six hours that the routine SMS drafting route still answers',
  sms_canary_save_sale: 'Checks every six hours that the save-the-sale SMS drafting route still answers',
  sms_tone: 'Rewrites a staff text in the Waves voice',
  sms_suggest: 'Suggests a reply inside the comms panel',
  response_drafter: 'Drafts replies to routine texts',
  response_drafter_high_stakes: 'Drafts replies to cancellations, complaints and high-severity texts',
  estimate_followup: 'Follows up on a quote by text',
  'sms-commitment-fulfillment': 'Checks whether recorded SMS requests were completed',
  'sms-operational-actions': 'Captures operational facts from customer texts for the profile',
  sms_intent: 'Works out what an inbound text is asking for',
  contact_correction: 'Pulls corrected names, emails and addresses out of texts',
  sms_pathology: 'Groups failed drafts by what went wrong',
  sms_verifier: 'Fact-checks a draft before it can send',
  shadow_judge: 'Scores silent drafts against what a human sent',
  voice_profile: 'Distils the house voice from real replies each week',
  sealed_eval: 'The frozen exam that ranks drafting models',
  quarantine_arbiter: 'Decides whether a suspicious contact record is real',
  call_extraction: 'Turns a call into structured facts (V2, shadow)',
  call_extraction_v1: 'Turns a call into structured facts (live extractor)',
  call_research: 'Mines calls for voice-of-customer themes',
  transcription: 'Transcribes recordings, with a long-call verifier',
  transcript_label: 'Labels who is speaking',
  contact_pass: 'Second listen for spelled emails and addresses',
  call_sentiment: 'Reads how the caller sounds',
  call_self_audit: 'Audits the extraction against the transcript',
  lead_synopsis: 'Summarises a new lead from the call',
  call_commitments: 'Records what Waves promised on the call (dark: GATE_CALL_COMMITMENTS)',
  csr_coach: 'Coaches the office on how the call went',
  contact_dictation: 'Decodes dictated contact details',
  address_recovery: 'Recovers a street address that did not validate',
  tech_dictation: 'Transcribes field notes from the tech',
  parse_when: 'Reads "next Tuesday morning" into a date',
  voice_relay: 'Speaks with callers on the phone line (Sandy)',
  voice_relay_collections: 'Speaks with customers on collections calls',
  voice_relay_judge: 'Grades Sandy\'s eval calls against each scenario\'s spec',
  pest_id: 'Identifies the pest in a customer photo',
  lawn_assess: 'Assesses lawn health from a customer photo',
  lawn_visit_assessment: 'Assesses all lawn visit photos for technician review',
  tree_shrub: 'Assesses trees and shrubs from a photo',
  treatment_zone: 'Suggests treatment zones on the property map',
  tech_caption_vision: 'Reads a job photo for a caption',
  satellite: 'Measures the property from aerial imagery',
  property_trio: 'Looks up stories, roof and lot from imagery',
  property_v2_vision: 'Property lookup v2 image legs',
  turf_ocr: 'Reads the turf height gauge',
  photo_scoring: 'Scores completion photos for the report',
  vision_delta: 'Compares before and after photos',
  lawn_quality_gate: 'Rejects photos too poor to assess',
  lawn_diag_vision: 'Lawn diagnostic: reads the photo',
  lawn_challenge: 'Lawn diagnostic: challenges the diagnosis',
  lawn_diag_writer: 'Lawn diagnostic: writes the customer narrative',
  wdo_project_brief: 'Briefs a WDO project from photos and notes',
  wdo_history: 'Looks up prior WDO history at an address',
  lead_triage: 'Classifies a new web lead',
  estimate_assistant: 'Answers questions while building an estimate',
  estimator_sms_signal: 'Spots a quote request in a text thread',
  sms_solicitation: 'Spots a vendor pitch texted to a Waves line',
  intent_composer: 'Turns a request into an estimator plan',
  commercial_proposal: 'Writes the commercial proposal brief',
  churn_classify: 'Classifies why a customer left',
  signal_detector: 'Spots customers at risk',
  retention_drafts: 'Drafts the retention outreach you approve',
  report_copy: 'Writes the completed-service report',
  treatment_narrative: 'Writes the treatment narrative',
  rodent_narrative: 'Writes rodent and typed reports',
  project_report: 'Writes the project report',
  completion_recap: 'Writes the short recap the customer gets',
  lawn_visit_narratives: 'Writes lawn and visit summaries',
  previsit_brief: 'Briefs the tech before a visit',
  job_card_paragraph: 'Writes the job card\'s customer paragraph',
  invoice_summary: 'Summarises an invoice in plain words',
  wdo_appt_brief: 'Briefs a WDO appointment',
  email_classify: 'Sorts inbound email',
  email_reply: 'Drafts email replies',
  bounce_rescue: 'Fixes a bounced address',
  invoice_pdf: 'Reads vendor invoice PDFs',
  blog_draft: 'Writes blog posts',
  blog_optimize: 'Improves a draft post',
  newsletter: 'Writes and ranks the newsletter',
  content_misc: 'Content ideas, scheduler copy, automation emails',
  social_copy: 'Writes social posts',
  social_judge: 'Checks social posts for compliance',
  tech_caption_copy: 'Writes the caption for a tech photo',
  review_ask: 'Writes the review request',
  review_reply: 'Replies to Google reviews',
  review_gate_text: 'Drafts the review text for a customer',
  hero_alt: 'Writes alt text for hero images',
  image_screen: 'Screens a generated blog image for a wrong text mark, logo, uniform badge or van wrap',
  editorial_review: 'Audits complete article evidence and editorial quality',
  editorial_repair: 'Repairs editorial findings while preserving document structure',
  editorial_plan_review: 'Checks answer-first section plans before drafting',
  fact_check_gate: 'Fact-checks a post before publish',
  compliance_gate: 'Checks a post for banned claims',
  codex_remediation: 'Fixes content findings automatically',
  footprint_claim: 'Checks service-area claims',
  seo_intent: 'Classifies search intent',
  seo_advisor: 'Weekly SEO advice and action drafts',
  prospect_score: 'Scores backlink prospects',
  signup_classifier: 'Classifies backlink signup forms',
  outreach_drafter: 'Drafts backlink outreach',
  form_filler: 'Fills signup forms from a screenshot',
  signup_worker: 'Works through backlink signups',
  link_investigator: 'Investigates internal link paths',
  mentions_prober: 'Asks each AI engine whether it mentions Waves',
  mentions_sentiment: 'Scores those mentions',
  image_gen: 'Generates blog images',
  social_image_gen: 'Generates social post images',
  video_gen: 'Generates Reels clips',
  events: 'Finds community events',
  events_editorial: 'Scores community events and cleans up their venue details',
  ads_advisor: 'Daily Google Ads advice',
  ib_admin: 'The admin command bar',
  ib_tech: 'The tech command bar',
  ib_tools: 'Command-bar email, SMS and procurement tools',
  chart_builder_image: 'Chart builder: reads a chart image',
  chart_builder_sql: 'Chart builder: writes the SQL and chart',
  knowledge_qa: 'Answers from the knowledge base',
  wiki_qa: 'Answers from the wiki',
  kb_audit: 'Audits the knowledge base nightly',
  wiki_compiler: 'Compiles sources into wiki entries',
  embeddings: 'Indexes knowledge for search',
  extreme_tier: 'Explicit deep audits you trigger by hand',
  ask_waves: 'Public chat on the website',
  portal_assistant: 'Assistant inside the customer portal',
  agent_bi: 'Weekly business briefing',
  agent_lead: 'Responds to new leads',
  agent_content: 'Content, blog writer and refresh',
  agent_meta: 'Rewrites page meta',
  agent_backlink: 'Backlink strategy',
  agent_assistant: 'Customer assistant',
  expense_categorize: 'Categorises expenses',
  tax_advisor: 'Weekly tax advice',
  inventory_research: 'Matches vendors and researches prices',
  job_screen: 'Screens job applications',
};
// Continuity = what catches a regression after a model switch.
//   judged    an LLM judge / replay eval scores output against human truth
//             (shadow judge, sealed exam, call replay eval, social judge, fact gates)
//   verified  a deterministic checker gates the output (report safe-copy gate,
//             estimator floors, transcription validation)
//   unchecked nothing but the owner notices
const JUDGED_LANES = new Set(["blog_draft", "call_extraction", "call_extraction_v1", "call_research", "estimate_followup", "response_drafter", "response_drafter_high_stakes", "sealed_eval", "sms_draft", "sms_save_sale", "sms_tone", "social_copy"]);
// fact_check_gate is NOT verified: fact-check-gate.js accepts any truthy JSON
// and treats a missing findings array as "no findings", so `{}` passes.
const VERIFIED_LANES = new Set(["commercial_proposal", "completion_recap", "compliance_gate", "image_screen", "intent_composer", "lawn_visit_narratives", "photo_scoring", "project_report", "report_copy", "rodent_narrative", "transcription", "treatment_narrative", "turf_ocr"]);

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
    const names = selectorEnvNames(sel);
    const overrideEnv = firstSetEnv(names);
    // What the selector returns to once the ACTIVE override is deleted: the
    // next set alias in the chain (MODEL_OPENAI_BEST behind MODEL_OPENAI_BALANCED),
    // else the registry default (null for a derived selector — it follows its parent).
    const afterUnpin = overrideEnv ? names.slice(names.indexOf(overrideEnv) + 1).map((n) => process.env[n]).find(Boolean) || null : null;
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
      // What the selector returns to when its override is deleted (null for
      // a selector that derives from another — it follows that one instead).
      codeDefault: MODELS.DEFAULTS[sel.key] || null,
      unpinnedModel: overrideEnv ? afterUnpin || MODELS.DEFAULTS[sel.key] || null : null,
      // `derivesFrom`: config/models.js defaults this selector to another one
      // (OPENAI_SMS_DRAFT = MODEL_OPENAI_SMS_DRAFT || OPENAI_FAST), so while
      // it is not set in env, a change to the parent moves it too.
      derivesFrom: sel.derivesFrom || null,
      derived: !!sel.derivesFrom && !overrideEnv,
      laneCount: 0,
    };
  });
}

const SELECTOR_BY_KEY = Object.fromEntries(SELECTORS.map((s) => [s.key, s]));

// A ROUTES / TEXT_POLICIES leg is attributed to its registry selector only
// while the selector still supplies that exact model.
function resolveAttributed(model, selKey, path) {
  const attributed = selKey && MODELS[selKey] === model ? selKey : null;
  return { model, selector: attributed, via: `${path}${attributed ? ` → ${attributed}` : ''}`, pinEnv: null, pinned: false, live: false, accepts: attributed ? SELECTOR_BY_KEY[attributed].accepts : null };
}

// One env pin's own state, before any fallback: which alias is set (`setEnv`
// is the name to DELETE, not the canonical first name the composer writes),
// the model it yields (through ref.parse when the call site validates or
// decodes the value), and `afterUnpin` — the next lower-priority alias still
// set, which is what the leg runs on once `setEnv` is deleted.
function envLink(ref) {
  const names = Array.isArray(ref.env) ? ref.env : [ref.env];
  const setName = names.find((n) => process.env[n]) || null;
  const raw = setName ? process.env[setName] : null;
  const model = raw ? (ref.parse ? ref.parse(raw) : raw) || null : null;
  const afterUnpin = setName ? names.slice(names.indexOf(setName) + 1).map((n) => process.env[n]).find(Boolean) || null : null;
  return { env: names[0], setEnv: setName, model, accepted: !!model, afterUnpin };
}

// D(env, literal): `process.env.PIN || 'literal'`.
function resolveEnvLiteral(ref) {
  const link = envLink(ref);
  const model = link.model || ref.literal;
  const via = link.setEnv ? `${link.setEnv}${link.setEnv !== link.env ? ' (alias)' : ''}` : `${link.env} (code default)`;
  return { model, selector: null, via, pinEnv: link.env, setEnv: link.setEnv, pinned: !!link.setEnv, unpinnedModel: link.afterUnpin || ref.literal, live: ref.live, accepts: ref.accepts || { providers: [providerOf(model)], cap: 'text' } };
}

// E(env, base): `process.env.PIN || <base>`, where base may itself be an E()
// (voice_relay: VOICE_RELAY_INBOUND_MODEL → VOICE_RELAY_MODEL → VOICE tier).
//
// `chain` is the whole env chain, highest precedence first, each link with its
// own accepted/rejected verdict; `chainBase` is the selector / model at the
// bottom. The composer (client/src/pages/admin/agents/modelDraft.js walkChain)
// resolves every draft question — where a leg lands, which env moves it,
// whether it still follows a selector — by walking this one list with the
// draft applied, instead of re-deriving the chain from summary flags.
//
// `pinned` = the model comes from an env rather than the selector (the tab's
// selector-follower lists key on `!pinned`). An override ref.parse REJECTED
// is set but not in effect, so the leg is pinned exactly when its base is.
// `dependsOnEnvs` lists lower envs the CURRENT resolution rides (non-empty
// only when this leg's own pin is not in effect).
function resolveEnvChain(ref) {
  const link = envLink(ref);
  const base = resolveRef(ref.ref);
  const own = link.accepted;
  const dependsOnEnvs = own ? [] : [...(base.pinEnv ? [base.pinEnv] : []), ...(base.dependsOnEnvs || [])];
  const chain = [link, ...(base.chain || [])];
  const chainBase = base.chainBase || { selector: base.selector || null, model: base.model };
  const accepts = ref.catalogOnly ? { ...base.accepts, catalogOnly: true, allowedIds: ref.allowed ? ref.allowed() : null } : base.accepts;
  const via = own ? `${link.setEnv} (pinned)` : link.setEnv ? `${link.setEnv} rejected → ${base.via}` : `${link.env} → ${base.via}`;
  return {
    model: own ? link.model : base.model,
    selector: base.selector,
    via,
    pinEnv: link.env,
    setEnv: link.setEnv,
    pinned: own || !!base.pinned,
    unpinnedModel: link.afterUnpin || base.model,
    live: ref.live,
    accepts,
    dependsOnEnvs,
    chain,
    chainBase,
  };
}

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
    case 'route':
      return resolveAttributed(MODELS.ROUTES[ref.key]?.model, ROUTE_SELECTOR[ref.key], `ROUTES.${ref.key}`);
    case 'policy':
      return resolveAttributed(MODELS.TEXT_POLICIES[ref.key]?.[ref.leg]?.model, POLICY_SELECTOR[ref.key]?.[ref.leg], `TEXT_POLICIES.${ref.key}.${ref.leg}`);
    case 'literal':
      return { model: ref.model, selector: null, via: 'code constant', pinEnv: null, pinned: false, unpinnedModel: ref.model, live: false, accepts: ref.accepts || { providers: [providerOf(ref.model)], cap: 'text' } };
    case 'env':
      return ref.literal !== undefined ? resolveEnvLiteral(ref) : resolveEnvChain(ref);
    default:
      return null;
  }
}

function withProvider(leg) {
  if (!leg) return null;
  return { ...leg, provider: providerOf(leg.model) };
}

// Provider switch → { primary, fallback } the way the two call sites do it.
function resolveSwitch(ref) {
  const raw = process.env[ref.env];
  const provider = raw && ref.legs[raw] ? raw : 'openai';
  const primary = resolveRef(ref.legs[provider]);
  const fallbackLegs = ref.fallbackLegs || ref.legs;
  const fallbackRef = provider === 'anthropic' ? fallbackLegs.openai : fallbackLegs.anthropic;
  const fallback = resolveRef(fallbackRef);
  const tag = (leg) => ({ ...leg, via: `${ref.env}=${provider}${raw ? '' : ' (default)'} → ${leg.via}` });
  return { primary: tag(primary), fallback: fallback ? tag(fallback) : null };
}

function getSwitchboard() {
  const selectors = resolveSelectors();
  const byKey = Object.fromEntries(selectors.map((s) => [s.key, s]));
  const lanes = LANES.map((lane) => {
    const legs = lane.primary.kind === 'switch'
      ? resolveSwitch(lane.primary)
      : { primary: resolveRef(lane.primary), fallback: resolveRef(lane.fallback) };
    const primary = withProvider(legs.primary);
    let fallback = withProvider(legs.fallback);
    let retry = withProvider(resolveRef(lane.retry));
    // On a `skipsEqualLeg` lane the implementation guards `FALLBACK !== MODEL`
    // and never calls a leg that resolves to the same model as the one before
    // it. The leg is MARKED, not dropped: its selector still moves the lane (a
    // split GEMINI_VISION_FALLBACK_MODEL re-arms five photo ladders), so the
    // change composer and previews keep the dependency; the card hides
    // `skipped` legs from the chain sentence. Ladders without the flag (e.g.
    // video_gen) call every leg regardless, so nothing is marked there.
    const sameLeg = (a, b) => !!(a && b && a.model === b.model && a.provider === b.provider);
    if (lane.skipsEqualLeg) {
      if (sameLeg(fallback, retry)) retry = { ...retry, skipped: true };
      if (sameLeg(primary, fallback)) fallback = { ...fallback, skipped: true };
    }
    const also = (lane.also || []).map((ref) => withProvider(resolveRef(ref)));
    const registration = lane.lock?.kind === 'registration';
    if (primary.selector && byKey[primary.selector] && !primary.pinned && !registration) byKey[primary.selector].laneCount += 1;
    return {
      id: lane.id,
      name: lane.name,
      describe: LANE_DESCRIBE[lane.id] || null,
      area: LANE_AREA[lane.id] || 'office',
      continuity: JUDGED_LANES.has(lane.id) ? 'judged' : VERIFIED_LANES.has(lane.id) ? 'verified' : 'unchecked',
      file: lane.file,
      policy: lane.policy,
      primary,
      fallback,
      retry,
      also,
      applies: registration ? 'registration' : primary.live ? 'live' : 'restart',
      lock: lane.lock || null,
      fanout: !!lane.fanout,
      inbound: !!lane.inbound,
      skipsEqualLeg: !!lane.skipsEqualLeg,
      note: lane.note || null,
    };
  });
  const models = { ...MODEL_CATALOG };
  for (const lane of lanes) {
    for (const leg of [lane.primary, lane.fallback, lane.retry, ...lane.also]) {
      if (leg?.model && !models[leg.model]) models[leg.model] = catalogEntry(leg.model);
    }
  }
  for (const s of selectors) {
    if (s.current && !models[s.current]) models[s.current] = catalogEntry(s.current);
  }
  return {
    generatedAt: new Date().toISOString(),
    models,
    selectors,
    policies: POLICIES,
    areas: AREAS,
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
  AREAS,
  LANE_AREA,
  LANE_DESCRIBE,
  ROUTE_SELECTOR,
  POLICY_SELECTOR,
  MODEL_CATALOG,
};
