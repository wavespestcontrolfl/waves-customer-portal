// @vitest-environment jsdom
// Visit Brief "Customer texts · last 7 days" (GATE_TECH_VISIT_TEXTS). Synthetic data only.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import VisitTextsSection from './VisitTextsSection';
import VisitBriefPanel from './VisitBriefPanel';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const renderWith = (request) => render(<VisitTextsSection serviceId="svc-1" request={request} />);
const wait = () => new Promise((resolve) => setTimeout(resolve, 20));

describe('VisitTextsSection', () => {
  it('shows each text with who sent it, the ET time, and photos that open full size', async () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    const request = vi.fn(async () => ({
      enabled: true,
      hidden: 0,
      texts: [
        { id: 't1', direction: 'inbound', at: '2026-11-20T15:00:00.000Z', body: 'Please skip the back yard', photos: [{ url: 'https://signed.example/a', contentType: 'image/jpeg' }] },
        { id: 't2', direction: 'outbound', at: '2026-11-20T16:00:00.000Z', body: 'Got it', photos: [] },
      ],
    }));
    renderWith(request);
    expect(await screen.findByText('Customer texts · last 7 days')).toBeInTheDocument();
    expect(request).toHaveBeenCalledWith('/admin/schedule/svc-1/visit-texts');
    expect(screen.getByText('Please skip the back yard')).toBeInTheDocument();
    expect(screen.getByText(/^Customer · /)).toHaveTextContent('Nov 20, 10:00 AM');
    expect(screen.getByText(/^Office · /)).toBeInTheDocument();
    expect(screen.queryByText(/hidden/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Open customer photo' }));
    expect(open).toHaveBeenCalledWith('https://signed.example/a', '_blank', 'noopener,noreferrer');
  });

  it('says how many billing texts are hidden, once, in muted text', async () => {
    renderWith(vi.fn(async () => ({ enabled: true, hidden: 3, texts: [{ id: 't1', direction: 'inbound', at: '2026-11-20T15:00:00.000Z', body: 'Hi', photos: [] }] })));
    expect(await screen.findByText('3 texts about billing are hidden. Ask the office.')).toBeInTheDocument();
  });

  it('renders nothing when the gate is off (404), the list is empty, or the answer is not the texts shape', async () => {
    for (const request of [
      vi.fn(async () => { throw Object.assign(new Error('Not found'), { status: 404 }); }),
      vi.fn(async () => ({ enabled: true, hidden: 0, texts: [] })),
      vi.fn(async () => ({ accessCodes: [] })),
    ]) {
      const { container, unmount } = renderWith(request);
      await wait();
      await waitFor(() => expect(request).toHaveBeenCalled());
      expect(container).toBeEmptyDOMElement();
      unmount();
    }
  });

  it('shows one muted line when the read fails', async () => {
    renderWith(vi.fn(async () => { throw Object.assign(new Error('boom'), { status: 500 }); }));
    expect(await screen.findByText("Couldn't load texts")).toBeInTheDocument();
  });
});

describe('in the Visit Brief', () => {
  const SERVICE = { id: 'svc-1', status: 'confirmed', customerName: 'Pat Sample', address: '123 Palm Ave, Bradenton, FL 34205', serviceType: 'Quarterly Pest Control' };
  const stop = { key: 'row:svc-1', isVisit: false, services: [SERVICE], primary: SERVICE, liveCount: 1 };
  const panel = (brief, request) => render(<VisitBriefPanel stop={stop} detail={{ status: 'ready', byService: { 'svc-1': { brief } } }} request={request} />);
  const texts = { enabled: true, hidden: 0, texts: [{ id: 't1', direction: 'inbound', at: '2026-11-20T15:00:00.000Z', body: 'Gate code changed', photos: [] }] };

  it('reads the texts only when the brief says the gate is on', async () => {
    const request = vi.fn(async () => texts);
    panel({ brief: null, visitTexts: true }, request);
    expect(await screen.findByText('Gate code changed')).toBeInTheDocument();
    expect(request).toHaveBeenCalledWith('/admin/schedule/svc-1/visit-texts');
  });

  it('asks for nothing when the brief carries no flag', async () => {
    const request = vi.fn(async () => texts);
    panel({ brief: null }, request);
    await wait();
    expect(request).not.toHaveBeenCalledWith('/admin/schedule/svc-1/visit-texts');
    expect(screen.queryByText('Customer texts · last 7 days')).toBeNull();
  });
});
