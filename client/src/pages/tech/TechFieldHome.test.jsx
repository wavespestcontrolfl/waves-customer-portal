// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import TechFieldHome from './TechFieldHome';
import { groupServicesIntoStops, nextStopOf, serviceWindowLabel, stopStatusLabel } from './routeStops';
afterEach(cleanup);
const row = (id, status, visit) => ({ id, status, visit, customerName: 'Fixture Customer', address: '100 Example Lane', serviceType: 'Lawn care', windowStart: '09:00', windowEnd: '10:00' });

it('counts grouped stops without labeling skipped members completed and opens the selected stop', () => {
  const stops = groupServicesIntoStops([row('one', 'completed', { id: 'group' }), row('two', 'skipped', { id: 'group' }), row('three', 'en_route')]);
  const onOpen = vi.fn();
  render(<TechFieldHome section="today" stops={stops} nextStop={nextStopOf(stops)} onOpen={onOpen} />);
  // One subtitle line under Today (approved admin mockup 2026-10-03).
  expect(screen.getByText(/0 of 2 stops complete · 3 services/)).toBeInTheDocument();
  expect(screen.getByText('Current visit')).toBeInTheDocument();
  expect(stopStatusLabel(stops[0])).toBe('mixed');
  fireEvent.click(screen.getByRole('button', { name: 'Open visit' }));
  expect(onOpen).toHaveBeenCalledWith(stops[1]);
  expect(serviceWindowLabel({ windowStart: '13:00', windowEnd: '14:00' })).toBe('1:00 PM–2:00 PM');
});

// Customer-visit-photos scope doc §5.4 item 2 (PR 3b) — the stop chip,
// server-computed and gate-off omitted (never rendered as a false chip).
it('shows the "Customer sent photos" chip only for a stop the server flagged', () => {
  const flagged = row('flagged', 'confirmed');
  flagged.customerSentPhotos = true;
  const notFlagged = row('quiet', 'confirmed');
  const stops = groupServicesIntoStops([flagged, notFlagged]);
  render(<TechFieldHome section="today" stops={stops} nextStop={null} onOpen={vi.fn()} />);
  expect(screen.getAllByText('📷 Customer sent photos')).toHaveLength(1);
});

it('keeps a failed route distinct from an empty route and offers retry', () => {
  const onRetry = vi.fn();
  render(<TechFieldHome section="today" stops={[]} error="Route unavailable" onRetry={onRetry} />);
  expect(screen.getByRole('alert')).toHaveTextContent('Route unavailable');
  expect(screen.queryByText('No stops scheduled today')).not.toBeInTheDocument();
  expect(screen.queryByText(/stops complete/)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Retry route' }));
  expect(onRetry).toHaveBeenCalledTimes(1);
});
