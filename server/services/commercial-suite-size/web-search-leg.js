/**
 * Web-search leg for commercial suite sizing — DISPLAY ONLY. Finds the
 * business name (and a rough business type) occupying a suite, for the
 * operator's notes; it is never a size source. AGENTS.md: an LLM proposes
 * intent, it never reaches a price/size field — a model-reported square
 * footage from a page we never fetched ourselves has no place pricing a
 * customer's bill. The sizing ladder is caller/tech-stated -> DBPR license
 * seats (dbpr-food-license.js, a real public record) -> a business-type-
 * keyed default (type-defaults.js, commercialRiskType/commercialSubtype
 * only — never this leg's businessType guess).
 *
 * Routed through the shared LLM dispatcher (server/services/llm/call.js
 * callAnthropic) rather than the SDK directly, per .claude/skills/waves-llm
 * — this call is Anthropic-only (the web_search tool has no cross-provider
 * equivalent), so it stays outside the ROUTES/dispatchWithFallback cross-
 * provider machinery, but the shared helper still gives it consistent
 * timeout/ledger/thinking-block handling instead of a hand-rolled SDK call.
 */

const MODELS = require('../../config/models');
const { callAnthropic, parseLooseJson } = require('../llm/call');

// Bounded well under the fresh lookup's own budget: with a cold DBPR
// download (15s, once a day) this leg adds at most ~35s.
const DEFAULT_TIMEOUT_MS = 20000;
const DEFAULT_MAX_SEARCHES = 5;

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

// Env kill switch — default ON. Any of '0' / 'false' / 'off' disables the
// leg (tests inject a stub client instead of flipping this in prod).
function webSearchLegEnabled() {
  const v = String(process.env.COMMERCIAL_SUITE_WEB_SEARCH ?? '').trim().toLowerCase();
  if (!v) return true;
  return !['0', 'false', 'off'].includes(v);
}

function formatAddress(address = {}) {
  return [address.street, address.unit ? `Unit ${address.unit}` : null, address.city, 'FL', address.zip]
    .filter(Boolean).join(', ');
}

function buildPrompt({ address, businessNameHint }) {
  const addressLine = formatAddress(address);
  const hint = businessNameHint ? `\nPossible business name: ${businessNameHint}\n` : '';
  return `What business occupies the suite/unit at this address?

Address: ${addressLine}
${hint}
This is one tenant space inside a multi-tenant building (shopping plaza, strip center, office park, or similar).

Respond with ONLY a JSON object — no preamble, no markdown fences:
{"businessName": "<name of the business at this suite, or null>", "businessType": "<short type, e.g. 'restaurant', 'retail', 'salon', 'medical office', or null>"}

Only report a name/type you are confident occupies THIS suite. If you cannot find it, return both fields null.`;
}

/**
 * Accept/reject the parsed model output. Exported separately so it is
 * directly unit-testable without a live model call.
 */
function acceptWebSearchResult(json) {
  if (!json || typeof json !== 'object') return null;
  const businessName = typeof json.businessName === 'string' && json.businessName.trim()
    ? json.businessName.trim() : null;
  const businessType = typeof json.businessType === 'string' && json.businessType.trim()
    ? json.businessType.trim() : null;
  return (businessName || businessType) ? { businessName, businessType } : null;
}

/**
 * @returns {Promise<{businessName:string|null, businessType:string|null}|null>}
 *   Never a size — see the module doc.
 */
// The LAST text block of a tool-using reply (the answer after any searches),
// falling back to the helper's own text when no raw response rides along.
function finalTextBlock(result) {
  const blocks = (result?.response?.content || [])
    .filter((b) => b && (b.type === 'text' || b.type == null) && typeof b.text === 'string');
  return blocks.length ? blocks[blocks.length - 1].text : (result?.text || '');
}

async function resolveViaWebSearch({ address = {}, businessNameHint = null } = {}, opts = {}) {
  if (!webSearchLegEnabled()) return null;
  if (!address || !address.street) return null;

  const timeoutMs = positiveInt(opts.timeoutMs, DEFAULT_TIMEOUT_MS);
  const maxSearches = positiveInt(opts.maxSearches, DEFAULT_MAX_SEARCHES);

  const result = await callAnthropic({
    model: MODELS.WORKHORSE,
    // 8192, not 1536/1024: WORKHORSE resolves to models with adaptive
    // thinking on by default, and max_tokens caps thinking + text TOGETHER.
    // ai-property-lookup.js's lookupPropertyFromAI hit exactly this trap
    // ("no text block in response" at 1536 across 5 web searches, live
    // 2026-07-27) — 8192 leaves room for the thinking spend.
    maxTokens: 8192,
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: maxSearches }],
    text: buildPrompt({ address, businessNameHint }),
    timeoutMs,
    anthropicClient: opts.anthropicClient,
    laneId: 'commercial_suite_business_name',
    policyLabel: 'commercial_suite_business_name',
    // Plain text, parsed below: a web-search reply can open with a text
    // preamble before its searches and put the JSON in a LATER block, while
    // the helper's JSON mode reads only the first text block.
    jsonMode: false,
  });
  if (!result.ok) return null;
  return acceptWebSearchResult(parseLooseJson(finalTextBlock(result)));
}

module.exports = {
  webSearchLegEnabled,
  buildPrompt,
  acceptWebSearchResult,
  resolveViaWebSearch,
};
