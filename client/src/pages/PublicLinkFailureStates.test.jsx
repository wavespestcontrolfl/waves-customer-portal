// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../glass/glass-engine', () => ({ useGlassSurface: () => {} }));
vi.mock('../components/BrandFooter', () => ({ default: () => null }));
vi.mock('../components/estimate/glass/EstimateGlassTheme', () => ({
  default: () => null,
  fireGlassConfetti: () => {},
}));

import RatePage from './RatePage';
import CardPage from './CardPage';
import PrepGuidePage from './PrepGuidePage';
import PriceChangeNoticePage from './PriceChangeNoticePage';
import StatementPayPage from './StatementPayPage';
import ProjectReportViewPage from './ProjectReportViewPage';
import PestReportViewPage from './PestReportViewPage';
import NewsletterArchivePage from './NewsletterArchivePage';
import EstimateViewPage from './EstimateViewPage';

function response(status, body = {}) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function renderRoute(path, pattern, element) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes><Route path={pattern} element={element} /></Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('public customer links distinguish temporary failures from dead links', () => {
  it.each([
    ['/rate/token-1', '/rate/:token', <RatePage />, 'feedback request'],
    ['/card/token-1', '/card/:token', <CardPage />, 'card'],
    ['/prep/token-1', '/prep/:token', <PrepGuidePage />, 'prep guide'],
    ['/price-change/token-1', '/price-change/:token', <PriceChangeNoticePage />, 'pricing notice'],
    ['/pay/statement/token-1', '/pay/statement/:token', <StatementPayPage />, 'statement'],
    ['/report/project/token-1', '/report/project/:token', <ProjectReportViewPage />, 'project report'],
    ['/pest-report/token-1', '/pest-report/:token', <PestReportViewPage />, 'pest report'],
    ['/newsletter/archive/issue-1', '/newsletter/archive/:id', <NewsletterArchivePage />, 'newsletter issue'],
    ['/estimate/token-1', '/estimate/:token', <EstimateViewPage />, 'estimate'],
  ])('shows a retryable temporary state for %s', async (path, pattern, element, resource) => {
    const fetchMock = vi.fn(async () => response(503, { error: 'unavailable' }));
    vi.stubGlobal('fetch', fetchMock);
    renderRoute(path, pattern, element);

    expect(await screen.findByText(new RegExp(`couldn.t load that ${resource}`, 'i'))).toBeInTheDocument();
    expect(screen.getByText(/link is still valid/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it('keeps a real 404 in the invalid-link state', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response(404, { error: 'not found' })));
    renderRoute('/rate/missing', '/rate/:token', <RatePage />);

    expect(await screen.findByText(/expired or already been used/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
  });

  it('returns an estimate retry to the error state after a network rejection', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(503, { error: 'unavailable' }))
      .mockRejectedValueOnce(new Error('offline'));
    vi.stubGlobal('fetch', fetchMock);
    renderRoute('/estimate/token-1', '/estimate/:token', <EstimateViewPage />);

    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(/couldn.t load that estimate/i)).toBeInTheDocument();
  });
});
