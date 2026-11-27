// @vitest-environment jsdom
// Visit Brief "Customer texts · last 7 days" (GATE_TECH_VISIT_TEXTS). Synthetic data only.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import VisitTextsSection from './VisitTextsSection';
import VisitBriefPanel from './VisitBriefPanel';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const ON = { 'svc-1': { brief: { brief: null, visitTexts: true } }, 'svc-2': { brief: { brief: null, visitTexts: true } } };
const SVC1 = { id: 'svc-1', customer_id: 'cust-1', scheduled_date: '2026-11-26' };
const renderWith = (request, byService = ON, service = SVC1) => render(<VisitTextsSection service={service} byService={byService} request={request} />);
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
    expect(request).toHaveBeenCalledWith('/admin/schedule/svc-1/visit-texts?customerId=cust-1&scheduledDate=2026-11-26');
    expect(screen.getByText('Please skip the back yard')).toBeInTheDocument();
    expect(screen.getByText(/^Customer · /)).toHaveTextContent('Nov 20, 10:00 AM');
    expect(screen.getByText(/^Office · /)).toBeInTheDocument();
    expect(screen.queryByText(/hidden/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Open customer photo' }));
    expect(open).toHaveBeenCalledWith('https://signed.example/a', '_blank', 'noopener,noreferrer');
  });

  it('says how many texts are hidden, once, in neutral muted words', async () => {
    const one = renderWith(vi.fn(async () => ({ enabled: true, hidden: 1, texts: [{ id: 't1', direction: 'inbound', at: '2026-11-20T15:00:00.000Z', body: 'Hi', photos: [] }] })));
    expect(await screen.findByText('1 text is hidden. Ask the office.')).toBeInTheDocument();
    one.unmount();
    renderWith(vi.fn(async () => ({ enabled: true, hidden: 3, texts: [{ id: 't1', direction: 'inbound', at: '2026-11-20T15:00:00.000Z', body: 'Hi', photos: [] }] })));
    expect(await screen.findByText('3 texts are hidden. Ask the office.')).toBeInTheDocument();
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

describe('texts unavailable', () => {
  it('says so in one muted line, with no texts', async () => {
    renderWith(vi.fn(async () => ({ enabled: true, unavailable: true, hidden: 0, texts: [] })));
    expect(await screen.findByText('Texts are not available right now. Ask the office.')).toBeInTheDocument();
  });
});

describe('photos held back by the server', () => {
  it('says how many photos are not shown instead of leaving a gap', async () => {
    renderWith(vi.fn(async () => ({ enabled: true, hidden: 0, texts: [
      { id: 't1', direction: 'inbound', at: '2026-11-20T15:00:00.000Z', body: 'Brown patch', photos: [], photoCount: 2 },
      { id: 't2', direction: 'inbound', at: '2026-11-20T16:00:00.000Z', body: 'One more', photos: [], photoCount: 1 },
    ] })));
    expect(await screen.findByText('2 photos are not shown. Ask the office.')).toBeInTheDocument();
    expect(screen.getByText('1 photo is not shown. Ask the office.')).toBeInTheDocument();
  });
});

describe('photos partly signed', () => {
  it('counts the photos that have no link, beside the ones that do', async () => {
    renderWith(vi.fn(async () => ({ enabled: true, hidden: 0, texts: [
      { id: 't1', direction: 'inbound', at: '2026-11-20T15:00:00.000Z', body: 'Three photos', photos: [{ url: 'https://signed.example/a', contentType: 'image/jpeg' }], photoCount: 3 },
    ] })));
    expect(await screen.findByText('2 photos are not shown. Ask the office.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open customer photo' })).toBeInTheDocument();
  });

  it('shows no line when every photo has a link', async () => {
    renderWith(vi.fn(async () => ({ enabled: true, hidden: 0, texts: [
      { id: 't1', direction: 'inbound', at: '2026-11-20T15:00:00.000Z', body: 'One photo', photos: [{ url: 'https://signed.example/a', contentType: 'image/jpeg' }], photoCount: 1 },
    ] })));
    await screen.findByText('One photo');
    expect(screen.queryByText(/not shown/)).toBeNull();
  });
});

describe('one visit at a time', () => {
  it('never shows the previous visit\'s texts under a new visit', async () => {
    const answers = {
      '/admin/schedule/svc-1/visit-texts': { enabled: true, hidden: 0, texts: [{ id: 'a', direction: 'inbound', at: '2026-11-20T15:00:00.000Z', body: 'Visit one text', photos: [] }] },
      '/admin/schedule/svc-2/visit-texts': new Promise(() => {}),
    };
    const request = vi.fn((path) => { const a = answers[path.split('?')[0]]; return a instanceof Promise ? a : Promise.resolve(a); });
    const { rerender } = render(<VisitTextsSection service={SVC1} byService={ON} request={request} />);
    expect(await screen.findByText('Visit one text')).toBeInTheDocument();
    rerender(<VisitTextsSection service={{ id: 'svc-2', customer_id: 'cust-1', scheduled_date: '2026-11-26' }} byService={ON} request={request} />);
    expect(screen.queryByText('Visit one text')).toBeNull();
    expect(request).toHaveBeenCalledWith('/admin/schedule/svc-2/visit-texts?customerId=cust-1&scheduledDate=2026-11-26');
  });
});

describe('signed photo links expire after an hour', () => {
  const answer = (n) => ({ enabled: true, hidden: 0, texts: [{ id: `t${n}`, direction: 'inbound', at: '2026-11-20T15:00:00.000Z', body: `Read ${n}`, photos: [{ url: `https://signed.example/${n}`, contentType: 'image/jpeg' }] }] });

  it('withholds stale links on resume and reads again', async () => {
    let n = 0;
    const request = vi.fn(async () => answer(++n));
    renderWith(request);
    expect(await screen.findByText('Read 1')).toBeInTheDocument();
    const realNow = Date.now();
    const spy = vi.spyOn(Date, 'now').mockReturnValue(realNow + 51 * 60 * 1000);
    window.dispatchEvent(new Event('focus'));
    expect(await screen.findByText('Read 2')).toBeInTheDocument();
    expect(request).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });

  it('does not read again on a resume inside the hour', async () => {
    const request = vi.fn(async () => answer(1));
    renderWith(request);
    await screen.findByText('Read 1');
    window.dispatchEvent(new Event('focus'));
    await wait();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('reads again before the hour ends while the panel stays open', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let n = 0;
      const request = vi.fn(async () => answer(++n));
      renderWith(request);
      await screen.findByText('Read 1');
      await act(async () => { vi.advanceTimersByTime(50 * 60 * 1000 + 10); });
      await screen.findByText('Read 2');
    } finally { vi.useRealTimers(); }
  });
});

describe('the visit\'s customer and date', () => {
  const texts = (body) => ({ enabled: true, hidden: 0, texts: [{ id: body, direction: 'inbound', at: '2026-11-20T15:00:00.000Z', body, photos: [] }] });

  it('clears the shown texts at once and reads again when the customer or the date changes', async () => {
    let n = 0;
    const request = vi.fn(() => (++n === 1 ? Promise.resolve(texts('First customer text')) : new Promise(() => {})));
    const { rerender } = render(<VisitTextsSection service={SVC1} byService={ON} request={request} />);
    expect(await screen.findByText('First customer text')).toBeInTheDocument();
    rerender(<VisitTextsSection service={{ ...SVC1, customer_id: 'cust-2' }} byService={ON} request={request} />);
    expect(screen.queryByText('First customer text')).toBeNull();
    expect(request).toHaveBeenCalledTimes(2);
    rerender(<VisitTextsSection service={{ ...SVC1, customer_id: 'cust-2', scheduled_date: '2026-11-30' }} byService={ON} request={request} />);
    expect(screen.queryByText('First customer text')).toBeNull();
    expect(request).toHaveBeenCalledTimes(3);
  });
});

describe('in the Visit Brief', () => {
  const SERVICE = { id: 'svc-1', customer_id: 'cust-1', scheduled_date: '2026-11-26', status: 'confirmed', customerName: 'Pat Sample', address: '123 Palm Ave, Bradenton, FL 34205', serviceType: 'Quarterly Pest Control' };
  const stop = { key: 'row:svc-1', isVisit: false, services: [SERVICE], primary: SERVICE, liveCount: 1 };
  const panel = (brief, request) => render(<VisitBriefPanel stop={stop} detail={{ status: 'ready', byService: { 'svc-1': { brief } } }} request={request} />);
  const texts = { enabled: true, hidden: 0, texts: [{ id: 't1', direction: 'inbound', at: '2026-11-20T15:00:00.000Z', body: 'Gate code changed', photos: [] }] };

  it('reads the texts only when the brief says the gate is on', async () => {
    const request = vi.fn(async () => texts);
    panel({ brief: null, visitTexts: true }, request);
    expect(await screen.findByText('Gate code changed')).toBeInTheDocument();
    expect(request).toHaveBeenCalledWith('/admin/schedule/svc-1/visit-texts?customerId=cust-1&scheduledDate=2026-11-26');
  });

  it('asks for nothing when the visit has no customer id or date to name', async () => {
    const request = vi.fn(async () => texts);
    render(<VisitTextsSection service={{ id: 'svc-1' }} byService={ON} request={request} />);
    await wait();
    expect(request).not.toHaveBeenCalled();
  });

  it('asks for nothing when the brief carries no flag', async () => {
    const request = vi.fn(async () => texts);
    panel({ brief: null }, request);
    await wait();
    expect(request).not.toHaveBeenCalledWith(expect.stringContaining('/visit-texts'));
    expect(screen.queryByText('Customer texts · last 7 days')).toBeNull();
  });
});
