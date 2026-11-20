// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ProtocolAudit from './ProtocolAudit';
import { adminFetch } from '../../lib/adminFetch';

vi.mock('../../lib/adminFetch', () => ({ adminFetch: vi.fn() }));

const reply = (body, ok = true, status = ok ? 200 : 400) => Promise.resolve({ ok, status, json: async () => body });
const VISIT = (over = {}) => ({
  scheduledServiceId: 'visit-1', recordId: 'rec-1', technicianId: 'tech-a', month: '2026-04', serviceDate: '2026-04-10', serviceType: 'Lawn Care Treatment', serviceLine: 'lawn',
  protocolName: 'Sample protocol', areaSqft: 5000, customerName: 'Sample Customer',
  products: [
    { name: 'Sample Product', rate: 2.5, rateUnit: 'oz/1000 sq ft', totalAmount: null, amountUnit: null, area: '5000 sq ft', targets: ['chinch bugs'] },
    { name: 'Total Only Product', rate: null, rateUnit: null, totalAmount: 12, amountUnit: 'oz', area: null, targets: [] },
  ],
  counts: { products: 2, photos: 2, photosByType: { before: 1, after: 1 } },
  photos: [{ id: 'p1', type: 'before', caption: 'Front lawn', url: 'https://photos.test/a.jpg' }, { id: 'p2', type: 'after', caption: null, url: null }],
  audit: null, ...over,
});
const BOARD = (visits) => ({ month: '2026-04', sampleSize: 5, technicians: [{ id: 'tech-a', name: 'Sample Alpha', eligibleCount: 9, markedCount: visits.filter(v => v.audit).length, visits }] });

