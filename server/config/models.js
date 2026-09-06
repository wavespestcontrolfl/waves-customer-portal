/**
 * Claude Model Registry — Single Source of Truth
 *
 * Every Anthropic API call in this codebase should import from here.
 * Never hardcode a model ID like 'claude-sonnet-4-20250514' in a service file.
 *
 * ── How to upgrade to a new model ─────────────────────────────────
 *
 * Option A (no code deploy — preferred):
 *   Set the env var in Railway, restart the service. Done.
 *     MODEL_FLAGSHIP=claude-opus-5-0
 *
 * Option B (code change):
 *   Update the fallback string below, commit, deploy.
 *
 * Option C (check what's new):
 *   Run `npm run models:check` to see current Anthropic model IDs.
 *
 * ── Tiers ─────────────────────────────────────────────────────────
 *
 *  These are workload tiers. Each points to the least-expensive model that is
 *  reliably strong for the job, with Opus reserved for high-stakes reasoning
 *  and Fable explicit-only. The tier names are unchanged so the 60+ importing
 *  services keep working; only the targets moved.
 *
 *  DEEP       — Difficult reasoning and adversarial review. Kept on Opus for
 *               strong quality without automatically paying Fable rates. → Opus 4.8
 *  EXTREME    — Explicit, latency-tolerant Fable opt-in. No automatic live
 *               workflow routes here; callers must deliberately select it. → Fable 5
 *  FLAGSHIP   — Best general reasoning. Admin Intelligence Bar, advisors,
 *               analysis, agents.                                    → Opus 4.8
 *  WORKHORSE  — Drafting + content generation.                       → Sonnet 5
 *  FAST       — High-volume classification, tagging, signals.        → Sonnet 5
 *  VOICE      — Customer-facing copy where a warm, natural human voice beats
 *               raw reasoning: SMS replies, service recaps, social posts.
 *               Sonnet reads more natural and less overbuilt; high-stakes
 *               messages (cancellations, complaints) escalate to FLAGSHIP at
 *               the call site.                                       → Sonnet 5
 *  VISION     — Image scoring. Opus 4.8 (owner 2026-07-21: photo scoring
 *               drives customer-facing health scores — best model is the
 *               live model). Current Anthropic models reject sampling
 *               controls; no direct caller sends `temperature`.  → Opus 4.8
 *
 * Cost-aware routing directive (2026-07-16): use the least-expensive model
 * that is reliably strong for the lane, reserve Opus for difficult/high-stakes
 * work, and keep Fable explicit rather than automatic. Swap any tier via its
 * env var with no code change.
 *
 * ── Cross-provider routing (ROUTES) ───────────────────────────────
 *
 * Beyond the Anthropic tiers above, some features route to OpenAI / Gemini
 * (owner directive: best model for the job). The provider + model per feature
 * lives in the ROUTES map below; services dispatch through services/llm/call.js.
 * Each route is { provider, model } and is env-overridable, so every model ID —
 * Anthropic or not — stays discoverable in one place. These are the LIVE model
 * for each feature (owner directive 2026-06-17: best model is the live model);
 * each call site keeps an automatic fallback to Claude (Anthropic) so a provider
 * issue never causes a gap. Managed agents stay on Anthropic. Call transcription
 * + extraction keep their own providers in call-recording-processor.js.
 */

// Code defaults for every env-overridable selector, in one place so the admin
// switchboard can say what a selector returns to when its Railway override is
// deleted. Each const below reads `process.env.X || DEFAULTS.KEY`.
const DEFAULTS = Object.freeze({
  FLAGSHIP: 'claude-opus-4-8',
  WORKHORSE: 'claude-sonnet-5',
  FAST: 'claude-sonnet-5',
  VOICE: 'claude-sonnet-5',
  VISION: 'claude-opus-4-8',
  DEEP: 'claude-opus-4-8',
  EXTREME: 'claude-fable-5',
  LAWN_CHALLENGE: 'claude-opus-4-8',
  CALL_RESEARCH_ANTHROPIC: 'claude-opus-4-8',
  CALL_EXTRACTION_ANTHROPIC: 'claude-opus-4-8',
  OPENAI_BALANCED: 'gpt-5.6-terra',
  OPENAI_FAST: 'gpt-5.6-luna',
  OPENAI_REPORT_WRITER: 'gpt-5.6-sol',
  GEMINI_VISION_BEST: 'gemini-3.5-flash',
  GEMINI_TEXT_BEST: 'gemini-3.5-flash',
  GEMINI_VISION_FALLBACK: 'gemini-2.5-flash',
  OPENAI_EMBEDDING: 'text-embedding-3-small',
  SMS_SONNET: 'claude-sonnet-5',
  GEMINI_IMAGE_PRO: 'gemini-3-pro-image',
  GEMINI_IMAGE_BEST: 'gemini-3.1-flash-image-preview',
  GEMINI_IMAGE_STABLE: 'gemini-2.5-flash-image',
  GEMINI_VIDEO_FAST: 'veo-3.1-fast-generate-preview',
  GEMINI_VIDEO_QUALITY: 'veo-3.1-generate-preview',
});

