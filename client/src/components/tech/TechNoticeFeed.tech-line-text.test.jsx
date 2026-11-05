// @vitest-environment jsdom
// A text to the tech's own Twilio line (tech-line.js → tech_line_sms) renders
// as a kept card: sender, body, "Got it" dismiss — never the 5-minute timer.
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TechNoticeFeed from './TechNoticeFeed';

const TEXT = {
  id: 'n-text', type: 'tech_line_sms', message: 'server message', created_at: '2026-09-08T18:41:00Z',
  payload: { headline: 'Text on your line', customer_name: 'Maria Ruiz', from: '+19415550199', body: 'Gate code is 4412, dog is friendly', media_count: 0 },
};
const PHOTOS = {
  id: 'n-photos', type: 'tech_line_sms', message: 'server message', created_at: '2026-09-08T18:42:00Z',
  payload: { headline: 'Text on your line', customer_name: '(941) 555-0199', from: '+19415550199', body: '', media_count: 2 },
};

function stubFeed(notifications) {
  const calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || 'GET' });
    if (!init.method) return { ok: true, json: async () => ({ notifications }) };
    return { ok: true, json: async () => ({}) };
  }));
  return calls;
}

describe('TechNoticeFeed — tech line text card', () => {
  beforeEach(() => {
    localStorage.setItem('waves_admin_token', 'tech-token');
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    cleanup();
    localStorage.clear();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('shows who texted and what they said; a photos-only text names the media', async () => {
    stubFeed([TEXT, PHOTOS]);
    render(<TechNoticeFeed />);
    await act(async () => { await Promise.resolve(); });
    const cards = await screen.findAllByTestId('tech-line-text');
    expect(cards).toHaveLength(2);
    // newest first
    expect(cards[0]).toHaveTextContent('(941) 555-0199');
    expect(cards[0]).toHaveTextContent('2 photos');
    expect(cards[1]).toHaveTextContent('Text on your line');
    expect(cards[1]).toHaveTextContent('Maria Ruiz');
    expect(cards[1]).toHaveTextContent('Gate code is 4412, dog is friendly');
  });

  // Reply (C17): the server names the visit (reply_visit_id) only for the tech's own visit when
  // the phone on file texted; Reply sends from the tech's own line through POST /tech/line/sms.
  const LINE = { line: { number: '+19413529161', formatted: '(941) 352-9161', label: 'Tech line' } };
  const REPLYABLE = { ...TEXT, payload: { ...TEXT.payload, reply_visit_id: 'svc-1' } };

  it('Reply texts back from the tech\'s line through the visit the card names; Got it waits for the send', async () => {
    stubFeed([REPLYABLE]);
    let finishSend;
    const request = vi.fn(() => new Promise((resolve) => { finishSend = resolve; }));
    render(<TechNoticeFeed techLine={LINE} request={request} />);
    await act(async () => { await Promise.resolve(); });
    fireEvent.click(await screen.findByRole('button', { name: 'Reply' }));
    expect(screen.getByTestId('line-text-compose')).toHaveTextContent('Text from your line (941) 352-9161');
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Be there in 10' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(request).toHaveBeenCalledWith('/tech/line/sms', {
      method: 'POST', body: JSON.stringify({ scheduledServiceId: 'svc-1', body: 'Be there in 10' }),
    });
    expect(screen.getByRole('button', { name: 'Got it' })).toBeDisabled();
    await act(async () => { finishSend({ ok: true }); });
    expect(await screen.findByText('Sent.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Got it' })).not.toBeDisabled();
  });

  it.each([
    ['the tech holds no line', REPLYABLE, null],
    ['the line could not be checked', REPLYABLE, { unknown: true }],
    ['the card names no visit', TEXT, LINE],
  ])('no Reply when %s', async (_label, card, techLine) => {
    stubFeed([card]);
    render(<TechNoticeFeed techLine={techLine} request={vi.fn()} />);
    await act(async () => { await Promise.resolve(); });
    expect(await screen.findByTestId('tech-line-text')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reply' })).not.toBeInTheDocument();
  });

  it('stays until "Got it" (dismiss); the reminder timer never marks it read', async () => {
    const calls = stubFeed([TEXT]);
    render(<TechNoticeFeed />);
    await act(async () => { await Promise.resolve(); });
    expect(await screen.findByTestId('tech-line-text')).toBeInTheDocument();

    await act(async () => { vi.advanceTimersByTime(6 * 60 * 1000); });
    expect(screen.getByTestId('tech-line-text')).toBeInTheDocument();
    expect(calls.some((c) => c.url.endsWith('/read'))).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Got it' }));
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByTestId('tech-line-text')).not.toBeInTheDocument();
    expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/n-text/dismiss'))).toBe(true);
  });
});
