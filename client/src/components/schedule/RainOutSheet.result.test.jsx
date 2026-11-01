// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../hooks/useIsMobile', () => ({ default: () => false }));
vi.mock('./useBestTimes', () => ({
  useBestTimes: () => ({ pickedByTech: [], availability: null, checking: false }),
}));

vi.mock('./AvailabilityStrip', () => ({ default: () => <div data-testid="open-times-box" /> }));
vi.mock('./ScheduleSaveNotice', () => ({ showScheduleSaveNotice: vi.fn() }));

import RainOutSheet from './RainOutSheet';
import { showScheduleSaveNotice } from './ScheduleSaveNotice';

// The dispatch sheet reads its commit result through the shared helper; these
// pin the visible behavior: attention results keep the sheet open and lock Move.
const json = (body) => ({ ok: true, json: async () => body });
let commitBody;
let optionsExtra;
let pickBody;
let fetchMock;

beforeEach(() => {
  optionsExtra = {};
  pickBody = null;
  localStorage.setItem('waves_admin_token', 'fixture-only');
  fetchMock = vi.fn(async (url, init) => {
    const path = String(url);
    if (path.endsWith('/rain-out-options')) {
      return json({
        sameDay: [], days: [{ kind: 'day', date: '2099-01-02', window: { start: '09:00', end: '10:00' }, display: 'Fri, Jan 2, 9:00 AM-10:00 AM' }],
        service: { window: { start: '10:00', end: '11:00' } }, remainingRouteCount: 0,
        ...optionsExtra,
      });
    }
    if (path.endsWith('/customer-pick') && init?.method === 'POST') {
      return { ok: pickBody.status === 200, status: pickBody.status, json: async () => pickBody.body };
    }
    if (path.endsWith('/rain-out') && init?.method === 'POST') return json(commitBody);
    return json({});
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });

async function move(onDone) {
  render(<RainOutSheet service={{ id: 'visit-1', customerName: 'Fixture Customer' }} onClose={vi.fn()} onDone={onDone} />);
  const button = await screen.findByRole('button', { name: 'Move appointment' });
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
}

describe('RainOutSheet commit result', () => {
  it('keeps a not-texted result on screen and locks a second Move', async () => {
    commitBody = { movedCount: 1, failedCount: 0, results: [{ id: 'visit-1', ok: true, smsSent: false }] };
    const onDone = vi.fn();
    await move(onDone);
    expect(await screen.findByText(/customer NOT texted\.\s+Some customers were NOT texted/)).toBeInTheDocument();
    expect(onDone).toHaveBeenCalledWith(expect.objectContaining({ movedCount: 1, notTexted: true, failedCount: 0, overlapCount: 0 }));
    expect(screen.getByRole('button', { name: 'Moved' })).toBeDisabled();
  });

  it('hands a clean move to the parent with no warning shown', async () => {
    commitBody = { movedCount: 1, failedCount: 0, results: [{ id: 'visit-1', ok: true, smsSent: true }] };
    const onDone = vi.fn();
    await move(onDone);
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(onDone.mock.calls[0][0]).toMatchObject({ summary: expect.stringMatching(/^Moved 1 stop to Fri, Jan 2.*customer texted$/), notTexted: false });
    expect(screen.queryByText(/NOT texted/)).not.toBeInTheDocument();
  });
});

// "Let the customer pick a day" (GATE_QUICKMOVE_CUSTOMER_PICK) on the dispatch sheet.
const customerPick = {
  available: true,
  pickBy: '2099-01-03T01:00:00.000Z',
  pickByLabel: 'Wed 8 PM',
  previewByReason: {
    weather_rain: 'Hi Fixture, rain is moving in.\nPick a new day: [link]',
    running_late: 'Hi Fixture, we are running late.',
  },
  segments: { count: 2, remaining: 31 },
};
const todayRow = { kind: 'same_day', date: '2099-01-01', window: { start: '14:00', end: '15:00' }, display: 'Today, 2:00 PM-3:00 PM' };
const picks = () => fetchMock.mock.calls.filter(([path, init]) => String(path).endsWith('/customer-pick') && init?.method === 'POST');

async function openPick(extra = {}) {
  optionsExtra = { sameDay: [todayRow], remainingRouteCount: 2, customerPick, extraReasonsEnabled: true, ...extra };
  const onDone = vi.fn();
  const onClose = vi.fn();
  render(<RainOutSheet service={{ id: 'visit-1', customerName: 'Fixture Customer' }} onClose={onClose} onDone={onDone} />);
  await screen.findByText('Today, 2:00 PM-3:00 PM');
  return { onDone, onClose };
}

describe('RainOutSheet: let the customer pick a day', () => {
  it('renders exactly as before when the options carry no customerPick', async () => {
    optionsExtra = { sameDay: [todayRow] };
    render(<RainOutSheet service={{ id: 'visit-1', customerName: 'Fixture Customer' }} onClose={vi.fn()} onDone={vi.fn()} />);
    await screen.findByText('Today, 2:00 PM-3:00 PM');
    expect(screen.getByText(/Fri, Jan 2, 9:00 AM-10:00 AM/)).toBeInTheDocument();
    expect(screen.queryByText(/pick a day/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Custom time' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Move appointment' })).toBeInTheDocument();
  });

  it('swaps the day rows for one pick row and keeps the same-day rows and Custom time', async () => {
    await openPick();
    expect(screen.queryByText(/Fri, Jan 2/)).not.toBeInTheDocument();
    expect(screen.getByText('Let Fixture pick a day')).toBeInTheDocument();
    expect(screen.getByText('Texts Fixture 6 route-fit times · pick by Wed 8 PM')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Custom time' })).toBeInTheDocument();
    // Still on the same-day row: the usual controls stay and there is no swap button.
    expect(screen.getByText('SCOPE')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Pick a day myself/ })).not.toBeInTheDocument();
  });

  it('shows the text preview and hides scope, the text box and the open-times box while picked', async () => {
    await openPick();
    expect(screen.getByTestId('open-times-box')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Let Fixture pick a day'));
    expect(screen.queryByText('SCOPE')).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByTestId('open-times-box')).not.toBeInTheDocument();
    expect(screen.getByText('FIXTURE GETS THIS TEXT')).toBeInTheDocument();
    expect(screen.getByText(/Hi Fixture, rain is moving in\./)).toHaveStyle({ whiteSpace: 'pre-line' });
    expect(screen.getByText('No note in this mode.')).toBeInTheDocument();
    expect(screen.getByText('31 left · 2-segment limit')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Text Fixture to pick a day' })).toBeEnabled();
    // The preview follows the reason.
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'running_late' } });
    expect(screen.getByText('Hi Fixture, we are running late.')).toBeInTheDocument();
  });

  it('drops the pick row for the Custom message reason and brings the day rows back', async () => {
    await openPick({ customReasonEnabled: true, customCompose: { enabled: true } });
    fireEvent.click(screen.getByText('Let Fixture pick a day'));
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'custom' } });
    expect(screen.queryByText('Let Fixture pick a day')).not.toBeInTheDocument();
    expect(screen.getByText(/Fri, Jan 2, 9:00 AM-10:00 AM/)).toBeInTheDocument();
    expect(screen.queryByText('FIXTURE GETS THIS TEXT')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Move appointment' })).toBeInTheDocument();
  });

  it('posts the hand-off, shows the toast and closes through the parent on success', async () => {
    pickBody = { status: 200, body: { ok: true, dueDate: '2099-01-03', pickBy: customerPick.pickBy, textSent: true } };
    const { onDone } = await openPick();
    fireEvent.click(screen.getByText('Let Fixture pick a day'));
    fireEvent.click(screen.getByRole('button', { name: 'Text Fixture to pick a day' }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(picks()).toHaveLength(1);
    expect(String(picks()[0][0])).toMatch(/\/admin\/dispatch\/visit-1\/customer-pick$/);
    expect(JSON.parse(picks()[0][1].body)).toEqual({ reasonCode: 'weather_rain' });
    expect(showScheduleSaveNotice).toHaveBeenCalledWith('Texted Fixture to pick a day.');
    expect(onDone.mock.calls[0][0]).toMatchObject({ movedCount: 1, notTexted: false, failedCount: 0, overlapCount: 0 });
    expect(fetchMock.mock.calls.some(([path]) => String(path).endsWith('/rain-out'))).toBe(false);
  });

  it('keeps the sheet open with the follow-up when the customer was not texted', async () => {
    pickBody = { status: 200, body: { ok: true, dueDate: '2099-01-03', pickBy: customerPick.pickBy, textSent: false } };
    const { onDone } = await openPick();
    fireEvent.click(screen.getByText('Let Fixture pick a day'));
    fireEvent.click(screen.getByRole('button', { name: 'Text Fixture to pick a day' }));
    expect(await screen.findByText('Handed off, but Fixture was NOT texted — call them so they can pick a time.')).toBeInTheDocument();
    expect(onDone).toHaveBeenCalledWith(expect.objectContaining({ notTexted: true }));
    expect(screen.getByRole('button', { name: 'Sent' })).toBeDisabled();
  });

  it('shows the server refusal and leaves the button ready', async () => {
    pickBody = { status: 409, body: { error: 'Already handed off', reason: 'already_pending' } };
    await openPick();
    fireEvent.click(screen.getByText('Let Fixture pick a day'));
    fireEvent.click(screen.getByRole('button', { name: 'Text Fixture to pick a day' }));
    expect(await screen.findByText('Already handed off')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Text Fixture to pick a day' })).toBeEnabled();
  });
});
