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
 * ── Opus 5.5 flip order (2026-09-25 cost audit) ───────────────────
 *
 *   Opus 5.5 ($4/$20, cache reads $0.20) replaces Opus 4.8 ($5/$25/$0.50)
 *   with the same tokenizer and a 512-token cache minimum (4.8: 1024). What
 *   differs on the wire, and where this repo handles it:
 *   - Thinking is always on and precedes the text block: callers read text
 *     with anthropicText() / stripThinkingBlocks, never content[0].
 *   - Thinking spends from max_tokens: every Anthropic request (adapter,
 *     DEEP helper, and each direct SDK site on an Opus tier) sizes its cap
 *     through anthropicMaxTokens(model, cap) in services/llm/anthropic-wire.js,
 *     which raises it to a floor on ANTHROPIC_THINKING_FLOOR_RE models only.
 *   - Effort defaults to 'medium' (4.8: 'high'): set MODEL_ANTHROPIC_EFFORT=high
 *     with the flip; the same module applies it to ANTHROPIC_EFFORT_CAPABLE_RE
 *     models, and a caller's own effort wins.
 *   - `thinking: { type: 'disabled' }` and forced tool_choice any/tool are
 *     400s: only the two VOICE lanes send the former (VOICE is Sonnet), and
 *     nothing sends the latter. Tool loops push response.content back whole.
 *   Flip MODEL_DEEP first (deep.js strips thinking + has an OpenAI backup),
 *   watch a night of ledger rows, then FLAGSHIP / VISION / the Opus pins.
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

// Anthropic effort for adapter + DEEP-helper calls (output_config.effort).
// Unset = the model's own default. Opus 4.8 defaults to 'high'; Opus 5.5
// defaults to 'medium', so a tier flip to 5.5 quietly drops effort unless
// this pins it. Only the five API levels are honored; anything else is
// ignored with the default (never a 400 on a typo).
const ANTHROPIC_EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const ANTHROPIC_EFFORT = ANTHROPIC_EFFORT_LEVELS.has(process.env.MODEL_ANTHROPIC_EFFORT)
  ? process.env.MODEL_ANTHROPIC_EFFORT
  : undefined;
// Model-family patterns read by services/llm/anthropic-wire.js (kept here so
// every Anthropic ID shape stays in the registry; a test that mocks this
// module without them gets byte-identical requests).
//
// Effort: only models that accept ALL five levels (low … max, incl. xhigh)
// get the pin — Opus 4.7 and later, Sonnet 5 and later, Fable, Mythos.
// Opus 4.5 takes low/medium/high only and Opus 4.6 has no xhigh; Haiku 4.5
// and pre-5 Sonnets 400 on the field. The admin picker can pin any of those
// on a lane, so the pin must never reach them.
const ANTHROPIC_EFFORT_CAPABLE_RE = /^claude-opus-(4-[7-9]|[5-9])(?![0-9])|^claude-sonnet-[5-9](?![0-9])|^claude-(fable|mythos)-/;
// Models that accept only SOME levels, for callers that request one specific
// level (the voice lanes' `low`) rather than applying the admin pin.
const ANTHROPIC_EFFORT_PARTIAL_LEVELS = Object.freeze([
  { re: /^claude-opus-4-5(?![0-9])/, levels: Object.freeze(['low', 'medium', 'high']) },
  { re: /^claude-opus-4-6(?![0-9])/, levels: Object.freeze(['low', 'medium', 'high', 'max']) },
]);
// True when `model` accepts output_config.effort at exactly `level`.
function anthropicAcceptsEffort(model, level) {
  const id = String(model || '');
  if (ANTHROPIC_EFFORT_CAPABLE_RE.test(id)) return ANTHROPIC_EFFORT_LEVELS.has(level);
  const partial = ANTHROPIC_EFFORT_PARTIAL_LEVELS.find(({ re }) => re.test(id));
  return Boolean(partial && partial.levels.includes(level));
}
// Thinking floor: Opus 5 and later, Fable and Mythos think on every request
// that omits `thinking` (5.5, Fable and Mythos cannot turn it off), and
// thinking spends from max_tokens ahead of the text block — a cap sized for
// a no-thinking reply ends the turn with no text. Sonnet 5 also thinks by
// default, but its lanes' caps were already tuned against it in production
// (previsit brief 1000 → 2000 → 3000), so it is left out and this stays
// inert for today's traffic. Sonnet 5.5 and later cannot turn thinking off
// (even `between_tools` returns progress-update thinking blocks), so they
// take the floor like Opus 5.5.
const ANTHROPIC_THINKING_FLOOR_RE = /^claude-opus-[5-9](?![0-9])|^claude-sonnet-5-[0-9]|^claude-sonnet-[6-9](?![0-9])|^claude-(fable|mythos)-/;

