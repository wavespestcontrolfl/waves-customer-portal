// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter } from 'react-router-dom';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import DispatchPageV2 from './DispatchPageV2';
import { adminFetch } from '../../utils/admin-fetch';
import { getAdminUser } from '../../lib/adminAuth';
import { etDateString } from '../../lib/timezone';
import { resetSummaryAvailability } from '../../components/schedule/useBestTimes';

vi.mock('../../utils/admin-fetch', () => ({ adminFetch: vi.fn(), isRateLimitError: () => false }));
vi.mock('../../lib/adminAuth', async (orig) => ({ ...(await orig()), getAdminUser: vi.fn() }));
vi.mock('../../components/schedule/TimeGridDay', () => ({ default: () => <div>Schedule visits</div> }));
vi.mock('../../components/schedule/MobileDispatchList', () => ({ default: () => null }));
vi.mock('../../hooks/useFeatureFlag', () => ({ useFeatureFlag: () => false, useFeatureFlagReady: () => ({ enabled: false, ready: true, known: true }) }));
vi.mock('../../components/AddressAutocomplete', () => ({
  default: ({ onSelect }) => (
    <button type="button" onClick={() => onSelect({ formatted: '100 Example Way, Bradenton, FL 34200', line1: '100 Example Way', city: 'Bradenton', state: 'FL', zip: '34200', lat: 27.5, lng: -82.5 })}>
      pick suggestion
    </button>
  ),
}));
vi.mock('../../components/schedule/CreateAppointmentModal', () => ({
  default: (props) => (
    <div data-testid="new-appointment">
      {JSON.stringify({
        date: props.defaultDate, hour: props.defaultWindowStart, tech: props.defaultTechId,
        minutes: props.defaultDurationMinutes, quickAdd: props.defaultQuickAddAddress,
      })}
    </div>
  ),
}));

const slot = (date, start) => ({
  date, start_time: start, end_time: '11:00', detour_minutes: 9, drive_in_minutes: 6, rain_chance: 10,
  technician: { id: 'tech-9', name: 'Example Tech' },
});

beforeEach(() => {
  resetSummaryAvailability();
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  const today = etDateString();
  vi.stubGlobal('fetch', vi.fn(async (url) => ({
    ok: true,
    status: 200,
    json: async () => (String(url).includes('/find-time')
      ? { ok: true, slots: [], summary: { days: [{ date: today, status: 'open', hours: [slot(today, '10:00')] }], best: { day: [slot(today, '10:00')], week: [], week_covered: true } } }
      : { alerts: [] }),
  })));
  vi.mocked(getAdminUser).mockReturnValue({ id: 'u1', role: 'admin' });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); document.body.style.overflow = ''; });

const renderPage = (findTimePanel) => {
  vi.mocked(adminFetch).mockImplementation(async (path) => (String(path).startsWith('/admin/schedule?')
    ? { services: [], technicians: [], findTimePanel }
    : { products: [], types: [] }));
  render(<MemoryRouter initialEntries={['/admin/dispatch?tab=schedule&date=2035-01-02']}><DispatchPageV2 activeTab="board" /></MemoryRouter>);
};

it('shows no Find a time button while the gate is off', async () => {
  renderPage(false);
  await screen.findByText('Schedule visits');
  expect(screen.queryByTestId('find-time-open')).not.toBeInTheDocument();
});

it('Book opens New Appointment with the chip day, hour and the address, no technician or length (Codex #6411 r1)', async () => {
  renderPage(true);
  fireEvent.click(await screen.findByTestId('find-time-open'));
  fireEvent.click(screen.getByText('pick suggestion'));
  fireEvent.click((await screen.findAllByTestId('availability-hour'))[0]);
  fireEvent.click(screen.getByTestId('find-time-book'));
  expect(JSON.parse((await screen.findByTestId('new-appointment')).textContent)).toEqual({
    date: etDateString(), hour: '10:00',
    quickAdd: { address: '100 Example Way', city: 'Bradenton', state: 'FL', zip: '34200' },
  });
});

it('hides the button from a non-admin login', async () => {
  vi.mocked(getAdminUser).mockReturnValue({ id: 'u2', role: 'technician' });
  renderPage(true);
  await screen.findByText('Schedule visits');
  expect(screen.queryByTestId('find-time-open')).not.toBeInTheDocument();
});
