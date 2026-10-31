// @vitest-environment jsdom
// Route-dispatcher audit D (owner 2026-10-31 "ok go"): the dispatch Quick Move sheet's day options say what
// they add to the drive, the same "+N min drive" Tech Home's sheet shows for the same options.
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('../../hooks/useIsMobile', () => ({ default: () => false }));
vi.mock('./useBestTimes', () => ({
  useBestTimes: () => ({ pickedByTech: [], availability: null, checking: false }),
}));

import RainOutSheet from './RainOutSheet';

const json = (body) => ({ ok: true, json: async () => body });
const day = (date, display, over = {}) => ({ kind: 'day', date, window: { start: '09:00', end: '10:00' }, display, ...over });

beforeEach(() => {
  localStorage.setItem('waves_admin_token', 'fixture-only');
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    if (String(url).includes('/rain-out-options')) {
      return json({
        sameDay: [],
        days: [day('2099-01-02', 'Fri, Jan 2, 9:00 AM-10:00 AM', { driveMinutes: 12 }), day('2099-01-05', 'Mon, Jan 5, 9:00 AM-10:00 AM')],
        service: { window: { start: '10:00', end: '11:00' } }, remainingRouteCount: 0,
      });
    }
    return json({});
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });

it('a day option with driveMinutes reads "+N min drive"; one without has no drive label', async () => {
  render(<RainOutSheet service={{ id: 'visit-1', customerId: 'c-1', customerName: 'Fixture Customer' }} onClose={vi.fn()} onDone={vi.fn()} />);
  const fri = await screen.findByText(/Fri, Jan 2, 9:00 AM-10:00 AM/);
  expect(fri.closest('button')).toHaveTextContent('Fri, Jan 2, 9:00 AM-10:00 AM · +12 min drive');
  const mon = screen.getByText(/Mon, Jan 5, 9:00 AM-10:00 AM/);
  expect(mon.closest('button')).not.toHaveTextContent('min drive');
  fireEvent.click(fri.closest('button'));
});
