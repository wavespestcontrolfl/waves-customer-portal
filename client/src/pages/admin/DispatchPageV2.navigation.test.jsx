// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import DispatchPageV2 from './DispatchPageV2';
import { adminFetch } from '../../utils/admin-fetch';

vi.mock('../../utils/admin-fetch', () => ({ adminFetch: vi.fn(), isRateLimitError: () => false }));
const enabledVisit = { id: 'service-one', visitId: 'visit-one', visitCloseoutEnabled: true, visitCloseoutPacket: null };
const enabledStandalone = { id: 'service-standalone', visitId: null, visitCloseoutEnabled: true, visitCloseoutPacket: null };
vi.mock('./SchedulePage', () => ({
  CompletionPanel: () => null,
  RescheduleModal: () => null,
  EditServiceModal: ({ service }) => <div>Editing service {service.id}</div>,
  ProtocolPanel: () => null,
  completionResumeOwed: () => false,
}));
vi.mock('../../components/schedule/TimeGridDay', () => ({ default: ({ onEdit, services = [] }) => <div>Schedule visits {services.map((service) => service.customerName).join(', ')}
  <button onClick={() => onEdit(enabledVisit)}>Open day visit</button>
  <button onClick={() => onEdit(enabledStandalone)}>Open standalone day</button>
</div> }));
const appointmentModalState = vi.hoisted(() => ({ props: null }));
vi.mock('../../components/schedule/CreateAppointmentModal', () => ({
  default: (props) => {
    appointmentModalState.props = props;
    return <div role="dialog">New booking for {props.defaultDate}</div>;
  },
}));
vi.mock('../../components/schedule/MobileDispatchList', () => ({ default: ({ services = [], onEdit }) => <div>
  {services.map((service) => <button key={service.id} aria-label={`Open mobile ${service.customerName}`} onClick={() => onEdit(service)}>Mobile visit</button>)}
</div> }));
const projectModalState = vi.hoisted(() => ({ props: null }));
vi.mock('../../components/tech/CreateProjectModal', () => ({
  default: (props) => { projectModalState.props = props; return <div role="dialog" aria-label="Project report fixture" />; },
  wdoFeeSeedFromVisit: () => 175,
}));
vi.mock('./ProjectsPage', () => ({ ProjectDetail: ({ projectId }) => <div>Existing report {projectId}</div> }));
vi.mock('../../components/schedule/MobileAppointmentDetailSheet', () => ({ default: ({ service, onCompleteService }) => <button
  onClick={() => onCompleteService(service)}
>Complete details {service.linkedProject?.id || 'unlinked'}</button> }));
vi.mock('../../hooks/useFeatureFlag', () => ({ useFeatureFlag: () => false, useFeatureFlagReady: () => ({ enabled: false, ready: true, known: true }) }));
vi.mock('../../components/admin/VisitCloseoutSheet', () => ({ default: ({ visitId }) => <div>Visit closeout {visitId}</div> }));
beforeEach(() => {
  projectModalState.props = null;
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ alerts: [] }) })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function schedulePayload(date, customerName) {
  return {
    date,
    services: customerName ? [{ id: customerName, customerName }] : [],
    technicians: [],
    products: [],
    types: [],
  };
}


vi.mock('../../components/schedule/TimeGridDays', () => ({ default: ({ date, dayCount, onEdit }) => <div>Grid date: {date}<button onClick={() => onEdit(enabledVisit)}>Open {dayCount}-day visit</button></div> }));
vi.mock('../../components/schedule/CalendarViewsV2', async importOriginal => ({
  ...await importOriginal(), MonthViewV2: ({date}) => <div>Month date: {date}</div>,
}));

