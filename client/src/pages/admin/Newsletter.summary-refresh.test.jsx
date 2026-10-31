// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import NewsletterPage from './NewsletterPage';

vi.mock('./EmailAutomationsPanelV2', () => ({ default: () => <div>Automations</div> }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });

const response = (data, { ok = true, status = 200 } = {}) => ({
  ok,
  status,
  json: async () => data,
});

const event = (id, title) => ({
  id,
  title,
  startAt: '2026-10-10T14:00:00.000Z',
  sourceName: 'Fixture feed',
});

it('clears summary loading when a queued poll supersedes dashboard re-entry', async () => {
  localStorage.setItem('waves_admin_token', 'fixture');
  let reads = 0;
  let finishForeground;
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const path = String(url).split('?')[0];
    let data = {};
    if (path.endsWith('/sends')) {
      reads += 1;
      if (reads === 2) {
        // Focus arrives after the foreground request starts, before its loading render.
        window.dispatchEvent(new Event("focus"));
        return new Promise((resolve) => { finishForeground = resolve; });
      }
      data = { sends: [], counts: { sent: reads } };
    }
    if (path.endsWith('/subscribers')) data = { subscribers: [], counts: { active: 3 } };
    return { ok: true, json: async () => data };
  }));
  render(<MemoryRouter><NewsletterPage /></MemoryRouter>);
  await screen.findByRole('button', { name: 'Schedule (1)' });
  fireEvent.click(screen.getByRole('button', { name: 'Automation', exact: true }));
  fireEvent.click(screen.getByRole('button', { name: 'Dashboard', exact: true }));
  await waitFor(() => expect(finishForeground).toBeTypeOf('function'));
  await screen.findByRole('button', { name: 'Schedule (3)' });
  await act(async () => { finishForeground({ ok: true, json: async () => ({ sends: [], counts: { sent: 2 } }) }); });
  fireEvent(window, new Event("focus"));
  await screen.findByRole('button', { name: 'Schedule (4)' });
});

it('shows a retryable upcoming-events error without a false empty state, then clears it after retry', async () => {
  localStorage.setItem('waves_admin_token', 'fixture');
  let eventReads = 0;
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const requestUrl = String(url);
    if (requestUrl.includes('/admin/newsletter/events?days=14&limit=12')) {
      eventReads += 1;
      if (eventReads === 1) {
        return response({ error: 'Event feed unavailable' }, { ok: false, status: 503 });
      }
      return response({ events: [event('recovered', 'Recovered fall festival')] });
    }
    if (requestUrl.includes('/admin/newsletter/sends')) {
      return response({ sends: [], counts: {} });
    }
    if (requestUrl.includes('/admin/newsletter/subscribers')) {
      return response({ subscribers: [], counts: { active: 0 } });
    }
    throw new Error(`Unexpected request: ${requestUrl}`);
  }));

  render(<MemoryRouter><NewsletterPage /></MemoryRouter>);

  expect(await screen.findByRole('alert')).toHaveTextContent('Event feed unavailable');
  expect(screen.queryByText('No upcoming events')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

  await screen.findByText('Recovered fall festival');
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(eventReads).toBe(2);
});

