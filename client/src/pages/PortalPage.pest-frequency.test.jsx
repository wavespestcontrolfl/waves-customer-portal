// @vitest-environment jsdom
// My Plan "Change how often we visit" (pest control visit frequency). The entry
// renders only when GET /pest-frequency says available:true; the sheet walks
// choose -> review -> done on the server's preview, and fewer visits is only
// ever a message the customer sends with a tap.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, fireEvent, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Any api method not explicitly mocked returns a forever-pending promise, so
// untested widgets sit in their loading states instead of crashing the render.
vi.mock('../utils/api', () => {
  const target = {};
  const proxy = new Proxy(target, {
    get: (obj, prop) => {
      if (typeof prop !== 'string') return obj[prop];
      if (!(prop in obj)) obj[prop] = vi.fn(() => new Promise(() => {}));
      return obj[prop];
    },
    set: (obj, prop, value) => { obj[prop] = value; return true; },
  });
  return { default: proxy };
});

import api from '../utils/api';
import { MyPlanTab } from './PortalPage';

const customer = {
  id: 'cust-1', firstName: 'Pat', lastName: 'Customer',
  phone: '9415551234', email: 'pat@example.com', tier: null,
  monthlyRate: 89, property: {},
};

const TODAY = { frequency: 'quarterly', visitsPerYear: 4, perVisit: 119, perYear: 476 };
const BIMONTHLY = { frequency: 'bimonthly', visitsPerYear: 6, perVisit: 99, perYear: 594 };
const MONTHLY = { frequency: 'monthly', visitsPerYear: 12, perVisit: 79, perYear: 948 };
const available = (over = {}) => ({ available: true, current: TODAY, options: [BIMONTHLY, MONTHLY], ...over });

const PREVIEW = {
  ...BIMONTHLY,
  today: TODAY,
  keptVisit: { date: '2026-11-16', perVisit: 119 },
  replacedVisits: ['2027-02-15', '2027-05-17'],
  newVisits: ['2027-01-15', '2027-03-15', '2027-05-15', '2027-07-15'],
  version: 'v-7',
};

const sentinel = (err) => { throw err; };
const apiError = (message, props) => Object.assign(new Error(message), props);

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  api.getPestFrequency.mockReset();
  api.previewPestFrequency.mockReset();
  api.confirmPestFrequency.mockReset();
  api.sendPortalMessage.mockReset();
  api.getSchedule.mockResolvedValue({ upcoming: [] });
  api.getNotificationPrefs.mockResolvedValue({});
  api.getPropertyNotificationPrefs.mockResolvedValue({ properties: [] });
  api.getPropertyPreferences.mockResolvedValue({ preferences: {} });
  api.getWeather.mockResolvedValue(null);
  api.getTodayTracker.mockResolvedValue({ tracker: null });
  api.getAutopay.mockResolvedValue({ state: 'disabled' });
  api.getNextService.mockResolvedValue({ next: null });
  api.getServiceStats.mockResolvedValue({});
  api.getBalance.mockResolvedValue({ currentBalance: 0 });
  api.getServices.mockResolvedValue({ services: [] });
  api.getRequests.mockResolvedValue({ requests: [] });
  api.oneTapOffers.mockResolvedValue({ offers: [] });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const renderPlan = (props = {}) => render(<MyPlanTab customer={customer} {...props} />);
const openSheet = async (props) => {
  renderPlan(props);
  fireEvent.click(await screen.findByText('Change how often we visit'));
  return screen.findByRole('dialog', { name: 'Change how often we visit' });
};

