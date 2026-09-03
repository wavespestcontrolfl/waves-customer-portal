// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ScheduleListView from './ScheduleListView';

const ROWS = [
  { id: 'svc-owed', customerName: 'Owed Customer', serviceType: 'Pest Control', scheduledDate: '2026-07-15', status: 'completed', has_service_record: false },
  { id: 'svc-done', customerName: 'Done Customer', serviceType: 'Pest Control', scheduledDate: '2026-07-15', status: 'completed', has_service_record: true },
];

beforeEach(() => {
  localStorage.setItem('waves_admin_token', 'test-token');
  global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ services: ROWS }) });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ScheduleListView closeout-owed badge', () => {
  it('flags only the completed row that still owes its closeout and hands it to onEdit', async () => {
    const onEdit = vi.fn();
    render(<ScheduleListView owesCompletion={(s) => s.status === 'completed' && s.has_service_record === false} onEdit={onEdit} />);
    expect(await screen.findAllByText('Closeout owed')).toHaveLength(1);
    expect(screen.getAllByText('Completed', { selector: 'span' })).toHaveLength(1);
    fireEvent.click(screen.getByText('Owed Customer'));
    expect(onEdit).toHaveBeenCalledWith(expect.objectContaining({ id: 'svc-owed' }));
  });
});

describe('ScheduleListView refreshKey', () => {
  it('refetches when the parent bumps refreshKey after a completion', async () => {
    const { rerender } = render(<ScheduleListView refreshKey={0} />);
    await screen.findByText('Owed Customer');
    expect(fetch).toHaveBeenCalledTimes(1);
    rerender(<ScheduleListView refreshKey={1} />);
    await screen.findByText('Owed Customer');
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
