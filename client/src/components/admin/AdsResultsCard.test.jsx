// @vitest-environment jsdom
/**
 * Ads -> Dashboard "Ad results" card. Campaign lines add the days up; a click opens the per-day view; a bad reply
 * shows a muted line, never a crash.
 */
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AdsResultsCard, { rollUp } from './AdsResultsCard';

const zero = {
  spend: 0, clicks: 0, leads: 0, calls: 0, booked: 0, paid_customers: 0, plan_customers: 0, one_time_customers: 0,
  paid90: 0, cancels: 0, customers: [], rain_day: null,
};
const rows = [
  { ...zero, date: '2026-10-01', campaign_id: 'a', campaign: 'Test Campaign A', platform: 'google_ads', spend: 10, leads: 2, paid_customers: 1, plan_customers: 1, paid90: 40, rain_day: { call: 'rain', cutoff_call: 'rain', wet_day: true } },
  { ...zero, date: '2026-10-02', campaign_id: 'a', campaign: 'Test Campaign A', platform: 'google_ads', spend: 5, leads: 1 },
  { ...zero, date: '2026-10-01', campaign_id: null, campaign: '(no campaign)', platform: 'google_lsa', leads: 3, one_time_customers: 1, paid_customers: 1 },
];

function reply(body, status = 200) {
  globalThis.fetch = vi.fn(() =>
    Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })),
  );
}

afterEach(() => cleanup());

describe('rollUp', () => {
  it('adds a campaign days up and puts the highest spend first', () => {
    const groups = rollUp(rows);
    expect(groups.map((g) => g.campaign)).toEqual(['Test Campaign A', '(no campaign)']);
    expect(groups[0].total).toMatchObject({ spend: 15, leads: 3, paid_customers: 1, paid90: 40 });
    expect(groups[0].days.map((d) => d.date)).toEqual(['2026-10-02', '2026-10-01']);
  });
});

describe('AdsResultsCard', () => {
  it('counts a rain date once in the total, and names the source of an unlinked line', async () => {
    const twoCampaigns = [
      ...rows,
      { ...zero, date: '2026-10-01', campaign_id: 'b', campaign: 'Test Campaign B', platform: 'google_ads', spend: 1, rain_day: { call: 'rain', cutoff_call: 'rain', wet_day: true } },
    ];
    reply({ period: '90d', since: 'x', until: 'y', rows: twoCampaigns, totals: zero });
    render(<AdsResultsCard />);
    await screen.findByText('Test Campaign B');
    expect(screen.getByRole('button', { name: 'Show days for (no campaign) · Google LSA' })).toBeInTheDocument();
    const totalRow = screen.getAllByRole('row').at(-1);
    expect(totalRow.textContent).toContain('1 called, 1 of 1 wet');
  });

  it('shows campaign lines and opens the per-day view', async () => {
    reply({ period: '90d', since: '2026-10-01', until: '2026-12-29', rows, totals: { ...zero, spend: 15, leads: 6 } });
    render(<AdsResultsCard />);
    await screen.findByText('Test Campaign A');
    expect(globalThis.fetch.mock.calls[0][0]).toContain('/admin/ads/results?period=90d');
    expect(screen.getAllByText('1 called, 1 of 1 wet').length).toBeGreaterThan(0);
    expect(screen.queryByText('2 PM call rain, it rained')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show days for Test Campaign A' }));
    expect(screen.getByText('2 PM call rain, it rained')).toBeInTheDocument();
  });

  it('a slow old reply never replaces the newer period', async () => {
    let finishOld;
    const oldBody = new Promise((resolve) => { finishOld = resolve; });
    const newRows = [{ ...zero, date: '2026-10-01', campaign_id: 'n', campaign: 'Newer Campaign', platform: 'google_ads' }];
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: () => oldBody })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ rows: newRows, totals: zero }) });
    render(<AdsResultsCard />);
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: '30 days' }));
    await screen.findByText('Newer Campaign');
    finishOld({ rows, totals: zero });
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByText('Test Campaign A')).toBeNull();
    expect(screen.getByText('Newer Campaign')).toBeInTheDocument();
  });

  it('counts the recorded 2 PM forecast call, not a later forecast', async () => {
    const changed = [
      { ...zero, date: '2026-10-05', campaign_id: 'c', campaign: 'Test Campaign C', platform: 'google_ads', rain_day: { call: 'rain', cutoff_call: 'dry', wet_day: false } },
      { ...zero, date: '2026-10-07', campaign_id: 'c', campaign: 'Test Campaign C', platform: 'google_ads', rain_day: { call: null, cutoff_call: 'unknown', wet_day: null } },
      { ...zero, date: '2026-10-06', campaign_id: 'c', campaign: 'Test Campaign C', platform: 'google_ads', rain_day: { call: 'rain', cutoff_call: null, wet_day: null } },
    ];
    reply({ period: '90d', since: 'x', until: 'y', rows: changed, totals: zero });
    render(<AdsResultsCard />);
    await screen.findByText('Test Campaign C');
    expect(screen.getAllByRole('row').at(-1).textContent).not.toContain('called');
    fireEvent.click(screen.getByRole('button', { name: 'Show days for Test Campaign C' }));
    expect(screen.getByText('2 PM call dry, stayed dry')).toBeInTheDocument();
    expect(screen.getByText('No 2 PM call (later forecast rain), not measured yet')).toBeInTheDocument();
    expect(screen.getByText('2 PM call unknown, not measured yet')).toBeInTheDocument();
  });

  it('asks again when the period changes', async () => {
    reply({ period: '90d', since: 'x', until: 'y', rows, totals: zero });
    render(<AdsResultsCard />);
    await screen.findByText('Test Campaign A');
    fireEvent.click(screen.getByRole('button', { name: '30 days' }));
    await waitFor(() => expect(globalThis.fetch.mock.calls.at(-1)[0]).toContain('period=30d'));
  });

  it('shows a muted line when the server fails', async () => {
    reply({ error: 'x' }, 500);
    render(<AdsResultsCard />);
    expect(await screen.findByText(/Ad results could not load: HTTP 500/)).toBeInTheDocument();
  });
});
