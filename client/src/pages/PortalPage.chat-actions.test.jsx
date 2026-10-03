// @vitest-environment jsdom
// Waves Assistant buttons: the chat renders only the buttons the server built
// (a self-serve reschedule page or a known portal tab), and says the team was
// notified only when the server says the bell rang.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({ enabled: false }));
vi.mock('../native/platform', async (importOriginal) => ({ ...await importOriginal(), isNativeApp: () => native.enabled }));
vi.mock('../native/nativeFile', () => ({ canSaveNative: () => false, canShareNative: () => true, saveBlobNative: vi.fn(), saveUrlNative: vi.fn(), shareUrlNative: vi.fn(async () => true) }));

vi.mock('../utils/api', () => {
  const target = {};
  const proxy = new Proxy(target, {
    get: (obj, prop) => {
      if (typeof prop !== 'string') return obj[prop];
      if (!(prop in obj)) obj[prop] = vi.fn(() => new Promise(() => {}));
      return obj[prop];
    },
    set: (obj, prop, value) => { obj[prop] = value; return true; },
  });
  return { default: proxy };
});

import api from '../utils/api';
import { ChatWidget } from './PortalPage';

const customer = { id: 'cust-1', firstName: 'Pat' };
const NOTIFIED_LINE = 'A team member has been notified and will follow up shortly.';
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.clearAllMocks();
  native.enabled = false;
  Element.prototype.scrollIntoView = vi.fn();
  window.scrollTo = vi.fn();
  window.matchMedia = window.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
});
afterEach(() => cleanup());

async function ask(reply, onNavigate = vi.fn()) {
  api.request.mockResolvedValue(reply);
  render(<ChatWidget customer={customer} initialQuestion="Reschedule my visit" onClose={() => {}} onNavigate={onNavigate} />);
  await settle();
  return onNavigate;
}

