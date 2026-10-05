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

  it('does not ask without a request function', () => {
    render(<VisitBriefPanel stop={stop} detail={{ status: 'ready', byService: {} }} />);
    expect(screen.queryByText('Access codes')).toBeNull();
  });
});
