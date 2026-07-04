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
 *  These are QUALITY tiers, not cost tiers. Per owner directive
 *  ("best model regardless of cost"), each tier points at the strongest
 *  model for its job — not the cheapest. The tier names are unchanged so
 *  the 60+ importing services keep working; only the targets moved.
 *
 *  FLAGSHIP   — Best reasoning. Admin Intelligence Bar, advisors, analysis,
 *               agents, adversarial review.                          → Opus 4.8
 *  WORKHORSE  — Drafting + content generation.                       → Opus 4.8
 *  FAST       — High-volume classification, tagging, signals.        → Opus 4.8
 *  VOICE      — Customer-facing copy where a warm, natural human voice beats
 *               raw reasoning: SMS replies, service recaps, social posts.
 *               Sonnet 4.6 reads more natural and less overbuilt; high-stakes
 *               messages (cancellations, complaints) escalate to FLAGSHIP at
 *               the call site.                                       → Sonnet 4.6
 *  VISION     — Image scoring where deterministic output matters more than
 *               raw capability. Sonnet 4.6 because the Opus line removed the
 *               temperature parameter; Sonnet still accepts it so we can pin
 *               Claude to 0.2 to match the Gemini scorer.            → Sonnet 4.6
 *
 * Owner directive (2026-06-16): best model regardless of cost. The three
 * reasoning tiers default to Opus 4.8 (the strongest current Opus). Swap
 * any tier via its env var with no code change.
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

const FLAGSHIP  = process.env.MODEL_FLAGSHIP  || 'claude-opus-4-8';
const WORKHORSE = process.env.MODEL_WORKHORSE || 'claude-opus-4-8';
const FAST      = process.env.MODEL_FAST      || 'claude-opus-4-8';
const VOICE     = process.env.MODEL_VOICE     || 'claude-sonnet-4-6';
const VISION    = process.env.MODEL_VISION    || 'claude-sonnet-4-6';

// Lawn-diagnostic adversarial-challenge reasoner. Pinned independently of FLAGSHIP
// (which stays Opus 4.7) so the lawn pipeline can run Opus 4.8 without moving the whole
// app. Lives here (not in the service) so every Anthropic ID stays in the central
// registry. Override via MODEL_LAWN_CHALLENGE (registry convention) or LAWN_CHALLENGE_MODEL.
const LAWN_CHALLENGE = process.env.MODEL_LAWN_CHALLENGE || process.env.LAWN_CHALLENGE_MODEL || 'claude-opus-4-8';

// ── Cross-provider routing ────────────────────────────────────────────
// Provider ids — so callers / services/llm/call.js never hardcode a string.
const PROVIDER = Object.freeze({ ANTHROPIC: 'anthropic', OPENAI: 'openai', GEMINI: 'gemini' });

// Cross-provider model defaults (env-overridable; same convention as the #1834
// lawn pipeline's LAWN_WRITER_MODEL / LAWN_VISION_MODEL). NOT Anthropic IDs, so
// scripts/check-models.js intentionally skips them (it validates Anthropic only).
const OPENAI_BEST        = process.env.MODEL_OPENAI_BEST   || 'gpt-5.5';
const GEMINI_VISION_BEST = process.env.MODEL_GEMINI_VISION || 'gemini-3.5-flash';

// Gemini image-GENERATION models (the "Nano Banana" line) — consumed by
// content/image-generator.js MODEL_MAP for the social creative engine's scene
// backgrounds. BEST is the newest image model; STABLE is the GA fallback the
// chain drops to if the newer ID 404s (preview IDs get retired), so an ID
// retirement degrades quality, never availability.
const GEMINI_IMAGE_BEST   = process.env.MODEL_GEMINI_IMAGE        || 'gemini-3.1-flash-image-preview';
const GEMINI_IMAGE_STABLE = process.env.MODEL_GEMINI_IMAGE_STABLE || 'gemini-2.5-flash-image';

// Gemini video-GENERATION models (Veo line) — consumed by
// content/video-generator.js for the social creative engine's Reels clips.
// FAST is the default (≈$0.15/s vs $0.40/s, generates in under a minute);
// QUALITY is the full model the chain can step up to via env. Both are
// env-overridable so a retired preview ID is a config change, not a deploy.
const GEMINI_VIDEO_FAST    = process.env.MODEL_GEMINI_VIDEO         || 'veo-3.1-fast-generate-preview';
const GEMINI_VIDEO_QUALITY = process.env.MODEL_GEMINI_VIDEO_QUALITY || 'veo-3.1-generate-preview';

// Per-feature routes: { provider, model }. services/llm/call.js#dispatch switches
// on .provider. These are the LIVE provider for each feature; each call site falls
// back to Claude (Anthropic) on any miss, so a provider issue never causes a gap.
// Vision services (lawn-assessment, satellite-analyzer) read GEMINI_VISION_BEST
// directly. Call transcription + extraction keep their own providers in
// call-recording-processor.js (intentionally not routed here).
const ROUTES = Object.freeze({
  leadClassify:      Object.freeze({ provider: PROVIDER.OPENAI, model: OPENAI_BEST }), // lead-triage.js — live, Claude fallback
  knowledgeAnswer:   Object.freeze({ provider: PROVIDER.OPENAI, model: OPENAI_BEST }), // knowledge-bridge.js — live, Claude fallback
  estimateAssistant: Object.freeze({ provider: PROVIDER.OPENAI, model: OPENAI_BEST }), // estimate-assistant.js — live, Claude fallback
  askWaves:          Object.freeze({ provider: PROVIDER.OPENAI, model: OPENAI_BEST }), // ask-waves-intake.js — live, Claude fallback
  churnClassify:     Object.freeze({ provider: PROVIDER.OPENAI, model: OPENAI_BEST }), // churn-classifier.js — live, Claude fallback
});

module.exports = {
  FLAGSHIP,
  WORKHORSE,
  FAST,
  VOICE,
  VISION,
  LAWN_CHALLENGE,
  // Cross-provider routing (additive — legacy tier exports above are unchanged)
  PROVIDER,
  ROUTES,
  OPENAI_BEST,
  GEMINI_VISION_BEST,
  GEMINI_IMAGE_BEST,
  GEMINI_IMAGE_STABLE,
  GEMINI_VIDEO_FAST,
  GEMINI_VIDEO_QUALITY,
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
//   GEMINI_EXTRACTION_MODEL        call extraction pipeline
//                                  default: gemini-2.5-pro
//
// Do NOT move these into the tier registry without also updating that
// processor's provider-specific validation, fallback, and output-shape
// logic. This is where the cross-provider "GPT-5.5 not mini" / Gemini
// upgrade work (owner-in-progress) will land.
