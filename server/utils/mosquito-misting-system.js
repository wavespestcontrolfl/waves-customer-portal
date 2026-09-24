/**
 * The mosquito misting SYSTEM's identity checks — the ONE place that
 * decides "is this the automatic misting system, not the barrier PROGRAM?"
 * and, separately, "should a booking of this identity get NO chemical
 * protocol?" Several call sites each grew their own copy of these checks
 * (Codex P1s on PR #4762's follow-up rounds: estimate-ai-context.js's
 * repo-context loader and estimate-assistant.js's fallback routing on one
 * side, protocol-matcher.js's matchServiceProtocol and job-card.js's
 * addonProgramKey on the other) and drifted from each other — this module
 * is the single source of truth every caller imports instead.
 *
 * Today there is exactly ONE misting-system catalog row/identity:
 * `mosquito_misting_system` (the lead-only design visit — migration
 * 20260924000020, wiki/protocols/mosquito-misting-systems.md covers
 * design, install, and monthly/quarterly maintenance as ONE program run by
 * Waves). Two predicates, deliberately different scopes:
 *
 * - `isMistingSystemService` — "is this about the misting system AT ALL"
 *   (design, install, or maintenance)? Broad on purpose: used to route a
 *   CUSTOMER's question or repo-context lookup to misting-system material
 *   instead of the barrier program's, regardless of which phase of the
 *   product the question is about.
 * - `isMistingDesignConsultation` — "should this booking get NO chemical
 *   protocol, because it is (or reads as) the free design-visit identity"?
 *   Narrower and KEY-FIRST: a present serviceKey decides it alone — only
 *   the exact `mosquito_misting_system` key qualifies, so a FUTURE distinct
 *   catalog row (e.g. `mosquito_misting_install` /
 *   `mosquito_misting_maintenance`) is never silently swept in by name
 *   matching just because it shares "misting system" in its display name.
 *   Only when NO serviceKey is present (a legacy or manually-typed row) does
 *   the name phrase apply — and even then, only when the name does NOT also
 *   read as a distinct install/maintenance/refill identity (see
 *   `isMistingSystemServiceUnconfigured` below).
 * - `isMistingSystemServiceUnconfigured` — a KEYLESS row whose name clearly
 *   names a different phase of the product ("Mosquito Misting System
 *   Install", "… Maintenance", "… Refill") rather than the plain design
 *   identity. There is no live protocols.json program or MATCH_RULES entry
 *   for install/maintenance work (pricing and the install product set are
 *   owner-pending — do not invent one here), so this is neither the design
 *   consultation NOR a barrier match: callers return their own "no
 *   protocol"/"no match" outcome for it (protocol-matcher.js's
 *   `misting_system_service_unconfigured` reason; job-card.js's normal
 *   null-program "no treatment protocol" note) rather than showing barrier
 *   steps. NOTE: bare "Service" is deliberately NOT treated as a
 *   disqualifying qualifier — it is the generic suffix this catalog uses on
 *   every service name (including the current design row's own literal
 *   name, "Mosquito Misting System Service"), not a signal of a distinct
 *   product phase.
 *
 * When a real `mosquito_misting_install` / `mosquito_misting_maintenance`
 * (or similar) catalog key is actually created, it needs its OWN
 * protocols.json program and MATCH_RULES/ADDON_PROGRAMS wiring at that
 * time — it must NOT be pointed at this module's design-consultation
 * suppression, which is specific to the free design-visit identity.
 *
 * Bare "misting" — the barrier program's own "21-day misting" cycle-length
 * copy — and the plain word "mosquito" must NEVER match any predicate here,
 * or an ordinary barrier customer's question would be routed to the
 * misting-system's copy/protocol instead of their own barrier program.
 */

const MISTING_SYSTEM_SERVICE_KEY = 'mosquito_misting_system';
const MISTING_SYSTEM_NAME_PATTERN = /\bmisting\s+systems?\b/i;
// Words that mark a keyless name as a DIFFERENT phase of the product
// (install/maintenance/refill), not the plain design-visit identity. Bare
// "service" is excluded on purpose — see the module comment above.
const MISTING_SYSTEM_SUBTYPE_QUALIFIER_PATTERN = /\b(install(?:ation|ed|s)?|maint(?:ain\w*|enance)|refill\w*|repair\w*)\b/i;

function normalizeServiceKey(serviceKey) {
  return serviceKey ? String(serviceKey).trim().toLowerCase() : '';
}

function matchesMistingSystemName(...values) {
  return values.some((value) => value != null && MISTING_SYSTEM_NAME_PATTERN.test(String(value)));
}

/**
 * Is this about the misting SYSTEM at all (any phase — design, install, or
 * maintenance)? Broad: used for customer-facing routing (AI repo context,
 * the estimate assistant's fallback), never for suppressing a chemical
 * protocol — use `isMistingDesignConsultation` for that.
 *
 * @param {object} input
 * @param {string} [input.serviceKey] - a catalog service_key to check verbatim.
 * @param {string} [input.name] - a service/display name to check for the phrase.
 * @param {string} [input.text] - any other free text (a question, a snippet,
 *   a search term) to check for the phrase.
 * @returns {boolean}
 */
function isMistingSystemService({ serviceKey, name, text } = {}) {
  if (normalizeServiceKey(serviceKey) === MISTING_SYSTEM_SERVICE_KEY) return true;
  return matchesMistingSystemName(name, text);
}

/**
 * Should this booking get NO chemical protocol because it is the free
 * design-visit identity? Key-first: a present serviceKey decides it alone
 * (only the exact `mosquito_misting_system` key qualifies — a different,
 * future key never does, regardless of its name). Only a KEYLESS row falls
 * back to the name phrase, and only when the name doesn't also read as a
 * distinct install/maintenance/refill identity (see
 * `isMistingSystemServiceUnconfigured`).
 *
 * @param {object} input
 * @param {string} [input.serviceKey]
 * @param {string} [input.name]
 * @returns {boolean}
 */
function isMistingDesignConsultation({ serviceKey, name } = {}) {
  const key = normalizeServiceKey(serviceKey);
  if (key) return key === MISTING_SYSTEM_SERVICE_KEY;
  return matchesMistingSystemName(name) && !MISTING_SYSTEM_SUBTYPE_QUALIFIER_PATTERN.test(String(name || ''));
}

/**
 * A KEYLESS row whose name reads as a different, not-yet-built phase of the
 * misting system (install/maintenance/refill) — neither the design
 * consultation nor a barrier match. Callers should treat this as "no
 * protocol" through their own normal no-match path (never barrier steps),
 * since there is no live program for it yet.
 *
 * @param {object} input
 * @param {string} [input.serviceKey]
 * @param {string} [input.name]
 * @returns {boolean}
 */
function isMistingSystemServiceUnconfigured({ serviceKey, name } = {}) {
  if (normalizeServiceKey(serviceKey)) return false;
  return matchesMistingSystemName(name) && MISTING_SYSTEM_SUBTYPE_QUALIFIER_PATTERN.test(String(name || ''));
}

module.exports = {
  MISTING_SYSTEM_SERVICE_KEY,
  MISTING_SYSTEM_NAME_PATTERN,
  isMistingSystemService,
  isMistingDesignConsultation,
  isMistingSystemServiceUnconfigured,
};
