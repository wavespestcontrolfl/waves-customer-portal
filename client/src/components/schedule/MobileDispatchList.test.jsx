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

describe('MobileDispatchList protocol opener', () => {
  it('focuses the trigger before opening the protocol panel', () => {
    let focusedAtOpen = null;
    const onProtocol = vi.fn(() => { focusedAtOpen = document.activeElement; });
    render(
      <MobileDispatchList
        mode="day"
        date="2026-07-15"
        services={[SERVICE]}
        onProtocol={onProtocol}
      />,
    );

    const trigger = screen.getByRole('button', { name: 'Protocol' });
    fireEvent.click(trigger);

    expect(onProtocol).toHaveBeenCalledWith(SERVICE);
    expect(focusedAtOpen).toBe(trigger);
  });
});

describe('MobileDispatchList tie-proximity display order', () => {
  it('shows the server displayOrder ahead of raw booking order for a same-tech tie', () => {
    fetch.mockResolvedValue({ ok: true, json: async () => ({}) });
    // Booked (array) order is Far-then-Near; GATE_SCHEDULE_TIE_PROXIMITY's
    // server-computed displayOrder says Near is actually closer to the
    // previous stop, so it must render FIRST despite being booked second.
    const bookedFirstButFarther = {
      ...SERVICE, id: 'svc-far', customerName: 'Far Customer',
      technicianId: 'tech-1', windowStart: '12:00', displayOrder: 1,
    };
    const bookedSecondButNearer = {
      ...SERVICE, id: 'svc-near', customerName: 'Near Customer',
      technicianId: 'tech-1', windowStart: '12:00', displayOrder: 0,
    };
    render(
      <MobileDispatchList
        mode="day"
        date="2026-07-15"
        services={[bookedFirstButFarther, bookedSecondButNearer]}
        technicians={[{ id: 'tech-1', name: 'Alex Tech' }]}
      />,
    );
    const names = screen.getAllByText(/Customer$/).map((el) => el.textContent);
    expect(names).toEqual(['Near Customer', 'Far Customer']);
  });

  it('ignores displayOrder across two different technicians (falls back to windowStart)', () => {
    fetch.mockResolvedValue({ ok: true, json: async () => ({}) });
    // displayOrder is a per-technician index, never comparable across techs
    // — an earlier windowStart must still win even if the OTHER tech's
    // displayOrder happens to be smaller.
    const techATenAM = {
      ...SERVICE, id: 'svc-a', customerName: 'Tech A Customer',
      technicianId: 'tech-a', windowStart: '10:00', displayOrder: 5,
    };
    const techBNoon = {
      ...SERVICE, id: 'svc-b', customerName: 'Tech B Customer',
      technicianId: 'tech-b', windowStart: '12:00', displayOrder: 0,
    };
    render(
      <MobileDispatchList
        mode="day"
        date="2026-07-15"
        services={[techBNoon, techATenAM]}
        technicians={[{ id: 'tech-a', name: 'Tech A' }, { id: 'tech-b', name: 'Tech B' }]}
      />,
    );
    const names = screen.getAllByText(/Customer$/).map((el) => el.textContent);
    expect(names).toEqual(['Tech A Customer', 'Tech B Customer']);
  });

  it('falls back to plain windowStart order when displayOrder is absent (gate off)', () => {
    fetch.mockResolvedValue({ ok: true, json: async () => ({}) });
    const first = { ...SERVICE, id: 'svc-1', customerName: 'First Customer', technicianId: 'tech-1', windowStart: '08:00' };
    const second = { ...SERVICE, id: 'svc-2', customerName: 'Second Customer', technicianId: 'tech-1', windowStart: '09:00' };
    render(
      <MobileDispatchList
        mode="day"
        date="2026-07-15"
        services={[second, first]}
        technicians={[{ id: 'tech-1', name: 'Alex Tech' }]}
      />,
    );
    const names = screen.getAllByText(/Customer$/).map((el) => el.textContent);
    expect(names).toEqual(['First Customer', 'Second Customer']);
  });
});
