// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import StaleVisitsCard from './StaleVisitsCard';

afterEach(cleanup);
it('hides a confirmed empty backlog but shows its failed refresh and retries', () => {
  const onRetry = vi.fn();
  const { rerender } = render(<StaleVisitsCard data={{ visits: [] }} />);
  expect(screen.queryByText('Stale visits')).not.toBeInTheDocument();
  rerender(<StaleVisitsCard data={{ visits: [] }} error={new Error('offline')} onRetry={onRetry} />);
  expect(screen.getByRole('alert')).toHaveTextContent('could not be refreshed');
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  expect(onRetry).toHaveBeenCalledOnce();
});
it('keeps previously loaded visit links visible alongside the failure', () => {
  render(<MemoryRouter><StaleVisitsCard data={{ visits: [{ id: 'test', href: '/admin/dispatch', customer: { name: 'Fixture account' }, metadata: { daysOverdue: 2, status: 'pending' } }] }} error={new Error('offline')} /></MemoryRouter>);
  expect(screen.getByRole('link')).toHaveTextContent('Fixture account');
  expect(screen.getByRole('alert')).toHaveTextContent('Showing last loaded data');
});
it('distinguishes initial loading from failed initial load', () => {
  const { rerender } = render(<StaleVisitsCard data={null} pending />);
  expect(screen.getByText('Loading overdue visits…')).toBeInTheDocument();
  rerender(<StaleVisitsCard data={null} error={new Error('offline')} />);
  expect(screen.getByRole('alert')).toHaveTextContent('could not be loaded');
  expect(screen.queryByText('Loading overdue visits…')).not.toBeInTheDocument();
});

it('keeps an unrequested feed hidden until loading or failure is reported', () => {
  render(<StaleVisitsCard data={null} />);
  expect(screen.queryByText('Stale visits')).not.toBeInTheDocument();
});
