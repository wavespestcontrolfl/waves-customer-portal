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

  it('keeps each tech proximity order when techs interleave (no comparator cycle)', () => {
    fetch.mockResolvedValue({ ok: true, json: async () => ({}) });
    // Tech 1: the 12:00 stop is nearer, so it goes before the 11:30 stop.
    // Tech 2 has an 11:45 stop between them. A pairwise same-tech override
    // cycles here (12:00<11:30 by order, 11:30<11:45, 11:45<12:00 by time).
    const t1Late = {
      ...SERVICE, id: 'svc-t1-late', customerName: 'T1 Noon Customer',
      technicianId: 'tech-1', windowStart: '12:00', displayOrder: 0,
    };
    const t1Early = {
      ...SERVICE, id: 'svc-t1-early', customerName: 'T1 Half Customer',
      technicianId: 'tech-1', windowStart: '11:30', displayOrder: 1,
    };
    const t2 = {
      ...SERVICE, id: 'svc-t2', customerName: 'T2 Customer',
      technicianId: 'tech-2', windowStart: '11:45', displayOrder: 0,
    };
    const expected = ['T2 Customer', 'T1 Noon Customer', 'T1 Half Customer'];
    [[t1Early, t2, t1Late], [t2, t1Late, t1Early], [t1Late, t1Early, t2]].forEach((services) => {
      const { unmount } = render(
        <MobileDispatchList
          mode="day"
          date="2026-07-15"
          services={services}
          technicians={[{ id: 'tech-1', name: 'Tech One' }, { id: 'tech-2', name: 'Tech Two' }]}
        />,
      );
      const names = screen.getAllByText(/Customer$/).map((el) => el.textContent);
      expect(names).toEqual(expected);
      unmount();
    });
  });

  it('keeps one tech displayOrder when another tech equal-time row sits between', () => {
    fetch.mockResolvedValue({ ok: true, json: async () => ({}) });
    const aFar = {
      ...SERVICE, id: 'svc-a-far', customerName: 'A Far Customer',
      technicianId: 'tech-a', windowStart: '12:00', displayOrder: 1,
    };
    const bOnly = {
      ...SERVICE, id: 'svc-b', customerName: 'B Only Customer',
      technicianId: 'tech-b', windowStart: '12:00', displayOrder: 0,
    };
    const aNear = {
      ...SERVICE, id: 'svc-a-near', customerName: 'A Near Customer',
      technicianId: 'tech-a', windowStart: '12:00', displayOrder: 0,
    };
    render(
      <MobileDispatchList
        mode="day"
        date="2026-07-15"
        services={[aFar, bOnly, aNear]}
        technicians={[{ id: 'tech-a', name: 'Tech A' }, { id: 'tech-b', name: 'Tech B' }]}
      />,
    );
    const names = screen.getAllByText(/Customer$/).map((el) => el.textContent)
      .filter((n) => n.startsWith('A '));
    expect(names).toEqual(['A Near Customer', 'A Far Customer']);
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

describe('MobileDispatchList open hours', () => {
  it('places a bookable block on each empty hour and pre-fills New appointment', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-07-15T10:00:00Z')); // 6:00 AM ET
    const onCreateSlot = vi.fn();
    render(
      <MobileDispatchList
        mode="day"
        date="2026-07-15"
        services={[SERVICE, { ...SERVICE, id: 'svc-2', windowStart: '10:00', windowEnd: '11:00' }]}
        technicians={[{ id: 'tech-1', name: 'Alex Tech' }]}
        onCreateSlot={onCreateSlot}
      />,
    );
    vi.useRealTimers();

    expect(screen.getByText('· 10 open', { exact: false })).toBeInTheDocument();
    const rows = screen.getAllByRole('button', { name: /^Book open hour/ });
    expect(rows.map((b) => b.getAttribute('aria-label'))).toEqual([
      'Book open hour 7–8 AM',
      'Book open hour 9–10 AM',
      'Book open hour 11 AM–12 PM',
      'Book open hour 12–1 PM',
      'Book open hour 1–2 PM',
      'Book open hour 2–3 PM',
      'Book open hour 3–4 PM',
      'Book open hour 4–5 PM',
      'Book open hour 5–6 PM',
      'Book open hour 6–7 PM',
    ]);
    // The 9 AM block sits between the 8 AM and 10 AM visits.
    const nineAm = rows[1];
    const names = screen.getAllByText('Pat Sample');
    expect(names[0].compareDocumentPosition(nineAm) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(nineAm.compareDocumentPosition(names[1]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    fireEvent.click(nineAm);
    expect(onCreateSlot).toHaveBeenCalledWith({
      date: '2026-07-15', windowStart: '09:00', windowEnd: '10:00', techId: 'tech-1',
    });
  });
});

describe('MobileDispatchList week open hours', () => {
  it("judges each week day by that day's own absences", async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-07-13T10:00:00Z')); // Mon 6:00 AM ET
    fetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        startDate: '2026-07-13',
        days: [
          { date: '2026-07-14', services: [], outTechIds: ['tech-1'] },
          { date: '2026-07-15', services: [], outTechIds: [] },
        ],
      }),
    });
    render(
      <MobileDispatchList
        mode="week"
        date="2026-07-14"
        technicians={[{ id: 'tech-1', name: 'Alex Tech', outToday: false }]}
        onCreateSlot={vi.fn()}
      />,
    );
    await waitFor(() => expect(screen.getAllByRole('button', { name: /^Book open hour/ })).toHaveLength(12));
    vi.useRealTimers();
  });
});

describe('MobileDispatchList open hours with two techs', () => {
  it('keeps an hour open while another tech is free, and preselects that tech', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-07-15T10:00:00Z')); // 6:00 AM ET
    const onCreateSlot = vi.fn();
    render(
      <MobileDispatchList
        mode="day"
        date="2026-07-15"
        services={[{ ...SERVICE, technicianId: 'tech-a', windowStart: '09:00', windowEnd: '10:00' }]}
        technicians={[{ id: 'tech-a', name: 'A Tech' }, { id: 'tech-b', name: 'B Tech' }]}
        onCreateSlot={onCreateSlot}
      />,
    );
    vi.useRealTimers();
    fireEvent.click(screen.getByRole('button', { name: 'Book open hour 9–10 AM' }));
    expect(onCreateSlot).toHaveBeenCalledWith(expect.objectContaining({ windowStart: '09:00', techId: 'tech-b' }));
    fireEvent.click(screen.getByRole('button', { name: 'Book open hour 10–11 AM' }));
    expect(onCreateSlot).toHaveBeenLastCalledWith(expect.objectContaining({ windowStart: '10:00', techId: undefined }));
  });
});
