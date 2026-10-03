// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TechTimeTrackingCard from './TechTimeTrackingCard';
import { TIME_TRACKING_CHANGED } from './timeTrackingEvents';

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

  it('reloads its status when a timer changes elsewhere on the page (the geofence prompt\'s Start Timer)', async () => {
    let clockedIn = false;
    const fetchMock = vi.fn(async () => response(200, { clockedIn, onBreak: false, currentJob: null, todaySummary: { shiftMinutes: 0, jobCount: 0 } }));
    vi.stubGlobal('fetch', fetchMock);
    render(<TechTimeTrackingCard variant="field" nextStop={{ id: 'visit-1', status: 'on_site' }} />);
    expect(await screen.findByRole('button', { name: 'Clock in' })).toBeInTheDocument();
    clockedIn = true;
    window.dispatchEvent(new Event(TIME_TRACKING_CHANGED));
    expect(await screen.findByRole('button', { name: 'Clock out' })).toBeInTheDocument();
  });
});
