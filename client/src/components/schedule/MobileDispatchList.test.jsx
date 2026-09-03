// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import MobileDispatchList from './MobileDispatchList';

const SERVICE = {
  id: 'svc-1',
  customerName: 'Pat Sample',
  address: '1 Test Lane',
  serviceType: 'Pest Control',
  status: 'confirmed',
  windowStart: '08:00',
  windowEnd: '09:00',
};

beforeEach(() => {
  localStorage.setItem('waves_admin_token', 'test-token');
  global.fetch = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('MobileDispatchList technician workflow', () => {
  it('offers technician assignment for an unassigned appointment and refreshes after success', async () => {
    const onRefresh = vi.fn();
    fetch.mockResolvedValue({ ok: true, json: async () => ({}) });

    render(
      <MobileDispatchList
        mode="day"
        date="2026-07-15"
        services={[SERVICE]}
        technicians={[{ id: 'tech-1', name: 'Alex Tech' }]}
        onRefresh={onRefresh}
      />,
    );

    const assignButton = screen.getByRole('button', { name: 'Assign technician' });
    expect(assignButton).toHaveClass('h-11');
    fireEvent.click(assignButton);
    fireEvent.click(screen.getByRole('button', { name: 'Alex Tech' }));

    await waitFor(() => expect(fetch).toHaveBeenCalledWith(
      '/api/admin/schedule/svc-1/assign',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ technicianId: 'tech-1' }),
      }),
    ));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('removes the Week-view En Route action immediately after a successful update', async () => {
    fetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        days: [{ date: '2026-07-15', services: [SERVICE] }],
      }),
    });
    const onEnRoute = vi.fn().mockResolvedValue(true);

    render(
      <MobileDispatchList
        mode="week"
        date="2026-07-15"
        onEnRoute={onEnRoute}
      />,
    );

    const action = await screen.findByRole('button', { name: 'Tech En Route' });
    expect(action).toHaveClass('h-11');
    fireEvent.click(action);

    await waitFor(() => expect(onEnRoute).toHaveBeenCalledWith(expect.objectContaining({ id: 'svc-1' })));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Tech En Route' })).not.toBeInTheDocument());
  });
});

describe('MobileDispatchList closeout-owed badge', () => {
  it('flags a completed stop that still owes its closeout, per the dispatch predicate', () => {
    fetch.mockResolvedValue({ ok: true, json: async () => ({}) });
    const owed = { ...SERVICE, id: 'svc-owed', status: 'completed', technicianId: 'tech-1' };
    const done = { ...SERVICE, id: 'svc-done', customerName: 'Done Customer', status: 'completed', technicianId: 'tech-1' };
    render(
      <MobileDispatchList
        mode="day"
        date="2026-07-15"
        services={[owed, done]}
        technicians={[{ id: 'tech-1', name: 'Alex Tech' }]}
        owesCompletion={(svc) => svc.id === 'svc-owed'}
      />,
    );
    expect(screen.getAllByText('Closeout owed')).toHaveLength(1);
  });

  it('shows no badge when the page passes no predicate', () => {
    fetch.mockResolvedValue({ ok: true, json: async () => ({}) });
    render(
      <MobileDispatchList
        mode="day"
        date="2026-07-15"
        services={[{ ...SERVICE, status: 'completed', technicianId: 'tech-1' }]}
        technicians={[{ id: 'tech-1', name: 'Alex Tech' }]}
      />,
    );
    expect(screen.queryByText('Closeout owed')).not.toBeInTheDocument();
  });
});
