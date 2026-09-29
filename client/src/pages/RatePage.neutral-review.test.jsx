// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import RatePage from './RatePage';

// Neutral review asks (owner ruling 2026-09-29): every score is offered the
// same Google button; going to Google is always the customer's own click;
// low scores keep the private form; the AI review writer is gone.

const GOOGLE = 'https://g.page/r/waves-test/review';
const PAGE_DATA = { firstName: 'Pat', techName: 'Alex', techPhotoUrl: null, serviceDate: '2026-09-28', locationName: 'Bradenton', googleReviewUrl: GOOGLE };
const LINE = 'Public Google reviews help local neighbors choose a provider.';

let calls;
let originalLocation;

function installFetch({ pageData = PAGE_DATA, submitStatus = 200 } = {}) {
  calls = [];
  globalThis.fetch = vi.fn(async (url, opts = {}) => {
    const path = String(url).replace(/^.*\/rate\/[^/]+/, '') || '/';
    calls.push({ path, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null });
    if (path === '/') return { ok: true, status: 200, json: async () => pageData };
    if (path === '/score') return { ok: true, status: 200, json: async () => ({ saved: true }) };
    if (path === '/submit') return { ok: submitStatus < 300, status: submitStatus, json: async () => ({ category: 'x', googleReviewUrl: GOOGLE }) };
    return { ok: false, status: 404, json: async () => ({}) };
  });
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/rate/tok']}>
      <Routes><Route path="/rate/:token" element={<RatePage />} /></Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  originalLocation = window.location;
  Object.defineProperty(window, 'location', { configurable: true, writable: true, value: { href: 'https://portal.test/rate/tok' } });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  Object.defineProperty(window, 'location', { configurable: true, writable: true, value: originalLocation });
});

const submits = () => calls.filter((c) => c.path === '/submit');

describe('RatePage neutral review asks', () => {
  it('score 9: the same line and Open Google button, no AI writer, one tap to Google after the score is committed', async () => {
    installFetch();
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: '9' }));

    expect(await screen.findByText(LINE)).toBeInTheDocument();
    expect(screen.queryByText(/help me write it/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open Google' }));

    await waitFor(() => expect(window.location.href).toBe(GOOGLE));
    expect(submits()).toHaveLength(1);
    expect(submits()[0].body).toMatchObject({ score: 9, feedback: '' });
    expect(calls.some((c) => c.path === '/generate-review')).toBe(false);
  });

  it.each([2, 5])('score %i: private form kept AND the identical Google line and button offered', async (n) => {
    installFetch();
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: String(n) }));

    expect(await screen.findByPlaceholderText(/tell us what happened/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /send feedback/i })).toBeInTheDocument();
    expect(screen.getByText(LINE)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open Google' })).toBeInTheDocument();
  });

  it('a low scorer who taps Google commits the score and the typed note first (so the office alert still fires), then goes on the tap', async () => {
    installFetch();
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: '3' }));
    fireEvent.change(await screen.findByPlaceholderText(/tell us what happened/i), { target: { value: 'Missed the lanai' } });
    fireEvent.click(screen.getByRole('button', { name: 'Open Google' }));

    await waitFor(() => expect(window.location.href).toBe(GOOGLE));
    expect(submits()).toHaveLength(1);
    expect(submits()[0].body).toMatchObject({ score: 3, feedback: 'Missed the lanai' });
  });

  it('Send Feedback never auto-redirects; the success screen offers the same button and reuses the committed submit', async () => {
    installFetch();
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: '2' }));
    fireEvent.change(await screen.findByPlaceholderText(/tell us what happened/i), { target: { value: 'Rude' } });
    fireEvent.click(screen.getByRole('button', { name: /send feedback/i }));

    expect(await screen.findByText('Thank you!')).toBeInTheDocument();
    // The old promoter flow bounced to Google after 2s on its own.
    await new Promise((r) => setTimeout(r, 2300));
    expect(window.location.href).toBe('https://portal.test/rate/tok');

    fireEvent.click(screen.getByRole('button', { name: 'Open Google' }));
    await waitFor(() => expect(window.location.href).toBe(GOOGLE));
    expect(submits()).toHaveLength(1); // no second submit
  }, 10000);

  it('an already-submitted link shows the thank-you with no Google button (finality)', async () => {
    installFetch({ pageData: { alreadySubmitted: true } });
    renderPage();
    expect(await screen.findByText('Thank you!')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open Google' })).not.toBeInTheDocument();
  });
});
