// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ProtocolPanel } from './SchedulePage';

beforeEach(() => { vi.stubGlobal('scrollTo', vi.fn()); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function ProtocolHarness() {
  const [open, setOpen] = React.useState(false);
  return <>
    <button
      type="button"
      onClick={(event) => {
        event.currentTarget.focus({ preventScroll: true });
        setOpen(true);
      }}
    >
      Open protocol
    </button>
    {open && (
      <ProtocolPanel
        service={{ id: 'test-visit', serviceType: 'Pest Control', customerName: 'Test Customer' }}
        onClose={() => setOpen(false)}
      />
    )}
  </>;
}

it('traps focus, closes on Escape, restores the opener, and locks background scrolling', () => {
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
  render(<ProtocolHarness />);

  const opener = screen.getByRole('button', { name: 'Open protocol' });
  fireEvent.click(opener);

  const dialog = screen.getByRole('dialog', { name: 'Service Protocol' });
  expect(dialog.getAttribute('aria-modal')).toBe('true');
  expect(document.activeElement).toBe(dialog);
  expect(document.body.style.position).toBe('fixed');

  const buttons = within(dialog).getAllByRole('button');
  const first = buttons[0];
  const last = buttons[buttons.length - 1];
  last.focus();
  fireEvent.keyDown(last, { key: 'Tab' });
  expect(document.activeElement).toBe(first);
  first.focus();
  fireEvent.keyDown(first, { key: 'Tab', shiftKey: true });
  expect(document.activeElement).toBe(last);

  fireEvent.keyDown(dialog, { key: 'Escape' });
  expect(screen.queryByRole('dialog', { name: 'Service Protocol' })).toBeNull();
  expect(document.activeElement).toBe(opener);
  expect(document.body.style.position).toBe('');
});

it('closes from the backdrop and restores the opener', () => {
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
  render(<ProtocolHarness />);

  const opener = screen.getByRole('button', { name: 'Open protocol' });
  fireEvent.click(opener);
  const dialog = screen.getByRole('dialog', { name: 'Service Protocol' });
  fireEvent.click(dialog.parentElement);

  expect(screen.queryByRole('dialog', { name: 'Service Protocol' })).toBeNull();
  expect(document.activeElement).toBe(opener);
});

it.each([
  [null, undefined, 'st_augustine'],
  [{ grass_type: '', lawn_sqft: 5000 }, undefined, 'st_augustine'],
  [{ grass_type: 'zoysia', lawn_sqft: 5000 }, undefined, 'zoysia'],
  [null, 'Bermuda', 'bermuda'],
  [{ track_key: 'bahia', lawn_sqft: 5000 }, undefined, 'bahia'],
])('loads the matching protocol for profile %j and customer type %s', async (profile, lawnType, track) => {
  const fetchMock = vi.fn(async (url) => ({ ok: true, json: async () => url.includes('turf-profile') ? { profile } : {} }));
  vi.stubGlobal('fetch', fetchMock);
  render(<ProtocolPanel service={{ id: 'test-visit', customerId: 'test-property', serviceType: 'Lawn Care', lawnSqft: 5000, lawnType }} onClose={() => {}} />);
  await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => url.includes(`/protocols/lawn-mix?track=${track}&`))).toBe(true));
});

it('does not load a default protocol after a failed profile lookup', async () => {
  const fetchMock = vi.fn().mockRejectedValue(new Error('Profile unavailable'));
  vi.stubGlobal('fetch', fetchMock);
  render(<ProtocolPanel service={{ id: 'test-visit', customerId: 'test-property', serviceType: 'Lawn Care', lawnSqft: 5000 }} onClose={() => {}} />);
  // The panel also fetches the job card on mount (GATE_JOB_CARD probe), so
  // the sync point is the line loads that follow the failed profile, not a
  // call count: none of them may be a track-keyed protocol load.
  await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => url.includes('/protocols/equipment'))).toBe(true));
  expect(fetchMock.mock.calls.some(([url]) => url.includes('/protocols/programs') || url.includes('/protocols/lawn-mix'))).toBe(false);
});

it.each(['unknown', 'mixed'])('does not replace explicit %s turf with legacy St. Augustine', async (grass_type) => {
  const fetchMock = vi.fn(async (url) => ({ ok: true, json: async () => url.includes('turf-profile') ? { profile: { grass_type, lawn_sqft: 5000 } } : {} }));
  vi.stubGlobal('fetch', fetchMock);
  render(<ProtocolPanel service={{ id: 'test-visit', customerId: 'test-property', serviceType: 'Lawn Care', lawnSqft: 5000, lawnType: 'St. Augustine' }} onClose={() => {}} />);
  await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => url.includes('/protocols/equipment'))).toBe(true));
  expect(fetchMock.mock.calls.some(([url]) => url.includes('/protocols/lawn-mix') || url.includes('/protocols/programs'))).toBe(false);
});
