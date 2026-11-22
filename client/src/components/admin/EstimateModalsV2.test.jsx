// @vitest-environment jsdom
// UI audit F0076: the modals surface the server's error reason, not "HTTP 409".
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeclineModalV2, FollowUpModalV2 } from './EstimateModalsV2';

beforeEach(() => {
  localStorage.setItem('waves_admin_token', 'test-token');
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('DeclineModalV2 error surfacing', () => {
  it('alerts with the server reason on a 409', async () => {
    const reason = 'This estimate is held for a re-price (a customer clarify reply).';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: reason }), { status: 409, headers: { 'Content-Type': 'application/json' } })));
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    const onSaved = vi.fn();
    render(<DeclineModalV2 estimate={{ id: 'e1', customerName: 'Pat Customer' }} onClose={() => {}} onSaved={onSaved} />);
    fireEvent.click(screen.getAllByRole('radio')[0]);
    fireEvent.click(screen.getByRole('button', { name: /mark as lost|save/i }));
    await waitFor(() => expect(alertSpy).toHaveBeenCalledTimes(1));
    expect(alertSpy.mock.calls[0][0]).toContain(reason);
    expect(alertSpy.mock.calls[0][0]).not.toContain('HTTP 409');
    expect(onSaved).not.toHaveBeenCalled();
  });
});

describe('FollowUpModalV2 ready text', () => {
  const estimate = { id: 'e1', customerName: 'Dana Fixture', address: '12 Example St, Town' };
  const DEFAULT_TEXT = 'Hi Dana, just checking in on the estimate I sent for 12 Example St. Any questions?';
  const DRAFT = "Hi Dana, it's Waves. Your lawn care estimate is here: https://portal.example.test/estimate/tok Any questions? Just reply to this text.";
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const box = () => screen.getByRole('textbox');

  it('shows the default words at once, then the server draft when the person has not typed', async () => {
    const fetchMock = vi.fn(async () => json({ message: DRAFT }));
    vi.stubGlobal('fetch', fetchMock);
    render(<FollowUpModalV2 estimate={estimate} onClose={() => {}} onSent={() => {}} />);
    expect(box()).toHaveValue(DEFAULT_TEXT);
    await waitFor(() => expect(box()).toHaveValue(DRAFT));
    expect(String(fetchMock.mock.calls[0][0])).toContain('/admin/estimates/e1/follow-up-draft');
  });

  it('keeps the text the person typed when the draft arrives late', async () => {
    let release;
    vi.stubGlobal('fetch', vi.fn(() => new Promise((resolve) => { release = () => resolve(json({ message: DRAFT })); })));
    render(<FollowUpModalV2 estimate={estimate} onClose={() => {}} onSent={() => {}} />);
    fireEvent.change(box(), { target: { value: 'My own words' } });
    release();
    await new Promise((r) => setTimeout(r, 20));
    expect(box()).toHaveValue('My own words');
  });

  it('keeps the default words for a null draft', async () => {
    const fetchMock = vi.fn(async () => json({ message: null }));
    vi.stubGlobal('fetch', fetchMock);
    render(<FollowUpModalV2 estimate={estimate} onClose={() => {}} onSent={() => {}} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(box()).toHaveValue(DEFAULT_TEXT);
  });

  it('keeps the default words and raises no alert when the draft fails', async () => {
    const fetchMock = vi.fn(async () => json({ error: 'boom' }, 500));
    vi.stubGlobal('fetch', fetchMock);
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    render(<FollowUpModalV2 estimate={estimate} onClose={() => {}} onSent={() => {}} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(box()).toHaveValue(DEFAULT_TEXT);
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('sends the text in the box', async () => {
    const fetchMock = vi.fn(async (url) => (String(url).endsWith('/follow-up-draft') ? json({ message: DRAFT }) : json({ success: true })));
    vi.stubGlobal('fetch', fetchMock);
    const onSent = vi.fn();
    render(<FollowUpModalV2 estimate={estimate} onClose={() => {}} onSent={onSent} />);
    await waitFor(() => expect(box()).toHaveValue(DRAFT));
    fireEvent.click(screen.getByRole('button', { name: /send follow-up sms/i }));
    await waitFor(() => expect(onSent).toHaveBeenCalled());
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
    expect(String(post[0])).toContain('/admin/estimates/e1/follow-up');
    expect(JSON.parse(post[1].body)).toEqual({ message: DRAFT });
  });
});
