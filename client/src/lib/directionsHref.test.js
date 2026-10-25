import { describe, expect, it } from 'vitest';
import { directionsHref } from './directionsHref';

describe('directionsHref', () => {
  it('is the plain driving-directions link when the visit has no gate', () => {
    expect(directionsHref('123 Main St, Bradenton, FL 34205'))
      .toBe('https://www.google.com/maps/dir/?api=1&destination=123%20Main%20St%2C%20Bradenton%2C%20FL%2034205&travelmode=driving');
    expect(directionsHref('123 Main St', null)).toContain('&destination=123%20Main%20St&travelmode');
    expect(directionsHref('')).toBe('https://www.google.com/maps/dir/?api=1&destination=&travelmode=driving');
  });

  it("routes through the neighborhood's main gate as the one stop before the house", () => {
    expect(directionsHref('123 Main St', { lat: 27.4321, lng: -82.4567 }))
      .toBe('https://www.google.com/maps/dir/?api=1&destination=123%20Main%20St&waypoints=27.4321%2C-82.4567&travelmode=driving');
  });

  it('ignores a gate with a missing or impossible coordinate', () => {
    const plain = directionsHref('123 Main St');
    expect(directionsHref('123 Main St', { lat: 27.4, lng: null })).toBe(plain);
    expect(directionsHref('123 Main St', { lat: 'x', lng: -82.4 })).toBe(plain);
    expect(directionsHref('123 Main St', { lat: 127.4, lng: -82.4 })).toBe(plain);
    expect(directionsHref('123 Main St', {})).toBe(plain);
  });
});
