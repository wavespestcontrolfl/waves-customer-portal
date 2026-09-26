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

// Bounded well under the fresh lookup's own budget: with a cold DBPR
// download (15s, once a day) the suite leg adds at most ~35s.
const DEFAULT_TIMEOUT_MS = 20000;
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

// The old check accepted ANY bare "suite"/"unit"/"space" word anywhere in
// the quote — "40,000 sq ft of retail space" (naming no suite at all) or a
// quote naming a DIFFERENT suite both passed, and the building-share cap
// only helps when buildingSqft happens to be known (the engine can pass
// null). The fix requires the quote to bind the number to the ACTUAL target
// unit: a suite token immediately adjacent to that exact number, in either
// order ("Suite 102", "Ste. #102", "102 Suite"). When no target unit is
// known at all, this leg accepts no sqft — a bare building-wide phrase can
// never stand in for "the suite this address names".
// address.unit (address-normalizer.js splitStreetLineUnitParts) carries the
// designator too — "#102", "Suite 102", "Unit 102" — never a bare number.
// Strip a leading designator so the regex binds to the actual unit token
// ("102"), matching how dbpr-food-license.js's normalizeUnitValue compares.
function extractUnitToken(unit) {
  const raw = String(unit || '').trim();
  if (!raw) return '';
  return raw.replace(/^(?:suite|ste\.?|unit|apt\.?|apartment|bldg\.?|building|bay|space|#)\s*#?\s*/i, '').trim();
}

function unitBoundSuiteRegex(unit) {
  const num = extractUnitToken(unit);
  if (!num) return null;
  const esc = num.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const token = '(?:suite|ste\\.?|unit|bay|space|#)';
  return new RegExp(`(?:\\b${token}\\.?\\s*#?\\s*${esc}\\b|\\b${esc}\\s*${token}\\b)`, 'i');
}

// Commercial listing marketplaces and public-records hosts. A business's
// own site or a directory is not a size source.
const LISTING_HOSTS = ['loopnet.com', 'crexi.com', 'commercialcafe.com', 'showcase.com', 'cityfeet.com', 'costar.com', 'officespace.com', 'commercialsearch.com'];

function trustedListingUrl(url) {
  if (!url) return false;
  let host;
  try { host = new URL(url).hostname.toLowerCase(); } catch { return false; }
  if (host.endsWith('.gov')) return true;
  return LISTING_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

function quoteStatesNumber(quote, value) {
  const want = String(Math.round(Number(value)));
  const numbers = String(quote || '').match(/\d[\d,]*(?:\.\d+)?/g) || [];
  return numbers.some((n) => String(Math.round(Number(n.replace(/,/g, '')))) === want);
}

/**
 * Accept/reject the parsed model output. Exported separately so the
 * acceptance rules (the part that actually protects against an overquote)
 * are directly unit-testable without a live model call.
 */
function acceptWebSearchResult(parsed, { buildingSqft, unit } = {}) {
  if (!parsed || typeof parsed !== 'object') return null;
  const businessName = typeof parsed.businessName === 'string' && parsed.businessName.trim()
    ? parsed.businessName.trim() : null;
  const businessType = typeof parsed.businessType === 'string' && parsed.businessType.trim()
    ? parsed.businessType.trim() : null;
  const suiteSqft = Number(parsed.suiteSqft);
  const quote = typeof parsed.suiteSqftQuote === 'string' ? parsed.suiteSqftQuote : '';
  const url = typeof parsed.suiteSqftUrl === 'string' && parsed.suiteSqftUrl.trim() ? parsed.suiteSqftUrl.trim() : null;

  const buildingCap = Number(buildingSqft) > 0 ? Number(buildingSqft) * MAX_BUILDING_SHARE : null;
  const suiteRe = unitBoundSuiteRegex(unit);
  const usable = Number.isFinite(suiteSqft)
    && suiteSqft >= MIN_ACCEPTABLE_SQFT
    && suiteSqft <= MAX_ACCEPTABLE_SQFT
    && suiteRe != null
    && suiteRe.test(quote)
    // The quote must actually state the number it claims (digits compared
    // with separators stripped, so "1,450 SF" backs 1450).
    && quoteStatesNumber(quote, suiteSqft)
    // The quote is model-reported; a source URL on a listing or government
    // records site at least ties it to a page the operator can open.
    && trustedListingUrl(url)
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
    return acceptWebSearchResult(parsed, { buildingSqft, unit: address.unit });
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
