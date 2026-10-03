// @vitest-environment jsdom
// Schedule changes on the admin Today page (owner ruling 2026-10-03): a
// change touching today or tomorrow keeps its own card; the rest fold into
// ONE summary with Review and Clear all.
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TechScheduleChanges from './TechScheduleChanges';

const SVC = 'Quarterly Pest Control Service';
const move = (id, name, { when, previous_when, date, previous_date, actor = 'by auto-dispatch', soon = false }) => ({
  id, type: 'visit_rescheduled', soon,
  payload: { visit_id: `visit-${name}`, headline: 'Visit moved', customer_name: name, service_type: SVC, when, previous_when, date, previous_date, actor },
});

// Two auto-dispatch moves that traded slots (Dec 10 ↔ Dec 15), plus one
// office move for tomorrow that keeps its own card.
const FAR_A = move('00000000-0000-4000-8000-00000000000a', 'Houser', {
  previous_when: 'Thu Dec 10, 2–3 PM', when: 'Tue Dec 15, 9–10 AM', previous_date: '2026-12-10', date: '2026-12-15',
});
const FAR_B = move('00000000-0000-4000-8000-00000000000b', 'Graham', {
  previous_when: 'Tue Dec 15, 9–10 AM', when: 'Thu Dec 10, 2–3 PM', previous_date: '2026-12-15', date: '2026-12-10',
});
const SOON = move('00000000-0000-4000-8000-00000000000c', 'Ortiz', {
  previous_when: 'Mon Oct 5, 9–10 AM', when: 'Tue Oct 6, 1–2 PM', previous_date: '2026-10-05', date: '2026-10-06', actor: 'by Virginia', soon: true,
});

const AS_OF = '2026-10-03T10:00:00.000Z';
function stubApi(changes, laterTotal = changes.filter((c) => !c.soon).length) {
  const calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null });
    if (!init.method) return { ok: true, json: async () => ({ changes, later_total: laterTotal, as_of: AS_OF }) };
    return { ok: true, json: async () => ({ success: true }) };
  }));
  return calls;
}

