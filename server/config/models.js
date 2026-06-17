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
 * NOTE: the cross-provider "best-model" routing (OpenAI GPT-5.5 / Gemini 3.5
 * Flash for parts of the stack) is owner-in-progress and NOT live — those
 * models are intentionally absent here until they ship.
 */

const FLAGSHIP  = process.env.MODEL_FLAGSHIP  || 'claude-opus-4-8';
const WORKHORSE = process.env.MODEL_WORKHORSE || 'claude-opus-4-8';
const FAST      = process.env.MODEL_FAST      || 'claude-opus-4-8';
const VOICE     = process.env.MODEL_VOICE     || 'claude-sonnet-4-6';
const VISION    = process.env.MODEL_VISION    || 'claude-sonnet-4-6';

module.exports = {
  FLAGSHIP,
  WORKHORSE,
  FAST,
  VOICE,
  VISION,
  // Backwards-compatible default export for quick imports
  DEFAULT: FLAGSHIP,
};
