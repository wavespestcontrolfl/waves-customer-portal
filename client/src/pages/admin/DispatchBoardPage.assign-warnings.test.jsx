// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen, fireEvent } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The page's own handler is under test; the board hook and the panes are stubs.
vi.mock('../../hooks/useDispatchBoard', () => ({
  useDispatchBoard: () => ({
    techs: [], jobs: [], jobsById: new Map(), selectedTechId: null, setSelectedTechId: vi.fn(),
    selectedJobId: 'job-1', setSelectedJobId: vi.fn(), loading: false, error: null, refreshTechs: vi.fn(),
  }),
}));
vi.mock('../../components/dispatch/DispatchBoardLayout', () => ({
  default: ({ left, center, right }) => <div>{left}{center}{right}</div>,
}));
vi.mock('../../components/dispatch/TechRosterPane', () => ({ default: () => null }));
vi.mock('../../components/dispatch/ActionQueuePane', () => ({ default: () => null }));
vi.mock('../../components/dispatch/JobDrawer', () => ({ default: () => null }));
vi.mock('../../components/dispatch/TechDrawer', () => ({ default: () => null }));
let drop;
let dragStart;
vi.mock('../../components/dispatch/DispatchMap', () => ({
  default: ({ onJobDropOnTech, onJobDragStart }) => { drop = onJobDropOnTech; dragStart = onJobDragStart; return null; },
}));

import DispatchBoardPage from './DispatchBoardPage';

function mockPut(response) {
  global.fetch = vi.fn(async () => response);
}

beforeEach(() => { localStorage.setItem('waves_admin_token', 'test-token'); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

// GATE_TECH_WORK_DAYS: a drag-reassign onto a day the tech does not work is saved
// and the answer carries the warning; the board must show it.
describe('DispatchBoardPage drag-reassign warnings', () => {
  it('shows the saved assignment\'s warning line, and a new drag clears it', async () => {
    mockPut({ ok: true, json: async () => ({ job: { id: 'job-1' }, warnings: ['Tech One does not work on Fridays.'] }) });
    render(<DispatchBoardPage />);
    await act(async () => { await drop('job-1', 't1'); });
    const note = await screen.findByText('Tech One does not work on Fridays.');
    expect(note).toBeInTheDocument();
    expect(screen.queryByText(/Reassignment failed/)).not.toBeInTheDocument();
    fireEvent.click(note);
    expect(screen.queryByText('Tech One does not work on Fridays.')).not.toBeInTheDocument();

    await act(async () => { await drop('job-1', 't1'); });
    await screen.findByText('Tech One does not work on Fridays.');
    act(() => dragStart('job-2'));
    expect(screen.queryByText('Tech One does not work on Fridays.')).not.toBeInTheDocument();
  });

  it('shows nothing extra when the answer has no warnings or cannot be read', async () => {
    mockPut({ ok: true, json: async () => ({ job: { id: 'job-1' } }) });
    render(<DispatchBoardPage />);
    await act(async () => { await drop('job-1', 't1'); });
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    mockPut({ ok: true, json: async () => { throw new Error('empty'); } });
    await act(async () => { await drop('job-1', 't1'); });
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('a refused reassignment shows the error banner and no warning', async () => {
    mockPut({ ok: false, status: 422, json: async () => ({ error: 'Tech One is marked out' }) });
    render(<DispatchBoardPage />);
    await act(async () => { await drop('job-1', 't1'); });
    expect(await screen.findByRole('alert')).toHaveTextContent('Reassignment failed: Tech One is marked out');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});