const FLAGSHIP  = process.env.MODEL_FLAGSHIP  || DEFAULTS.FLAGSHIP;
const WORKHORSE = process.env.MODEL_WORKHORSE || DEFAULTS.WORKHORSE;
const FAST      = process.env.MODEL_FAST      || DEFAULTS.FAST;
const VOICE     = process.env.MODEL_VOICE     || DEFAULTS.VOICE;
// Owner 2026-07-21 (T&S report dry-run): photo scoring drives customer-facing
// health scores and report claims — best model is the live model.
const VISION    = process.env.MODEL_VISION    || DEFAULTS.VISION;

// Automatic deep-review work stays on Opus. Fable is available only through
// the explicit EXTREME tier so routine verifiers/fact checks cannot silently
// incur its latency, refusal semantics, and premium token rate.
const DEEP = process.env.MODEL_DEEP || DEFAULTS.DEEP;
const EXTREME = process.env.MODEL_EXTREME || DEFAULTS.EXTREME;

// Lawn-diagnostic adversarial-challenge reasoner. Pinned independently of FLAGSHIP
// (which stays Opus 4.7) so the lawn pipeline can run Opus 4.8 without moving the whole
// app. Lives here (not in the service) so every Anthropic ID stays in the central
// registry. Override via MODEL_LAWN_CHALLENGE (registry convention) or LAWN_CHALLENGE_MODEL.
const LAWN_CHALLENGE = process.env.MODEL_LAWN_CHALLENGE || process.env.LAWN_CHALLENGE_MODEL || DEFAULTS.LAWN_CHALLENGE;

// Call-research miner's Anthropic leg (fallback by default). Pinned here per
// the registry convention rather than riding FLAGSHIP: extraction-model
// changes must be deliberate (they mix corpus provenance without a
// prompt-version bump), so tier/report env changes must not move this.
const CALL_RESEARCH_ANTHROPIC = process.env.MODEL_CALL_RESEARCH_ANTHROPIC || DEFAULTS.CALL_RESEARCH_ANTHROPIC;

// V2 call-extraction's Anthropic fallback leg — same pinning rationale, own
// env so extraction and the research miner can diverge deliberately.
const CALL_EXTRACTION_ANTHROPIC = process.env.MODEL_CALL_EXTRACTION_ANTHROPIC || DEFAULTS.CALL_EXTRACTION_ANTHROPIC;

// ── Cross-provider routing ────────────────────────────────────────────
// Provider ids — so callers / services/llm/call.js never hardcode a string.
const PROVIDER = Object.freeze({ ANTHROPIC: 'anthropic', OPENAI: 'openai', GEMINI: 'gemini' });

// Cross-provider model defaults (env-overridable; same convention as the #1834
// lawn pipeline's LAWN_WRITER_MODEL / LAWN_VISION_MODEL). NOT Anthropic IDs, so
// scripts/check-models.js intentionally skips them (it validates Anthropic only).
const OPENAI_BALANCED      = process.env.MODEL_OPENAI_BALANCED
  || process.env.MODEL_OPENAI_BEST
  || DEFAULTS.OPENAI_BALANCED;
