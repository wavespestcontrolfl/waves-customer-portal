// Single chokepoint for "is this a NEW sale of something the owner retired?"
// (codex round 2 pre-push, 2026-09-24, PR #4786: "one more surface still
// sells Light" — the first round fixed this one surface at a time across
// estimate-public.js, property-lookup-v2.js, customer-pricing-ai.js,
// public-services-menu.js, public-quote.js, and public-mcp.js; round 2 found
// two MORE surfaces — the Intelligence Bar agent estimate tools and the
// social-content-studio campaign-context builder — plus a P0 gap in the
// round-1 cadence-text matcher. This module exists so a THIRD surface never
// needs its own bespoke copy of the same check).
//
// Two distinct, deliberately separate concerns:
//
//   RETIRED_SALE_SERVICE_KEYS — catalog `service_key`s that must never be
//   offered, advertised, or created as a NEW sale, full stop. Distinct from
//   `services/public-services-menu.js`'s FORMERLY_PUBLIC_KEYS, which is
//   about "left the public QUOTE MENU" (a much broader compatibility set —
//   foam_drill, termite_pretreatment, the rodent one-time keys, etc. — rows
//   that are still perfectly bookable/customer-visible, just not on the
//   public quote-to-calculate menu). Conflating the two hid real, live
//   services from the public MCP catalog (codex P1 round 2). Every new-sale
//   boundary that needs "don't sell/advertise this exact retired product"
//   (public MCP catalog, social campaign context, lead/booking tools) reads
//   THIS set, never FORMERLY_PUBLIC_KEYS.
//
//   isRetiredTreeShrubTier(tier) — is a Tree & Shrub TIER KEY (as opposed to
//   a catalog service_key) retired for new sales? Mirrors
//   TREE_SHRUB.tiers[key].hidden (light, 2026-09-24) plus the legacy
//   'premium' alias (12x, fully removed from TREE_SHRUB.tiers — never
//   resurrected, so it can't carry a `hidden` flag and must be named
//   explicitly). Every new-sale boundary that accepts a CALLER-CONTROLLED
//   `treeShrub.tier` value should reject a non-sellable tier for a NEW
//   quote/draft — property-lookup-v2.js, public-quote.js, and the
//   Intelligence Bar agent estimate tools all do, reading the POSITIVE
//   isSellableTreeShrubTier below (codex P1 round 3: the negative form here
//   wrongly passes a malformed/hallucinated tier value that was never
//   actually retired, e.g. 'gold'). customer-pricing-ai.js's tree_shrub
//   variant ladder is closed-enum by construction instead (only
//   'standard'/'enhanced' entries exist in its own candidate array — 'light'
//   was dropped from the array itself in round 1, so there is no runtime
//   value to check). The voice-agent relay files (Sandy's get_pricing tool)
//   never forward a caller-supplied tier for tree_shrub AT ALL — the handler
//   hardcodes `{ access: 'easy' }` with no tier field, so the engine's own
//   TREE_SHRUB.defaultTier always resolves it; verified codex P1 round 4 —
//   there is nothing there for this module to gate unless a future change
//   adds a tier parameter to that tool, at which point it must read this
//   module too. It is deliberately NOT applied inside `priceTreeShrub`
//   itself, or the scheduling/converter/seeder readers of an ALREADY
//   selected or stored cadence (estimate-converter.js,
//   self-booking-plan-sync.js, slot-reservation.js) — those must keep
//   pricing/reading tier:'light' correctly for the one grandfathered
//   quarterly customer's existing plan on replay.
//
// Both sets are intentionally tiny and named explicitly rather than derived
// from a broader flag (e.g. `!public_quote_selectable`) — see the PR body /
// round-2 review thread for why a flag-derived set risks hiding an
// unrelated, still-fully-sold service that merely isn't on the public quote
// menu for its own reasons.

const { TREE_SHRUB } = require('./constants');

const RETIRED_SALE_SERVICE_KEYS = new Set(['tree_shrub_quarterly']);

// 'premium' (12x T&S) was fully removed from TREE_SHRUB.tiers well before
// the 2026-09-24 Light retirement — it never carried (and can never carry)
// a `hidden` flag, so it must be named here explicitly, the same way
// estimate-public.js's REMOVED_LAWN_TIER_KEYS names lawn's fully-removed
// 'basic'.
const REMOVED_TREE_SHRUB_TIER_ALIASES = new Set(['premium']);