it.each([
  ['2026-09-09', 'Sep 7 – Sep 11, 2026', '2026-09-16', 'Sep 14 – Sep 18, 2026'],
  ['2026-09-30', 'Sep 28 – Oct 2, 2026', '2026-10-07', 'Oct 5 – Oct 9, 2026'],
  ['2026-12-30', 'Dec 28 – Jan 1, 2027', '2027-01-06', 'Jan 4 – Jan 8, 2027'],
])('navigates adjacent workweeks from %s with matching date headings', async (date, heading, nextDate, nextHeading) => {
  vi.mocked(adminFetch).mockResolvedValue({ services: [], technicians: [], products: [], types: [] });
  render(<MemoryRouter initialEntries={['/admin/dispatch?tab=schedule&date='+date]}><DispatchPageV2 activeTab="board" /></MemoryRouter>);
  fireEvent.click(await screen.findByRole('button', {name:'5-Day'}));
  expect(screen.getByText(heading)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', {name:'Next', exact:true}));
  await screen.findByText('Grid date: '+nextDate);
  expect(screen.getByText(nextHeading)).toBeInTheDocument();
  expect(adminFetch).toHaveBeenCalledWith('/admin/schedule?date='+nextDate);
  fireEvent.click(screen.getByRole('button', {name:'Prev', exact:true}));
  await screen.findByText('Grid date: '+date);
  expect(screen.getByText(heading)).toBeInTheDocument();
});

it.each([
  ['Day', '2026-10-01'], ['Week', '2026-10-07'], ['Month', '2026-10-30'],
])('preserves %s navigation across a month boundary', async (mode, nextDate) => {
  vi.mocked(adminFetch).mockResolvedValue({ services: [], technicians: [], products: [], types: [] });
  render(<MemoryRouter initialEntries={['/admin/dispatch?tab=schedule&date=2026-09-30']}><DispatchPageV2 activeTab="board" /></MemoryRouter>);
  fireEvent.click((await screen.findAllByRole('button', {name:mode, exact:true}))[0]);
  fireEvent.click(screen.getByRole('button', {name:'Next', exact:true}));
  (await screen.findAllByRole('button', {name:mode, exact:true}))[0];
  expect(adminFetch).toHaveBeenCalledWith('/admin/schedule?date='+nextDate);
});

it.each([
  ['Day', 'Open day visit'],
  ['5-Day', 'Open 5-day visit'],
  ['Week', 'Open 7-day visit'],
])('opens an enabled unsubmitted combined visit from the desktop %s calendar', async (mode, entryName) => {
  vi.mocked(adminFetch).mockResolvedValue({ services: [enabledVisit], technicians: [], products: [], types: [] });
  render(<MemoryRouter initialEntries={['/admin/dispatch?tab=schedule&date=2026-09-12']}><DispatchPageV2 activeTab="board" /></MemoryRouter>);
  fireEvent.click((await screen.findAllByRole('button', { name: mode, exact: true }))[0]);
  fireEvent.click(await screen.findByRole('button', { name: entryName }));
  expect(await screen.findByText('Visit closeout visit-one')).toBeInTheDocument();
});

it('keeps a standalone row in the normal editor when the legacy gate marks every row enabled', async () => {
  vi.mocked(adminFetch).mockResolvedValue({ services: [enabledStandalone], technicians: [], products: [], types: [] });
  render(<MemoryRouter initialEntries={['/admin/dispatch?tab=schedule&date=2026-09-12']}><DispatchPageV2 activeTab="board" /></MemoryRouter>);
  fireEvent.click(await screen.findByRole('button', { name: 'Open standalone day' }));
  expect(await screen.findByText('Editing service service-standalone')).toBeInTheDocument();
  expect(screen.queryByText(/Visit closeout/)).not.toBeInTheDocument();
});

it('keeps a reopened draft open when a cancelled booking finishes in the background', async () => {
  const refresh = deferred();
  let nextDateLoads = 0;
  vi.mocked(adminFetch).mockImplementation((url) => {
    if (url === '/admin/dispatch/products/catalog') return Promise.resolve({ products: [] });
    if (url === '/admin/schedule?date=2026-09-30') {
      return Promise.resolve(schedulePayload('2026-09-30', 'First day'));
    }
    if (url === '/admin/schedule?date=2026-10-01') {
      nextDateLoads += 1;
      return nextDateLoads === 1
        ? Promise.resolve(schedulePayload('2026-10-01', 'Next day'))
        : refresh.promise;
    }
    return Promise.resolve(schedulePayload('', null));
  });
  const setOpenCreateHandler = vi.fn();
  render(
    <MemoryRouter initialEntries={['/admin/dispatch?date=2026-09-30']}>
      <DispatchPageV2 activeTab="board" setOpenCreateHandler={setOpenCreateHandler} />
    </MemoryRouter>,
  );
  await screen.findByText(/First day/);
  await waitFor(() => expect(setOpenCreateHandler).toHaveBeenCalled());

  act(() => setOpenCreateHandler.mock.calls.at(-1)[0]());
  const firstOnCreated = appointmentModalState.props.onCreated;
  act(() => appointmentModalState.props.onClose());
  fireEvent.click(screen.getByRole('button', { name: 'Next', exact: true }));
  await screen.findByText(/Next day/);
  act(() => setOpenCreateHandler.mock.calls.at(-1)[0]());
  expect(screen.getByRole('dialog')).toHaveTextContent('2026-10-01');

  act(() => firstOnCreated({ id: 'created' }, { background: true }));
  expect(screen.getByRole('dialog')).toHaveTextContent('2026-10-01');
  expect(screen.queryByText('Loading schedule…')).not.toBeInTheDocument();
  await act(async () => {
    refresh.resolve(schedulePayload('2026-10-01', 'Background refresh'));
  });
  expect(await screen.findByText(/Background refresh/)).toBeInTheDocument();
  expect(screen.getByRole('dialog')).toHaveTextContent('2026-10-01');
});

it('discards a refresh response after its date is no longer displayed', async () => {
  const staleRefresh = deferred();
  let firstDateLoads = 0;
  vi.mocked(adminFetch).mockImplementation((url) => {
    if (url === '/admin/dispatch/products/catalog') return Promise.resolve({ products: [] });
    if (url === '/admin/schedule?date=2026-09-30') {
      firstDateLoads += 1;
      return firstDateLoads === 1
        ? Promise.resolve(schedulePayload('2026-09-30', 'First day'))
        : staleRefresh.promise;
    }
    if (url === '/admin/schedule?date=2026-10-01') {
      return Promise.resolve(schedulePayload('2026-10-01', 'Current day'));
    }
    return Promise.resolve(schedulePayload('', null));
  });
  const setOpenCreateHandler = vi.fn();
  render(
    <MemoryRouter initialEntries={['/admin/dispatch?date=2026-09-30']}>
      <DispatchPageV2 activeTab="board" setOpenCreateHandler={setOpenCreateHandler} />
    </MemoryRouter>,
  );
  await screen.findByText(/First day/);
  await waitFor(() => expect(setOpenCreateHandler).toHaveBeenCalled());
  act(() => setOpenCreateHandler.mock.calls.at(-1)[0]());
  act(() => appointmentModalState.props.onCreated({}, { background: true }));
  fireEvent.click(screen.getByRole('button', { name: 'Next', exact: true }));
  expect(await screen.findByText(/Current day/)).toBeInTheDocument();

  await act(async () => {
    staleRefresh.resolve(schedulePayload('2026-09-30', 'Stale first day'));
  });
  expect(screen.getByText(/Current day/)).toBeInTheDocument();
  expect(screen.queryByText(/Stale first day/)).not.toBeInTheDocument();
});

vi.mock('../../components/schedule/MobileDayStrip', () => ({ default: () => <div>Day strip</div> }));
vi.mock('../../components/dispatch/TechMatchPanelV2', () => ({ default: () => <div>Tech Match tools</div> }));
vi.mock('../../components/dispatch/CSRPanelV2', () => ({ default: () => <div>CSR Booking tools</div> }));
vi.mock('../../components/dispatch/RevenuePanelV2', () => ({ default: () => <div>Job Scores tools</div> }));
vi.mock('../../components/dispatch/InsightsPanelV2', () => ({ default: () => <div>Insights tools</div> }));

it.each([['match', 'Tech Match tools'], ['csr', 'CSR Booking tools'], ['revenue', 'Job Scores tools'], ['insights', 'Insights tools']])('keeps board-only view switches out of mobile %s', async (tab, content) => {
  vi.stubGlobal('innerWidth', 390);
  vi.mocked(adminFetch).mockResolvedValue({ services: [], technicians: [], products: [], types: [] });
  render(<MemoryRouter><DispatchPageV2 activeTab={tab} /></MemoryRouter>);
  expect(await screen.findByText(content)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Week', exact: true })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Day', exact: true })).not.toBeInTheDocument();
});

