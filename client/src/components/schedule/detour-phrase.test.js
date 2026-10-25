import { describe, expect, it } from 'vitest';
import { detourPhrase } from './detour-phrase';

describe('detourPhrase', () => {
  it('rounds the added minutes', () => {
    expect(detourPhrase({ detourMinutes: 4.4 })).toBe('+4 min added to route');
    expect(detourPhrase({ detourMinutes: 57 })).toBe('+57 min added to route');
  });

  it('says there is no added drive for a zero detour', () => {
    expect(detourPhrase({ detourMinutes: 0 })).toBe('no added drive');
  });

  it('says the cost is unknown when the route could not be priced', () => {
    expect(detourPhrase({ detourMinutes: null })).toBe('route cost unknown');
  });
});
