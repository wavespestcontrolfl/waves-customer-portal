// @vitest-environment jsdom
// The customer Messages page: the thread with its labels and times, the empty
// state, sending with one requestId per draft (a failed send keeps the text and
// the id), "Show earlier messages", mark-read through the newest Waves message,
// and the load error.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../utils/api', () => ({
  default: {
    getPortalMessages: vi.fn(),
    getPortalMessagesUnread: vi.fn(),
    sendPortalMessage: vi.fn(),
    markPortalMessagesRead: vi.fn(),
  },
}));

import api from '../../utils/api';
import PortalMessages, { makeRequestId, usePortalMessagesGate } from './PortalMessages';

const thread = [
  { id: 'm1', from: 'you', body: 'Do you spray the pool cage?', createdAt: '2026-11-03T15:30:00.000Z' },
  { id: 'm2', from: 'waves', body: 'Yes.\nEvery visit.', createdAt: '2026-11-03T16:05:00.000Z' },
];

const setVisibility = (state) => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
};

beforeEach(() => {
  vi.clearAllMocks();
  setVisibility('visible');
  api.getPortalMessages.mockResolvedValue({ messages: thread, hasMore: false, unread: 1 });
  api.markPortalMessagesRead.mockResolvedValue({ unread: 0 });
});
afterEach(() => {
  cleanup();
  setVisibility('visible');
});

const composer = () => screen.getByPlaceholderText('Write a message to the Waves team');

