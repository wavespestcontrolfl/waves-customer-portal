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
  // Fresh session: /auth/me resolved house B but /auth/properties failed, so
  // there is no saved list. The ticket still pins B (uncapped codex r2c P1).
  it('pins the ticket to the selected house even when no property list is available', async () => {
    echo.value = { enabled: true, propertyId: 'pb', closed: false };
    const api = (await import('../utils/api')).default;
    const { fireEvent } = await import('@testing-library/react');
    render(<ReportIssueOverlay open onClose={() => {}} customer={customer} propertyAddress="" currentEntry={null} savedScope={false} selectedProperty={{ customerId: 'c1', propertyId: 'pb' }} />);
    const submit = await screen.findByRole('button', { name: /submit request/i });
    const categoryButton = document.querySelector('button[aria-pressed]');
    fireEvent.click(categoryButton);
    fireEvent.change(screen.getByLabelText("Describe what's happening"), { target: { value: 'Ants along the lanai door' } });
    await waitFor(() => expect(submit).not.toBeDisabled());
    fireEvent.click(submit);
    await waitFor(() => expect(api.createRequest).toHaveBeenCalledWith(expect.objectContaining({ expectedPropertyId: 'pb' })));
  });
  it('a rolled-back gate (echo disabled) under a named selection with no list withholds the ticket', async () => {
    echo.value = { enabled: false };
    render(<ReportIssueOverlay open onClose={() => {}} customer={customer} propertyAddress="" currentEntry={null} savedScope={false} selectedProperty={{ customerId: 'c1', propertyId: 'pb' }} />);
    expect(await screen.findByText('Refreshing your property selection…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /submit request/i })).toBeDisabled();
  });
  // The "your next visit is …" advisory follows the house: a next visit
  // echoed under another house than the overlay names is not offered as the
  // stop to wait for (GitHub codex #4207 r13 P2).
  const soon = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const pickPestIssue = async () => {
    const { fireEvent } = await import('@testing-library/react');
    fireEvent.click(screen.getByRole('button', { name: /pest issue/i }));
    await screen.findByText('Priority');
  };
  it('offers the next visit as the stop to wait for when its echo matches the shown house', async () => {
    echo.value = { enabled: true, propertyId: 'pb', closed: false };
    const api = (await import('../utils/api')).default;
    api.getNextService.mockResolvedValueOnce({ next: { id: 'v1', date: soon }, propertyScope: { enabled: true, propertyId: 'pb', closed: false } });
    render(<ReportIssueOverlay open onClose={() => {}} customer={customer} propertyAddress="418 Oak Ave" currentEntry={secondary} savedScope />);
    await screen.findByRole('button', { name: /submit request/i });
    await waitFor(() => expect(api.getNextService).toHaveBeenCalled());
    await pickPestIssue();
    expect(await screen.findByText('Upcoming visit')).toBeInTheDocument();
  });
  it('withholds the next-visit advisory when the echo names another house', async () => {
    echo.value = { enabled: true, propertyId: 'pb', closed: false };
    const api = (await import('../utils/api')).default;
    api.getNextService.mockResolvedValueOnce({ next: { id: 'v1', date: soon }, propertyScope: { enabled: true, propertyId: 'pa', closed: false } });
    render(<ReportIssueOverlay open onClose={() => {}} customer={customer} propertyAddress="418 Oak Ave" currentEntry={secondary} savedScope />);
    await screen.findByRole('button', { name: /submit request/i });
    await waitFor(() => expect(api.getNextService).toHaveBeenCalled());
    await pickPestIssue();
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByText('Upcoming visit')).not.toBeInTheDocument();
  });
});
