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
  it('a server scoped to a house while the client sits in profile mode (gate back after a rollback) is stale; a primary/unscoped echo is not', () => {
    expect(scopeEchoMismatch({ enabled: true, propertyId: 'pb' }, null, false)).toBe(true);
    expect(scopeEchoMismatch({ enabled: true, propertyId: null }, secondary, false)).toBe(false);
  });
  it('never fires without an echo, or with no entry to compare', () => {
    expect(scopeEchoMismatch(undefined, secondary, true)).toBe(false);
    expect(scopeEchoMismatch({ enabled: true, propertyId: 'pa' }, null, true)).toBe(false);
  });
  it('a disabled scope (gate off, cancelled) is stale while the tab still shows a saved-property label; in profile mode it is not (uncapped codex r1m)', () => {
    expect(scopeEchoMismatch({ enabled: false, propertyId: null }, secondary, true)).toBe(true);
    expect(scopeEchoMismatch({ enabled: false, propertyId: null }, primary, true)).toBe(true);
    expect(scopeEchoMismatch({ enabled: false, propertyId: null }, null, false)).toBe(false);
  });
  it('the RESOLVED echo: a lone secondary the server fell back to matches its own entry; every-row-retired (closed) is stale for any house entry (uncapped codex r1m)', () => {
    expect(scopeEchoMismatch({ enabled: true, propertyId: 'pb', closed: false }, secondary, true)).toBe(false);
    expect(scopeEchoMismatch({ enabled: true, propertyId: null, closed: true }, secondary, true)).toBe(true);
    expect(scopeEchoMismatch({ enabled: true, propertyId: null, closed: true }, primary, true)).toBe(true);
    // Closed is stale with NO entry too (the list names none for this profile) — in saved and in profile mode (GitHub codex r5 P1).
    expect(scopeEchoMismatch({ enabled: true, propertyId: null, closed: true }, null, true)).toBe(true);
    expect(scopeEchoMismatch({ enabled: true, propertyId: null, closed: true }, null, false)).toBe(true);
    const profileOnly = { id: 'c9:profile', key: 'c9:profile', propertyId: null, isPrimaryProperty: true };
    expect(scopeEchoMismatch({ enabled: true, propertyId: null, closed: false }, profileOnly, true)).toBe(false);
  });
});
