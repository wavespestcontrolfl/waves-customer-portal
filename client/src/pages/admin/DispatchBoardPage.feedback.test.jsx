// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const board = vi.hoisted(() => ({ refresh: vi.fn() }));

vi.mock('../../hooks/useDispatchBoard', () => ({
  useDispatchBoard: () => {
    const [error, setError] = React.useState('HTTP 503');
    const refreshTechs = React.useCallback(async () => {
      await board.refresh();
      setError(null);
    }, []);
    return {
      techs: [],
      jobs: [],
      jobsById: new Map(),
      selectedTechId: null,
      setSelectedTechId: vi.fn(),
      selectedJobId: null,
      setSelectedJobId: vi.fn(),
      loading: false,
      error,
      refreshTechs,
    };
  },
}));
vi.mock('../../components/dispatch/DispatchBoardLayout', () => ({
  default: () => <div>Dispatch board recovered</div>,
}));
vi.mock('../../components/dispatch/TechRosterPane', () => ({ default: () => null }));
vi.mock('../../components/dispatch/DispatchMap', () => ({ default: () => null }));
vi.mock('../../components/dispatch/ActionQueuePane', () => ({ default: () => null }));
vi.mock('../../components/dispatch/JobDrawer', () => ({ default: () => null }));
vi.mock('../../components/dispatch/TechDrawer', () => ({ default: () => null }));

import DispatchBoardPage from './DispatchBoardPage';

beforeEach(() => {
  board.refresh.mockReset();
  window.history.replaceState({}, '', '/admin/dispatch?tab=board');
});
afterEach(() => cleanup());

it('retries a failed board load only when feedback=1 and disables retry while pending', async () => {
  let finishRetry;
  board.refresh.mockReturnValue(new Promise((resolve) => { finishRetry = resolve; }));
  window.history.replaceState({}, '', '/admin/dispatch?tab=board&feedback=1');
  render(<DispatchBoardPage />);

  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  expect(board.refresh).toHaveBeenCalledTimes(1);
  expect(screen.getByText('Retrying dispatch board…')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();

  await act(async () => finishRetry());
  expect(await screen.findByText('Dispatch board recovered')).toBeInTheDocument();
});

it.each([
  '/admin/dispatch?tab=board',
  '/admin/dispatch?tab=board&feedback=0',
])('preserves the static board error without the exact feedback gate: %s', (url) => {
  window.history.replaceState({}, '', url);
  render(<DispatchBoardPage />);

  expect(screen.getByText('Failed to load dispatch board: HTTP 503')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
});
