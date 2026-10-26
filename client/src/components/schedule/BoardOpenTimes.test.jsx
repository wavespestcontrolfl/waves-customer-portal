// @vitest-environment jsdom
// Open times on the Dispatch board (owner 2026-10-26, "start step 4";
// GATE_BOARD_OPEN_TIMES): the drag-time search, its fits and the lit hours.
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, renderHook, screen, waitFor } from '@testing-library/react';
import { boardFits, LitHours, useBoardOpenTimes } from './BoardOpenTimes';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const hour = (start, detour, techId, over = {}) => ({
  start_time: start, end_time: `${String(Number(start.slice(0, 2)) + 1).padStart(2, '0')}:00`,
  detour_minutes: detour, technician: { id: techId, name: techId }, rain_tier: null, ...over,
});
const answer = (days) => ({ slots: [], summary: { days, open_times: { from: days[0].date, to: days[days.length - 1].date } } });
const VISIT = { id: 'svc-1', customerId: 'cust-1', serviceType: 'Pest Control', technicianId: 't1' };
const duration = () => 60;

describe('boardFits', () => {
  it('lists every hour on every route, skips a closed day, and answers nothing without the list', () => {
    const fits = boardFits(answer([
      { date: '2035-01-02', status: 'open', hours: [hour('09:00', 12, 't1'), hour('09:00', 40, 't2', { rain_tier: 2 })] },
      { date: '2035-01-07', status: 'open', closed: true, hours: [hour('10:00', 1, 't1')] },
    ]));
    expect(fits).toEqual([
      { date: '2035-01-02', techId: 't1', startMin: 540, detourMinutes: 12, driveSource: null, rainTier: null },
      { date: '2035-01-02', techId: 't2', startMin: 540, detourMinutes: 40, driveSource: null, rainTier: 2 },
    ]);
    expect(boardFits({ slots: [], summary: { days: [] } })).toBeNull();
    expect(boardFits(null)).toBeNull();
  });
});

describe('useBoardOpenTimes', () => {
  const stubFind = (days) => {
    const fetch = vi.fn(async () => ({ ok: true, json: async () => answer(days) }));
    vi.stubGlobal('fetch', fetch);
    return fetch;
  };
  it('the day grid: one search for that day on every route; the best fit is the least added drive', async () => {
    const fetch = stubFind([{ date: '2035-01-02', status: 'open', hours: [hour('09:00', 12, 't1'), hour('11:00', 4, 't2')] }]);
    const { result } = renderHook(() => useBoardOpenTimes({ enabled: true, service: VISIT, durationOf: duration, dates: ['2035-01-02'] }));
    await waitFor(() => expect(result.current.fits).toHaveLength(2));
    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(body).toMatchObject({
      hint: true, summary: true, openTimes: true, arrivalWindows: true, serviceId: 'svc-1', customerId: 'cust-1',
      serviceType: 'Pest Control', durationMinutes: 60, excludeServiceIds: ['svc-1'], dateFrom: '2035-01-02', dateTo: '2035-01-02',
    });
    expect(body).not.toHaveProperty('technicianId');
    expect(result.current.best).toMatchObject({ techId: 't2', startMin: 660 });
  });
  it('the week grid: the visit\'s own route across the shown days; an unassigned visit asks nothing', async () => {
    const fetch = stubFind([{ date: '2035-01-01', status: 'open', hours: [hour('09:00', 5, 't1')] }, { date: '2035-01-05', status: 'full', hours: [] }]);
    const { result, rerender } = renderHook((props) => useBoardOpenTimes({
      enabled: true, durationOf: duration, dates: ['2035-01-01', '2035-01-02', '2035-01-05'], ownRoute: true, ...props,
    }), { initialProps: { service: VISIT } });
    await waitFor(() => expect(result.current.fits).toHaveLength(1));
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({ technicianId: 't1', dateFrom: '2035-01-01', dateTo: '2035-01-05' });
    rerender({ service: { ...VISIT, id: 'svc-2', technicianId: null } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(result.current).toEqual({ fits: null, best: null });
  });
  it('gate off or nothing dragged: no search, nothing lit', async () => {
    const fetch = stubFind([{ date: '2035-01-02', status: 'open', hours: [hour('09:00', 5, 't1')] }]);
    const { result, rerender } = renderHook((props) => useBoardOpenTimes({ durationOf: duration, dates: ['2035-01-02'], ...props }), {
      initialProps: { enabled: false, service: VISIT },
    });
    rerender({ enabled: true, service: null });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetch).not.toHaveBeenCalled();
    expect(result.current).toEqual({ fits: null, best: null });
  });
});

describe('LitHours', () => {
  it('each fit shows what it adds, amber over 30 min, and only the best one is tagged', () => {
    const fits = [
      { date: '2035-01-02', techId: 't1', startMin: 540, detourMinutes: 4, driveSource: null, rainTier: null },
      { date: '2035-01-02', techId: 't1', startMin: 720, detourMinutes: 41, driveSource: null, rainTier: null },
    ];
    render(<div style={{ position: 'relative' }}><LitHours fits={fits} best={fits[0]} minutesToTopPx={(m) => m} hourHeight={64} /></div>);
    const lit = screen.getAllByTestId('board-open-time');
    expect(lit.map((el) => el.textContent)).toEqual(['adds ~4 minBest', 'adds ~41 min']);
    expect(lit.map((el) => el.dataset.far)).toEqual([undefined, 'true']);
    expect(lit[0].style.top).toBe('543px');
  });
});