let calls;
let refusal;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-04-20T15:00:00.000Z'));
  calls = []; refusal = null;
  adminFetch.mockReset();
  adminFetch.mockImplementation((path, options = {}) => {
    calls.push({ path, method: options.method, body: options.body });
    if (options.method === 'PUT') {
      if (refusal) return reply({ error: refusal }, false, 409);
      return reply({ mark: { scheduledServiceId: 'visit-1', result: options.body.result, note: options.body.note || null, auditedAt: '2026-04-20T15:00:00Z' } });
    }
    return reply(BOARD([VISIT(), VISIT({ scheduledServiceId: 'visit-2', serviceDate: '2026-04-12', audit: { result: 'match', note: null, auditedAt: '2026-04-13T10:00:00Z' } })]));
  });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('Protocol audit tab', () => {
  it('loads this ET month and shows each sampled visit with products, targets, counts and photos', async () => {
    render(<ProtocolAudit />);
    const tech = await screen.findByRole('region', { name: 'Audit for Sample Alpha' });
    expect(calls[0].path).toBe('/admin/tech-protocol-audits?month=2026-04');
    expect(within(tech).getByText(/1 of 2 marked · 9 eligible visits/)).toBeInTheDocument();
    const visit = within(tech).getAllByRole('heading', { level: 3 })[1];
    expect(visit).toHaveTextContent('Apr 10, 2026 · Lawn Care Treatment');
    expect(within(tech).getAllByText(/2 products · 2 photos \(1 before, 1 after\)/)).toHaveLength(2);
    expect(within(tech).getAllByText('Sample Product')).toHaveLength(2);
    expect(within(tech).getAllByText('chinch bugs')).toHaveLength(2);
    expect(within(tech).getAllByText('total 12 oz')).toHaveLength(2); // a recorded total shows even with no rate or area
    expect(within(tech).getAllByAltText('Front lawn')[0]).toHaveAttribute('src', 'https://photos.test/a.jpg');
    expect(within(tech).getAllByText('Photo unavailable')).toHaveLength(2);
  });

  it('a mismatch needs a note; a match saves with no note and shows the new mark', async () => {
    render(<ProtocolAudit />);
    const card = (await screen.findAllByRole('form', { name: 'Mark this visit' }))[0];
    fireEvent.click(within(card).getByLabelText('Mismatch'));
    fireEvent.click(within(card).getByRole('button', { name: 'Save mark' }));
    expect(await within(card).findByText('A mismatch needs a note.')).toBeInTheDocument();
    expect(calls.some(c => c.method === 'PUT')).toBe(false);
    fireEvent.click(within(card).getByLabelText('Match'));
    fireEvent.click(within(card).getByRole('button', { name: 'Save mark' }));
    await waitFor(() => expect(calls.find(c => c.method === 'PUT')).toBeTruthy());
    expect(calls.find(c => c.method === 'PUT')).toMatchObject({ path: '/admin/tech-protocol-audits/visits/visit-1', body: { result: 'match', note: '', technicianId: 'tech-a', month: '2026-04', recordId: 'rec-1' } });
    expect(await screen.findByText(/2 of 2 marked/)).toBeInTheDocument();
  });

  it('shows the server refusal on the visit and changes the month', async () => {
    refusal = 'this visit is not in the sample';
    render(<ProtocolAudit />);
    const card = (await screen.findAllByRole('form', { name: 'Mark this visit' }))[0];
    fireEvent.click(within(card).getByLabelText('Match'));
    fireEvent.click(within(card).getByRole('button', { name: 'Save mark' }));
    expect(await within(card).findByText('this visit is not in the sample')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Month'), { target: { value: '2026-03' } });
    await waitFor(() => expect(calls.some(c => c.path === '/admin/tech-protocol-audits?month=2026-03')).toBe(true));
  });

  it('says so when the month has no eligible visits', async () => {
    adminFetch.mockImplementation(() => reply({ month: '2026-04', sampleSize: 5, technicians: [] }));
    render(<ProtocolAudit />);
    expect(await screen.findByText(/No completed lawn or tree & shrub visits this month/)).toBeInTheDocument();
  });
});

describe('Protocol audit tab, a stale mark', () => {
  it('shows Needs re-check on a visit whose old mark no longer counts', async () => {
    adminFetch.mockImplementation(() => reply(BOARD([VISIT({ needsRecheck: true })])));
    render(<ProtocolAudit />);
    expect(await screen.findByText(/Needs re-check/)).toBeInTheDocument();
    expect(screen.getByText(/0 of 1 marked/)).toBeInTheDocument();
  });
});

describe('Protocol audit tab, re-marking a stale visit', () => {
  it('clears Needs re-check once the mark is saved', async () => {
    adminFetch.mockImplementation((path, options = {}) => (options.method === 'PUT'
      ? reply({ mark: { scheduledServiceId: 'visit-1', result: 'match', note: null, auditedAt: '2026-04-20T15:00:00Z' } })
      : reply(BOARD([VISIT({ needsRecheck: true })]))));
    render(<ProtocolAudit />);
    const card = await screen.findByRole('form', { name: 'Mark this visit' });
    expect(screen.getByText(/Needs re-check/)).toBeInTheDocument();
    fireEvent.click(within(card).getByLabelText('Match'));
    fireEvent.click(within(card).getByRole('button', { name: 'Save mark' }));
    expect(await screen.findByText('Marked match')).toBeInTheDocument();
    expect(screen.queryByText(/Needs re-check/)).not.toBeInTheDocument();
    expect(screen.getByText(/1 of 1 marked/)).toBeInTheDocument();
  });
});

describe('Protocol audit tab, a save that returns after the month changed', () => {
  it('is dropped and does not break the board', async () => {
    let finishSave;
    adminFetch.mockImplementation((path, options = {}) => {
      if (options.method === 'PUT') return new Promise(resolve => { finishSave = () => resolve({ ok: true, status: 200, json: async () => ({ mark: { scheduledServiceId: 'visit-1', result: 'match', note: null } }) }); });
      return reply(path.includes('2026-03') ? { month: '2026-03', sampleSize: 5, technicians: [] } : BOARD([VISIT()]));
    });
    render(<ProtocolAudit />);
    const card = (await screen.findAllByRole('form', { name: 'Mark this visit' }))[0];
    fireEvent.click(within(card).getByLabelText('Match'));
    fireEvent.click(within(card).getByRole('button', { name: 'Save mark' }));
    await waitFor(() => expect(finishSave).toBeTypeOf('function'));
    fireEvent.change(screen.getByLabelText('Month'), { target: { value: '2026-03' } });
    await screen.findByText(/No completed lawn or tree & shrub visits this month/);
    finishSave();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(screen.getByText(/No completed lawn or tree & shrub visits this month/)).toBeInTheDocument();
  });
});
