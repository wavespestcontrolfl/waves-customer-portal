// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TechTimeTrackingCard from './TechTimeTrackingCard';

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn(async () => body),
  };
}

describe('TechTimeTrackingCard', () => {
  beforeEach(() => {
    localStorage.setItem('waves_admin_token', 'tech-token');
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  it('does not expose clock actions when status cannot be verified', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response(503, { error: 'Time clock unavailable' })));

    render(<TechTimeTrackingCard nextStop={{ id: 'visit-1', status: 'on_site' }} />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Time clock unavailable');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Clock in' })).not.toBeInTheDocument();
  });

  it('requires the stop to be on site before enabling its job timer', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response(200, {
      clockedIn: true,
      onBreak: false,
      currentJob: null,
      todaySummary: { shiftMinutes: 42, jobCount: 1 },
    })));

    const { rerender } = render(
      <TechTimeTrackingCard nextStop={{ id: 'visit-1', status: 'en_route', customerName: 'River Home' }} />,
    );

    const guardedButton = await screen.findByRole('button', { name: 'Mark on site before starting timer' });
    expect(guardedButton).toBeDisabled();

    rerender(
      <TechTimeTrackingCard nextStop={{ id: 'visit-1', status: 'on_site', customerName: 'River Home' }} />,
    );
    expect(screen.getByRole('button', { name: 'Start job · River Home' })).toBeEnabled();
  });

  it('reloads its status when the window regains focus', async () => {
    let clockedIn = false;
    const fetchMock = vi.fn(async () => response(200, { clockedIn, onBreak: false, currentJob: null, todaySummary: { shiftMinutes: 0, jobCount: 0 } }));
    vi.stubGlobal('fetch', fetchMock);
    render(<TechTimeTrackingCard variant="field" nextStop={{ id: 'visit-1', status: 'on_site' }} />);
    expect(await screen.findByRole('button', { name: 'Clock in' })).toBeInTheDocument();
    clockedIn = true;
    window.dispatchEvent(new Event('focus'));
    expect(await screen.findByRole('button', { name: 'Clock out' })).toBeInTheDocument();
  });

  it('only the newest status read lands: an older read arriving last never puts back the old controls', async () => {
    const pending = [];
    vi.stubGlobal('fetch', vi.fn(() => new Promise((r) => pending.push(r))));
    render(<TechTimeTrackingCard variant="field" nextStop={{ id: 'visit-1', status: 'on_site' }} />);
    window.dispatchEvent(new Event('focus'));
    const body = (clockedIn) => response(200, { clockedIn, onBreak: false, currentJob: null, todaySummary: { shiftMinutes: 0, jobCount: 0 } });
    // the newer read (after the timer started) answers first, the older one last
    pending[1](body(true));
    expect(await screen.findByRole('button', { name: 'Clock out' })).toBeInTheDocument();
    pending[0](body(false));
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.getByRole('button', { name: 'Clock out' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Clock in' })).not.toBeInTheDocument();
  });
  describe('No lunch today (GATE_AUTO_LUNCH)', () => {
    const clockedInStatus = (autoLunch) => ({
      clockedIn: true,
      onBreak: false,
      currentJob: null,
      todaySummary: { shiftMinutes: 120, jobCount: 0 },
      ...(autoLunch ? { autoLunch } : {}),
    });

    it('shows no lunch control while the gate is off or the status has no gate state', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => response(200, clockedInStatus({ enabled: false, noLunch: false }))));
      const { unmount } = render(<TechTimeTrackingCard nextStop={null} />);
      expect(await screen.findByRole('button', { name: 'Clock out' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /no lunch/i })).not.toBeInTheDocument();
      unmount();

      vi.stubGlobal('fetch', vi.fn(async () => response(200, clockedInStatus())));
      render(<TechTimeTrackingCard nextStop={null} />);
      expect(await screen.findByRole('button', { name: 'Clock out' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /no lunch/i })).not.toBeInTheDocument();
    });

    it('posts the choice, then shows the new state from the next status read', async () => {
      let noLunch = false;
      const fetchMock = vi.fn(async (url, options = {}) => {
        if (String(url).endsWith('/no-lunch')) {
          noLunch = JSON.parse(options.body).noLunch;
          return response(200, { workDate: '2026-10-26', noLunch });
        }
        return response(200, clockedInStatus({ enabled: true, noLunch }));
      });
      vi.stubGlobal('fetch', fetchMock);
      render(<TechTimeTrackingCard nextStop={null} />);

      fireEvent.click(await screen.findByRole('button', { name: 'No lunch today' }));
      expect(await screen.findByRole('button', { name: 'Undo no lunch' })).toBeInTheDocument();
      expect(screen.getByText('No lunch today: the automatic 30-minute deduction is waived.')).toBeInTheDocument();
      expect(screen.queryByText(/full day is paid/)).not.toBeInTheDocument();
      const post = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/no-lunch'));
      expect(post[0]).toContain('/api/tech/timetracking/no-lunch');
      expect(post[1].method).toBe('POST');
      expect(JSON.parse(post[1].body)).toEqual({ noLunch: true });

      fireEvent.click(screen.getByRole('button', { name: 'Undo no lunch' }));
      expect(await screen.findByRole('button', { name: 'No lunch today' })).toBeInTheDocument();
    });

    it('says a recorded lunch of 30+ minutes stays unpaid, with or without No lunch', async () => {
      const mock = (noLunch) => vi.fn(async () => response(200, clockedInStatus({ enabled: true, noLunch, recordedMealMinutes: 45 })));
      vi.stubGlobal('fetch', mock(false));
      const { unmount } = render(<TechTimeTrackingCard nextStop={null} />);
      expect(await screen.findByText('Recorded lunch 45 min stays unpaid.')).toBeInTheDocument();
      unmount();

      vi.stubGlobal('fetch', mock(true));
      render(<TechTimeTrackingCard nextStop={null} />);
      expect(await screen.findByText('No lunch today waives only the automatic 30 minutes. Recorded lunch 45 min stays unpaid.')).toBeInTheDocument();
      expect(screen.queryByText(/full day is paid/)).not.toBeInTheDocument();
    });

    it('shows the refusal when the day or week is already approved', async () => {
      vi.stubGlobal('fetch', vi.fn(async (url) => (String(url).endsWith('/no-lunch')
        ? response(409, { error: 'Reopen the approved day before changing lunch.' })
        : response(200, clockedInStatus({ enabled: true, noLunch: false })))));
      render(<TechTimeTrackingCard variant="field" nextStop={null} />);

      fireEvent.click(await screen.findByRole('button', { name: 'No lunch today' }));
      await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Reopen the approved day'));
      expect(screen.getByRole('button', { name: 'No lunch today' })).toBeEnabled();
    });
  });
});
