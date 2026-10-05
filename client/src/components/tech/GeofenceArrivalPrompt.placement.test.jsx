// @vitest-environment jsdom
// Owner 2026-10-05 (phone screenshots): notices must never cover the page.
// On the Today overview every card sits in the page flow; away from Today only
// the time-critical arrival cards float, and one line points to Today.
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import GeofenceArrivalPrompt from './GeofenceArrivalPrompt';

const now = () => new Date().toISOString();
const n = (id, type, payload = {}, message = 'server message') => ({ id, type, message, payload, created_at: now() });
const FEED = [
  n('n-prompt', 'geofence_arrival_reminder', { customer_name: 'Okafor' }),
  n('n-started', 'geofence_timer_started', {}, 'Timer started for Okafor'),
  n('n-v1', 'visit_assigned', { headline: 'New visit on your route', customer_name: 'Ruiz', service_type: 'Pest Control', when: 'Thu 9 AM' }),
  n('n-v2', 'visit_cancelled', { headline: 'Visit cancelled', customer_name: 'Ruiz', service_type: 'Pest Control', when: 'Thu 9 AM' }),
  n('n-v3', 'visit_rescheduled', { headline: 'Visit moved', customer_name: 'Ruiz', service_type: 'Pest Control', previous_when: 'Thu 9 AM', when: 'Fri 1 PM' }),
  n('n-text', 'tech_line_sms', { customer_name: 'Ruiz', body: 'Gate is open' }),
  n('n-photo', 'customer_visit_photos', { scheduled_date: '2099-01-05' }, 'A customer sent photos'),
  n('n-track', 'follow_through_tracking', { stage: 1, customer_name: 'Ruiz' }, 'Window underway'),
  n('n-nudge', 'tech_open_visit_nudge', {}, '2 visits still open'),
  n('n-storm', 'storm_watch_alert', { job_id: 'job-1', city: 'Bradenton' }),
];

function stubFeed(notifications) {
  const calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || 'GET' });
    if (!init.method) return { ok: true, json: async () => ({ notifications }) };
    return { ok: true, json: async () => ({}) };
  }));
  return calls;
}

function mount(props) {
  return render(<MemoryRouter initialEntries={['/admin/today/tools']}><Routes>
    <Route path="/admin/today" element={<div>Today page</div>} />
    <Route path="/admin/today/tools" element={<GeofenceArrivalPrompt {...props} />} />
  </Routes></MemoryRouter>);
}

describe('GeofenceArrivalPrompt placement', () => {
  beforeEach(() => {
    localStorage.setItem('waves_admin_token', 'tech-token');
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); localStorage.clear(); });

  it('Today overview: every card renders in the page flow (no overlay), with the caps and summary lines', async () => {
    stubFeed(FEED);
    mount({ placement: 'page' });
    const stack = await screen.findByTestId('notice-stack');
    expect(stack).toHaveAttribute('data-placement', 'page');
    expect(stack.style.position).toBe('');
    expect(stack.style.zIndex).toBe('');
    expect(stack.style.maxHeight).toBe('');
    expect(stack.style.overflowY).toBe('');
    expect(screen.getByText('Okafor')).toBeInTheDocument();
    expect(screen.getByText(/Timer auto-started/)).toBeInTheDocument();
    // MAX_VISIT_CARDS (2) of the seven kept cards show; the rest are summarized.
    expect(within(stack).getAllByRole('button', { name: 'Got it' })).toHaveLength(2);
    expect(screen.getByTestId('visit-notice-more')).toHaveTextContent('5 more notices');
    expect(screen.getByText(/Storm watch/)).toBeInTheDocument();
    expect(screen.queryByTestId('notices-on-today')).not.toBeInTheDocument();
    // No card wrapper floats or carries a pointer-events overlay.
    for (const card of stack.children) expect(card.style.pointerEvents).toBe('');
  });

  it('Today overview: Review options on a storm card still reaches onStormReview', async () => {
    stubFeed([FEED[9]]);
    const onStormReview = vi.fn();
    mount({ placement: 'page', onStormReview });
    fireEvent.click(await screen.findByRole('button', { name: 'Review options' }));
    expect(onStormReview).toHaveBeenCalledWith({ job_id: 'job-1', city: 'Bradenton' });
  });

  it('Tools, More and an open visit: only the arrival cards float; the rest is one "N notices on Today" line', async () => {
    const calls = stubFeed(FEED);
    mount({ placement: 'elsewhere' });
    const stack = await screen.findByTestId('notice-stack');
    expect(stack).toHaveAttribute('data-placement', 'float');
    expect(stack.style.position).toBe('fixed');
    expect(screen.getByText('Okafor')).toBeInTheDocument();
    expect(screen.getByText(/Timer auto-started/)).toBeInTheDocument();
    for (const id of ['visit-notice', 'photo-notice', 'tech-line-text', 'tracking-notice', 'tech-open-visits', 'visit-notice-more']) {
      expect(screen.queryByTestId(id)).not.toBeInTheDocument();
    }
    expect(screen.queryByText(/Storm watch/)).not.toBeInTheDocument();
    const line = screen.getByTestId('notices-on-today');
    expect(line).toHaveTextContent('8 notices on Today');
    expect(line).toHaveAttribute('href', '/admin/today');
    // Waiting notices stay unread: the 5-minute auto-dismiss never touches them.
    await act(async () => { vi.advanceTimersByTime(6 * 60 * 1000); });
    expect(calls.filter((c) => c.method === 'POST' && /n-(storm|v1|photo)/.test(c.url))).toEqual([]);
    fireEvent.click(line);
    expect(await screen.findByText('Today page')).toBeInTheDocument();
  });

  it('the line is singular for one notice, absent for none, and held while a visit action is in flight', async () => {
    stubFeed([FEED[4]]);
    const mounted = mount({ placement: 'elsewhere', navigationBusy: true });
    const line = await screen.findByTestId('notices-on-today');
    expect(line).toHaveTextContent(/^1 notice on Today$/);
    expect(line).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(line);
    expect(screen.queryByText('Today page')).not.toBeInTheDocument();
    expect(screen.queryByTestId('notice-stack')).not.toBeInTheDocument();
    mounted.unmount();
    stubFeed([FEED[0]]);
    mount({ placement: 'elsewhere' });
    await screen.findByText('Okafor');
    expect(screen.queryByTestId('notices-on-today')).not.toBeInTheDocument();
  });
});
