// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import CustomerReviews from './CustomerReviews';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('CustomerReviews', () => {
  it('renders featured Google reviews from the shared pool', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        reviews: [
          { reviewerName: 'Dana R.', starRating: 5, text: 'Waves has been fantastic — on time, thorough, and the lawn has never looked better.', location: 'Parrish' },
          { reviewerName: 'Mike T.', starRating: 5, text: 'Great communication and the tech walked me through everything he treated around the house.', location: 'Sarasota' },
        ],
      }),
    }));

    render(<CustomerReviews />);

    expect(await screen.findByRole('heading', { name: 'Customer reviews' })).toBeInTheDocument();
    expect(screen.getByText('Dana R.')).toBeInTheDocument();
    expect(screen.getByText(/never looked better/)).toBeInTheDocument();
  });

  it('drops too-short reviews and falls back to GBP profile cards when none remain', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ reviews: [{ reviewerName: 'A', starRating: 5, text: 'Great!' }] }),
    }));

    render(<CustomerReviews />);

    expect(await screen.findAllByText('Open Google reviews')).toHaveLength(3);
    expect(screen.queryByText('Great!')).toBeNull();
  });

  it('falls back to GBP profile cards when the fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));

    render(<CustomerReviews />);

    expect(await screen.findByText(/Read current Google reviews for our Lakewood Ranch location/)).toBeInTheDocument();
  });

  it('fallback profile cards render NO star row — they are links, not reviews (estimator audit 2026-07-24)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));

    render(<CustomerReviews />);

    await screen.findByText(/Read current Google reviews for our Lakewood Ranch location/);
    expect(screen.queryByRole('img', { name: /Rated \d out of 5 stars/ })).toBeNull();
  });

  it('real reviews still render their star row', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        reviews: [{ reviewerName: 'A. Customer', starRating: 5, text: 'Great service, thorough tech, and the report was fantastic to read.' }],
      }),
    }));

    render(<CustomerReviews />);

    expect(await screen.findByRole('img', { name: 'Rated 5 out of 5 stars' })).toBeInTheDocument();
  });
});
