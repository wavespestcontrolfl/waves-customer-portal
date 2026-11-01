// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ navigationBusy: vi.fn() }));
vi.mock('socket.io-client', () => ({ io: () => ({ on: vi.fn(), off: vi.fn(), disconnect: vi.fn() }) }));
vi.mock('../../hooks/useFeatureFlag', () => ({ useFeatureFlag: (key) => key === 'pest-recap-v1', useFeatureFlagReady: () => ({ enabled: false, ready: true }) }));
vi.mock('../../components/tech/TechIntelligenceBar', () => ({ default: () => <div>Field assistant</div> }));
vi.mock('../../components/tech/TechNoticeFeed', () => ({ default: () => <div /> }));
vi.mock('../../components/tech/CreateProjectModal', () => ({ default: () => null, wdoFeeSeedFromVisit: () => null }));
vi.mock('../../components/tech/TechTimeTrackingCard', () => ({ default: () => <div>Shift time</div> }));
vi.mock('../../components/tech/TechServicePhotosModal', () => ({ default: () => null }));
vi.mock('../../components/tech/TechTreatmentZoneModal', () => ({ default: () => null }));
vi.mock('../../components/tech/FieldLeadModal', () => ({ default: () => null }));
vi.mock('../../components/ServiceRecapModal', () => ({ default: () => null }));
vi.mock('../admin/ProjectsPage', () => ({ ProjectDetail: () => null }));
vi.mock('./VisitBriefPanel', () => ({ default: ({ stop }) => <p>Property brief for {stop.primary.id}</p> }));
import TechHomePage from './TechHomePage';

// Tech Home Quick Move: a result that needs follow-up stays on screen until the
// tech dismisses it, exactly like the dispatch Details flow.
const row = (id, name) => ({ id, technicianId: 'tech-fixture', customerName: name, address: '100 Example Lane', serviceType: 'Lawn care', scheduledDate: '2099-01-01', status: 'confirmed', windowStart: '09:00:00', windowEnd: '10:00:00' });
let commitBody;
let optionsExtra;
let optionsRefusal;
let pickBody;
let fetchMock;
let scheduleReads;

function mount() {
  localStorage.setItem('waves_admin_token', 'fixture-only');
  localStorage.setItem('waves_admin_user', JSON.stringify({ id: 'tech-fixture', name: 'Fixture Technician', role: 'technician' }));
  return render(<MemoryRouter initialEntries={['/admin/today?visit=row%3Aone']}><Routes>
    <Route path="/admin/today" element={<Outlet context={{ setNavigationBusy: mocks.navigationBusy, techRole: 'technician' }} />}>
      <Route index element={<TechHomePage />} />
    </Route>
  </Routes></MemoryRouter>);
}

