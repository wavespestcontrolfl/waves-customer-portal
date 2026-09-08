// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

function mount(path = '/tech', { enabled = true, role = 'technician' } = {}) {
  localStorage.setItem('waves_admin_token', 'fixture-only');
  localStorage.setItem('waves_admin_user', JSON.stringify({ id: 'tech-fixture', name: 'Fixture Technician', role }));
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

describe('Tech field workspace uses the existing route workflow', () => {
  it('filters assignments and counts combined stops without treating skipped work as completed', async () => {
    rows = [row('one', { visit: { id: 'group' }, status: 'completed' }), row('two', { visit: { id: 'group' }, status: 'skipped' }), row('three'), row('other', { technicianId: 'other-tech' })];
    mount();
    expect(await screen.findByText('0 of 2 stops complete')).toBeInTheDocument();
    expect(screen.getByText('3 services')).toBeInTheDocument();
    expect(screen.queryByText('Fixture other')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Open visit/ })).toBeEnabled();
  });

  it('opens a selected stop and sends arrival and photos to that service, even when it is not first', async () => {
    mount('/tech?visit=row%3Atwo');
    expect(await screen.findByText('Property brief for two')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'On site' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/tech/services/two/on-site', expect.objectContaining({ method: 'POST' })));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'On site' })).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Service photos' }));
    expect(screen.getByText('Photos for two')).toBeInTheDocument();
  });

  it('brings the active visit ahead of an earlier pending stop', async () => {
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Open visit' }));
    expect(await screen.findByText('Property brief for two')).toBeInTheDocument();
  });

  it('does not offer arrival or moving actions for a terminal visit', async () => {
    rows = [row('one', { status: 'completed' })];
    mount('/tech?visit=row%3Aone');
    await screen.findByText('Property brief for one');
    expect(screen.queryByRole('button', { name: 'En route' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Quick Move' })).not.toBeInTheDocument();
  });

  it('does not resolve a pasted URL for another technician or fetch its property detail', async () => {
    mount('/tech?visit=row%3Aother');
    expect(await screen.findByRole('heading', { name: 'Visit unavailable' })).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([path]) => path.includes('/other/'))).toBe(false);
    expect(screen.queryByText('Fixture other')).not.toBeInTheDocument();
  });

  it('removes the selected brief when a live update reassigns the visit', async () => {
    mount('/tech?visit=row%3Atwo');
    await screen.findByText('Property brief for two');
    rows = rows.map((service) => ({ ...service, technicianId: 'other-tech' }));
    await act(async () => { mocks.socketEvent(); });
    expect(await screen.findByRole('heading', { name: 'Visit unavailable' })).toBeInTheDocument();
    expect(screen.queryByText('Property brief for two')).not.toBeInTheDocument();
  });

  it('retains prior access details after a partial background failure and clears a confirmed removal on retry', async () => {
    mount('/tech?visit=row%3Atwo');
    await screen.findByText('Use the side gate');
    briefStatus = 503;
    rows = rows.map(service => ({ ...service }));
    await act(async () => { mocks.socketEvent(); });
    await screen.findByRole('button', { name: 'Retry details' });
    expect(screen.getByText('Use the side gate')).toBeInTheDocument();
    briefStatus = 404;
    fireEvent.click(screen.getByRole('button', { name: 'Retry details' }));
    await waitFor(() => expect(screen.queryByText('Use the side gate')).not.toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Retry details' })).not.toBeInTheDocument();
  });

  it('ignores an older detail response after a newer refresh confirms removal', async () => {
    mount('/tech?visit=row%3Atwo');
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
    rows = rows.map(service => ({ ...service }));
    await act(async () => { mocks.socketEvent(); });
    await waitFor(() => expect(release).toBeTypeOf('function'));
    briefStatus = 404;
    rows = rows.map(service => ({ ...service }));
    await act(async () => { mocks.socketEvent(); });
    await waitFor(() => expect(screen.queryByText('Use the side gate')).not.toBeInTheDocument());
    await act(async () => { release(); });
    expect(screen.queryByText('Stale gate code')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry details' })).not.toBeInTheDocument();
  });

  it('keeps the group URL selected when its first member becomes terminal', async () => {
    rows = [row('one', { visit: { id: 'group' } }), row('two', { visit: { id: 'group' } })];
    mount('/tech?visit=visit%3Agroup');
    await screen.findByText('Property brief for one');
    rows = rows.map((service) => service.id === 'one' ? { ...service, status: 'completed' } : service);
    await act(async () => { mocks.socketEvent(); });
    expect(await screen.findByText('Property brief for two')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Visit unavailable' })).not.toBeInTheDocument();
    expect(screen.getByText('mixed')).toBeInTheDocument();
  });

  it('blocks stale actions during route failure and restores them after retry', async () => {
    mount('/tech?visit=row%3Atwo');
    await screen.findByText('Property brief for two');
    scheduleFails = true;
    await act(async () => { mocks.socketEvent(); });
    expect(await screen.findByText('Route connection unavailable')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'On site' })).not.toBeInTheDocument();
    scheduleFails = false;
    fireEvent.click(screen.getByRole('button', { name: 'Retry route' }));
    expect(await screen.findByRole('button', { name: 'On site' })).toBeEnabled();
  });

  it.each([true, false])('keeps the latest schedule verdict when the newer request fails: %s', async (newerFails) => {
    mount('/tech?visit=row%3Atwo');
    await screen.findByText('Property brief for two');
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
      if (newerFails) {
        expect(screen.getByText('Route connection unavailable')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'On site' })).not.toBeInTheDocument();
      } else {
        expect(screen.getByRole('button', { name: 'On site' })).toBeEnabled();
        expect(screen.queryByText('Older route failure')).not.toBeInTheDocument();
      }
    };
    await waitFor(expectLatest);
    await act(async () => { release(); });
    expectLatest();
  });

  it('does not present an unavailable route as zero assigned stops', async () => {
    scheduleFails = true;
    mount();
    await screen.findByText('Route connection unavailable');
    expect(screen.queryByText(/stops complete/)).not.toBeInTheDocument();
    expect(screen.queryByText('No stops scheduled today')).not.toBeInTheDocument();
  });

  it('preserves the contact-action navigation lock', async () => {
    mount('/tech?visit=row%3Atwo');
    await screen.findByText('Property brief for two');
    fireEvent.click(screen.getByRole('button', { name: 'Start contact action' }));
    expect(mocks.navigationBusy).toHaveBeenLastCalledWith(true);
    expect(screen.getByRole('button', { name: 'Today' })).toBeDisabled();
  });

  it('keeps Project Report disabled when the selected visit is missing despite another live service', async () => {
    rows = [row('one')];
    await act(async () => { mount('/tech/tools?visit=row%3Amissing'); });
    await screen.findByRole('heading', { name: 'Tools' });
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.getByRole('button', { name: /Project Report/ })).toBeDisabled();
    expect(screen.queryByText('Existing recap form')).not.toBeInTheDocument();
  });

  it.each(['sent', 'closed', 'draft'])('Tools only offers editable linked reports (%s)', async status => {
    rows = [row('one', { linkedProject: { id: 'existing-report', status } })];
    await act(async () => { mount('/tech/tools'); });
    const report = await screen.findByRole('button', { name: /Project Report/ });
    if (status === 'draft') expect(report).toBeEnabled();
    else expect(report).toBeDisabled();
  });

  it('preserves owner-only estimating and the social feature gate in Tools', async () => {
    mount('/tech/tools');
    expect(await screen.findByRole('heading', { name: 'Tools' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Protocols & SOPs/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Field Estimator/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Social Post/ })).not.toBeInTheDocument();
    expect(screen.queryByText('Messages')).not.toBeInTheDocument();
  });

  it('keeps the legacy route when the workspace flag is off', async () => {
    mount('/tech/tools', { enabled: false });
    expect(await screen.findByRole('heading', { name: 'Quick Actions' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Tools' })).not.toBeInTheDocument();
  });
});