describe('assistant reply buttons', () => {
  it('renders a reschedule link and a portal tab button, and drops anything else', async () => {
    const onNavigate = await ask({
      reply: 'Tap the button to pick a new time.',
      actions: [
        { type: 'link', label: 'Reschedule Pest Control, Oct 9', href: '/reschedule/tok_one' },
        { type: 'link', label: 'Elsewhere', href: 'https://example.com/reschedule/tok' },
        { type: 'link', label: 'Admin', href: '/admin/customers' },
        { type: 'link', label: 'Book your free pest control re-service', href: '/reservice/tok_rs' },
        { type: 'link', label: 'Off-site re-service', href: 'https://example.com/reservice/tok' },
        { type: 'link', label: 'Traversal', href: '/reservice/../admin' },
        { type: 'tab', label: 'Open Billing', tab: 'billing' },
        { type: 'tab', label: 'Open Admin', tab: 'admin' },
      ],
    });

    expect(screen.getByRole('link', { name: 'Reschedule Pest Control, Oct 9' })).toHaveAttribute('href', '/reschedule/tok_one');
    expect(screen.queryByText('Elsewhere')).toBeNull();
    expect(screen.queryByText('Admin')).toBeNull();
    expect(screen.getByRole('link', { name: 'Book your free pest control re-service' })).toHaveAttribute('href', '/reservice/tok_rs');
    expect(screen.queryByText('Off-site re-service')).toBeNull();
    expect(screen.queryByText('Traversal')).toBeNull();
    expect(screen.queryByText('Open Admin')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Open Billing' }));
    expect(onNavigate).toHaveBeenCalledWith('billing');
  });

  it('renders every button the server can build at once: six tabs, three reschedule links, the re-service link and two booked re-service moves', async () => {
    const tabs = ['billing', 'schedule', 'services', 'plan', 'documents', 'refer'].map((tab) => ({ type: 'tab', label: `Open ${tab}`, tab }));
    const links = ['a', 'b', 'c', 'd', 'e'].map((t) => ({ type: 'link', label: `Reschedule ${t}`, href: `/reschedule/tok_${t}` }));
    await ask({ reply: 'Here you go.', actions: [...tabs, ...links, { type: 'link', label: 'Book your free re-service', href: '/reservice/tok_rs' }] });

    expect(screen.getByRole('link', { name: 'Book your free re-service' })).toHaveAttribute('href', '/reservice/tok_rs');
    expect(screen.getAllByRole('link')).toHaveLength(6);
    expect(screen.getAllByRole('button', { name: /^Open / })).toHaveLength(6);
  });

  it('a reply with no actions renders no buttons', async () => {
    await ask({ reply: 'Ghost ants follow moisture.' });
    expect(screen.getByText('Ghost ants follow moisture.')).toBeInTheDocument();
    expect(screen.queryByRole('link')).toBeNull();
  });
});

describe('payment card', () => {
  it('renders the server-rendered rows and only Waves receipt links', async () => {
    await ask({
      reply: 'The card below has your recent payments.',
      cards: [{ type: 'payments', title: 'Your last 2 payments', rows: [
        { id: 'p1', description: 'Invoice WV-1042', dateLabel: 'Sep 28, 2026', amountLabel: '$129.00', statusLabel: 'Paid', methodLabel: 'Visa ending in 4242', receiptUrl: '/receipt/tok_abc' },
        { id: 'p2', description: 'Silver WaveGuard Monthly', dateLabel: 'Aug 28, 2026', amountLabel: '$1,250.50', statusLabel: 'Failed', methodLabel: '', receiptUrl: 'https://evil.example/receipt/x' },
      ] }, { type: 'unknown', rows: [{ id: 'z' }] }],
    });
    expect(screen.getByText('Your last 2 payments')).toBeInTheDocument();
    expect(screen.getByText('$129.00')).toBeInTheDocument();
    expect(screen.getByText('Sep 28, 2026 · Visa ending in 4242 · Paid')).toBeInTheDocument();
    expect(screen.getByText('Aug 28, 2026 · Failed')).toBeInTheDocument();
    const links = screen.getAllByRole('link', { name: 'View receipt' });
    expect(links).toHaveLength(1);
    expect(links[0].getAttribute('href')).toMatch(/\/receipt\/tok_abc$/);
  });
});

describe('visits card', () => {
  it('renders each visit with its summary and only Waves report links', async () => {
    await ask({
      reply: 'Your last visit was Sep 28.',
      cards: [{ type: 'visits', title: 'Your last 2 visits', rows: [
        { id: 's1', service: 'Quarterly Pest Control', dateLabel: 'Sep 28, 2026', technician: 'Jordan', summary: 'Treated the lanai.', reportUrl: '/report/tok_r' },
        { id: 's2', service: 'Lawn Care', dateLabel: 'Aug 20, 2026', technician: null, summary: null, reportUrl: 'https://evil.example/report/x' },
      ] }],
    });
    expect(screen.getByText('Your last 2 visits')).toBeInTheDocument();
    expect(screen.getByText('Sep 28, 2026 · Jordan')).toBeInTheDocument();
    expect(screen.getByText('Treated the lanai.')).toBeInTheDocument();
    const links = screen.getAllByRole('link', { name: 'View report' });
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute('href', '/report/tok_r');
  });
});

describe('payment card in the native app', () => {
  it('hands the receipt to the share sheet instead of a blank-target link', async () => {
    native.enabled = true;
    const { shareUrlNative } = await import('../native/nativeFile');
    await ask({ reply: 'Here.', cards: [{ type: 'payments', title: 'Your most recent payment', rows: [
      { id: 'p1', description: 'Invoice WV-1', dateLabel: 'Sep 28, 2026', amountLabel: '$129.00', statusLabel: 'Paid', methodLabel: '', receiptUrl: '/receipt/tok_abc' },
    ] }] });
    expect(screen.queryByRole('link', { name: 'View receipt' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'View receipt' }));
    await settle();
    expect(shareUrlNative).toHaveBeenCalledWith(expect.stringMatching(/\/receipt\/tok_abc$/), 'Waves receipt');
  });
});

describe('hand-off notice', () => {
  it('is shown when the server rang the bell', async () => {
    await ask({ reply: "I've sent this to our team.", escalated: true, teamNotified: true });
    expect(screen.getByText(NOTIFIED_LINE)).toBeInTheDocument();
  });

  it('is not shown when nobody was paged', async () => {
    await ask({ reply: "I've saved your request for our team.", escalated: true, teamNotified: false });
    expect(screen.queryByText(NOTIFIED_LINE)).toBeNull();
  });

  it('keeps the earlier behavior for a server that sends no teamNotified field', async () => {
    await ask({ reply: "I'm connecting you with our team right now.", escalated: true });
    expect(screen.getByText(NOTIFIED_LINE)).toBeInTheDocument();
  });
});

describe('AI response reports', () => {
  it('reports the selected older reply with that reply\'s server conversation id', async () => {
    const olderConversationId = '11111111-1111-4111-8111-111111111111';
    const newerConversationId = '22222222-2222-4222-8222-222222222222';
    api.request
      .mockResolvedValueOnce({ reply: 'Older assistant reply.', conversationId: olderConversationId })
      .mockResolvedValueOnce({ reply: 'Newer assistant reply.', conversationId: newerConversationId })
      .mockResolvedValueOnce({ success: true });
    render(<ChatWidget customer={customer} initialQuestion="First question" onClose={() => {}} onNavigate={() => {}} />);
    await settle();

    fireEvent.change(screen.getByLabelText('Chat message'), { target: { value: 'Second question' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await settle();
    fireEvent.click(screen.getAllByRole('button', { name: 'Report this AI response as inappropriate' })[0]);
    await settle();

    const chatCall = api.request.mock.calls.find(([path]) => path === '/ai/chat');
    const reportCall = api.request.mock.calls.find(([path]) => path === '/ai/chat/report');
    expect(JSON.parse(reportCall[1].body)).toEqual({
      sessionId: JSON.parse(chatCall[1].body).sessionId,
      conversationId: olderConversationId,
      messageContent: 'Older assistant reply.',
    });
  });
});

describe('durable chat retry', () => {
  it('preserves a new draft and reuses the request id and user bubble after an ambiguous transport failure', async () => {
    const pending = deferred();
    api.request
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce({ reply: 'Your request was already received.', escalated: false });
    render(<ChatWidget
      customer={customer}
      initialQuestion="Please cancel my service"
      onClose={() => {}}
      onNavigate={() => {}}
    />);
    await settle();

    fireEvent.change(screen.getByLabelText('Chat message'), { target: { value: 'Also, what about the lanai?' } });
    await act(async () => {
      pending.reject(new Error('connection lost'));
      await Promise.resolve();
    });
    expect(screen.getByLabelText('Chat message')).toHaveValue('Also, what about the lanai?');

    fireEvent.change(screen.getByLabelText('Chat message'), { target: { value: 'Please cancel my service' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await settle();

    const chatCalls = api.request.mock.calls.filter(([path]) => path === '/ai/chat');
    expect(chatCalls).toHaveLength(2);
    const firstBody = JSON.parse(chatCalls[0][1].body);
    const retryBody = JSON.parse(chatCalls[1][1].body);
    expect(firstBody.requestId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(retryBody).toEqual(firstBody);
    expect(screen.getAllByText('Please cancel my service')).toHaveLength(1);
    expect(screen.getByText('Your request was already received.')).toBeInTheDocument();
  });

  it('preserves a new draft and reuses the request id when the coordinator asks the client to retry', async () => {
    const pending = deferred();
    api.request
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce({ reply: 'Your request was already received.', escalated: false });
    render(<ChatWidget
      customer={customer}
      initialQuestion="Please cancel my service"
      onClose={() => {}}
      onNavigate={() => {}}
    />);
    await settle();

    fireEvent.change(screen.getByLabelText('Chat message'), { target: { value: 'Also, what about the lanai?' } });
    await act(async () => {
      pending.resolve({ reply: 'Still working on that request.', retryable: true });
      await Promise.resolve();
    });
    expect(screen.getByLabelText('Chat message')).toHaveValue('Also, what about the lanai?');

    fireEvent.change(screen.getByLabelText('Chat message'), { target: { value: 'Please cancel my service' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await settle();

    const chatCalls = api.request.mock.calls.filter(([path]) => path === '/ai/chat');
    expect(chatCalls).toHaveLength(2);
    expect(JSON.parse(chatCalls[1][1].body)).toEqual(JSON.parse(chatCalls[0][1].body));
    expect(screen.getAllByText('Please cancel my service')).toHaveLength(1);
    expect(screen.getByText('Still working on that request.')).toBeInTheDocument();
    expect(screen.getByText('Your request was already received.')).toBeInTheDocument();
  });

  it('times out a request stalled in the actual refresh Web Lock and retains its request id', async () => {
    vi.useFakeTimers();
    const originalFetch = globalThis.fetch;
    const locksDescriptor = Object.getOwnPropertyDescriptor(navigator, 'locks');
    try {
      const { ApiClient } = await vi.importActual('../utils/api');
      const stalledClient = new ApiClient();
      stalledClient.token = 'expired-access';
      stalledClient.refreshToken = 'refresh-token';
      globalThis.fetch = vi.fn().mockResolvedValue({ status: 401 });
      const lockRequest = vi.fn(() => new Promise(() => {}));
      Object.defineProperty(navigator, 'locks', {
        configurable: true,
        value: { request: lockRequest },
      });
      api.request.mockImplementation((...args) => stalledClient.request(...args));

      render(<ChatWidget
        customer={customer}
        initialQuestion="Please cancel my service"
        onClose={() => {}}
        onNavigate={() => {}}
      />);
      await act(async () => { await Promise.resolve(); });
      expect(lockRequest).toHaveBeenCalledWith('waves-customer-refresh', { mode: 'exclusive' }, expect.any(Function));

      await act(async () => { await vi.advanceTimersByTimeAsync(17_000); });
      expect(screen.getByLabelText('Chat message')).toHaveValue('Please cancel my service');
      expect(screen.getByText(/Connection issue/)).toBeInTheDocument();

      api.request.mockResolvedValueOnce({ reply: 'Your request was already received.', escalated: true });
      fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
      await act(async () => { await Promise.resolve(); });

      const chatCalls = api.request.mock.calls.filter(([path]) => path === '/ai/chat');
      expect(chatCalls).toHaveLength(2);
      expect(JSON.parse(chatCalls[1][1].body)).toEqual(JSON.parse(chatCalls[0][1].body));
      expect(screen.getAllByText('Please cancel my service')).toHaveLength(1);
      expect(screen.getByText('Your request was already received.')).toBeInTheDocument();
    } finally {
      globalThis.fetch = originalFetch;
      if (locksDescriptor) Object.defineProperty(navigator, 'locks', locksDescriptor);
      else delete navigator.locks;
      vi.useRealTimers();
    }
  });
});
