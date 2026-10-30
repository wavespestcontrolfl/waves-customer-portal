// @vitest-environment jsdom
/**
 * PPC -> Capacity gap-fill panel. The server routes ship behind
 * GATE_ADS_GAP_RULE, so the panel must stay invisible while GET answers 404
 * and must send exactly the documented bodies when the owner edits limits or
 * sets a hold.
 */
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AdsGapRulePanel from './AdsGapRulePanel';
import { addETDays, etDateString } from '../../lib/timezone';

function json(body, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
}

function payload(overrides = {}) {
  return {
    mode: 'shadow',
    settings: { weekday_limit: 8, saturday_limit: 5, sunday_limit: 2, window_days: 7, run_at_open: 10, stop_below_open: 4 },
    window: {
      start: '2026-10-30',
      end: '2026-11-05',
      days: [
        { date: '2026-10-30', weekday: 'Fri', stops: 6, techs: 1, limit: 8, open: 2 },
        { date: '2026-10-31', weekday: 'Sat', stops: 1, techs: 1, limit: 5, open: 4 },
      ],
      total_open: 12,
      total_limit: 13,
      total_stops: 7,
    },
    decision: { mode: 'base', reason: 'Open stops are at or above the run threshold.' },
    campaigns: [
      { id: 'camp-1', campaign_name: 'Test Search Campaign', budget_mode: 'stop', daily_budget_current: 0.05, daily_budget_base: 5, hold: null },
    ],
    last_run: null,
    ...overrides,
  };
}

let calls;
function route(handlers) {
  calls = [];
  globalThis.fetch = vi.fn((url, init = {}) => {
    const method = init.method || 'GET';
    calls.push({ url, method, body: init.body ? JSON.parse(init.body) : undefined });
    const handler = handlers[`${method} ${url.replace(/^.*\/api/, '')}`];
    return handler ? handler() : json({ error: 'unexpected' }, 500);
  });
}

describe('AdsGapRulePanel', () => {
  beforeEach(() => {
    localStorage.setItem('waves_admin_token', 'test-token');
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('renders nothing when the rule is off (404)', async () => {
    route({ 'GET /admin/ads/gap-rule': () => json({ error: 'gap_rule_off' }, 404) });
    const { container } = render(<AdsGapRulePanel />);
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 0));
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing on a network error', async () => {
    globalThis.fetch = vi.fn(() => Promise.reject(new Error('offline')));
    const { container } = render(<AdsGapRulePanel />);
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 0));
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the shadow badge, "would" summary and the day table', async () => {
    route({ 'GET /admin/ads/gap-rule': () => json(payload()) });
    render(<AdsGapRulePanel />);
    expect(await screen.findByText('Shadow — watching only')).toBeInTheDocument();
    expect(screen.getByText(/Next 2 days \(Oct 30 – Nov 5\): 12 open stops → would run full budget/)).toBeInTheDocument();
    expect(screen.getByText('Fri Oct 30')).toBeInTheDocument();
    expect(screen.getByText('Sat Oct 31')).toBeInTheDocument();
    expect(screen.getByText('Total')).toBeInTheDocument();
    expect(screen.getByText('Automatic')).toBeInTheDocument();
    expect(screen.getByText(/Off means 1% of budget, not a Google pause/)).toBeInTheDocument();
  });

  it('uses the plain wording in live mode', async () => {
    route({ 'GET /admin/ads/gap-rule': () => json(payload({ mode: 'live', decision: { mode: 'stop', reason: 'Few open stops.' } })) });
    render(<AdsGapRulePanel />);
    expect(await screen.findByText('Live — sets the budget')).toBeInTheDocument();
    expect(screen.getByText(/12 open stops → stop \(1% budget\)/)).toBeInTheDocument();
    expect(screen.queryByText(/would/)).not.toBeInTheDocument();
  });

  it('saves only the changed setting and shows the server message on a 400', async () => {
    route({
      'GET /admin/ads/gap-rule': () => json(payload()),
      'PUT /admin/ads/gap-rule/settings': () => json({ error: 'weekday_limit must be 1 to 30' }, 400),
    });
    render(<AdsGapRulePanel />);
    const input = await screen.findByLabelText('Weekday limit');
    expect(screen.getByRole('button', { name: 'Save settings' })).toBeDisabled();
    fireEvent.change(input, { target: { value: '99' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    expect(await screen.findByText('weekday_limit must be 1 to 30')).toBeInTheDocument();
    const put = calls.find((c) => c.method === 'PUT');
    expect(put.body).toEqual({ weekday_limit: 99 });
  });

  it('re-fetches after a successful settings save', async () => {
    route({
      'GET /admin/ads/gap-rule': () => json(payload()),
      'PUT /admin/ads/gap-rule/settings': () => json({ settings: {} }),
    });
    render(<AdsGapRulePanel />);
    fireEvent.change(await screen.findByLabelText('Sunday limit'), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    await waitFor(() => expect(calls.filter((c) => c.method === 'GET')).toHaveLength(2));
    expect(calls.find((c) => c.method === 'PUT').body).toEqual({ sunday_limit: 3 });
  });

  it('asks for confirmation, then POSTs the hold', async () => {
    const until = etDateString(addETDays(new Date(), 7));
    route({
      'GET /admin/ads/gap-rule': () => json(payload()),
      'POST /admin/ads/campaigns/camp-1/hold': () => json({ hold: {} }),
    });
    render(<AdsGapRulePanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Keep ads off until this date' }));
    expect(screen.getByText(/Google Ads budget set to \$0\.05\/day \(1% of budget\) until /)).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(calls.filter((c) => c.method === 'GET')).toHaveLength(2));
    expect(calls.find((c) => c.method === 'POST').body).toEqual({ mode: 'stop', until });
  });

  it('states the full budget for a keep-on hold and shows server errors inline', async () => {
    route({
      'GET /admin/ads/gap-rule': () => json(payload()),
      'POST /admin/ads/campaigns/camp-1/hold': () => json({ error: 'campaign is not active' }, 409),
    });
    render(<AdsGapRulePanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Keep ads on until this date' }));
    expect(screen.getByText(/Google Ads budget set to \$5\.00\/day until /)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(await screen.findByText('campaign is not active')).toBeInTheDocument();
  });

  it('sends no request when the hold is cancelled', async () => {
    route({ 'GET /admin/ads/gap-rule': () => json(payload()) });
    render(<AdsGapRulePanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Keep ads on until this date' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('button', { name: 'Confirm' })).not.toBeInTheDocument();
    expect(calls.map((c) => c.method)).toEqual(['GET']);
  });

  it('shows the hold and sends DELETE for "Back to automatic"', async () => {
    const held = payload({
      campaigns: [
        { id: 'camp-1', campaign_name: 'Test Search Campaign', budget_mode: 'stop', daily_budget_current: 0.05, daily_budget_base: 5, hold: { mode: 'stop', until: '2026-11-06', set_at: '2026-10-29T14:00:00Z', set_by: 'owner' } },
      ],
    });
    route({
      'GET /admin/ads/gap-rule': () => json(held),
      'DELETE /admin/ads/campaigns/camp-1/hold': () => json({ hold: null }),
    });
    render(<AdsGapRulePanel />);
    expect(await screen.findByText('Held off until Nov 6')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Back to automatic' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE')).toBe(true));
    await waitFor(() => expect(calls.filter((c) => c.method === 'GET')).toHaveLength(2));
  });
});