beforeEach(() => {
  scheduleReads = 0;
  commitBody = null;
  optionsExtra = {};
  optionsRefusal = null;
  pickBody = null;
  fetchMock = vi.fn(async (path, init) => {
    let data = {};
    if (path.includes('/admin/schedule?')) { scheduleReads += 1; data = { services: [row('one', 'Ames Fixture'), row('two', 'Baker Fixture')] }; }
    if (path.endsWith('/visit-brief')) data = { facts: { access: { accessNotes: 'Use the side gate' } } };
    if (path.includes('/tech/line')) data = { line: null };
    if (path.endsWith('/rain-out-options') && optionsRefusal) {
      return { ok: false, status: optionsRefusal.status, json: async () => optionsRefusal.body };
    }
    if (path.endsWith('/rain-out-options')) {
      data = {
        ok: true, days: [], ...optionsExtra, remainingRouteCount: 1, service: { window: { start: '09:00', end: '10:00' } }, today: {},
        sameDay: [{ kind: 'same_day', date: '2099-01-01', window: { start: '14:00', end: '15:00' }, label: 'Later today', display: 'Today, 2:00 PM-3:00 PM' }],
      };
    }
    if (path.endsWith('/rain-out') && init?.method === 'POST') data = commitBody;
    if (path.endsWith('/customer-pick') && init?.method === 'POST') {
      return { ok: pickBody.status === 200, status: pickBody.status, json: async () => pickBody.body };
    }
    return { ok: true, status: 200, json: async () => data };
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals(); });

const commits = () => fetchMock.mock.calls.filter(([path, init]) => String(path).endsWith('/rain-out') && init?.method === 'POST');

async function openAndMove() {
  mount();
  await screen.findByText('Property brief for one');
  fireEvent.click(screen.getByRole('button', { name: 'Quick Move' }));
  await screen.findByText(/Today, 2:00 PM-3:00 PM/);
  fireEvent.click(screen.getByRole('button', { name: /^Move this stop/ }));
}

describe('Tech Home Quick Move result', () => {
  it('keeps a partial move open, names the stop to follow up, and locks a second Move until dismissed', async () => {
    commitBody = {
      ok: true, movedCount: 1, failedCount: 1,
      results: [{ id: 'one', ok: true, smsSent: true }, { id: 'two', ok: false, error: 'slot taken' }],
    };
    await openAndMove();
    const result = await screen.findByTestId('quick-move-result');
    expect(result).toHaveTextContent('Moved 1 stop to Today, 2:00 PM-3:00 PM, customer texted.');
    expect(result).toHaveTextContent('1 stop could not be moved');
    expect(result).toHaveTextContent('Baker Fixture: Not moved — review dispatch');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    const move = screen.getByRole('button', { name: 'Moved' });
    expect(move).toBeDisabled();
    fireEvent.click(move);
    expect(commits()).toHaveLength(1);
    // The route behind the sheet refreshed for the stop that did move.
    await waitFor(() => expect(scheduleReads).toBeGreaterThan(1));

    // Nothing dismisses it on its own.
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      await act(async () => { vi.advanceTimersByTime(7000); });
    } finally {
      vi.useRealTimers();
    }
    expect(screen.getByTestId('quick-move-result')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByTestId('quick-move-result')).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('keeps a customer-not-texted result and an overlap warning open with their detail', async () => {
    commitBody = {
      ok: true, movedCount: 1, failedCount: 0, overlapCount: 1,
      overlapWarnings: ['2099-01-01 overlaps another appointment.'],
      results: [{ id: 'one', ok: true, smsSent: false, warnings: ['2099-01-01 overlaps another appointment.'] }],
    };
    await openAndMove();
    const result = await screen.findByTestId('quick-move-result');
    expect(result).toHaveTextContent('customer NOT texted');
    expect(result).toHaveTextContent('2099-01-01 overlaps another appointment. Check the route on that day.');
    expect(result).toHaveTextContent('Ames Fixture: Customer not texted — follow up manually; 2099-01-01 overlaps another appointment.');
    expect(screen.getByRole('button', { name: 'Moved' })).toBeDisabled();
  });

  it('closes a clean move and shows the short banner', async () => {
    commitBody = { ok: true, movedCount: 1, failedCount: 0, results: [{ id: 'one', ok: true, smsSent: true }] };
    await openAndMove();
    expect(await screen.findByText('Moved 1 stop to Today, 2:00 PM-3:00 PM, customer texted')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByTestId('quick-move-result')).not.toBeInTheDocument();
  });
});

// "Let the customer pick a day" (GATE_QUICKMOVE_CUSTOMER_PICK): the one MOVE TO
// row, the swap back to day rows, the text preview, the hand-off POST and the
// Today card it leaves behind.
const customerPick = {
  available: true,
  pickBy: '2099-01-03T01:00:00.000Z',
  pickByLabel: 'Wed 8 PM',
  previewByReason: { weather_rain: 'Hi Ames, rain is moving in.\nPick a new day: [link]' },
};
const dayRow = { kind: 'day', date: '2099-01-02', window: { start: '09:00', end: '10:00' }, label: 'Tomorrow', display: 'Fri, Jan 2, 9:00 AM-10:00 AM' };
const picks = () => fetchMock.mock.calls.filter(([path, init]) => String(path).endsWith('/customer-pick') && init?.method === 'POST');

async function openSheet() {
  mount();
  await screen.findByText('Property brief for one');
  fireEvent.click(screen.getByRole('button', { name: 'Quick Move' }));
  await screen.findByText(/Today, 2:00 PM-3:00 PM|Moving this visit/);
}

describe('Tech Home Quick Move: let the customer pick a day', () => {
  it('shows today exactly as before when the options carry no customerPick', async () => {
    optionsExtra = { days: [dayRow] };
    await openSheet();
    expect(screen.getByText(/Fri, Jan 2, 9:00 AM-10:00 AM/)).toBeInTheDocument();
    expect(screen.queryByText(/pick a day/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Pick a day myself instead' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Move this stop/ })).toBeInTheDocument();
  });

  it('replaces the day rows with one pick row, keeps the same-day rows, and swaps back', async () => {
    optionsExtra = { days: [dayRow], customerPick };
    await openSheet();
    expect(screen.getByText(/Today, 2:00 PM-3:00 PM/)).toBeInTheDocument();
    expect(screen.queryByText(/Fri, Jan 2/)).not.toBeInTheDocument();
    expect(screen.getByText('📅 Let Ames pick a day')).toBeInTheDocument();
    expect(screen.getByText('Texts Ames 6 route-fit times · pick by Wed 8 PM')).toBeInTheDocument();
    // Still on the same-day row: the usual controls stay.
    expect(screen.getByText('APPLY TO')).toBeInTheDocument();
    expect(screen.queryByText('AMES GETS THIS TEXT')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('📅 Let Ames pick a day'));
    expect(screen.queryByText('APPLY TO')).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.getByText('AMES GETS THIS TEXT')).toBeInTheDocument();
    expect(screen.getByText(/Hi Ames, rain is moving in\./)).toHaveStyle({ whiteSpace: 'pre-line' });
    expect(screen.getByRole('button', { name: 'Text Ames to pick a day' })).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: 'Pick a day myself instead' }));
    expect(screen.getByText(/Fri, Jan 2, 9:00 AM-10:00 AM/)).toBeInTheDocument();
    expect(screen.queryByText('📅 Let Ames pick a day')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Move this stop/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Let Ames pick instead' }));
    expect(screen.getByText('📅 Let Ames pick a day')).toBeInTheDocument();
    expect(screen.getByText('AMES GETS THIS TEXT')).toBeInTheDocument();
  });

  it('hands the stop off, closes with the toast, and leaves a Today card that Got it clears', async () => {
    optionsExtra = { days: [dayRow], customerPick };
    pickBody = { status: 200, body: { ok: true, dueDate: '2099-01-03', pickBy: customerPick.pickBy, textSent: true } };
    await openSheet();
    fireEvent.click(screen.getByText('📅 Let Ames pick a day'));
    fireEvent.click(screen.getByRole('button', { name: 'Text Ames to pick a day' }));
    expect(await screen.findByText('Texted Ames to pick a day. Stop taken off your route.')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(picks()).toHaveLength(1);
    expect(JSON.parse(picks()[0][1].body)).toEqual({ reasonCode: 'weather_rain' });
    expect(commits()).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: 'Today' }));
    const card = await screen.findByTestId('quick-move-handoff');
    expect(card).toHaveTextContent('HANDED OFF TO THE CUSTOMER');
    expect(card.querySelector('h2')).toHaveTextContent('Fixture');
    expect(card).toHaveTextContent('Lawn care');
    expect(screen.getByText('Was Today, 9:00 AM-10:00 AM')).toHaveClass('tf-struck');
    expect(card).toHaveTextContent('Now Ames picks a day by Wed 8 PM');
    expect(card).toHaveTextContent("Off your route. If Ames doesn't pick, Auto-Dispatch books it.");
    fireEvent.click(screen.getByRole('button', { name: 'Got it' }));
    expect(screen.queryByTestId('quick-move-handoff')).not.toBeInTheDocument();
  });

  it('keeps the sheet open with the follow-up box when the customer was not texted', async () => {
    optionsExtra = { customerPick };
    pickBody = { status: 200, body: { ok: true, dueDate: '2099-01-03', pickBy: customerPick.pickBy, textSent: false, needsAttention: ['Customer not texted'] } };
    await openSheet();
    fireEvent.click(screen.getByText('📅 Let Ames pick a day'));
    fireEvent.click(screen.getByRole('button', { name: 'Text Ames to pick a day' }));
    const result = await screen.findByTestId('quick-move-result');
    expect(result).toHaveTextContent('Handed off, but Ames was NOT texted — call them so they can pick a time.');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sent' })).toBeDisabled();
    expect(picks()).toHaveLength(1);
  });

  it('shows the server refusal and lets the tech retry', async () => {
    optionsExtra = { customerPick };
    pickBody = { status: 409, body: { error: 'Already handed off', reason: 'already_pending' } };
    await openSheet();
    fireEvent.click(screen.getByText('📅 Let Ames pick a day'));
    fireEvent.click(screen.getByRole('button', { name: 'Text Ames to pick a day' }));
    expect(await screen.findByText('Already handed off')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Text Ames to pick a day' })).toBeEnabled();
  });

  it('shows only the pick row to a technician who cannot move visits', async () => {
    optionsRefusal = { status: 403, body: { error: 'Ask the office to move this visit.', code: 'move_not_allowed', customerPickOnly: true, customerPick } };
    pickBody = { status: 200, body: { ok: true, dueDate: '2099-01-03', pickBy: customerPick.pickBy, textSent: true } };
    await openSheet();
    expect(screen.queryByText('Ask the office to move this visit.')).not.toBeInTheDocument();
    expect(screen.getByText('📅 Let Ames pick a day')).toBeInTheDocument();
    expect(screen.queryByText(/Today, 2:00 PM/)).not.toBeInTheDocument();
    expect(screen.getByText('Moving this visit to a set time needs the office.')).toBeInTheDocument();
    expect(screen.getByText('AMES GETS THIS TEXT')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Pick a day myself instead' })).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Text Ames to pick a day' }));
    expect(await screen.findByText('Texted Ames to pick a day. Stop taken off your route.')).toBeInTheDocument();
    expect(picks()).toHaveLength(1);
  });

  it('keeps today\'s error box for a 403 that is not a pick-only refusal', async () => {
    optionsRefusal = { status: 403, body: { error: 'Ask the office to move this visit.', code: 'move_not_allowed' } };
    mount();
    await screen.findByText('Property brief for one');
    fireEvent.click(screen.getByRole('button', { name: 'Quick Move' }));
    expect(await screen.findByText('Ask the office to move this visit.')).toBeInTheDocument();
    expect(screen.queryByText(/pick a day/i)).not.toBeInTheDocument();
  });
});