it('keeps upcoming-event cards through a failed poll and clears the error after automatic recovery', async () => {
  localStorage.setItem('waves_admin_token', 'fixture');
  let eventReads = 0;
  let finishPoll;
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const requestUrl = String(url);
    if (requestUrl.includes('/admin/newsletter/events?days=14&limit=12')) {
      eventReads += 1;
      if (eventReads === 1) {
        return response({ events: [event('existing', 'Existing art walk')] });
      }
      if (eventReads === 2) {
        return new Promise((resolve) => { finishPoll = resolve; });
      }
      return response({ events: [event('fresh', 'Fresh seafood festival')] });
    }
    if (requestUrl.includes('/admin/newsletter/sends')) {
      return response({ sends: [], counts: {} });
    }
    if (requestUrl.includes('/admin/newsletter/subscribers')) {
      return response({ subscribers: [], counts: { active: 0 } });
    }
    throw new Error(`Unexpected request: ${requestUrl}`);
  }));

  render(<MemoryRouter><NewsletterPage /></MemoryRouter>);
  await screen.findByText('Existing art walk');

  fireEvent(window, new Event('focus'));
  await waitFor(() => expect(finishPoll).toBeTypeOf('function'));
  expect(screen.getByText('Existing art walk')).toBeInTheDocument();
  await act(async () => {
    finishPoll(response({ error: 'Events refresh failed' }, { ok: false, status: 503 }));
  });

  expect(await screen.findByRole('alert')).toHaveTextContent('Events refresh failed');
  expect(screen.getByText('Existing art walk')).toBeInTheDocument();

  fireEvent(window, new Event('focus'));
  await screen.findByText('Fresh seafood festival');
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(screen.queryByText('Existing art walk')).not.toBeInTheDocument();
  expect(eventReads).toBe(3);
});

it('ignores an older retry failure after a newer events refresh succeeds', async () => {
  localStorage.setItem('waves_admin_token', 'fixture');
  let eventReads = 0;
  let finishRetry;
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const requestUrl = String(url);
    if (requestUrl.includes('/admin/newsletter/events?days=14&limit=12')) {
      eventReads += 1;
      if (eventReads === 1) {
        return response({ error: 'Initial event outage' }, { ok: false, status: 503 });
      }
      if (eventReads === 2) {
        // Focus lands after Retry starts but before its loading state renders,
        // so the visibility refresh becomes the newest request.
        window.dispatchEvent(new Event('focus'));
        return new Promise((resolve) => { finishRetry = resolve; });
      }
      return response({ events: [event('newest', 'Newest community market')] });
    }
    if (requestUrl.includes('/admin/newsletter/sends')) {
      return response({ sends: [], counts: {} });
    }
    if (requestUrl.includes('/admin/newsletter/subscribers')) {
      return response({ subscribers: [], counts: { active: 0 } });
    }
    throw new Error(`Unexpected request: ${requestUrl}`);
  }));

  render(<MemoryRouter><NewsletterPage /></MemoryRouter>);
  expect(await screen.findByRole('alert')).toHaveTextContent('Initial event outage');
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

  await screen.findByText('Newest community market');
  await waitFor(() => expect(finishRetry).toBeTypeOf('function'));
  await act(async () => {
    finishRetry(response({ error: 'Stale retry failure' }, { ok: false, status: 503 }));
  });

  expect(screen.getByText('Newest community market')).toBeInTheDocument();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(screen.queryByText('Loading events…')).not.toBeInTheDocument();
  expect(eventReads).toBe(3);
});

// Audit 2026-10-30 NEWS-03 / NEWS-08: History kept its mount-time rows while
// the page refreshed /sends, and a failed read looked like "No campaigns yet".
const historySend = (overrides = {}) => ({
  id: 'send-1',
  subject: 'Synthetic weekly issue',
  status: 'sending',
  recipient_count: 10,
  delivered_count: 0,
  ...overrides,
});

it('History shows the refreshed delivery status while the tab stays open', async () => {
  localStorage.setItem('waves_admin_token', 'fixture');
  let sendsReads = 0;
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const path = String(url).split('?')[0];
    if (path.endsWith('/sends')) {
      sendsReads += 1;
      const send = sendsReads === 1
        ? historySend()
        : historySend({ status: 'sent', delivered_count: 10, sent_at: '2026-10-27T10:05:00.000Z' });
      return response({ sends: [send], counts: { [send.status]: 1 } });
    }
    if (path.endsWith('/subscribers')) return response({ subscribers: [], counts: { active: 10 } });
    return response({});
  }));
  render(<MemoryRouter initialEntries={['/admin/newsletter?tab=history']}><NewsletterPage /></MemoryRouter>);
  expect(await screen.findByText('Sending…')).toBeInTheDocument();
  fireEvent(window, new Event('focus'));
  expect(await screen.findByText('Sent')).toBeInTheDocument();
  expect(screen.queryByText('Sending…')).not.toBeInTheDocument();
  expect(screen.getByText('10 (100%)')).toBeInTheDocument();
});

