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

function panelElement({ customerFlagged = CUSTOMER_FLAGGED, request = vi.fn(async () => ({ photos: [] })), onRetry = vi.fn() } = {}) {
  const detail = detailFor({
    'svc-1': { estimate: null, brief: { brief: null, facts: { access: null, last_visit: null, customerFlagged } } },
  });
  return (
    <VisitBriefPanel
      stop={stopOf(BASE_SERVICE)}
      detail={detail}
      request={request}
      onRetry={onRetry} onPhotos={vi.fn()} onProject={vi.fn()} onZone={vi.fn()} onLead={vi.fn()}
    />
  );
}

function renderPanel({ customerFlagged = CUSTOMER_FLAGGED, request = vi.fn(async () => ({ photos: [] })), onRetry = vi.fn() } = {}) {
  const { rerender } = render(panelElement({ customerFlagged, request, onRetry }));
  return { request, onRetry, rerender };
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

  it('shows the pest read as an AI suggestion built only from fixed fields', () => {
    renderPanel({ customerFlagged: [{
      ...CUSTOMER_FLAGGED[0],
      read: {
        status: 'done', wordingTier: 'likely', commonName: 'German cockroach',
        matches: ['Two dark stripes behind the head'], stillNeed: ['A clear top-down photo'],
        referralKind: null, hazards: { disease_vector: true },
      },
    }] });
    expect(screen.getByText(
      'Photo read (AI suggestion, not confirmed): Likely: German cockroach. Matches: Two dark stripes behind the head. Still need: A clear top-down photo. Hazard: disease vector.',
    )).toBeInTheDocument();
  });

  it('shows the plant (lawn/tree & shrub) read as an AI suggestion built only from fixed fields', () => {
    renderPanel({ customerFlagged: [{
      ...CUSTOMER_FLAGGED[0],
      read: {
        status: 'done', kind: 'plant', wordingTier: 'likely', headline: 'Likely: Brown Patch',
        plantCommonName: 'St. Augustinegrass', conditionName: 'Brown Patch',
        fits: ['Roughly circular brown patch'], notYet: ['A smoke-ring edge'],
        nextStepText: 'A technician checks this on your next visit.', referralKind: null, safetyLines: [],
      },
    }] });
    expect(screen.getByText(
      'Photo read (AI suggestion, not confirmed): Likely: Brown Patch. Plant: St. Augustinegrass. Fits: Roughly circular brown patch. Not yet seen: A smoke-ring edge. A technician checks this on your next visit.',
    )).toBeInTheDocument();
  });

  describe('combined Lawn & Pest read (owner ruling 2026-09-30): BOTH notes', () => {
    const PEST_PART = {
      status: 'done', wordingTier: 'likely', commonName: 'German cockroach',
      matches: ['Two dark stripes behind the head'], stillNeed: [], referralKind: null, hazards: null,
    };
    const PLANT_PART = {
      status: 'done', kind: 'plant', subjectType: 'lawn', wordingTier: 'likely', headline: 'Likely: Brown Patch',
      plantCommonName: 'St. Augustinegrass', conditionName: 'Brown Patch',
      fits: ['Roughly circular brown patch'], notYet: [], nextStepText: 'A technician checks this on your next visit.', referralKind: null, safetyLines: [],
    };

    it('shows the pest note and the lawn note as two lines', () => {
      renderPanel({ customerFlagged: [{ ...CUSTOMER_FLAGGED[0], read: { status: 'done', kind: 'combo', pest: PEST_PART, plant: PLANT_PART } }] });
      expect(screen.getByText(
        'Photo read — pest (AI suggestion, not confirmed): Likely: German cockroach. Matches: Two dark stripes behind the head.',
      )).toBeInTheDocument();
      expect(screen.getByText(
        'Photo read — lawn (AI suggestion, not confirmed): Likely: Brown Patch. Plant: St. Augustinegrass. Fits: Roughly circular brown patch. A technician checks this on your next visit.',
      )).toBeInTheDocument();
    });

    it('labels a tree & shrub plant note as such', () => {
      renderPanel({ customerFlagged: [{ ...CUSTOMER_FLAGGED[0], read: { status: 'done', kind: 'combo', pest: PEST_PART, plant: { ...PLANT_PART, subjectType: 'tree_shrub' } } }] });
      expect(screen.getByText(/^Photo read — tree & shrub \(AI suggestion, not confirmed\): Likely: Brown Patch/)).toBeInTheDocument();
    });

    it('a partial combo shows only the part that worked', () => {
      renderPanel({ customerFlagged: [{ ...CUSTOMER_FLAGGED[0], read: { status: 'done', kind: 'combo', pest: PEST_PART, plant: null } }] });
      expect(screen.getByText(/^Photo read — pest /)).toBeInTheDocument();
      expect(screen.queryByText(/^Photo read — lawn/)).not.toBeInTheDocument();
      cleanup();
      renderPanel({ customerFlagged: [{ ...CUSTOMER_FLAGGED[0], read: { status: 'done', kind: 'combo', pest: null, plant: PLANT_PART } }] });
      expect(screen.getByText(/^Photo read — lawn /)).toBeInTheDocument();
      expect(screen.queryByText(/^Photo read — pest/)).not.toBeInTheDocument();
    });

    it('a combo with neither part renders nothing', () => {
      renderPanel({ customerFlagged: [{ ...CUSTOMER_FLAGGED[0], read: { status: 'done', kind: 'combo', pest: null, plant: null } }] });
      expect(screen.queryByText(/Photo read/)).not.toBeInTheDocument();
    });

    it('a pending combo read shows "Photo read pending" and keeps the brief refreshing', () => {
      renderPanel({ customerFlagged: [{ ...CUSTOMER_FLAGGED[0], read: { status: 'pending' } }] });
      expect(screen.getByText('Photo read pending')).toBeInTheDocument();
    });
  });

  it('names the weeds a lawn read found (Codex #5320 r13)', () => {
    renderPanel({ customerFlagged: [{
      ...CUSTOMER_FLAGGED[0],
      read: {
        status: 'done', kind: 'plant', wordingTier: null, headline: 'Weeds in the lawn',
        plantCommonName: null, conditionName: null, weedNames: ['Spotted Spurge', 'Dollarweed'],
        fits: [], notYet: [], nextStepText: null, referralKind: null, safetyLines: [],
      },
    }] });
    expect(screen.getByText(
      'Photo read (AI suggestion, not confirmed): Weeds in the lawn. Weeds: Spotted Spurge, Dollarweed.',
    )).toBeInTheDocument();
  });

  it('shows "Photo read pending" while a read runs, and nothing for unsupported/failed/none', () => {
    renderPanel({ customerFlagged: [{ ...CUSTOMER_FLAGGED[0], read: { status: 'pending' } }] });
    expect(screen.getByText('Photo read pending')).toBeInTheDocument();
    cleanup();
    for (const status of ['unsupported', 'failed', 'none']) {
      renderPanel({ customerFlagged: [{ ...CUSTOMER_FLAGGED[0], read: { status } }] });
      expect(screen.queryByText(/Photo read/)).not.toBeInTheDocument();
      cleanup();
    }
  });

  it('a group-only read names the catalog group', () => {
    renderPanel({ customerFlagged: [{ ...CUSTOMER_FLAGGED[0], read: { status: 'done', wordingTier: 'group_only', commonName: null, groupLabel: 'Ants' } }] });
    expect(screen.getByText('Photo read (AI suggestion, not confirmed): Looks like: Ants.')).toBeInTheDocument();
  });

  it('re-reads the brief every 30 s while a read is pending, and stops once it is not', async () => {
    vi.useFakeTimers();
    try {
      const onRetry = vi.fn();
      renderPanel({ customerFlagged: [{ ...CUSTOMER_FLAGGED[0], read: { status: 'pending' } }], onRetry });
      await act(async () => { vi.advanceTimersByTime(29 * 1000); });
      expect(onRetry).not.toHaveBeenCalled();
      await act(async () => { vi.advanceTimersByTime(2 * 1000); });
      expect(onRetry).toHaveBeenCalledTimes(1);
      cleanup();
      const onRetryDone = vi.fn();
      renderPanel({ customerFlagged: [{ ...CUSTOMER_FLAGGED[0], read: { status: 'done', commonName: 'German cockroach' } }], onRetry: onRetryDone });
      await act(async () => { vi.advanceTimersByTime(60 * 1000); });
      expect(onRetryDone).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a just-sent submission whose read has not started yet is polled, silently', async () => {
    vi.useFakeTimers();
    try {
      const onRetry = vi.fn();
      renderPanel({ customerFlagged: [{ ...CUSTOMER_FLAGGED[0], sentAt: new Date().toISOString(), read: { status: 'none' } }], onRetry });
      expect(screen.queryByText(/Photo read/)).not.toBeInTheDocument();
      await act(async () => { vi.advanceTimersByTime(31 * 1000); });
      expect(onRetry).toHaveBeenCalledTimes(1);
      cleanup();
      const onRetryOld = vi.fn();
      renderPanel({ customerFlagged: [{ ...CUSTOMER_FLAGGED[0], sentAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(), read: { status: 'none' } }], onRetry: onRetryOld });
      await act(async () => { vi.advanceTimersByTime(31 * 1000); });
      expect(onRetryOld).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('an older unread submission the recovery sweep may still read (awaiting) is polled once a minute, silently', async () => {
    vi.useFakeTimers();
    try {
      const onRetry = vi.fn();
      renderPanel({
        customerFlagged: [{ ...CUSTOMER_FLAGGED[0], sentAt: new Date(Date.now() - 40 * 60 * 1000).toISOString(), read: { status: 'none', awaiting: true } }],
        onRetry,
      });
      expect(screen.queryByText(/Photo read/)).not.toBeInTheDocument();
      await act(async () => { vi.advanceTimersByTime(31 * 1000); });
      expect(onRetry).not.toHaveBeenCalled();
      await act(async () => { vi.advanceTimersByTime(30 * 1000); await Promise.resolve(); });
      expect(onRetry).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('an awaited read the sweep claims starts a fresh budget at the pending pace (Codex #5320 r11)', async () => {
    vi.useFakeTimers();
    try {
      const onRetry = vi.fn();
      const sentAt = new Date(Date.now() - 40 * 60 * 1000).toISOString();
      const entry = (read) => [{ ...CUSTOMER_FLAGGED[0], sentAt, read }];
      const { rerender } = renderPanel({ customerFlagged: entry({ status: 'none', awaiting: true }), onRetry });
      // Burn most of the awaiting budget (29 of 30 one-minute polls).
      for (let i = 0; i < 29; i += 1) {
        await act(async () => { vi.advanceTimersByTime(60 * 1000); await Promise.resolve(); });
      }
      expect(onRetry).toHaveBeenCalledTimes(29);
      rerender(panelElement({ customerFlagged: entry({ status: 'pending' }), onRetry }));
      for (let i = 0; i < 5; i += 1) {
        await act(async () => { vi.advanceTimersByTime(30 * 1000); await Promise.resolve(); });
      }
      expect(onRetry).toHaveBeenCalledTimes(34);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a slow refresh is awaited before the next poll is armed', async () => {
    vi.useFakeTimers();
    try {
      let settle;
      const onRetry = vi.fn(() => new Promise((resolve) => { settle = resolve; }));
      renderPanel({ customerFlagged: [{ ...CUSTOMER_FLAGGED[0], read: { status: 'pending' } }], onRetry });
      await act(async () => { vi.advanceTimersByTime(31 * 1000); });
      expect(onRetry).toHaveBeenCalledTimes(1);
      // Still in flight: no second poll however long it takes.
      await act(async () => { vi.advanceTimersByTime(90 * 1000); });
      expect(onRetry).toHaveBeenCalledTimes(1);
      await act(async () => { settle(); await Promise.resolve(); });
      await act(async () => { vi.advanceTimersByTime(31 * 1000); });
      expect(onRetry).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a parent re-render with a new retry callback does not restart the 30 s timer', async () => {
    vi.useFakeTimers();
    try {
      const calls = [];
      const panel = (fn) => (
        <VisitBriefPanel
          stop={stopOf(BASE_SERVICE)}
          detail={detailFor({ 'svc-1': { estimate: null, brief: { brief: null, facts: { access: null, last_visit: null, customerFlagged: [{ ...CUSTOMER_FLAGGED[0], read: { status: 'pending' } }] } } } })}
          request={vi.fn(async () => ({ photos: [] }))}
          onRetry={fn} onPhotos={vi.fn()} onProject={vi.fn()} onZone={vi.fn()} onLead={vi.fn()}
        />
      );
      const { rerender } = render(panel(() => calls.push('first')));
      await act(async () => { vi.advanceTimersByTime(20 * 1000); });
      rerender(panel(() => calls.push('second')));
      await act(async () => { vi.advanceTimersByTime(11 * 1000); });
      // Fired at 30 s from the first render, with the LATEST callback.
      expect(calls).toEqual(['second']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a new pending read gets a fresh refresh budget', async () => {
    vi.useFakeTimers();
    try {
      const onRetry = vi.fn();
      const panel = (entries) => (
        <VisitBriefPanel
          stop={stopOf(BASE_SERVICE)}
          detail={detailFor({ 'svc-1': { estimate: null, brief: { brief: null, facts: { access: null, last_visit: null, customerFlagged: entries } } } })}
          request={vi.fn(async () => ({ photos: [] }))}
          onRetry={onRetry} onPhotos={vi.fn()} onProject={vi.fn()} onZone={vi.fn()} onLead={vi.fn()}
        />
      );
      const { rerender } = render(panel([{ ...CUSTOMER_FLAGGED[0], read: { status: 'pending' } }]));
      for (let i = 0; i < 31; i += 1) {
        await act(async () => { vi.advanceTimersByTime(30 * 1000); });
        rerender(panel([{ ...CUSTOMER_FLAGGED[0], read: { status: 'pending' } }]));
      }
      const spent = onRetry.mock.calls.length;
      expect(spent).toBe(30);
      // Another submission's read starts pending: polling resumes.
      rerender(panel([{ ...CUSTOMER_FLAGGED[0], read: { status: 'done', commonName: 'German cockroach' } }, { ...CUSTOMER_FLAGGED[0], id: 'sub-2', read: { status: 'pending' } }]));
      await act(async () => { vi.advanceTimersByTime(30 * 1000); });
      expect(onRetry.mock.calls.length).toBe(spent + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a category-level read shows the engine headline', () => {
    renderPanel({ customerFlagged: [{ ...CUSTOMER_FLAGGED[0], read: { status: 'done', wordingTier: 'group_only', commonName: null, groupLabel: null, groupHeadline: 'Looks like a beetle' } }] });
    expect(screen.getByText('Photo read (AI suggestion, not confirmed): Looks like a beetle.')).toBeInTheDocument();
  });

  it('a done read with no named species says so plainly', () => {
    renderPanel({ customerFlagged: [{ ...CUSTOMER_FLAGGED[0], read: { status: 'done', wordingTier: 'unknown', commonName: null } }] });
    expect(screen.getByText('Photo read (AI suggestion, not confirmed): No species named from these photos.')).toBeInTheDocument();
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
