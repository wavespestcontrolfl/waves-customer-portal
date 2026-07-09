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
});
