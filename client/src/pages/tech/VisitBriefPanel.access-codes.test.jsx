// @vitest-environment jsdom
// Visit brief: the customer's access codes, read only. Active standing codes
// plus one-visit codes tied to a visit of this stop, read per visit; nothing
// when the read is refused (section off, or not this technician's visit). Synthetic data only.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import VisitBriefPanel from './VisitBriefPanel';

afterEach(cleanup);

const SERVICE = {
  id: 'svc-1', customer_id: 'cust-1', status: 'confirmed', customerName: 'Pat Sample',
  address: '123 Palm Ave, Bradenton, FL 34205', serviceType: 'Quarterly Pest Control',
};
const stop = { key: 'row:svc-1', isVisit: false, services: [SERVICE], primary: SERVICE, liveCount: 1 };

const code = (over = {}) => ({
  id: 'c1', kind: 'lockbox', code: '1234', instructions: 'On the back fence', life: 'standing', scheduledServiceId: null, status: 'active', ...over,
});

const renderPanel = (request, detail = { status: 'ready', byService: {} }) => render(
  <VisitBriefPanel stop={stop} detail={detail} request={request} />,
);

describe('VisitBriefPanel access codes', () => {
  it('shows standing codes and codes tied to this visit, not another visit', async () => {
    const request = vi.fn(() => Promise.resolve({ accessCodes: [
      code(),
      code({ id: 'c2', kind: 'door', code: '5555', instructions: null, life: 'visit', scheduledServiceId: 'svc-1' }),
      code({ id: 'c3', kind: 'garage', code: '7777', instructions: null, life: 'visit', scheduledServiceId: 'svc-other' }),
    ] }));
    renderPanel(request);
    expect(await screen.findByText('1234')).toBeInTheDocument();
    expect(screen.getByText('5555')).toBeInTheDocument();
    expect(screen.getByText('Door or lock (this visit):')).toBeInTheDocument();
    expect(screen.getByText(/On the back fence/)).toBeInTheDocument();
    expect(screen.queryByText('7777')).toBeNull();
    expect(request).toHaveBeenCalledWith('/admin/access-codes/visits/svc-1');
  });

  it('shows a pass link as an Open visitor pass button, never as raw text', async () => {
    const request = vi.fn(() => Promise.resolve({ accessCodes: [
      code({ id: 'p1', kind: 'pass', code: null, instructions: 'View your pass: https://pass.example.com/v/abc123.' }),
      code({ id: 'p2', kind: 'pass', code: null, instructions: 'Scan the QR at the guard house' }),
      code({ id: 'p3', kind: 'pass', code: null, instructions: 'Not secure http://pass.example.com/v/x and javascript:alert(1)' }),
    ] }));
    renderPanel(request);
    const button = await screen.findByRole('link', { name: 'Open visitor pass' });
    expect(button).toHaveAttribute('href', 'https://pass.example.com/v/abc123');
    expect(button).toHaveAttribute('target', '_blank');
    expect(button).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.queryByText(/pass\.example\.com\/v\/abc123/)).toBeNull();
    expect(screen.getByText(/View your pass:/)).toBeInTheDocument();
    expect(screen.getByText(/Scan the QR at the guard house/)).toBeInTheDocument();
    // Only an https link becomes a button; an http link stays text.
    expect(screen.getAllByRole('link', { name: 'Open visitor pass' })).toHaveLength(1);
    expect(screen.getByText(/http:\/\/pass\.example\.com\/v\/x/)).toBeInTheDocument();
  });

  it('keeps raw text for a note that is not a pass, and for alerts, even when they hold a link', async () => {
    const service = { ...SERVICE, propertyAlerts: [{ type: 'gate', text: 'Gate: https://pass.example.com/v/hood1 (neighborhood)' }] };
    const request = vi.fn(() => Promise.resolve({ accessCodes: [
      code({ id: 'o1', kind: 'other', code: null, instructions: 'Directions: https://maps.example.com/gate' }),
    ] }));
    render(<VisitBriefPanel stop={{ ...stop, services: [service], primary: service }} detail={{ status: 'ready', byService: {} }} request={request} />);
    expect(await screen.findByText(/https:\/\/maps\.example\.com\/gate/)).toBeInTheDocument();
    expect(screen.getByText(/https:\/\/pass\.example\.com\/v\/hood1/)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Open visitor pass' })).toBeNull();
  });

  it('labels a pass shared by a neighbor and shows its link as the button', async () => {
    const request = vi.fn(() => Promise.resolve({ accessCodes: [
      code({ id: 'p9', kind: 'pass', code: null, instructions: 'View your pass: https://pass.example.com/v/n1', shared: true }),
    ] }));
    renderPanel(request);
    expect(await screen.findByText('Visitor pass (neighborhood):')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open visitor pass' })).toHaveAttribute('href', 'https://pass.example.com/v/n1');
  });

  it('shows nothing, with no error, when the list is refused', async () => {
    const request = vi.fn(() => Promise.reject(Object.assign(new Error('nope'), { status: 404 })));
    renderPanel(request);
    await waitFor(() => expect(request).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 10));
    expect(screen.queryByText('Access codes')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('clears the previous stop\'s codes as soon as the stop changes', async () => {
    let resolveSecond;
    const request = vi.fn((url) => (url.endsWith('svc-1')
      ? Promise.resolve({ accessCodes: [code()] })
      : new Promise((r) => { resolveSecond = r; })));
    const view = renderPanel(request);
    expect(await screen.findByText('1234')).toBeInTheDocument();
    const other = { ...SERVICE, id: 'svc-2', customer_id: 'cust-2' };
    view.rerender(<VisitBriefPanel stop={{ ...stop, key: 'row:svc-2', services: [other], primary: other }} detail={{ status: 'ready', byService: {} }} request={request} />);
    await waitFor(() => expect(screen.queryByText('1234')).toBeNull());
    resolveSecond({ accessCodes: [] });
  });

  it('says so, with a retry, when the read fails for another reason', async () => {
    let calls = 0;
    const request = vi.fn(() => { calls += 1; return calls === 1 ? Promise.reject(Object.assign(new Error('timeout'), { status: 504 })) : Promise.resolve({ accessCodes: [code()] }); });
    renderPanel(request);
    expect(await screen.findByRole('alert')).toHaveTextContent("Could not load this stop's access codes");
    screen.getByRole('button', { name: 'Try again' }).click();
    expect(await screen.findByText('1234')).toBeInTheDocument();
  });

  it('shows a code that equals a profile code of ANOTHER access point', async () => {
    const request = vi.fn(() => Promise.resolve({ accessCodes: [code({ id: 'd1', kind: 'door', code: '4321', instructions: null })] }));
    render(<VisitBriefPanel stop={stop} detail={{ status: 'ready', byService: { 'svc-1': { access: { codes: { neighborhoodGate: '4321' } } } } }} request={request} />);
    expect(await screen.findByText('Door or lock:')).toBeInTheDocument();
  });

  const withFacts = (codes) => ({ status: 'ready', byService: { 'svc-1': { brief: { brief: null, facts: { access: { codes, alerts: [] } } } } } });
  const garageRow = (over = {}) => code({ id: 'g1', kind: 'garage', code: '2468', instructions: null, profileBacked: true, ...over });

  it('one-home visit, profile facts received: the profileBacked row is hidden and the profile code shows once', async () => {
    const request = vi.fn(() => Promise.resolve({ accessCodes: [garageRow(), code({ id: 'd1', kind: 'door', code: '4321', instructions: null })] }));
    render(<VisitBriefPanel stop={stop} detail={withFacts({ garage: '2468', neighborhoodGate: '#4821' })} request={request} />);
    expect(await screen.findByText('Door or lock:')).toBeInTheDocument();
    expect(screen.getAllByText('2468')).toHaveLength(1);
    expect(screen.getAllByText('#4821')).toHaveLength(1);
  });

  it('one-home visit, profile facts missing: the profileBacked row is shown', async () => {
    const request = vi.fn(() => Promise.resolve({ accessCodes: [garageRow()] }));
    render(<VisitBriefPanel stop={stop} detail={{ status: 'ready', byService: {} }} request={request} />);
    expect(await screen.findByText('2468')).toBeInTheDocument();
    expect(screen.getByText('Garage:')).toBeInTheDocument();
  });

  it('one-home visit: facts for another kind do not hide the row, and a row with directions for the same code stays', async () => {
    const request = vi.fn(() => Promise.resolve({ accessCodes: [garageRow(), garageRow({ id: 'g2', instructions: 'Side keypad' })] }));
    render(<VisitBriefPanel stop={stop} detail={withFacts({ lockbox: '1212' })} request={request} />);
    expect(await screen.findAllByText('2468')).toHaveLength(2);
    cleanup();
    render(<VisitBriefPanel stop={stop} detail={withFacts({ garage: '2468' })} request={vi.fn(() => Promise.resolve({ accessCodes: [garageRow(), garageRow({ id: 'g2', instructions: 'Side keypad' })] }))} />);
    expect(await screen.findByText(/Side keypad/)).toBeInTheDocument();
    // the profile line plus the row with directions
    expect(screen.getAllByText('2468')).toHaveLength(2);
  });

  it('a code that differs from the profile code only by spaces is shown once', async () => {
    const request = vi.fn(() => Promise.resolve({ accessCodes: [garageRow({ code: '#4821', kind: 'neighborhood_gate' })] }));
    render(<VisitBriefPanel stop={stop} detail={withFacts({ neighborhoodGate: '# 4821' })} request={request} />);
    expect(await screen.findByText('# 4821')).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText('#4821')).toBeNull();
  });

  it('one-home visit: a stale cached profile code does not hide the current row', async () => {
    const request = vi.fn(() => Promise.resolve({ accessCodes: [garageRow({ code: '1357' })] }));
    render(<VisitBriefPanel stop={stop} detail={withFacts({ garage: '2468' })} request={request} />);
    expect(await screen.findByText('1357')).toBeInTheDocument();
  });

  it('multi-home visit: rows carry no flag, so only the same-kind value dedupe applies', async () => {
    const request = vi.fn(() => Promise.resolve({ accessCodes: [
      garageRow({ profileBacked: undefined }),
      garageRow({ id: 'g3', code: '9999', profileBacked: undefined }),
    ] }));
    render(<VisitBriefPanel stop={stop} detail={withFacts({ garage: '2468' })} request={request} />);
    // 2468 is the same kind and value as the profile line (deduped); 9999 is a different code and shows
    expect(await screen.findByText('9999')).toBeInTheDocument();
    expect(screen.getAllByText('2468')).toHaveLength(1);
  });

  it('does not ask without a request function', () => {
    render(<VisitBriefPanel stop={stop} detail={{ status: 'ready', byService: {} }} />);
    expect(screen.queryByText('Access codes')).toBeNull();
  });
});