it('keeps the mobile board Day and Week switches available', async () => {
  vi.stubGlobal('innerWidth', 390);
  vi.mocked(adminFetch).mockResolvedValue({ services: [], technicians: [], products: [], types: [] });
  render(<MemoryRouter><DispatchPageV2 activeTab="board" /></MemoryRouter>);
  expect(await screen.findByRole('button', { name: 'Week', exact: true })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Day', exact: true })).toBeInTheDocument();
});

it('carries a newly saved project through Details before completion is reopened', async () => {
  vi.stubGlobal('innerWidth', 390);
  const service = { id: 'wdo-service', customerName: 'WDO customer', status: 'confirmed', scheduledDate: '2026-09-12', completionProfile: { projectBacked: true, projectType: 'wdo_inspection' } };
  vi.mocked(adminFetch).mockResolvedValue({ services: [service], technicians: [], products: [], types: [] });
  render(<MemoryRouter initialEntries={['/admin/dispatch?date=2026-09-12']}><DispatchPageV2 activeTab="board" /></MemoryRouter>);

  fireEvent.click(await screen.findByRole('button', { name: 'Open mobile WDO customer' }));
  await screen.findByRole('dialog', { name: 'Project report fixture' });
  const created = { id: 'created-project', status: 'draft' };
  act(() => { projectModalState.props.onCreated(created); projectModalState.props.onViewDetails(created); });

  fireEvent.click(await screen.findByRole('button', { name: 'Complete details created-project' }));
  expect(await screen.findByText('Existing report created-project')).toBeInTheDocument();
});


it('recovers a failed day load when a late booking refresh succeeds', async () => {
  let nextDayLoads = 0;
  vi.mocked(adminFetch).mockImplementation((url) => {
    if (url === '/admin/dispatch/products/catalog') return Promise.resolve({ products: [] });
    if (url === '/admin/schedule?date=2026-10-01' && ++nextDayLoads === 1) {
      return Promise.reject(new Error('Day unavailable'));
    }
    return Promise.resolve(schedulePayload('2026-10-01', 'Recovered schedule'));
  });
  const setOpenCreateHandler = vi.fn();
  render(<MemoryRouter initialEntries={['/admin/dispatch?date=2026-09-30']}>
    <DispatchPageV2 activeTab="board" setOpenCreateHandler={setOpenCreateHandler} />
  </MemoryRouter>);
  await screen.findByText(/Recovered schedule/);
  await waitFor(() => expect(setOpenCreateHandler).toHaveBeenCalled());
  act(() => setOpenCreateHandler.mock.calls.at(-1)[0]());
  const lateRefresh = appointmentModalState.props.onCreated;
  act(() => appointmentModalState.props.onClose());
  fireEvent.click(screen.getByRole('button', { name: 'Next', exact: true }));
  await screen.findByText(/Failed to load schedule: Day unavailable/);
  act(() => lateRefresh({}, { background: true }));
  expect(await screen.findByText(/Recovered schedule/)).toBeInTheDocument();
  expect(screen.queryByText(/Failed to load schedule/)).not.toBeInTheDocument();
});


it.each(['success', 'failure', 'new-failure'])('keeps the latest same-day outcome when an older load settles (%s)', async (outcome) => {
  const older = deferred();
  let nextDayLoads = 0;
  vi.mocked(adminFetch).mockImplementation((url) => {
    if (url === '/admin/dispatch/products/catalog') return Promise.resolve({ products: [] });
    if (url === '/admin/schedule?date=2026-10-01') {
      nextDayLoads += 1;
      if (nextDayLoads === 1) return older.promise;
      if (outcome === 'new-failure') return Promise.reject(new Error('Latest error'));
    }
    return Promise.resolve(schedulePayload('2026-10-01', 'Current schedule'));
  });
  const setOpenCreateHandler = vi.fn();
  render(<MemoryRouter initialEntries={['/admin/dispatch?date=2026-09-30']}>
    <DispatchPageV2 activeTab="board" setOpenCreateHandler={setOpenCreateHandler} />
  </MemoryRouter>);
  await screen.findByText(/Current schedule/);
  await waitFor(() => expect(setOpenCreateHandler).toHaveBeenCalled());
  act(() => setOpenCreateHandler.mock.calls.at(-1)[0]());
  const lateRefresh = appointmentModalState.props.onCreated;
  act(() => appointmentModalState.props.onClose());
  fireEvent.click(screen.getByRole('button', { name: 'Next', exact: true }));
  await screen.findByText('Loading schedule…');
  act(() => lateRefresh({}, { background: true }));
  const expected = outcome === 'new-failure' ? /Latest error/ : /Current schedule/;
  expect(await screen.findByText(expected)).toBeInTheDocument();
  expect(screen.queryByText('Loading schedule…')).not.toBeInTheDocument();
  await act(async () => older.resolve(outcome === 'failure'
    ? Promise.reject(new Error('Stale error'))
    : schedulePayload('2026-10-01', 'Stale schedule')));
  expect(screen.getByText(expected)).toBeInTheDocument();
  expect(screen.queryByText(/Stale schedule|Stale error/)).not.toBeInTheDocument();
});

function MissingAppointmentLink() {
  const navigate = useNavigate();
  return <button onClick={() => navigate('/admin/dispatch?date=2026-09-30&appointment=missing')}>Missing appointment link</button>;
}

it('preserves a consumed missing-appointment message during background refresh', async () => {
  vi.mocked(adminFetch).mockResolvedValue(schedulePayload('2026-09-30', 'Current schedule'));
  const setOpenCreateHandler = vi.fn();
  render(<MemoryRouter initialEntries={['/admin/dispatch?date=2026-09-30']}>
    <MissingAppointmentLink />
    <DispatchPageV2 activeTab="board" setOpenCreateHandler={setOpenCreateHandler} />
  </MemoryRouter>);
  await screen.findByText(/Current schedule/);
  await waitFor(() => expect(setOpenCreateHandler).toHaveBeenCalled());
  act(() => setOpenCreateHandler.mock.calls.at(-1)[0]());
  const lateRefresh = appointmentModalState.props.onCreated;
  act(() => appointmentModalState.props.onClose());
  fireEvent.click(screen.getByRole('button', { name: 'Missing appointment link' }));
  await screen.findByText(/That appointment is no longer on this date/);
  await act(async () => lateRefresh({}, { background: true }));
  expect(screen.getByText(/That appointment is no longer on this date/)).toBeInTheDocument();
});

it('shows a held visit above the stops and Book it opens the new-appointment modal on its day, time and customer', async () => {
  const held = {
    call_log_id: 'call-held', kind: 'confirmed', date_et: '2026-10-14', minutes: 660, time_label: '11:00 AM',
    caller_name: 'Pat Sample', phone: '+19415550100', address: { line1: '12 Test Lane', city: 'Bradenton', zip: '34205' },
    service: 'General Pest Control', call_at: '2026-10-12T14:30:00.000Z', customer_id: 'cust-1', notes: null,
  };
  const offHour = { ...held, call_log_id: 'call-off-hour', minutes: 870, time_label: '2:30 PM', customer_id: null };
  vi.mocked(adminFetch).mockImplementation(async (url) => {
    if (url.startsWith('/admin/schedule/held-visits')) return { heldVisits: [held, offHour] };
    if (url === '/admin/customers/cust-1') return { customer: { id: 'cust-1', firstName: 'Pat', lastName: 'Sample', phone: '+19415550100', address: { line1: '12 Test Lane', city: 'Bradenton', zip: '34205' } } };
    return { services: [], technicians: [], products: [], types: [] };
  });
  render(<MemoryRouter initialEntries={['/admin/dispatch?tab=schedule&date=2026-10-14']}><DispatchPageV2 activeTab="board" /></MemoryRouter>);
  expect(await screen.findByText('From calls, not on the calendar')).toBeInTheDocument();
  expect(adminFetch).toHaveBeenCalledWith('/admin/schedule/held-visits?date=2026-10-14');
  // An off-hour slot is not prefilled: the form must make the person pick a time, and the agreed time rides in the notes.
  fireEvent.click(screen.getAllByRole('button', { name: 'Book it' })[1]);
  await screen.findByRole('dialog');
  expect(appointmentModalState.props).toMatchObject({
    defaultDate: '2026-10-14', requireTimeChoice: true,
    defaultInternalNotes: 'Booked from a phone call. Call ID: call-off-hour. Time agreed on the call: 2:30 PM. Visits start on the hour: agree a whole-hour time with the caller. Address stated on the call: 12 Test Lane, Bradenton, 34205.',
    defaultAddressLine1: '12 Test Lane',
  });
  expect(appointmentModalState.props.defaultWindowStart).toBeUndefined();
  act(() => appointmentModalState.props.onClose());
  fireEvent.click(screen.getAllByRole('button', { name: 'Book it' })[0]);
  await screen.findByRole('dialog');
  expect(appointmentModalState.props).toMatchObject({
    defaultDate: '2026-10-14', defaultWindowStart: '11:00', defaultCustomer: expect.objectContaining({ id: 'cust-1', firstName: 'Pat', lastName: 'Sample' }),
    // The call marker rides into the visit's internal notes, so the booked visit carries the call.
    defaultInternalNotes: 'Booked from a phone call. Call ID: call-held. Address stated on the call: 12 Test Lane, Bradenton, 34205.', requireTimeChoice: false,
  });
});

it('only the newest Book it click opens the form when an earlier customer lookup is slow', async () => {
  const row = (id, customerId) => ({
    call_log_id: id, kind: 'confirmed', date_et: '2026-10-14', minutes: 660, time_label: '11:00 AM', caller_name: `Caller ${id}`,
    phone: '+19415550100', address: { line1: '12 Test Lane', city: 'Bradenton', zip: '34205' }, service: 'General Pest Control',
    call_at: '2026-10-12T14:30:00.000Z', customer_id: customerId, notes: null,
  });
  let releaseSlow;
  const slow = new Promise((resolve) => { releaseSlow = resolve; });
  vi.mocked(adminFetch).mockImplementation(async (url) => {
    if (url.startsWith('/admin/schedule/held-visits')) return { heldVisits: [row('first', 'cust-slow'), row('second', 'cust-fast')] };
    if (url === '/admin/customers/cust-slow') { await slow; return { customer: { id: 'cust-slow', firstName: 'Slow', lastName: 'Sample' } }; }
    if (url === '/admin/customers/cust-fast') return { customer: { id: 'cust-fast', firstName: 'Fast', lastName: 'Sample' } };
    return { services: [], technicians: [], products: [], types: [] };
  });
  render(<MemoryRouter initialEntries={['/admin/dispatch?tab=schedule&date=2026-10-14']}><DispatchPageV2 activeTab="board" /></MemoryRouter>);
  const buttons = await screen.findAllByRole('button', { name: 'Book it' });
  fireEvent.click(buttons[0]);
  fireEvent.click(buttons[1]);
  await screen.findByRole('dialog');
  expect(appointmentModalState.props.defaultCustomer).toMatchObject({ id: 'cust-fast' });
  await act(async () => { releaseSlow(); await slow; });
  expect(appointmentModalState.props.defaultCustomer).toMatchObject({ id: 'cust-fast' });
  expect(appointmentModalState.props.defaultInternalNotes).toContain('Call ID: second.');
});

it('a Book it lookup still pending when the day changes does not open the form', async () => {
  const held = {
    call_log_id: 'call-late', kind: 'confirmed', date_et: '2026-10-14', minutes: 660, time_label: '11:00 AM', caller_name: 'Pat Sample',
    phone: '+19415550100', address: { line1: '12 Test Lane', city: 'Bradenton', zip: '34205' }, service: 'General Pest Control',
    call_at: '2026-10-12T14:30:00.000Z', customer_id: 'cust-slow', notes: null,
  };
  let releaseSlow;
  const slow = new Promise((resolve) => { releaseSlow = resolve; });
  vi.mocked(adminFetch).mockImplementation(async (url) => {
    if (url === '/admin/schedule/held-visits?date=2026-10-14') return { heldVisits: [held] };
    if (url.startsWith('/admin/schedule/held-visits')) return { heldVisits: [] };
    if (url === '/admin/customers/cust-slow') { await slow; return { customer: { id: 'cust-slow', firstName: 'Slow', lastName: 'Sample' } }; }
    return { services: [], technicians: [], products: [], types: [] };
  });
  render(<MemoryRouter initialEntries={['/admin/dispatch?tab=schedule&date=2026-10-14']}><DispatchPageV2 activeTab="board" /></MemoryRouter>);
  fireEvent.click(await screen.findByRole('button', { name: 'Book it' }));
  fireEvent.click(screen.getByRole('button', { name: 'Next', exact: true }));
  await waitFor(() => expect(adminFetch).toHaveBeenCalledWith('/admin/schedule/held-visits?date=2026-10-15'));
  await act(async () => { releaseSlow(); await slow; });
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});
