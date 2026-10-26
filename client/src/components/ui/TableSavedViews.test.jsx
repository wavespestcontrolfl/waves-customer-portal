// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { TableSavedViews } from './TableSavedViews';
import { UiSurface } from './UiSurface';

afterEach(cleanup);
const controllerFor = (overrides = {}) => ({
  available: true, catalogLoading: false, views: [{ id: 'open', name: 'Open projects', state: {} }], error: null,
  refreshViews: vi.fn(async () => true), saveView: vi.fn(async () => true), applyView: vi.fn(async () => ({})), removeView: vi.fn(async () => true),
  ...overrides,
});
const example = (controller, onApply) => <UiSurface density="comfortable"><TableSavedViews label="Bids" controller={controller} onApply={onApply} /></UiSurface>;

it('saves a named view through a labeled form and returns keyboard focus', async () => {
  const controller = controllerFor();
  render(example(controller));
  const trigger = screen.getByRole('button', { name: 'Bids saved views' });
  fireEvent.click(trigger);
  expect(controller.refreshViews).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('button', { name: 'Save current view' })).toBeDisabled();
  fireEvent.change(screen.getByRole('textbox', { name: 'View name' }), { target: { value: 'Upcoming projects' } });
  fireEvent.submit(screen.getByRole('textbox', { name: 'View name' }).closest('form'));
  expect(controller.saveView).toHaveBeenCalledWith('Upcoming projects');
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(trigger).toHaveFocus();
  expect(screen.getByRole('status')).toHaveTextContent('View saved.');
});

it('separates choosing, applying, and deleting a view and permits a caller URL update', async () => {
  const controller = controllerFor();
  const apply = vi.fn(async () => ({}));
  render(example(controller, apply));
  const trigger = screen.getByRole('button', { name: 'Bids saved views' });
  fireEvent.click(trigger);
  expect(screen.getByRole('button', { name: 'Use view' })).toBeDisabled();
  fireEvent.change(screen.getByRole('combobox', { name: 'Bids saved view' }), { target: { value: 'open' } });
  expect(apply).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Use view' }));
  expect(apply).toHaveBeenCalledWith('open');
  expect(controller.applyView).not.toHaveBeenCalled();
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  fireEvent.click(trigger);
  fireEvent.change(screen.getByRole('combobox', { name: 'Bids saved view' }), { target: { value: 'open' } });
  fireEvent.click(screen.getByRole('button', { name: 'Delete view' }));
  expect(controller.removeView).toHaveBeenCalledWith('open');
  expect(screen.getByRole('dialog')).toBeInTheDocument();
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('View deleted.'));
});

it('shows catalog loading and waits for apply before allowing another action', async () => {
  let finishApply;
  const apply = vi.fn(() => new Promise((resolve) => { finishApply = resolve; }));
  const controller = controllerFor({ catalogLoading: true });
  const { rerender } = render(example(controller, apply));
  fireEvent.click(screen.getByRole('button', { name: 'Bids saved views' }));
  expect(screen.getByRole('status')).toHaveTextContent('Loading saved views…');
  expect(screen.getByRole('button', { name: 'Save current view' })).toBeDisabled();

  rerender(example({ ...controller, catalogLoading: false }, apply));
  fireEvent.change(screen.getByRole('combobox', { name: 'Bids saved view' }), { target: { value: 'open' } });
  fireEvent.click(screen.getByRole('button', { name: 'Use view' }));
  expect(apply).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('button', { name: 'Use view' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Delete view' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Done' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Use view' }));
  expect(apply).toHaveBeenCalledTimes(1);

  await act(async () => { finishApply({}); });
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(screen.getByRole('status')).toHaveTextContent('View “Open projects” applied.');
});

it('unlocks the dialog without claiming success when a custom apply rejects', async () => {
  const apply = vi.fn(async () => { throw new Error('URL update failed'); });
  render(example(controllerFor(), apply));
  fireEvent.click(screen.getByRole('button', { name: 'Bids saved views' }));
  fireEvent.change(screen.getByRole('combobox', { name: 'Bids saved view' }), { target: { value: 'open' } });
  fireEvent.click(screen.getByRole('button', { name: 'Use view' }));

  await waitFor(() => expect(screen.getByRole('button', { name: 'Done' })).toBeEnabled());
  expect(screen.getByRole('dialog')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Use view' })).toBeEnabled();
  expect(screen.getByRole('alert')).toHaveTextContent('The view could not be applied. Try again.');
  expect(screen.queryByText('View “Open projects” applied.')).not.toBeInTheDocument();
});

it('keeps a failed save open, exposes its error, and closes on Escape without claiming success', async () => {
  const controller = controllerFor({ saveView: vi.fn(async () => false) });
  const { rerender } = render(example(controller));
  const trigger = screen.getByRole('button', { name: 'Bids saved views' });
  fireEvent.click(trigger);
  fireEvent.change(screen.getByRole('textbox', { name: 'View name' }), { target: { value: 'My projects' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save current view' }));
  rerender(example({ ...controller, error: 'Changes could not be saved in this browser.' }));
  expect(screen.getByRole('dialog')).toBeInTheDocument();
  expect(screen.getByRole('alert')).toHaveTextContent('Changes could not be saved');
  expect(screen.queryByText('View saved.')).not.toBeInTheDocument();
  await waitFor(() => expect(screen.getByRole('button', { name: 'Done' })).toBeEnabled());
  fireEvent.keyDown(document, { key: 'Escape' });
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(trigger).toHaveFocus();
});

it('disables dialog actions while a mutation is pending and retains a delayed failure', async () => {
  let finishSave;
  const controller = controllerFor({
    saveView: vi.fn(() => new Promise((resolve) => { finishSave = resolve; })),
  });
  const { rerender } = render(example(controller));
  fireEvent.click(screen.getByRole('button', { name: 'Bids saved views' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'View name' }), { target: { value: 'Waiting view' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save current view' }));
  expect(screen.getByRole('button', { name: 'Bids saved views' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Save current view' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Delete view' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Done' })).toBeDisabled();
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.getByRole('dialog')).toBeInTheDocument();

  await act(async () => { finishSave(false); });
  rerender(example({ ...controller, error: 'Changes could not be saved in this browser.' }));
  expect(screen.getByRole('dialog')).toBeInTheDocument();
  expect(screen.getByRole('alert')).toHaveTextContent('Changes could not be saved');
  expect(screen.getByRole('button', { name: 'Save current view' })).toBeEnabled();
});
