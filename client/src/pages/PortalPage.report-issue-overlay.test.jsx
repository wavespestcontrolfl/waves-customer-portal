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

  // Photo ID (PhotoId.jsx) hands off here via `initialValues`. The overlay
  // stays mounted across opens, so every field must be REPLACED (including
  // empty ones) on a handoff, and cleared again on close — otherwise a
  // stale category/note/photo from an earlier handoff (or a cancelled one)
  // survives into the next open (Codex r2 P1).
  it('a Photo ID handoff replaces every field and clears them again on close, so a later handoff never inherits stale values', async () => {
    echo.value = undefined;
    const { rerender } = render(
      <ReportIssueOverlay
        open onClose={() => {}} customer={customer} propertyAddress="418 Oak Ave" currentEntry={secondary} savedScope
        initialValues={{ category: 'pest_issue', location: 'inside_home', note: 'Found ants by the sink', photos: [{ preview: 'data:image/jpeg;base64,aaa', data: 'data:image/jpeg;base64,aaa', name: 'a.jpg' }] }}
      />,
    );
    await screen.findByRole('button', { name: /submit request/i });
    expect(screen.getByRole('button', { name: /pest issue/i })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByLabelText("Describe what's happening")).toHaveValue('Found ants by the sink');
    expect(screen.getByRole('button', { name: 'Inside Home' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByLabelText('Remove photo 1')).toBeInTheDocument();

    // Close (cancel) — PortalPage nulls its prefill on this same close.
    rerender(
      <ReportIssueOverlay
        open={false} onClose={() => {}} customer={customer} propertyAddress="418 Oak Ave" currentEntry={secondary} savedScope
        initialValues={null}
      />,
    );

    // A second, DIFFERENT handoff (a history result with no location/photos)
    // must show ONLY its own values, never the previous handoff's leftovers.
    rerender(
      <ReportIssueOverlay
        open onClose={() => {}} customer={customer} propertyAddress="418 Oak Ave" currentEntry={secondary} savedScope
        initialValues={{ category: 'lawn_concern', location: '', note: '', photos: [] }}
      />,
    );
    await screen.findByRole('button', { name: /submit request/i });
    expect(screen.getByRole('button', { name: /lawn concern/i })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByLabelText("Describe what's happening")).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Inside Home' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByLabelText('Remove photo 1')).not.toBeInTheDocument();
  });

  it('submits only live photo data and the remaining saved Photo ID references after removal', async () => {
    echo.value = undefined;
    const api = (await import('../utils/api')).default;
    const { fireEvent } = await import('@testing-library/react');
    api.createRequest.mockClear();
    render(
      <ReportIssueOverlay
        open onClose={() => {}} customer={customer} propertyAddress="418 Oak Ave" currentEntry={secondary} savedScope
        initialValues={{
          category: 'pest_issue',
          location: 'inside_home',
          note: 'Found ants by the sink',
          photos: [
            { preview: null, photoId: 'saved-1', name: 'Photo ID photo 1' },
            { preview: 'https://signed.example/two.jpg', photoId: 'saved-2', name: 'Photo ID photo 2' },
            { preview: 'data:image/jpeg;base64,live', data: 'data:image/jpeg;base64,live', name: 'live.jpg' },
          ],
          photoIdSource: { type: 'pest', id: 'photo-id-1' },
        }}
      />,
    );

    const submit = await screen.findByRole('button', { name: /submit request/i });
    expect(screen.getByText('Preview unavailable')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Remove photo 1'));
    fireEvent.click(submit);

    await waitFor(() => expect(api.createRequest).toHaveBeenCalledTimes(1));
    expect(api.createRequest).toHaveBeenCalledWith(expect.objectContaining({
      photos: ['data:image/jpeg;base64,live'],
      photoIdSource: { type: 'pest', id: 'photo-id-1', photoIds: ['saved-2'] },
    }));
  });

  it('submits a live Photo ID capture with an empty saved-photo id list', async () => {
    echo.value = undefined;
    const api = (await import('../utils/api')).default;
    const { fireEvent } = await import('@testing-library/react');
    api.createRequest.mockClear();
    render(
      <ReportIssueOverlay
        open onClose={() => {}} customer={customer} propertyAddress="418 Oak Ave" currentEntry={secondary} savedScope
        initialValues={{
          category: 'lawn_concern', location: 'front_yard', note: 'Yellow patch by the driveway',
          photos: [{ preview: 'data:image/jpeg;base64,live', data: 'data:image/jpeg;base64,live', name: 'live.jpg' }],
          photoIdSource: { type: 'lawn', id: 'photo-id-live' },
        }}
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: /submit request/i }));

    await waitFor(() => expect(api.createRequest).toHaveBeenCalledTimes(1));
    expect(api.createRequest).toHaveBeenCalledWith(expect.objectContaining({
      photos: ['data:image/jpeg;base64,live'],
      photoIdSource: { type: 'lawn', id: 'photo-id-live', photoIds: [] },
    }));
  });

  it('clears the Photo ID source on close so a later manual request does not submit it', async () => {
    echo.value = undefined;
    const api = (await import('../utils/api')).default;
    const { fireEvent } = await import('@testing-library/react');
    api.createRequest.mockClear();
    const { rerender } = render(
      <ReportIssueOverlay
        open onClose={() => {}} customer={customer} propertyAddress="418 Oak Ave" currentEntry={secondary} savedScope
        initialValues={{
          category: 'pest_issue', location: '', note: 'From Photo ID', photos: [],
          photoIdSource: { type: 'pest', id: 'photo-id-1' },
        }}
      />,
    );
    await screen.findByRole('button', { name: /submit request/i });

    rerender(<ReportIssueOverlay open={false} onClose={() => {}} customer={customer} propertyAddress="418 Oak Ave" currentEntry={secondary} savedScope initialValues={null} />);
    rerender(<ReportIssueOverlay open onClose={() => {}} customer={customer} propertyAddress="418 Oak Ave" currentEntry={secondary} savedScope initialValues={null} />);

    fireEvent.click(await screen.findByRole('button', { name: /pest issue/i }));
    fireEvent.change(screen.getByLabelText("Describe what's happening"), { target: { value: 'Manual follow-up request' } });
    fireEvent.click(screen.getByRole('button', { name: /submit request/i }));

    await waitFor(() => expect(api.createRequest).toHaveBeenCalledTimes(1));
    expect(api.createRequest.mock.calls[0][0]).not.toHaveProperty('photoIdSource');
  });

  // Photo ID's 'request' / 'inspection' / 'unclear' next steps land here
  // specifically because the server decided this is NOT an automatic
  // re-service (a 'reservice' next step links straight to /reservice/:token
  // from the sheet itself and never opens this overlay). The generic
  // schedule-derived streamline handoff must not second-guess that and swap
  // the prefilled ticket for its own "book a free re-service" CTA — doing so
  // would silently drop the note/photos the customer already provided
  // (Codex r3 P1).
  it('a Photo ID handoff is never overridden by the generic reservice streamline, even when that lane is granted', async () => {
    echo.value = undefined;
    const api = (await import('../utils/api')).default;
    api.getSchedule.mockResolvedValueOnce({
      upcoming: [], overlayHandoff: true, reservice: { url: '/reservice/tok-1', lanes: ['pest'] }, propertyScope: undefined,
    });
    render(
      <ReportIssueOverlay
        open onClose={() => {}} customer={customer} propertyAddress="418 Oak Ave" currentEntry={secondary} savedScope
        initialValues={{ category: 'pest_issue', location: 'inside_home', note: 'Found ants by the sink', photos: [] }}
      />,
    );
    await waitFor(() => expect(api.getSchedule).toHaveBeenCalled());
    expect(screen.getByLabelText("Describe what's happening")).toHaveValue('Found ants by the sink');
    expect(screen.queryByText('Covered — book your free re-service')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Book a free re-service' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /submit request/i })).toBeInTheDocument();
  });

  // Same granted lane, but reached the ORDINARY way (no Photo ID handoff) —
  // the streamline CTA must still appear. Pins that the suppression above is
  // scoped to the handoff, not a global regression of the existing feature.
  it('the same granted reservice lane still streamlines an ordinary (non-Photo-ID) pest ticket', async () => {
    echo.value = undefined;
    const api = (await import('../utils/api')).default;
    const { fireEvent } = await import('@testing-library/react');
    api.getSchedule.mockResolvedValueOnce({
      upcoming: [], overlayHandoff: true, reservice: { url: '/reservice/tok-1', lanes: ['pest'] }, propertyScope: undefined,
    });
    render(<ReportIssueOverlay open onClose={() => {}} customer={customer} propertyAddress="418 Oak Ave" currentEntry={secondary} savedScope />);
    await waitFor(() => expect(api.getSchedule).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: /pest issue/i }));
    expect(await screen.findByText('Covered — book your free re-service')).toBeInTheDocument();
    // Rendered twice (body card + sticky footer CTA) when the lane is granted.
    for (const link of screen.getAllByRole('link', { name: 'Book a free re-service' })) {
      expect(link).toHaveAttribute('href', '/reservice/tok-1');
    }
  });

  // The overlay stays mounted across opens, so urgency (like every other
  // field) can carry a stale value into a later Photo ID handoff — Photo ID
  // never sets urgency itself, so a handoff must always land on the routine
  // default (Codex r7 P2).
  it('a Photo ID handoff resets urgency to routine, not an Urgent left over from a cancelled manual entry', async () => {
    echo.value = undefined;
    const { fireEvent } = await import('@testing-library/react');
    const { rerender } = render(
      <ReportIssueOverlay open onClose={() => {}} customer={customer} propertyAddress="418 Oak Ave" currentEntry={secondary} savedScope />,
    );
    await screen.findByRole('button', { name: /submit request/i });
    fireEvent.click(screen.getByRole('button', { name: /pest issue/i }));
    await screen.findByText('Priority');
    fireEvent.click(screen.getByRole('button', { name: /urgent/i }));
    expect(screen.getByRole('button', { name: /urgent/i })).toHaveAttribute('aria-pressed', 'true');

    // Cancel without submitting — an unseeded (manual) close leaves state as-is.
    rerender(<ReportIssueOverlay open={false} onClose={() => {}} customer={customer} propertyAddress="418 Oak Ave" currentEntry={secondary} savedScope />);

    rerender(
      <ReportIssueOverlay
        open onClose={() => {}} customer={customer} propertyAddress="418 Oak Ave" currentEntry={secondary} savedScope
        initialValues={{ category: 'pest_issue', location: '', note: 'From Photo ID', photos: [] }}
      />,
    );
    await screen.findByText('Priority');
    expect(screen.getByRole('button', { name: /routine/i })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /urgent/i })).toHaveAttribute('aria-pressed', 'false');
  });
});
