/**
 * One card system for the customer estimate page — mirrors the SSR
 * estimate's `.card` rule (radius 12 / padding 24 / 16px stack gap / warm
 * border / soft double shadow) so every section sits in the same shadow
 * box with uniform alignment. Pass overrides for accent backgrounds
 * (e.g. the tan Waves AI / membership cards).
 */
export const ESTIMATE_CARD_SHADOW = '0 6px 18px rgba(15,23,42,.10), 0 2px 4px rgba(15,23,42,.06)';
export const ESTIMATE_CARD_BORDER = '#E7E2D7';

export function estimateCard(overrides = {}) {
  return {
    background: '#FFFFFF',
    border: `1px solid ${ESTIMATE_CARD_BORDER}`,
    borderRadius: 12,
    padding: 24,
    marginBottom: 16,
    boxShadow: ESTIMATE_CARD_SHADOW,
    ...overrides,
  };
}
