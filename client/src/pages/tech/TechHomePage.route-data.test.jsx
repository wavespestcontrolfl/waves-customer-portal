// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ navigationBusy: vi.fn(), socketEvent: null }));
vi.mock('socket.io-client', () => ({ io: () => ({ on: (_event, callback) => { mocks.socketEvent = callback; }, off: vi.fn(), disconnect: vi.fn() }) }));
vi.mock('../../hooks/useFeatureFlag', () => ({ useFeatureFlag: () => false }));
vi.mock('../../components/tech/TechIntelligenceBar', () => ({ default: () => <div>Field assistant</div> }));
vi.mock('../../components/tech/GeofenceArrivalPrompt', () => ({ default: () => null }));
vi.mock('../../components/tech/CreateProjectModal', () => ({ default: () => null, wdoFeeSeedFromVisit: () => null }));
vi.mock('../../components/tech/TechTimeTrackingCard', () => ({ default: () => <div>Shift time</div> }));
vi.mock('../../components/tech/TechServicePhotosModal', () => ({ default: ({ serviceId }) => <div>Photos for {serviceId}</div> }));
vi.mock('../../components/tech/TechTreatmentZoneModal', () => ({ default: () => null }));
vi.mock('../../components/tech/FieldLeadModal', () => ({ default: () => null }));
vi.mock('../../components/ServiceRecapModal', () => ({ default: () => <div>Existing recap form</div> }));
vi.mock('./VisitBriefPanel', () => ({ default: ({ stop, detail, onRetry, onPhotos, onBusyChange }) => <div>
  <p>Property brief for {stop.primary.id}</p>
  <p>{detail?.byService?.[stop.primary.id]?.brief?.facts?.access?.accessNotes}</p>
  {detail?.status === 'error' && <button onClick={onRetry}>Retry details</button>}
  <button onClick={() => onPhotos(stop.primary)}>Service photos</button>
  <button onClick={() => onBusyChange(true)}>Start contact action</button>
</div> }));
import TechHomePage from './TechHomePage';

const row = (id, overrides = {}) => ({ id, technicianId: 'tech-fixture', customerName: `Fixture ${id}`, address: '100 Example Lane', serviceType: 'Lawn care', scheduledDate: '2099-01-01', status: 'confirmed', windowStart: '09:00:00', windowEnd: '10:00:00', ...overrides });
let rows;
let scheduleFails;
let briefStatus;
let fetchMock;

function mount(path = '/tech', { enabled = false, role = 'technician', id = 'tech-fixture' } = {}) {
  localStorage.setItem('waves_admin_token', 'fixture-only');
  localStorage.setItem('waves_admin_user', JSON.stringify({ id, name: 'Fixture Technician', role }));
  return render(<MemoryRouter initialEntries={[path]}><Routes>
    <Route path="/tech" element={<Outlet context={{ fieldWorkspace: enabled, setNavigationBusy: mocks.navigationBusy }} />}>
      <Route index element={<TechHomePage />} />
      <Route path="tools" element={<TechHomePage section="tools" />} />
      <Route path="more" element={<TechHomePage section="more" />} />
    </Route>
  </Routes></MemoryRouter>);
}

