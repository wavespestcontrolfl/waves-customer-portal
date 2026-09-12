// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import VisitCloseoutSheet from './VisitCloseoutSheet';
import { adminFetch } from '../../utils/admin-fetch';
import { getCompletionDraft, getVisitCompletionDraft, putCompletionDraft } from '../../lib/completion-resume-store';

vi.mock('../../utils/admin-fetch', () => ({ adminFetch: vi.fn() }));
vi.mock('../../pages/admin/SchedulePage', () => ({
  createCompletionIdempotencyKey: (id) => `fixture_${id}`,
  completionReconcilePrompt: (error) => error.code === 'report_reconcile' ? 'Confirm recorded values' : null,
  CompletionPanel: ({ service, onPrepared }) => <button onClick={() => onPrepared(service.id, {
    visitOutcome: service.fixtureOutcome || (service.id === 'one' ? 'completed' : 'incomplete'),
    completionPhotos: [{ data: 'data:image/jpeg;base64,c3ludGhldGlj', capturedAt: '2020-01-01T12:00:00Z' }],
  }, { serviceId: service.id, notes: 'Saved fixture form' })}>Save fixture form</button>,
}));

const services = [
  { id: 'one', visitId: 'visit', requiresForm: true, serviceType: 'Pest Control' },
  { id: 'two', visitId: 'visit', requiresForm: true, serviceType: 'Lawn Care' },
];
let packet;
const scope = 'tech-a';
const mount = () => render(<VisitCloseoutSheet visitId="visit" products={[]} onClose={vi.fn()} onSaved={vi.fn()} />);
beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  localStorage.clear();
  localStorage.setItem('waves_admin_user', JSON.stringify({ id: scope, role: 'technician' }));
  packet = null;
  adminFetch.mockReset().mockImplementation(async (path) => {
    if (path.startsWith('/admin/schedule?')) return { services };
    return { visitId: 'visit', serviceDate: '2020-01-01', members: services, packet };
  });
});
afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); });

