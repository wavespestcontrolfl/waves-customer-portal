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
