/**
 * Web-search leg for commercial suite sizing — mirrors the pattern in
 * services/property-lookup/ai-property-lookup.js (lookupStoriesEvidenceFromAI):
 * a bounded Claude call with the web_search tool, strict JSON output, never
 * throws.
 *
 * Looks up the leasable square footage of ONE suite inside a multi-tenant
 * building (LoopNet, Crexi, CommercialCafe, county commercial-condo records,
 * the business's own site) — never the whole building. Accepted only when
 * the quote plausibly names the suite/unit and the value is not a
 * whole-building total masquerading as a suite figure.
 */

const logger = require('../logger');
const MODELS = require('../../config/models');

const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_MAX_SEARCHES = 5;
const MIN_ACCEPTABLE_SQFT = 300;
const MAX_ACCEPTABLE_SQFT = 20000;
// A suite figure that is more than half the known building size is almost
// certainly the whole-building total misread as the suite — reject rather
// than overquote (mirrors the >3x county-vs-caller sanity check in
// source-arbitration.js).
const MAX_BUILDING_SHARE = 0.5;

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

function buildPrompt({ address, businessNameHint, buildingSqft, commercialRiskType, commercialSubtype }) {
  const addressLine = formatAddress(address);
  const hints = [];
  if (businessNameHint) hints.push(`Possible business name: ${businessNameHint}`);
  if (commercialRiskType) hints.push(`Business type: ${commercialRiskType}`);
  if (commercialSubtype) hints.push(`Property subtype: ${commercialSubtype}`);
  if (Number(buildingSqft) > 0) hints.push(`The WHOLE BUILDING is approximately ${Number(buildingSqft).toLocaleString()} sq ft — do not report that as the suite size.`);
  const hintsBlock = hints.length ? `\nKnown facts:\n${hints.map((h) => `- ${h}`).join('\n')}\n` : '';

  return `What business occupies the suite/unit at this address, and how many square feet does THAT SUITE (not the whole building) lease?

Address: ${addressLine}
${hintsBlock}
This is one tenant space inside a multi-tenant building (shopping plaza, strip center, office park, or similar) — the goal is the LEASABLE AREA OF THIS ONE SUITE, never the building total.

Search aggressively, in this order:
1. Commercial listing sites — loopnet.com, crexi.com, commercialcafe.com, commercialedge.com — for a "for lease" or "sold" listing naming this suite number and its square footage.
2. County commercial-condo / unit-level property records, if the suite is individually platted.
3. The business's own website (About/Contact/press) if it states its space size.
4. Local news or permit records mentioning a buildout square footage for this address.

Respond with ONLY a JSON object — no preamble, no markdown fences:
{"businessName": "<name of the business at this suite, or null>", "businessType": "<short type, e.g. 'restaurant', 'retail', 'salon', 'medical office', or null>", "suiteSqft": <integer sq ft of THIS SUITE, or null>, "suiteSqftQuote": "<the exact sentence/phrase that named the suite and its size, or empty string>", "suiteSqftUrl": "<source URL, or null>"}

Only report suiteSqft when a source clearly ties the number to THIS suite/unit — never a building or shopping-center total. If you cannot find a suite-specific figure, return suiteSqft: null (still report businessName/businessType if you found them).`;
}

function parseJson(text) {
  const cleaned = String(text || '').replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

// Loose "this mentions a suite/unit" check on the model's own quoted
// sentence — a quote that never names a suite/unit is a building total by
// construction, whatever number the model attached to it.
const SUITE_MENTION_RE = /\b(suite|ste\.?|unit|space)\b/i;

/**
 * Accept/reject the parsed model output. Exported separately so the
 * acceptance rules (the part that actually protects against an overquote)
 * are directly unit-testable without a live model call.
 */
function acceptWebSearchResult(parsed, { buildingSqft } = {}) {
  if (!parsed || typeof parsed !== 'object') return null;
  const businessName = typeof parsed.businessName === 'string' && parsed.businessName.trim()
    ? parsed.businessName.trim() : null;
  const businessType = typeof parsed.businessType === 'string' && parsed.businessType.trim()
    ? parsed.businessType.trim() : null;
  const suiteSqft = Number(parsed.suiteSqft);
  const quote = typeof parsed.suiteSqftQuote === 'string' ? parsed.suiteSqftQuote : '';
  const url = typeof parsed.suiteSqftUrl === 'string' && parsed.suiteSqftUrl.trim() ? parsed.suiteSqftUrl.trim() : null;

  const buildingCap = Number(buildingSqft) > 0 ? Number(buildingSqft) * MAX_BUILDING_SHARE : null;
  const usable = Number.isFinite(suiteSqft)
    && suiteSqft >= MIN_ACCEPTABLE_SQFT
    && suiteSqft <= MAX_ACCEPTABLE_SQFT
    && SUITE_MENTION_RE.test(quote)
    && (buildingCap == null || suiteSqft <= buildingCap);

  if (!usable) {
    // businessName/businessType are still useful even without a sized
    // suite — the caller threads them through to the type-default leg and
    // (for a food business) the commercial_risk_type inference.
    return (businessName || businessType) ? { value: null, businessName, businessType } : null;
  }

  return {
    value: Math.round(suiteSqft),
    businessName,
    businessType,
    evidence: [{
      source: 'commercial_listing',
      detail: quote || `${suiteSqft.toLocaleString()} sq ft per commercial listing`,
      ...(url ? { url } : {}),
    }],
  };
}

async function resolveViaWebSearch({
  address = {}, businessNameHint = null, buildingSqft = null,
  commercialRiskType = null, commercialSubtype = null,
} = {}, opts = {}) {
  if (!webSearchLegEnabled()) return null;
  if (!opts.anthropicClient && !process.env.ANTHROPIC_API_KEY) {
    logger.info('[commercial-suite-size] web-search leg skipped — ANTHROPIC_API_KEY not set');
    return null;
  }
  if (!address || !address.street) return null;

  const timeoutMs = positiveInt(opts.timeoutMs, DEFAULT_TIMEOUT_MS);
  const maxSearches = positiveInt(opts.maxSearches, DEFAULT_MAX_SEARCHES);

  try {
    let client = opts.anthropicClient;
    if (!client) {
      // Lazy-require so module load doesn't depend on the SDK in test contexts.
      const Anthropic = require('@anthropic-ai/sdk');
      client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 0 });
    }
    const resp = await client.messages.create({
      model: MODELS.WORKHORSE,
      max_tokens: 1024,
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: maxSearches }],
      messages: [{
        role: 'user',
        content: buildPrompt({ address, businessNameHint, buildingSqft, commercialRiskType, commercialSubtype }),
      }],
    }, { timeout: timeoutMs });

    const textBlock = (resp.content || []).filter((b) => b.type === 'text').pop();
    if (!textBlock?.text) return null;
    const parsed = parseJson(textBlock.text);
    if (!parsed) return null;
    return acceptWebSearchResult(parsed, { buildingSqft });
  } catch (err) {
    logger.warn(`[commercial-suite-size] web-search leg failed: ${err.message}`);
    return null;
  }
}

module.exports = {
  webSearchLegEnabled,
  buildPrompt,
  parseJson,
  acceptWebSearchResult,
  resolveViaWebSearch,
};