async function renderChanges(props = {}) {
  render(<MemoryRouter><TechScheduleChanges {...props} /></MemoryRouter>);
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

describe('TechScheduleChanges', () => {
  beforeEach(() => { localStorage.setItem('waves_admin_token', 'tech-token'); });
  afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals(); });

  it('keeps a today/tomorrow change as its own card and folds the rest into one summary', async () => {
    stubApi([SOON, FAR_A, FAR_B]);
    await renderChanges();

    const soon = await screen.findByTestId('schedule-change-soon');
    expect(soon).toHaveTextContent('Ortiz');
    expect(soon).toHaveTextContent('Now Tue Oct 6, 1–2 PM');
    expect(soon).toHaveTextContent('Moved by Virginia');

    const summary = screen.getByTestId('schedule-changes-summary');
    expect(summary).toHaveTextContent('Auto-dispatch moved 2 visits');
    expect(summary).toHaveTextContent(`All ${SVC} · Dec 10 – Dec 15 · 1 earlier, 1 later`);
    expect(summary).not.toHaveTextContent('Houser');
  });

  it('a mix of movers reads as schedule changes, not auto-dispatch', async () => {
    stubApi([FAR_A, { ...FAR_B, payload: { ...FAR_B.payload, actor: 'by Virginia' } }]);
    await renderChanges();
    expect(await screen.findByTestId('schedule-changes-summary')).toHaveTextContent('2 schedule changes');
  });

  it('Review lists each move with its old and new time, direction, and swap partner; filters by direction', async () => {
    stubApi([FAR_A, FAR_B]);
    await renderChanges();
    fireEvent.click(await screen.findByRole('button', { name: 'Review moves' }));

    const review = screen.getByTestId('schedule-changes-review');
    const rows = within(review).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('Houser');
    expect(rows[0]).toHaveTextContent('LATER');
    expect(rows[0]).toHaveTextContent('Swapped with Graham');
    expect(rows[1]).toHaveTextContent('EARLIER');

    fireEvent.click(within(review).getByRole('button', { name: 'Earlier 1' }));
    expect(within(review).getAllByRole('listitem')).toHaveLength(1);
    expect(within(review).getByRole('listitem')).toHaveTextContent('Graham');
  });

  it('a backlog past the rows returned: the summary counts all of it and Review says Clear all covers the rest', async () => {
    stubApi([FAR_A, FAR_B], 412);
    await renderChanges();
    expect(await screen.findByTestId('schedule-changes-summary')).toHaveTextContent('Auto-dispatch moved 412 visits');
    fireEvent.click(screen.getByRole('button', { name: 'Review moves' }));
    expect(screen.getByText('410 more not shown. Clear all covers them too.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Got it, clear all 412' })).toBeInTheDocument();
  });

  it('Clear all dismisses only the folded changes in one call; the today/tomorrow card stays', async () => {
    const calls = stubApi([SOON, FAR_A, FAR_B]);
    await renderChanges();
    fireEvent.click(await screen.findByRole('button', { name: 'Clear all' }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    const post = calls.find((c) => c.method === 'POST');
    expect(post.url).toMatch(/\/api\/tech\/notifications\/dismiss-batch$/);
    // The server clears every folded change up to the read on screen.
    expect(post.body).toEqual({ as_of: AS_OF });
    expect(screen.queryByTestId('schedule-changes-summary')).not.toBeInTheDocument();
    expect(screen.getByTestId('schedule-change-soon')).toBeInTheDocument();
  });

  it('Got it on a today/tomorrow card dismisses just that card', async () => {
    const calls = stubApi([SOON]);
    await renderChanges();
    fireEvent.click(await screen.findByRole('button', { name: 'Got it' }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(calls.find((c) => c.method === 'POST').url).toMatch(new RegExp(`/api/tech/notifications/${SOON.id}/dismiss$`));
    expect(screen.queryByTestId('schedule-change-soon')).not.toBeInTheDocument();
  });

  it('shows the Dispatch link to admins only', async () => {
    stubApi([FAR_A]);
    await renderChanges({ canOpenDispatch: true });
    fireEvent.click(await screen.findByRole('button', { name: 'Review moves' }));
    expect(screen.getByRole('link', { name: 'Open in Dispatch' })).toHaveAttribute('href', '/admin/dispatch?tab=schedule');
    cleanup();

    stubApi([FAR_A]);
    await renderChanges();
    fireEvent.click(await screen.findByRole('button', { name: 'Review moves' }));
    expect(screen.queryByRole('link', { name: 'Open in Dispatch' })).not.toBeInTheDocument();
  });

  it('one visit moved A→B and back B→A is not a swap', async () => {
    const there = move('00000000-0000-4000-8000-00000000000d', 'Lee', {
      previous_when: 'Thu Dec 10, 2–3 PM', when: 'Tue Dec 15, 9–10 AM', previous_date: '2026-12-10', date: '2026-12-15',
    });
    const back = { ...move('00000000-0000-4000-8000-00000000000e', 'Lee', {
      previous_when: 'Tue Dec 15, 9–10 AM', when: 'Thu Dec 10, 2–3 PM', previous_date: '2026-12-15', date: '2026-12-10',
    }) };
    stubApi([there, back]);
    await renderChanges();
    fireEvent.click(await screen.findByRole('button', { name: 'Review moves' }));
    expect(screen.getByTestId('schedule-changes-review')).not.toHaveTextContent('Swapped with');
  });

  it('Review keeps a non-move change\'s details: where a new visit is, who holds a removed one, who acted', async () => {
    stubApi([
      { id: '00000000-0000-4000-8000-00000000000f', type: 'visit_assigned', soon: false,
        payload: { headline: 'New visit on your route', customer_name: 'Diaz', service_type: SVC, when: 'Thu Dec 10, 9–10 AM', date: '2026-12-10', address: '12 Palm Ave, Bradenton', actor: 'by Virginia' } },
      { id: '00000000-0000-4000-8000-000000000010', type: 'visit_unassigned', soon: false,
        payload: { headline: 'Moved off your route', customer_name: 'Ng', service_type: SVC, when: 'Fri Dec 11, 1–2 PM', date: '2026-12-11', now_with: 'Tech Two', actor: 'by Virginia' } },
    ]);
    await renderChanges();
    fireEvent.click(await screen.findByRole('button', { name: 'Review changes' }));
    const [assigned, removed] = within(screen.getByTestId('schedule-changes-review')).getAllByRole('listitem');
    expect(assigned).toHaveTextContent('12 Palm Ave, Bradenton');
    expect(assigned).toHaveTextContent('Assigned by Virginia');
    expect(removed).toHaveTextContent('Now with Tech Two');
    expect(removed).toHaveTextContent('Reassigned by Virginia');
  });

  it('onReady(true) only after a read succeeds (the floating cards stay up until then); onReady(false) on unmount', async () => {
    const onReady = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })));
    await renderChanges({ onReady });
    expect(onReady).not.toHaveBeenCalledWith(true);
    cleanup();
    expect(onReady).toHaveBeenLastCalledWith(false);

    onReady.mockClear();
    stubApi([]);
    await renderChanges({ onReady });
    expect(onReady).toHaveBeenCalledWith(true);
  });

  it('renders nothing when there are no schedule changes', async () => {
    stubApi([]);
    await renderChanges();
    expect(screen.queryByTestId('schedule-changes-summary')).not.toBeInTheDocument();
    expect(screen.queryByTestId('schedule-change-soon')).not.toBeInTheDocument();
  });
});