const OPENAI_FAST          = process.env.MODEL_OPENAI_FAST          || DEFAULTS.OPENAI_FAST;
// Backwards-compatible export for older callers/env configuration. New routes
// should select BALANCED or FAST explicitly instead of treating one model as
// universally "best".
const OPENAI_BEST          = OPENAI_BALANCED;
// Dedicated customer-report writer. Keep this separate from OPENAI_BEST so a
// writing-model upgrade does not silently move classification / Q&A lanes.
// The completed-service report uses this model first, then Claude Opus whenever
// OpenAI is unavailable, overloaded, empty, or fails the copy-safety gate.
const OPENAI_REPORT_WRITER = process.env.MODEL_OPENAI_REPORT_WRITER || DEFAULTS.OPENAI_REPORT_WRITER;
const GEMINI_VISION_BEST   = process.env.MODEL_GEMINI_VISION        || DEFAULTS.GEMINI_VISION_BEST;

// Gemini TEXT drafting — MEASUREMENT-ONLY today: the sealed-eval exam's
// experimental third leg drafts with it so Gemini can be ranked against the
// two live SMS providers on identical frozen items. No live text lane routes
// to it (generated text stays on the two-provider Claude/OpenAI policies);
// promoting it would be a deliberate registry change, not a fallback edit.
const GEMINI_TEXT_BEST = process.env.MODEL_GEMINI_TEXT || DEFAULTS.GEMINI_TEXT_BEST;

// Gemini vision FALLBACK — the prior GA model the customer vision services
// (pest-identification.js, lawn-assessment.js) retry when GEMINI_VISION_BEST
// misses, so a live-model entitlement/availability issue never costs the
// Gemini scorer. Lives here (not in the services) so every model ID stays
// discoverable in the central registry.
const GEMINI_VISION_FALLBACK = process.env.GEMINI_VISION_FALLBACK_MODEL || DEFAULTS.GEMINI_VISION_FALLBACK;

// Knowledge-index embedding model (hybrid knowledge search, lane A2).
// SINGLE provider BY DESIGN — an embedding space is only comparable to
// itself, so a cross-provider fallback here would return meaningless
// similarity scores. This is a deliberate exception to the every-lane
// Claude-fallback rule (Anthropic ships no embeddings API): if OpenAI
// embeddings are unavailable, hybrid search degrades to full-text and
// ingestion leaves rows pending for the next nightly run. Changing this
// model requires re-embedding the whole corpus
// (scripts/backfill-knowledge-embeddings.js after truncating embeddings).
const OPENAI_EMBEDDING = process.env.MODEL_OPENAI_EMBEDDING || DEFAULTS.OPENAI_EMBEDDING;
const EMBEDDING_DIMS = 1536; // must match knowledge_embeddings vector(1536)

// SMS reply-drafting split (owner directive 2026-07-05):
//   default auto-reply draft              → GPT-5.6 Luna (high-volume lane)
//   tone rewrite + save-the-sale replies  → Claude Sonnet 5 (warm customer voice)
// "Save-the-sale" = retention-critical inbound (cancellation / complaint /
// customer-issue intents) — matched by the drafter's SAVE_SALE_INTENT_RE.
// The drafter's adversarial fact-check verifier runs on DEEP: with a mini
// model drafting, the verify loop is the safety net, so it gets the
// deepest-reasoning model (falls back to FLAGSHIP on refusal).
const OPENAI_SMS_DRAFT = process.env.MODEL_OPENAI_SMS_DRAFT || OPENAI_FAST;
const SMS_SONNET       = process.env.MODEL_SMS_SONNET       || DEFAULTS.SMS_SONNET;

// Gemini image-GENERATION models (the "Nano Banana" line) — consumed by
// content/image-generator.js MODEL_MAP for the social creative engine's scene
// backgrounds. BEST is the newest image model; STABLE is the GA fallback the
// chain drops to if the newer ID 404s (preview IDs get retired), so an ID
// retirement degrades quality, never availability.
const GEMINI_IMAGE_PRO    = process.env.MODEL_GEMINI_IMAGE_PRO    || DEFAULTS.GEMINI_IMAGE_PRO;
const GEMINI_IMAGE_BEST   = process.env.MODEL_GEMINI_IMAGE        || DEFAULTS.GEMINI_IMAGE_BEST;
const GEMINI_IMAGE_STABLE = process.env.MODEL_GEMINI_IMAGE_STABLE || DEFAULTS.GEMINI_IMAGE_STABLE;

