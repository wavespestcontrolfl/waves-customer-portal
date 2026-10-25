// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import DocumentRecord from './DocumentRecord';
import { request } from './common';

vi.mock('./common', async () => ({ ...await vi.importActual('./common'), request: vi.fn() }));
beforeEach(() => vi.resetAllMocks());
afterEach(cleanup);

const fields = [
  { id: 'vehicle', label: 'Assigned vehicle', type: 'text', required: false },
  { id: 'home-address', label: 'Home address', type: 'text', required: false },
  { id: 'start-date', label: 'Start date', type: 'date', required: false },
  { id: 'agree', label: 'I agree', type: 'checkbox', required: true },
  { id: 'signed-name', label: 'Typed name', type: 'text', required: true },
];
const people = [{ id: 'me', name: 'Sample Admin', role: 'admin' }, { id: 'hire', name: 'Sample Hire', role: 'technician' }];
const detail = (extra = {}) => ({ document: { id: 'doc-1', staff_access: 'staff' }, version: { id: 'ver-1', content_hash: 'h' }, records: [],
  rendered: { kind: 'form', sections: [], metadata: { fields } }, ...extra });
const view = (props = {}) => render(<DocumentRecord detail={detail(props.detail)} people={people} selfId="me" manage canWrite onSaved={() => {}} />);
const prefillCalls = () => request.mock.calls.filter(([path]) => String(path).includes('/prefill'));
const FILLED = { answers: { vehicle: 'Truck 7', 'home-address': '1 Test Lane, Sampleton, FL', 'start-date': '2026-11-02' }, fields: ['vehicle', 'home-address', 'start-date'] };

test('a new record gets the prefilled values and the note', async () => {
  request.mockResolvedValue(FILLED);
  view({ detail: { prefill: true } });
  expect(await screen.findByDisplayValue('Truck 7')).toBeInTheDocument();
  expect(screen.getByDisplayValue('1 Test Lane, Sampleton, FL')).toBeInTheDocument();
  expect(screen.getByDisplayValue('2026-11-02')).toBeInTheDocument();
  expect(screen.getByText('Filled from the staff record: Assigned vehicle, Home address, Start date. Check each before you save.')).toBeInTheDocument();
  expect(request).toHaveBeenCalledWith('/versions/ver-1/prefill?owner_id=me', undefined, expect.anything());
  expect(screen.getByLabelText('Typed name *')).toHaveValue('');
});

test('a value the user typed is not overwritten, and the note leaves it out', async () => {
  let resolve;
  request.mockReturnValue(new Promise(r => { resolve = r; }));
  view({ detail: { prefill: true } });
  fireEvent.change(screen.getByLabelText('Assigned vehicle'), { target: { value: 'My own truck' } });
  resolve(FILLED);
  expect(await screen.findByDisplayValue('1 Test Lane, Sampleton, FL')).toBeInTheDocument();
  expect(screen.getByLabelText('Assigned vehicle')).toHaveValue('My own truck');
  expect(screen.getByText('Filled from the staff record: Home address, Start date. Check each before you save.')).toBeInTheDocument();
});

test('changing the owner replaces only values that still hold the earlier prefill', async () => {
  request.mockResolvedValueOnce(FILLED).mockResolvedValueOnce({ answers: { vehicle: 'Truck 9', 'home-address': '2 Test Lane, Sampleton, FL' }, fields: ['vehicle', 'home-address'] });
  view({ detail: { prefill: true } });
  await screen.findByDisplayValue('Truck 7');
  fireEvent.change(screen.getByLabelText('Home address'), { target: { value: 'Typed address' } });
  fireEvent.change(screen.getByLabelText('Record owner'), { target: { value: 'hire' } });
  expect(await screen.findByDisplayValue('Truck 9')).toBeInTheDocument();
  expect(request).toHaveBeenLastCalledWith('/versions/ver-1/prefill?owner_id=hire', undefined, expect.anything());
  expect(screen.getByLabelText('Home address')).toHaveValue('Typed address');
  await waitFor(() => expect(screen.getByLabelText('Start date')).toHaveValue(''));
});

test('gate off makes no prefill request and shows no note', async () => {
  view();
  await Promise.resolve();
  expect(prefillCalls()).toHaveLength(0);
  expect(screen.queryByText(/Filled from the staff record/)).not.toBeInTheDocument();
});

test('an existing record is never prefilled', async () => {
  const record = { id: 'rec-1', owner_id: 'me', answers: { vehicle: 'Saved truck' }, completed_steps: [], due_at: '2026-11-01T12:00:00Z', updated_at: '2026-10-30T12:00:00Z', created_at: '2026-10-30T12:00:00Z' };
  request.mockResolvedValue(FILLED);
  view({ detail: { prefill: true, records: [record] } });
  await waitFor(() => expect(prefillCalls()).toHaveLength(1));
  fireEvent.change(screen.getByLabelText('Saved records'), { target: { value: 'rec-1' } });
  await waitFor(() => expect(screen.getByDisplayValue('Saved truck')).toBeInTheDocument());
  expect(screen.queryByText(/Filled from the staff record/)).not.toBeInTheDocument();
  expect(prefillCalls()).toHaveLength(1);
});

test('a failed prefill leaves the form empty and shows no error', async () => {
  request.mockRejectedValue(new Error('boom'));
  view({ detail: { prefill: true } });
  await waitFor(() => expect(prefillCalls()).toHaveLength(1));
  expect(screen.getByLabelText('Assigned vehicle')).toHaveValue('');
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});
