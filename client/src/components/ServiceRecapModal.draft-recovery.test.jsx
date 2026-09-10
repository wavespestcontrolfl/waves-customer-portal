// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import ServiceRecapModal from './ServiceRecapModal';
import { completionDraftKey } from '../lib/completion-drafts';

const product = { id: 1, name: 'Example gel', category: 'Insecticide', default_rate: '0.1', default_unit: 'g/spot' };
const context = { service: { id: 'visit-a', customerName: 'Avery Example', hasPhone: false }, products: [product], existingRecord: null, timeline: [] };
const noteInput = () => screen.getByPlaceholderText(/Quick internal note/);
const requestFor = () => vi.fn(async (path) => {
  if (path.endsWith('/context')) return structuredClone(context);
  if (path.endsWith('/draft')) throw new Error('Example AI unavailable.');
  return { ok: true };
});
afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); });

describe('recap interruption recovery', () => {
  it.each([
    ['serviceType', 'Mosquito Control'],
    ['customerId', 'customer-b'],
    ['scheduledDate', '2026-01-02'],
    ['propertyId', 'property-b'],
    ['catalogServiceId', 'catalog-b'],
    ['address', { line1: '200 Example Court', line2: null, city: 'Example City', state: 'FL', zip: '34201' }],
  ])('blocks stale treatment drafts after the live visit %s changes', async (field, value) => {
    const service = { ...context.service, serviceType: 'Pest Control', customerId: 'customer-a', scheduledDate: '2026-01-01', catalogServiceId: 'catalog-a',
      propertyId: 'property-a', address: { line1: '100 Example Court', line2: null, city: 'Example City', state: 'FL', zip: '34201' } };
    let current = { ...structuredClone(context), service };
    const request = vi.fn(async (path) => path.endsWith('/context') ? structuredClone(current) : { ok: true });
    const open = () => render(<ServiceRecapModal service={service} request={request} onClose={vi.fn()} />);
    const first = open();
    fireEvent.click(await screen.findByRole('button', { name: 'Example gel', exact: true }));
    fireEvent.change(noteInput(), { target: { value: 'Treatment for the original visit.' } });
    fireEvent.change(screen.getByLabelText('Application rate for Example gel'), { target: { value: '0.4' } });
    fireEvent.change(screen.getByPlaceholderText(/The recap your customer receives/), { target: { value: 'Original service recap.' } });
    first.unmount();

    current = { ...current, service: { ...service, [field]: value } };
    open();
    expect(await screen.findByRole('button', { name: 'Restore draft', exact: true })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Complete Service', exact: true })).toBeDisabled();
    expect(request.mock.calls.every(([, options]) => !options?.method)).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Discard draft', exact: true }));
    expect(noteInput()).toHaveValue('');
    expect(screen.getByPlaceholderText(/The recap your customer receives/)).toHaveValue('');
    fireEvent.click(screen.getByRole('button', { name: 'Complete Service', exact: true }));
    await waitFor(() => expect(request.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(true));
    const payload = JSON.parse(request.mock.calls.find(([, options]) => options?.method === 'POST')[1].body);
    expect(payload).toMatchObject({ technicianNotes: '', customerRecap: '', products: [], sendSms: false });
  });

  it.each(['completed elsewhere', 'record edited', 'record lookup failed', 'product lookup failed'])('blocks restoring a draft when %s', async (change) => {
    const currentProduct = { ...product, id: 2, name: 'Current product' };
    const initial = { ...structuredClone(context), products: [product, currentProduct] };
    if (change === 'record edited') initial.existingRecord = { id: 'record-a', status: 'completed', technician_notes: 'Initial record', products: [] };
    let current = initial;
    const request = vi.fn(async (path) => path.endsWith('/context') ? structuredClone(current) : { ok: true });
    const open = () => render(<ServiceRecapModal service={{ id: 'visit-a' }} request={request} onClose={vi.fn()} />);
    const first = open();
    fireEvent.click(await screen.findByRole('button', { name: 'Example gel', exact: true }));
    fireEvent.change(noteInput(), { target: { value: 'Stale local treatment' } });
    first.unmount();
    current = { ...initial, existingRecord: { id: 'record-a', status: 'completed', technician_notes: 'Current treatment', products: [{ product_id: 2, product_name: 'Current product', application_rate: 0.2, rate_unit: 'g/spot' }] } };
    if (change === 'record lookup failed') current = { ...initial, existingRecordLoadFailed: true };
    if (change === 'product lookup failed') current.existingRecord.productsLoadFailed = true;
    open();
    expect(await screen.findByRole('button', { name: 'Restore draft', exact: true })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Complete Service', exact: true })).toBeDisabled();
    if (!change.includes('failed')) {
      fireEvent.click(screen.getByRole('button', { name: 'Discard draft', exact: true }));
      expect(noteInput()).toHaveValue('Current treatment');
      fireEvent.click(screen.getByRole('button', { name: 'Complete Service', exact: true }));
      await waitFor(() => expect(request.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(true));
      const payload = JSON.parse(request.mock.calls.find(([, options]) => options?.method === 'POST')[1].body);
      expect(payload.products).toMatchObject([{ product_id: 2, application_rate: 0.2 }]);
    }
  });

  it('restores a draft after a normal lifecycle transition of the same visit', async () => {
    const service = { ...context.service, status: 'en_route', propertyId: 'property-a', customerId: 'customer-a' };
    let current = { ...structuredClone(context), service };
    const request = vi.fn(async (path) => path.endsWith('/context') ? structuredClone(current) : { ok: true });
    const open = () => render(<ServiceRecapModal service={service} request={request} onClose={vi.fn()} />);
    const first = open();
    await screen.findByRole('button', { name: 'Example gel', exact: true });
    fireEvent.change(noteInput(), { target: { value: 'Started before arrival.' } });
    first.unmount();

    current = { ...current, service: { ...service, status: 'on_site' } };
    open();
    const restore = await screen.findByRole('button', { name: 'Restore draft', exact: true });
    expect(restore).toBeEnabled();
    fireEvent.click(restore);
    expect(noteInput()).toHaveValue('Started before arrival.');
  });

  it('does not keep a phantom draft after a selected product is deselected again', async () => {
    const request = requestFor();
    const open = () => render(<ServiceRecapModal service={{ id: 'visit-a' }} request={request} onClose={vi.fn()} />);
    const first = open();
    const gel = await screen.findByRole('button', { name: 'Example gel', exact: true });
    fireEvent.click(gel);
    fireEvent.change(screen.getByLabelText('Application rate for Example gel'), { target: { value: '0.4' } });
    fireEvent.click(gel);
    await waitFor(() => expect(screen.queryByText(/Draft saved on this device/)).toBeNull());
    first.unmount();

    open();
    await screen.findByRole('button', { name: 'Example gel', exact: true });
    expect(screen.queryByRole('button', { name: 'Restore draft', exact: true })).toBeNull();
  });

  it('does not keep a phantom draft after a recorded product is deselected and reselected', async () => {
    const second = { ...product, id: 2, name: 'Second product' };
    const record = { id: 'record-a', status: 'completed', technician_notes: 'Recorded', products: [
      { product_id: 1, product_name: 'Example gel', application_rate: 0.1, rate_unit: 'g/spot' },
      { product_id: 2, product_name: 'Second product', application_rate: 0.1, rate_unit: 'g/spot' },
    ] };
    const request = vi.fn(async (path) => path.endsWith('/context') ? { ...structuredClone(context), products: [product, second], existingRecord: record } : { ok: true });
    const open = () => render(<ServiceRecapModal service={{ id: 'visit-a' }} request={request} onClose={vi.fn()} />);
    const first = open();
    const gelButton = () => screen.getByRole('button', { name: /Example gel$/ });
    await screen.findByRole('button', { name: '✓ Example gel', exact: true });
    fireEvent.click(gelButton());
    fireEvent.click(gelButton());
    expect(screen.getByRole('button', { name: '✓ Example gel', exact: true })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText(/Draft saved on this device/)).toBeNull());
    first.unmount();

    open();
    await screen.findByRole('button', { name: '✓ Example gel', exact: true });
    expect(screen.queryByRole('button', { name: 'Restore draft', exact: true })).toBeNull();
  });

  it('blocks a draft saved while a recorded product was missing from the catalog once it is representable again', async () => {
    const record = { id: 'record-a', status: 'completed', technician_notes: 'Recorded', products: [
      { product_id: 1, product_name: 'Example gel', application_rate: 0.1, rate_unit: 'g/spot' },
    ] };
    let current = { ...structuredClone(context), products: [], existingRecord: record };
    const request = vi.fn(async (path, options) => (path.endsWith('/context') ? structuredClone(current) : { ok: true, options }));
    const open = () => render(<ServiceRecapModal service={{ id: 'visit-a' }} request={request} onClose={vi.fn()} />);
    const first = open();
    await screen.findByDisplayValue('Recorded');
    fireEvent.change(noteInput(), { target: { value: 'Edited while the catalog was unavailable.' } });
    await screen.findByText(/Draft saved on this device/);
    first.unmount();

    current = { ...current, products: [product] };
    open();
    expect(await screen.findByRole('button', { name: 'Restore draft', exact: true })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Complete Service', exact: true })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Discard draft', exact: true }));
    expect(screen.getByRole('button', { name: '✓ Example gel', exact: true })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Complete Service', exact: true }));
    await waitFor(() => expect(request.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(true));
    const payload = JSON.parse(request.mock.calls.find(([, options]) => options?.method === 'POST')[1].body);
    expect(payload.products).toMatchObject([{ product_id: 1 }]);
  });

  it('sends the verified visit identity with the completion and explains a server ownership rejection', async () => {
    const service = { ...context.service, customerId: 'customer-a', propertyId: 'property-a', catalogServiceId: 'catalog-a',
      serviceType: 'Pest Control', scheduledDate: '2026-01-01', address: { line1: '100 Example Court', line2: null, city: 'Example City', state: 'FL', zip: '34201' } };
    const request = vi.fn(async (path, options) => {
      if (path.endsWith('/context')) return { ...structuredClone(context), service };
      if (options?.method === 'POST') throw new Error('visit_identity_changed');
      return { ok: true };
    });
    render(<ServiceRecapModal service={service} request={request} onClose={vi.fn()} />);
    await screen.findByRole('button', { name: 'Example gel', exact: true });
    fireEvent.change(noteInput(), { target: { value: 'Treatment.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Complete Service', exact: true }));
    expect(await screen.findByText(/This visit changed since it was opened/)).toBeInTheDocument();
    const payload = JSON.parse(request.mock.calls.find(([, options]) => options?.method === 'POST')[1].body);
    expect(payload.expectedVisit).toEqual({
      customerId: 'customer-a', propertyId: 'property-a', catalogServiceId: 'catalog-a', serviceType: 'Pest Control', scheduledDate: '2026-01-01',
      address: { line1: '100 Example Court', line2: null, city: 'Example City', state: 'FL', zip: '34201' },
    });
    expect(noteInput()).toHaveValue('Treatment.');
  });

  it('asserts only the identity keys the context reported and blocks that draft once newer keys arrive', async () => {
    const older = { ...context.service, customerId: 'customer-a', serviceType: 'Pest Control', scheduledDate: '2026-01-01' };
    const newer = { ...older, propertyId: 'property-b', catalogServiceId: 'catalog-a', address: { line1: '200 Example Court', line2: null, city: 'Example City', state: 'FL', zip: '34201' } };
    let current = older;
    const request = vi.fn(async (path, options) => {
      if (path.endsWith('/context')) return { ...structuredClone(context), service: structuredClone(current) };
      if (options?.method === 'POST') throw new Error('Example outage.');
      return { ok: true };
    });
    const open = () => render(<ServiceRecapModal service={{ id: 'visit-a' }} request={request} onClose={vi.fn()} />);
    const first = open();
    await screen.findByRole('button', { name: 'Example gel', exact: true });
    fireEvent.change(noteInput(), { target: { value: 'Treatment during the deploy.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Complete Service', exact: true }));
    await screen.findByText('Example outage.');
    const payload = JSON.parse(request.mock.calls.find(([, options]) => options?.method === 'POST')[1].body);
    expect(payload.expectedVisit).toEqual({ customerId: 'customer-a', serviceType: 'Pest Control', scheduledDate: '2026-01-01' });
    expect(Object.keys(payload.expectedVisit)).not.toContain('propertyId');
    first.unmount();

    // The draft never observed propertyId or address, so it cannot prove the
    // visit was not reassigned to property-b in the meantime: no restore.
    current = newer;
    open();
    expect(await screen.findByRole('button', { name: 'Restore draft', exact: true })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Complete Service', exact: true })).toBeDisabled();
    expect(screen.getByText(/Could not verify this draft/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Discard draft', exact: true }));
    expect(noteInput()).toHaveValue('');
  });

  it('re-checks a restored rate against the current label ceiling instead of the one saved with the draft', async () => {
    let band = '0.1-1';
    const request = vi.fn(async (path) => (path.endsWith('/context')
      ? { ...structuredClone(context), products: [{ ...product, default_rate: band }] }
      : { ok: true }));
    const open = () => render(<ServiceRecapModal service={{ id: 'visit-a' }} request={request} onClose={vi.fn()} />);
    const first = open();
    fireEvent.click(await screen.findByRole('button', { name: 'Example gel', exact: true }));
    fireEvent.change(screen.getByLabelText('Application rate for Example gel'), { target: { value: '0.4' } });
    expect(screen.queryByText(/label max/)).toBeNull();
    expect(JSON.parse(localStorage.getItem(completionDraftKey('visit-a', 'recap_local_local'))).rates).toEqual({ 1: { rate: '0.4', unit: 'g/spot' } });
    first.unmount();

    band = '0.1-0.3';
    open();
    fireEvent.click(await screen.findByRole('button', { name: 'Restore draft', exact: true }));
    expect(screen.getByLabelText('Application rate for Example gel')).toHaveValue(0.4);
    expect(screen.getByText(/label max 0\.3/)).toBeInTheDocument();
  });

  it('warns before unloading dirty edits that device storage could not save', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Storage unavailable'); });
    render(<ServiceRecapModal service={{ id: 'visit-a' }} request={requestFor()} onClose={vi.fn()} />);
    await screen.findByRole('button', { name: 'Example gel', exact: true });
    fireEvent.change(noteInput(), { target: { value: 'Unsaved treatment' } });
    await screen.findByText(/Draft could not be saved on this device/);
    const pending = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(pending);
    expect(pending.defaultPrevented).toBe(true);
    fireEvent.change(noteInput(), { target: { value: '' } });
    const clean = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(clean);
    expect(clean.defaultPrevented).toBe(false);
  });

  it('routes Escape through the guarded close while a completion is pending', async () => {
    let reject;
    const pending = new Promise((_, rejectRequest) => { reject = rejectRequest; });
    const close = vi.fn();
    const request = vi.fn((path) => path.endsWith('/context') ? Promise.resolve(structuredClone(context)) : pending);
    render(<ServiceRecapModal service={{ id: 'visit-a' }} request={request} onClose={close} />);
    await screen.findByRole('button', { name: 'Example gel', exact: true });
    fireEvent.change(noteInput(), { target: { value: 'Keep this while pending.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Complete Service', exact: true }));
    fireEvent.keyDown(document.activeElement || document.body, { key: 'Escape' });
    expect(close).not.toHaveBeenCalled();
    reject(new Error('Example completion failed.'));
    await screen.findByText('Example completion failed.');
    fireEvent.keyDown(document.activeElement || document.body, { key: 'Escape' });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('routes Escape through the unsaved-draft confirmation when device storage failed', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Storage unavailable'); });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const close = vi.fn();
    render(<ServiceRecapModal service={{ id: 'visit-a' }} request={requestFor()} onClose={close} />);
    await screen.findByRole('button', { name: 'Example gel', exact: true });
    fireEvent.change(noteInput(), { target: { value: 'Unsaved treatment' } });
    await screen.findByText(/Draft could not be saved on this device/);
    fireEvent.keyDown(document.activeElement || document.body, { key: 'Escape' });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(close).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    fireEvent.keyDown(document.activeElement || document.body, { key: 'Escape' });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('does not report an unverifiable draft as saved when the visit record failed to load', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const close = vi.fn();
    const request = vi.fn(async (path) => (path.endsWith('/context')
      ? { ...structuredClone(context), existingRecordLoadFailed: true }
      : { ok: true }));
    render(<ServiceRecapModal service={{ id: 'visit-a' }} request={request} onClose={close} />);
    await screen.findByRole('button', { name: 'Example gel', exact: true });
    fireEvent.change(noteInput(), { target: { value: 'Notes with no verifiable identity.' } });
    await screen.findByText(/Draft cannot be saved on this device/);
    expect(screen.queryByText(/Draft saved on this device/)).toBeNull();
    expect(localStorage.getItem(completionDraftKey('visit-a', 'recap_local_local'))).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Close', exact: true }));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(close).not.toHaveBeenCalled();
    fireEvent.change(noteInput(), { target: { value: '' } });
    await waitFor(() => expect(screen.queryByText(/Draft cannot be saved on this device/)).toBeNull());
  });

  it('restores the selected visit draft after close and reopen, including actual rates', async () => {
    const request = requestFor();
    const open = () => render(<ServiceRecapModal service={{ id: 'visit-a' }} request={request} onClose={vi.fn()} />);
    const first = open();
    fireEvent.click(await screen.findByRole('button', { name: 'Example gel', exact: true }));
    fireEvent.change(noteInput(), { target: { value: 'Internal notes for this visit only.' } });
    fireEvent.change(screen.getByLabelText('Application rate for Example gel'), { target: { value: '0.4' } });
    first.unmount();
    open();
    fireEvent.click(await screen.findByRole('button', { name: 'Restore draft', exact: true }));
    expect(noteInput()).toHaveValue('Internal notes for this visit only.');
    expect(screen.getByLabelText('Application rate for Example gel')).toHaveValue(0.4);
  });

  it('keeps the actual treatment and completes without requesting a customer send when AI is unavailable', async () => {
    const request = requestFor(), completed = vi.fn();
    render(<ServiceRecapModal service={{ id: 'visit-a' }} request={request} onClose={vi.fn()} onCompleted={completed} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Example gel', exact: true }));
    fireEvent.change(noteInput(), { target: { value: 'Recorded actual treatment manually.' } });
    fireEvent.change(screen.getByLabelText('Application rate for Example gel'), { target: { value: '0.4' } });
    fireEvent.click(screen.getByRole('button', { name: /Draft with AI/ }));
    expect(await screen.findByText('Example AI unavailable.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Complete Service', exact: true }));
    await waitFor(() => expect(completed).toHaveBeenCalledOnce());
    const submitted = request.mock.calls.find(([path, options]) => path.endsWith('/pest-recap') && options?.method === 'POST');
    expect(JSON.parse(submitted[1].body)).toMatchObject({ technicianNotes: 'Recorded actual treatment manually.', sendSms: false, products: [{ product_id: 1, application_rate: 0.4, rate_unit: 'g/spot' }] });
    expect(Object.keys(localStorage).filter((key) => key.includes('completion_draft'))).toEqual([]);
  });

  it('retains a failed completion draft and prevents duplicate submits or closing while pending', async () => {
    let reject;
    const pending = new Promise((_, rejectRequest) => { reject = rejectRequest; });
    const close = vi.fn();
    const request = vi.fn((path) => path.endsWith('/context') ? Promise.resolve(structuredClone(context)) : pending);
    render(<ServiceRecapModal service={{ id: 'visit-a' }} request={request} onClose={close} />);
    await screen.findByRole('button', { name: 'Example gel', exact: true });
    fireEvent.change(noteInput(), { target: { value: 'Keep this after failure.' } });
    const submit = screen.getByRole('button', { name: 'Complete Service', exact: true });
    fireEvent.click(submit);
    fireEvent.click(submit);
    fireEvent.click(screen.getByRole('button', { name: 'Close', exact: true }));
    expect(close).not.toHaveBeenCalled();
    expect(noteInput()).toBeDisabled();
    expect(request.mock.calls.filter(([path]) => !path.endsWith('/context'))).toHaveLength(1);
    reject(new Error('Example completion failed.'));
    await screen.findByText('Example completion failed.');
    expect(noteInput()).toHaveValue('Keep this after failure.');
    expect(localStorage.getItem('waves_completion_draft_visit-a_recap_local_local')).toContain('Keep this after failure.');
  });

  it('isolates drafts by visit and operator role, and removes a draft when edits return to the original state', async () => {
    const request = requestFor();
    const first = render(<ServiceRecapModal service={{ id: 'visit-a' }} request={request} onClose={vi.fn()} />);
    await screen.findByRole('button', { name: 'Example gel', exact: true });
    fireEvent.change(noteInput(), { target: { value: 'Private to this visit.' } });
    fireEvent.change(noteInput(), { target: { value: '' } });
    expect(localStorage.getItem('waves_completion_draft_visit-a_recap_local_local')).toBeNull();
    fireEvent.change(noteInput(), { target: { value: 'Private to this visit.' } });
    first.unmount();
    const otherVisit = render(<ServiceRecapModal service={{ id: 'visit-b' }} request={request} onClose={vi.fn()} />);
    await screen.findByRole('button', { name: 'Example gel', exact: true });
    expect(screen.queryByRole('button', { name: 'Restore draft' })).not.toBeInTheDocument();
    expect(noteInput()).toHaveValue('');
    otherVisit.unmount();
    localStorage.setItem('waves_admin_user', JSON.stringify({ id: 'another-operator', role: 'technician' }));
    render(<ServiceRecapModal service={{ id: 'visit-a' }} request={request} onClose={vi.fn()} />);
    await screen.findByRole('button', { name: 'Example gel', exact: true });
    expect(screen.queryByRole('button', { name: 'Restore draft' })).not.toBeInTheDocument();
    expect(noteInput()).toHaveValue('');
  });

  it('requires review when a restored product is no longer in the catalog', async () => {
    const initialRequest = vi.fn(async () => ({ ...structuredClone(context), products: [{ ...product, id: 99, name: 'Unavailable example' }] }));
    const first = render(<ServiceRecapModal service={{ id: 'visit-a' }} request={initialRequest} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Unavailable example', exact: true }));
    fireEvent.change(noteInput(), { target: { value: 'Review actual treatment.' } });
    first.unmount();
    render(<ServiceRecapModal service={{ id: 'visit-a' }} request={requestFor()} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Restore draft', exact: true }));
    expect(screen.getByRole('button', { name: 'Complete Service', exact: true })).toBeDisabled();
    expect(screen.getByText(/Unavailable product from draft: Unavailable example/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove Unavailable example', exact: true }));
    expect(screen.getByRole('button', { name: 'Complete Service', exact: true })).toBeEnabled();
    expect(noteInput()).toHaveValue('Review actual treatment.');
  });
});
