// @vitest-environment jsdom
// Expired estimate card: when the /data 404 body is the eligible-expired one
// (extensionRequestEligible + expiresAt), the card says plainly that the
// estimate expired, shows the sent and expiry dates in ET, and words the
// button for a self-serve reopen vs an office request. Any other 404 keeps the
// old "Estimate unavailable" copy.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import EstimateViewPage from './EstimateViewPage';

vi.mock('react-router-dom', () => ({
  useParams: () => ({ token: 'expired-card-token' }),
}));

vi.mock('../lib/stripeLoader', () => ({
  loadStripeSdk: vi.fn(async () => null),
}));

function stub404(body) {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, json: async () => body })));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('EstimateViewPage expired card', () => {
  it('says the estimate expired, with sent and expiry dates in ET, and offers a self-serve reopen', async () => {
    // 01:30 UTC on Oct 29 is still Oct 28 in New York; 03:00 UTC on Nov 5 is Nov 4.
    stub404({
      error: 'Estimate not found',
      extensionRequestEligible: true,
      expiresAt: '2026-11-05T03:00:00.000Z',
      sentAt: '2026-10-29T01:30:00.000Z',
      extensionSelfServe: true,
    });
    render(<EstimateViewPage />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Your estimate expired' })).toBeInTheDocument();
    expect(screen.getByText(/Your estimate from Oct 28 expired on Nov 4\./)).toBeInTheDocument();
    expect(screen.getByText(/Tap below to reopen it for 7 days at the same price\./)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reopen my estimate' })).toBeInTheDocument();
    const phone = screen.getByRole('link', { name: '(941) 297-5749' });
    expect(phone).toHaveAttribute('href', expect.stringMatching(/^tel:/));
    expect(screen.queryByText(/Estimate unavailable/)).not.toBeInTheDocument();
  });

  it('asks the office for more time once the self-serve reopen is used', async () => {
    stub404({
      error: 'Estimate not found',
      extensionRequestEligible: true,
      expiresAt: '2026-11-05T03:00:00.000Z',
      sentAt: '2026-10-29T01:30:00.000Z',
    });
    render(<EstimateViewPage />);
    expect(await screen.findByText(/Tap below to ask our office for more time\./)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Ask for more time' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reopen my estimate' })).not.toBeInTheDocument();
  });

  it('drops "from {date}" when the send date is missing', async () => {
    stub404({
      error: 'Estimate not found',
      extensionRequestEligible: true,
      expiresAt: '2026-11-05T03:00:00.000Z',
      extensionSelfServe: true,
    });
    render(<EstimateViewPage />);
    expect(await screen.findByText(/Your estimate expired on Nov 4\./)).toBeInTheDocument();
  });

  it('keeps the old copy and shows no button for a bare 404', async () => {
    stub404({ error: 'Estimate not found' });
    render(<EstimateViewPage />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Estimate unavailable' })).toBeInTheDocument();
    expect(screen.getByText(/This link may have expired or isn't valid\./)).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('button')).not.toBeInTheDocument());
  });

  it('keeps the old copy for an eligible 404 without an expiry date', async () => {
    stub404({ error: 'Estimate not found', extensionRequestEligible: true });
    render(<EstimateViewPage />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Estimate unavailable' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Request an extension' })).toBeInTheDocument();
  });
});
