// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import RatePage from './RatePage';

// The 1-10 rating is retired (owner ruling 2026-09-29): /rate/:token is a
// thank-you plus ONE tap to Google. Finalized or already-reviewed requests get
// the thank-you with no button.

const TRACKED = 'https://portal.test/api/rate/tok/go';
const LINE = 'Public Google reviews help local neighbors choose a provider.';

function installFetch(data, status = 200) {
  globalThis.fetch = vi.fn(async () => ({ ok: status < 300, status, json: async () => data }));
}

function renderPage(search = '') {
  return render(
    <MemoryRouter initialEntries={[`/rate/tok${search}`]}>
      <Routes><Route path="/rate/:token" element={<RatePage />} /></Routes>
    </MemoryRouter>,
  );
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('RatePage thank-you + one Google button', () => {
  it('shows the line and a single Open Google link to the tracked /go URL, with no rating or feedback form and no other calls', async () => {
    installFetch({ firstName: 'Pat', techName: 'Alex', techPhotoUrl: null, reviewUrl: TRACKED });
    renderPage();

    const link = await screen.findByRole('link', { name: 'Open Google' });
    expect(link).toHaveAttribute('href', TRACKED);
    expect(screen.getByRole('heading', { level: 1, name: 'Thank you!' })).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: 'Waves' })).not.toBeInTheDocument();
    expect(screen.getByText(LINE)).toBeInTheDocument();
    for (const n of ['1', '5', '10']) expect(screen.queryByRole('button', { name: n })).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/tell us what happened/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/help me write it/i)).not.toBeInTheDocument();
    expect(screen.getAllByRole('link')).toHaveLength(1);
    // Only the page GET — nothing is posted (score/submit/generate-review are gone).
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(globalThis.fetch.mock.calls[0][0]).toMatch(/\/rate\/tok$/);
  });

  it('a finalized request shows the thank-you with no button', async () => {
    installFetch({ alreadySubmitted: true, message: 'Thank you!' });
    renderPage();
    expect(await screen.findByText('Thank you!')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Open Google' })).not.toBeInTheDocument();
  });

  it('a customer already marked as a reviewer (reviewUrl null) gets no button', async () => {
    installFetch({ firstName: 'Pat', techName: 'Alex', techPhotoUrl: null, reviewUrl: null });
    renderPage();
    expect(await screen.findByText('Thank you!')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Open Google' })).not.toBeInTheDocument();
  });

  it('?retry=1 (a /go failure fallback) shows one short try-again line above the same button', async () => {
    installFetch({ firstName: 'Pat', techName: 'Alex', techPhotoUrl: null, reviewUrl: TRACKED });
    renderPage('?retry=1');
    expect(await screen.findByText("Couldn't open Google just now — please try again in a minute.")).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open Google' })).toHaveAttribute('href', TRACKED);
  });

  it('without ?retry=1 there is no try-again line', async () => {
    installFetch({ firstName: 'Pat', techName: 'Alex', techPhotoUrl: null, reviewUrl: TRACKED });
    renderPage();
    await screen.findByRole('link', { name: 'Open Google' });
    expect(screen.queryByText(/try again in a minute/i)).not.toBeInTheDocument();
  });

  it('uses an in-file spinner keyframe while loading and PublicStateCard on 404', async () => {
    let resolveFetch;
    globalThis.fetch = vi.fn(() => new Promise((resolve) => { resolveFetch = resolve; }));
    const { container } = renderPage();
    const spinner = container.querySelector('[data-rate-spinner]');
    expect(spinner).not.toBeNull();
    expect(spinner.style.animation).toContain('wavesRateSpin');
    expect(container.querySelector('style')?.textContent).toContain('@keyframes wavesRateSpin');

    resolveFetch({ ok: false, status: 404, json: async () => ({}) });
    expect(await screen.findByRole('heading', { level: 1, name: /isn’t available|isn't available/i })).toBeInTheDocument();
    expect(screen.getByText(/expired or already been used/i)).toBeInTheDocument();
  });
});
