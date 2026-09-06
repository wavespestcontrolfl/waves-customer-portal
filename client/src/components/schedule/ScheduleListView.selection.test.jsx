// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import ScheduleListView from './ScheduleListView';

const rows = ['Alpha', 'Beta'].map((name, i) => ({id: `qa-${i}`, customerName: `Synthetic ${name}`, scheduledDate: '2026-09-09', status: 'confirmed'}));
const response = services => ({ok:true, json:async () => ({services,total:services.length})});
const header = () => screen.getByRole('checkbox', {name:'Select all visible appointments'});
const checkbox = name => within(screen.getByText(`Synthetic ${name}`).closest('tr')).getByRole('checkbox');
beforeEach(() => { vi.stubGlobal('fetch', vi.fn(async () => response(rows))); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('uses visible IDs after an equal-size disjoint filter and replaces selection with visible rows', async () => {
  fetch.mockResolvedValue(response([rows[0]]));
  render(<ScheduleListView />);
  await screen.findByText('Synthetic Alpha');
  fireEvent.click(checkbox('Alpha'));
  fetch.mockResolvedValue(response([rows[1]]));
  fireEvent.change(screen.getByPlaceholderText('Name or service…'), {target:{value:'Beta'}});
  await screen.findByText('Synthetic Beta');
  expect(header()).not.toBeChecked();
  expect(header()).not.toBePartiallyChecked();
  expect(checkbox('Beta')).not.toBeChecked();
  expect(screen.getByText('1 selected')).toBeInTheDocument();
  fireEvent.click(header());
  expect(checkbox('Beta')).toBeChecked();
  fetch.mockResolvedValue(response(rows));
  fireEvent.change(screen.getByPlaceholderText('Name or service…'), {target:{value:''}});
  await screen.findByText('Synthetic Alpha');
  expect(checkbox('Alpha')).not.toBeChecked();
  expect(checkbox('Beta')).toBeChecked();
  expect(header()).toBePartiallyChecked();
});

it('preserves row identity and partial selection when sorting, then selects and clears the visible set', async () => {
  render(<ScheduleListView />); await screen.findByText('Synthetic Alpha');
  fireEvent.click(checkbox('Beta'));
  fireEvent.click(screen.getByText('Customer'));
  expect(checkbox('Beta')).toBeChecked();
  expect(header()).toBePartiallyChecked();
  fireEvent.click(header());
  expect(header()).toBeChecked();
  expect(header()).not.toBePartiallyChecked();
  expect(screen.getByText('2 selected')).toBeInTheDocument();
  fireEvent.click(header());
  expect(checkbox('Alpha')).not.toBeChecked();
  expect(checkbox('Beta')).not.toBeChecked();
});

it('does not mark a disjoint next page selected and preserves individual cross-page selection', async () => {
  fetch.mockImplementation(async url => ({ok:true,json:async () => ({services:[rows[new URL(url,'http://test').searchParams.get('page') === '2' ? 1 : 0]], total:51})}));
  render(<ScheduleListView />); await screen.findByText('Synthetic Alpha');
  fireEvent.click(checkbox('Alpha'));
  fireEvent.click(screen.getByRole('button',{name:'Next'}));
  await screen.findByText('Synthetic Beta');
  expect(header()).not.toBeChecked();
  fireEvent.click(checkbox('Beta'));
  expect(header()).toBeChecked();
  expect(screen.getByText('2 selected')).toBeInTheDocument();
});

it.each([true,false])('disables selection for empty or failed results: empty=%s', async empty => {
  fetch.mockResolvedValue(empty ? response([]) : {ok:false,status:503});
  render(<ScheduleListView />);
  if(empty) await screen.findByText('No appointments match your filters');
  else await screen.findByRole('alert');
  expect(header()).toBeDisabled();
  expect(header()).not.toBeChecked();
});
