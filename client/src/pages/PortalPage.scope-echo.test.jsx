// @vitest-environment jsdom
// scopeEchoMismatch: does the RESOLVED scope a read was served under match the
// house this tab shows? Pins the r2a rule: a selection with NO listed entry is
// stale (the server may have fallen back to another house and nothing can be
// compared), while no selection at all still reads as profile/primary.
import '@testing-library/jest-dom/vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

let scopeEchoMismatch;
beforeEach(async () => {
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  ({ scopeEchoMismatch } = await import('./PortalPage'));
});

const primary = { id: 'c1:pa', key: 'c1:pa', customerId: 'c1', propertyId: 'pa', isPrimaryProperty: true };
const secondary = { id: 'c1:pb', key: 'c1:pb', customerId: 'c1', propertyId: 'pb', isPrimaryProperty: false };

describe('scopeEchoMismatch', () => {
  it('no echo = not stale', () => {
    expect(scopeEchoMismatch(undefined, secondary, true, 'pb')).toBe(false);
  });
  it('matching echo on the shown entry = not stale; another house = stale', () => {
    expect(scopeEchoMismatch({ enabled: true, propertyId: 'pb' }, secondary, true)).toBe(false);
    expect(scopeEchoMismatch({ enabled: true, propertyId: 'pa' }, secondary, true)).toBe(true);
    expect(scopeEchoMismatch({ enabled: true, propertyId: null }, primary, true)).toBe(false);
    expect(scopeEchoMismatch({ enabled: true, propertyId: null }, secondary, true)).toBe(true);
  });
  it('a NAMED selection with no listed entry is stale whatever the server echoed (r2a)', () => {
    expect(scopeEchoMismatch({ enabled: true, propertyId: 'pa' }, null, true, 'pc')).toBe(true);
    expect(scopeEchoMismatch({ enabled: true, propertyId: null }, null, true, 'pc')).toBe(true);
  });
  it('no selection named and no entry (profile/primary fallback) is not stale', () => {
    expect(scopeEchoMismatch({ enabled: true, propertyId: null }, null, true)).toBe(false);
    expect(scopeEchoMismatch({ enabled: true, propertyId: 'pa' }, null, true, null)).toBe(false);
  });
  // No saved list (the read failed on a fresh session) while /auth/me resolved
  // a house: the selection is the only binding — the echo must name it, and
  // a rolled-back gate is stale (uncapped codex r2c P1).
  it('without a saved list, a named selection is compared against the echo', () => {
    expect(scopeEchoMismatch({ enabled: true, propertyId: 'pb' }, null, false, 'pb')).toBe(false);
    expect(scopeEchoMismatch({ enabled: true, propertyId: 'pa' }, null, false, 'pb')).toBe(true);
    expect(scopeEchoMismatch({ enabled: true, propertyId: null }, null, false, 'pb')).toBe(true);
    expect(scopeEchoMismatch({ enabled: false }, null, false, 'pb')).toBe(true);
  });
  it('closed and disabled rules are unchanged', () => {
    expect(scopeEchoMismatch({ enabled: true, closed: true }, null, true)).toBe(true);
    expect(scopeEchoMismatch({ enabled: false }, null, true)).toBe(true);
    expect(scopeEchoMismatch({ enabled: false }, null, false)).toBe(false);
    expect(scopeEchoMismatch({ enabled: true, propertyId: 'pa' }, null, false)).toBe(true);
  });
});
