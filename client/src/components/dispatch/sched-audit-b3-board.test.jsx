// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';

import ActionQueuePane from './ActionQueuePane';
import TechCard from './TechCard';
import TechOutSection from './TechOutSection';
import AdminDispatchPage from '../../pages/admin/AdminDispatchPage';

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Schedule & Dispatch audit Batch 3 — Alerts, TechOut, TechCard & AdminDispatchPage', () => {
  it('P1-17 & P0-8: ActionQueuePane shows total truncation banner and explains protected decision cards on Clear', async () => {
    fetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          total: 85,
          alerts: [
            { id: 'al-1', type: 'follow_up_needed', severity: 'warn', created_at: '2026-11-27T15:00:00Z', payload: {} },
            { id: 'al-2', type: 'tech_late', severity: 'critical', created_at: '2026-11-27T14:55:00Z', payload: { delay_minutes: 65 } },
          ],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ resolved: 1, alert_ids: ['al-2'] }),
      });

    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<ActionQueuePane />);

    expect(await screen.findByText('2 / 85')).toBeInTheDocument();
    expect(screen.getByText(/Showing top 2 of 85 open alerts/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(confirmSpy).toHaveBeenCalledWith(expect.stringMatching(/Decision cards.*stay open until decided/i));
    expect(await screen.findByText(/Cleared 1 alert\. Decision cards stay open until acted on\./)).toBeInTheDocument();
  });

  it('P2: TechCard React.memo re-renders when status or today_completed/today_total changes with same updated_at', () => {
    const baseTech = {
      id: 'tech-1',
      name: 'Tech One',
      status: 'en_route',
      updated_at: '2026-11-27T14:00:00Z',
      location_updated_at: '2026-11-27T14:00:00Z',
      current_job_id: null,
      eta_minutes: null,
      out_today: false,
      off_today: false,
      today_completed: 1,
      today_total: 4,
    };
    const jobs = new Map();
    const onSelect = vi.fn();
    const { rerender } = render(<TechCard tech={baseTech} jobs={jobs} selected={false} onSelect={onSelect} isDropTarget={false} />);
    expect(screen.getByText('1 / 4 jobs')).toBeInTheDocument();

    rerender(
      <TechCard
        tech={{ ...baseTech, status: 'on_site', today_completed: 2, today_total: 5 }}
        jobs={jobs}
        selected={false}
        onSelect={onSelect}
        isDropTarget={false}
      />,
    );
    expect(screen.getByText('2 / 5 jobs')).toBeInTheDocument();
    expect(screen.getByText('on_site')).toBeInTheDocument();
  });

  it('P2: TechOutSection renders error banner with Retry on transient 500 failure and recovers', async () => {
    fetch
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ enabled: true, absence: null }) });

    render(<TechOutSection techId="tech-1" techName="Tech One" />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to load tech-out status: HTTP 500');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('button', { name: 'Mark out today' })).toBeInTheDocument();
  });

  it('P2: AdminDispatchPage trusts verified outlet.user role over tampered localStorage role', async () => {
    localStorage.setItem('waves_admin_user', JSON.stringify({ id: 't1', role: 'admin' }));
    fetch.mockResolvedValue({ ok: true, json: async () => ({ enabled: false }) });

    function LayoutShell() {
      return <Outlet context={{ user: { id: 't1', role: 'technician' } }} />;
    }

    render(
      <MemoryRouter initialEntries={['/admin/dispatch?tab=board']}>
        <Routes>
          <Route element={<LayoutShell />}>
            <Route path="/admin/dispatch" element={<AdminDispatchPage />} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => {
      // Board and Scores tabs are adminOnly and must NOT render for verified technician
      expect(screen.queryByRole('tab', { name: /Board/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('tab', { name: /Scores/i })).not.toBeInTheDocument();
    });
  });
});
