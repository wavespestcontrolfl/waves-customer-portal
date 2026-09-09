// @vitest-environment jsdom
// ReportIssueOverlay is mounted by PortalPage on EVERY authenticated render
// (open={false} included), so a render-time throw inside it takes the whole
// portal down — r1o shipped exactly that (a const read before its
// declaration; uncapped codex r1o P1). This pins: closed and open mounts
// render; a stale scope echo withholds the submit and names the refresh.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const echo = { value: undefined };
vi.mock('../utils/api', () => ({
  default: {
    getSchedule: vi.fn(async () => ({ upcoming: [], reservice: null, overlayHandoff: false, propertyScope: echo.value })),
    getNextService: vi.fn(async () => ({ next: null })),
    getServices: vi.fn(async () => ({ services: [] })),
    getLastService: vi.fn(async () => ({ service: null })),
    createRequest: vi.fn(async () => ({ id: 'r1' })),
    request: vi.fn(async () => ({})),
  },
}));

let ReportIssueOverlay;
beforeEach(async () => {
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  ({ ReportIssueOverlay } = await import('./PortalPage'));
});
afterEach(() => cleanup());

const customer = { id: 'c1', firstName: 'Jordan', lastName: 'Rivera', address: { line1: '1200 Palm Row Ct', city: 'Parrish', state: 'FL', zip: '34219' } };
const secondary = { id: 'c1:pb', key: 'c1:pb', customerId: 'c1', propertyId: 'pb', isPrimaryProperty: false };

describe('ReportIssueOverlay mount safety', () => {
  it('mounts closed without throwing (the portal renders it on every authenticated render)', () => {
    expect(() => render(<ReportIssueOverlay open={false} onClose={() => {}} customer={customer} />)).not.toThrow();
  });
  it('mounts open with the selected house and no scope echo — submit stays gated only on the form', async () => {
    echo.value = undefined;
    render(<ReportIssueOverlay open onClose={() => {}} customer={customer} propertyAddress="418 Oak Ave, Bradenton FL 34205" currentEntry={secondary} savedScope />);
    expect(await screen.findByText('418 Oak Ave, Bradenton FL 34205')).toBeInTheDocument();
  });
  it('scopeUnavailable (every saved property retired) withholds the ticket before any read, without asking for a re-read', async () => {
    echo.value = undefined;
    const refresh = vi.fn();
    render(<ReportIssueOverlay open onClose={() => {}} customer={customer} propertyAddress="" currentEntry={null} savedScope scopeUnavailable onSavedScopeUnavailable={refresh} />);
    expect(await screen.findByText('Refreshing your property selection…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /submit request/i })).toBeDisabled();
    expect(refresh).not.toHaveBeenCalled();
  });
  it('a schedule echo scoped to another house than the one shown withholds the ticket and re-reads the selection', async () => {
    echo.value = { enabled: true, propertyId: 'pa', closed: false };
    const refresh = vi.fn();
    render(<ReportIssueOverlay open onClose={() => {}} customer={customer} propertyAddress="418 Oak Ave, Bradenton FL 34205" currentEntry={secondary} savedScope onSavedScopeUnavailable={refresh} />);
    expect(await screen.findByText('Refreshing your property selection…')).toBeInTheDocument();
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(screen.getByRole('button', { name: /submit request/i })).toBeDisabled();
  });
  // Another tab switched to a newly added house and the list reload failed:
  // the selection names a house the retained list does not carry. The
  // server's echo (a fallback house here) has nothing to be compared with —
  // the ticket is withheld and the list re-read (uncapped codex r2a P1).
  it('a NAMED selection with no listed entry withholds the ticket even when the echo names some house', async () => {
    echo.value = { enabled: true, propertyId: 'pa', closed: false };
    const refresh = vi.fn();
    render(<ReportIssueOverlay open onClose={() => {}} customer={customer} propertyAddress="" currentEntry={null} savedScope selectedProperty={{ customerId: 'c1', propertyId: 'pc' }} onSavedScopeUnavailable={refresh} />);
    expect(await screen.findByText('Refreshing your property selection…')).toBeInTheDocument();
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(screen.getByRole('button', { name: /submit request/i })).toBeDisabled();
  });
});
