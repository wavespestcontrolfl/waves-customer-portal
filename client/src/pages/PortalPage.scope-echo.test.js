// @vitest-environment jsdom
import { beforeAll, describe, expect, it, vi } from 'vitest';

let scopeEchoMismatch;
beforeAll(async () => {
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  ({ scopeEchoMismatch } = await import('./PortalPage'));
});

// The scoped reads echo the selection the SERVER honored; the page compares it
// with the entry it shows and treats a mismatch as stale (re-read the list,
// withhold actions) — codex #4207 r1j.
describe('scopeEchoMismatch', () => {
  const primary = { id: 'c1:pa', key: 'c1:pa', propertyId: 'pa', isPrimaryProperty: true };
  const secondary = { id: 'c1:pb', key: 'c1:pb', propertyId: 'pb', isPrimaryProperty: false };
  it('matches when the server honored the shown house; null from the server means the primary', () => {
    expect(scopeEchoMismatch({ enabled: true, propertyId: 'pb' }, secondary, true)).toBe(false);
    expect(scopeEchoMismatch({ enabled: true, propertyId: null }, primary, true)).toBe(false);
    expect(scopeEchoMismatch({ enabled: true, propertyId: 'pa' }, primary, true)).toBe(false);
  });
  it('flags a read scoped to another house than the one shown', () => {
    expect(scopeEchoMismatch({ enabled: true, propertyId: null }, secondary, true)).toBe(true); // retired house → server fell back to the primary
    expect(scopeEchoMismatch({ enabled: true, propertyId: 'pa' }, secondary, true)).toBe(true);
  });
  it('never fires outside the saved scope, without an echo, when the scope is disabled, or with no entry to compare', () => {
    expect(scopeEchoMismatch({ enabled: true, propertyId: null }, secondary, false)).toBe(false);
    expect(scopeEchoMismatch(undefined, secondary, true)).toBe(false);
    expect(scopeEchoMismatch({ enabled: false, propertyId: null }, secondary, true)).toBe(false);
    expect(scopeEchoMismatch({ enabled: true, propertyId: 'pa' }, null, true)).toBe(false);
  });
});