describe('PortalMessages thread', () => {
  it('shows the header, both labels, the times and keeps line breaks', async () => {
    render(<PortalMessages />);
    expect(await screen.findByText('Do you spray the pool cage?')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Messages' })).toBeInTheDocument();
    expect(screen.getByText('Questions and answers between you and the Waves team.')).toBeInTheDocument();
    expect(screen.getByText('You')).toBeInTheDocument();
    expect(screen.getByText('Waves Pest Control')).toBeInTheDocument();
    expect(screen.getByText('Nov 3, 10:30 AM')).toBeInTheDocument();
    expect(screen.getByText('Nov 3, 11:05 AM')).toBeInTheDocument();
    const answer = screen.getByText((_, el) => el.textContent === 'Yes.\nEvery visit.' && el.children.length === 0);
    expect(answer).toHaveStyle({ whiteSpace: 'pre-wrap' });
    expect(screen.getByText('We answer between 8 AM and 8 PM, usually within one business hour.')).toBeInTheDocument();
    expect(screen.queryByText('Show earlier messages')).toBeNull();
  });

  it('shows the empty state and the composer when there are no messages', async () => {
    api.getPortalMessages.mockResolvedValue({ messages: [], hasMore: false, unread: 0 });
    render(<PortalMessages />);
    expect(await screen.findByText(/No messages yet\. When our team answers a question you asked in the app/)).toBeInTheDocument();
    expect(composer()).toBeInTheDocument();
    expect(api.markPortalMessagesRead).not.toHaveBeenCalled();
  });

  it('prepends earlier messages from before the oldest one', async () => {
    api.getPortalMessages.mockResolvedValueOnce({ messages: thread, hasMore: true, unread: 0 });
    api.getPortalMessages.mockResolvedValueOnce({
      messages: [{ id: 'm0', from: 'waves', body: 'Welcome to Waves.', createdAt: '2026-11-01T14:00:00.000Z' }],
      hasMore: false,
      unread: 0,
    });
    render(<PortalMessages />);
    fireEvent.click(await screen.findByRole('button', { name: 'Show earlier messages' }));
    expect(await screen.findByText('Welcome to Waves.')).toBeInTheDocument();
    expect(api.getPortalMessages).toHaveBeenLastCalledWith('2026-11-03T15:30:00.000Z');
    const log = screen.getByRole('log');
    const bodies = within(log).getAllByText(/Welcome to Waves\.|Do you spray|Every visit/).map((el) => el.textContent);
    expect(bodies[0]).toBe('Welcome to Waves.');
    expect(screen.queryByRole('button', { name: 'Show earlier messages' })).toBeNull();
  });

  it('a refresh with more than one page of new messages shows the newest page and keeps the rest reachable', async () => {
    render(<PortalMessages />);
    await screen.findByText('Do you spray the pool cage?');
    const page = Array.from({ length: 50 }, (_, i) => ({
      id: `n${i}`, from: 'waves', body: `Note ${i}`, createdAt: new Date(Date.UTC(2026, 10, 4, 12, i)).toISOString(),
    }));
    api.getPortalMessages.mockResolvedValueOnce({ messages: page, hasMore: true, unread: 50 });
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(await screen.findByText('Note 49')).toBeInTheDocument();
    // No gap: the old messages left the window, and Show earlier loads from before the newest page.
    expect(screen.queryByText('Do you spray the pool cage?')).toBeNull();
    api.getPortalMessages.mockResolvedValueOnce({ messages: thread, hasMore: false, unread: 0 });
    fireEvent.click(screen.getByRole('button', { name: 'Show earlier messages' }));
    expect(await screen.findByText('Do you spray the pool cage?')).toBeInTheDocument();
    expect(api.getPortalMessages).toHaveBeenLastCalledWith(page[0].createdAt);
  });

  it('an empty thread that gets more than one page while hidden keeps the rest reachable', async () => {
    api.getPortalMessages.mockResolvedValueOnce({ messages: [], hasMore: false, unread: 0 });
    render(<PortalMessages />);
    await screen.findByText(/No messages yet|Write a message/);
    const page = Array.from({ length: 50 }, (_, i) => ({
      id: `e${i}`, from: 'waves', body: `Update ${i}`, createdAt: new Date(Date.UTC(2026, 10, 4, 13, i)).toISOString(),
    }));
    api.getPortalMessages.mockResolvedValueOnce({ messages: page, hasMore: true, unread: 51 });
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(await screen.findByText('Update 49')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show earlier messages' })).toBeInTheDocument();
  });

  it('shows Try again when the thread cannot load, and loads it on retry', async () => {
    api.getPortalMessages.mockRejectedValueOnce(new Error('offline'));
    render(<PortalMessages />);
    expect(await screen.findByText('Messages couldn’t be loaded.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Do you spray the pool cage?')).toBeInTheDocument();
  });
});

describe('PortalMessages read marker', () => {
  it('marks read through the newest Waves message once and reports the unread count', async () => {
    const onUnread = vi.fn();
    render(<PortalMessages onUnread={onUnread} />);
    await waitFor(() => expect(onUnread).toHaveBeenCalledWith(0));
    expect(api.markPortalMessagesRead).toHaveBeenCalledTimes(1);
    expect(api.markPortalMessagesRead).toHaveBeenCalledWith('m2');
    // Sending a message does not mark again: the newest Waves message is the same.
    api.sendPortalMessage.mockResolvedValue({ message: { id: 'm3', from: 'you', body: 'Thanks', createdAt: '2026-11-03T17:00:00.000Z' } });
    fireEvent.change(composer(), { target: { value: 'Thanks' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByText('Nov 3, 12:00 PM');
    expect(api.markPortalMessagesRead).toHaveBeenCalledTimes(1);
  });

  it('marks a newer answer that came while a mark was out, once that mark finishes', async () => {
    let finish;
    api.markPortalMessagesRead.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    render(<PortalMessages />);
    await waitFor(() => expect(api.markPortalMessagesRead).toHaveBeenCalledWith('m2'));
    const newer = { id: 'm5', from: 'waves', body: 'We can come at 9.', createdAt: '2026-11-03T18:00:00.000Z' };
    api.getPortalMessages.mockResolvedValue({ messages: [...thread, newer], hasMore: false, unread: 2 });
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    await screen.findByText('We can come at 9.');
    expect(api.markPortalMessagesRead).toHaveBeenCalledTimes(1);
    await act(async () => { finish({ unread: 1 }); });
    await waitFor(() => expect(api.markPortalMessagesRead).toHaveBeenLastCalledWith('m5'));
    expect(api.markPortalMessagesRead).toHaveBeenCalledTimes(2);
  });

  it('tries a failed mark again on the next refresh tick while the page stays open', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      api.markPortalMessagesRead.mockRejectedValueOnce(new TypeError('Failed to fetch'));
      render(<PortalMessages />);
      await waitFor(() => expect(api.markPortalMessagesRead).toHaveBeenCalledTimes(1));
      await act(async () => { vi.advanceTimersByTime(60 * 1000); });
      await waitFor(() => expect(api.markPortalMessagesRead).toHaveBeenCalledTimes(2));
      expect(api.markPortalMessagesRead).toHaveBeenLastCalledWith('m2');
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports a read that finishes after the customer left Messages', async () => {
    let finish;
    api.markPortalMessagesRead.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const onUnread = vi.fn();
    const { unmount } = render(<PortalMessages onUnread={onUnread} />);
    await waitFor(() => expect(api.markPortalMessagesRead).toHaveBeenCalledWith('m2'));
    unmount();
    await act(async () => { finish({ unread: 0 }); });
    expect(onUnread).toHaveBeenCalledWith(0);
  });

  it('waits while the page is hidden and marks when it comes back', async () => {
    setVisibility('hidden');
    render(<PortalMessages />);
    await screen.findByText('Do you spray the pool cage?');
    expect(api.markPortalMessagesRead).not.toHaveBeenCalled();
    setVisibility('visible');
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    await waitFor(() => expect(api.markPortalMessagesRead).toHaveBeenCalledWith('m2'));
  });
});

describe('PortalMessages composer', () => {
  it('disables Send while empty, then sends with a requestId, appends and clears', async () => {
    api.sendPortalMessage.mockResolvedValue({ message: { id: 'm3', from: 'you', body: 'Is Friday ok?', createdAt: '2026-11-03T17:00:00.000Z' } });
    render(<PortalMessages />);
    await screen.findByText('Do you spray the pool cage?');
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    fireEvent.change(composer(), { target: { value: '  Is Friday ok?  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('Is Friday ok?')).toBeInTheDocument();
    const [body, requestId] = api.sendPortalMessage.mock.calls[0];
    expect(body).toBe('Is Friday ok?');
    expect(requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(composer()).toHaveValue('');

    // The next draft gets its own requestId.
    api.sendPortalMessage.mockResolvedValue({ message: { id: 'm4', from: 'you', body: 'Second', createdAt: '2026-11-03T17:05:00.000Z' } });
    fireEvent.change(composer(), { target: { value: 'Second' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByText('Second');
    expect(api.sendPortalMessage.mock.calls[1][1]).not.toBe(requestId);
  });

  it('keeps the text and reuses the same requestId after a network failure', async () => {
    api.sendPortalMessage.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    render(<PortalMessages />);
    await screen.findByText('Do you spray the pool cage?');
    fireEvent.change(composer(), { target: { value: 'Please call me' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Your message didn’t send. Check your connection and try again.');
    expect(composer()).toHaveValue('Please call me');

    api.sendPortalMessage.mockResolvedValueOnce({ message: { id: 'm3', from: 'you', body: 'Please call me', createdAt: '2026-11-03T17:00:00.000Z' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(composer()).toHaveValue(''));
    expect(api.sendPortalMessage).toHaveBeenCalledTimes(2);
    expect(api.sendPortalMessage.mock.calls[1][1]).toBe(api.sendPortalMessage.mock.calls[0][1]);
    expect(screen.getAllByText('Please call me')).toHaveLength(1);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('gives changed text a new requestId after a failure (the first try may have been saved)', async () => {
    api.sendPortalMessage.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    render(<PortalMessages />);
    await screen.findByText('Do you spray the pool cage?');
    fireEvent.change(composer(), { target: { value: 'Please call me' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByRole('alert');
    api.sendPortalMessage.mockResolvedValueOnce({ message: { id: 'm3', from: 'you', body: 'Please call me today', createdAt: '2026-11-03T17:00:00.000Z' } });
    fireEvent.change(composer(), { target: { value: 'Please call me today' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(composer()).toHaveValue(''));
    expect(api.sendPortalMessage.mock.calls[1]).toEqual(['Please call me today', expect.any(String)]);
    expect(api.sendPortalMessage.mock.calls[1][1]).not.toBe(api.sendPortalMessage.mock.calls[0][1]);
  });

  it('keeps the draft read-only while it sends, so nothing typed then is lost', async () => {
    let finish;
    api.sendPortalMessage.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    render(<PortalMessages />);
    await screen.findByText('Do you spray the pool cage?');
    fireEvent.change(composer(), { target: { value: 'Hi there' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(composer()).toHaveAttribute('readonly'));
    await act(async () => { finish({ message: { id: 'm3', from: 'you', body: 'Hi there', createdAt: '2026-11-03T17:00:00.000Z' } }); });
    await waitFor(() => expect(composer()).not.toHaveAttribute('readonly'));
    expect(composer()).toHaveValue('');
  });

  it('shows the server text for a 400 and the wait text for a 429', async () => {
    const tooLong = Object.assign(new Error('Messages can be up to 2000 characters.'), { status: 400, code: 'TOO_LONG' });
    api.sendPortalMessage.mockRejectedValueOnce(tooLong);
    render(<PortalMessages />);
    await screen.findByText('Do you spray the pool cage?');
    fireEvent.change(composer(), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Messages can be up to 2000 characters.');

    api.sendPortalMessage.mockRejectedValueOnce(Object.assign(new Error('Too many'), { status: 429 }));
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Too many messages in a short time. Please wait a little, or call or text our office.'));
  });

  it('shows Sending… while the request is out and the counter only near the limit', async () => {
    let finish;
    api.sendPortalMessage.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    render(<PortalMessages />);
    await screen.findByText('Do you spray the pool cage?');
    expect(composer()).toHaveAttribute('maxLength', '2000');
    fireEvent.change(composer(), { target: { value: 'short' } });
    expect(screen.queryByText(/\/ 2000/)).toBeNull();
    fireEvent.change(composer(), { target: { value: 'a'.repeat(1850) } });
    expect(screen.getByText('1850 / 2000')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByRole('button', { name: 'Sending…' })).toBeDisabled();
    await act(async () => { finish({ message: { id: 'm9', from: 'you', body: 'a', createdAt: '2026-11-03T17:00:00.000Z' } }); });
  });
});

describe('makeRequestId', () => {
  it('falls back to a v4 UUID when crypto.randomUUID is missing', () => {
    const original = globalThis.crypto.randomUUID;
    Object.defineProperty(globalThis.crypto, 'randomUUID', { configurable: true, value: undefined });
    try {
      expect(makeRequestId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    } finally {
      Object.defineProperty(globalThis.crypto, 'randomUUID', { configurable: true, value: original });
    }
  });
});

describe('usePortalMessagesGate', () => {
  it('never probes when told not to', async () => {
    const { result } = renderHook(() => usePortalMessagesGate(false, 'a'));
    act(() => { result.current.probe('dashboard'); });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(api.getPortalMessagesUnread).not.toHaveBeenCalled();
    expect(result.current.enabled).toBe(false);
  });

  it('turns on with the count for a 200, and stays off for good after a 404', async () => {
    api.getPortalMessagesUnread.mockResolvedValueOnce({ count: 2 });
    const on = renderHook(() => usePortalMessagesGate(true, 'a'));
    act(() => { on.result.current.probe('dashboard'); });
    await waitFor(() => expect(on.result.current).toMatchObject({ enabled: true, unread: 2 }));

    api.getPortalMessagesUnread.mockRejectedValueOnce(Object.assign(new Error('x'), { status: 404 }));
    const off = renderHook(() => usePortalMessagesGate(true, 'b'));
    act(() => { off.result.current.probe('dashboard'); });
    await waitFor(() => expect(off.result.current.off).toBe(true));
    const calls = api.getPortalMessagesUnread.mock.calls.length;
    act(() => { off.result.current.probe('plan'); });
    expect(api.getPortalMessagesUnread.mock.calls.length).toBe(calls);
  });

  it('a probe that asked before a read cannot put the count back once the customer leaves Messages', async () => {
    let answer;
    api.getPortalMessagesUnread.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
    const { result } = renderHook(() => usePortalMessagesGate(true, 'a'));
    act(() => { result.current.probe('messages'); });
    await waitFor(() => expect(api.getPortalMessagesUnread).toHaveBeenCalledTimes(1));
    // The page reads the thread, then the customer goes Home; that probe answers 0.
    api.getPortalMessagesUnread.mockResolvedValueOnce({ count: 0 });
    act(() => { result.current.setUnread(0); result.current.probe('dashboard'); });
    await waitFor(() => expect(result.current.enabled).toBe(true));
    // The first probe answers late with the count from before the read.
    await act(async () => { answer({ count: 3 }); });
    expect(result.current.unread).toBe(0);
  });

  it('drops a read result from an earlier session', async () => {
    api.getPortalMessagesUnread.mockResolvedValue({ count: 2 });
    const { result, rerender } = renderHook(({ key }) => usePortalMessagesGate(true, key), { initialProps: { key: 'a' } });
    const earlier = result.current.setUnread;
    rerender({ key: 'b' });
    act(() => { result.current.probe('dashboard'); });
    await waitFor(() => expect(result.current.unread).toBe(2));
    act(() => { earlier(0); });
    expect(result.current.unread).toBe(2);
  });

  it('does not put a count back while the customer is on the Messages tab', async () => {
    api.getPortalMessagesUnread.mockResolvedValue({ count: 3 });
    const { result } = renderHook(() => usePortalMessagesGate(true, 'a'));
    act(() => { result.current.probe('dashboard'); });
    await waitFor(() => expect(result.current.unread).toBe(3));
    act(() => { result.current.setUnread(0); result.current.probe('messages'); });
    await waitFor(() => expect(api.getPortalMessagesUnread).toHaveBeenCalledTimes(2));
    expect(result.current.unread).toBe(0);
  });
});
