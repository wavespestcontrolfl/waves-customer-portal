// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import ScheduleListView from './ScheduleListView';

const row = { id: 'qa-visit', customerName: 'Synthetic Alpha', status: 'confirmed', scheduledDate: new Date().toISOString().slice(0, 10) };
const response = (services = [row]) => ({ ok: true, json: async () => ({ services, total: services.length }) });
const failure = { ok: false, status: 503 };
let load;
beforeEach(() => {
  load = vi.fn(async () => response());
  vi.stubGlobal('fetch', load);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('distinguishes failed search from zero matches and retries the same filter', async () => {
  render(<ScheduleListView />);
  await screen.findByText('Synthetic Alpha');
  load.mockResolvedValueOnce(failure);
  fireEvent.change(screen.getByPlaceholderText('Name or service…'), { target: { value: 'Synthetic' } });
  await screen.findByRole('alert');
  expect(screen.queryByText('0 results')).not.toBeInTheDocument();
  expect(screen.queryByText('No appointments match your filters')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await screen.findByText('Synthetic Alpha');
  expect(String(load.mock.lastCall[0])).toContain('search=Synthetic');
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

it('keeps successful empty results distinct', async () => {
  load.mockResolvedValue(response([]));
  render(<ScheduleListView />);
  await screen.findByText('No appointments match your filters');
  expect(screen.getByText('0 results')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
});

it('ignores an obsolete failure after a newer search succeeds', async () => {
  render(<ScheduleListView />);
  await screen.findByText('Synthetic Alpha');
  let release;
  load.mockReturnValueOnce(new Promise(resolve => { release = resolve; }));
  fireEvent.change(screen.getByPlaceholderText('Name or service…'), { target: { value: 'old' } });
  fireEvent.change(screen.getByPlaceholderText('Name or service…'), { target: { value: 'Synthetic' } });
  await screen.findByText('Synthetic Alpha');
  await act(async () => { release(failure); });
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(screen.getByText('Synthetic Alpha')).toBeInTheDocument();
});

it('disables bulk Apply when a refresh fails, then recovers on retry', async () => {
  const view = render(<ScheduleListView />);
  await screen.findByText('Synthetic Alpha');
  fireEvent.click(screen.getAllByRole('checkbox')[1]);
  fireEvent.change(screen.getByDisplayValue('Choose action…'), { target: { value: 'cancel' } });
  load.mockResolvedValueOnce(failure);
  view.rerender(<ScheduleListView refreshKey={1} />);
  await screen.findByRole('alert');
  expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await screen.findByText('Synthetic Alpha');
  expect(screen.getByRole('button', { name: 'Apply' })).not.toBeDisabled();
});

it('still drops a saved row whose selection metadata cannot be verified', async () => {
  const view = render(<ScheduleListView />);
  await screen.findByText('Synthetic Alpha');
  fireEvent.click(screen.getAllByRole('checkbox')[1]);
  load.mockResolvedValueOnce(failure);
  view.rerender(<ScheduleListView refreshKey={1} lastSave={{ id: row.id }} />);
  await screen.findByRole('alert');
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await screen.findByText('Synthetic Alpha');
  expect(screen.getAllByRole('checkbox')[1]).not.toBeChecked();
});
