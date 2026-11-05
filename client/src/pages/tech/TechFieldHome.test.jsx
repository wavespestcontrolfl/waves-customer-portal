// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import TechFieldHome from './TechFieldHome';
import { currentStopOf, groupServicesIntoStops, nextStopOf, serviceWindowLabel, stopStatusLabel } from './routeStops';
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

it('puts the onboarding card at the top of Today, above the route, and not on Tools', () => {
  const stops = groupServicesIntoStops([row('one', 'confirmed')]);
  const { container, rerender } = render(<TechFieldHome section="today" stops={stops} nextStop={nextStopOf(stops)} onOpen={vi.fn()} onboarding={<div data-testid="onboarding-slot">Sign 1 document to finish setup</div>} />);
  const slot = screen.getByTestId('onboarding-slot');
  expect(slot.compareDocumentPosition(container.querySelector('.tf-today-grid')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  rerender(<TechFieldHome section="tools" stops={stops} tools={[]} onboarding={<div data-testid="onboarding-slot" />} />);
  expect(screen.queryByTestId('onboarding-slot')).not.toBeInTheDocument();
});

// Truck kit (GATE_TRUCK_KIT, PR 2): a stop whose checklist needs a tool the
// truck lacks says so on the Up next card and carries a tag in the route list.
it('names the tools a stop needs that are not on the truck, and only on that stop', () => {
  const stops = groupServicesIntoStops([row('one', 'confirmed'), row('two', 'confirmed')]);
  const gaps = [{ serviceId: 'one', serviceType: 'Termite Inspection', missing: ['Moisture meter', 'Hammer drill'] }];
  render(<TechFieldHome section="today" stops={stops} nextStop={nextStopOf(stops)} onOpen={vi.fn()} toolGaps={gaps} />);
  expect(screen.getByText('Not on your truck: Moisture meter, Hammer drill')).toBeInTheDocument();
  expect(screen.getAllByText('Tool not on truck')).toHaveLength(1);
  cleanup();
  render(<TechFieldHome section="today" stops={stops} nextStop={nextStopOf(stops)} onOpen={vi.fn()} />);
  expect(screen.queryByText(/Not on your truck/)).not.toBeInTheDocument();
});

// Several stops can be on site (the tech starts the next one before finishing
// the last in the app): the latest arrival is current, the others are listed.
it('lists earlier on-site stops under the current visit, flags them in the header and the bar, and opens one on tap', () => {
  const timed = (id, name, checkInTime, status = 'on_site') => ({ ...row(id, status), customerName: name, checkInTime });
  const stops = groupServicesIntoStops([
    timed('a', 'Done Customer', '2026-11-04T15:00:00Z', 'completed'),
    timed('b', 'Older Customer', '2026-11-04T17:02:00Z'),
    timed('c', 'Middle Customer', '2026-11-04T18:33:00Z'),
    timed('d', 'Latest Customer', '2026-11-04T19:07:00Z'),
    timed('e', 'Later Customer', null, 'confirmed'),
  ]);
  const onOpen = vi.fn();
  const { container } = render(<TechFieldHome section="today" stops={stops} nextStop={currentStopOf(stops)} onOpen={onOpen} />);
  expect(screen.getByText(/1 of 5 stops complete · 3 still open · 5 services/)).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Latest Customer' })).toBeInTheDocument();
  const rows = screen.getAllByRole('button', { name: /arrived/ });
  expect(rows.map((r) => r.textContent)).toEqual(['Older Customer · arrived 12:02 PM', 'Middle Customer · arrived 1:33 PM']);
  // The list sits in the same area as the current visit, in the page flow.
  expect(container.querySelector('.tf-area-next')).toContainElement(rows[0]);
  expect(Array.from(container.querySelectorAll('.tf-progress span')).map((s) => s.className)).toEqual(['done', 'open', 'open', 'current', '']);
  fireEvent.click(rows[0]);
  expect(onOpen).toHaveBeenCalledWith(stops[1]);
});

it('shows no still-open list or count when only the current stop is on site', () => {
  const stops = groupServicesIntoStops([row('a', 'completed'), row('b', 'on_site'), row('c', 'confirmed')]);
  render(<TechFieldHome section="today" stops={stops} nextStop={currentStopOf(stops)} onOpen={vi.fn()} />);
  expect(screen.queryByText('Still open from earlier')).not.toBeInTheDocument();
  expect(screen.getByText(/1 of 3 stops complete · 1 still open · 3 services/)).toBeInTheDocument();
});

it('shows neither the count nor the list when nothing is on site', () => {
  const stops = groupServicesIntoStops([row('a', 'completed'), row('b', 'confirmed')]);
  render(<TechFieldHome section="today" stops={stops} nextStop={currentStopOf(stops)} onOpen={vi.fn()} />);
  expect(screen.queryByText(/still open/)).not.toBeInTheDocument();
});