// NARROWER than the floor above on purpose: bare Opus 5 (`claude-opus-5`)
// thinks by default (ANTHROPIC_THINKING_FLOOR_RE) but still ACCEPTS
// `thinking: { type: 'disabled' }` — the voice-relay override tests and the
// live inbound/sandbox chain both rely on picking it with that literal still
// sent. Opus 5.5 and later minors/majors (5-5, 5-6, 6, 7, …), Sonnet 5.5 and
// later (its floor is `between_tools`), plus Fable and Mythos, are the ones
// that 400 on it outright. One id shape per family, so a future minor needs a
// change here only, never at either call site that reads this.
const ANTHROPIC_THINKING_REQUIRED_RE = /^claude-opus-5-[0-9]|^claude-opus-[6-9](?![0-9])|^claude-sonnet-5-[0-9]|^claude-sonnet-[6-9](?![0-9])|^claude-(fable|mythos)-/;
// What a CALLER needs to know before building a request: can `thinking` be
// sent as `{ type: 'disabled' }` at all? The two voice-relay lanes that
// always send it check this before picking a model.
function anthropicThinkingAlwaysOn(model) {
  return ANTHROPIC_THINKING_REQUIRED_RE.test(String(model || ''));
}

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
  VOICE_JUDGE: 'claude-opus-4-8',
  // Newsletter writer + event-curation scoring (owner ruling 2026-09-27):
  // Opus 5.5 at effort 'max' — Opus 5.5 defaults to 'medium', so the
  // newsletterWriter policy pins effort explicitly rather than relying on
  // the model's own default.
  NEWSLETTER: 'claude-opus-5-5',
  OPENAI_BALANCED: 'gpt-5.6-terra',
  OPENAI_FAST: 'gpt-5.6-luna',
  OPENAI_REPORT_WRITER: 'gpt-5.6-sol',
  OPENAI_FRONTIER: 'gpt-6-astra',
  OPENAI_ESTIMATE_VISION: 'gpt-6-sol',
  OPENAI_IMAGE_SCREEN: 'gpt-5.6-sol',
  // Plant/tree/shrub/palm photo ID second opinion (owner ruling 2026-09-28,
  // replaces the 09-26 "no Claude" ruling for the PLANT ENGINE ONLY — the
  // pest engine's photoIdVision ladder is unchanged): Gemini 3.8 Flash first,
  // GPT-6 Sol as the second opinion.
  OPENAI_PLANT_ID: 'gpt-6-sol',
  // Lawn visit assessment backup leg (owner ruling 2026-09-29): GPT-6 Sol
  // replaces Astra, matching the plant engine's second opinion — about a
  // third of Astra's cost and no worse on the hardest photo tests.
  OPENAI_LAWN_ASSESSMENT: 'gpt-6-sol',
  // Plant/tree/shrub/palm photo ID referee (owner ruling 2026-09-28): Claude
  // Fable 5.1 at high effort, a deciding third look only when a scope is
  // still unsure after the second opinion. requires:'deep' in MODEL_CATALOG
  // below; dispatched through services/llm/call.js like every other route,
  // which already sizes max_tokens for always-thinking models and reads the
  // answer past any thinking block (anthropicText) — see plant-engine.js.
  PLANT_ID_REFEREE: 'claude-fable-5-1',
  // Lawn visit assessment name referee (owner ruling 2026-09-29): Claude Fable
  // 5.1 at high effort, a tie-break on grass type / finding names only, and
  // only when Gemini and the Sol second opinion disagreed. Dark behind
  // GATE_LAWN_ASSESSMENT_REFEREE.
  LAWN_ASSESSMENT_REFEREE: 'claude-fable-5-1',
  // Daily Google Ads campaign advisor (owner ruling 2026-10-01): Claude Fable
  // 5.1 at high effort writes the daily report. requires:'deep' in
  // MODEL_CATALOG; dispatched through services/llm/call.js, which floors
  // max_tokens for always-thinking models and reads past thinking blocks.
  ADS_ADVISOR: 'claude-fable-5-1',
  GEMINI_VISION_BEST: 'gemini-3.8-flash',
  // App lawn + tree/shrub/palm Photo ID (owner 2026-10-02, "same as pest"):
  // the model for photoIdPlantV2's one Gemini read; set from the 27-photo eval.
  GEMINI_PHOTO_ID_PLANT: 'gemini-3.6-flash',
  // App Photo ID pest engine (owner 2026-10-01, "lets just use Gemini"): on
  // the owner's chinch bug photo 3.6 Flash named it 4/4 in ~1.7 s through
  // the engine; 3.8 Flash gave chinch, seed bug and carpenter ant.
  GEMINI_PHOTO_ID_PEST: 'gemini-3.6-flash',
  GEMINI_TEXT_BEST: 'gemini-3.5-flash',
  GEMINI_VISION_FALLBACK: 'gemini-3.8-flash',
  OPENAI_EMBEDDING: 'text-embedding-3-small',
  SMS_SONNET: 'claude-sonnet-5',
  GEMINI_IMAGE_PRO: 'gemini-3-pro-image',
  GEMINI_IMAGE_BEST: 'gemini-3.1-flash-image-preview',
  GEMINI_IMAGE_STABLE: 'gemini-2.5-flash-image',
  GEMINI_VIDEO_FAST: 'veo-3.1-fast-generate-preview',
  GEMINI_VIDEO_QUALITY: 'veo-3.1-generate-preview',
  // TypeSafe Jev: a decision-only model (yes/no, choice, score answers; no
  // free text). Production PINS a dated version: the `jev-latest` alias moves
  // under us, so the adapter refuses any model that is not jev-N.N.N.
  TYPESAFE_JEV: 'jev-1.13.0',
  // Cloudflare Clef (Workers AI): decision-only models with Jev-compatible
  // answers. Cloudflare publishes no dated ids, so the pin is the id itself
  // plus the model the provider reports serving, recorded on every ledger row.
  CLOUDFLARE_CLEF: 'clef-flash',
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