describe('pest frequency entry', () => {
  it('renders nothing and logs nothing when the read fails or says not available', async () => {
    api.getPestFrequency.mockRejectedValue(apiError('Not found', { status: 404 }));
    const view = renderPlan();
    await vi.waitFor(() => expect(api.getPestFrequency).toHaveBeenCalledTimes(1));
    await screen.findByText('Included Services');
    expect(screen.queryByText('Change how often we visit')).not.toBeInTheDocument();

    view.unmount();
    api.getPestFrequency.mockResolvedValue({ available: false });
    renderPlan();
    await vi.waitFor(() => expect(api.getPestFrequency).toHaveBeenCalledTimes(2));
    await screen.findByText('Included Services');
    expect(screen.queryByText('Change how often we visit')).not.toBeInTheDocument();
    expect(console.error).not.toHaveBeenCalled();
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('a cancelled account never asks', () => {
    render(<MyPlanTab customer={{ ...customer, cancelled: true }} />);
    expect(api.getPestFrequency).not.toHaveBeenCalled();
  });

  it('available: the entry opens a sheet with today and both options priced', async () => {
    api.getPestFrequency.mockResolvedValue(available());
    const dialog = await openSheet();
    expect(within(dialog).getByText('How often should we visit?')).toBeInTheDocument();
    expect(within(dialog).getByText('Today: every three months · $119.00 a visit · $476.00 a year')).toBeInTheDocument();
    expect(within(dialog).getByText('Every two months')).toBeInTheDocument();
    expect(within(dialog).getByText('6 visits a year')).toBeInTheDocument();
    expect(within(dialog).getByText('$99.00 a visit · $594.00 a year')).toBeInTheDocument();
    expect(within(dialog).getByText('Every month')).toBeInTheDocument();
    expect(within(dialog).getByText('12 visits a year')).toBeInTheDocument();
    expect(within(dialog).getByText('$79.00 a visit · $948.00 a year')).toBeInTheDocument();
    // Opening the sheet writes nothing and previews nothing.
    expect(api.previewPestFrequency).not.toHaveBeenCalled();
  });

  it('an empty options list says the plan is the most frequent and shows no cards', async () => {
    api.getPestFrequency.mockResolvedValue(available({ current: { ...TODAY, frequency: 'monthly' }, options: [] }));
    const dialog = await openSheet();
    expect(within(dialog).getByText('You\'re on our most frequent pest plan.')).toBeInTheDocument();
    expect(within(dialog).queryByText('Every two months')).not.toBeInTheDocument();
    expect(within(dialog).queryByText('Every month')).not.toBeInTheDocument();
  });
});

describe('pest frequency review and confirm', () => {
  it('choosing previews with { frequency } and the review shows prices, kept visit, new and replaced dates', async () => {
    api.getPestFrequency.mockResolvedValue(available());
    api.previewPestFrequency.mockResolvedValue(PREVIEW);
    const dialog = await openSheet();
    fireEvent.click(within(dialog).getByText('Every two months'));

    expect(await within(dialog).findByText('Review your new plan')).toBeInTheDocument();
    expect(api.previewPestFrequency).toHaveBeenCalledWith({ frequency: 'bimonthly' });
    expect(within(dialog).getByText('Pest control every two months')).toBeInTheDocument();
    expect(within(dialog).getByText('$99.00 a visit · $594.00 a year')).toBeInTheDocument();
    expect(within(dialog).getByText('Today: $119.00 a visit · $476.00 a year')).toBeInTheDocument();
    expect(within(dialog).getByText('Your visit on Nov 16, 2026 stays as booked at $119.00.')).toBeInTheDocument();
    expect(within(dialog).getByText('Your new visits: Jan 15, 2027, Mar 15, 2027, May 15, 2027 and then every two months.')).toBeInTheDocument();
    expect(within(dialog).getByText('These replace the visits you had on Feb 15, 2027, May 17, 2027.')).toBeInTheDocument();
    expect(within(dialog).getByText('Nothing is charged today. We bill each visit after it\'s done.')).toBeInTheDocument();
    expect(api.confirmPestFrequency).not.toHaveBeenCalled();
  });

  it('confirm sends { frequency, version } once even on a double tap, then the done step names the next visit; Done refreshes', async () => {
    api.getPestFrequency.mockResolvedValue(available());
    api.previewPestFrequency.mockResolvedValue(PREVIEW);
    let resolveConfirm;
    api.confirmPestFrequency.mockImplementation(() => new Promise((resolve) => { resolveConfirm = resolve; }));
    const dialog = await openSheet();
    fireEvent.click(within(dialog).getByText('Every two months'));
    const confirmButton = await within(dialog).findByText('Confirm change');
    fireEvent.click(confirmButton);
    fireEvent.click(confirmButton);
    expect(api.confirmPestFrequency).toHaveBeenCalledTimes(1);
    expect(api.confirmPestFrequency).toHaveBeenCalledWith({ frequency: 'bimonthly', version: 'v-7' });

    resolveConfirm({ success: true, ...PREVIEW });
    expect(await within(dialog).findByText('Your plan is changed')).toBeInTheDocument();
    expect(within(dialog).getByText('Pest control is now every two months. Your next visit is Nov 16, 2026.')).toBeInTheDocument();

    const readsBefore = api.getPestFrequency.mock.calls.length;
    const scheduleReadsBefore = api.getSchedule.mock.calls.length;
    fireEvent.click(within(dialog).getByText('Done'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await vi.waitFor(() => expect(api.getPestFrequency.mock.calls.length).toBeGreaterThan(readsBefore));
    await vi.waitFor(() => expect(api.getSchedule.mock.calls.length).toBeGreaterThan(scheduleReadsBefore));
  });

  it('without a kept visit the next visit is the first new date', async () => {
    api.getPestFrequency.mockResolvedValue(available());
    api.previewPestFrequency.mockResolvedValue({ ...PREVIEW, keptVisit: null, replacedVisits: [] });
    api.confirmPestFrequency.mockResolvedValue({ success: true, ...PREVIEW, keptVisit: null, replacedVisits: [] });
    const dialog = await openSheet();
    fireEvent.click(within(dialog).getByText('Every two months'));
    fireEvent.click(await within(dialog).findByText('Confirm change'));
    expect(await within(dialog).findByText('Pest control is now every two months. Your next visit is Jan 15, 2027.')).toBeInTheDocument();
  });

  it('PREVIEW_CHANGED on confirm previews again and stays on review with the changed-schedule sentence', async () => {
    api.getPestFrequency.mockResolvedValue(available());
    api.previewPestFrequency
      .mockResolvedValueOnce(PREVIEW)
      .mockResolvedValueOnce({ ...PREVIEW, version: 'v-8', newVisits: ['2027-01-22', '2027-03-22', '2027-05-22'] });
    api.confirmPestFrequency.mockRejectedValue(apiError('changed', { status: 409, code: 'PREVIEW_CHANGED' }));
    const dialog = await openSheet();
    fireEvent.click(within(dialog).getByText('Every two months'));
    fireEvent.click(await within(dialog).findByText('Confirm change'));

    expect(await within(dialog).findByText('Your schedule changed — please review the new dates.')).toBeInTheDocument();
    expect(api.previewPestFrequency).toHaveBeenCalledTimes(2);
    expect(api.previewPestFrequency).toHaveBeenLastCalledWith({ frequency: 'bimonthly' });
    expect(within(dialog).getByText('Review your new plan')).toBeInTheDocument();
    expect(within(dialog).getByText('Your new visits: Jan 22, 2027, Mar 22, 2027, May 22, 2027')).toBeInTheDocument();
    // The next confirm uses the new version.
    api.confirmPestFrequency.mockResolvedValue({ success: true, ...PREVIEW });
    fireEvent.click(within(dialog).getByText('Confirm change'));
    await vi.waitFor(() => expect(api.confirmPestFrequency).toHaveBeenLastCalledWith({ frequency: 'bimonthly', version: 'v-8' }));
  });

  it('a 429 shows the server sentence; any other failure shows the generic one', async () => {
    api.getPestFrequency.mockResolvedValue(available());
    api.previewPestFrequency.mockResolvedValue(PREVIEW);
    api.confirmPestFrequency.mockRejectedValueOnce(apiError('You can change your plan again tomorrow.', { status: 429 }));
    const dialog = await openSheet();
    fireEvent.click(within(dialog).getByText('Every two months'));
    fireEvent.click(await within(dialog).findByText('Confirm change'));
    expect(await within(dialog).findByText('You can change your plan again tomorrow.')).toBeInTheDocument();

    api.confirmPestFrequency.mockRejectedValueOnce(apiError('boom', { status: 500 }));
    fireEvent.click(within(dialog).getByText('Confirm change'));
    expect(await within(dialog).findByText('Something went wrong — please try again.')).toBeInTheDocument();
  });
});

describe('pest frequency unavailable plan', () => {
  const unavailable = () => apiError('no', { status: 409, code: 'FREQUENCY_CHANGE_UNAVAILABLE' });

  it('shows the sentence and the send-message action; nothing is sent until Send message', async () => {
    api.getPestFrequency.mockResolvedValue(available());
    api.previewPestFrequency.mockImplementation(() => sentinel(unavailable()));
    api.sendPortalMessage.mockResolvedValue({ message: { id: 'm1' } });
    const dialog = await openSheet({ messagesEnabled: true });
    fireEvent.click(within(dialog).getByText('Every two months'));
    expect(await within(dialog).findByText('We can\'t make this change online for your plan. Send us a message and we\'ll take care of it.')).toBeInTheDocument();
    expect(api.sendPortalMessage).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByText('Send us a message'));
    expect(api.sendPortalMessage).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByText('Send message'));
    await within(dialog).findByText('Sent. We\'ll answer in Messages.');
    expect(api.sendPortalMessage).toHaveBeenCalledTimes(1);
    expect(api.sendPortalMessage.mock.calls[0][0]).toBe('I\'d like pest control visits every two months.');
  });

  it('without Messages it shows the phone number and no send action', async () => {
    api.getPestFrequency.mockResolvedValue(available());
    api.previewPestFrequency.mockRejectedValue(unavailable());
    const dialog = await openSheet({ messagesEnabled: false });
    fireEvent.click(within(dialog).getByText('Every month'));
    expect(await within(dialog).findByText('We can\'t make this change online for your plan. Call us at (941) 297-5749.')).toBeInTheDocument();
    expect(within(dialog).queryByText(/Send us a message/)).not.toBeInTheDocument();
  });

  it('the same error on confirm returns to the choice with the sentence', async () => {
    api.getPestFrequency.mockResolvedValue(available());
    api.previewPestFrequency.mockResolvedValue(PREVIEW);
    api.confirmPestFrequency.mockRejectedValue(unavailable());
    const dialog = await openSheet({ messagesEnabled: true });
    fireEvent.click(within(dialog).getByText('Every two months'));
    fireEvent.click(await within(dialog).findByText('Confirm change'));
    expect(await within(dialog).findByText(/We can't make this change online for your plan\./)).toBeInTheDocument();
    expect(within(dialog).getByText('How often should we visit?')).toBeInTheDocument();
  });
});

describe('pest frequency fewer visits', () => {
  it('sends nothing until Send message, then calls the Messages helper once with the exact sentence', async () => {
    api.getPestFrequency.mockResolvedValue(available());
    api.sendPortalMessage.mockResolvedValue({ message: { id: 'm1' } });
    const dialog = await openSheet({ messagesEnabled: true });
    fireEvent.click(within(dialog).getByText('Want fewer visits? Send us a message.'));
    expect(within(dialog).getByText('We\'ll send this to the office: "I\'d like fewer pest control visits."')).toBeInTheDocument();
    expect(api.sendPortalMessage).not.toHaveBeenCalled();

    const send = within(dialog).getByText('Send message');
    fireEvent.click(send);
    fireEvent.click(send);
    expect(await within(dialog).findByText('Sent. We\'ll answer in Messages.')).toBeInTheDocument();
    expect(api.sendPortalMessage).toHaveBeenCalledTimes(1);
    expect(api.sendPortalMessage.mock.calls[0][0]).toBe('I\'d like fewer pest control visits.');
  });

  it('a failed send shows the generic sentence and keeps the button for a retry', async () => {
    api.getPestFrequency.mockResolvedValue(available());
    api.sendPortalMessage.mockRejectedValue(apiError('x', { status: 500 }));
    const dialog = await openSheet({ messagesEnabled: true });
    fireEvent.click(within(dialog).getByText('Want fewer visits? Send us a message.'));
    fireEvent.click(within(dialog).getByText('Send message'));
    expect(await within(dialog).findByText('Something went wrong — please try again.')).toBeInTheDocument();
    expect(within(dialog).getByText('Send message')).toBeInTheDocument();
  });

  it('is hidden when Messages is not available', async () => {
    api.getPestFrequency.mockResolvedValue(available());
    const dialog = await openSheet({ messagesEnabled: false });
    expect(within(dialog).queryByText('Want fewer visits? Send us a message.')).not.toBeInTheDocument();
  });
});
