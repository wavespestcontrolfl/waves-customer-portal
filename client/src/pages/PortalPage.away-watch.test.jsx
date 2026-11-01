// @vitest-environment jsdom
// GATE_AWAY_WATCH: the Away Watch section on the Property tab. The server carries the gate as awayWatchEnabled in
// GET /api/property/preferences (key absent while the gate is off). The pair saves whole, so nothing is sent until both
// days are chosen; Remove sends two nulls.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../utils/api', () => ({
  default: {
    getPropertyPreferences: vi.fn(),
    getWateringPlan: vi.fn(),
    updatePropertyPreferences: vi.fn(),
    getServicePreferences: vi.fn(),
    updateServicePreferences: vi.fn(),
  },
}));

import api from '../utils/api';
import { PropertyTab } from './PortalPage';
import { AWAY_WATCH_COPY, awayWatchSummary, awayWatchDayLabel } from '../lib/awayWatchCopy';

const customer = { id: 'cust-1', firstName: 'Pat', lastName: 'Customer', phone: '9415551234', email: 'pat@example.com', tier: 'Gold', property: {} };

beforeEach(() => {
  vi.clearAllMocks();
  api.getWateringPlan.mockResolvedValue({ available: false });
  api.getServicePreferences.mockResolvedValue({ preferences: {} });
  api.updatePropertyPreferences.mockResolvedValue({ preferences: {}, saved: true });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const sectionOf = async () => (await screen.findByText(AWAY_WATCH_COPY.description)).closest('section');

describe('Away Watch section on the Property tab', () => {
  it('gate off (no key): no Away Watch section anywhere', async () => {
    api.getPropertyPreferences.mockResolvedValue({ preferences: {}, hasLawnCare: false });
    render(<PropertyTab customer={customer} />);
    await screen.findByText('Pets');
    expect(screen.queryByText(AWAY_WATCH_COPY.title)).toBeNull();
    expect(screen.queryByText(AWAY_WATCH_COPY.description)).toBeNull();
  });

  it('gate on: the section sits right after Pets, with the approved description word for word', async () => {
    api.getPropertyPreferences.mockResolvedValue({ preferences: {}, hasLawnCare: false, awayWatchEnabled: true });
    render(<PropertyTab customer={customer} />);
    const section = await sectionOf();
    expect(section).toHaveTextContent('Away for the summer? On each visit day, your tech takes three photos of the outside of your home from the ground and flags standing water. The visit before you come back includes a lanai cobweb sweep, and we text you the photos. This is not a security or home-watch service.');
    const sections = [...document.querySelectorAll('section')].map((el) => el.querySelector('button')?.textContent || '');
    const pets = sections.findIndex((t) => t.startsWith('Pets'));
    expect(sections[pets + 1]).toMatch(/^Away Watch/);
    expect(within(section).getByText(AWAY_WATCH_COPY.summaryOff)).toBeInTheDocument();
  });

  it('choosing both days sends both in one save; one day alone sends nothing and says to choose both', async () => {
    api.getPropertyPreferences.mockResolvedValue({ preferences: {}, hasLawnCare: false, awayWatchEnabled: true });
    render(<PropertyTab customer={customer} />);
    await sectionOf();
    fireEvent.change(screen.getByLabelText(AWAY_WATCH_COPY.fromLabel), { target: { value: '2026-06-01' } });
    expect(screen.getByText(AWAY_WATCH_COPY.bothDays)).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 1300));
    expect(api.updatePropertyPreferences).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText(AWAY_WATCH_COPY.untilLabel), { target: { value: '2026-09-15' } });
    await waitFor(() => expect(api.updatePropertyPreferences).toHaveBeenCalledTimes(1), { timeout: 3000 });
    expect(api.updatePropertyPreferences.mock.calls[0][0]).toMatchObject({ awayWatchFrom: '2026-06-01', awayWatchUntil: '2026-09-15' });
    expect(screen.queryByText(AWAY_WATCH_COPY.bothDays)).toBeNull();
  });

  it('a complete pair that loses a day before its autosave leaves saves nothing; other queued edits still save', async () => {
    api.getPropertyPreferences.mockResolvedValue({ preferences: { awayWatchFrom: '2026-05-01', awayWatchUntil: '2026-08-01' }, hasLawnCare: false, awayWatchEnabled: true });
    render(<PropertyTab customer={customer} />);
    const section = await sectionOf();
    fireEvent.change(screen.getByLabelText(AWAY_WATCH_COPY.fromLabel), { target: { value: '2026-06-01' } });
    fireEvent.change(screen.getByLabelText(AWAY_WATCH_COPY.untilLabel), { target: { value: '2026-09-15' } });
    // Before the debounce fires, the member clears the back day.
    fireEvent.change(screen.getByLabelText(AWAY_WATCH_COPY.untilLabel), { target: { value: '' } });
    expect(screen.getByText(AWAY_WATCH_COPY.bothDays)).toBeInTheDocument();
    // The summary goes back to the pair the server holds, not the withdrawn draft.
    expect(within(section).getByText('Away May 1 to Aug 1')).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 1300));
    expect(api.updatePropertyPreferences).not.toHaveBeenCalled();
  });

  it('withdrawing the pair keeps another queued edit: only that edit saves', async () => {
    api.getPropertyPreferences.mockResolvedValue({ preferences: {}, hasLawnCare: false, awayWatchEnabled: true });
    render(<PropertyTab customer={customer} />);
    await sectionOf();
    fireEvent.change(screen.getByLabelText('Community Gate'), { target: { value: '#1234' } });
    fireEvent.change(screen.getByLabelText(AWAY_WATCH_COPY.fromLabel), { target: { value: '2026-06-01' } });
    fireEvent.change(screen.getByLabelText(AWAY_WATCH_COPY.untilLabel), { target: { value: '2026-09-15' } });
    fireEvent.change(screen.getByLabelText(AWAY_WATCH_COPY.fromLabel), { target: { value: '' } });
    await waitFor(() => expect(api.updatePropertyPreferences).toHaveBeenCalledTimes(1), { timeout: 3000 });
    const sent = api.updatePropertyPreferences.mock.calls[0][0];
    expect(sent).toMatchObject({ neighborhoodGateCode: '#1234' });
    expect(sent).not.toHaveProperty('awayWatchFrom');
    expect(sent).not.toHaveProperty('awayWatchUntil');
  });

  it('a pair already being saved when a day is cleared: if that save fails, the pair is not re-queued', async () => {
    api.getPropertyPreferences.mockResolvedValue({ preferences: {}, hasLawnCare: false, awayWatchEnabled: true });
    let failFirst;
    api.updatePropertyPreferences
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { failFirst = reject; }))
      .mockResolvedValue({ preferences: {}, saved: true });
    render(<PropertyTab customer={customer} />);
    await sectionOf();
    fireEvent.change(screen.getByLabelText(AWAY_WATCH_COPY.fromLabel), { target: { value: '2026-06-01' } });
    fireEvent.change(screen.getByLabelText(AWAY_WATCH_COPY.untilLabel), { target: { value: '2026-09-15' } });
    await waitFor(() => expect(api.updatePropertyPreferences).toHaveBeenCalledTimes(1), { timeout: 3000 });
    // The pair's save is in flight; the member clears the back day, then the save fails (network).
    fireEvent.change(screen.getByLabelText(AWAY_WATCH_COPY.untilLabel), { target: { value: '' } });
    failFirst(new Error('network down'));
    // A later edit flushes the queue: the withdrawn pair must not ride it.
    fireEvent.change(screen.getByLabelText('Community Gate'), { target: { value: '#1234' } });
    await waitFor(() => expect(api.updatePropertyPreferences).toHaveBeenCalledTimes(2), { timeout: 3000 });
    const sent = api.updatePropertyPreferences.mock.calls[1][0];
    expect(sent).toMatchObject({ neighborhoodGateCode: '#1234' });
    expect(sent).not.toHaveProperty('awayWatchFrom');
    expect(sent).not.toHaveProperty('awayWatchUntil');
  });

  it('an Away Watch-only save that fails after the member clears a day queues nothing: a property-switch flush sends no request', async () => {
    api.getPropertyPreferences.mockResolvedValue({ preferences: {}, hasLawnCare: false, awayWatchEnabled: true });
    let failFirst;
    api.updatePropertyPreferences
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { failFirst = reject; }))
      .mockResolvedValue({ preferences: {}, saved: true });
    render(<PropertyTab customer={customer} />);
    await sectionOf();
    fireEvent.change(screen.getByLabelText(AWAY_WATCH_COPY.fromLabel), { target: { value: '2026-06-01' } });
    fireEvent.change(screen.getByLabelText(AWAY_WATCH_COPY.untilLabel), { target: { value: '2026-09-15' } });
    await waitFor(() => expect(api.updatePropertyPreferences).toHaveBeenCalledTimes(1), { timeout: 3000 });
    fireEvent.change(screen.getByLabelText(AWAY_WATCH_COPY.untilLabel), { target: { value: '' } });
    failFirst(new Error('network down'));
    await new Promise((resolve) => setTimeout(resolve, 50));
    const waiters = [];
    window.dispatchEvent(new CustomEvent('waves:property-switching', { detail: { waiters } }));
    await Promise.allSettled(waiters);
    expect(api.updatePropertyPreferences).toHaveBeenCalledTimes(1);
  });

  it('a pair withdrawn while its save was in flight, and that save succeeds: the summary shows the window the server holds', async () => {
    api.getPropertyPreferences.mockResolvedValue({ preferences: {}, hasLawnCare: false, awayWatchEnabled: true });
    let finishFirst;
    api.updatePropertyPreferences
      .mockImplementationOnce(() => new Promise((resolve) => { finishFirst = resolve; }))
      .mockResolvedValue({ preferences: {}, saved: true });
    render(<PropertyTab customer={customer} />);
    const section = await sectionOf();
    fireEvent.change(screen.getByLabelText(AWAY_WATCH_COPY.fromLabel), { target: { value: '2026-06-01' } });
    fireEvent.change(screen.getByLabelText(AWAY_WATCH_COPY.untilLabel), { target: { value: '2026-09-15' } });
    await waitFor(() => expect(api.updatePropertyPreferences).toHaveBeenCalledTimes(1), { timeout: 3000 });
    fireEvent.change(screen.getByLabelText(AWAY_WATCH_COPY.untilLabel), { target: { value: '' } });
    expect(within(section).getByText(AWAY_WATCH_COPY.summaryOff)).toBeInTheDocument();
    finishFirst({ preferences: { awayWatchFrom: '2026-06-01', awayWatchUntil: '2026-09-15' }, saved: true });
    expect(await within(section).findByText('Away Jun 1 to Sep 15')).toBeInTheDocument();
  });

  it('a withdrawn pair\'s late success never overrides a newer Remove: the screen ends with no window', async () => {
    api.getPropertyPreferences.mockResolvedValue({ preferences: {}, hasLawnCare: false, awayWatchEnabled: true });
    let finishFirst;
    api.updatePropertyPreferences
      .mockImplementationOnce(() => new Promise((resolve) => { finishFirst = resolve; }))
      .mockResolvedValue({ preferences: { awayWatchFrom: null, awayWatchUntil: null }, saved: true });
    render(<PropertyTab customer={customer} />);
    const section = await sectionOf();
    fireEvent.change(screen.getByLabelText(AWAY_WATCH_COPY.fromLabel), { target: { value: '2026-06-01' } });
    fireEvent.change(screen.getByLabelText(AWAY_WATCH_COPY.untilLabel), { target: { value: '2026-09-15' } });
    await waitFor(() => expect(api.updatePropertyPreferences).toHaveBeenCalledTimes(1), { timeout: 3000 });
    fireEvent.change(screen.getByLabelText(AWAY_WATCH_COPY.untilLabel), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: AWAY_WATCH_COPY.remove }));
    finishFirst({ preferences: { awayWatchFrom: '2026-06-01', awayWatchUntil: '2026-09-15' }, saved: true });
    await waitFor(() => expect(api.updatePropertyPreferences).toHaveBeenCalledTimes(2), { timeout: 3000 });
    expect(api.updatePropertyPreferences.mock.calls[1][0]).toMatchObject({ awayWatchFrom: null, awayWatchUntil: null });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(within(section).getByText(AWAY_WATCH_COPY.summaryOff)).toBeInTheDocument();
    expect(within(section).queryByText('Away Jun 1 to Sep 15')).toBeNull();
  });

  it('a saved pair shows its summary; Remove sends two nulls and empties the inputs', async () => {
    api.getPropertyPreferences.mockResolvedValue({ preferences: { awayWatchFrom: '2026-06-01', awayWatchUntil: '2026-09-15' }, hasLawnCare: false, awayWatchEnabled: true });
    render(<PropertyTab customer={customer} />);
    const section = await sectionOf();
    expect(within(section).getByText('Away Jun 1 to Sep 15')).toBeInTheDocument();
    expect(screen.getByLabelText(AWAY_WATCH_COPY.fromLabel)).toHaveValue('2026-06-01');
    fireEvent.click(screen.getByRole('button', { name: AWAY_WATCH_COPY.remove }));
    await waitFor(() => expect(api.updatePropertyPreferences).toHaveBeenCalledTimes(1), { timeout: 3000 });
    expect(api.updatePropertyPreferences.mock.calls[0][0]).toMatchObject({ awayWatchFrom: null, awayWatchUntil: null });
    expect(screen.getByLabelText(AWAY_WATCH_COPY.fromLabel)).toHaveValue('');
    expect(screen.queryByRole('button', { name: AWAY_WATCH_COPY.remove })).toBeNull();
  });

  it('a rule the server refuses is shown under the dates', async () => {
    api.getPropertyPreferences.mockResolvedValue({ preferences: {}, hasLawnCare: false, awayWatchEnabled: true });
    api.updatePropertyPreferences.mockResolvedValue({ preferences: {}, saved: true, rejected: [{ field: 'awayWatchUntil', message: 'Away Watch can cover at most 240 days.' }] });
    render(<PropertyTab customer={customer} />);
    await sectionOf();
    fireEvent.change(screen.getByLabelText(AWAY_WATCH_COPY.fromLabel), { target: { value: '2026-01-01' } });
    fireEvent.change(screen.getByLabelText(AWAY_WATCH_COPY.untilLabel), { target: { value: '2026-12-31' } });
    expect(await screen.findByText('Away Watch can cover at most 240 days.', {}, { timeout: 3000 })).toBeInTheDocument();
  });
});

describe('Away Watch copy', () => {
  it('reads a day as a plain calendar day, never shifted by time zone', () => {
    expect(awayWatchDayLabel('2026-06-01')).toBe('Jun 1');
    expect(awayWatchDayLabel('2026-06-01T00:00:00.000Z')).toBe('Jun 1');
    expect(awayWatchDayLabel(null)).toBe('');
    expect(awayWatchSummary({ awayWatchFrom: '2026-06-01', awayWatchUntil: null })).toBe(AWAY_WATCH_COPY.summaryOff);
  });
});
