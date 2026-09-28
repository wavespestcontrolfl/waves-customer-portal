// @vitest-environment jsdom
// "Customer flagged" section (PR 3a — customer photos before a visit,
// facts.customerFlagged). Separate file from VisitBriefPanel.test.jsx so
// this PR's client coverage stays self-contained.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import VisitBriefPanel from './VisitBriefPanel';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const BASE_SERVICE = {
  id: 'svc-1',
  status: 'confirmed',
  customerName: 'Pat Sample',
  customerPhone: '(941) 555-0100',
  address: '123 Palm Ave, Bradenton, FL 34205',
  serviceType: 'Quarterly Pest Control',
};

const stopOf = (...services) => ({
  key: `row:${services[0].id}`,
  isVisit: services.length > 1,
  services,
  primary: services[0],
  liveCount: services.length,
});

const detailFor = (byService, status = 'ready') => ({ status, byService });

const CUSTOMER_FLAGGED = [{
  id: 'sub-1',
  sentAt: '2026-09-30T23:42:00.000Z',
  topic: 'lawn',
  locationOnProperty: 'back_yard',
  note: 'Brown spots spreading by the driveway',
  photoIds: ['photo-a', 'photo-b'],
}];

function renderPanel({ customerFlagged = CUSTOMER_FLAGGED, request = vi.fn(async () => ({ photos: [] })) } = {}) {
  const detail = detailFor({
    'svc-1': { estimate: null, brief: { brief: null, facts: { access: null, last_visit: null, customerFlagged } } },
  });
  render(
    <VisitBriefPanel
      stop={stopOf(BASE_SERVICE)}
      detail={detail}
      request={request}
      onRetry={vi.fn()} onPhotos={vi.fn()} onProject={vi.fn()} onZone={vi.fn()} onLead={vi.fn()}
    />,
  );
  return { request };
}

describe('VisitBriefPanel — Customer flagged section', () => {
  it('renders sent time (ET), the quoted note, and the location/topic line', async () => {
    renderPanel();
    expect(screen.getByText('Customer flagged')).toBeInTheDocument();
    // 2026-09-30T23:42:00.000Z is 7:42 PM ET.
    expect(screen.getByText(/sent Sep 30, 7:42 PM/)).toBeInTheDocument();
    // The panel wraps the note in curly quotes (same convention as
    // TechRecapCapture.jsx's caption display), not straight ones.
    expect(screen.getByText('“Brown spots spreading by the driveway”')).toBeInTheDocument();
    expect(screen.getByText('Back yard · Lawn')).toBeInTheDocument();
  });

  it('fetches thumbnails from GET /admin/schedule/:id/visit-prep-photos and renders them tappable', async () => {
    const request = vi.fn(async () => ({
      photos: [
        { id: 'photo-a', submissionId: 'sub-1', url: 'https://s3.example/a.jpg' },
        { id: 'photo-b', submissionId: 'sub-1', url: 'https://s3.example/b.jpg' },
      ],
    }));
    renderPanel({ request });
    expect(request).toHaveBeenCalledWith('/admin/schedule/svc-1/visit-prep-photos');
    await act(async () => { await Promise.resolve(); });
    const openBtns = await screen.findAllByRole('button', { name: 'Open customer photo' });
    expect(openBtns).toHaveLength(2);
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => {});
    fireEvent.click(openBtns[0]);
    expect(openSpy).toHaveBeenCalledWith('https://s3.example/a.jpg', '_blank', 'noopener,noreferrer');
  });

  it('refetches thumbnails when a brief refresh brings new photo ids (no reopen needed)', async () => {
    const request = vi.fn(async () => ({ photos: [] }));
    const panelFor = (customerFlagged) => (
      <VisitBriefPanel
        stop={stopOf(BASE_SERVICE)}
        detail={detailFor({
          'svc-1': { estimate: null, brief: { brief: null, facts: { access: null, last_visit: null, customerFlagged } } },
        })}
        request={request}
        onRetry={vi.fn()} onPhotos={vi.fn()} onProject={vi.fn()} onZone={vi.fn()} onLead={vi.fn()}
      />
    );
    const { rerender } = render(panelFor(CUSTOMER_FLAGGED));
    await act(async () => { await Promise.resolve(); });
    expect(request).toHaveBeenCalledTimes(1);
    // Same ids again: no extra fetch.
    rerender(panelFor(CUSTOMER_FLAGGED.map((e) => ({ ...e }))));
    await act(async () => { await Promise.resolve(); });
    expect(request).toHaveBeenCalledTimes(1);
    // The customer sent another submission while the panel was open.
    rerender(panelFor([...CUSTOMER_FLAGGED, {
      id: 'sub-2', sentAt: '2026-10-01T12:00:00.000Z', topic: 'pest', locationOnProperty: null, note: null, photoIds: ['photo-c'],
    }]));
    await act(async () => { await Promise.resolve(); });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('re-fetches the signed links before their one-hour expiry while the panel stays open', async () => {
    vi.useFakeTimers();
    try {
      const request = vi.fn(async () => ({ photos: [] }));
      renderPanel({ request });
      await act(async () => { await Promise.resolve(); });
      expect(request).toHaveBeenCalledTimes(1);
      await act(async () => { vi.advanceTimersByTime(49 * 60 * 1000); });
      expect(request).toHaveBeenCalledTimes(1);
      await act(async () => { vi.advanceTimersByTime(2 * 60 * 1000); await Promise.resolve(); });
      expect(request).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('withholds expired links and re-fetches when a suspended tab resumes', async () => {
    vi.useFakeTimers();
    const start = Date.now();
    try {
      const request = vi.fn(async () => ({ photos: [] }));
      renderPanel({ request });
      await act(async () => { await Promise.resolve(); });
      expect(request).toHaveBeenCalledTimes(1);
      // The phone was locked: the clock moved but the timer never fired.
      vi.setSystemTime(start + 70 * 60 * 1000);
      await act(async () => { document.dispatchEvent(new Event('visibilitychange')); await Promise.resolve(); });
      expect(request).toHaveBeenCalledTimes(2);
      // A resume while the links are still fresh does not re-fetch.
      await act(async () => { document.dispatchEvent(new Event('visibilitychange')); await Promise.resolve(); });
      expect(request).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('renders nothing when facts carry no customerFlagged entries (gate off, or nothing sent)', () => {
    renderPanel({ customerFlagged: null });
    expect(screen.queryByText('Customer flagged')).not.toBeInTheDocument();
  });

  it('never calls the thumbnails endpoint when there is nothing to show', () => {
    const request = vi.fn(async () => ({ photos: [] }));
    renderPanel({ customerFlagged: null, request });
    expect(request).not.toHaveBeenCalled();
  });
});
