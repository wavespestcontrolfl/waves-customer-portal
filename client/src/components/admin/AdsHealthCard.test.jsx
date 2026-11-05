// @vitest-environment jsdom
/**
 * Ads -> Dashboard "Ad health" card. The server route ships behind
 * GATE_ADS_HEALTH_CARD, so the card must stay invisible while GET answers 404,
 * and one failed Google section must not hide the others.
 */
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AdsHealthCard from './AdsHealthCard';

function reply(body, status = 200) {
  globalThis.fetch = vi.fn(() =>
    Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })),
  );
}

function change(i) {
  return {
    at: `2026-11-02T16:${String(10 + i).padStart(2, '0')}:00.000Z`,
    source: 'google',
    who: 'owner@example.test',
    via: 'Google Ads app',
    campaign: 'Test Search Campaign',
    what: `Change number ${i}`,
    detail: null,
  };
}

function payload(overrides = {}) {
  return {
    generatedAt: '2026-11-05T05:40:00.000Z',
    windowDays: 30,
    google: {
      configured: true,
      accountTimeZone: 'America/New_York',
      serving: {
        campaigns: [
          { id: '1', name: 'Test Search Campaign', status: 'PAUSED', primaryStatus: 'PAUSED', reasons: ['CAMPAIGN_PAUSED'], dailyBudget: 5 },
        ],
      },
      disapprovals: { total: 0, truncated: false, ads: [] },
      uploadCheck: {
        actions: [
          {
            name: 'Test - Qualified Lead',
            status: 'EXCELLENT',
            lastUploadAt: '2026-11-03T11:40:01.956Z',
            accepted: 25,
            failed: 0,
            pending: 0,
            uploadDays: 7,
            alerts: [{ error: 'UNPARSEABLE_GCLID', percent: 12.5 }],
          },
        ],
      },
    },
    uploads: {
      google: { sent: 104, pending: 7, failed: 0, lastSentAt: '2026-11-04T11:40:03.551Z' },
      meta: { sent: 108, pending: 0, failed: 0, lastSentAt: '2026-11-04T11:45:02.584Z' },
    },
    timeline: [change(1)],
    notes: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.stubGlobal('localStorage', { getItem: () => 'synthetic-token' });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('AdsHealthCard', () => {
  it('renders nothing while the gate is off (404)', async () => {
    reply({ error: 'ads_health_off' }, 404);
    const { container } = render(<AdsHealthCard />);
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByText('Loading ad health...')).not.toBeInTheDocument());
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the four sections from a payload', async () => {
    reply(payload());
    render(<AdsHealthCard />);
    expect(await screen.findByText('Ad health')).toBeInTheDocument();
    expect(screen.getByText('Paused')).toBeInTheDocument();
    expect(screen.getByText('Campaign paused')).toBeInTheDocument();
    expect(screen.getByText('$5.00/day')).toBeInTheDocument();
    expect(screen.getByText('No ads disapproved.')).toBeInTheDocument();
    expect(screen.getByText(/Google: 104 sent, 7 pending,/)).toBeInTheDocument();
    expect(screen.getByText(/Google accepted 25 in the last 7 upload days/)).toBeInTheDocument();
    expect(screen.getByText('Change number 1')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Show all/ })).not.toBeInTheDocument();
  });

  it('shows a section error but still renders the other sections', async () => {
    const body = payload();
    body.google.serving = { error: 'Google serving check failed' };
    reply(body);
    render(<AdsHealthCard />);
    expect(await screen.findByText('Google serving check failed')).toBeInTheDocument();
    expect(screen.getByText('No ads disapproved.')).toBeInTheDocument();
    expect(screen.getByText('Change number 1')).toBeInTheDocument();
  });

  it('offers Show all only past 10 timeline rows', async () => {
    reply(payload({ timeline: Array.from({ length: 12 }, (_, i) => change(i + 1)) }));
    render(<AdsHealthCard />);
    expect(await screen.findByText('Change number 10')).toBeInTheDocument();
    expect(screen.queryByText('Change number 11')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show all 12' }));
    expect(screen.getByText('Change number 12')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Show all/ })).not.toBeInTheDocument();
  });

  it('says Google Ads is not connected', async () => {
    reply(payload({ google: { configured: false, serving: null, disapprovals: null, uploadCheck: null } }));
    render(<AdsHealthCard />);
    expect(await screen.findByText('Google Ads is not connected.')).toBeInTheDocument();
    expect(screen.getByText(/Meta: 108 sent/)).toBeInTheDocument();
  });

  it('shows one muted line when the request fails', async () => {
    reply({ error: 'boom' }, 500);
    render(<AdsHealthCard />);
    expect(await screen.findByText('Ad health could not load: HTTP 500')).toBeInTheDocument();
  });
});
