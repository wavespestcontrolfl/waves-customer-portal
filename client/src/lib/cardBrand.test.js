import { describe, expect, it } from 'vitest';
import { cardBrandLabel } from './cardBrand';

describe('cardBrandLabel', () => {
  it('maps stored (uppercased) and raw Stripe brands to proper names', () => {
    expect(cardBrandLabel('VISA')).toBe('Visa');
    expect(cardBrandLabel('visa')).toBe('Visa');
    expect(cardBrandLabel('MASTERCARD')).toBe('Mastercard');
    expect(cardBrandLabel('amex')).toBe('Amex');
    expect(cardBrandLabel('American Express')).toBe('Amex');
    expect(cardBrandLabel('discover')).toBe('Discover');
    expect(cardBrandLabel('jcb')).toBe('JCB');
  });
  it('title-cases unknown brands and falls back when empty', () => {
    expect(cardBrandLabel('SOMEBANK')).toBe('Somebank');
    expect(cardBrandLabel('')).toBe('Card');
    expect(cardBrandLabel(null, 'card')).toBe('card');
  });
});
