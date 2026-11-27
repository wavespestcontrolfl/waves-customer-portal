import { describe, expect, it } from 'vitest';
import { seedsHouseMix } from './FastCompleteSheet.jsx';

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
