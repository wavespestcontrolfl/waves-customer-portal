import { describe, expect, it } from 'vitest';
import { seedsHouseMix, missingRequirement, noProductHold, NO_CARD_HOLD } from './FastCompleteSheet.jsx';

// Owner pick D18: a visit with no protocol card is inspection only, on the re-service sheet too.
describe('seedsHouseMix: the server card answer', () => {
  const noCard = { matchedVisit: { visit: null, reason: 'no_protocol', matched: false } };
  const courtesy = { serviceType: 'Courtesy Visit', isCallback: true };
  it('seeds no mix on a no-card answer, on the re-service sheet and the report flow', () => {
    expect(seedsHouseMix(courtesy, { serviceType: 'Courtesy Visit', reportFlow: false, cardDefaults: noCard })).toBe(false);
    expect(seedsHouseMix({ serviceType: 'Pest Re-Service', isCallback: true }, { serviceType: 'Pest Re-Service', reportFlow: true, cardDefaults: noCard })).toBe(false);
  });
  it('keeps the re-service sheet mix when the card answer is a card or the read failed', () => {
    expect(seedsHouseMix(courtesy, { serviceType: 'Courtesy Visit', reportFlow: false, cardDefaults: null })).toBe(true);
    expect(seedsHouseMix(courtesy, { serviceType: 'Courtesy Visit', reportFlow: false, cardDefaults: { matchedVisit: { reason: 'matched', matched: true } } })).toBe(true);
  });
});

// A no-card visit with no product is inspection only: the sheet sends the tech to the Full form, which records it.
describe('the empty product hold on a no-card visit', () => {
  const form = { pests: new Set(), areas: new Set(), otherPest: '', linearFt: '', method: '', activity: null };
  it('names the Full form on the re-service sheet and the report flow', () => {
    expect(NO_CARD_HOLD).toMatch(/Full form/);
    expect(missingRequirement(form, [], false, false, 0, {}, false, true).reason).toBe(NO_CARD_HOLD);
    expect(noProductHold(undefined, true)).toBe(NO_CARD_HOLD);
  });
  it('keeps the product ask on a visit with a card', () => {
    expect(missingRequirement(form, [], false, false, 0, {}, false, false).reason).toBe('Select at least one product.');
    expect(noProductHold(undefined, false)).toBe('Select at least one product.');
    expect(noProductHold('typed', true)).toBeNull();
  });
});