// STRING-only: a non-string tier (array, object, number, boolean, ...) is
// never a valid tier key, full stop — it must fall through to "not
// sellable" without `String()`-coercing into an accidental match (a
// single-element array like ['standard'] stringifies to the bare string
// "standard", which would otherwise slip past a naive lowercase compare).
function normalizedTierKey(tier) {
  return typeof tier === 'string' ? tier.trim().toLowerCase() : '';
}

// OWN entries only: 'constructor' / '__proto__' resolve to inherited
// properties of the plain tiers object and must never read as a tier
// (codex P0 r8 — they reached priceTreeShrub and priced NaN).
function ownTier(key) {
  const tiers = TREE_SHRUB?.tiers;
  return tiers && Object.prototype.hasOwnProperty.call(tiers, key) ? tiers[key] : null;
}

function isRetiredTreeShrubTier(tier) {
  const key = normalizedTierKey(tier);
  if (!key) return false;
  if (REMOVED_TREE_SHRUB_TIER_ALIASES.has(key)) return true;
  return ownTier(key)?.hidden === true;
}

// Positive form for a boundary that must accept ONLY a currently-sold tier
// (property-lookup-v2.js's builder input, public-quote.js's unkeyed
// /calculate) — `!isRetiredTreeShrubTier(tier)` is NOT the right check
// there: it also returns true for a garbage value like 'gold' (never
// retired because it was never a tier at all), which would wrongly pass
// validation. isSellableTreeShrubTier requires the key to be BOTH a real
// TREE_SHRUB.tiers entry AND not hidden — true only for 'standard'/
// 'enhanced' today.
function isSellableTreeShrubTier(tier) {
  const key = normalizedTierKey(tier);
  const entry = key ? ownTier(key) : null;
  return !!(entry && !entry.hidden);
}

// Free-text labels that name a retired row without its exact catalog name
// ("Quarterly Tree & Shrub", "T&S 4x", "tree and shrub - quarterly", the
// catalog short name "Tree & Shrub (Light)", "four applications", a
// structured cadence rendered as "quarterly" / "every 90 days" — codex r16/
// r20 on #4786), keyed by the retired service_key they mean. Used by the
// shared booking gate (service-library retiredServicesNotHeldBy) for
// id-less writes.
// "Ornamental" is the Tree & Shrub family everywhere else the portal maps
// free text to a catalog row (admin-customers serviceCatalogMatch) — codex
// r21 on #4786.
const TREE_SHRUB_LABEL_RE = /\btree\s*(?:&|and|\+|\/)?\s*shrubs?\b|\bt\s*&\s*s\b|\bornamentals?\b/i;
const QUARTERLY_CADENCE_RE = /\bquarterly\b|\b(?:4|four)[\s-]*(?:x|visits?|applications?)\b|\bevery\s+(?:3|three)\s+months?\b|\bevery\s+(?:8[4-9]|9[0-7])\s+days?\b/i;
// The retired tier's own name: the catalog row is short-named
// "Tree & Shrub (Light)" (20260718300000_tree_shrub_quarterly_catalog.js).
const LIGHT_TIER_RE = /\blight\b/i;
const RETIRED_SALE_LABEL_MATCHERS = {
  tree_shrub_quarterly: (text) => TREE_SHRUB_LABEL_RE.test(text) && (QUARTERLY_CADENCE_RE.test(text) || LIGHT_TIER_RE.test(text)),
};

function retiredSaleKeyForLabel(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  for (const [key, matches] of Object.entries(RETIRED_SALE_LABEL_MATCHERS)) {
    if (RETIRED_SALE_SERVICE_KEYS.has(key) && matches(text)) return key;
  }
  return null;
}

// Cheap pre-check before a catalog read: can this free text name a retired
// row at all? True for a matcher hit or a retired key spelled out, and always
// true while any retired key lacks a label matcher (its exact name could be
// anything).
function labelMayNameRetiredSale(text) {
  if (typeof text !== 'string' || !text.trim()) return false;
  if ([...RETIRED_SALE_SERVICE_KEYS].some((key) => !RETIRED_SALE_LABEL_MATCHERS[key])) return true;
  return !!retiredSaleKeyForLabel(text)
    || RETIRED_SALE_SERVICE_KEYS.has(text.trim().toLowerCase().replace(/\s+/g, '_'));
}

module.exports = {
  labelMayNameRetiredSale,
  retiredSaleKeyForLabel,
  RETIRED_SALE_SERVICE_KEYS,
  isRetiredTreeShrubTier,
  isSellableTreeShrubTier,
};
