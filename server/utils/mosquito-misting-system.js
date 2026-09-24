/**
 * isMistingSystemService — the ONE place that decides "is this the
 * automatic mosquito misting SYSTEM (mosquito_misting_system: design visit,
 * install, monthly/quarterly maintenance — wiki/protocols/mosquito-misting-
 * systems.md), not the barrier PROGRAM?"
 *
 * Three separate call sites each grew their own copy of this check (Codex
 * P1s on PR #4762's follow-up rounds: estimate-ai-context.js's repo-context
 * loader, protocol-matcher.js's matchServiceProtocol, job-card.js's
 * addonProgramKey) and each one risked drifting from the others — this
 * module is the single source of truth every caller imports instead.
 *
 * Scoped deliberately narrow: only the explicit catalog key
 * (`mosquito_misting_system`) or the two-word phrase "misting system(s)"
 * matches. Bare "misting" — the barrier program's own "21-day misting"
 * cycle-length copy — and the plain word "mosquito" must NOT match, or a
 * barrier customer's ordinary question would get routed to the misting-
 * system's consultation copy/protocol instead of their own barrier program.
 */

const MISTING_SYSTEM_SERVICE_KEY = 'mosquito_misting_system';
const MISTING_SYSTEM_NAME_PATTERN = /\bmisting\s+systems?\b/i;

/**
 * @param {object} input
 * @param {string} [input.serviceKey] - a catalog service_key to check verbatim.
 * @param {string} [input.name] - a service/display name to check for the phrase.
 * @param {string} [input.text] - any other free text (a question, a snippet,
 *   a search term) to check for the phrase.
 * @returns {boolean}
 */
function isMistingSystemService({ serviceKey, name, text } = {}) {
  if (serviceKey && String(serviceKey).trim().toLowerCase() === MISTING_SYSTEM_SERVICE_KEY) return true;
  return [name, text].some((value) => value != null && MISTING_SYSTEM_NAME_PATTERN.test(String(value)));
}

module.exports = {
  MISTING_SYSTEM_SERVICE_KEY,
  MISTING_SYSTEM_NAME_PATTERN,
  isMistingSystemService,
};