// Optional voice replay judge (services/eval/voice-relay-judge.js). Pinned
// under the registry convention rather than riding FLAGSHIP: a judge that moves with the tier
// re-baselines every scorecard, so it moves only when MODEL_VOICE_JUDGE is
// set deliberately.
const VOICE_JUDGE = process.env.MODEL_VOICE_JUDGE || DEFAULTS.VOICE_JUDGE;

// Newsletter writer + event-curation scoring (owner ruling 2026-09-27:
// stop skipping the weekly issue — auto-curation was starving at 0-5
// approved events/week). Own selector rather than riding FLAGSHIP/WORKHORSE
// so this one lane can move to Opus 5.5 without affecting every other
// FLAGSHIP/WORKHORSE call site.
const NEWSLETTER = process.env.MODEL_NEWSLETTER || DEFAULTS.NEWSLETTER;

// ── Cross-provider routing ────────────────────────────────────────────
// Provider ids — so callers / services/llm/call.js never hardcode a string.
const PROVIDER = Object.freeze({ ANTHROPIC: 'anthropic', OPENAI: 'openai', GEMINI: 'gemini', TYPESAFE: 'typesafe', CLOUDFLARE: 'cloudflare' });

// Cross-provider model defaults (env-overridable; same convention as the #1834
// lawn pipeline's LAWN_WRITER_MODEL / LAWN_VISION_MODEL). NOT Anthropic IDs, so
// scripts/check-models.js intentionally skips them (it validates Anthropic only).
// TypeSafe Jev typed-decision model (ROUTES.typedDecision). Pinned version.
const TYPESAFE_JEV = process.env.MODEL_TYPESAFE_JEV || DEFAULTS.TYPESAFE_JEV;
// Cloudflare Clef typed-decision model (ROUTES.typedDecisionClef): a second
// provider for the same decision packages. clef-flash (9B) or clef (27B).
const CLOUDFLARE_CLEF = process.env.MODEL_CLOUDFLARE_CLEF || DEFAULTS.CLOUDFLARE_CLEF;

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
// Frontier OpenAI multimodal model — the backup leg of the lawn visit
// assessment (owner 2026-09-08: when the Gemini call misses, ChatGPT takes
// over on the best model). Its own selector, off BALANCED / REPORT_WRITER, so
// the premium rate is paid only on that lane's fallback leg and a Q&A or
// report model change never moves it.
const OPENAI_FRONTIER      = process.env.MODEL_OPENAI_FRONTIER || DEFAULTS.OPENAI_FRONTIER;
// Estimate imagery has its own Sol fallback so generic OpenAI overrides cannot
// silently replace it with an unrelated model (owner directive 2026-09-25).
const OPENAI_ESTIMATE_VISION = process.env.MODEL_OPENAI_ESTIMATE_VISION || DEFAULTS.OPENAI_ESTIMATE_VISION;
// Generated-image screen (owner ruling 2026-09-25: Sol first). In the
// 2026-09-25 lab GPT-5.6 Sol judged the uniform badge's chest side 12 of 12
// from badge/placket positions; Claude Opus got it wrong in both directions.
const OPENAI_IMAGE_SCREEN  = process.env.MODEL_OPENAI_IMAGE_SCREEN || DEFAULTS.OPENAI_IMAGE_SCREEN;
// Plant photo ID second opinion (owner ruling 2026-09-28). Its own selector,
// off OPENAI_FRONTIER / OPENAI_ESTIMATE_VISION, so this one lane can move
// independently of the pest identifier's second look and the estimate vision
// fallback.
const OPENAI_PLANT_ID      = process.env.MODEL_OPENAI_PLANT_ID     || DEFAULTS.OPENAI_PLANT_ID;
// Lawn visit assessment backup (owner ruling 2026-09-29). Its own selector,
// off OPENAI_FRONTIER / OPENAI_PLANT_ID, so the lawn lane moves independently
// of the pest identifier's Astra second look and the plant engine.
const OPENAI_LAWN_ASSESSMENT = process.env.MODEL_OPENAI_LAWN_ASSESSMENT || DEFAULTS.OPENAI_LAWN_ASSESSMENT;
// Plant photo ID referee (owner ruling 2026-09-28) — explicit opt-in via
// GATE_PLANT_ID_REFEREE (server/config/feature-gates.js), never automatic.
const PLANT_ID_REFEREE     = process.env.MODEL_PLANT_ID_REFEREE    || DEFAULTS.PLANT_ID_REFEREE;
// Lawn visit assessment name referee (owner ruling 2026-09-29) — explicit
// opt-in via GATE_LAWN_ASSESSMENT_REFEREE, never automatic.
const LAWN_ASSESSMENT_REFEREE = process.env.MODEL_LAWN_ASSESSMENT_REFEREE || DEFAULTS.LAWN_ASSESSMENT_REFEREE;
// Daily ads advisor (owner ruling 2026-10-01) — its own selector so the
// advisor moves independently of FLAGSHIP / the highStakes policy.
const ADS_ADVISOR          = process.env.MODEL_ADS_ADVISOR         || DEFAULTS.ADS_ADVISOR;
const GEMINI_VISION_BEST   = process.env.MODEL_GEMINI_VISION        || DEFAULTS.GEMINI_VISION_BEST;
const GEMINI_PHOTO_ID_PLANT = process.env.MODEL_GEMINI_PHOTO_ID_PLANT || DEFAULTS.GEMINI_PHOTO_ID_PLANT;
const GEMINI_PHOTO_ID_PEST = process.env.MODEL_GEMINI_PHOTO_ID_PEST || DEFAULTS.GEMINI_PHOTO_ID_PEST;

