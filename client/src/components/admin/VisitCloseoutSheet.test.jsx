// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import VisitCloseoutSheet from './VisitCloseoutSheet';
import { adminFetch } from '../../utils/admin-fetch';
import { getCompletionResumeBody } from '../../lib/completion-resume-store';

vi.mock('../../utils/admin-fetch', () => ({ adminFetch: vi.fn() }));
vi.mock('../../pages/admin/SchedulePage', () => ({
  CompletionPanel: ({ service, onPrepared }) => <button onClick={() => onPrepared(service.id, {
    visitOutcome: service.id === 'one' ? 'completed' : 'incomplete',
    completionPhotos: [{ data: 'data:image/jpeg;base64,c3ludGhldGlj', capturedAt: '2020-01-01T12:00:00Z' }],
  }, { serviceId: service.id, notes: 'Saved fixture form' })}>Save fixture form</button>,
}));

const services = [
  { id: 'one', visitId: 'visit', serviceType: 'Pest Control' },
  { id: 'two', visitId: 'visit', serviceType: 'Lawn Care' },
];
let packet;
const mount = () => render(<VisitCloseoutSheet visitId="visit" products={[]} onClose={vi.fn()} onSaved={vi.fn()} />);
beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  packet = null;
  adminFetch.mockReset().mockImplementation(async (path) => {
    if (path.startsWith('/admin/schedule?')) return { services };
    return { visitId: 'visit', serviceDate: '2020-01-01', members: services, packet };
  });
});
afterEach(cleanup);

async function prepareBoth() {
  await screen.findAllByRole('button', { name: 'Open form' });
  fireEvent.click(screen.getAllByRole('button', { name: 'Open form' })[0]);
  fireEvent.click(screen.getByRole('button', { name: 'Save fixture form' }));
  await screen.findByText('1 of 2 forms ready. Saved forms and photos stay on this device until the visit is recorded.');
  fireEvent.click(screen.getByRole('button', { name: 'Open form' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save fixture form' }));
  await screen.findByText('2 of 2 forms ready. Saved forms and photos stay on this device until the visit is recorded.');
}

it('requires every form and preserves the exact photo bodies and key across a reload', async () => {
  const view = mount();
  expect(await screen.findByRole('button', { name: 'Complete visit' })).toBeDisabled();
  await prepareBoth();
  const saved = await getCompletionResumeBody('visit:visit');
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
  await waitFor(async () => expect(await getCompletionResumeBody('visit:visit')).toBeNull());
  expect(screen.queryByRole('button', { name: 'Complete visit' })).not.toBeInTheDocument();
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
