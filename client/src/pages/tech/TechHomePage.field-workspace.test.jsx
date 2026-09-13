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
let followThrough;

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
  followThrough = {};
  mocks.navigationBusy.mockClear();
  fetchMock = vi.fn(async (path, options = {}) => {
    let data = {};
    let status = 200;
    if (path.includes('/call-recordings/commitments/open')) data = followThrough;
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
  it('shows shared callback actions in the field workspace even when its route fails', async () => {
    scheduleFails = true;
    followThrough = { callbacks_enabled: true, commitments: [{ id: 'callback-fixture', kind: 'callback', party: 'waves', customer_first_name: 'Fixture',
      description: 'Call about service access', effective_due_at: '2099-01-01T17:00:00Z', overdue: false, updated_at: '2099-01-01T15:00:00Z' }] };
    mount();
    expect(await screen.findByText('Call about service access')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Done', exact: true })).toBeInTheDocument();
    expect(await screen.findByText('Route connection unavailable')).toBeInTheDocument();
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

  it.each([
    ['confirmed', 'en_route', null, null, 'en-route'],
    ['en_route', 'confirmed', null, null, 'en-route'],
    ['en_route', 'on_site', null, null, 'on-site'],
    ['on_site', 'en_route', null, null, 'on-site'],
    ['en_route', 'en_route', 'en_route', 'pending', 'en-route'],
    ['en_route', 'en_route', 'pending', 'en_route', 'en-route'],
  ])('reconciles mixed stop %s/%s with tracks %s/%s through %s', async (first, second, firstTrack, secondTrack, endpoint) => {
    rows = [row('one', { visit: { id: 'group' }, status: first, trackState: firstTrack }), row('two', { visit: { id: 'group' }, status: second, trackState: secondTrack })];
    mount('/tech?visit=visit%3Agroup');
    await screen.findByText('Property brief for one');
    expect(screen.queryByRole('button', { name: 'En route', exact: true })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'On site', exact: true })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Sync stop' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(`/api/tech/services/one/${endpoint}`, expect.objectContaining({ method: 'POST' })));
    expect(fetchMock.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1);
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

  it.each([
    [false, false],
    [true, true],
  ])('Tools exposes completed combined closeout only when has_service_record is %s (disabled=%s)', async (hasRecord, disabled) => {
    rows = [row('one', { status: 'completed', visit: { id: 'group' }, visitId: 'group',
      visitCloseoutEnabled: true, has_service_record: hasRecord })];
    await act(async () => { mount('/tech/tools?visit=visit%3Agroup'); });
    const report = await screen.findByRole('button', { name: /Project Report/ });
    if (disabled) expect(report).toBeDisabled();
    else expect(report).toBeEnabled();
  });

  it.each([undefined, 'sent', 'closed'])('Tools keeps a saved processing packet available with linked report status %s', async (status) => {
    rows = [row('one', { status: 'completed', visit: { id: 'group' }, visitId: 'group',
      visitCloseoutEnabled: true, has_service_record: true,
      visitCloseoutPacket: { id: 'packet-one', status: 'processing' },
      linkedProject: status ? { id: 'existing-report', status } : null })];
    await act(async () => { mount('/tech/tools?visit=visit%3Agroup'); });
    expect(await screen.findByRole('button', { name: /Project Report/ })).toBeEnabled();
  });

  it.each(['sent', 'closed'])('Tools keeps recordless combined closeout available with a %s linked report', async (status) => {
    rows = [row('one', { status: 'completed', visit: { id: 'group' }, visitId: 'group',
      visitCloseoutEnabled: true, has_service_record: false,
      linkedProject: { id: 'existing-report', status } })];
    await act(async () => { mount('/tech/tools?visit=visit%3Agroup'); });
    expect(await screen.findByRole('button', { name: /Project Report/ })).toBeEnabled();
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
