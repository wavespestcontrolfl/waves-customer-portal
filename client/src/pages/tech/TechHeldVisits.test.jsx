// @vitest-environment jsdom
// Held visits on the Today page (GATE_CALL_HELD_VISIT): the Dispatch strip's rows for today,
// shown to an admin login, display only, with a link to Dispatch to book.
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import TechHeldVisits from './TechHeldVisits';
import { etDateString } from '../../lib/timezone';

const ROW = {
  call_log_id: 'call-1', kind: 'confirmed', date_et: etDateString(), minutes: 660, time_label: '11:00 AM',
  caller_name: 'Riley Example', phone: '+19415550100', address: { line1: '12 Test Lane', line2: null, city: 'Bradenton', zip: '34205' },
  service: 'General Pest Control', call_at: '2026-10-09T19:54:00.000Z', customer_id: null, daypart: null, notes: null,
};
const DAY_ONLY = { ...ROW, call_log_id: 'call-2', kind: 'day_only', minutes: null, time_label: null, caller_name: 'Morgan Example', daypart: 'morning', notes: 'Can meet after 10:30.' };

function stubHeld(response) {
  const fetcher = vi.fn(async () => response);
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}
const renderCard = () => render(<MemoryRouter><TechHeldVisits /></MemoryRouter>);

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('TechHeldVisits', () => {
  it('lists today\'s held rows with the Dispatch wording and links to Dispatch on today', async () => {
    const fetcher = stubHeld({ ok: true, json: async () => ({ heldVisits: [ROW, DAY_ONLY] }) });
    renderCard();
    expect(await screen.findByText('11:00 AM · Riley Example')).toBeInTheDocument();
    expect(String(fetcher.mock.calls[0][0])).toContain(`/api/admin/schedule/held-visits?date=${etDateString()}`);
    expect(screen.getByText('PROMISED · not booked')).toBeInTheDocument();
    expect(screen.getAllByText('12 Test Lane, Bradenton · General Pest Control')).toHaveLength(2);
    // A day-only row is never called a promise.
    expect(screen.getByText('Time not set · asked for the morning · Morgan Example')).toBeInTheDocument();
    expect(screen.getByText('NOT CONFIRMED · not booked')).toBeInTheDocument();
    expect(screen.getByText('From the call: Can meet after 10:30.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Book in Dispatch' })).toHaveAttribute('href', `/admin/dispatch?date=${etDateString()}`);
  });

  it.each([
    ['no rows (also the gate-off answer)', { ok: true, json: async () => ({ heldVisits: [] }) }],
    ['a refused or failed read', { ok: false, status: 403, json: async () => ({ error: 'no' }) }],
  ])('renders nothing for %s', async (_name, response) => {
    const fetcher = stubHeld(response);
    const { container } = renderCard();
    await waitFor(() => expect(fetcher).toHaveBeenCalled());
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when the phone has no connection', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    const { container } = renderCard();
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    expect(container).toBeEmptyDOMElement();
  });
});