// Gemini TEXT drafting — MEASUREMENT-ONLY today: the sealed-eval exam's
// experimental third leg drafts with it so Gemini can be ranked against the
// two live SMS providers on identical frozen items. No live text lane routes
// to it (generated text stays on the two-provider Claude/OpenAI policies);
// promoting it would be a deliberate registry change, not a fallback edit.
const GEMINI_TEXT_BEST = process.env.MODEL_GEMINI_TEXT || DEFAULTS.GEMINI_TEXT_BEST;

// Gemini vision FALLBACK — the model the photo lanes (pest-identification.js,
// lawn-assessment.js, …) retry when GEMINI_VISION_BEST misses. Owner ruling
// 2026-09-06: every image-analysis leg runs gemini-3.8-flash, so the default
// equals BEST and every ladder skips the retry rung; set
// GEMINI_VISION_FALLBACK_MODEL to a different id to re-arm it. Lives here
// (not in the services) so every model ID stays discoverable in the registry.
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
  // Opus 5.5 (see the flip-order note atop this file) — thinking is always
  // on (anthropicThinkingAlwaysOn), and most direct tier callers size
  // max_tokens for a no-thinking reply, so like Fable it is offered only to
  // DEEP / EXTREME selectors (deep.js sizes and strips thinking). `voice`
  // admits it to the voice relay's sandbox / eval-harness thinking-on path
  // (relay-conversation.js) — never production inbound or collections.
  'claude-opus-5-5': { label: 'Claude Opus 5.5', provider: 'anthropic', caps: ['text', 'vision'], status: 'current', requires: 'deep', voice: { thinking: 'adaptive' } },
  'claude-opus-4-8': { label: 'Claude Opus 4.8', provider: 'anthropic', caps: ['text', 'vision'], status: 'legacy' },
  'claude-sonnet-5': { label: 'Claude Sonnet 5', provider: 'anthropic', caps: ['text', 'vision'], status: 'current' },
  // Sonnet 5.5 (released 2026-09-28) rejects `thinking: { type: 'disabled' }`
  // (anthropicThinkingAlwaysOn); its lowest setting is `between_tools`, which
  // `voice.thinking` hands the voice relay's sandbox / eval-harness path so a
  // test call keeps up-front thinking off. `requires: 'deep'` keeps it off the
  // WORKHORSE / FAST / VOICE pickers, whose call sites were not migrated —
  // same containment as Opus 5.5 above.
  'claude-sonnet-5-5': { label: 'Claude Sonnet 5.5', provider: 'anthropic', caps: ['text', 'vision'], status: 'current', requires: 'deep', voice: { thinking: 'between_tools' } },
  // Fable's thinking blocks + refusal semantics are handled only by
  // services/llm/deep.js, so only DEEP / EXTREME selectors may take it.
  'claude-fable-5-1': { label: 'Claude Fable 5.1', provider: 'anthropic', caps: ['text', 'vision'], status: 'current', requires: 'deep' },
  'claude-fable-5': { label: 'Claude Fable 5', provider: 'anthropic', caps: ['text', 'vision'], status: 'legacy', requires: 'deep' },
  'claude-haiku-4-5-20251001': { label: 'Claude Haiku 4.5', provider: 'anthropic', caps: ['text', 'vision'], status: 'current' },
  'gpt-6-astra': { label: 'GPT-6 Astra', provider: 'openai', caps: ['text', 'vision'], status: 'current' },
  // `voice` marks a model eligible for the gated voice-relay OpenAI adapter
  // (server/services/voice-agent/relay-openai-client.js) AND carries its
  // per-model Responses `reasoning.effort` — one place for both, so the
  // adapter never hardcodes a model id (CLAUDE.md AI rule 1). Voice-relay
  // sessions always run this lane's `low`-equivalent: minimal thinking on a
  // live phone call. See relay-openai-client.js for how `voice.reasoning` is
  // read and applied; a model with no `voice` key is never offered to
  // VOICE_RELAY_INBOUND_MODEL / VOICE_RELAY_SANDBOX_MODEL / a benchmark
  // --candidate-model, gate or no gate.
  // The GPT-6 line's efforts start at 'low' ('none' 400s — see
  // services/llm/call.js), so its voice entries take 'low'; GPT-5.6 keeps 'none'.
  'gpt-6-sol': { label: 'GPT-6 Sol', provider: 'openai', caps: ['text', 'vision'], status: 'current', voice: { reasoning: 'low' } },
  // Released 2026-09-22. No vision leg documented yet — text only.
  'gpt-6-luna': { label: 'GPT-6 Luna', provider: 'openai', caps: ['text'], status: 'current', voice: { reasoning: 'low' } },
  'gpt-5.6-sol': { label: 'GPT-5.6 Sol', provider: 'openai', caps: ['text', 'vision'], status: 'current' },
  'gpt-5.6-terra': { label: 'GPT-5.6 Terra', provider: 'openai', caps: ['text', 'vision'], status: 'current', voice: { reasoning: 'none' } },
  'gpt-5.6-luna': { label: 'GPT-5.6 Luna', provider: 'openai', caps: ['text', 'vision'], status: 'current', voice: { reasoning: 'none' } },
  'gpt-5.5': { label: 'GPT-5.5', provider: 'openai', caps: ['text', 'vision'], status: 'current' },
  'gpt-5-mini': { label: 'GPT-5 mini', provider: 'openai', caps: ['text', 'vision'], status: 'current' },
  'gemini-3.8-flash': { label: 'Gemini 3.8 Flash', provider: 'gemini', caps: ['text', 'vision'], status: 'current' },
  'gemini-3.6-flash': { label: 'Gemini 3.6 Flash', provider: 'gemini', caps: ['text', 'vision'], status: 'current' },
  'gemini-3.5-flash': { label: 'Gemini 3.5 Flash', provider: 'gemini', caps: ['text', 'vision'], status: 'current' },
  'gemini-2.5-pro': { label: 'Gemini 2.5 Pro', provider: 'gemini', caps: ['text', 'vision'], status: 'legacy' },
  'gemini-2.5-flash': { label: 'Gemini 2.5 Flash', provider: 'gemini', caps: ['text', 'vision'], status: 'legacy' },
  // TypeSafe Jev answers typed questions only (noul / choice / score); it never
  // writes text, so its only cap is 'decision' and no text/vision picker may
  // offer it.
  'jev-1.13.0': { label: 'TypeSafe Jev 1.13', provider: 'typesafe', caps: ['decision'], status: 'current' },
  // Cloudflare Clef on Workers AI: decision-only, same question and answer
  // shapes as Jev. Never a text or vision picker option.
  'clef-flash': { label: 'Cloudflare Clef-flash', provider: 'cloudflare', caps: ['decision'], status: 'current' },
  'clef': { label: 'Cloudflare Clef', provider: 'cloudflare', caps: ['decision'], status: 'current' },
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
  churnClassify:     Object.freeze({ provider: PROVIDER.OPENAI, model: OPENAI_FAST }), // low-cost structured lane; Claude fallback
  // Owner ruling 2026-07-30 (v9 sealed-exam ranking: Sonnet beat Luna on
  // voice 7.79 vs 7.25, overall 6.50 vs 5.90, 0 unsafe vs 1): Claude Sonnet
  // drafts EVERY SMS lane, GPT (Sol via the highStakes fallback) backs it up.
  smsDraftDefault:   Object.freeze({ provider: PROVIDER.ANTHROPIC, model: SMS_SONNET }),       // default draft; OpenAI Sol backup
  smsDraftSaveSale:  Object.freeze({ provider: PROVIDER.ANTHROPIC, model: SMS_SONNET }),       // cancel/complaint draft; OpenAI Sol backup
  smsToneRewrite:    Object.freeze({ provider: PROVIDER.ANTHROPIC, model: SMS_SONNET }),       // tone rewrite; OpenAI Terra backup
  // Plant/tree/shrub/palm photo ID referee (owner ruling 2026-09-28,
  // plant-engine.js's runReferee): single-leg, no automatic fallback — a
  // referee miss leaves the Gemini -> Sol escalation result unchanged rather
  // than trying a third provider. `effort: 'high'` reaches only the
  // Anthropic leg (services/llm/call.js#dispatch).
  plantIdReferee:    Object.freeze({ provider: PROVIDER.ANTHROPIC, model: PLANT_ID_REFEREE, effort: 'high' }),
  // Lawn visit assessment name referee (owner ruling 2026-09-29,
  // lawn-visit-referee.js): single-leg, no automatic fallback — a referee
  // miss leaves Gemini's read exactly as it was.
  lawnAssessmentReferee: Object.freeze({ provider: PROVIDER.ANTHROPIC, model: LAWN_ASSESSMENT_REFEREE, effort: 'high' }),
  // Typed decisions (services/typed-decisions/jev.js): TypeSafe Jev answers
  // yes/no, choice and score questions. Single-leg by design, no cross-provider
  // fallback: nothing else answers typed questions, so callers fall back to
  // their existing path on `ok:false`. Never a TEXT_POLICIES leg.
  typedDecision: Object.freeze({ provider: PROVIDER.TYPESAFE, model: TYPESAFE_JEV }),
  // The same decision packages on Cloudflare Clef (Workers AI), recorded
  // beside Jev for comparison. Single-leg like typedDecision; dark behind
  // GATE_TYPED_DECISIONS_CLEF (which also needs GATE_TYPED_DECISIONS).
  typedDecisionClef: Object.freeze({ provider: PROVIDER.CLOUDFLARE, model: CLOUDFLARE_CLEF }),
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
  adsAdvisor: Object.freeze({
    name: 'adsAdvisor',
    // Daily Google Ads advisor (campaign-advisor.js) — owner ruling
    // 2026-10-01: Claude Fable 5.1 at high effort, GPT (Sol) as the backup.
    // `effort` reaches only the Anthropic leg (services/llm/call.js#dispatch).
    primary: Object.freeze({ provider: PROVIDER.ANTHROPIC, model: ADS_ADVISOR, effort: 'high' }),
    fallback: Object.freeze({ provider: PROVIDER.OPENAI, model: OPENAI_REPORT_WRITER }),
  }),
  fastStructured: Object.freeze({
    name: 'fastStructured',
    primary: Object.freeze({ provider: PROVIDER.OPENAI, model: OPENAI_FAST }),
    fallback: Object.freeze({ provider: PROVIDER.ANTHROPIC, model: FAST }),
  }),
  balancedAnswer: Object.freeze({
    name: 'balancedAnswer',
    primary: Object.freeze({ provider: PROVIDER.OPENAI, model: OPENAI_BALANCED }),
    fallback: Object.freeze({ provider: PROVIDER.ANTHROPIC, model: WORKHORSE }),
  }),
  askWaves: Object.freeze({
    name: 'askWaves',
    // Public sales-intake chat (services/ask-waves-intake.js): balanced OpenAI
    // primary, Claude VOICE-tier fallback — through dispatchWithFallback like
    // every other policy, so the shared chain (budget split, provider
    // failures, chain telemetry) owns the fallback instead of a bespoke local
    // implementation. ASK_WAVES_MODEL overrides the Anthropic fallback leg
    // only (the call site swaps this policy's fallback route when set — same
    // convention as MODEL_FACTCHECK/MODEL_COMPLIANCE overriding one leg of
    // deepAnalysis); the OpenAI primary always follows OPENAI_BALANCED.
    primary: Object.freeze({ provider: PROVIDER.OPENAI, model: OPENAI_BALANCED }),
    fallback: Object.freeze({ provider: PROVIDER.ANTHROPIC, model: VOICE }),
  }),
  visionAnalysis: Object.freeze({
    name: 'visionAnalysis',
    primary: Object.freeze({ provider: PROVIDER.ANTHROPIC, model: VISION }),
    fallback: Object.freeze({ provider: PROVIDER.OPENAI, model: OPENAI_BALANCED }),
  }),
  estimateVision: Object.freeze({
    name: 'estimateVision',
    // Estimate satellite/property images: one Gemini read, Sol only on a miss.
    primary: Object.freeze({ provider: PROVIDER.GEMINI, model: process.env.GEMINI_VISION_MODEL || GEMINI_VISION_BEST }),
    fallback: Object.freeze({ provider: PROVIDER.OPENAI, model: OPENAI_ESTIMATE_VISION }),
  }),
  photoCaptions: Object.freeze({
    name: 'photoCaptions',
    // Completion-photo captions (admin-dispatch.js, laneId 'photo_scoring').
    // Owner directive 2026-09-24: this lane runs on Gemini, not Claude/OpenAI —
    // GEMINI_VISION_BEST is the primary, Claude VISION is the fallback (only
    // when Gemini returns nothing), matching the waves-llm skill's rule that
    // every cross-provider call site keeps an automatic Claude fallback.
    // Honors the shared GEMINI_VISION_MODEL override the other photo lanes
    // read, so one env var moves (or rolls back) every Gemini photo lane.
    primary: Object.freeze({ provider: PROVIDER.GEMINI, model: process.env.GEMINI_VISION_MODEL || GEMINI_VISION_BEST }),
    fallback: Object.freeze({ provider: PROVIDER.ANTHROPIC, model: VISION }),
  }),
  lawnVisitAssessment: Object.freeze({
    name: 'lawnVisitAssessment',
    // One multimodal call per lawn visit (services/lawn-visit-assessment.js,
    // GATE_LAWN_VISIT_ASSESSMENT). Owner ruling 2026-09-08 (DECISIONS.md): the
    // Gemini vision model reads every visit photo at once; when it misses,
    // OpenAI takes over — GPT-6 Sol since the 2026-09-29 ruling (was Astra).
    // No Claude leg and no parallel providers — the one lane that
    // deliberately departs from the Claude-fallback rule.
    primary: Object.freeze({ provider: PROVIDER.GEMINI, model: GEMINI_VISION_BEST }),
    fallback: Object.freeze({ provider: PROVIDER.OPENAI, model: OPENAI_LAWN_ASSESSMENT }),
  }),
  photoIdVision: Object.freeze({
    name: 'photoIdVision',
    // Photo ID (pest-identification.js: website funnel, SMS photo triage,
    // admin assessments, the customer app). Owner ruling 2026-09-26: Gemini
    // 3.8 Flash reads the photo; a miss, an unsure answer
    // (PHOTO_ID_ESCALATE_BELOW) or a risky runner-up goes to ChatGPT's best
    // vision model, the same OpenAI leg as lawnVisitAssessment. Sequential,
    // no Claude leg (DECISIONS.md 2026-09-26). Honors GEMINI_VISION_MODEL.
    primary: Object.freeze({ provider: PROVIDER.GEMINI, model: process.env.GEMINI_VISION_MODEL || GEMINI_VISION_BEST }),
    fallback: Object.freeze({ provider: PROVIDER.OPENAI, model: OPENAI_FRONTIER }),
  }),
  photoIdPestV2: Object.freeze({
    name: 'photoIdPestV2',
    // The customer app's Photo ID pest engine (photo-id-v2/pest-engine.js)
    // only. Owner 2026-10-01: Gemini's one read answers; OpenAI stands in
    // only when Gemini returns nothing. photoIdVision above keeps the v1
    // surfaces (website funnel, SMS triage, admin) on 3.8 Flash.
    primary: Object.freeze({ provider: PROVIDER.GEMINI, model: GEMINI_PHOTO_ID_PEST }),
    fallback: Object.freeze({ provider: PROVIDER.OPENAI, model: OPENAI_FRONTIER }),
  }),
  photoIdPlantV2: Object.freeze({
    name: 'photoIdPlantV2',
    // The customer app's lawn and tree/shrub/palm Photo ID (plant-engine.js
    // with ladder 'gemini_only') only. Owner 2026-10-02: Gemini's one read
    // answers; OpenAI stands in only when Gemini returns nothing usable.
    // plantIdVision below keeps visit prep on its full ladder.
    primary: Object.freeze({ provider: PROVIDER.GEMINI, model: GEMINI_PHOTO_ID_PLANT }),
    fallback: Object.freeze({ provider: PROVIDER.OPENAI, model: OPENAI_PLANT_ID }),
  }),
  treeShrubWatchSignals: Object.freeze({
    name: 'treeShrubWatchSignals',
    // The Tree & Shrub Fast Complete watch-signal read (tree-shrub-assessment.js
    // readWatchSignals, GATE_TS_WATCH_LIST): one small Gemini read of one photo
    // that returns only watch-list keys, tech-facing, never customer copy. The
    // same legs as photoIdPlantV2 (the nearest one-read plant photo lane, the
    // cheapest vision models already named here): Gemini answers; OpenAI stands
    // in only when Gemini returns nothing usable. No Claude leg.
    primary: Object.freeze({ provider: PROVIDER.GEMINI, model: GEMINI_PHOTO_ID_PLANT }),
    fallback: Object.freeze({ provider: PROVIDER.OPENAI, model: OPENAI_PLANT_ID }),
  }),
  plantIdVision: Object.freeze({
    name: 'plantIdVision',
    // Lawn/tree/shrub/palm photo ID (plant-engine.js). Owner ruling
    // 2026-09-28 — replaces the 09-26 "Gemini -> Astra, no Claude" ruling
    // FOR THE PLANT ENGINE ONLY (the pest engine's photoIdVision above is
    // unchanged): Gemini 3.8 Flash reads the photo; a miss, an unsure answer
    // (PHOTO_ID_ESCALATE_BELOW) or a risky runner-up goes to GPT-6 Sol as the
    // second opinion. Sequential, same GEMINI_VISION_MODEL override as
    // photoIdVision. A scope still unsure after this second opinion may get
    // one more look from Claude Fable 5.1 (ROUTES.plantIdReferee), gated
    // behind GATE_PLANT_ID_REFEREE — not part of this two-provider policy.
    primary: Object.freeze({ provider: PROVIDER.GEMINI, model: process.env.GEMINI_VISION_MODEL || GEMINI_VISION_BEST }),
    fallback: Object.freeze({ provider: PROVIDER.OPENAI, model: OPENAI_PLANT_ID }),
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
  imageScreen: Object.freeze({
    name: 'imageScreen',
    // The blog image text/logo/uniform/van screen (content/hero-alt-vision.js
    // screenGeneratedImage). Sol first, by owner ruling 2026-09-25; Claude
    // VISION answers only when the OpenAI leg misses (owner, same day: "add
    // claude as backup") — it misreads the chest side more often, but a
    // checked image beats one shipped unchecked during an OpenAI outage.
    // The alt-text pass stays on visionAnalysis.
    primary: Object.freeze({ provider: PROVIDER.OPENAI, model: OPENAI_IMAGE_SCREEN }),
    fallback: Object.freeze({ provider: PROVIDER.ANTHROPIC, model: VISION }),
  }),
  voiceJudge: Object.freeze({
    name: 'voiceJudge',
    // Voice relay eval judge: the pinned Claude leg, Sol as the cross-provider
    // backup. A verdict from the fallback leg is stamped judge_fallback and
    // never flips a scenario's pass/fail (services/eval/voice-relay-judge.js).
    primary: Object.freeze({ provider: PROVIDER.ANTHROPIC, model: VOICE_JUDGE }),
    fallback: Object.freeze({ provider: PROVIDER.OPENAI, model: OPENAI_REPORT_WRITER }),
  }),
  newsletterWriter: Object.freeze({
    name: 'newsletterWriter',
    // Owner ruling 2026-09-27: the newsletter is WRITTEN by Opus 5.5 at
    // effort 'max', and community-event curation scoring rides the same
    // model/effort (event-curation.js). `effort` on a route is honored only
    // on the Anthropic leg (services/llm/call.js#dispatch); a caller that
    // needs a lighter interactive path (the admin Compose UI) overrides it
    // per-call rather than moving the whole policy off 'max'.
    primary: Object.freeze({ provider: PROVIDER.ANTHROPIC, model: NEWSLETTER, effort: 'max' }),
    fallback: Object.freeze({ provider: PROVIDER.OPENAI, model: OPENAI_BALANCED }),
  }),
});