beforeEach(() => {
  rows = [row('one'), row('two', { status: 'en_route' }), row('other', { technicianId: 'other-tech' })];
  scheduleFails = false;
  briefStatus = 200;
  mocks.navigationBusy.mockClear();
  fetchMock = vi.fn(async (path, options = {}) => {
    let data = {};
    let status = 200;
    if (path.includes('/admin/schedule?')) {
      status = scheduleFails ? 503 : 200;
      data = scheduleFails ? { error: 'Route connection unavailable' } : { services: rows };
    }
    if (path.endsWith('/on-site')) {
      const id = path.split('/').at(-2);
      rows = rows.map((service) => service.id === id ? { ...service, status: 'on_site' } : service);
    }
    if (path.endsWith('/visit-brief')) {
      status = briefStatus;
      data = status === 200 ? { facts: { access: { accessNotes: 'Use the side gate' } } } : { error: status === 404 ? 'Not found' : 'Brief unavailable' };
    }
    if (path.includes('/tech/line')) data = { line: null };
    return { ok: status === 200, status, json: async () => data };
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals(); });


const toggleBrief = () => fireEvent.click(screen.getByRole('button', { name: /Fixture two/ }));

it('shows only assigned rows and shows none while the technician identity is missing', async () => {
  const view = mount();
  await screen.findByRole('button', { name: /Fixture two/ });
  expect(screen.queryByText('Fixture other')).not.toBeInTheDocument();
  view.unmount();
  mount('/tech', { id: null });
  await screen.findByText('No services scheduled today');
  expect(screen.queryByRole('button', { name: /Fixture (one|two|other)/ })).not.toBeInTheDocument();
});

it('preserves access details after partial failure and clears a confirmed removal', async () => {
  mount();
  await screen.findByRole('button', { name: /Fixture two/ });
  toggleBrief();
  await screen.findByText('Use the side gate');
  briefStatus = 503;
  toggleBrief(); toggleBrief();
  await screen.findByRole('button', { name: 'Retry details' });
  expect(screen.getByText('Use the side gate')).toBeInTheDocument();
  briefStatus = 404;
  fireEvent.click(screen.getByRole('button', { name: 'Retry details' }));
  await waitFor(() => expect(screen.queryByText('Use the side gate')).not.toBeInTheDocument());
  expect(screen.queryByRole('button', { name: 'Retry details' })).not.toBeInTheDocument();
});

it('ignores an older detail response after a newer refresh confirms removal', async () => {
  mount();
  await screen.findByRole('button', { name: /Fixture two/ });
  toggleBrief();
  await screen.findByText('Use the side gate');
  const respond = fetchMock.getMockImplementation();
  let release;
  let delayNext = true;
  fetchMock.mockImplementation(async (path, options) => {
    if (delayNext && path.endsWith('/visit-brief')) {
      delayNext = false;
      return new Promise(resolve => { release = () => resolve({ ok: true, status: 200, json: async () => ({ facts: { access: { accessNotes: 'Stale gate code' } } }) }); });
    }
    return respond(path, options);
  });
  toggleBrief(); toggleBrief();
  await waitFor(() => expect(release).toBeTypeOf('function'));
  briefStatus = 404;
  toggleBrief(); toggleBrief();
  await waitFor(() => expect(screen.queryByText('Use the side gate')).not.toBeInTheDocument());
  await act(async () => { release(); });
  expect(screen.queryByText('Stale gate code')).not.toBeInTheDocument();
});

it.each([true, false])('keeps the newer schedule verdict when the newer request fails: %s', async newerFails => {
  mount();
  await screen.findByRole('button', { name: /Fixture two/ });
  const respond = fetchMock.getMockImplementation();
  const olderData = newerFails ? { services: rows.map(service => ({ ...service })) } : { error: 'Older route failure' };
  let release;
  let delayNext = true;
  fetchMock.mockImplementation(async (path, options) => {
    if (delayNext && path.includes('/admin/schedule?')) {
      delayNext = false;
      return new Promise(resolve => { release = () => resolve({ ok: newerFails, status: newerFails ? 200 : 503, json: async () => olderData }); });
    }
    return respond(path, options);
  });
  await act(async () => { mocks.socketEvent(); });
  await waitFor(() => expect(release).toBeTypeOf('function'));
  scheduleFails = newerFails;
  await act(async () => { mocks.socketEvent(); });
  const expectLatest = () => {
    if (newerFails) expect(screen.getByText('Route connection unavailable')).toBeInTheDocument();
    else expect(screen.queryByText('Older route failure')).not.toBeInTheDocument();
  };
  await waitFor(expectLatest);
  await act(async () => { release(); });
  expectLatest();
});
