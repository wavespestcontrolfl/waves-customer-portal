// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ReschedulePage from './ReschedulePage';

vi.mock('../components/brand', () => ({
  WavesShell: ({ children }) => <div>{children}</div>,
}));

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

function reschedulablePayload(overrides = {}) {
  return {
    state: 'reschedulable',
    reason: null,
    customerFirstName: 'Pat',
    service: { type: 'Pest Control' },
    isRecurring: false,
    current: {
      date: '2026-07-10',
      windowStart: '09:00',
      windowEnd: '10:00',
    },
    availability: {
      days: [
        {
          date: '2026-07-12',
          fullDate: 'Sunday, July 12',
          nearby: false,
          slots: [
            {
              start_time: '13:00',
              end_time: '14:00',
              start_label: '1:00 PM',
              end_label: '2:00 PM',
              technician_id: 'tech-1',
            },
          ],
        },
      ],
    },
    ...overrides,
  };
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/reschedule/deadbeef']}>
      <Routes>
        <Route path="/reschedule/:token" element={<ReschedulePage />} />
      </Routes>
    </MemoryRouter>
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ReschedulePage arrival windows', () => {
  it('shows the current visit as a 2-hour arrival window, not the job block', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(reschedulablePayload()));
    vi.stubGlobal('fetch', fetchMock);

    renderPage();

    // window_start 09:00 with job-block window_end 10:00 → the promise is
    // 9:00–11:00 AM, never 9:00–10:00 AM.
    expect(await screen.findByText('9:00 AM–11:00 AM')).toBeInTheDocument();
    expect(screen.queryByText('9:00 AM–10:00 AM')).not.toBeInTheDocument();
  });

  it('shows the success message as start + 2 hours even though the server echoes the job-block endLabel', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(reschedulablePayload()))
      .mockResolvedValueOnce(jsonResponse({
        success: true,
        originalDate: '2026-07-10',
        newDate: '2026-07-12',
        window: { start: '13:00', end: '14:00' },
        startLabel: '1:00 PM',
        endLabel: '2:00 PM',
      }));
    vi.stubGlobal('fetch', fetchMock);

    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: '1:00 PM' }));
    fireEvent.click(screen.getByRole('button', { name: /Move to Sunday, July 12/ }));

    await waitFor(() => {
      expect(screen.getByText('You\'re all set')).toBeInTheDocument();
    });
    expect(screen.getByText('1:00 PM–3:00 PM')).toBeInTheDocument();
    expect(screen.queryByText('1:00 PM–2:00 PM')).not.toBeInTheDocument();
  });
});
