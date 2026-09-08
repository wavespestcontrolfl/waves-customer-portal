// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, act } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('../../utils/api', () => ({ default: { getWateringPlan: vi.fn() } }));
import api from '../../utils/api';
import WeeklyWateringPlanCard from './WeeklyWateringPlanCard';
const PLAN = { validThrough: '2026-09-13', title: 'Check the rain first', summary: 'Saved email summary',
  instruction: 'If the rain arrives, skip the run. Otherwise run on your assigned day.', note: '', forecast: '', restrictionNote: '',
  guides: [{ label: 'Timer guide', url: 'https://www.wavespestcontrol.com/sprinkler-timers/' }] };
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-09-07T14:05:00Z')); vi.clearAllMocks(); api.getWateringPlan.mockResolvedValue({ available: true, plan: PLAN }); });
afterEach(() => { cleanup(); vi.useRealTimers(); });
it('shows the saved conditional instructions and working guide destinations', async () => {
  render(<WeeklyWateringPlanCard customerId="property-1" />);
  expect(await screen.findByText(PLAN.instruction)).toBeInTheDocument();
  expect(screen.getByText(/Through Sunday, Sep 13/)).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Timer guide' })).toHaveAttribute('href', PLAN.guides[0].url);
});
it.each(['dark', 'error'])('hides the card when %s', async (mode) => {
  if (mode === 'dark') api.getWateringPlan.mockResolvedValue({ available: false });
  else api.getWateringPlan.mockRejectedValue(new Error('Unavailable'));
  const { container } = render(<WeeklyWateringPlanCard customerId="property-1" />);
  await act(async () => {});
  expect(container).toBeEmptyDOMElement();
});
it('shows setup guidance for an unavailable current snapshot without guessing a plan', async () => {
  api.getWateringPlan.mockResolvedValue({ available: true, plan: null });
  render(<WeeklyWateringPlanCard customerId="property-1" />);
  expect(await screen.findByText(/current plan isn't available/)).toBeInTheDocument();
  expect(screen.queryByText(PLAN.instruction)).not.toBeInTheDocument();
});
it('a tap for another property withholds this property’s instructions and uses the owned switch action', async () => {
  const open = vi.fn();
  render(<WeeklyWateringPlanCard customerId="property-1" targetCustomerId="property-2" onOpenProperty={open} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Open this property' }));
  expect(open).toHaveBeenCalledTimes(1);
  expect(screen.queryByText(PLAN.instruction)).not.toBeInTheDocument();
});
it('withholds the old plan throughout a pending edit and rejects a late pre-edit response', async () => {
  let resolve;
  api.getWateringPlan.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
  const { rerender } = render(<WeeklyWateringPlanCard customerId="property-1" />);
  rerender(<WeeklyWateringPlanCard customerId="property-1" pending />);
  await act(async () => { resolve({ available: true, plan: PLAN }); });
  expect(screen.queryByText(PLAN.instruction)).not.toBeInTheDocument();
  api.getWateringPlan.mockResolvedValue({ available: true, plan: null });
  rerender(<WeeklyWateringPlanCard customerId="property-1" refreshKey={1} />);
  await waitFor(() => expect(api.getWateringPlan).toHaveBeenCalledTimes(2));
  expect(await screen.findByText(/current plan isn't available/)).toBeInTheDocument();
});

it('revalidates when an open app regains focus', async () => {
  render(<WeeklyWateringPlanCard customerId="property-1" />);
  expect(await screen.findByText(PLAN.instruction)).toBeInTheDocument();
  api.getWateringPlan.mockResolvedValue({ available: true, plan: null });
  fireEvent.focus(window);
  expect(screen.queryByText(PLAN.instruction)).not.toBeInTheDocument();
  expect(await screen.findByText(/current plan isn't available/)).toBeInTheDocument();
});
it('retires an open plan exactly when its Eastern week ends', async () => {
  vi.useRealTimers();
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  vi.setSystemTime(new Date('2026-09-14T03:59:59Z'));
  render(<WeeklyWateringPlanCard customerId="property-1" />);
  await act(async () => {});
  expect(screen.getByText(PLAN.instruction)).toBeInTheDocument();
  await act(async () => { vi.advanceTimersByTime(1000); });
  expect(screen.queryByText(PLAN.instruction)).not.toBeInTheDocument();
  expect(screen.getByText(/current plan isn't available/)).toBeInTheDocument();
});