// Gemini video-GENERATION models (Veo line) — consumed by
// content/video-generator.js for the social creative engine's Reels clips.
// FAST is the default (≈$0.15/s vs $0.40/s, generates in under a minute);
// QUALITY is the full model the chain can step up to via env. Both are
// env-overridable so a retired preview ID is a config change, not a deploy.
const GEMINI_VIDEO_FAST    = process.env.MODEL_GEMINI_VIDEO         || DEFAULTS.GEMINI_VIDEO_FAST;
const GEMINI_VIDEO_QUALITY = process.env.MODEL_GEMINI_VIDEO_QUALITY || DEFAULTS.GEMINI_VIDEO_QUALITY;

// ── Model catalog (Agents → Models tab) ─────────────────────────────
// Every model id the admin switchboard may OFFER, with the metadata the
// picker needs. Lives here so all model ids stay in the registry (the
// domain-rules check fails on a `claude-*` literal anywhere else).
// Models the picker may offer. No prices here on purpose (owner 2026-09-03:
// prices are pulled weekly into a table, never hand-typed). `status`:
// current | legacy | unavailable (no adapter — listed so the option can be
// shown disabled).
const MODEL_CATALOG = {
  'claude-opus-5': { label: 'Claude Opus 5', provider: 'anthropic', caps: ['text', 'vision'], status: 'current' },
  'claude-opus-4-8': { label: 'Claude Opus 4.8', provider: 'anthropic', caps: ['text', 'vision'], status: 'legacy' },
  'claude-sonnet-5': { label: 'Claude Sonnet 5', provider: 'anthropic', caps: ['text', 'vision'], status: 'current' },
  // Fable's thinking blocks + refusal semantics are handled only by
  // services/llm/deep.js, so only DEEP / EXTREME selectors may take it.
  'claude-fable-5-1': { label: 'Claude Fable 5.1', provider: 'anthropic', caps: ['text', 'vision'], status: 'current', requires: 'deep' },
  'claude-fable-5': { label: 'Claude Fable 5', provider: 'anthropic', caps: ['text', 'vision'], status: 'legacy', requires: 'deep' },
  'claude-haiku-4-5-20251001': { label: 'Claude Haiku 4.5', provider: 'anthropic', caps: ['text', 'vision'], status: 'current' },
  'gpt-5.6-sol': { label: 'GPT-5.6 Sol', provider: 'openai', caps: ['text', 'vision'], status: 'current' },
  'gpt-5.6-terra': { label: 'GPT-5.6 Terra', provider: 'openai', caps: ['text', 'vision'], status: 'current' },
  'gpt-5.6-luna': { label: 'GPT-5.6 Luna', provider: 'openai', caps: ['text', 'vision'], status: 'current' },
  'gpt-5.5': { label: 'GPT-5.5', provider: 'openai', caps: ['text', 'vision'], status: 'current' },
  'gpt-5-mini': { label: 'GPT-5 mini', provider: 'openai', caps: ['text', 'vision'], status: 'current' },
  'gemini-3.8-flash': { label: 'Gemini 3.8 Flash', provider: 'gemini', caps: ['text', 'vision'], status: 'current' },
  'gemini-3.5-flash': { label: 'Gemini 3.5 Flash', provider: 'gemini', caps: ['text', 'vision'], status: 'current' },
  'gemini-2.5-pro': { label: 'Gemini 2.5 Pro', provider: 'gemini', caps: ['text', 'vision'], status: 'legacy' },
  'gemini-2.5-flash': { label: 'Gemini 2.5 Flash', provider: 'gemini', caps: ['text', 'vision'], status: 'legacy' },
  'muse-spark-1.3': { label: 'Muse Spark 1.3', provider: 'unknown', caps: ['text'], status: 'unavailable' },
};

