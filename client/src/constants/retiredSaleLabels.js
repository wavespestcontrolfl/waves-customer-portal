// Client mirror of server/services/pricing-engine/retired-sale-catalog.js's
// free-text label matcher (the three regexes are pinned byte-for-byte by
// server/tests/retired-sale-catalog.test.js). It answers one question for a
// selector built from a customer's OWN history: does this label name a plan
// retired for new sales (quarterly / Light Tree & Shrub)? The server's write
// gates stay authoritative; this only keeps a selector from offering a choice
// the save refuses for a customer who is not on that plan (codex r30 on
// #4786).
const TREE_SHRUB_LABEL_RE = /\btrees?\s*(?:&|and|\+|\/)?\s*shrubs?\b|\bt\s*&\s*s\b|\bornamentals?\b/i;
const QUARTERLY_CADENCE_RE = /\bquarterly\b|\b(?:4|four)[\s-]*(?:x|visits?|applications?)\b|\bevery\s+(?:3|three)\s+months?\b|\bevery\s+(?:8[4-9]|9[0-7])\s+days?\b/i;
const LIGHT_TIER_RE = /\blight\b/i;

// The catalog keys retired for new sales (server RETIRED_SALE_SERVICE_KEYS,
// pinned by the same test).
export const RETIRED_SALE_SERVICE_KEYS = new Set(['tree_shrub_quarterly']);

export function labelNamesRetiredSale(text) {
  if (typeof text !== "string" || !text.trim()) return false;
  return TREE_SHRUB_LABEL_RE.test(text) && (QUARTERLY_CADENCE_RE.test(text) || LIGHT_TIER_RE.test(text));
}

export const RETIRED_SALE_LABEL_PATTERNS = { TREE_SHRUB_LABEL_RE, QUARTERLY_CADENCE_RE, LIGHT_TIER_RE };