it('History shows a failed read with retry instead of an empty list', async () => {
  localStorage.setItem('waves_admin_token', 'fixture');
  let sendsReads = 0;
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const path = String(url).split('?')[0];
    if (path.endsWith('/sends')) {
      sendsReads += 1;
      if (sendsReads === 1) return response({ error: 'Synthetic outage' }, { ok: false, status: 503 });
      return response({ sends: [historySend({ status: 'sent' })], counts: { sent: 1 } });
    }
    if (path.endsWith('/subscribers')) return response({ subscribers: [], counts: { active: 10 } });
    return response({});
  }));
  render(<MemoryRouter initialEntries={['/admin/newsletter?tab=history']}><NewsletterPage /></MemoryRouter>);
  expect(await screen.findByText('Campaigns could not be loaded.')).toBeInTheDocument();
  expect(screen.queryByText(/No campaigns yet/)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  expect(await screen.findByText('Synthetic weekly issue')).toBeInTheDocument();
  expect(screen.queryByText('Campaigns could not be loaded.')).not.toBeInTheDocument();
});

it('History keeps the last rows through a failed refresh and marks them out of date', async () => {
  localStorage.setItem('waves_admin_token', 'fixture');
  let sendsReads = 0;
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const path = String(url).split('?')[0];
    if (path.endsWith('/sends')) {
      sendsReads += 1;
      if (sendsReads === 2) return response({ error: 'Synthetic outage' }, { ok: false, status: 503 });
      return response({ sends: [historySend({ status: 'sent' })], counts: { sent: 1 } });
    }
    if (path.endsWith('/subscribers')) return response({ subscribers: [], counts: { active: 10 } });
    return response({});
  }));
  render(<MemoryRouter initialEntries={['/admin/newsletter?tab=history']}><NewsletterPage /></MemoryRouter>);
  expect(await screen.findByText('Synthetic weekly issue')).toBeInTheDocument();
  fireEvent(window, new Event('focus'));
  expect(await screen.findByText('Campaigns could not be refreshed. This list may be out of date.')).toBeInTheDocument();
  expect(screen.getByText('Synthetic weekly issue')).toBeInTheDocument();
});

it('a failed A/B breakdown read shows an error with retry instead of loading forever', async () => {
  localStorage.setItem('waves_admin_token', 'fixture');
  let detailReads = 0;
  const abSend = historySend({ status: 'sent', subject_b: 'Synthetic subject B', delivered_count: 10 });
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const path = String(url).split('?')[0];
    if (path.endsWith('/sends/send-1')) {
      detailReads += 1;
      if (detailReads === 1) return response({ error: 'Synthetic outage' }, { ok: false, status: 503 });
      return response({ variantStats: { a: { delivered: 5, opened: 2 }, b: { delivered: 5, opened: 1 } } });
    }
    if (path.endsWith('/sends')) return response({ sends: [abSend], counts: { sent: 1 } });
    if (path.endsWith('/subscribers')) return response({ subscribers: [], counts: { active: 10 } });
    return response({});
  }));
  render(<MemoryRouter initialEntries={['/admin/newsletter?tab=history']}><NewsletterPage /></MemoryRouter>);
  fireEvent.click(await screen.findByRole('button', { name: 'Show A/B breakdown' }));
  expect(await screen.findByText("Couldn't load the A/B breakdown.")).toBeInTheDocument();
  expect(screen.queryByText('Loading variant breakdown…')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  await waitFor(() => expect(detailReads).toBe(2));
  expect(await screen.findByText('Synthetic subject B')).toBeInTheDocument();
  expect(screen.queryByText("Couldn't load the A/B breakdown.")).not.toBeInTheDocument();
});