// Per-feature routes: { provider, model }. services/llm/call.js#dispatch switches
// on .provider. These are the LIVE provider for each feature; each call site falls
// back to Claude (Anthropic) on any miss, so a provider issue never causes a gap.
// Vision services (lawn-assessment, satellite-analyzer) read GEMINI_VISION_BEST
// directly. Call transcription + extraction keep their own providers in
// call-recording-processor.js (intentionally not routed here).
const ROUTES = Object.freeze({
  leadClassify:      Object.freeze({ provider: PROVIDER.OPENAI, model: OPENAI_FAST }), // low-cost structured lane; Claude fallback
  knowledgeAnswer:   Object.freeze({ provider: PROVIDER.OPENAI, model: OPENAI_BALANCED }), // balanced Q&A; Claude fallback
  estimateAssistant: Object.freeze({ provider: PROVIDER.OPENAI, model: OPENAI_BALANCED }), // balanced prose; Claude fallback
  askWaves:          Object.freeze({ provider: PROVIDER.OPENAI, model: OPENAI_BALANCED }), // balanced public chat; Claude fallback
  churnClassify:     Object.freeze({ provider: PROVIDER.OPENAI, model: OPENAI_FAST }), // low-cost structured lane; Claude fallback
  // Owner ruling 2026-07-30 (v9 sealed-exam ranking: Sonnet beat Luna on
  // voice 7.79 vs 7.25, overall 6.50 vs 5.90, 0 unsafe vs 1): Claude Sonnet
  // drafts EVERY SMS lane, GPT (Sol via the highStakes fallback) backs it up.
  smsDraftDefault:   Object.freeze({ provider: PROVIDER.ANTHROPIC, model: SMS_SONNET }),       // default draft; OpenAI Sol backup
  smsDraftSaveSale:  Object.freeze({ provider: PROVIDER.ANTHROPIC, model: SMS_SONNET }),       // cancel/complaint draft; OpenAI Sol backup
  smsToneRewrite:    Object.freeze({ provider: PROVIDER.ANTHROPIC, model: SMS_SONNET }),       // tone rewrite; OpenAI Terra backup
});

// Generated-text policies always cross providers. The shared LLM dispatcher
// walks primary then fallback; no policy is allowed to list the same provider
// twice. Provider-specific managed agents and image/audio pipelines are outside
// this map because they do not have drop-in cross-provider equivalents.
const TEXT_POLICIES = Object.freeze({
  report: Object.freeze({
    name: 'report',
    primary: Object.freeze({ provider: PROVIDER.OPENAI, model: OPENAI_REPORT_WRITER }),
    fallback: Object.freeze({ provider: PROVIDER.ANTHROPIC, model: FLAGSHIP }),
  }),
  customerCopy: Object.freeze({
    name: 'customerCopy',
    // Owner 2026-07-21: customer-facing recap copy rides the flagship —
    // "sonnet is not cutting it" on the report/recap surfaces.
    primary: Object.freeze({ provider: PROVIDER.ANTHROPIC, model: FLAGSHIP }),
    fallback: Object.freeze({ provider: PROVIDER.OPENAI, model: OPENAI_BALANCED }),
  }),
  contentDraft: Object.freeze({
    name: 'contentDraft',
    primary: Object.freeze({ provider: PROVIDER.ANTHROPIC, model: WORKHORSE }),
    fallback: Object.freeze({ provider: PROVIDER.OPENAI, model: OPENAI_BALANCED }),
  }),
  highStakes: Object.freeze({
    name: 'highStakes',
    primary: Object.freeze({ provider: PROVIDER.ANTHROPIC, model: FLAGSHIP }),
    fallback: Object.freeze({ provider: PROVIDER.OPENAI, model: OPENAI_REPORT_WRITER }),
  }),
  fastStructured: Object.freeze({
    name: 'fastStructured',
    primary: Object.freeze({ provider: PROVIDER.OPENAI, model: OPENAI_FAST }),
    fallback: Object.freeze({ provider: PROVIDER.ANTHROPIC, model: FAST }),
  }),
  jobCardParagraph: Object.freeze({
    name: 'jobCardParagraph',
    // Job card customer paragraph (services/job-card.js): a 1–3 sentence
    // plain-English rewrite of deterministic portal facts, never analysis —
    // FAST tier both legs, same shape as fastStructured but text mode.
    primary: Object.freeze({ provider: PROVIDER.OPENAI, model: OPENAI_FAST }),
    fallback: Object.freeze({ provider: PROVIDER.ANTHROPIC, model: FAST }),
  }),
  balancedAnswer: Object.freeze({
    name: 'balancedAnswer',
    primary: Object.freeze({ provider: PROVIDER.OPENAI, model: OPENAI_BALANCED }),
    fallback: Object.freeze({ provider: PROVIDER.ANTHROPIC, model: WORKHORSE }),
  }),
  visionAnalysis: Object.freeze({
    name: 'visionAnalysis',
    primary: Object.freeze({ provider: PROVIDER.ANTHROPIC, model: VISION }),
    fallback: Object.freeze({ provider: PROVIDER.OPENAI, model: OPENAI_BALANCED }),
  }),
  visitBrief: Object.freeze({
    name: 'visitBrief',
    // Per-visit pocket-reference brief (previsit-brief.js) — summarization
    // over deterministic grounding, not analysis, so it rides the WORKHORSE
    // tier rather than the WDO brief's deepAnalysis (scope ruling
    // 2026-08-06: deepAnalysis is overkill per-visit).
    primary: Object.freeze({ provider: PROVIDER.ANTHROPIC, model: WORKHORSE }),
    fallback: Object.freeze({ provider: PROVIDER.OPENAI, model: OPENAI_BALANCED }),
  }),
  deepAnalysis: Object.freeze({
    name: 'deepAnalysis',
    primary: Object.freeze({ provider: PROVIDER.ANTHROPIC, model: DEEP }),
    fallback: Object.freeze({ provider: PROVIDER.OPENAI, model: OPENAI_REPORT_WRITER }),
  }),
});

