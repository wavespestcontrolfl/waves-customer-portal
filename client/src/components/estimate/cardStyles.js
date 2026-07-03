/**
 * One card system for the customer estimate page — mirrors the SSR
 * estimate's `.card` rule and the Waves AI panel exactly (owner
 * directive 2026-07-03: every box uses the AI card's warm tan
 * background, border, and shadow): radius 12 / padding 24 / 16px stack
 * gap / #D9D3C4 border / soft double shadow. Content that needs to pop
 * sits in WHITE inner boxes inside the tan card, same as the AI panel's
 * metric tiles.
 */
export const ESTIMATE_CARD_SHADOW = '0 6px 18px rgba(15,23,42,.10), 0 2px 4px rgba(15,23,42,.06)';
export const ESTIMATE_CARD_BG = '#F2EEE0';
export const ESTIMATE_CARD_BORDER = '#D9D3C4';

export function estimateCard(overrides = {}) {
  return {
    background: ESTIMATE_CARD_BG,
    border: `1px solid ${ESTIMATE_CARD_BORDER}`,
    borderRadius: 12,
    padding: 24,
    marginBottom: 16,
    boxShadow: ESTIMATE_CARD_SHADOW,
    ...overrides,
  };
}

// White inner boxes that sit INSIDE a tan card (frequency options,
// preference toggles, AI metric tiles, review cards, …) — one bordered,
// softly-shadowed treatment so every clickable/inner box reads the same.
export const ESTIMATE_INNER_SHADOW = '0 2px 8px rgba(15,23,42,.08), 0 1px 2px rgba(15,23,42,.05)';

export function estimateInnerBox(overrides = {}) {
  return {
    background: '#FFFFFF',
    border: `1px solid ${ESTIMATE_CARD_BORDER}`,
    borderRadius: 10,
    boxShadow: ESTIMATE_INNER_SHADOW,
    ...overrides,
  };
}
