/**
 * Request sizing for Anthropic calls that must survive a model flip.
 *
 * Every Anthropic request in the portal — the adapter (call.js), the DEEP
 * helper (deep.js), and each direct SDK site on an Opus tier — sizes its
 * max_tokens and effort through here, so an Opus 5.5 flip (always-on
 * thinking, effort default 'medium') is one env change instead of a hunt.
 *
 * The model-family patterns live in config/models.js (the only place an
 * Anthropic ID shape may appear). They are read at call time, so a test that
 * pins MODELS.ANTHROPIC_EFFORT sees it, and a test that mocks the registry
 * without the patterns gets the caller's request unchanged.
 */
const MODELS = require('../../config/models');

// Thinking spends from the same budget as the reply. 8192 clears the
// thinking a short task does at 'high' effort with room to spare, costs
// nothing unless used (billing is per generated token), and stays far under
// the SDK's non-streaming ceiling (~21k tokens without an explicit timeout).
const THINKING_FLOOR_TOKENS = 8192;

function matches(pattern, model) {
  return pattern instanceof RegExp && pattern.test(String(model || ''));
}

// The wire max_tokens for `model` given the cap the call site sized for its
// reply. Unchanged (including undefined) on models that don't think by
// default; raised to the floor on those that do.
function anthropicMaxTokens(model, cap) {
  if (!matches(MODELS.ANTHROPIC_THINKING_FLOOR_RE, model)) return cap;
  return Math.max(Number(cap) || 0, THINKING_FLOOR_TOKENS);
}

// `requested` (e.g. a per-call effort a caller asks for) wins when the served
// `model` actually accepts that exact level — checked with the registry's own
// anthropicAcceptsEffort, which covers both full-capable models (every level)
// and partial ones (Opus 4.5/4.6's narrower sets) — so a caller never learns
// which model tier is serving the request. Otherwise falls back to the pinned
// MODEL_ANTHROPIC_EFFORT when `model` accepts every level, else undefined —
// the model's own default then applies.
function anthropicEffortFor(model, requested) {
  if (requested && typeof MODELS.anthropicAcceptsEffort === 'function' && MODELS.anthropicAcceptsEffort(model, requested)) {
    return requested;
  }
  const pinned = MODELS.ANTHROPIC_EFFORT;
  return pinned && matches(MODELS.ANTHROPIC_EFFORT_CAPABLE_RE, model) ? pinned : undefined;
}

// Spread form for direct SDK sites that build their own request:
// `...anthropicEffortConfig(MODELS.VISION)` adds `output_config: { effort }`
// when pinned and applicable, nothing otherwise. `requested` is the same
// per-call override anthropicEffortFor takes.
function anthropicEffortConfig(model, requested) {
  const effort = anthropicEffortFor(model, requested);
  return effort ? { output_config: { effort } } : {};
}

module.exports = { anthropicMaxTokens, anthropicEffortFor, anthropicEffortConfig, THINKING_FLOOR_TOKENS };
