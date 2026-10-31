// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import CustomerReviews, { businessFitReviews } from './CustomerReviews';

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

describe('CustomerReviews on a commercial proposal (owner 2026-10-26, choice 2A)', () => {
  const POOL = [
    { reviewerName: 'Home A.', starRating: 5, text: 'They treated around the house and the pool cage, and my dogs stayed inside the whole time.' },
    { reviewerName: 'Office B.', starRating: 5, text: 'Very knowledgeable and professional. The ant problem was under control after the first visit, as promised.' },
    { reviewerName: 'Yard C.', starRating: 5, text: 'The yard and the garden look better than ever since the team started coming every quarter.' },
    { reviewerName: 'Service D.', starRating: 5, text: 'On time, explained exactly what he treated, and followed up the next week without being asked to.' },
  ];

  it('businessFitReviews keeps only the reviews with no home, family, pets or yard words', () => {
    expect(businessFitReviews(POOL).map((r) => r.reviewerName)).toEqual(['Office B.', 'Service D.']);
  });

  it('shows the business-fit reviews under the business heading, as a glass card', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ reviews: POOL }) });
    vi.stubGlobal('fetch', fetchMock);

    render(<CustomerReviews commercial />);

    expect(await screen.findByRole('heading', { name: 'What our customers say' })).toBeInTheDocument();
    expect(fetchMock.mock.calls[0][0]).toMatch(/\/reviews\/featured\?limit=40$/);
    expect(screen.getByText('Office B.')).toBeInTheDocument();
    expect(screen.getByText('Service D.')).toBeInTheDocument();
    expect(screen.queryByText('Home A.')).not.toBeInTheDocument();
    expect(screen.queryByText('Yard C.')).not.toBeInTheDocument();
    expect(screen.getByTestId('commercial-reviews')).toHaveAttribute('data-glass', 'card');
    expect(screen.queryByText(/homeowners/i)).not.toBeInTheDocument();
  });
});
