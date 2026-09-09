// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import ServiceRecapModal from './ServiceRecapModal';

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
