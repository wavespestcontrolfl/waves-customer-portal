// @vitest-environment jsdom
// Scores loads one day at a time: a slow response for the previous day must
// not replace the scores of the day now selected (schedule audit S5).
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import RevenuePanelV2 from './RevenuePanelV2';

const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
const job = (name) => ({ id: name, customer_name: name, service_type: 'general_pest', waveguard_tier: 'none', job_category: 'recurring', job_score: 80 });

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('keeps the selected day when the previous day answers last', async () => {
  let finishMonday;
  const mondayResponse = new Promise((resolve) => { finishMonday = resolve; });
  vi.stubGlobal('fetch', vi.fn(async (url) => (String(url).includes('date=2026-11-02') ? mondayResponse : json([job('Tuesday visit')]))));
  const view = render(<RevenuePanelV2 date="2026-11-02" />);
  view.rerender(<RevenuePanelV2 date="2026-11-03" />);
  await screen.findByText('Tuesday visit');
  await act(async () => { finishMonday(json([job('Monday visit')])); });
  expect(screen.getByText('Tuesday visit')).toBeInTheDocument();
  expect(screen.queryByText('Monday visit')).not.toBeInTheDocument();
});
