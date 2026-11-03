// @vitest-environment jsdom
// My Plan's "Take WaveGuard with you" (moving PR 2a, GATE_MOVING_PORTAL): with
// My Plan's real palette (muted is a COLOR string) the section renders and its
// line uses that color; the button opens the server's moving page path; a
// cancelled account's read-only portal never asks for the route.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MyPlanTab } from './PortalPage';
import api from '../utils/api';
import { MOVING_BODY, MOVING_HEADLINE } from '../components/portal/MovingEntry';

vi.mock('../utils/api', () => {
  const methods = {};
  return { default: new Proxy(methods, {
    get(target, key) {
      if (typeof key !== 'string') return target[key];
      return target[key] ||= vi.fn(() => new Promise(() => {}));
    },
  }) };
});

const assign = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  Object.defineProperty(window, 'location', { configurable: true, value: { ...window.location, assign } });
  api.getNextService.mockResolvedValue({ next: null });
  api.getSchedule.mockResolvedValue({ upcoming: [] });
  api.getServices.mockResolvedValue({ services: [] });
  api.getAutopay.mockResolvedValue({ state: 'disabled' });
  api.getStationMap.mockResolvedValue({ available: false });
  api.getLawnHealth.mockResolvedValue({ available: false });
  api.getMovingEntry.mockResolvedValue({ enabled: true });
  api.startMove.mockResolvedValue({ path: '/moving/fixture-token' });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it('an active account sees the section in My Plan colors, and the button opens its moving page', async () => {
  render(<MyPlanTab customer={{ id: 'fixture-account', firstName: 'Fixture', tier: 'Gold', property: {} }} />);
  const button = await screen.findByRole('button', { name: MOVING_HEADLINE });
  // muted is the palette's text color: rendered as a color, never spread into the style.
  expect(screen.getByText(MOVING_BODY).style.color).toBe('rgb(71, 85, 105)');
  fireEvent.click(button);
  await waitFor(() => expect(assign).toHaveBeenCalledWith('/moving/fixture-token'));
  expect(api.getMovingEntry).toHaveBeenCalledTimes(1);
});

it('the gate off shows nothing; a cancelled account never asks for the route', async () => {
  api.getMovingEntry.mockResolvedValue({ enabled: false });
  const { unmount } = render(<MyPlanTab customer={{ id: 'fixture-account', firstName: 'Fixture', tier: 'Gold', property: {} }} />);
  await waitFor(() => expect(api.getMovingEntry).toHaveBeenCalled());
  expect(screen.queryByRole('button', { name: MOVING_HEADLINE })).not.toBeInTheDocument();
  unmount();

  api.getMovingEntry.mockClear();
  render(<MyPlanTab customer={{ id: 'fixture-account', firstName: 'Fixture', tier: 'Gold', property: {}, cancelled: true }} />);
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(api.getMovingEntry).not.toHaveBeenCalled();
});
