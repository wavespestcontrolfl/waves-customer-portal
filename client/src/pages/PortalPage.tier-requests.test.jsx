// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MyPlanTab } from './PortalPage';
import api from '../utils/api';

vi.mock('../utils/api', () => {
  const methods = {};
  return { default: new Proxy(methods, {
    get(target, key) {
      if (typeof key !== 'string') return target[key];
      return target[key] ||= vi.fn(() => new Promise(() => {}));
    },
  }) };
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  api.getNextService.mockResolvedValue({ next: null });
  api.getSchedule.mockResolvedValue({ upcoming: [] });
  api.getServices.mockResolvedValue({ services: [] });
  api.getAutopay.mockResolvedValue({ state: 'disabled' });
  api.getStationMap.mockResolvedValue({ available: false });
  api.getLawnHealth.mockResolvedValue({ available: false });
  api.createRequest.mockResolvedValue({ success: true });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it.each([
  ['Gold', 'Silver', 'other'],
  ['Gold', 'Gold', 'other'],
  ['Silver', 'Gold', 'upgrade'],
  ['Platinum', 'Platinum', 'other'],
])('labels a %s to %s request as %s', async (current, requested, category) => {
  render(<MyPlanTab customer={{ id: 'fixture-account', firstName: 'Fixture', tier: current, property: {} }} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Explore WaveGuard tiers' }));
  const dialog = screen.getByRole('dialog', { name: 'Explore WaveGuard tiers' });
  fireEvent.click(within(dialog).getByRole('button', { name: new RegExp(`^WaveGuard ${requested}\\b`) }));
  if (category === 'upgrade') {
    api.queryCustomerPricing.mockResolvedValue({ ok: true, options: [{
      id: 'fixture-option', label: 'Selected tier option', serviceKey: 'waveguard_tier',
      requestSubject: 'Generated wording does not identify both tiers',
      requestDescription: `Selected option details. ${'Additional pricing context. '.repeat(30)}`,
    }] });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Check My Price' }));
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Request This Tier' }));
  } else {
    fireEvent.click(within(dialog).getByRole('button', { name: 'Request Plan Review' }));
  }
  await waitFor(() => expect(api.createRequest).toHaveBeenCalledOnce());
  const payload = api.createRequest.mock.calls[0][0];
  expect(payload.category).toBe(category);
  expect(payload.subject).toBe(`WaveGuard plan ${category === 'upgrade' ? 'upgrade' : 'review'}: ${current} to ${requested}`);
  expect(payload.description).toContain(`Current tier: WaveGuard ${current}. Requested tier: WaveGuard ${requested}.`);
  expect(payload.subject.length).toBeLessThanOrEqual(200);
  expect(payload.description.length).toBeLessThanOrEqual(500);
  if (category === 'upgrade') expect(payload.description).toContain('Selected option details.');
  else expect(api.queryCustomerPricing).not.toHaveBeenCalled();
});
