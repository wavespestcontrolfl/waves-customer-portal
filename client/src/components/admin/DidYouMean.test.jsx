// @vitest-environment jsdom
import React from 'react';
import "@testing-library/jest-dom/vitest";
import { MemoryRouter } from 'react-router-dom';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useDiscountStackingState } from '../../hooks/useDiscountStacking';
vi.mock('../../hooks/useDiscountStacking', () => ({
  useDiscountStackingState: vi.fn(() => ({ enabled: false, known: true, retry: vi.fn() })),
  ensureStackingFresh: vi.fn(async () => ({ enabled: true, known: true })),
}));
vi.mock('../../utils/admin-fetch', () => ({
  adminFetch: vi.fn(),
  isRateLimitError: () => false,
}));
import DidYouMean, { isApproximateRow, splitApproximate } from './DidYouMean';
import CustomerDirectoryTable from './CustomerDirectoryTable';
import ScheduleClientSearch from '../schedule/ScheduleClientSearch';
import CreateAppointmentModal from '../schedule/CreateAppointmentModal';
import { adminFetch } from '../../utils/admin-fetch';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.mocked(adminFetch).mockReset();
  vi.mocked(useDiscountStackingState).mockReturnValue({ enabled: false, known: true, retry: vi.fn() });
});

const exact = { id: 'e1', firstName: 'Orlan', lastName: 'Stompf', phone: '+19415550001', address: '1 Sample Way' };
const sound = { id: 's1', firstName: 'Orlan', lastName: 'Stimpf', phone: '+19415550002', address: '2 Sample Way', approximate: true, matchReasons: [] };

describe('splitApproximate', () => {
  it('keeps the exact rows first and finds the first approximate row', () => {
    expect(isApproximateRow(sound)).toBe(true);
    expect(isApproximateRow(exact)).toBe(false);
    const split = splitApproximate([sound, exact]);
    expect(split.rows.map((r) => r.id)).toEqual(['e1', 's1']);
    expect(split.firstApproximateIndex).toBe(1);
    expect(splitApproximate([exact]).firstApproximateIndex).toBe(-1);
    expect(splitApproximate(undefined).rows).toEqual([]);
  });
});

describe('DidYouMean', () => {
  it('renders the divider', () => {
    render(<DidYouMean />);
    expect(screen.getByRole('separator', { name: 'Did you mean' })).toBeInTheDocument();
  });
});

describe('CustomerDirectoryTable (Customers page)', () => {
  const table = (customers) => render(<CustomerDirectoryTable customers={customers} onSort={() => {}} onOpen={() => {}} />);

  it('puts one "Did you mean" divider before the first approximate row', () => {
    table([exact, sound, { ...sound, id: 's2', lastName: 'Stampf' }]);
    expect(screen.getAllByTestId('did-you-mean')).toHaveLength(1);
    const rows = screen.getAllByRole('row').map((row) => row.textContent);
    const at = rows.findIndex((text) => text.includes('Did you mean'));
    expect(rows[at - 1]).toContain('Orlan Stompf');
    expect(rows[at + 1]).toContain('Orlan Stimpf');
  });

  it('shows no divider when every row is exact', () => {
    table([exact]);
    expect(screen.queryByTestId('did-you-mean')).toBeNull();
  });
});

describe('ScheduleClientSearch', () => {
  const svc = (id, customerId, customerName, extra = {}) => ({
    id, customerId, customerName, serviceType: 'Pest Control', scheduledDate: '2099-01-05', windowStart: '08:00', windowEnd: '10:00', ...extra,
  });

  it('shows sound-alike customers under a "Did you mean" divider after the exact ones', async () => {
    vi.mocked(adminFetch).mockResolvedValue({
      services: [svc('a1', 'c1', 'Orlan Stompf'), svc('b1', 'c2', 'Orlan Stimpf', { approximate: true, matchReasons: [] })],
      approximateCount: 1,
    });
    render(<ScheduleClientSearch onSelect={() => {}} />);
    const input = screen.getByLabelText('Search clients for upcoming appointments');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'Orlan Stompf' } });
    await waitFor(() => expect(screen.getByTestId('did-you-mean')).toBeInTheDocument(), { timeout: 2000 });
    const text = document.body.textContent;
    expect(text.indexOf('Orlan Stompf')).toBeLessThan(text.indexOf('Did you mean'));
    expect(text.indexOf('Did you mean')).toBeLessThan(text.indexOf('Orlan Stimpf'));
    expect(screen.getAllByTestId('did-you-mean')).toHaveLength(1);
  });

  it('shows no divider when the server returns only exact rows', async () => {
    vi.mocked(adminFetch).mockResolvedValue({ services: [svc('a1', 'c1', 'Orlan Stompf')] });
    render(<ScheduleClientSearch onSelect={() => {}} />);
    const input = screen.getByLabelText('Search clients for upcoming appointments');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'Orlan Stompf' } });
    await screen.findByText('Orlan Stompf', {}, { timeout: 2000 });
    expect(screen.queryByTestId('did-you-mean')).toBeNull();
  });
});

describe('CreateAppointmentModal customer picker', () => {
  it('lists sound-alike customers under "Did you mean", after the exact ones', async () => {
    const reply = (body) => ({ ok: true, status: 200, json: async () => body });
    vi.stubGlobal('fetch', vi.fn(async (url) => (String(url).includes('/admin/customers?search=')
      ? reply({ customers: [exact, sound], total: 1, approximateCount: 1 })
      : reply({}))));
    render(<MemoryRouter><CreateAppointmentModal onClose={() => {}} onCreated={() => {}} onChange={() => {}} /></MemoryRouter>);
    fireEvent.change(screen.getByPlaceholderText('Search by name or phone...'), { target: { value: 'Orlan Stompf' } });
    await screen.findByText(/Stimpf/);
    expect(screen.getAllByTestId('did-you-mean')).toHaveLength(1);
    const text = document.body.textContent;
    expect(text.indexOf('Orlan Stompf')).toBeLessThan(text.indexOf('Did you mean'));
    expect(text.indexOf('Did you mean')).toBeLessThan(text.indexOf('Orlan Stimpf'));
  });
});
