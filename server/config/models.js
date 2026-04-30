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
 *  FLAGSHIP   — Best reasoning. Admin Intelligence Bar, advisors, analysis.
 *  WORKHORSE  — Balanced drafting + conversation. SMS, voice, content.
 *  FAST       — Cheapest high-volume. Classification, tagging, signals.
 *  VISION     — Image scoring where deterministic output matters more than
 *               raw capability. Defaults to Sonnet 4.6 because Opus 4.7
 *               removed the temperature parameter; Sonnet still accepts
 *               temperature so we can pin Claude to 0.2 to match Gemini.
 *
 * Per owner request (2026-04-17): the three reasoning tiers default to
 * Opus 4.7. If cost becomes an issue, drop FAST and/or WORKHORSE via
 * env vars — no code change required.
 */

const FLAGSHIP  = process.env.MODEL_FLAGSHIP  || 'claude-opus-4-7';
const WORKHORSE = process.env.MODEL_WORKHORSE || 'claude-opus-4-7';
const FAST      = process.env.MODEL_FAST      || 'claude-opus-4-7';
const VISION    = process.env.MODEL_VISION    || 'claude-sonnet-4-6';

module.exports = {
  FLAGSHIP,
  WORKHORSE,
  FAST,
  VISION,
  // Backwards-compatible default export for quick imports
  DEFAULT: FLAGSHIP,
};
