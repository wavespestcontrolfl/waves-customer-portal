// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import JobDrawer from './JobDrawer';

vi.mock('./VisualNotesReviewSection', () => ({ default: () => null }));
vi.mock('../../hooks/useFeatureFlag', () => ({ useFeatureFlag: () => false }));

// GATE_TECH_WORK_DAYS: an office assignment onto a day the tech does not work is
// saved; the PUT answer carries the plain warning and the drawer must show it.
const JOB = {
  id: 'svc-1', customer_id: 'c1', customer_first_name: 'Pat', customer_last_name: 'Sample',
  address: '123 Palm Ave, Bradenton, FL 34205', status: 'pending', service_type: 'Quarterly Pest Control',
  scheduled_date: '2031-03-07', window_start: '09:00:00', window_end: '10:00:00', tech_id: null, tech_full_name: null,
};

function mockFetch({ putResponse }) {
  const puts = [];
  global.fetch = vi.fn(async (url, options = {}) => {
    const u = String(url);
    if (options.method === 'PUT' && u.includes('/assign')) {
      puts.push(JSON.parse(options.body));
      return putResponse;
    }
    if (u.includes('/admin/dispatch/technicians')) {
      return { ok: true, json: async () => ({ technicians: [{ id: 't1', name: 'Tech One', offDay: true }] }) };
    }
    if (u.includes('/admin/dispatch/jobs/')) return { ok: true, json: async () => JOB };
    return { ok: true, json: async () => ({}) };
  });
  return puts;
}

async function assignTechOne() {
  render(<JobDrawer jobId="svc-1" onClose={() => {}} />);
  const option = await screen.findByRole('option', { name: 'Tech One (off)' });
  const select = option.closest('select');
  fireEvent.change(select, { target: { value: 't1' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
}

beforeEach(() => { localStorage.setItem('waves_admin_token', 'test-token'); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('JobDrawer assignment warnings', () => {
  it('lists an off-day technician as "(off)" and shows the saved assignment\'s warning line', async () => {
    const puts = mockFetch({
      putResponse: { ok: true, json: async () => ({ job: { id: 'svc-1' }, warnings: ['Tech One does not work on Fridays.'] }) },
    });
    await assignTechOne();
    expect(await screen.findByText('Tech One does not work on Fridays.')).toBeInTheDocument();
    expect(puts).toEqual([{ technicianId: 't1' }]);
    expect(screen.queryByText('Assignment failed')).not.toBeInTheDocument();
  });

  it('shows no warning when the answer carries none', async () => {
    mockFetch({ putResponse: { ok: true, json: async () => ({ job: { id: 'svc-1' } }) } });
    await assignTechOne();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument());
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('a body that cannot be read still counts as saved, with no warning and no error', async () => {
    mockFetch({ putResponse: { ok: true, json: async () => { throw new Error('empty'); } } });
    await assignTechOne();
    await waitFor(() => expect(global.fetch.mock.calls.some(([, o]) => o?.method === 'PUT')).toBe(true));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByText('Assignment failed')).not.toBeInTheDocument();
  });

  it('a refused assignment shows the error and no warning', async () => {
    mockFetch({ putResponse: { ok: false, status: 422, json: async () => ({ error: 'Tech One is marked out' }) } });
    await assignTechOne();
    expect(await screen.findByText('Tech One is marked out')).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});