async function prepareBoth() {
  await screen.findAllByRole('button', { name: 'Open form' });
  fireEvent.click(screen.getAllByRole('button', { name: 'Open form' })[0]);
  fireEvent.click(screen.getByRole('button', { name: 'Save fixture form' }));
  await screen.findByText('1 of 2 forms ready. Saved forms and photos stay on this device until the visit is recorded.');
  fireEvent.click(screen.getByRole('button', { name: 'Open form' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save fixture form' }));
  await screen.findByText('2 of 2 forms ready. Saved forms and photos stay on this device until the visit is recorded.');
}

it('retained terminal members need no form and one live member can close the visit', async () => {
  adminFetch.mockImplementation(async (path, options) => {
    if (options?.method === 'POST') return { packetId: 'packet', state: 'done' };
    if (path.startsWith('/admin/schedule?')) return { services: [services[0]] };
    return { visitId: 'visit', serviceDate: '2020-01-01', packet, members: [
      { ...services[0], status: 'on_site' },
      { id: 'gone', serviceType: 'Lawn Care', status: 'cancelled', requiresForm: false },
      { id: 'done', serviceType: 'Mosquito', status: 'completed', requiresForm: false },
      { id: 'moved', serviceType: 'Irrigation', status: 'rescheduled', requiresForm: false },
    ] };
  });
  mount();
  fireEvent.click(await screen.findByRole('button', { name: 'Open form' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save fixture form' }));
  await screen.findByText('1 of 1 forms ready. Saved forms and photos stay on this device until the visit is recorded.');
  expect(screen.queryByText('Lawn Care')).not.toBeInTheDocument();
  expect(screen.queryByText('Mosquito')).not.toBeInTheDocument();
  expect(screen.queryByText('Irrigation')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Complete visit' }));
  await screen.findByText('Visit closeout is complete.');
  const [, options] = adminFetch.mock.calls.find(([, opts]) => opts?.method === 'POST');
  expect(JSON.parse(options.body).items.map((item) => item.serviceId)).toEqual(['one']);
});

it('requires a form for a completed status when the server has no canonical record', async () => {
  adminFetch.mockImplementation(async (path) => {
    if (path.startsWith('/admin/schedule?')) return { services };
    return { visitId: 'visit', serviceDate: '2020-01-01', packet: null,
      members: services.map((service) => ({ ...service, status: service.id === 'one' ? 'completed' : 'on_site' })) };
  });
  mount();
  expect(await screen.findAllByRole('button', { name: 'Open form' })).toHaveLength(2);
  expect(screen.getByRole('button', { name: 'Complete visit' })).toBeDisabled();
  await prepareBoth();
  expect(screen.getByRole('button', { name: 'Complete visit' })).toBeEnabled();
});

it('shows the canonical follow-up and customer-concern outcomes in the review rows', async () => {
  const outcomeServices = [
    { ...services[0], fixtureOutcome: 'follow_up_needed' },
    { ...services[1], fixtureOutcome: 'customer_concern' },
  ];
  adminFetch.mockImplementation(async (path) => path.startsWith('/admin/schedule?')
    ? { services: outcomeServices }
    : { visitId: 'visit', serviceDate: '2020-01-01', members: outcomeServices, packet: null });
  mount();
  await prepareBoth();
  expect(screen.getByText('Follow-up needed')).toBeInTheDocument();
  expect(screen.getByText('Customer concern')).toBeInTheDocument();
  expect(screen.queryByText('Form ready')).not.toBeInTheDocument();
});

it('requires every form and preserves the exact photo bodies and key across a reload', async () => {
  const view = mount();
  expect(await screen.findByRole('button', { name: 'Complete visit' })).toBeDisabled();
  await prepareBoth();
  const saved = await getVisitCompletionDraft('visit', scope);
  view.unmount();
  mount();
  expect(await screen.findByText('Incomplete — office follow-up')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Complete visit' })).toBeEnabled();
  const original = adminFetch.getMockImplementation();
  adminFetch.mockImplementation(async (path, options) => options?.method === 'POST'
    ? { packetId: 'packet', state: 'effects_pending' } : original(path));
  fireEvent.click(screen.getByRole('button', { name: 'Complete visit' }));
  await screen.findByRole('button', { name: 'Resume closeout' });
  const submitted = adminFetch.mock.calls.find(([, options]) => options?.method === 'POST');
  expect(submitted[0]).toBe('/admin/visit-closeouts/visit');
  expect(submitted[1].headers['Idempotency-Key']).toBe(saved.key);
  expect(JSON.parse(submitted[1].body).items).toEqual(services.map((service) => ({ serviceId: service.id, body: saved.forms[service.id].body })));
});

it('does not restore another signed-in operator\'s prepared visit forms', async () => {
  const first = mount();
  fireEvent.click((await screen.findAllByRole('button', { name: 'Open form' }))[0]);
  fireEvent.click(screen.getByRole('button', { name: 'Save fixture form' }));
  await screen.findByText('1 of 2 forms ready. Saved forms and photos stay on this device until the visit is recorded.');
  first.unmount();

  localStorage.setItem('waves_admin_user', JSON.stringify({ id: 'tech-b', role: 'technician' }));
  mount();
  await screen.findByText('0 of 2 forms ready. Saved forms and photos stay on this device until the visit is recorded.');
  expect(screen.getAllByRole('button', { name: 'Open form' })).toHaveLength(2);
  expect(await getVisitCompletionDraft('visit', scope)).not.toBeNull();
  expect(await getVisitCompletionDraft('visit', 'tech-b')).toBeNull();
});

it.each([true, false])('preserves member reconciliation confirmation (confirmed=%s)', async (confirmed) => {
  vi.spyOn(window, 'confirm').mockReturnValue(confirmed);
  mount();
  await prepareBoth();
  const saved = await getVisitCompletionDraft('visit', scope);
  const original = adminFetch.getMockImplementation();
  adminFetch.mockImplementation(async (path, options) => {
    if (options?.method !== 'POST') return original(path);
    const items = JSON.parse(options.body).items;
    if (!items[0].body.reportReconcileConfirmed) throw Object.assign(new Error('Report disagrees with recorded values'), {
      code: 'report_reconcile', details: { serviceId: 'one' },
    });
    expect(await getVisitCompletionDraft('visit', scope)).toMatchObject({ key: saved.key,
      forms: { one: { body: { ...saved.forms.one.body, reportReconcileConfirmed: true } }, two: saved.forms.two } });
    return { packetId: 'packet', state: 'effects_pending' };
  });
  fireEvent.click(screen.getByRole('button', { name: 'Complete visit' }));
  await waitFor(() => expect(window.confirm).toHaveBeenCalledWith('Confirm recorded values'));
  if (confirmed) await screen.findByRole('button', { name: 'Resume closeout' });
  else await waitFor(() => expect(screen.getByRole('button', { name: 'Complete visit' })).toBeEnabled());
  const posts = adminFetch.mock.calls.filter(([, options]) => options?.method === 'POST');
  expect(posts).toHaveLength(confirmed ? 2 : 1);
  expect(posts.every(([, options]) => options.headers['Idempotency-Key'] === saved.key)).toBe(true);
  if (!confirmed) expect(await getVisitCompletionDraft('visit', scope)).toEqual(saved);
});

it('clears photo drafts when reopening a packet already finished by the server', async () => {
  const view = mount();
  await prepareBoth();
  expect(await getVisitCompletionDraft('visit', scope)).not.toBeNull();
  view.unmount();
  packet = { id: 'packet', status: 'done' };
  mount();
  await screen.findByText('Visit closeout is complete.');
  await waitFor(async () => expect(await getVisitCompletionDraft('visit', scope)).toBeNull());
});

it.each(['done', 'office_required'])('clears late ordinary service drafts after a terminal %s closeout', async (state) => {
  mount();
  await prepareBoth();
  const original = adminFetch.getMockImplementation();
  adminFetch.mockImplementation(async (path, options) => options?.method === 'POST'
    ? { packetId: 'packet', state }
    : original(path));
  const lateUnmountWrite = putCompletionDraft('one', {
    serviceId: 'one', owner: scope, servicePhotos: [{ data: 'data:image/jpeg;base64,bGF0ZQ==' }],
  }, scope);
  await putCompletionDraft('two', { serviceId: 'two', owner: scope, notes: 'late form cleanup' }, scope);
  fireEvent.click(screen.getByRole('button', { name: 'Complete visit' }));
  await screen.findByText(state === 'done' ? 'Visit closeout is complete.' : /office has an alert/i);
  await lateUnmountWrite;
  await waitFor(async () => {
    expect(await getCompletionDraft('one', scope)).toBeNull();
    expect(await getCompletionDraft('two', scope)).toBeNull();
  });
});

it('refreshes authoritative services and filters prepared forms after membership rejection', async () => {
  const added = { id: 'three', visitId: 'visit', requiresForm: true, serviceType: 'Mosquito Control' };
  let currentServices = services;
  let currentMembers = services;
  let rejected = false;
  adminFetch.mockImplementation(async (path, options) => {
    if (options?.method === 'POST') {
      if (!rejected) {
        rejected = true;
        currentServices = [services[1], added];
        currentMembers = [services[1], added];
        throw Object.assign(new Error('Visit members changed'), { code: 'visit_members_changed' });
      }
      return { packetId: 'packet', state: 'effects_pending' };
    }
    if (path.startsWith('/admin/schedule?')) return { services: currentServices };
    return { visitId: 'visit', serviceDate: '2020-01-01', members: currentMembers, packet: null };
  });

  mount();
  await prepareBoth();
  fireEvent.click(screen.getByRole('button', { name: 'Complete visit' }));
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Review the refreshed services'));
  await screen.findByText('1 of 2 forms ready. Saved forms and photos stay on this device until the visit is recorded.');
  expect(screen.queryByText('Pest Control')).not.toBeInTheDocument();
  expect(screen.getByText('Mosquito Control')).toBeInTheDocument();
  expect((await getVisitCompletionDraft('visit', scope)).forms).toEqual({ two: expect.any(Object) });

  fireEvent.click(screen.getByRole('button', { name: 'Open form' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save fixture form' }));
  await screen.findByText('2 of 2 forms ready. Saved forms and photos stay on this device until the visit is recorded.');
  fireEvent.click(screen.getByRole('button', { name: 'Complete visit' }));
  await screen.findByRole('button', { name: 'Resume closeout' });
  const posts = adminFetch.mock.calls.filter(([, options]) => options?.method === 'POST');
  expect(JSON.parse(posts[1][1].body).items.map((item) => item.serviceId)).toEqual(['two', 'three']);
});

it('discovers a packet after a lost response and resumes the saved server closeout', async () => {
  mount();
  await prepareBoth();
  const original = adminFetch.getMockImplementation();
  adminFetch.mockImplementation(async (path, options) => {
    if (options?.method !== 'POST') return original(path);
    if (path.endsWith('/resume')) return { packetId: 'packet', state: 'done', payment: { state: 'paid' } };
    packet = { id: 'packet', status: 'processing' };
    throw new Error('Connection interrupted');
  });
  fireEvent.click(screen.getByRole('button', { name: 'Complete visit' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Resume closeout' }));
  expect(await screen.findByText('Visit closeout is complete.')).toBeInTheDocument();
  const posts = adminFetch.mock.calls.filter(([, options]) => options?.method === 'POST');
  expect(posts).toHaveLength(2);
  expect(posts[1][0]).toBe('/admin/visit-closeouts/visit/resume');
  expect(JSON.parse(posts[1][1].body)).toEqual({});
  await waitFor(async () => expect(await getVisitCompletionDraft('visit', scope)).toBeNull());
  expect(screen.queryByRole('button', { name: 'Complete visit' })).not.toBeInTheDocument();
});

it('uses the discovered terminal packet after losing a resume response', async () => {
  mount();
  await prepareBoth();
  const original = adminFetch.getMockImplementation();
  adminFetch.mockImplementation(async (path, options) => {
    if (options?.method !== 'POST') return original(path);
    if (path.endsWith('/resume')) {
      packet = { id: 'packet', status: 'done' };
      throw new Error('Connection interrupted');
    }
    packet = { id: 'packet', status: 'processing' };
    return { packetId: 'packet', state: 'effects_pending' };
  });
  fireEvent.click(screen.getByRole('button', { name: 'Complete visit' }));
  const resume = await screen.findByRole('button', { name: 'Resume closeout' });
  await waitFor(() => expect(resume).toBeEnabled());
  fireEvent.click(resume);
  expect(await screen.findByText('Visit closeout is complete.')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Resume closeout' })).not.toBeInTheDocument();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  await waitFor(async () => expect(await getVisitCompletionDraft('visit', scope)).toBeNull());
});

it('reopens a failed saved packet as an office exception without offering another retry', async () => {
  const view = mount();
  await prepareBoth();
  view.unmount();
  packet = { id: 'packet', status: 'failed', officeReview: true };
  mount();
  expect(await screen.findByText('Visit recorded. The office has an alert to review the service closeout, billing, or delivery.')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Resume closeout' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Complete visit' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Open form' })).not.toBeInTheDocument();
  await waitFor(async () => expect(await getVisitCompletionDraft('visit', scope)).toBeNull());
});

it('offers the server-authorized summary revoke action after completion', async () => {
  mount();
  await prepareBoth();
  const original = adminFetch.getMockImplementation();
  adminFetch.mockImplementation(async (path, options) => {
    if (options?.method !== 'POST') return original(path);
    if (path.endsWith('/revoke-summary')) return { revoked: true };
    return { packetId: 'packet', state: 'done', canRevokeSummary: true };
  });
  fireEvent.click(screen.getByRole('button', { name: 'Complete visit' }));
  const revoke = await screen.findByRole('button', { name: 'Revoke shared summary link' });
  // The successful submit still awaits IndexedDB cleanup. Real clicks wait
  // for the control to become enabled; fireEvent does not do that for us.
  await waitFor(() => expect(revoke).toBeEnabled());
  fireEvent.click(revoke);
  expect(await screen.findByText('The shared summary link has been revoked.')).toBeInTheDocument();
  expect(adminFetch).toHaveBeenCalledWith('/admin/visit-closeouts/visit/revoke-summary', { method: 'POST', body: '{}' });
});