module.exports = {
  ANTHROPIC_EFFORT,
  ANTHROPIC_EFFORT_CAPABLE_RE,
  anthropicAcceptsEffort,
  ANTHROPIC_THINKING_FLOOR_RE,
  ANTHROPIC_THINKING_REQUIRED_RE,
  anthropicThinkingAlwaysOn,
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
  VOICE_JUDGE,
  NEWSLETTER,
  // Cross-provider routing (additive — legacy tier exports above are unchanged)
  PROVIDER,
  ROUTES,
  TEXT_POLICIES,
  OPENAI_BEST,
  OPENAI_BALANCED,
  OPENAI_FAST,
  OPENAI_REPORT_WRITER,
  OPENAI_FRONTIER,
  OPENAI_ESTIMATE_VISION,
  OPENAI_IMAGE_SCREEN,
  OPENAI_PLANT_ID,
  OPENAI_LAWN_ASSESSMENT,
  PLANT_ID_REFEREE,
  LAWN_ASSESSMENT_REFEREE,
  ADS_ADVISOR,
  TYPESAFE_JEV,
  CLOUDFLARE_CLEF,
  OPENAI_SMS_DRAFT,
  OPENAI_EMBEDDING,
  EMBEDDING_DIMS,
  SMS_SONNET,
  GEMINI_VISION_BEST,
  GEMINI_PHOTO_ID_PEST,
  GEMINI_PHOTO_ID_PLANT,
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