module.exports = {
  DEEP,
  EXTREME,
  FLAGSHIP,
  WORKHORSE,
  FAST,
  VOICE,
  VISION,
  LAWN_CHALLENGE,
  CALL_RESEARCH_ANTHROPIC,
  CALL_EXTRACTION_ANTHROPIC,
  // Cross-provider routing (additive — legacy tier exports above are unchanged)
  PROVIDER,
  ROUTES,
  TEXT_POLICIES,
  OPENAI_BEST,
  OPENAI_BALANCED,
  OPENAI_FAST,
  OPENAI_REPORT_WRITER,
  OPENAI_SMS_DRAFT,
  OPENAI_EMBEDDING,
  EMBEDDING_DIMS,
  SMS_SONNET,
  GEMINI_VISION_BEST,
  GEMINI_TEXT_BEST,
  GEMINI_VISION_FALLBACK,
  GEMINI_IMAGE_PRO,
  GEMINI_IMAGE_BEST,
  GEMINI_IMAGE_STABLE,
  GEMINI_VIDEO_FAST,
  GEMINI_VIDEO_QUALITY,
  // Admin switchboard picker catalog (services/model-switchboard.js)
  MODEL_CATALOG,
  DEFAULTS,
  // Backwards-compatible default export for quick imports
  DEFAULT: FLAGSHIP,
};

// ── Cross-provider touchpoints OUTSIDE this registry ──────────────────
//
// Call transcription/recording models are intentionally configured in
// server/services/call-recording-processor.js, NOT here. They are
// pipeline-specific and provider-specific, with audio/diarization
// constraints (response_format, upload limits, multi-provider fallback,
// output shape) that do not map cleanly onto the app's LLM reasoning
// tiers. Listed here only as a breadcrumb so they're discoverable:
//
//   OPENAI_TRANSCRIPTION_MODEL     primary call transcription/diarization
//                                  default: gpt-4o-transcribe-diarize
//   GEMINI_TRANSCRIPTION_MODEL     long-call verifier / transcription fallback
//                                  default: gemini-2.5-flash
//   OPENAI_TRANSCRIPT_LABEL_MODEL  post-transcription Agent/Caller relabeling
//                                  default: gpt-5-mini (falls back to OPENAI_MODEL)
//   CALL_EXTRACTION_PROVIDER /     V2 call-extraction route primary
//   CALL_EXTRACTION_MODEL          default: openai / gpt-5.6-sol (25-call bake-off
//                                  winner 2026-07-18), Claude Opus 4.8 fallback via
//                                  dispatchWithFallback; kill = CALL_EXTRACTION_PROVIDER=gemini
//   GEMINI_EXTRACTION_MODEL        the route's gemini-leg model (legacy env name)
//                                  default: gemini-2.5-pro
//   CALL_RESEARCH_PROVIDER /       call-research corpus miner (voice-of-customer,
//   CALL_RESEARCH_MODEL            server/services/call-research-miner.js)
//                                  default: openai / gpt-5.6-sol (7-arm bake-off
//                                  winner 2026-07-18), Claude Opus 4.8 fallback
//                                  via dispatchWithFallback
//
// Do NOT move these into the tier registry without also updating that
// processor's provider-specific validation, fallback, and output-shape
// logic. This is where the cross-provider "GPT-5.5 not mini" / Gemini
// upgrade work (owner-in-progress) will land.
